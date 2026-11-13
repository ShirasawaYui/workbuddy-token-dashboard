/**
 * 阶段 1 · 1.8 新增单元测试（V1 / V2 / V5 + 冷文件三态 + 文件变更 + 索引 + 口径白名单）
 *
 * 运行：node --test server/test/phase1.test.js（根 npm test 已把本文件纳入）
 * 零新依赖：只用 node:test / node:assert / node:fs / node:os / node:path 与被测模块。
 *
 * ── 关于 config.js「import 时求值」 ────────────────────────────────────────
 * config.js 在模块加载时读 WORKBUDDY_HOME / FORCE_FULL_LOAD / HOT_DAYS 并冻结
 * PROJECTS_DIR。本文件**不依赖这些进程级取值**：
 *   - Scanner 用「覆盖 discover」把扫描范围限定到临时夹具（沿用
 *     incremental.test.js 的做法），forceFullLoad / hotDays 全走构造参数；
 *   - FileIndex 的 projectsDir 也走构造参数。
 * 因此无需子进程 + env，也无需动态 import + cache-buster，静态 import 即可。
 *
 * ── 关于 Windows 改不了 birthtime ─────────────────────────────────────────
 * 计划 0.1 / R4 明确：utimes 改不了 birthtime，直接拿刚写的文件验证双边界会
 * 得到「历史区间必然漏判」的假结论。这里用 **sidecar 记虚拟边界**：
 *   - V2 用 specs 数组描述每个文件的虚拟 firstTs/lastTs，注入到冷 entry 的
 *     birthtimeMs/mtimeMs（以及索引 truthMap），再与「全量 parseChunk 真值」比对；
 *   - V1 需要真实的热/冷混合，用 fs.utimesSync 只改 **mtime**（这个 Windows 支持）
 *     让 isHot 自然判冷，birthtime 的真实值不参与 V1 断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scanner } from '../src/scanner.js';
import { FileIndex, FILE_INDEX_VERSION, FILE_INDEX_NAME } from '../src/file-index.js';
import { parseChunk } from '../src/parser.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();
/** 今天的本地零点：所有档位区间都以它为锚，避免 new Date('YYYY-MM-DD') 的 UTC 偏移 */
const T0 = (() => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

function dayStart(n) {
  const d = new Date(T0);
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dayEnd(n) {
  const d = new Date(T0);
  d.setDate(d.getDate() - n);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** 计划 4.1 的 from/to 映射表：六类入参 + 全部 */
const RANGES = [
  { name: '今天', from: dayStart(0), to: Infinity },
  { name: '昨天', from: dayStart(1), to: dayEnd(1) },
  { name: '近7天', from: dayStart(7), to: Infinity },
  { name: '近30天', from: dayStart(30), to: Infinity },
  { name: '历史单日', from: dayStart(400), to: dayEnd(400) },
  { name: '自定义历史区间', from: dayStart(730), to: dayEnd(400) },
  { name: '全部', from: -Infinity, to: Infinity },
];

/** 一条带用量的 JSONL 行。messageId 必须唯一，否则 Store.byId 会去重。 */
function usageLine(id, ts, sessionId, opts = {}) {
  const { model = 'phase1-model', credit = 0.5, prompt = 100, completion = 40 } = opts;
  return JSON.stringify({
    type: 'function_call',
    timestamp: ts,
    sessionId,
    cwd: 'D:\\phase1\\secret-cwd',
    name: 'Bash',
    providerData: {
      messageId: id,
      traceId: `trace-${sessionId}`,
      model,
      rawUsage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_cache_hit_tokens: Math.round(prompt * 0.8),
        prompt_cache_miss_tokens: prompt - Math.round(prompt * 0.8),
        completion_thinking_tokens: 5,
        credit,
      },
    },
  });
}

/** 临时数据源：home/projects/<project>/... + .cache 目录 */
function makeTmp(tag = 'p1') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `phase1-${tag}-`));
  const projectsDir = path.join(home, 'projects');
  const projDir = path.join(projectsDir, 'd-phase1-demo');
  const cacheDir = path.join(home, '.cache');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  return {
    home,
    projectsDir,
    projDir,
    cacheDir,
    filePath: (sessionId) => path.join(projDir, `${sessionId}.jsonl`),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }),
  };
}

/** 写一个会话 JSONL，返回 discover 需要的 info 及路径 */
function writeSession(tmp, sessionId, lines) {
  const filePath = tmp.filePath(sessionId);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  const projectId = 'd-phase1-demo';
  return { filePath, sessionId, projectId, info: { filePath, projectId, sessionId } };
}

/** 造一批冷文件：真实写盘 + parseChunk 全量真值 + sidecar 虚拟边界注入冷 entry */
function buildV2Fixture(tmp, specs) {
  const scanner = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: false, hotDays: 7 });
  const parsed = [];
  for (const s of specs) {
    const sessionId = `s-${s.key}`;
    const lines = s.tsList.map((ts, i) => usageLine(`${s.key}-m${i}`, ts, sessionId));
    const { filePath, projectId } = writeSession(tmp, sessionId, lines);
    const full = parseChunk(lines.join('\n') + '\n', { projectId, sessionId });
    s.filePath = filePath;
    s.sessionId = sessionId;
    s.records = full.records;
    scanner.files.set(filePath, {
      filePath,
      sessionId,
      projectId,
      loaded: false,
      size: fs.statSync(filePath).size,
      // sidecar 虚拟边界：绕开 Windows 改不了 birthtime
      mtimeMs: s.lastTs,
      birthtimeMs: s.firstTs,
      records: [],
      events: [],
      meta: {},
    });
    parsed.push(s);
  }
  return { scanner, parsed };
}

/** 全量真值：文件内确有记录落在 [from,to] 的文件集合 */
function truthSet(parsed, from, to) {
  return new Set(
    parsed.filter((s) => s.records.some((r) => r.ts >= from && r.ts <= to)).map((s) => s.filePath),
  );
}
/** 候选集合：coldCandidates 返回的未加载文件 */
function candSet(scanner, from, to, truthMap = null) {
  return new Set(scanner.coldCandidates(from, to, truthMap).map((f) => f.filePath));
}
/** 零漏判：真值集合必须是候选集合的子集 */
function assertNoMiss(label, parsed, scanner, range, truthMap = null) {
  const truth = truthSet(parsed, range.from, range.to);
  const cand = candSet(scanner, range.from, range.to, truthMap);
  for (const t of truth) {
    assert.ok(cand.has(t), `${label} / ${range.name}: 漏判 ${path.basename(t)}`);
  }
  return { truth, cand };
}

/* ── 带 0 / ~1 年 / ~2 年时间分布、且历史区间确实有数据的合成夹具（计划 0.2 / R4） ── */
const V2_SPECS = [
  { key: 'today', firstTs: dayStart(0), lastTs: T0 + 15 * HOUR, tsList: [T0 + 9 * HOUR, T0 + 14 * HOUR] },
  { key: 'yesterday', firstTs: dayStart(1), lastTs: dayEnd(1), tsList: [dayStart(1) + 3 * HOUR, dayStart(1) + 15 * HOUR] },
  { key: '3d', firstTs: dayStart(3), lastTs: dayStart(3) + 12 * HOUR, tsList: [dayStart(3) + 10 * HOUR] },
  { key: '20d', firstTs: dayStart(20), lastTs: dayStart(20) + 10 * HOUR, tsList: [dayStart(20) + 8 * HOUR] },
  { key: '400d', firstTs: dayStart(400), lastTs: dayEnd(400), tsList: [dayStart(400) + 5 * HOUR, dayStart(400) + 18 * HOUR] },
  { key: '730d', firstTs: dayStart(730), lastTs: dayStart(730) + 8 * HOUR, tsList: [dayStart(730) + 6 * HOUR] },
  { key: '500d', firstTs: dayStart(500), lastTs: dayStart(500) + 9 * HOUR, tsList: [dayStart(500) + 6 * HOUR, dayStart(500) + 7 * HOUR] },
  // 老会话被重新写入：birth 在 ~600 天前，末次写入在今天 → 同时含历史与今天的数据
  { key: 'cross', firstTs: dayStart(600), lastTs: T0 + 2 * HOUR, tsList: [dayStart(600) + HOUR, T0 + HOUR] },
];

/* ==========================================================================
 * 1. 冷文件三态
 * ======================================================================== */
test('1. 冷文件三态：仍登记在 scanner.files、loaded=false、records/events 空、带 stat 指纹', async () => {
  const tmp = makeTmp('cold3');
  try {
    const s = writeSession(tmp, 'cold-one', [usageLine('cold-m0', T0 + HOUR, 'cold-one')]);
    const scanner = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: false, hotDays: 7 });
    scanner.isHot = () => false; // 强制判冷，避免依赖真实 mtime
    scanner.discover = async () => [s.info];
    await scanner.scan();

    assert.ok(scanner.files.has(s.filePath), 'R1：冷文件必须仍在 scanner.files 里');
    const e = scanner.files.get(s.filePath);
    assert.equal(e.loaded, false, '冷文件 loaded=false');
    assert.equal(e.records.length, 0, '冷文件不解析 records');
    assert.equal(e.events.length, 0, '冷文件不解析 events');
    assert.equal(e.size, fs.statSync(s.filePath).size, '带 size 指纹');
    assert.ok(Number.isFinite(e.mtimeMs) && e.mtimeMs > 0, '带 mtimeMs 指纹');
    assert.ok(Number.isFinite(e.birthtimeMs), '带 birthtimeMs 指纹');
    assert.equal(e.sessionId, s.sessionId);
    assert.equal(e.projectId, s.projectId);
    // 空条目不进 all() / latestActivity()
    assert.equal(scanner.all().records.length, 0, 'all() 跳过空 records+events 条目');
    assert.equal(scanner.latestActivity(), null, 'latestActivity 跳过空条目');
    const st = scanner.stats();
    assert.equal(st.total, 1);
    assert.equal(st.loaded, 0);
  } finally {
    tmp.cleanup();
  }
});

/* ==========================================================================
 * 2. V1：启动解析字节 ≤ 近 7 天文件字节 + 容差；连续 3 拍零解析 / 零 revision 抖动
 * ======================================================================== */
test('V1. 3 拍稳定态零解析 + 启动解析字节受近 7 天约束 + FORCE_FULL_LOAD 全加载', async () => {
  const tmp = makeTmp('v1');
  try {
    // 2 个热文件（mtime 保持刚写入），3 个冷文件（utimes 只改 mtime 到 ~400 天前）
    const infos = [];
    const hot = [];
    for (let i = 0; i < 2; i++) {
      const s = writeSession(tmp, `hot-${i}`, [usageLine(`hot-m${i}`, T0 + (i + 1) * HOUR, `hot-${i}`)]);
      hot.push(s);
      infos.push(s.info);
    }
    for (let i = 0; i < 3; i++) {
      const s = writeSession(tmp, `cold-${i}`, [usageLine(`cold-m${i}`, dayStart(400) + i * HOUR, `cold-${i}`)]);
      fs.utimesSync(s.filePath, new Date(NOW), new Date(T0 - 400 * DAY));
      infos.push(s.info);
    }
    const hotBytes = hot.reduce((a, s) => a + fs.statSync(s.filePath).size, 0);

    const scanner = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: false, hotDays: 7 });
    scanner.discover = async () => infos;
    // 启动第一拍：热文件整文件解析、冷文件只登记指纹（这一拍会因「新冷文件登记」返回 true，
    // 是启动那一次 rebuild，允许；关键是它不解析冷文件字节）
    await scanner.scan();
    const st0 = scanner.stats();
    assert.equal(st0.total, 5);
    assert.equal(st0.loaded, 2, '冷启动只加载 2 个热文件');
    assert.ok(
      scanner.parsedBytes > 0 && scanner.parsedBytes <= hotBytes * 1.1,
      `启动解析字节 ${scanner.parsedBytes} 应 ≤ 近 7 天文件字节 ${hotBytes} + 容差`,
    );

    const pb0 = scanner.parsedBytes;
    const lv0 = scanner.loadVersion;
    for (let i = 0; i < 3; i++) {
      const changed = await scanner.scan();
      assert.equal(changed, false, `稳定态第 ${i + 1} 拍 scan 应返回 false（不触发 rebuild / revision 抖动）`);
      assert.equal(scanner.parsedBytes, pb0, `第 ${i + 1} 拍 parsedBytes 不增长`);
      assert.equal(scanner.loadVersion, lv0, `第 ${i + 1} 拍 loadVersion 不变`);
    }
    assert.equal(scanner.stats().loaded, 2, '3 拍后仍未偷读冷文件');

    // 对比：forceFullLoad 时全部 loaded
    const full = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: true, hotDays: 7 });
    full.discover = async () => infos;
    await full.scan();
    assert.equal(full.stats().loaded, 5, 'forceFullLoad:true 全部 loaded');
    assert.equal(full.stats().total, 5);
    assert.ok(full.parsedBytes > scanner.parsedBytes, '全量路径解析字节更多');
  } finally {
    tmp.cleanup();
  }
});

/* ==========================================================================
 * 3. V2：六类入参候选集合 vs 全量真值零漏判（stat 路径）
 * ======================================================================== */
test('V2-a. 六类入参 + 全部：coldCandidates 候选集合对全量真值零漏判（stat 双边界）', async () => {
  const tmp = makeTmp('v2a');
  try {
    const specs = V2_SPECS.map((s) => ({ ...s, tsList: [...s.tsList] }));
    const { scanner, parsed } = buildV2Fixture(tmp, specs);
    for (const range of RANGES) {
      const { truth, cand } = assertNoMiss('V2-a', parsed, scanner, range, null);
      if (range.name === '全部') {
        assert.equal(cand.size, specs.length, '「全部」应把所有冷文件纳入候选');
        assert.equal(truth.size, specs.length, '每个文件都确有记录（历史区间非退化用例）');
      }
    }
    // 历史单日 / 自定义历史区间确实有数据，不是退化用例（计划 0.2 的 G1 前提）
    assert.ok(truthSet(parsed, dayStart(400), dayEnd(400)).size >= 1, '历史单日用例确实含数据');
    assert.ok(truthSet(parsed, dayStart(730), dayEnd(400)).size >= 3, '自定义历史区间确实含数据');
  } finally {
    tmp.cleanup();
  }
});

/* ==========================================================================
 * 3b. V2：索引真值优先（birthtime 被改写仍零漏判）
 * ======================================================================== */
test('V2-b. 索引真值优先：birthtime 被复制/还原改写时历史区间仍零漏判', async () => {
  const tmp = makeTmp('v2b');
  try {
    const specs = V2_SPECS.map((s) => ({ ...s, tsList: [...s.tsList] }));
    const { scanner, parsed } = buildV2Fixture(tmp, specs);

    // 模拟「复制 / 备份还原把 birthtime 重置为复制时刻」：400d 文件内容在 400 天前，
    // 但 stat 的 birth/mtime 都变成现在（计划 4.2 的兜底场景）。
    // 注：冷文件从未读过、索引又无真值时，stat 路径会对历史区间漏判 —— 这是计划
    // 4.5 明示的「兜底不完备」已知局限。本用例验证的正是索引真值把它补回来。
    const target = specs.find((s) => s.key === '400d');
    const e = scanner.files.get(target.filePath);
    e.birthtimeMs = T0 + HOUR;
    e.mtimeMs = T0 + 2 * HOUR;

    const truthMap = new Map(
      specs.map((s) => [s.filePath, { firstTs: s.firstTs, lastTs: s.lastTs, models: [] }]),
    );
    for (const range of RANGES) {
      const { truth, cand } = assertNoMiss('V2-b/truthMap', parsed, scanner, range, truthMap);
      if (truth.has(target.filePath)) {
        assert.ok(cand.has(target.filePath), `${range.name}: 真值兜底应召回 birth 被改写的文件`);
      }
    }
    // 历史单日这一最窄区间上，被改写文件必须被召回
    const hist = candSet(scanner, dayStart(400), dayEnd(400), truthMap);
    assert.ok(hist.has(target.filePath), '真值优先：历史单日不漏判被改写文件');
  } finally {
    tmp.cleanup();
  }
});

/* ==========================================================================
 * 3c. V2：truthMap 缺失 / 边界无效 → 保守多选
 * ======================================================================== */
test('V2-c. truthMap 缺失 + stat 边界无效 → 保守多选，任意区间都不漏', async () => {
  const tmp = makeTmp('v2c');
  try {
    const scanner = new Scanner({ forceFullLoad: false });
    const unknown = [];
    for (const key of ['unknown-a', 'unknown-b']) {
      const s = writeSession(tmp, key, [usageLine(`${key}-m0`, dayStart(500) + HOUR, key)]);
      scanner.files.set(s.filePath, {
        filePath: s.filePath,
        sessionId: s.sessionId,
        projectId: s.projectId,
        loaded: false,
        size: 1,
        mtimeMs: 0, // 无效 → last 退化为 Infinity
        birthtimeMs: 0, // 无效 → first 退化为 0
        records: [],
        events: [],
        meta: {},
      });
      unknown.push(s.filePath);
    }
    // unknown-b 给一条索引项但首尾时间戳为 null（等同缺失），也必须保守多选
    const partialTruth = new Map([[unknown[1], { firstTs: null, lastTs: null, models: [] }]]);
    for (const tm of [null, partialTruth]) {
      for (const range of RANGES) {
        const cand = candSet(scanner, range.from, range.to, tm);
        for (const u of unknown) {
          assert.ok(cand.has(u), `保守多选：${range.name} 应把信息缺失文件纳入候选（不漏）`);
        }
      }
    }
  } finally {
    tmp.cleanup();
  }
});

/* ==========================================================================
 * 4. V5：loadFile 失败不标记 loaded，恢复后重试成功（无永久漏数据）
 * ======================================================================== */
test('V5. loadFile 失败（文件被删 / 变成目录）后保持 loaded=false，恢复可重试成功', async () => {
  const tmp = makeTmp('v5');
  try {
    // 场景 A：文件被删 —— loadFile 返回 false，不标记 loaded
    const a = writeSession(tmp, 'retry-a', [
      usageLine('a-m0', dayStart(400), 'retry-a'),
      usageLine('a-m1', dayStart(400) + HOUR, 'retry-a'),
    ]);
    const sa = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: false });
    sa.isHot = () => false;
    sa.discover = async () => [a.info];
    await sa.scan();
    const ea = sa.files.get(a.filePath);
    assert.equal(ea.loaded, false);
    assert.equal(sa.loadVersion, 0);

    fs.rmSync(a.filePath);
    const r1 = await sa.loadFile(a.filePath);
    assert.equal(r1, false, '文件被删：loadFile 返回 false');
    assert.equal(ea.loaded, false, '失败不标记 loaded');
    assert.equal(sa.loadVersion, 0, '失败不推进 loadVersion');
    assert.equal(ea.records.length, 0);

    // 恢复文件后重试成功
    fs.writeFileSync(a.filePath, [usageLine('a-m0', dayStart(400), 'retry-a'), usageLine('a-m1', dayStart(400) + HOUR, 'retry-a')].join('\n') + '\n');
    const r2 = await sa.loadFile(a.filePath);
    assert.equal(r2, true, '恢复后重试成功');
    assert.equal(ea.loaded, true);
    assert.equal(ea.records.length, 2, '重试后拿到全部记录，无永久漏数据');
    assert.equal(sa.loadVersion, 1);

    // 场景 B：文件变成目录（readFile 抛 EISDIR）—— loadFile reject，仍不标记 loaded
    const b = writeSession(tmp, 'retry-b', [usageLine('b-m0', dayStart(400), 'retry-b')]);
    const sb = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: false });
    sb.isHot = () => false;
    sb.discover = async () => [b.info];
    await sb.scan();
    const eb = sb.files.get(b.filePath);
    fs.rmSync(b.filePath);
    fs.mkdirSync(b.filePath); // 同名目录，readFile 会抛
    await assert.rejects(() => sb.loadFile(b.filePath), 'readFile 失败应冒泡给 ensureLoaded 交前端 needsRetry');
    assert.equal(eb.loaded, false, 'reject 也不标记 loaded');
    assert.equal(eb.records.length, 0);

    // 恢复成正常文件，且 #exclusive 队列没被上一次 reject 卡住
    fs.rmdirSync(b.filePath);
    fs.writeFileSync(b.filePath, usageLine('b-m0', dayStart(400), 'retry-b') + '\n');
    const ok = await sb.loadFile(b.filePath);
    assert.equal(ok, true, '恢复后仍能成功（失败没破坏串行队列）');
    assert.equal(eb.loaded, true);
    assert.equal(eb.records.length, 1);
  } finally {
    tmp.cleanup();
  }
});

/* ==========================================================================
 * 5. 文件追加 / 重写 / 删除在冷、热两种状态下的行为
 * ======================================================================== */
test('5a. 冷状态：追加 / 重写只更新指纹不解析，删除才移除条目', async () => {
  const tmp = makeTmp('cold-change');
  try {
    const l0 = usageLine('m0', dayStart(400), 'cc');
    const l1 = usageLine('m1', dayStart(400) + HOUR, 'cc');
    const l2 = usageLine('m2', dayStart(400) + 2 * HOUR, 'cc');
    const s = writeSession(tmp, 'cc', [l0, l1]);
    const infos = [s.info];
    const scanner = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: false });
    scanner.isHot = () => false;
    scanner.discover = async () => infos;
    await scanner.scan(); // 冷登记
    const e = scanner.files.get(s.filePath);
    assert.equal(e.loaded, false);
    const size0 = e.size;

    // 追加：冷分支只更新指纹
    fs.appendFileSync(s.filePath, l2 + '\n');
    let changed = await scanner.scan();
    assert.equal(changed, false, '冷文件追加不算 changed（不触发 rebuild）');
    assert.equal(e.loaded, false);
    assert.equal(e.records.length, 0, '冷状态追加不解析内容');
    assert.ok(e.size > size0, '指纹 size 已更新');
    assert.equal(scanner.parsedBytes, 0, '冷状态全程零解析');

    // 重写（变小）：仍只更新指纹
    fs.writeFileSync(s.filePath, l0 + '\n');
    changed = await scanner.scan();
    assert.equal(changed, false);
    assert.equal(e.loaded, false);
    assert.equal(e.records.length, 0);
    assert.equal(e.size, fs.statSync(s.filePath).size);

    // 删除：从 scanner.files 移除
    fs.rmSync(s.filePath);
    infos.splice(0, infos.length); // discover 不再返回
    changed = await scanner.scan();
    assert.equal(changed, true, '删除触发一次 changed');
    assert.equal(scanner.files.has(s.filePath), false, '已删除文件从 Map 移除');
  } finally {
    tmp.cleanup();
  }
});

test('5b. 热状态：追加续读尾巴、重写全量重解析、删除移除条目', async () => {
  const tmp = makeTmp('hot-change');
  try {
    const l0 = usageLine('m0', T0 + HOUR, 'hc');
    const l1 = usageLine('m1', T0 + 2 * HOUR, 'hc');
    const l2 = usageLine('m2', T0 + 3 * HOUR, 'hc');
    const s = writeSession(tmp, 'hc', [l0, l1]);
    const infos = [s.info];
    const scanner = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: true });
    scanner.discover = async () => infos;
    await scanner.scan(); // 全量解析
    const e = scanner.files.get(s.filePath);
    assert.equal(e.loaded, true);
    assert.equal(e.records.length, 2);

    // 追加：读尾巴
    fs.appendFileSync(s.filePath, l2 + '\n');
    let changed = await scanner.scan();
    assert.equal(changed, true, '追加触发 changed');
    assert.equal(e.records.length, 3, '追加后 3 条');

    // 重写变小：整体重解析，不残留旧记录
    fs.writeFileSync(s.filePath, l0 + '\n');
    changed = await scanner.scan();
    assert.equal(changed, true);
    assert.equal(e.records.length, 1, '重写后只剩 1 条，不残留旧记录');
    assert.equal(e.records[0].id, 'm0');

    // 删除
    fs.rmSync(s.filePath);
    infos.splice(0, infos.length);
    changed = await scanner.scan();
    assert.equal(changed, true);
    assert.equal(scanner.files.has(s.filePath), false);
  } finally {
    tmp.cleanup();
  }
});

/* ==========================================================================
 * 6. 索引：损坏 / 版本不符 / 换数据源失效 + persist 脱敏 + truthMap key 对齐
 * ======================================================================== */
test('6. FileIndex：损坏/版本/换数据源返回 ok:false，persist 不含敏感字段，truthMap key 对齐', async () => {
  const tmp = makeTmp('index');
  try {
    const { cacheDir, projectsDir } = tmp;
    const idxPath = path.join(cacheDir, FILE_INDEX_NAME);

    // (a) 文件不存在：首次运行属正常
    const idx0 = new FileIndex({ cacheDir, projectsDir });
    assert.deepEqual(idx0.load(), { ok: true, created: true, files: 0 });

    // (b) 损坏 JSON
    fs.writeFileSync(idxPath, '{ broken json');
    const idx1 = new FileIndex({ cacheDir, projectsDir });
    const r1 = idx1.load();
    assert.equal(r1.ok, false, '损坏 JSON 应失效');
    assert.ok(r1.reason && r1.reason.length > 0, '带 reason');

    // 先写一份结构正确的索引（手工 entries， isolate 版本 / 数据源两个因素）
    const idxW = new FileIndex({ cacheDir, projectsDir });
    idxW.entries.set('d-phase1-demo/sess.jsonl', {
      size: 10, mtimeMs: 1, birthtimeMs: 1, firstTs: 1, lastTs: 2, models: ['m'],
    });
    await idxW.persist();
    const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    assert.equal(raw.version, FILE_INDEX_VERSION, '写出的版本与导出常量一致');

    // (c) 版本不符（sourceKey 正确）
    raw.version = FILE_INDEX_VERSION + 999;
    fs.writeFileSync(idxPath, JSON.stringify(raw));
    const idx2 = new FileIndex({ cacheDir, projectsDir });
    const r2 = idx2.load();
    assert.equal(r2.ok, false, '版本不符应整体失效');
    assert.ok(r2.reason, '带 reason');

    // (d) 换 projectsDir → sourceKey 不同 → 整体失效
    raw.version = FILE_INDEX_VERSION;
    fs.writeFileSync(idxPath, JSON.stringify(raw));
    const other = new FileIndex({ cacheDir, projectsDir: path.join(tmp.home, 'other-projects') });
    const r3 = other.load();
    assert.equal(r3.ok, false, '换 WORKBUDDY_HOME / projectsDir 应整体失效');

    // (e) persist 只写汇总量，不含 title / cwd / prompt 等敏感字段
    const SECRET = 'PHASE1_SECRET_TITLE_9f3a_DO_NOT_PERSIST';
    const proj = writeSession(tmp, 'sensitive', [
      JSON.stringify({ type: 'ai-title', timestamp: T0 + HOUR, sessionId: 'sensitive', aiTitle: SECRET, cwd: 'D:\\secret\\cwd' }),
      usageLine('sensitive-m0', T0 + 2 * HOUR, 'sensitive'),
    ]);
    const scanner = new Scanner({ fileCacheDir: cacheDir, forceFullLoad: true });
    scanner.discover = async () => [proj.info];
    await scanner.scan();
    const idxP = new FileIndex({ cacheDir, projectsDir });
    assert.ok(idxP.update(scanner) >= 1, '至少并入一个已加载文件');
    await idxP.persist();
    const text = fs.readFileSync(idxPath, 'utf8');
    assert.ok(!text.includes(SECRET), '索引不含会话标题');
    assert.ok(!text.includes('secret\\\\cwd') && !text.includes('D:\\\\secret'), '索引不含 cwd');
    assert.ok(!text.includes('prompt_tokens') && !text.includes('promptText'), '索引不含提示词/用量明细');
    const persisted = JSON.parse(text);
    for (const v of Object.values(persisted.files)) {
      assert.deepEqual(
        Object.keys(v).sort(),
        ['birthtimeMs', 'firstTs', 'lastTs', 'models', 'mtimeMs', 'size'].sort(),
        '每条只含白名单汇总字段',
      );
    }

    // (f) truthMap() 的 key 能与 scanner.files 的 key 对齐（相对路径 → 绝对路径）
    const idxT = new FileIndex({ cacheDir, projectsDir });
    idxT.update(scanner);
    const tm = idxT.truthMap();
    for (const key of scanner.files.keys()) {
      assert.ok(tm.has(key), `truthMap 应能对齐 ${key}`);
    }
  } finally {
    tmp.cleanup();
  }
});

/* ==========================================================================
 * 7. 口径白名单：forceFullLoad 全量 == 冷启动→全部按需加载，逐条恒等
 *    容差说明：两边都是 parseChunk 对同一批文件的确定性结果，且 store.records()
 *    按 ts 稳定排序、byId 按 messageId 去重，因此逐条 deepEqual，零容差。
 * ======================================================================== */
test('7. 口径白名单：全量路径与「冷启动→全部按需加载」逐条恒等（零容差）', async () => {
  const tmp = makeTmp('whitelist');
  try {
    const specs = [
      { sid: 'w-today', ts: [T0 + 9 * HOUR, T0 + 14 * HOUR], model: 'm-fast' },
      { sid: 'w-3d', ts: [dayStart(3) + 10 * HOUR], model: 'm-fast' },
      { sid: 'w-20d', ts: [dayStart(20) + 8 * HOUR], model: 'm-slow' },
      { sid: 'w-400d', ts: [dayStart(400) + 5 * HOUR, dayStart(400) + 18 * HOUR], model: 'm-slow' },
      { sid: 'w-730d', ts: [dayStart(730) + 6 * HOUR], model: 'm-fast' },
    ];
    const infos = specs.map((s) => {
      const lines = s.ts.map((ts, i) => usageLine(`${s.sid}-m${i}`, ts, s.sid, { model: s.model, credit: 0.3 + i * 0.1 }));
      return writeSession(tmp, s.sid, lines).info;
    });

    // 全量路径
    const full = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: true });
    full.discover = async () => infos;
    await full.scan();
    const fullAll = full.all();
    assert.equal(full.stats().loaded, specs.length);

    // 冷启动 → 全部按需加载
    const cold = new Scanner({ fileCacheDir: tmp.cacheDir, forceFullLoad: false, hotDays: 7 });
    cold.isHot = () => false; // 全冷
    cold.discover = async () => infos;
    await cold.scan();
    assert.equal(cold.stats().loaded, 0, '冷启动零加载');
    assert.equal(cold.stats().total, specs.length);
    for (const f of cold.files.values()) assert.equal(f.loaded, false);
    for (const info of infos) {
      const did = await cold.loadFile(info.filePath);
      assert.equal(did, true, `按需加载 ${path.basename(info.filePath)}`);
    }
    assert.equal(cold.stats().loaded, specs.length, '全部按需加载完成');
    const coldAll = cold.all();

    // 逐条恒等
    const norm = (r) => ({
      id: r.id, sessionId: r.sessionId, projectId: r.projectId, ts: r.ts,
      kind: r.kind, model: r.model, toolName: r.toolName,
      prompt: r.prompt, completion: r.completion, total: r.total,
      cacheRead: r.cacheRead, cacheMiss: r.cacheMiss, reasoning: r.reasoning, credit: r.credit,
    });
    const byId = (recs) => recs.map(norm).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    assert.equal(coldAll.records.length, fullAll.records.length, '记录数一致');
    assert.deepEqual(byId(coldAll.records), byId(fullAll.records), '逐条记录恒等（零容差）');

    // 逐会话统计恒等
    const bySid = (recs) => {
      const m = new Map();
      for (const r of recs) {
        let a = m.get(r.sessionId);
        if (!a) m.set(r.sessionId, (a = { requests: 0, prompt: 0, completion: 0, credit: 0 }));
        a.requests += 1;
        a.prompt += r.prompt;
        a.completion += r.completion;
        a.credit += r.credit;
      }
      return [...m.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([sid, a]) => ({ sid, ...a, credit: Number(a.credit.toFixed(6)) }));
    };
    assert.deepEqual(bySid(coldAll.records), bySid(fullAll.records), '逐会话统计恒等');
    assert.equal(coldAll.sessions.length, fullAll.sessions.length, '会话列表条数一致');
    const sessIds = (a) => a.sessions.map((s) => s.sessionId).sort();
    assert.deepEqual(sessIds(coldAll), sessIds(fullAll), '会话集合一致');
  } finally {
    tmp.cleanup();
  }
});
