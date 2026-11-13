/** 第 9 步：把性能前后对照从人工抄表变成可重复执行的脚本。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] || 'final';
const finalFile = path.join(root, '.perf', `bench-${tag}.json`);
if (!fs.existsSync(finalFile)) {
  console.error(`找不到 ${finalFile}，请先运行：npm run perf:bench -- --tag=${tag}`);
  process.exit(1);
}
const final = JSON.parse(fs.readFileSync(finalFile, 'utf8'));

/**
 * 优化前原始 bench-before.json 已被初版 --gen 误删；这些数值来自第一次
 * `perf:bench --gen --tag=before` 的终端实测输出，并被写入执行计划书第 8 步。
 * 它不是脚本可复现的原始 JSON，这里明确标注来源，绝不伪装成新测结果。
 */
const TERMINAL_BASELINE = {
  provenance: '2026-11-12 首次 perf:bench --gen --tag=before 终端输出；原 JSON 已丢失',
  reproducible: false,
  bootMs: 1062,
  steadyMs: 126.9,
  sessionMs: 7.1,
  sessionsMs: 15.3,
  requestsMs: 8.5,
  append: { 1: 106.4, 10: 92.7, 100: 86.8 },
};
const apiAvg = (label) => {
  const row = final.api.find((x) => x.label === label);
  if (!row) throw new Error(`最终基准缺少 ${label}`);
  return row.avg;
};
const appendAvg = (n) => {
  const row = final.append.find((x) => x.added === n);
  if (!row) throw new Error(`最终基准缺少追加 ${n} 条`);
  return row.avg;
};
const rows = [
  ['冷启动', TERMINAL_BASELINE.bootMs, final.bootMs],
  ['稳定态一拍', TERMINAL_BASELINE.steadyMs, final.steady.revisionSkip.avg],
  ['单会话详情 API', TERMINAL_BASELINE.sessionMs, apiAvg('GET /api/session (单会话)')],
  ['/api/sessions', TERMINAL_BASELINE.sessionsMs, apiAvg('GET /api/sessions')],
  ['/api/requests', TERMINAL_BASELINE.requestsMs, apiAvg('GET /api/requests')],
  ['追加 1 条 → refresh', TERMINAL_BASELINE.append[1], appendAvg(1)],
  ['追加 10 条 → refresh', TERMINAL_BASELINE.append[10], appendAvg(10)],
  ['追加 100 条 → refresh', TERMINAL_BASELINE.append[100], appendAvg(100)],
];

console.log(`最终基准：${finalFile}`);
console.log(`规模：${final.scale.requests} 请求 / ${final.scale.sessions} 会话`);
console.log(`优化前基线：${TERMINAL_BASELINE.provenance}`);
console.log('（基线数值来自终端，非可复现 JSON；稳定态为三项 API 相加估算）\n');
console.log('指标'.padEnd(26) + '优化前'.padStart(10) + '最终'.padStart(10) + '变化'.padStart(12));
console.log('-'.repeat(58));
for (const [label, before, after] of rows) {
  const delta = ((after - before) / before) * 100;
  console.log(
    label.padEnd(26) +
      `${before.toFixed(1)}ms`.padStart(10) +
      `${after.toFixed(1)}ms`.padStart(10) +
      `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`.padStart(12),
  );
}

const report = {
  at: new Date().toISOString(),
  finalFile,
  baseline: TERMINAL_BASELINE,
  final: {
    bootMs: final.bootMs,
    steadyMs: final.steady.revisionSkip.avg,
    api: Object.fromEntries(final.api.map((x) => [x.label, x.avg])),
    append: Object.fromEntries(final.append.map((x) => [x.added, x.avg])),
  },
  rows: rows.map(([label, before, after]) => ({
    label,
    before,
    after,
    changePct: +(((after - before) / before) * 100).toFixed(1),
  })),
};
const out = path.join(root, '.perf', `compare-${tag}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n对照结果已写入 ${out}`);
