/**
 * 内存存储 + 查询层。
 * 数据量级（几千~几十万条）完全放得下内存；
 * 如果要长期留存 + 复杂查询，把 upsert 换到 SQLite 即可，上层 API 不变。
 */
import {
  deriveTimings,
  buildSpeedProfiles,
  attachSpeeds,
  summarizeSpeed,
  bucketKey,
  bucketStart,
} from './timing.js';

export class Store {
  constructor(scanner) {
    this.scanner = scanner;
    /** @type {Map<string, any>} 以 messageId 为键天然去重 */
    this.byId = new Map();
    /** @type {Map<string, any>} sessionId -> 会话元信息 */
    this.sessions = new Map();
    /** 工具调用明细（含实测耗时），一个 callId 一条 */
    this.toolCalls = [];
    /** @type {Map<string, object>} sessionId -> 时间去向 */
    this.phases = new Map();
    /**
     * sessionId -> { from, to, segs } 时间去向的区间明细。
     * 单独存不挂在 phases 上：总览要把多个会话的区间做并集（并行会重叠），
     * 而这些明细是内部用的，不该跟着 API 一起吐出去。
     * @type {Map<string, {from:number,to:number,segs:Array<{s:number,e:number,type:string}>}>}
     */
    this.phaseIntervals = new Map();
    /** @type {Map<string, object>} model -> 速度画像 */
    this.speedProfiles = new Map();
    /**
     * 全量轮次索引（惰性，见下面的 getter）。
     * 生产 API 从不读它 —— /api/session 为了保证与 summary/steps 同口径，
     * 会按筛选后的记录自己 buildTurns(list)。只有回归测试会访问这两个索引。
     */
    this._turnIndex = null;
    this._turnsBySession = null;
    /** @type {Map<string, any>} sessionId -> 该会话按时间升序的记录（第 8 步索引） */
    this.bySession = new Map();
    /** 全量按 ts 排好序的记录。rebuild 时排一次，查询不再重复 O(N log N) 排序 */
    this.sortedRecords = [];
    /**
     * 数据版本：只有 rebuild 才会 +1。前端据此判断「这一拍有没有新数据」，
     * 没变就整拍跳过重绘；lastScanAt 每次扫描都会变，不能当版本号用。
     */
    this.revision = 0;
    this.defaultOverheadMs = 0;
    this.lastScanAt = 0;
    /** 正在进行的 refresh，用于并发去重 */
    this.refreshing = null;
  }

  /**
   * 定时扫描与手动 /api/refresh 可能撞在同一拍。
   * 共享同一个 in-flight Promise：后者直接复用前者的结果，不会有两个 scan
   * 同时读同一段文件尾巴、也不会重复触发一次全量 rebuild。
   */
  async refresh() {
    if (this.refreshing) return this.refreshing;
    const job = (async () => {
      const changed = await this.scanner.scan();
      if (changed) this.rebuild();
      this.lastScanAt = Date.now();
      return changed;
    })();
    this.refreshing = job;
    try {
      return await job;
    } finally {
      if (this.refreshing === job) this.refreshing = null;
    }
  }

  rebuild() {
    const { records, sessions, timelines } = this.scanner.all();
    this.byId = new Map();
    this.sessions = new Map(sessions.map((s) => [s.sessionId, s]));

    for (const r of records) {
      if (!r.id) continue;
      const prev = this.byId.get(r.id);
      // 同一 messageId 保留先到的（含完整 usage 的那条）
      if (!prev || (prev.total === 0 && r.total > 0)) this.byId.set(r.id, r);
    }

    // 用会话元信息补齐/覆写标题、路径
    for (const r of this.byId.values()) {
      const s = this.sessions.get(r.sessionId);
      if (!s) continue;
      if (!r.title) r.title = s.title;
      if (!r.cwd) r.cwd = s.cwd;
    }

    // ---------- 耗时维度 ----------
    // 顺序有依赖：先把时间线的差值贴回记录，才能拿 (输出 token, 耗时) 去拟合速度
    const { reqDur, toolCalls, phases, intervals } = deriveTimings(timelines);
    for (const r of this.byId.values()) {
      const d = reqDur.get(r.id);
      r.durMs = d ? d.durMs : null;
      r.startTs = d ? d.startTs : null;
    }

    const all = [...this.byId.values()];
    const { profiles, defaultOverheadMs } = buildSpeedProfiles(all);
    attachSpeeds(all, profiles, defaultOverheadMs);

    // ---------- 轮次维度 ----------
    // 每条记录贴一个稳定的轮次键，/api/session 的 steps 才能按轮次下钻。
    // 全量轮次索引改成惰性：10 万条时 buildTurns(all) 会白算 3 万多个轮次
    // 并整体排序一次，而生产 API 根本不读它。这里只负责让缓存失效。
    for (const r of all) r.turnKey = turnKeyOf(r);
    this._turnIndex = null;
    this._turnsBySession = null;

    this.toolCalls = toolCalls;
    this.phases = phases;
    this.phaseIntervals = intervals;
    this.speedProfiles = profiles;
    this.defaultOverheadMs = defaultOverheadMs;

    // ---------- 查询索引（第 8 步）----------
    // records() 过去每次调用都 [...byId.values()].sort(...)，而一拍里
    // meta / overview / sessions / session / requests 会各调一次 ——
    // 10 万条就是 5 次 O(N log N) 复制 + 排序。这里一次排好，查询直接复用。
    // bySession 让单会话详情只过滤该会话的记录，不必先摊平整段历史。
    const sorted = all.slice().sort((a, b) => a.ts - b.ts);
    this.sortedRecords = sorted;
    const bySession = new Map();
    for (const r of sorted) {
      let list = bySession.get(r.sessionId);
      if (!list) bySession.set(r.sessionId, (list = []));
      list.push(r);
    }
    this.bySession = bySession;
    this.revision += 1;
  }

  /** 全部记录，按时间升序。返回的是 rebuild 时缓存的数组，调用方不得修改 */
  records() {
    return this.sortedRecords;
  }

  /** 单个会话的记录（已按时间升序）；单会话查询不必再过滤全历史 */
  recordsForSession(sessionId) {
    return this.bySession.get(sessionId) || [];
  }

  /**
   * 全量轮次索引：首次访问才构建，rebuild 时只置 null 让它失效。
   * 独立审计确认生产路由没有任何一处读它们，唯一消费者是轮次回归测试；
   * 放在 rebuild 里无条件构建属于纯浪费。
   */
  get turnIndex() {
    if (!this._turnIndex) this.#buildTurnIndexes();
    return this._turnIndex;
  }
  get turnsBySession() {
    if (!this._turnsBySession) this.#buildTurnIndexes();
    return this._turnsBySession;
  }
  #buildTurnIndexes() {
    const allTurns = buildTurns(this.sortedRecords);
    this._turnIndex = new Map(allTurns.map((t) => [t.turnKey, t]));
    const bySid = new Map();
    for (const t of allTurns) {
      if (!bySid.has(t.sessionId)) bySid.set(t.sessionId, []);
      bySid.get(t.sessionId).push(t);
    }
    this._turnsBySession = bySid;
  }

  sessionList() {
    return [...this.sessions.values()];
  }

  size() {
    return this.byId.size;
  }
}

/** 过滤：所有维度都走这一个函数，保证口径一致 */
export function applyFilter(records, f = {}) {
  const from = f.from ? Number(f.from) : -Infinity;
  const to = f.to ? Number(f.to) : Infinity;
  const projects = toSet(f.projectId);
  const sessions = toSet(f.sessionId);
  const models = toSet(f.model);
  const kinds = toSet(f.kind);
  const keyword = f.keyword ? String(f.keyword).toLowerCase() : null;

  return records.filter((r) => {
    if (r.ts < from || r.ts > to) return false;
    if (projects && !projects.has(r.projectId)) return false;
    if (sessions && !sessions.has(r.sessionId)) return false;
    if (models && !models.has(r.model)) return false;
    if (kinds && !kinds.has(r.kind)) return false;
    if (keyword) {
      const hay = `${r.title || ''} ${r.cwd || ''} ${r.model} ${r.toolName || ''} ${r.sessionId}`;
      if (!hay.toLowerCase().includes(keyword)) return false;
    }
    return true;
  });
}

function toSet(v) {
  if (v == null || v === '' || v === 'all') return null;
  return new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean));
}

/** 汇总指标 */
export function summarize(records) {
  const acc = {
    requests: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    cacheRead: 0,
    cacheMiss: 0,
    reasoning: 0,
    credit: 0,
    /** 有耗时数据的请求合计时长（模型生成阶段） */
    durMs: 0,
    /** 扣掉每请求固定开销后的净出字时长 */
    netMs: 0,
    /** 有耗时数据的请求数，用来判断速度指标是否可信 */
    timed: 0,
  };
  for (const r of records) {
    acc.requests += 1;
    acc.prompt += r.prompt;
    acc.completion += r.completion;
    acc.total += r.total;
    acc.cacheRead += r.cacheRead;
    acc.cacheMiss += r.cacheMiss;
    acc.reasoning += r.reasoning;
    acc.credit += r.credit;
    if (r.durMs) {
      acc.durMs += r.durMs;
      acc.timed += 1;
    }
    if (r.netMs) acc.netMs += r.netMs;
  }
  // 缓存命中率：命中 token / 总输入 token
  acc.cacheHitRate = acc.prompt > 0 ? acc.cacheRead / acc.prompt : 0;
  acc.credit = round(acc.credit, 4);
  acc.avgPrompt = acc.requests ? Math.round(acc.prompt / acc.requests) : 0;
  acc.avgCompletion = acc.requests ? Math.round(acc.completion / acc.requests) : 0;
  acc.avgCredit = acc.requests ? round(acc.credit / acc.requests, 4) : 0;
  acc.avgDurMs = acc.timed ? Math.round(acc.durMs / acc.timed) : 0;

  // 吐字速度：Σ输出 / Σ净时长。加权而不是逐条求平均——短请求的瞬时速度噪声太大。
  // 注意这是**实测口径**，里面混着"上一次工具返回到真正发起请求之间"的调度空转，
  // 所以它系统性低于拟合出来的吐字速度。两者都留，别混着展示。
  const sp = summarizeSpeed(records);
  acc.measuredSpeed = sp.speed;
  acc.speedSamples = sp.samples;
  return acc;
}

/**
 * 工具耗时统计：从 callId 配对出来的原始明细聚合。
 * 这个数不需要任何推导假设，是耗时维度里最硬的一部分。
 * @param {Array} calls store.toolCalls 的子集
 */
export function toolStats(calls) {
  const map = new Map();
  for (const c of calls) {
    let t = map.get(c.name);
    if (!t) {
      t = { name: c.name, calls: 0, totalMs: 0, maxMs: 0 };
      map.set(c.name, t);
    }
    t.calls += 1;
    t.totalMs += c.ms;
    if (c.ms > t.maxMs) t.maxMs = c.ms;
  }
  return [...map.values()]
    .map((t) => ({
      name: t.name,
      calls: t.calls,
      totalMs: t.totalMs,
      avgMs: Math.round(t.totalMs / t.calls),
      maxMs: t.maxMs,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** 通用分组汇总 */
export function groupBy(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/* ==========================================================================
 * 轮次：一轮对话 = 一次用户提问及其所有后续模型/工具调用。
 *
 * 口径（执行计划书第 3 节）：
 *  - 一次 API 请求以 providerData.messageId 为键；Store.byId 已去重
 *  - 一轮优先按 (sessionId, traceId) 分组，跨会话即便 traceId 相同也不合并
 *  - 缺失 traceId 的请求各自独立成"未归属请求"，绝不合并成一个空轮
 *  - 输入已含缓存命中；总 token = 输入 + 输出，不再加一次缓存
 *  - credit 只累加日志里的 rawUsage.credit，不建价格表
 *
 * 刻意接收"记录数组"而不是直接读 Store：/api/session 的 turns 必须与
 * summary / steps 用同一份筛选后的数据，否则会出现「KPI 是今天的、
 * 轮次是全历史」的口径分裂。Store 的全量索引也复用这个函数，只有一份聚合逻辑。
 * ======================================================================== */

/** NUL 做分隔符，避免 sessionId / traceId / messageId 里的字符造成键碰撞 */
const TURN_SEP = '\u0000';

export function turnKeyOf(r) {
  const sid = r.sessionId || '';
  if (r.traceId) return `${sid}${TURN_SEP}${r.traceId}`;
  return `${sid}${TURN_SEP}__orphan__${TURN_SEP}${r.id || ''}`;
}

/** 把一组记录聚合成轮次数组，按起始时间升序 */
export function buildTurns(records) {
  // 双保险：调用方即使传进重复 messageId，也不会重复计费
  const seen = new Set();
  const rows = [];
  for (const r of records) {
    if (r.id && seen.has(r.id)) continue;
    if (r.id) seen.add(r.id);
    rows.push(r);
  }

  const out = [];
  for (const [turnKey, list] of groupBy(rows, turnKeyOf)) {
    const head = list[0];
    const isOrphan = !head.traceId;
    const s = summarize(list);
    let startTs = Infinity;
    let endTs = -Infinity;
    const models = new Set();
    let toolCalls = 0;
    for (const r of list) {
      if (r.ts < startTs) startTs = r.ts;
      if (r.ts > endTs) endTs = r.ts;
      if (r.model) models.add(r.model);
      if (r.kind === 'function_call') toolCalls += 1;
    }
    out.push({
      turnKey,
      turnId: isOrphan ? `orphan:${head.id}` : head.traceId,
      traceId: head.traceId || '',
      sessionId: head.sessionId,
      isOrphan,
      requests: s.requests,
      prompt: s.prompt,
      completion: s.completion,
      total: s.total,
      cacheRead: s.cacheRead,
      cacheMiss: s.cacheMiss,
      cacheHitRate: s.cacheHitRate,
      reasoning: s.reasoning,
      credit: s.credit,
      durMs: s.durMs,
      models: [...models],
      toolCalls,
      startTs,
      endTs,
      lastTs: endTs,
    });
  }
  return out.sort((a, b) => a.startTs - b.startTs || a.turnId.localeCompare(b.turnId));
}

/**
 * 轮次汇总。所有数值都从轮次派生，而不是抄一份 summarize(records)，
 * 这样「轮次合计 == 所属请求逐项求和」才是真正被检验的等式。
 * 注意各轮 credit 已各自 round 到 4 位，汇总与全量一次性求和可能有
 * 0.0001 级舍入差，对账时用容差比较。
 */
export function summarizeTurns(turns) {
  const acc = {
    turns: turns.length,
    orphanTurns: 0,
    requests: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    cacheRead: 0,
    cacheMiss: 0,
    reasoning: 0,
    credit: 0,
    maxRequests: 0,
    latestTurnId: null,
    latestTs: 0,
  };
  for (const t of turns) {
    acc.requests += t.requests;
    acc.prompt += t.prompt;
    acc.completion += t.completion;
    acc.total += t.total;
    acc.cacheRead += t.cacheRead;
    acc.cacheMiss += t.cacheMiss;
    acc.reasoning += t.reasoning;
    acc.credit += t.credit;
    if (t.isOrphan) acc.orphanTurns += 1;
    if (t.requests > acc.maxRequests) acc.maxRequests = t.requests;
    if (!acc.latestTurnId || t.lastTs >= acc.latestTs) {
      acc.latestTurnId = t.turnId;
      acc.latestTs = t.lastTs;
    }
  }
  acc.credit = round(acc.credit, 4);
  acc.cacheHitRate = acc.prompt > 0 ? acc.cacheRead / acc.prompt : 0;
  acc.avgRequests = turns.length ? round(acc.requests / turns.length, 2) : 0;
  return acc;
}

/** 按时间分桶（本地时区） */
export function timeline(records, granularity = 'day') {
  const buckets = new Map();
  for (const r of records) {
    const k = bucketKey(r.ts, granularity);
    if (!buckets.has(k)) {
      buckets.set(k, {
        ts: bucketStart(r.ts, granularity),
        key: k,
        requests: 0,
        prompt: 0,
        completion: 0,
        total: 0,
        cacheRead: 0,
        cacheMiss: 0,
        reasoning: 0,
        credit: 0,
      });
    }
    const b = buckets.get(k);
    b.requests += 1;
    b.prompt += r.prompt;
    b.completion += r.completion;
    b.total += r.total;
    b.cacheRead += r.cacheRead;
    b.cacheMiss += r.cacheMiss;
    b.reasoning += r.reasoning;
    b.credit += r.credit;
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, credit: round(b.credit, 4) }))
    .sort((a, b) => a.ts - b.ts);
}

/* 分桶口径（bucketKey / bucketStart）已挪到 timing.js：
   时间去向的趋势分桶也要用，放这边会形成 timing → store 的反向依赖。 */

export function round(n, p = 2) {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

export function pct(n) {
  return round(n * 100, 2);
}
