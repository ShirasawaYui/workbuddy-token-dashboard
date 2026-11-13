#!/usr/bin/env node
/**
 * 阶段 0 · G5 推定（只读）
 *
 * 用真实的近一个月 WorkBuddy JSONL 按天聚合「新增字节 / 行数 / 文件数」，
 * 再用阶段 0 实测的解析吞吐与 stat 开销外推 2 年，给出 G5 启动目标阈值的建议值。
 *
 * 纪律：不启服务、不占端口、不改业务代码；真实数据只读，报告只落聚合量，
 *      不写项目名 / 目录名 / 标题 / 提示词 / 绝对路径。
 *
 * 用法：node tools/phase2-g5.mjs
 * 依赖：.phase2/step-4.json（阶段 0 冷启动实测吞吐）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.phase2');
const PROJ = path.join(os.homedir(), '.workbuddy', 'projects');
const DAY = 86400_000;
const MB = 1048576;
const HORIZON_DAYS = 730; // 2 年

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localZero = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] || 0;

/* ---------- 1. 真实数据：逐行按天聚合 ---------- */
function scanReal() {
  const daily = new Map(); // dayKey -> { bytes, lines }
  const filesByDay = new Map(); // dayKey -> 新增文件数（按 birthtime）
  let totalFiles = 0;
  let totalBytes = 0;
  let totalLines = 0;
  let noTimestampLines = 0;
  let birthVsContentMismatch = 0;
  let minTs = Infinity;
  let maxTs = 0;

  const bump = (map, key, field, n) => {
    let v = map.get(key);
    if (!v) map.set(key, (v = { bytes: 0, lines: 0, files: 0 }));
    v[field] += n;
  };

  const dirs = fs.readdirSync(PROJ, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const dir = path.join(PROJ, d.name);
    for (const fn of fs.readdirSync(dir)) {
      if (!fn.endsWith('.jsonl')) continue;
      const p = path.join(dir, fn);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      totalFiles++;
      totalBytes += st.size;

      const birthKey = dayKey(st.birthtimeMs);
      bump(filesByDay, birthKey, 'files', 1);

      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      let firstContentTs = Infinity;
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        totalLines++;
        const lineBytes = Buffer.byteLength(raw) + 1;
        let ts = NaN;
        try {
          const o = JSON.parse(raw);
          ts = Number(o.timestamp);
          if (ts && ts < 1e12) ts *= 1000;
        } catch {
          /* 脏行：仍计字节，归到文件创建日 */
        }
        if (!Number.isFinite(ts) || ts <= 0) {
          noTimestampLines++;
          bump(daily, birthKey, 'bytes', lineBytes);
          bump(daily, birthKey, 'lines', 1);
          continue;
        }
        if (ts < firstContentTs) firstContentTs = ts;
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
        bump(daily, dayKey(ts), 'bytes', lineBytes);
        bump(daily, dayKey(ts), 'lines', 1);
      }
      if (Number.isFinite(firstContentTs) && dayKey(firstContentTs) !== birthKey) birthVsContentMismatch++;
    }
  }
  return {
    daily,
    filesByDay,
    totalFiles,
    totalBytes,
    totalLines,
    noTimestampLines,
    birthVsContentMismatch,
    minTs,
    maxTs,
    projectDirs: dirs.length,
  };
}

/* ---------- 2. 实测每文件 stat / readdir 固定开销 ---------- */
function scanOverhead() {
  const dirs = fs.readdirSync(PROJ, { withFileTypes: true }).filter((d) => d.isDirectory());
  const files = [];
  for (const d of dirs) {
    const dir = path.join(PROJ, d.name);
    for (const fn of fs.readdirSync(dir)) if (fn.endsWith('.jsonl')) files.push(path.join(dir, fn));
  }
  const statSamples = [];
  const readdirSamples = [];
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    for (const p of files) {
      try {
        fs.statSync(p);
      } catch {
        /* ignore */
      }
    }
    statSamples.push(performance.now() - t0);
    const t1 = performance.now();
    for (const d of dirs) {
      try {
        fs.readdirSync(path.join(PROJ, d.name));
      } catch {
        /* ignore */
      }
    }
    readdirSamples.push(performance.now() - t1);
  }
  const statMs = median(statSamples);
  const readdirMs = median(readdirSamples);
  return { files: files.length, dirs: dirs.length, statMs, readdirMs, msPerFile: statMs / Math.max(1, files.length) };
}

/* ---------- 3. 近 30 / 7 个完整自然日的速率模型 ---------- */
function rates(scan, now) {
  const today0 = localZero(now);
  const dayList = (n) => {
    const out = [];
    for (let i = n; i >= 1; i--) {
      const key = dayKey(today0 - i * DAY);
      const v = scan.daily.get(key) || { bytes: 0, lines: 0, files: 0 };
      const f = scan.filesByDay.get(key)?.files || 0;
      out.push({ date: key, bytes: v.bytes, lines: v.lines, files: f });
    }
    return out;
  };
  const d30 = dayList(30);
  const d7 = dayList(7);
  const bytes30 = d30.map((x) => x.bytes);
  const active = bytes30.filter((x) => x > 0);
  const models = {
    A_30d_mean: {
      label: '基准 A：近 30 个完整自然日均值',
      bytesPerDay: mean(bytes30),
      linesPerDay: mean(d30.map((x) => x.lines)),
      filesPerDay: mean(d30.map((x) => x.files)),
    },
    B_7d_mean: {
      label: '近期 B：近 7 个完整自然日均值',
      bytesPerDay: mean(d7.map((x) => x.bytes)),
      linesPerDay: mean(d7.map((x) => x.lines)),
      filesPerDay: mean(d7.map((x) => x.files)),
    },
    C_active_or_p90: {
      label: '压力 C：活跃日均值与 P90 单日取大',
      bytesPerDay: Math.max(mean(active), p90(bytes30)),
      linesPerDay: Math.max(mean(d30.filter((x) => x.lines > 0).map((x) => x.lines)), p90(d30.map((x) => x.lines))),
      filesPerDay: Math.max(mean(d30.filter((x) => x.files > 0).map((x) => x.files)), p90(d30.map((x) => x.files))),
    },
  };
  const weekly = [];
  for (let w = 0; w < 4; w++) {
    const slice = d30.slice(w * 7, w * 7 + 7);
    weekly.push({ window: `T-${4 - w}周`, bytes: slice.reduce((a, x) => a + x.bytes, 0), lines: slice.reduce((a, x) => a + x.lines, 0) });
  }
  return { d30, d7, models, weekly, activeDays: active.length };
}

/* ---------- 4. 外推 2 年 ---------- */
function extrapolate(scan, ov, rate, bench) {
  const msPerMBFull = bench.real.fullParseMs / (bench.real.totalBytes / MB);
  const msPerMBHot = bench.real.hot7ParseMs / (bench.real.hot7Bytes / MB);
  const hot7Bytes = rate.bytesPerDay * 7;
  const futureBytes = rate.bytesPerDay * HORIZON_DAYS;
  const totalBytes = scan.totalBytes + futureBytes;
  const files2y = scan.totalFiles + rate.filesPerDay * HORIZON_DAYS;
  const scale = files2y / Math.max(1, scan.totalFiles);

  // 不做优化的对照组：全量解析
  const fullParseMs = msPerMBFull * (totalBytes / MB);
  // 本方案：stat 全部文件（随历史涨）+ readdir（近似按同比例）+ 只解析近 7 天
  const statMs2y = ov.statMs * scale;
  const readdirMs2y = ov.readdirMs * scale;
  const parseMs2y = msPerMBHot * (hot7Bytes / MB);
  const startMs2y = statMs2y + readdirMs2y + parseMs2y;
  const memHotMB = bench.real.hot7RssDeltaMB * (hot7Bytes / Math.max(1, bench.real.hot7Bytes));

  return {
    label: rate.label,
    bytesPerDayMB: +(rate.bytesPerDay / MB).toFixed(3),
    linesPerDay: Math.round(rate.linesPerDay),
    filesPerDay: +rate.filesPerDay.toFixed(2),
    increment2Years: {
      files: Math.round(rate.filesPerDay * HORIZON_DAYS),
      MB: +(futureBytes / MB).toFixed(1),
      lines: Math.round(rate.linesPerDay * HORIZON_DAYS),
    },
    after2Years: {
      files: Math.round(files2y),
      totalMB: +(totalBytes / MB).toFixed(1),
      addedMB: +(futureBytes / MB).toFixed(1),
      hot7MB: +(hot7Bytes / MB).toFixed(2),
    },
    noOptimization: { fullParseMs: +fullParseMs.toFixed(0), fullParseSec: +(fullParseMs / 1000).toFixed(1) },
    withOptimization: {
      statMs: +statMs2y.toFixed(1),
      readdirMs: +readdirMs2y.toFixed(1),
      parseMs: +parseMs2y.toFixed(1),
      startMs: +startMs2y.toFixed(1),
      memHotMB: +memHotMB.toFixed(1),
    },
    // 第一阶段实测：全量 375MB 日志常驻约 216MB。按「加载过不卸载」的单向升级，
    // 用户一旦切到「全部」，内存仍会随历史总量增长 —— 这不是本期目标，但必须如实列出。
    memoryIfAllLoadedMB: Math.round(216 * (totalBytes / Math.max(1, scan.totalBytes))),
    speedup: +(fullParseMs / Math.max(1, startMs2y)).toFixed(1),
  };
}

/* ---------- main ---------- */
const bench = JSON.parse(fs.readFileSync(path.join(OUT, 'step-4.json'), 'utf8'));
const now = Date.now();
const scan = scanReal();
const ov = scanOverhead();
const r = rates(scan, now);
const projections = Object.values(r.models).map((m) => extrapolate(scan, ov, m, bench));

// G5 机械建议（历史记录）：压力模型上浮 25% 得机械上限；取「整秒」便于验收。
// 结衣 2026-11-12 20:22 已把门槛拍板为 3000ms，下面 recommendedMs=1000
// 只保留为当时的拟合建议，不再作为门槛；以 g5Decision 为准。
const stress = projections[projections.length - 1];
const mechanicalUpperBoundMs = Math.ceil((stress.withOptimization.startMs * 1.25) / 50) * 50;
const recommendedMs = 1000;
const baseA = projections[0];
const strictMs = Math.ceil((baseA.withOptimization.startMs * 1.6) / 50) * 50;
const headroomPct = +((recommendedMs / stress.withOptimization.startMs - 1) * 100).toFixed(1);
const APPROVED_MS = 3000;
const decision = {
  approvedMs: APPROVED_MS,
  approvedBy: '结衣',
  approvedAt: '2026-11-12 20:22 GMT+8',
  wording: `在按本机实测日均外推的 2 年规模下，冷启动总耗时（stat + readdir + 近 7 天解析）≤ ${APPROVED_MS}ms`,
  kind: '验收线 / 阶段 3 触发线；不是运行时开关、不是当前每次启动的 SLA、界面不显示、超阈值不触发任何自动行为',
  verification: '阶段 1 的 1.9 用同一套 2 年合成夹具 + 当前真实数据双跑实测；同时必报 V1 结构性指标（启动解析字节 ≤ 近 7 天 stat 字节 + 容差、连续 3 拍字节不增长 / revision 不变）',
  regressionGuard: '当前真实数据全量解析 1845.3ms < 3000ms，故在现有数据量上 G5 已无法区分「只加载近 7 天」与「退回全量读取」；防 R1 回归由 V1 / G2 / G3(overshoot=1.0000) 的结构性断言承担，不由 G5 承担',
  notCovered: [
    '切「近 30 天」/「全部」首次读历史的等待（由加载提示兜、只发生一次）',
    '运行期 5s 轮询与页面交互响应',
    '内存（A7 假设，2.8/6.6 GB 与 G5 无关）',
  ],
  headroom: `压力 C ${stress.withOptimization.startMs}ms → ${(APPROVED_MS / stress.withOptimization.startMs).toFixed(1)} 倍；基准 A ${baseA.withOptimization.startMs}ms → ${(APPROVED_MS / baseA.withOptimization.startMs).toFixed(1)} 倍`,
  rationale: '结衣认为 3 秒本身很短，放宽以免过早触发阶段 3 的深度优化',
  supersedes: { recommendedMs, mechanicalUpperBoundMs, strictMs },
};

const result = {
  generatedAt: new Date(now).toISOString(),
  source: '真实 WorkBuddy JSONL（仅聚合量，不含路径/项目名/标题/提示词）',
  horizonDays: HORIZON_DAYS,
  observed: {
    totalFiles: scan.totalFiles,
    projectDirs: scan.projectDirs,
    totalMB: +(scan.totalBytes / MB).toFixed(1),
    totalLines: scan.totalLines,
    noTimestampLines: scan.noTimestampLines,
    birthVsContentMismatch: scan.birthVsContentMismatch,
    earliestContentDay: dayKey(scan.minTs),
    latestContentDay: dayKey(scan.maxTs),
    observedSpanDays: +((scan.maxTs - scan.minTs) / DAY).toFixed(1),
  },
  measuredOverhead: {
    statMs: +ov.statMs.toFixed(2),
    readdirMs: +ov.readdirMs.toFixed(2),
    msPerFile: +ov.msPerFile.toFixed(4),
    note: '3 次中位数；stat 每文件一次、readdir 每项目目录一次，均随历史文件数增长',
  },
  throughput: {
    fullParseMsPerMB: +(bench.real.fullParseMs / (bench.real.totalBytes / MB)).toFixed(3),
    hot7ParseMsPerMB: +(bench.real.hot7ParseMs / (bench.real.hot7Bytes / MB)).toFixed(3),
    source: '.phase2/step-4.json（阶段 0 实测）',
  },
  last30Days: r.d30,
  weekly: r.weekly,
  activeDaysInLast30: r.activeDays,
  models: r.models,
  projections,
  g5Recommendation: {
    recommendedMs,
    mechanicalUpperBoundMs,
    basis: `压力 C 两年后启动 ${stress.withOptimization.startMs}ms，1000ms 留 ${headroomPct}% 余量；基准 A 日常情形仅 ${baseA.withOptimization.startMs}ms，有 ${(recommendedMs / baseA.withOptimization.startMs).toFixed(1)} 倍余量`,
    alternatives: [
      { label: '严格', ms: strictMs, basis: `基准 A 启动 ${baseA.withOptimization.startMs}ms × 1.6；压力情形下会触发阶段 3` },
      { label: '推荐', ms: recommendedMs, basis: '覆盖压力 C 并留余量，整秒便于验收' },
      { label: '宽松', ms: mechanicalUpperBoundMs, basis: '压力 C × 1.25 的机械值，向上取整到 50ms' },
    ],
    proposedWording: `在按本机实测日均外推的 2 年规模下，冷启动总耗时（stat + readdir + 近 7 天解析）≤ ${recommendedMs}ms`,
    trigger: '阶段 1 实测超过该阈值时，进入阶段 3 评估（解析快照 / 正式索引 / SQLite）',
    supersededBy: 'g5Decision',
    status: '历史建议值，已被结衣 2026-11-12 20:22 拍板的 ≤3000ms 覆盖，不再是门槛；保留仅作拟合记录',
  },
  g5Decision: decision,
  assumptions: [
    '按「近 30 个完整自然日」日均线性外推，未假设使用强度逐年增长；压力 C 用活跃日均值与 P90 单日取大',
    '不做优化时全量解析耗时按当前 ms/MB 线性外推，未计 deriveTimings/速度拟合（会随记录数再涨）',
    '本方案下 rebuild 派生统计只处理已加载的近 7 天数据，不随历史总量增长，故未计入 2 年增量',
    'stat/readdir 按文件数同比例放大；若项目目录数增长慢于文件数，readdir 项会略高估',
    '外推是估算不是实测；阶段 1 落地后须用同一套 .perf 合成夹具复核',
  ],
};
fs.writeFileSync(path.join(OUT, 'g5-estimate.json'), JSON.stringify(result, null, 2));

const fmt = (x) => (x / MB).toFixed(2);
console.log('\n========== 近一个月真实增量（按天聚合，只报聚合量） ==========');
console.log(`现有: ${scan.totalFiles} 文件 / ${fmt(scan.totalBytes)} MB / ${scan.totalLines} 行 / 项目目录 ${scan.projectDirs}`);
console.log(`内容时间跨度: ${dayKey(scan.minTs)} → ${dayKey(scan.maxTs)}（${result.observed.observedSpanDays} 天）；无时间戳行 ${scan.noTimestampLines}`);
console.log(`近 30 个完整自然日: 有写入 ${r.activeDays} 天 / 日均 ${fmt(r.models.A_30d_mean.bytesPerDay)} MB`);
console.log('周桶:', r.weekly.map((w) => `${w.window} ${fmt(w.bytes)}MB`).join(' | '));
console.log('\n========== 速率模型 ==========');
for (const m of Object.values(r.models)) {
  console.log(`${m.label}: ${fmt(m.bytesPerDay)} MB/日 · ${Math.round(m.linesPerDay)} 行/日 · ${m.filesPerDay.toFixed(2)} 文件/日`);
}
console.log('\n========== 2 年（730 天）外推 ==========');
console.table(projections.map((p) => ({
  模型: p.label.split('：')[0],
  'MB/日': p.bytesPerDayMB,
  '两年新增MB': p.increment2Years.MB,
  '2年后文件': p.after2Years.files,
  '2年后MB': p.after2Years.totalMB,
  '全量解析s(不优化)': p.noOptimization.fullParseSec,
  '启动ms(本方案)': p.withOptimization.startMs,
  '切全部后内存MB': p.memoryIfAllLoadedMB,
  '加速比': p.speedup,
})));
console.log(`\nG5 已批准门槛: ≤ ${APPROVED_MS}ms（结衣 2026-11-12 20:22 拍板；替代 20:11 的 ≤${recommendedMs}ms 建议值）`);
console.log(`历史建议: 严格 ${strictMs}ms / 推荐 ${recommendedMs}ms / 宽松 ${mechanicalUpperBoundMs}ms（仅作拟合记录，均不采用）`);
console.log(`余量: 压力 C ${stress.withOptimization.startMs}ms → ${(APPROVED_MS / stress.withOptimization.startMs).toFixed(1)} 倍；基准 A ${baseA.withOptimization.startMs}ms → ${(APPROVED_MS / baseA.withOptimization.startMs).toFixed(1)} 倍`);
console.log('注意: 当前真实数据全量解析 1845.3ms < 3000ms，防 R1 回归由 V1 结构性断言承担，不靠 G5');
console.log('报告: .phase2/g5-estimate.json');
