#!/usr/bin/env node
/**
 * 第二阶段 · 阶段 0 只读原型
 *
 * 目标：为「冷启动只加载近 7 天文件」提供可复现的实测依据，输出 G1–G5 与 go/no-go。
 * 纪律：不改任何生产代码，不启动看板服务，不占端口；真实数据只读，报告不落项目名/标题/提示词/绝对路径。
 *
 * 用法：
 *   node tools/phase2-probe.mjs fixture              # 0.1 生成夹具与 sidecar
 *   node tools/phase2-probe.mjs recall              # 0.2 六类入参召回率（可与 0.3 并行）
 *   node tools/phase2-probe.mjs scanstate           # 0.3 R1 扫描器状态机模拟（可与 0.2 并行）
 *   node tools/phase2-probe.mjs coldstart           # 0.4 冷启动与规模外推（计时敏感，独占）
 *   node tools/phase2-probe.mjs index               # 0.5 索引体积与损坏回退（计时敏感，独占）
 *   node tools/phase2-probe.mjs report --tag=phase0 # 0.6 汇总与 go/no-go
 *
 * 各步独立进程、各写自己的 step-N.json，因此 0.2 / 0.3 可并行且互不干扰结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.phase2');
const FIX = path.join(OUT, 'fixtures');
const DAY = 86400_000;
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const argOf = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const TAG = argOf('tag', 'phase0');

/** 时间分布：按「每天固定新增文件数」生成，才符合 1~2 年后的真实模型。
 *  若按「固定总文件数均匀铺满」生成，近 7 天文件数也会随总量增长，外推会失真。 */
const SCALES = [
  { name: 'y1', years: 1, dailyFiles: 4, rows: 16 },
  { name: 'y2', years: 2, dailyFiles: 4, rows: 16 },
  { name: 'y3', years: 3, dailyFiles: 4, rows: 16 },
];
const FLAT = { name: 'flat', years: 0, dailyFiles: 0, rows: 16 };

const ensureOut = () => fs.mkdirSync(OUT, { recursive: true });
const stepPath = (n) => path.join(OUT, `step-${n}.json`);
function writeStep(n, data) {
  ensureOut();
  fs.writeFileSync(stepPath(n), JSON.stringify(data, null, 2));
  console.log(`[step ${n}] 已写入 ${path.basename(stepPath(n))}`);
}
function readStep(n) {
  if (!fs.existsSync(stepPath(n))) throw new Error(`缺少 step-${n}.json，请先执行对应步骤`);
  return JSON.parse(fs.readFileSync(stepPath(n), 'utf8'));
}
const metaPath = () => path.join(OUT, 'meta.json');
function readMeta() {
  if (!fs.existsSync(metaPath())) throw new Error('缺少 .phase2/meta.json，请先跑 fixture');
  return JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
}
const fxDir = (name) => path.join(FIX, name);
const sidecar = (name) => JSON.parse(fs.readFileSync(path.join(fxDir(name), 'files.json'), 'utf8'));
const localZero = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/* ============================ 0.1 夹具 ============================ */

function makeLine(sid, ts, i) {
  return JSON.stringify({
    type: 'message',
    role: 'assistant',
    timestamp: ts,
    sessionId: sid,
    providerData: {
      model: `probe-m-${i % 3}`,
      traceId: `trace-${sid}-${Math.floor(i / 3)}`,
      conversationRequestId: `req-${sid}-${i}`,
      rawUsage: {
        prompt_tokens: 70000 + i * 13,
        completion_tokens: 600 + i * 7,
        total_tokens: 70600 + i * 20,
        prompt_cache_hit_tokens: 63000 + i * 11,
        prompt_cache_miss_tokens: 7000 + i * 2,
        credit: 3.21,
      },
    },
  });
}

/** 生成一档夹具。返回 { files, totalBytes } */
function buildFixture(scale, now) {
  const dir = fxDir(scale.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });

  const isFlat = scale.years === 0;
  const days = isFlat ? 30 : Math.round(scale.years * 365);
  const totalFiles = isFlat ? 400 : days * scale.dailyFiles;
  const files = [];
  let totalBytes = 0;
  const madeDirs = new Set();

  for (let i = 0; i < totalFiles; i++) {
    // 每天固定新增 dailyFiles 个文件；flat 对照把 400 个文件全放在「今天」
    const dayIdx = isFlat ? 0 : Math.floor(i / scale.dailyFiles);
    const firstTs = isFlat
      ? now - 30 * DAY + ((i * 3_600_000) % (29 * DAY))
      : now - (days - dayIdx) * DAY + (i % scale.dailyFiles) * 3_600_000;
    const activeDays = 1 + (i % 14);
    const lastTs = Math.min(now, firstTs + activeDays * DAY);
    // mtime 恒不早于内容最后时间戳（实测偏差方向，安全）；最大约 6 天
    const lag = (i % 7) * DAY;
    const mtime = Math.min(now, lastTs + lag);
    // birth 略早于首条记录；flat 对照刻意设为「刚生成」，复现旧 perf-bench 夹具缺陷
    const birth = isFlat ? now : firstTs - 60_000;

    const sid = `probe-${scale.name}-${String(i).padStart(5, '0')}`;
    const proj = `p-${String(i % 20).padStart(3, '0')}`;
    const rel = path.join('projects', proj, `${sid}.jsonl`);
    const abs = path.join(dir, rel);
    const parent = path.dirname(abs);
    if (!madeDirs.has(parent)) {
      fs.mkdirSync(parent, { recursive: true });
      madeDirs.add(parent);
    }

    const lines = [];
    const span = Math.max(1, lastTs - firstTs);
    for (let r = 0; r < scale.rows; r++) {
      lines.push(makeLine(sid, firstTs + Math.floor((span * r) / scale.rows), r));
    }
    const text = lines.join('\n') + '\n';
    fs.writeFileSync(abs, text);
    const size = Buffer.byteLength(text);
    totalBytes += size;

    files.push({
      rel,
      size,
      birth,
      mtime,
      firstTs,
      lastTs: firstTs + Math.floor((span * (scale.rows - 1)) / scale.rows),
      count: scale.rows,
      models: [`probe-m-0`, `probe-m-1`, `probe-m-2`],
    });
  }

  fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(files));
  return { files, totalBytes, totalFiles };
}

function fixture() {
  ensureOut();
  fs.mkdirSync(FIX, { recursive: true });
  const now = Date.now();
  const t0 = performance.now();
  const built = [];
  for (const s of [...SCALES, FLAT]) {
    const r = buildFixture(s, now);
    built.push({ name: s.name, years: s.years, dailyFiles: s.dailyFiles, files: r.totalFiles, bytes: r.totalBytes });
    console.log(`[fixture] ${s.name}: ${r.totalFiles} 文件 / ${(r.totalBytes / 1048576).toFixed(1)} MB`);
  }
  const meta = { now, generatedAt: new Date(now).toISOString(), scales: built, rowsPerFile: 16 };
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
  writeStep(1, {
    step: '0.1',
    ...meta,
    elapsedMs: +(performance.now() - t0).toFixed(1),
    note: '虚拟 birthtime/mtime 存于各夹具 files.json；不依赖 utimes 改 birthtime（Windows 不可改）。flat 为负面对照，不计入 G1。',
  });
}

/* ======================= 0.2 双边界召回率 ======================= */

/** 六类入参；历史单日/区间从真值里挑「确实有数据」的日期，避免 v2 的退化用例 */
function buildCases(now, entries) {
  const today0 = localZero(now);
  const firsts = entries.map((e) => e.firstTs).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  const histMid = firsts.length ? localZero(firsts[Math.floor(firsts.length / 2)]) : today0 - 60 * DAY;
  const histStart = firsts.length ? localZero(firsts[0]) : today0 - 90 * DAY;
  return [
    { label: '今天', from: today0, to: Infinity },
    { label: '昨天', from: today0 - DAY, to: today0 - 1 },
    { label: '近 7 天', from: localZero(now - 7 * DAY), to: Infinity },
    { label: '近 30 天', from: localZero(now - 30 * DAY), to: Infinity },
    { label: '历史单日', from: histMid, to: histMid + DAY - 1 },
    { label: '历史区间', from: histStart, to: histStart + 12 * DAY - 1 },
    { label: '全部', from: -Infinity, to: Infinity },
  ];
}

/** truth 用逐条记录判定（真实数据）或 firstTs/lastTs 区间判定（合成夹具，时间戳单调） */
function evaluate(label, entries, cases, truthMode) {
  return cases.map((c) => {
    const cand = entries.filter((e) => e.birth <= c.to && e.mtime >= c.from);
    const truth = entries.filter((e) =>
      truthMode === 'records'
        ? e.ts.some((t) => t >= c.from && t <= c.to)
        : e.firstTs <= c.to && e.lastTs >= c.from,
    );
    const candSet = new Set(cand.map((e) => e.key));
    const miss = truth.filter((e) => !candSet.has(e.key));
    const truthSet = new Set(truth.map((e) => e.key));
    const extra = cand.filter((e) => !truthSet.has(e.key));
    return {
      label: c.label,
      truth: truth.length,
      candidate: cand.length,
      missed: miss.length,
      extra: extra.length,
      bytes: cand.reduce((a, e) => a + (e.size || 0), 0),
      hasData: truth.length > 0,
    };
  });
}

async function recall() {
  const meta = readMeta();
  const now = meta.now;
  const datasets = [];

  // 真实数据：只读扫描一次，绝不输出路径 / 标题
  const { Scanner } = await import('../server/src/scanner.js');
  const scanner = new Scanner({ fileCacheDir: null });
  const t0 = performance.now();
  await scanner.scan();
  const realEntries = [];
  for (const f of scanner.files.values()) {
    let birth = 0;
    try {
      birth = fs.statSync(f.filePath).birthtimeMs;
    } catch {
      birth = 0;
    }
    const ts = (f.records || []).map((r) => r.ts).filter((t) => Number.isFinite(t) && t > 0);
    realEntries.push({
      key: String(realEntries.length),
      birth: birth || f.mtimeMs,
      mtime: f.mtimeMs,
      size: f.size || 0,
      firstTs: ts.length ? Math.min(...ts) : f.mtimeMs,
      lastTs: ts.length ? Math.max(...ts) : f.mtimeMs,
      ts,
    });
  }
  datasets.push({
    name: 'real-173',
    kind: 'real',
    files: realEntries.length,
    bytes: realEntries.reduce((a, e) => a + e.size, 0),
    cases: evaluate('real', realEntries, buildCases(now, realEntries), 'records'),
    scanMs: +(performance.now() - t0).toFixed(1),
    countsInG1: true,
  });

  // 合成夹具
  for (const s of meta.scales) {
    const list = sidecar(s.name);
    const entries = list.map((f, i) => ({ ...f, key: String(i) }));
    datasets.push({
      name: s.name,
      kind: s.name === 'flat' ? 'negative-control' : 'synthetic',
      files: entries.length,
      bytes: s.bytes,
      cases: evaluate(s.name, entries, buildCases(now, entries), 'range'),
      countsInG1: s.name !== 'flat',
    });
  }

  const g1Cases = datasets.filter((d) => d.countsInG1).flatMap((d) => d.cases.map((c) => ({ ...c, ds: d.name })));
  const missed = g1Cases.filter((c) => c.missed > 0);
  const degenerate = g1Cases.filter((c) => !c.hasData);
  writeStep(2, {
    step: '0.2',
    datasets,
    g1: {
      pass: missed.length === 0,
      totalCases: g1Cases.length,
      casesWithData: g1Cases.filter((c) => c.hasData).length,
      degenerateCases: degenerate.length,
      missedCases: missed.length,
      missed,
    },
    note: 'flat 为负面对照：所有文件 birthtime=生成时刻，历史区间必然漏判，用于证明旧 perf-bench 夹具不可用；不计入 G1。',
  });
  for (const d of datasets) {
    const m = d.cases.filter((c) => c.missed > 0).length;
    console.log(`[recall] ${d.name}: ${d.cases.length} 用例 / 漏判用例 ${m}${d.countsInG1 ? '' : '（负面对照，不计入 G1）'}`);
  }
  console.log(`[recall] G1: ${missed.length === 0 ? 'PASS' : 'FAIL'}（含数据用例 ${g1Cases.filter((c) => c.hasData).length}/${g1Cases.length}）`);
}

/* ==================== 0.3 R1 扫描器状态机 ==================== */

function simulate(name, entries, fixDir, mode, ticks = 3) {
  const map = new Map();
  let bootReadBytes = 0;
  let bootParsed = 0;
  const hot = entries.filter((e) => e.mtime >= readMeta().now - 7 * DAY);
  const cold = entries.filter((e) => e.mtime < readMeta().now - 7 * DAY);

  // 启动：只解析热文件
  for (const e of hot) {
    const text = fs.readFileSync(path.join(fixDir, e.rel), 'utf8');
    bootReadBytes += Buffer.byteLength(text);
    for (const line of text.split('\n')) if (line.trim()) JSON.parse(line);
    bootParsed++;
    map.set(e.rel, { size: e.size, mtime: e.mtime, loaded: true });
  }
  // 计划实现：冷文件也登记指纹，但 loaded=false
  if (mode === 'planned') {
    for (const e of cold) map.set(e.rel, { size: e.size, mtime: e.mtime, loaded: false });
  }

  const ticksLog = [];
  for (let t = 1; t <= ticks; t++) {
    let readBytes = 0;
    let parsed = 0;
    let changed = false;
    for (const e of entries) {
      const prev = map.get(e.rel);
      if (prev && prev.size === e.size && prev.mtime === e.mtime) {
        if (mode === 'planned' && !prev.loaded) continue; // 只更新指纹，不解析
        continue;
      }
      if (mode === 'planned' && prev && !prev.loaded) {
        prev.size = e.size;
        prev.mtime = e.mtime;
        continue;
      }
      // 朴素实现：冷文件无 prev ⇒ 当成新文件整文件解析
      const text = fs.readFileSync(path.join(fixDir, e.rel), 'utf8');
      readBytes += Buffer.byteLength(text);
      for (const line of text.split('\n')) if (line.trim()) JSON.parse(line);
      parsed++;
      map.set(e.rel, { size: e.size, mtime: e.mtime, loaded: true });
      changed = true;
    }
    ticksLog.push({ tick: t, readBytes, parsed, changed });
  }
  return {
    mode: name,
    hotFiles: hot.length,
    coldFiles: cold.length,
    bootReadBytes,
    bootParsed,
    ticks: ticksLog,
    totalReadAfterBoot: ticksLog.reduce((a, t) => a + t.readBytes, 0),
    changedTicks: ticksLog.filter((t) => t.changed).length,
  };
}

function scanstate() {
  const meta = readMeta();
  const dir = fxDir('y2');
  const entries = sidecar('y2');
  const naive = simulate('naive（冷文件不进 Map）', entries, dir, 'naive');
  const planned = simulate('planned（冷文件登记指纹 loaded=false）', entries, dir, 'planned');
  const pass = planned.totalReadAfterBoot === 0 && planned.changedTicks === 0;
  writeStep(3, {
    step: '0.3',
    naive,
    planned,
    g2: { pass, criterion: '计划实现 3 拍内冷文件解析字节数 = 0 且 revision 不推进' },
    note: 'R1 的准确后果：朴素实现在启动后第一拍定时扫描就把冷文件全量读回（一次性，非每拍重复），并触发一次 rebuild/revision 抖动；收益归零但只发生一次。',
  });
  console.log(`[scanstate] 朴素: 启动后 3 拍共读 ${(naive.totalReadAfterBoot / 1048576).toFixed(1)} MB / changed ${naive.changedTicks} 拍`);
  console.log(`[scanstate] 计划: 启动后 3 拍共读 ${planned.totalReadAfterBoot} B / changed ${planned.changedTicks} 拍`);
  console.log(`[scanstate] G2: ${pass ? 'PASS' : 'FAIL'}`);
}

/* ==================== 0.4 冷启动与外推 ==================== */

function parseFiles(absPaths) {
  const t0 = performance.now();
  let bytes = 0;
  let lines = 0;
  for (const p of absPaths) {
    const text = fs.readFileSync(p, 'utf8');
    bytes += Buffer.byteLength(text);
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        JSON.parse(raw);
        lines++;
      } catch {
        /* 容忍脏行，与 parseChunk 一致 */
      }
    }
  }
  return { ms: +(performance.now() - t0).toFixed(1), bytes, lines };
}

function coldstart() {
  const meta = readMeta();
  const now = meta.now;

  // 真实数据：只列文件与 stat，不解析全历史拿列表，避免污染计时
  const projRoot = path.join(os.homedir(), '.workbuddy', 'projects');
  const realAll = [];
  if (fs.existsSync(projRoot)) {
    for (const d of fs.readdirSync(projRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(projRoot, d.name);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          realAll.push({ p, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* 忽略瞬时不可读 */
        }
      }
    }
  }
  const hot7 = realAll.filter((f) => f.mtime >= now - 7 * DAY);
  const rss0 = process.memoryUsage().rss;
  const realHot = parseFiles(hot7.map((f) => f.p));
  const rssHot = process.memoryUsage().rss;
  const realAllParse = parseFiles(realAll.map((f) => f.p));
  const rssAll = process.memoryUsage().rss;

  // 合成夹具：按「每天固定新增文件数」模型实测三档规模
  const scales = [];
  for (const s of meta.scales.filter((x) => x.name !== 'flat')) {
    const dir = fxDir(s.name);
    const list = sidecar(s.name);
    const abs = list.map((f) => path.join(dir, f.rel));
    const hotAbs = list.filter((f) => f.mtime >= now - 7 * DAY).map((f) => path.join(dir, f.rel));
    const all = parseFiles(abs);
    const hot = parseFiles(hotAbs);
    scales.push({
      name: s.name,
      years: s.years,
      files: list.length,
      hotFiles: hotAbs.length,
      totalBytes: all.bytes,
      hotBytes: hot.bytes,
      allMs: all.ms,
      hotMs: hot.ms,
      ratio: +(hot.bytes / Math.max(1, all.bytes)).toFixed(4),
    });
  }

  // ×2 / ×5 / ×10 线性外推（基于 y3 的单位字节成本；明确标注为估算）。
  // 关键：本夹具是「每天固定新增文件数」模型，近 7 天的文件数与字节**不随历史总量增长**，
  // 所以 hot7 耗时保持恒定；若把 hot7 也乘 k 会得出与实测相悖的结论。
  const base = scales[scales.length - 1];
  const perMB = base.allMs / Math.max(1, base.totalBytes / 1048576);
  const extrapolate = [2, 5, 10].map((k) => ({
    factor: `x${k}`,
    files: base.files * k,
    totalMB: +((base.totalBytes * k) / 1048576).toFixed(1),
    fullParseMsEstimate: +(perMB * ((base.totalBytes * k) / 1048576)).toFixed(1),
    hot7Files: base.hotFiles,
    hot7ParseMsEstimate: base.hotMs,
    note: '固定日活模型：近 7 天文件数/字节不随历史总量增长，启动耗时保持恒定；只有「每天文件数」本身增加时才会上升',
  }));

  const realRatio = +(realHot.bytes / Math.max(1, realAllParse.bytes)).toFixed(4);
  const hotStatBytes = hot7.reduce((a, f) => a + f.size, 0);
  // G3 判的是「有没有偷读冷文件」：解析字节应与近 7 天文件自身的 stat 字节一致。
  // realRatio（近7天字节 / 全量字节）只是收益指标，不能拿来当门槛，否则逻辑是循环的。
  const noExtraRead = realHot.bytes <= hotStatBytes * 1.1;
  const g3 = {
    pass: noExtraRead,
    criterion: '近 7 天解析字节数 ≤ 近 7 天文件 stat 字节数 × 1.1（即未偷读冷文件）',
    hotStatBytes,
    parsedBytes: realHot.bytes,
    overshoot: +(realHot.bytes / Math.max(1, hotStatBytes)).toFixed(4),
    realRatio,
  };
  writeStep(4, {
    step: '0.4',
    real: {
      totalFiles: realAll.length,
      hot7Files: hot7.length,
      totalBytes: realAllParse.bytes,
      hot7Bytes: realHot.bytes,
      fullParseMs: realAllParse.ms,
      hot7ParseMs: realHot.ms,
      hot7RssDeltaMB: +((rssHot - rss0) / 1048576).toFixed(1),
      fullRssDeltaMB: +((rssAll - rssHot) / 1048576).toFixed(1),
      byteRatio: realRatio,
    },
    synthetic: scales,
    extrapolate,
    g3,
    note: '计时为「readFileSync + 逐行 JSON.parse」的原型测量，未含 deriveTimings 等派生统计；同进程顺序执行，RSS 为阶段增量。',
  });
  console.log(`[coldstart] 真实: 全量 ${realAllParse.ms}ms / 近7天 ${realHot.ms}ms，字节占比 ${(realRatio * 100).toFixed(1)}%`);
  console.log(`[coldstart] G3: ${g3.pass ? 'PASS' : 'FAIL'}`);
}

/* ==================== 0.5 索引体积与回退 ==================== */

function indexBench() {
  const list = sidecar('y2');
  const schema = (files) => ({
    version: 1,
    generatedAt: new Date().toISOString(),
    files: files.map((f) => ({
      p: f.rel,
      size: f.size,
      mtime: f.mtime,
      birth: f.birth,
      firstTs: f.firstTs,
      lastTs: f.lastTs,
      count: f.count,
      models: f.models,
    })),
  });
  const rows = [];
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const n of [500, 5000]) {
    const pool = [];
    while (pool.length < n) pool.push(...list);
    const data = schema(pool.slice(0, n));
    const file = path.join(OUT, `index-probe-${n}.json`);
    const writeSamples = [];
    const readSamples = [];
    let versionOk = false;
    // 跑 3 次取中位数：首次 writeFileSync 含文件创建，直接记单次会把噪声当成结论
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      fs.writeFileSync(file, JSON.stringify(data));
      writeSamples.push(performance.now() - t0);
      const t1 = performance.now();
      const back = JSON.parse(fs.readFileSync(file, 'utf8'));
      readSamples.push(performance.now() - t1);
      if (k === 2) versionOk = back.version === 1;
    }
    const bytes = fs.statSync(file).size;
    rows.push({
      files: n,
      bytes,
      bytesPerFile: +(bytes / n).toFixed(1),
      writeMs: +median(writeSamples).toFixed(2),
      readMs: +median(readSamples).toFixed(2),
      samples: 3,
      versionOk: !!versionOk,
    });
  }
  // 损坏回退
  const broken = path.join(OUT, 'index-probe-broken.json');
  fs.writeFileSync(broken, '{"version":1,"files":[{"p":"x"');
  let fallback = false;
  try {
    const v = JSON.parse(fs.readFileSync(broken, 'utf8'));
    fallback = v.version !== 1;
  } catch {
    fallback = true;
  }
  fs.rmSync(broken, { force: true });
  writeStep(5, {
    step: '0.5',
    rows,
    damageFallback: fallback,
    g4: { pass: fallback && rows.every((r) => r.versionOk), criterion: '体积/耗时入表，损坏可检测并回退' },
    note: '索引只记汇总量，不写标题/cwd/提示词；写入用临时文件+rename 属阶段 1 实现项，本步只测体积与耗时。',
  });
  for (const r of rows) console.log(`[index] ${r.files} 文件: ${r.bytes} B (${r.bytesPerFile} B/文件), 写 ${r.writeMs}ms 读 ${r.readMs}ms`);
  console.log(`[index] 损坏回退: ${fallback ? 'PASS' : 'FAIL'}`);
}

/* ==================== 0.6 汇总 ==================== */

function report() {
  const [s1, s2, s3, s4, s5] = [1, 2, 3, 4, 5].map(readStep);
  const g1 = s2.g1;
  const g2 = s3.g2;
  const g3 = s4.g3;
  const g4 = s5.g4;
  const hard = { G1: g1.pass, G2: g2.pass, G3: g3.pass };
  const go = Object.values(hard).every(Boolean);
  const result = {
    tag: TAG,
    generatedAt: new Date().toISOString(),
    scope: '阶段 0 只读原型；未改生产代码、未启服务',
    baseline: { realFiles: s4.real.totalFiles, realBytes: s4.real.totalBytes, fullParseMs: s4.real.fullParseMs, hot7ParseMs: s4.real.hot7ParseMs },
    gates: { G1: g1, G2: g2, G3: g3, G4: g4, G5: { defined: false, note: '1~2 年规模的启动目标阈值由结衣看完外推曲线后设定；本步未擅自定' } },
    hardGates: hard,
    conclusion: go ? 'GO' : 'NO-GO',
    fallbackIfNoGo: '索引真值优先 → 保守多选 → 单边界 mtime + 全量兜底；不进入阶段 1，回到方案讨论',
    steps: { '0.1': s1, '0.2': s2, '0.3': s3, '0.4': s4, '0.5': s5 },
  };
  ensureOut();
  fs.writeFileSync(path.join(OUT, `probe-${TAG}.json`), JSON.stringify(result, null, 2));

  console.log('\n========== 阶段 0 分项计时表 ==========');
  console.log(`夹具: ${s1.scales.map((x) => `${x.name} ${x.files}文件/${(x.bytes / 1048576).toFixed(1)}MB`).join(' | ')}`);
  console.log(`真实数据: ${s4.real.totalFiles} 文件 / ${(s4.real.totalBytes / 1048576).toFixed(1)} MB；全量解析 ${s4.real.fullParseMs}ms → 近7天 ${s4.real.hot7ParseMs}ms`);
  console.log(`G1 召回率 ${g1.pass ? 'PASS' : 'FAIL'}（含数据用例 ${g1.casesWithData}/${g1.totalCases}，漏判 ${g1.missedCases}）`);
  console.log(`G2 状态机 ${g2.pass ? 'PASS' : 'FAIL'}（计划实现 3 拍冷文件解析 ${s3.planned.totalReadAfterBoot} B）`);
  console.log(`G3 冷启动 ${g3.pass ? 'PASS' : 'FAIL'}（字节占比 ${(g3.realRatio * 100).toFixed(1)}%）`);
  console.log(`G4 索引 ${g4.pass ? 'PASS' : 'FAIL'}（500/5000 文件体积见 step-0.5）`);
  console.log(`G5 目标阈值：待结衣看完外推曲线后设定（本步不擅自定）`);
  console.log(`结论: ${result.conclusion}`);
  console.log(`报告: .phase2/probe-${TAG}.json`);
}

const runners = { fixture, recall, scanstate, coldstart, index: indexBench, report };
if (!runners[cmd]) {
  console.log('用法: node tools/phase2-probe.mjs <fixture|recall|scanstate|coldstart|index|report> [--tag=xxx]');
  process.exit(1);
}
try {
  await runners[cmd]();
} catch (e) {
  console.error(`[phase2-probe] ${cmd} 失败:`, e);
  process.exit(1);
}
