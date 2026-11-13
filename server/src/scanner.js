import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR, decodeProjectDir, FORCE_FULL_LOAD, COLD_START_HOT_DAYS } from './config.js';
import { parseChunk } from './parser.js';

/**
 * 取一组事件/记录里最大的时间戳。
 * 用循环而不是 Math.max(...arr)：大会话里 events 能有几十万条，
 * spread 会直接把调用栈撑爆。
 */
export function maxTsOf(arr, key) {
  let m = 0;
  for (const x of arr || []) {
    const t = Number(x[key]) || 0;
    if (t > m) m = t;
  }
  return m;
}

const DAY = 86400_000;

/**
 * 增量扫描器（阶段 1 增加「冷 / 热 / 已加载」三态）。
 *
 * JSONL 是追加写的：文件变大 = 有新内容，可以只读尾巴。
 * 每个文件维护 { size, offset, mtimeMs, birthtimeMs, loaded, records, meta }：
 *   - 文件变小 → 判定被重写，整体重解析
 *   - 文件变大 → 从 offset 续读
 *   - 只处理到最后一个 '\n'，避免把写了一半的行解析掉
 *
 * 三态（v2.4 计划 4.1）：
 *   unloaded  只登记 stat 指纹，records/events 为空，loaded=false
 *   loading   正在解析，其余请求等待同一个 Promise（见 index.js 的 fileLoads）
 *   loaded    内容已进内存，单向升级、不卸载、不重复读
 *
 * 冷文件**必须仍登记在 this.files 里**（R1）：否则 #syncFile 会在下一拍把每个
 * 冷文件当「新文件」整文件读回来，启动省下的 91.6% 在 5 秒后被吃光，且
 * changed=true → rebuild() → revision+1 会让第 8 步稳定态优化同时失效。
 *
 * 判断「该文件可能含 [from,to] 数据」只靠 fs.stat 免费给的 birthtimeMs / mtimeMs：
 * birthtimeMs <= to && mtimeMs >= from。阶段 0 已在真实 173 文件 + 1/2/3 年合成
 * 夹具上验过 28/28 含数据用例零漏判。
 */
export class Scanner {
  constructor({
    fileCacheDir = null,
    forceFullLoad = FORCE_FULL_LOAD,
    hotDays = COLD_START_HOT_DAYS,
  } = {}) {
    /** @type {Map<string, object>} filePath -> 文件条目（含冷文件） */
    this.files = new Map();
    this.fileCacheDir = fileCacheDir;
    /** FORCE_FULL_LOAD=1 / 索引损坏时，所有文件都当热文件，回退全量路径 */
    this.forceFullLoad = forceFullLoad;
    this.hotDays = hotDays;
    /**
     * scan() 与 loadFile() 串行化，避免 5 秒定时扫描和按需加载同时改同一个条目。
     * 本地工具一次读盘几十到几百毫秒，串行比引入两套锁更简单也更不容易错。
     */
    this._queue = Promise.resolve();
    /** 累计解析字节数：V1 与性能基准用来证明「没有偷读冷文件」 */
    this.parsedBytes = 0;
    /** 每次成功加载（含定时扫描里的新热文件）+1，供 index.js 合并 rebuild */
    this.loadVersion = 0;
  }

  /** 串行执行 fn；前一个失败也不阻塞后一个 */
  #exclusive(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  /** 启动 / 新建文件是否该立刻完整加载 */
  isHot(st) {
    if (this.forceFullLoad) return true;
    const t = Number(st.mtimeMs) || 0;
    return t >= Date.now() - this.hotDays * DAY;
  }

  /** 递归找出所有会话 JSONL */
  async discover() {
    const out = [];
    let projects = [];
    try {
      projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return out;
    }

    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, p.name);
      let files = [];
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue; // 跳过 .file-rollback.ndjson 等
        out.push({
          filePath: path.join(dir, f),
          projectId: p.name,
          sessionId: f.replace(/\.jsonl$/, ''),
        });
      }
    }
    return out;
  }

  /** 扫描全部文件，返回是否发生了变化 */
  async scan() {
    return this.#exclusive(() => this.#scanNow());
  }

  async #scanNow() {
    const files = await this.discover();
    const seen = new Set();
    let changed = false;

    for (const info of files) {
      seen.add(info.filePath);
      if (await this.#syncFile(info)) changed = true;
    }

    // 清理已删除的文件
    for (const key of [...this.files.keys()]) {
      if (!seen.has(key)) {
        this.files.delete(key);
        changed = true;
      }
    }

    if (changed) await this.#persist();
    return changed;
  }

  /** 冷文件条目：只有 stat 指纹，没有任何解析结果 */
  #coldEntry(st, { filePath, projectId, sessionId }) {
    return {
      size: st.size,
      offset: 0,
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs,
      loaded: false,
      records: [],
      events: [],
      meta: {},
      lastEventTs: 0,
      lastRecordTs: 0,
      projectId,
      sessionId,
      filePath,
    };
  }

  /**
   * 整文件解析。失败时**不改动 entry**（保持 loaded=false），
   * 异常直接冒泡给 ensureLoaded，下一拍可重试 —— 否则一次抖动会变成永久漏数据。
   */
  async #parseFull(info, st, prev) {
    const { filePath, projectId, sessionId } = info;
    const text = await fsp.readFile(filePath, 'utf8');
    const cut = text.lastIndexOf('\n');
    const usable = cut >= 0 ? text.slice(0, cut + 1) : '';
    const { records, meta, events } = parseChunk(usable, { projectId, sessionId });
    const offset = Buffer.byteLength(usable, 'utf8');
    const next = {
      size: st.size,
      offset,
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs,
      loaded: true,
      records,
      events,
      meta,
      lastEventTs: maxTsOf(events, 't'),
      lastRecordTs: maxTsOf(records, 'ts'),
      projectId,
      sessionId,
      filePath,
    };
    // 复用同一个对象引用：ensureLoaded 手里拿的 entry 也能立刻看到 loaded=true
    if (prev) Object.assign(prev, next);
    else this.files.set(filePath, next);
    this.parsedBytes += offset;
    this.loadVersion += 1;
    return true;
  }

  async #syncFile({ filePath, projectId, sessionId }) {
    let st;
    try {
      st = await fsp.stat(filePath);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;

    const prev = this.files.get(filePath);
    const info = { filePath, projectId, sessionId };

    // 冷文件：只更新指纹，不 readFile、不 parseChunk（R1 的关键分支）
    // 指纹变化不算 changed，否则有会话在写就会每拍 rebuild + revision 抖动。
    if (prev && prev.loaded === false) {
      prev.size = st.size;
      prev.mtimeMs = st.mtimeMs;
      prev.birthtimeMs = st.birthtimeMs;
      return false;
    }

    // 首次出现：热文件整文件解析；冷文件只登记指纹，等用户切到对应档位再读
    if (!prev) {
      if (!this.isHot(st)) {
        this.files.set(filePath, this.#coldEntry(st, info));
        return true; // 启动那一拍要 rebuild 出初始索引；之后不会再走到这里
      }
      return this.#parseFull(info, st, null);
    }

    // 已加载：指纹未变 → 跳过
    if (prev.size === st.size && prev.mtimeMs === st.mtimeMs) return false;

    // 文件被重写 → 全量重解析
    if (st.size < prev.offset) return this.#parseFull(info, st, prev);

    // 追加 → 读尾巴
    const start = prev.offset;
    const handle = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await handle.read(buf, 0, buf.length, start);
      const chunk = buf.toString('utf8');
      const cut = chunk.lastIndexOf('\n');
      if (cut < 0) {
        // 还只有半行，等下次
        prev.size = st.size;
        prev.mtimeMs = st.mtimeMs;
        prev.birthtimeMs = st.birthtimeMs;
        return false;
      }
      const usable = chunk.slice(0, cut + 1);
      const { records, meta, events } = parseChunk(usable, { projectId, sessionId });
      prev.records.push(...records);
      prev.events.push(...events);
      Object.assign(prev.meta, meta);
      prev.lastEventTs = Math.max(prev.lastEventTs || 0, maxTsOf(events, 't'));
      prev.lastRecordTs = Math.max(prev.lastRecordTs || 0, maxTsOf(records, 'ts'));
      prev.offset = start + Buffer.byteLength(usable, 'utf8');
      prev.size = st.size;
      prev.mtimeMs = st.mtimeMs;
      prev.birthtimeMs = st.birthtimeMs;
      this.parsedBytes += Buffer.byteLength(usable, 'utf8');
      return true;
    } finally {
      await handle.close();
    }
  }

  /**
   * 按需加载一个冷文件。供 index.js 的 ensureLoaded 调用；
   * 同一文件的 in-flight Promise 去重在调用方做，这里只负责「解析 + 单向升级」。
   * @returns {Promise<boolean>} 是否真的解析了文件
   */
  async loadFile(filePath) {
    return this.#exclusive(async () => {
      const entry = this.files.get(filePath);
      if (!entry || entry.loaded) return false;
      let st;
      try {
        st = await fsp.stat(filePath);
      } catch {
        return false; // 文件刚好被删：不标记 loaded，也不算失败
      }
      return this.#parseFull(entry, st, entry);
    });
  }

  /**
   * 双边界候选集合：可能含 [from, to] 数据、且尚未加载的文件。
   * indexTruth 是索引里已读文件的真实 firstTs/lastTs（兜底 birthtime 被改写）；
   * 缺失一律**保守多选**：birthtime 缺失按 0（很早），mtime 缺失按 Infinity（很晚）。
   */
  coldCandidates(from, to, indexTruth = null) {
    const out = [];
    for (const f of this.files.values()) {
      if (f.loaded) continue;
      const truth = indexTruth && indexTruth.get(f.filePath);
      const first = Number.isFinite(truth?.firstTs) && truth.firstTs > 0
        ? truth.firstTs
        : Number.isFinite(f.birthtimeMs) && f.birthtimeMs > 0
          ? f.birthtimeMs
          : 0;
      const last = Number.isFinite(truth?.lastTs) && truth.lastTs > 0
        ? truth.lastTs
        : Number.isFinite(f.mtimeMs) && f.mtimeMs > 0
          ? f.mtimeMs
          : Infinity;
      if (first <= to && last >= from) out.push(f);
    }
    return out;
  }

  /** /api/session 走 recordsForSession，必须按 sessionId 定向加载（R10） */
  coldForSession(sessionId) {
    const out = [];
    for (const f of this.files.values()) {
      if (!f.loaded && f.sessionId === sessionId) out.push(f);
    }
    return out;
  }

  /** 全局 meta 用：已加载 / 总文件数、全部文件 birthtime 最小值 */
  stats() {
    let total = 0;
    let loaded = 0;
    let minBirthtimeMs = Infinity;
    let maxMtimeMs = 0;
    for (const f of this.files.values()) {
      total += 1;
      if (f.loaded) loaded += 1;
      if (Number.isFinite(f.birthtimeMs) && f.birthtimeMs > 0 && f.birthtimeMs < minBirthtimeMs) {
        minBirthtimeMs = f.birthtimeMs;
      }
      if (Number.isFinite(f.mtimeMs) && f.mtimeMs > maxMtimeMs) maxMtimeMs = f.mtimeMs;
    }
    return {
      total,
      loaded,
      minBirthtimeMs: Number.isFinite(minBirthtimeMs) ? minBirthtimeMs : null,
      maxMtimeMs: maxMtimeMs || null,
    };
  }

  /** 项目全集：冷文件也贡献项目名，让筛选栏一开始就不缩水 */
  allProjectIds() {
    const out = new Set();
    for (const f of this.files.values()) if (f.projectId) out.add(f.projectId);
    return [...out];
  }

  /**
   * 索引用汇总量：只记 stat 指纹、真实首尾时间戳与模型集合。
   * **绝不写会话标题 / cwd / 提示词**。未加载文件没有真值，返回 null。
   */
  summarizeForIndex(entry) {
    if (!entry || !entry.loaded) return null;
    let firstTs = Infinity;
    let lastTs = 0;
    const models = new Set();
    for (const r of entry.records) {
      const ts = Number(r.ts) || 0;
      if (ts > 0 && ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
      if (r.model) models.add(r.model);
    }
    return {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      birthtimeMs: entry.birthtimeMs,
      firstTs: Number.isFinite(firstTs) ? firstTs : null,
      lastTs: lastTs || null,
      models: [...models],
    };
  }

  /** 汇总所有文件的记录 */
  all() {
    const records = [];
    const sessions = [];
    /**
     * 每个会话一条有序事件时间线。
     * 耗时只能靠"相邻事件时间差"还原，而这个差值**跨解析块**——
     * 某次请求的起点可能落在上一次增量读进来的那段里。
     * 所以配对必须在攒齐事件之后做，不能放在 parseChunk 里。
     */
    const timelines = [];

    for (const f of this.files.values()) {
      records.push(...f.records);
      const events = f.events || [];
      // 没有任何用量记录、也没有事件的会话才跳过。
      // 只按 records 判会把"只有工具调用、没有用量行"的会话整条丢掉，
      // 连带它的工具耗时一起从时间去向里消失。
      if (f.records.length === 0 && events.length === 0) continue;
      sessions.push({
        sessionId: f.sessionId,
        projectId: f.projectId,
        title: f.meta.title || '',
        cwd: f.meta.cwd || '',
        cwdPretty: f.meta.cwd || decodeProjectDir(f.projectId),
        filePath: f.filePath,
      });
      timelines.push({
        sessionId: f.sessionId,
        projectId: f.projectId,
        events,
      });
    }

    // 会话元信息回填到记录上（标题只有 ai-title 行才知道）
    const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
    for (const r of records) {
      const s = bySession.get(r.sessionId);
      if (!s) continue;
      r.title = s.title;
      if (!r.cwd) r.cwd = s.cwd;
    }

    return { records, sessions, timelines };
  }

  /**
   * 最近活跃会话（第 7 步）。
   *
   * 取三个信号里最大的一个，而不是只看「最后一条 credit」：
   *   1) 文件 mtimeMs —— 真实写入时间，能覆盖刚开始、还没结算的一轮；
   *   2) 时间线事件 t —— 用户消息 / 工具调用 / 工具返回；
   *   3) 用量记录 ts。
   * 只用 credit 会让跟随模式滞后整整一轮：一轮开始时的用户消息与工具调用
   * 都还没有结算记录。
   *
   * 只有 session-meta / ai-title、既无事件也无用量的文件会被跳过：
   * 它没有可展示的对话内容，选它就会凭空冒出一个「0 消耗会话」。
   * 阶段 1 下未加载的冷文件同样没有事件/用量，按 4.4 口径 A 允许渐进。
   *
   * 语义边界：这是「最近活跃」，**不是**「当前打开」。本地日志里没有
   * WorkBuddy 前台窗口信号，多个会话并发时只能知道哪个文件最后被写过。
   */
  latestActivity() {
    let best = null;
    for (const f of this.files.values()) {
      const events = f.events || [];
      const records = f.records || [];
      if (!events.length && !records.length) continue;

      const mtime = Number(f.mtimeMs) || 0;
      const evTs = Number(f.lastEventTs) || 0;
      const recTs = Number(f.lastRecordTs) || 0;
      const ts = Math.max(mtime, evTs, recTs);
      if (!Number.isFinite(ts) || ts <= 0) continue;

      const source = ts === recTs ? 'usage' : ts === evTs ? 'event' : 'file-mtime';
      // 时间相同时按 sessionId 字典序取小，保证结果确定、不会随 Map 顺序抖动
      if (!best || ts > best.ts || (ts === best.ts && String(f.sessionId) < String(best.sessionId))) {
        best = {
          sessionId: f.sessionId,
          projectId: f.projectId,
          title: f.meta?.title || '',
          cwd: f.meta?.cwd || '',
          ts,
          source,
          eventCount: events.length,
          recordCount: records.length,
          hasUsage: records.length > 0,
        };
      }
    }
    return best;
  }

  /** 落一份轻量快照，方便排查解析问题 */
  async #persist() {
    if (!this.fileCacheDir) return;
    try {
      await fsp.mkdir(this.fileCacheDir, { recursive: true });
      const snapshot = [...this.files.values()].map((f) => ({
        filePath: f.filePath,
        size: f.size,
        offset: f.offset,
        count: f.records.length,
        loaded: f.loaded,
      }));
      await fsp.writeFile(
        path.join(this.fileCacheDir, 'scan-state.json'),
        JSON.stringify(snapshot, null, 2),
      );
    } catch {
      /* 快照失败不影响主流程 */
    }
  }
}

export { fs };
