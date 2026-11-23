import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORT,
  HOST,
  PROJECTS_DIR,
  HOME,
  SCAN_INTERVAL_MS,
  CORS_ORIGINS,
  CORS_ALLOW_ALL,
  FORCE_FULL_LOAD,
  COLD_START_HOT_DAYS,
  corsAllowOrigin,
  isAllowedHost,
} from './config.js';
import { Scanner } from './scanner.js';
import { FileIndex } from './file-index.js';
import {
  Store,
  applyFilter,
  summarize,
  groupBy,
  timeline,
  toolStats,
  buildTurns,
  summarizeTurns,
  round,
  pct,
} from './store.js';
import { mergePhases } from './timing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * 缓存目录默认仍是 server/.cache；仅当回归 / 并行验证需要隔离时，
 * 用 TOKEN_DASHBOARD_CACHE_DIR 指到别处，避免多个数据源互踩索引 sourceKey。
 * 不设置时行为与原来完全一致。
 */
const CACHE_DIR = process.env.TOKEN_DASHBOARD_CACHE_DIR
  ? path.resolve(process.env.TOKEN_DASHBOARD_CACHE_DIR)
  : path.join(__dirname, '..', '.cache');

const scanner = new Scanner({ fileCacheDir: CACHE_DIR });
const store = new Store(scanner);
const fileIndex = new FileIndex({ cacheDir: CACHE_DIR });

/**
 * 索引只做兜底与元数据，**不作为正确性依赖**：
 * 损坏 / 版本 / 数据源不符 → 丢弃并回退全量路径（本次进程启动即全量加载）。
 * 首次运行没有索引文件属正常，不触发回退。
 */
const indexState = fileIndex.load();
let forceFullLoad = FORCE_FULL_LOAD;
/** 启动日志要能分清「用户显式回退」和「索引损坏自动回退」，否则排障会看错原因 */
let fullLoadReason = FORCE_FULL_LOAD ? 'FORCE_FULL_LOAD=1' : '';
if (!indexState.ok && indexState.reason !== 'no-cache-dir') {
  console.warn(`[token-dashboard] 索引不可用（${indexState.reason}），本次回退全量加载`);
  forceFullLoad = true;
  fullLoadReason = `索引不可用（${indexState.reason}）`;
}
scanner.forceFullLoad = forceFullLoad;

/* ---------- 按需加载（阶段 1 · 1.2 / 计划 4.1） ---------- */

/** 同一文件的 in-flight Promise 去重：三视图并发切档只读一次盘 */
const fileLoads = new Map();
function loadOne(entry) {
  if (entry.loaded) return Promise.resolve(false);
  const pending = fileLoads.get(entry.filePath);
  if (pending) return pending;
  const job = scanner.loadFile(entry.filePath).finally(() => fileLoads.delete(entry.filePath));
  fileLoads.set(entry.filePath, job);
  return job;
}

/**
 * 上一次 rebuild 对应的加载版本。并发 ensureLoaded 靠它保证**只 rebuild 一次**
 * （否则三个视图各 rebuild 一次，revision 连跳三下）。
 * Scanner.#exclusive 已把多个冷文件串行读盘，避免一次切「全部」把内存撑爆。
 */
let rebuiltAtVersion = 0;
function rebuildAfterLoad() {
  if (scanner.loadVersion === rebuiltAtVersion) return false;
  rebuiltAtVersion = scanner.loadVersion;
  store.rebuild();
  fileIndex.schedulePersist(scanner);
  return true;
}

/** store.refresh() 自己会 rebuild（changed 时），同步版本避免下次多 rebuild 一次 */
async function refreshStore() {
  const changed = await store.refresh();
  rebuiltAtVersion = scanner.loadVersion;
  return changed;
}

/**
 * 4.1 的 from/to 映射表：
 *  今天 / 近 7 / 近 30 / 全部 → to 为空 → +Infinity，等价按 mtime >= from 单边界；
 *  昨天 / 自定义闭区间       → to 为当日 23:59:59.999 → 双边界；
 *  全部                       → from 为空 → -Infinity → 全部剩余冷文件。
 *
 * 两处例外（R10）：/api/meta 的 handler 不消费 f 且稳定态每拍只发它，
 * **不参与加载判断**；/api/session 走 recordsForSession()，按 sessionId 定向加载。
 *
 * 请求内 await 完成后才到 handler，因此**该请求返回时数据已是新版本**，
 * 不需要再做一次 revision 换数（计划 4.3）。
 */
async function ensureLoaded(pathname, f) {
  if (pathname === '/api/meta' || forceFullLoad) return;
  const from = f.from ? Number(f.from) : -Infinity;
  const to = f.to ? Number(f.to) : Infinity;
  const entries = pathname === '/api/session' && f.sessionId
    ? scanner.coldForSession(String(f.sessionId).split(',')[0])
    : scanner.coldCandidates(from, to, fileIndex.truthMap());
  if (!entries.length) return;

  const t0 = Date.now();
  const results = await Promise.allSettled(entries.map(loadOne));
  const loaded = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
  if (rebuildAfterLoad()) {
    const s = scanner.stats();
    console.log(`[load] 按需加载 ${loaded} 个历史文件，耗时 ${Date.now() - t0}ms；已加载 ${s.loaded}/${s.total} 个文件`);
  }
  // 部分失败也抛给前端 needsRetry：已成功的文件保持 loaded，下一拍只补失败的。
  // 失败的文件**不标记 loaded**，避免一次 IO 抖动变成永久漏数据。
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * 解析日期参数。
 * 注意：new Date('2026-09-26') 会按 UTC 解析，在东八区会整体偏移 8 小时，
 * 所以纯日期字符串一律补上本地零点，保证"按天筛选"符合直觉。
 */
function parseDate(v, endOfDay = false) {
  if (!v) return null;
  const s = String(v);
  const d = s.length <= 10 ? new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}`) : new Date(s);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/** 从请求里解析过滤器 */
function parseFilter(url) {
  const q = url.searchParams;
  const days = q.get('days');
  let from = parseDate(q.get('from'));
  const to = parseDate(q.get('to'), true);
  if (from == null && days) {
    const d = new Date(Date.now() - Number(days) * 86400_000);
    d.setHours(0, 0, 0, 0);
    from = d.getTime();
  }

  return {
    from,
    to,
    projectId: q.get('projectId'),
    sessionId: q.get('sessionId'),
    model: q.get('model'),
    kind: q.get('kind'),
    keyword: q.get('keyword'),
  };
}

function sessionAggregates(records) {
  const bySession = groupBy(records, (r) => r.sessionId);
  const out = [];
  for (const [sessionId, list] of bySession) {
    const meta = store.sessions.get(sessionId) || {};
    const s = summarize(list);
    const modelSet = new Set();
    let toolCalls = 0;
    let startTs = Infinity;
    let endTs = -Infinity;
    // 不用 Math.min(...list.map(...))：单会话上万条时 spread 会把调用栈撑爆。
    // 一次循环顺带把模型集合、工具调用数、首尾时间都收齐。
    for (const r of list) {
      if (r.model) modelSet.add(r.model);
      if (r.kind === 'function_call') toolCalls += 1;
      if (r.ts < startTs) startTs = r.ts;
      if (r.ts > endTs) endTs = r.ts;
    }
    out.push({
      sessionId,
      projectId: list[0].projectId,
      title: meta.title || '',
      cwd: meta.cwd || list[0].cwd || '',
      startTs: list.length ? startTs : null,
      endTs: list.length ? endTs : null,
      models: [...modelSet],
      toolCalls,
      ...s,
    });
  }
  return out.sort((a, b) => b.credit - a.credit);
}

/**
 * 把工具调用明细收窄到与当前筛选一致的范围。
 * 工具明细挂在 sessionId 上，而 model / kind / keyword 这些筛选维度它没有，
 * 所以统一用"筛选后出现过哪些会话"来对齐，口径才不会和表格打架。
 */
function pickToolCalls(sessionIds, f) {
  const from = f.from ? Number(f.from) : -Infinity;
  const to = f.to ? Number(f.to) : Infinity;
  const projects = f.projectId && f.projectId !== 'all' ? new Set(String(f.projectId).split(',')) : null;
  return store.toolCalls.filter(
    (c) =>
      sessionIds.has(c.sessionId) &&
      c.ts >= from &&
      c.ts <= to &&
      (!projects || projects.has(c.projectId)),
  );
}

/**
 * 时间去向：把筛选范围内的会话合成**墙钟口径**。
 *
 * 两处刻意的处理：
 *  - 区间明细（store.phaseIntervals）交给 mergePhases 做并集，不再直接相加 ——
 *    并行会话会让同一段时间被算两次（实测虚高 7%）。
 *  - 裁到筛选区间：筛"今天"时，跨零点的会话只算落在今天的那一段。
 */
function pickPhase(sessionIds, f = {}) {
  const items = [];
  for (const sid of sessionIds) {
    const iv = store.phaseIntervals.get(sid);
    if (iv) items.push(iv);
  }
  return mergePhases(items, {
    from: f.from ? Number(f.from) : -Infinity,
    to: f.to ? Number(f.to) : Infinity,
    granularity: f.granularity || 'day',
  });
}

/**
 * 按会话拆时间去向，给总览做下钻用。
 * 总量只有一个数说明不了"时间花在哪"，摊到会话上才能看出是哪一个吃掉的在岗时间。
 */
function pickPhaseBySession(sessionIds, limit = 8) {
  const out = [];
  for (const sid of sessionIds) {
    const p = store.phases.get(sid);
    if (!p || !p.activeMs) continue;
    const meta = store.sessions.get(sid) || {};
    out.push({
      sessionId: sid,
      title: meta.title || '',
      projectId: p.projectId,
      spanMs: p.spanMs,
      modelMs: p.modelMs,
      toolMs: p.toolMs,
      humanMs: p.humanMs,
      awayMs: p.awayMs,
      activeMs: p.activeMs,
    });
  }
  return out.sort((a, b) => b.activeMs - a.activeMs).slice(0, limit);
}

/** 请求行里跟耗时有关的字段，统一在这里产出，保证各处口径一致 */
function timingFields(r) {
  return {
    startTs: r.startTs,
    durMs: r.durMs,
    overheadMs: r.overheadMs,
    netMs: r.netMs,
    tps: r.tps,
  };
}

/**
 * 一组数据的吐字速度口径。
 *
 * 为什么不直接对这批记录做一次拟合：筛选到单个会话时样本可能只有十几条，
 * 拟合出来的斜率会乱跳。吐字速度是**模型的固有属性**，不该随筛选条件变，
 * 所以速度一律取模型的（全量拟合）画像，聚合时按各模型贡献的输出 token 加权。
 *
 * 同时把"实测口径"一并给出：Σ输出 / Σ净时长。它系统性偏低——因为
 * "上一次工具返回到真正发起请求"之间的调度空转也被算进去了。
 * 两个口径都要，但必须标清楚，混着展示会让人以为数字前后矛盾。
 */
function speedOf(byModel, summary) {
  let wsum = 0;
  let weight = 0;
  for (const m of byModel) {
    if (m.speed == null || !m.completion) continue;
    wsum += m.speed * m.completion;
    weight += m.completion;
  }
  const dominant = [...byModel].filter((m) => m.speed != null).sort((a, b) => b.completion - a.completion)[0];
  // 不可信的画像连开销也别信：kimi 只 6 条样本时拟合出来的截距是 0，
  // 直接展示会得到"每请求开销 0 秒"这种明显错误的结论。
  const ovh =
    dominant && dominant.speedReliable && dominant.overheadMs != null
      ? dominant.overheadMs
      : store.defaultOverheadMs;
  return {
    /** 拟合吐字速度（按输出量加权），看板主指标 */
    tps: weight > 0 ? round(wsum / weight, 1) : null,
    /** 实测口径 Σ输出 / Σ净时长，作对照 */
    measuredTps: summary ? summary.measuredSpeed : null,
    /** 每请求固定开销 */
    overheadMs: ovh,
    dominantModel: dominant ? dominant.model : null,
    /** 主导模型的画像是否可信，不可信时前端要标"仅供参考" */
    reliable: dominant ? !!dominant.speedReliable : false,
    models: byModel
      .filter((m) => m.speed != null)
      .map((m) => ({
        model: m.model,
        tps: m.speed,
        samples: m.speedSamples,
        r2: m.speedR2,
        reliable: m.speedReliable,
      }))
      .sort((a, b) => b.tps - a.tps),
  };
}

const routes = {
  /** 数据源与筛选维度 */
  '/api/meta': async () => {
    const records = store.records();
    const uniq = (fn) => [...new Set(records.map(fn))].filter(Boolean);
    /** 第 7 步：最近活跃会话。前端跟随模式直接读这个 id，不需要自己猜。 */
    const active = scanner.latestActivity();
    const st = scanner.stats();
    /**
     * 4.4 口径 A：全局元数据允许随加载范围「越用越准」，但能在不读内容的前提下
     * 先给全的，一开始就给全，减少数字跳动：
     *  - projects 从**全部文件**枚举（冷文件也贡献项目名），一开始就完整；
     *  - minTs 用全部文件 birthtime 最小值兜底，避免「全部」档的粒度误判；
     *  - models 用索引里已读文件的模型集合渐进补全；
     *  - recordCount / sessionCount / speedProfiles 只对已加载记录成立，允许渐进。
     */
    const loadedMinTs = records.length ? records[0].ts : null;
    // FORCE_FULL_LOAD=1 是回归夹具用的「第一阶段全量路径」：所有既有字段必须与
    // 第一阶段逐字一致，否则 e2e / live / final / large 的硬断言数字会被改口径。
    // 只在冷启动模式下才用全文件枚举 / birthtime 兜底这些新逻辑。
    const minTs = forceFullLoad
      ? loadedMinTs
      : st.minBirthtimeMs != null
        ? Math.min(st.minBirthtimeMs, loadedMinTs ?? st.minBirthtimeMs)
        : loadedMinTs;
    const maxTs = records.length ? records[records.length - 1].ts : forceFullLoad ? null : st.maxMtimeMs;
    const projects = forceFullLoad
      ? uniq((r) => r.projectId)
      : [...new Set([...uniq((r) => r.projectId), ...scanner.allProjectIds()])];
    const models = forceFullLoad
      ? uniq((r) => r.model)
      : [...new Set([...uniq((r) => r.model), ...fileIndex.models()])];
    return {
      home: HOME,
      projectsDir: PROJECTS_DIR,
      lastScanAt: store.lastScanAt,
      /** 数据版本：rebuild 才 +1；前端据此整拍跳过无变化的重绘 */
      revision: store.revision,
      recordCount: store.size(),
      sessionCount: store.sessions.size,
      /** 阶段 1：界面据此交代「当前已加载范围」，并标明是否走了全量路径 */
      loadedFiles: st.loaded,
      totalFiles: st.total,
      fullLoad: forceFullLoad,
      latestActiveSessionId: active ? active.sessionId : null,
      latestActive: active,
      // 保持既有顺序做前缀，只把冷文件里多出来的项目/模型追加在后面
      projects,
      models,
      kinds: uniq((r) => r.kind),
      minTs,
      maxTs,
      /** 全量口径的模型速度画像：速度不随筛选变，前端筛选时也能引用 */
      speedProfiles: [...store.speedProfiles.values()],
      defaultOverheadMs: store.defaultOverheadMs,
    };
  },

  /** 总览：KPI + 趋势 + 模型/项目分布 + 时间去向 */
  '/api/overview': async (_p, f) => {
    const all = store.records();
    const picked = applyFilter(all, f);
    const granularity = f.granularity || 'day';
    const sessionIds = new Set(picked.map((r) => r.sessionId));

    const byModel = [...groupBy(picked, (r) => r.model)]
      .map(([model, list]) => {
        const p = store.speedProfiles.get(model);
        return {
          model,
          ...summarize(list),
          /** 速度来自全量拟合，样本数与拟合优度一并给出，前端据此决定要不要标注"仅供参考" */
          speed: p ? p.speed : null,
          overheadMs: p ? p.overheadMs : null,
          speedSamples: p ? p.samples : 0,
          speedR2: p ? p.r2 : null,
          speedReliable: p ? p.reliable : false,
        };
      })
      .sort((a, b) => b.credit - a.credit);

    const byProject = [...groupBy(picked, (r) => r.projectId)]
      .map(([projectId, list]) => {
        const sessions = new Set(list.map((r) => r.sessionId));
        const s = summarize(list);
        return {
          projectId,
          cwd: list.find((r) => r.cwd)?.cwd || '',
          sessionCount: sessions.size,
          ...s,
        };
      })
      .sort((a, b) => b.credit - a.credit);

    const byKind = [...groupBy(picked, (r) => r.kind)]
      .map(([kind, list]) => ({ kind, ...summarize(list) }))
      .sort((a, b) => b.total - a.total);

    const byTool = [...groupBy(picked.filter((r) => r.toolName), (r) => r.toolName)]
      .map(([name, list]) => ({ name, calls: list.length, ...summarize(list) }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 20);

    const calls = pickToolCalls(sessionIds, f);
    const summary = summarize(picked);
    const mergedPhase = pickPhase(sessionIds, f);
    const { buckets: phaseTimeline, ...phase } = mergedPhase;

    return {
      summary,
      speed: speedOf(byModel, summary),
      timeline: timeline(picked, granularity),
      byModel,
      byProject,
      byKind,
      byTool,
      /** 工具真实耗时排行（callId 配对，无需任何推导假设） */
      toolTime: toolStats(calls).slice(0, 15),
      /** 单次最慢的工具调用，用来定位"卡在哪一条命令上" */
      slowTools: [...calls]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 10)
        .map((c) => ({
          callId: c.callId,
          sessionId: c.sessionId,
          projectId: c.projectId,
          ts: c.ts,
          name: c.name,
          ms: c.ms,
          title: store.sessions.get(c.sessionId)?.title || '',
        })),
      phase,
      /** 时间去向按粒度的趋势：只有一个总数看不出变好还是变坏 */
      phaseTimeline,
      phaseBySession: pickPhaseBySession(sessionIds),
      // 复用上面算过的 summary，别对 10 万条 picked 再求和一次
      cacheHitRatePct: pct(picked.length ? summary.cacheHitRate : 0),
    };
  },

  /** 会话列表 */
  '/api/sessions': async (_p, f) => {
    const picked = applyFilter(store.records(), f);
    const items = sessionAggregates(picked).map((s) => ({
      ...s,
      phase: store.phases.get(s.sessionId) || null,
    }));
    return { items };
  },

  /** 单会话详情：逐次请求时间线 */
  '/api/session': async (_p, f) => {
    if (!f.sessionId) throw new HttpError(400, '缺少 sessionId');
    const sessionId = f.sessionId.split(',')[0];
    // 第 8 步：单会话详情只过滤这个会话的记录，不再把 10 万条全历史
    // 复制/过滤一遍。索引由 Store.rebuild 建好，顺序与全局 records() 一致。
    const list = applyFilter(store.recordsForSession(sessionId), { ...f, sessionId });
    const meta = store.sessions.get(sessionId) || {};
    const calls = pickToolCalls(new Set([sessionId]), { ...f, sessionId });
    const summary = summarize(list);
    // 轮次与 summary / steps 同源（同一份筛选后的 list），避免口径分裂。
    // turnLimit 只裁剪返回给前端的列表；turnSummary 始终覆盖全部轮次。
    const allTurns = buildTurns(list);
    const limit = Math.max(1, Math.min(500, Number(f.turnLimit || 200)));
    const turnTruncated = allTurns.length > limit;
    const turns = turnTruncated ? allTurns.slice(-limit) : allTurns;
    const turnSummary = summarizeTurns(allTurns);
    const latestTurn = allTurns.length ? allTurns[allTurns.length - 1] : null;
    const byModel = [...groupBy(list, (r) => r.model)].map(([model, l]) => {
      const p = store.speedProfiles.get(model);
      return {
        model,
        completion: l.reduce((a, r) => a + r.completion, 0),
        speed: p ? p.speed : null,
        overheadMs: p ? p.overheadMs : null,
        speedSamples: p ? p.samples : 0,
        speedR2: p ? p.r2 : null,
        speedReliable: p ? p.reliable : false,
      };
    });
    return {
      sessionId,
      meta,
      summary,
      speed: speedOf(byModel, summary),
      steps: list.map((r) => ({
        id: r.id,
        ts: r.ts,
        kind: r.kind,
        toolName: r.toolName,
        model: r.model,
        prompt: r.prompt,
        completion: r.completion,
        total: r.total,
        cacheRead: r.cacheRead,
        cacheMiss: r.cacheMiss,
        reasoning: r.reasoning,
        credit: round(r.credit, 4),
        /** 子代理请求（Agent 派生的队友）标记，前端打「子代理」标签 */
        isSubAgent: !!r.isSubAgent,
        agent: r.agent || '',
        /** 与 turns[].turnKey 对应，前端可直接在本地 steps 里按轮次下钻 */
        turnKey: r.turnKey,
        ...timingFields(r),
      })),
      /**
       * 上下文增长曲线：输入 token 随轮次的爬升，能直观看出"上下文膨胀"。
       * 子代理行/结算镜像行排除：它们是各自独立的上下文（或只有 credit），
       * 混进单会话曲线会让爬升图失真。
       */
      contextGrowth: list
        .filter((r) => !r.isSubAgent && !r.creditOnly)
        .map((r, i) => ({ index: i + 1, ts: r.ts, prompt: r.prompt })),
      /** 本会话：时间去向 + 工具耗时 + 单次最慢 */
      phase: store.phases.get(sessionId) || null,
      toolTime: toolStats(calls).slice(0, 15),
      slowTools: [...calls]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 8)
        .map((c) => ({ callId: c.callId, ts: c.ts, name: c.name, ms: c.ms })),
      /** 轮次视图（第 5 步）：与 summary / steps 同筛选口径 */
      turns,
      turnTotal: allTurns.length,
      turnTruncated,
      turnSummary,
      latestTurn,
    };
  },

  /** 请求明细（分页）。order=asc 走时间正序；缺省 / 其它值一律逆序，保持既有默认 */
  '/api/requests': async (_p, f) => {
    const asc = f.order === 'asc';
    const picked = applyFilter(store.records(), f).sort((a, b) => (asc ? a.ts - b.ts : b.ts - a.ts));
    const page = Math.max(1, Number(f.page || 1));
    const size = Math.min(500, Number(f.size || 50));
    const start = (page - 1) * size;
    return {
      total: picked.length,
      page,
      size,
      items: picked.slice(start, start + size).map((r) => ({
        id: r.id,
        ts: r.ts,
        sessionId: r.sessionId,
        projectId: r.projectId,
        title: r.title,
        model: r.model,
        kind: r.kind,
        toolName: r.toolName,
        prompt: r.prompt,
        completion: r.completion,
        total: r.total,
        cacheRead: r.cacheRead,
        reasoning: r.reasoning,
        credit: round(r.credit, 4),
        /** 子代理请求（Agent 派生的队友）标记，前端打「子代理」标签 */
        isSubAgent: !!r.isSubAgent,
        agent: r.agent || '',
        ...timingFields(r),
      })),
    };
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 生产模式：如果 web/dist 存在，就顺手把打包产物托管在同一端口，
 * 这样部署时只需要跑一个 Node 进程（无需 nginx）。
 */
const DIST_DIR = path.resolve(__dirname, '../../web/dist');
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  // 防目录穿越
  const target = path.join(DIST_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(DIST_DIR)) return false;

  let file = target;
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(DIST_DIR, 'index.html'); // SPA 兜底
  }

  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const isHashed = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON 响应。
 * cors 是依据请求 Origin 算出来的头：白名单内回显具体来源，其余不下发 ACAO。
 * 不再固定写 '*' —— 那会让任何网页都能读到本机的会话用量数据。
 */
function json(res, status, body, cors = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    ...cors,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  // 绑回环之外的第二层边界：拒绝 Host 头不是本机名字的请求，挡 DNS rebinding。
  // 注意不能用 req.headers.host 拼 URL 之前就先检查，否则恶意 Host 会参与解析。
  if (!isAllowedHost(req.headers.host)) {
    console.warn('[security] 拒绝非本机 Host:', req.headers.host);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden: host not allowed');
  }

  const origin = corsAllowOrigin(req.headers.origin);
  const cors = origin
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // 强制重扫
  if (url.pathname === '/api/refresh') {
    try {
      await refreshStore();
      return json(res, 200, { ok: true, recordCount: store.size(), lastScanAt: store.lastScanAt }, cors);
    } catch (err) {
      console.error('[refresh error]', err);
      return json(res, 500, { error: err.message }, cors);
    }
  }

  const handler = routes[url.pathname];
  if (!handler) {
    // 非 /api 请求交给静态产物
    if (!url.pathname.startsWith('/api') && HAS_DIST && serveStatic(url.pathname, res)) return;
    return json(res, 404, { error: 'Not Found', path: url.pathname }, cors);
  }

  try {
    const f = parseFilter(url);
    f.granularity = url.searchParams.get('granularity') || 'day';
    f.page = url.searchParams.get('page');
    f.size = url.searchParams.get('size');
    f.turnLimit = url.searchParams.get('turnLimit');
    f.order = url.searchParams.get('order');
    // 统一分发处（计划 4.1 的插入点）：parseFilter 之后、handler 之前。
    // 切到更宽档位 / 点开冷会话时补齐历史数据；/api/meta 不参与。
    await ensureLoaded(url.pathname, f);
    const body = await handler(url, f);
    json(res, 200, body, cors);
  } catch (err) {
    console.error('[api error]', url.pathname, err);
    json(res, err.status || 500, { error: err.message }, cors);
  }
});

// 启动时扫一次：只完整解析近 COLD_START_HOT_DAYS 天的文件，冷文件只登记指纹。
// 之后按 SCAN_INTERVAL_MS 增量扫（冷文件每拍只 stat，不读内容）。
await refreshStore();
// 索引首写：把已加载文件的真值落盘，供下次启动兜底 birthtime 被改写。
fileIndex.update(scanner);
await fileIndex.persist();
const bootStats = scanner.stats();

/**
 * 定时扫描。Store.refresh 内部已按 in-flight Promise 去重；这里再挡一层，
 * 避免慢扫描被 setInterval 不断排队，并把新增／失败／耗时写进日志。
 * 本地排障时不用再猜"数据到底扫进来没有"。
 */
let scanInFlight = false;
async function scheduledScan() {
  if (scanInFlight) {
    console.warn('[scan] 跳过本次：上一轮扫描仍在进行');
    return;
  }
  scanInFlight = true;
  const t0 = Date.now();
  try {
    const changed = await refreshStore();
    const ms = Date.now() - t0;
    if (changed) console.log(`[scan] 已追加数据：${store.size()} 条请求，扫描耗时 ${ms}ms`);
    else if (ms > 1000) console.warn(`[scan] 无新增但耗时 ${ms}ms，数据量可能偏大`);
  } catch (err) {
    console.error('[scan] 扫描失败', err);
  } finally {
    scanInFlight = false;
  }
}
setInterval(scheduledScan, SCAN_INTERVAL_MS);

const shownHost = HOST.includes(':') ? `[${HOST}]` : HOST;
server.listen(PORT, HOST, () => {
  console.log(`[token-dashboard] API 已启动  http://${shownHost}:${PORT}`);
  console.log(`[token-dashboard] 数据源      ${PROJECTS_DIR}`);
  console.log(`[token-dashboard] 自动重扫    每 ${SCAN_INTERVAL_MS / 1000}s（增量）`);
  console.log(`[token-dashboard] 已解析 ${store.size()} 条请求 / ${store.sessions.size} 个会话`);
  console.log(
    `[token-dashboard] 已加载     ${bootStats.loaded} / ${bootStats.total} 个文件 · ` +
      `启动解析 ${scanner.parsedBytes.toLocaleString('en-US')} B` +
      (forceFullLoad
        ? `（${fullLoadReason}：全量路径）`
        : `（冷启动近 ${COLD_START_HOT_DAYS} 天，其余切档时按需加载）`),
  );
  console.log(
    `[token-dashboard] 页面产物    ` +
      (HAS_DIST
        ? `web/dist 已托管（同源 http://${shownHost}:${PORT}）`
        : '未找到 web/dist，当前仅提供 API；请先执行 npm run build'),
  );
  console.log(
    `[token-dashboard] 本地边界    仅监听 ${HOST}:${PORT}；CORS ` +
      (CORS_ALLOW_ALL
        ? '允许任意来源（CORS_ORIGIN=*，不建议）'
        : `白名单 ${CORS_ORIGINS.size} 项`),
  );
  const fitted = [...store.speedProfiles.values()].filter((p) => p.reliable);
  console.log(
    `[token-dashboard] 耗时维度    ${store.toolCalls.length} 次工具调用 / ` +
      `${fitted.length} 个模型完成速度拟合 · 兜底固定开销 ${store.defaultOverheadMs}ms`,
  );
});
