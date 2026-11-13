#!/usr/bin/env node
/**
 * 阶段 1 · 重建 / 校验极简文件索引（CLI，非 HTTP）。
 *
 * 用法：
 *   node tools/index-rebuild.mjs            重建索引并输出校验结果
 *   node tools/index-rebuild.mjs --verify   只校验，不写盘
 *
 * 纪律：
 *  - 全量读一遍真实 JSONL 只为生成汇总量；**不写会话标题 / cwd / 提示词**。
 *  - 入口定为 CLI 而非 HTTP，避免扩大 Host / CORS 的写面。
 *  - 不启服务、不占端口、不改业务数据；索引损坏时服务启动会自动回退全量。
 *  - 想让下一次启动走第一阶段的全量路径：FORCE_FULL_LOAD=1 npm start
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scanner } from '../server/src/scanner.js';
import { FileIndex } from '../server/src/file-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'server', '.cache');
const verifyOnly = process.argv.includes('--verify');

const idx = new FileIndex({ cacheDir: CACHE_DIR });
const state = idx.load();
console.log('========== 文件索引重建 / 校验 ==========');
console.log(
  state.ok
    ? `现有索引：${state.created ? '首次运行，尚无索引' : `${state.files} 条`}`
    : `现有索引：不可用（${state.reason}），本次将重建`,
);

// 全量路径：逐个读完整文件，拿真实首尾时间戳、模型集合与 stat 指纹。
// 不传 fileCacheDir，避免覆盖服务正在用的 scan-state.json 快照。
const scanner = new Scanner({ fileCacheDir: null, forceFullLoad: true });
const t0 = Date.now();
await scanner.scan();

const anomalies = { unparsed: 0, noTimestamp: 0, empty: 0 };
let indexed = 0;
for (const f of scanner.files.values()) {
  if (!f.loaded) {
    anomalies.unparsed += 1;
    continue;
  }
  if (!f.records.length && !f.events.length) anomalies.empty += 1;
  const sum = scanner.summarizeForIndex(f);
  if (sum) {
    indexed += 1;
    if (f.records.length && (sum.firstTs == null || sum.lastTs == null)) anomalies.noTimestamp += 1;
  }
}
const totalAnomalies = anomalies.unparsed + anomalies.noTimestamp;

const st = scanner.stats();
console.log(`扫描文件：${st.total} 个 / ${(scanner.parsedBytes / 1048576).toFixed(1)} MB / ${Date.now() - t0}ms`);
console.log(`可入索引：${indexed} 个（其余为空会话或异常）`);
console.log(`异常统计：解析失败 ${anomalies.unparsed} / 时间戳缺失 ${anomalies.noTimestamp} / 空会话 ${anomalies.empty}（空会话不算异常）`);

if (!verifyOnly) {
  idx.update(scanner);
  await idx.persist();
  console.log(`索引已写入：server/.cache/file-index.json（${idx.entries.size} 条）`);
} else {
  console.log('--verify：未写盘');
}
console.log(
  totalAnomalies === 0
    ? '校验通过 / 发现 0 个异常文件'
    : `校验通过 / 发现 ${totalAnomalies} 个异常文件`,
);
console.log('回退全量路径：FORCE_FULL_LOAD=1 npm start');
process.exitCode = totalAnomalies === 0 ? 0 : 1;
