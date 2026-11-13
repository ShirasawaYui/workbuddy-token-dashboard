/**
 * 第 8 步：大数据性能基准（可重复，前后对照用）。
 *
 * 生成 20 项目 × 25 会话 × 200 请求 = 100,000 条用量记录的合成 JSONL，
 * 启动一个只绑回环的解析服务，实测：
 *   - 冷启动（首次全量解析 + 重建）
 *   - 无变化时的 /api/refresh
 *   - 少量追加（1 / 10 / 100 条）时的 /api/refresh —— 本步最关键的指标
 *   - meta / overview / sessions / session / requests 的响应耗时
 *   - 服务进程 Working Set
 *
 * 用法：
 *   npm run perf:bench -- --gen --tag=before   # 重新生成数据并测优化前基线
 *   npm run perf:bench -- --gen --tag=after    # 同一份规模重测优化后
 *   npm run perf:gen                           # 只生成数据
 *
 * 数据全在 .perf/（已加进 .gitignore），不读取真实会话。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(root, '.perf', 'workbuddy');
const PROJ = path.join(HOME, 'projects');
const PORT = Number(process.env.PERF_PORT || 5181);
const BASE = `http://127.0.0.1:${PORT}`;
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const TAG = getArg('tag', 'bench');
const DO_GEN = argv.includes('--gen') || argv.includes('--gen-only');
const GEN_ONLY = argv.includes('--gen-only');

const P = 20;
const S = 25;
const R = 200;
const MODELS = ['perf-model-a', 'perf-model-b', 'perf-model-c'];

function makeUsageLine(sid, ts, mid, i) {
  const prompt = 20000 + (i % 50) * 500;
  const hit = Math.round(prompt * 0.85);
  const comp = 100 + (i % 30) * 10;
  return JSON.stringify({
    sessionId: sid,
    type: 'message',
    role: 'assistant',
    timestamp: ts,
    providerData: {
      messageId: mid,
      conversationRequestId: `req-${mid}`,
      model: MODELS[i % MODELS.length],
      traceId: `trace-${sid}-${Math.floor(i / 3)}`,
      rawUsage: {
        prompt_tokens: prompt,
        completion_tokens: comp,
        total_tokens: prompt + comp,
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: prompt - hit,
        credit: Number((0.02 + (prompt - hit) * 8e-6 + comp * 2.2e-5).toFixed(2)),
      },
    },
  });
}

/** 重新生成整份合成数据；返回写入的请求行数 */
function generate() {
  const t0 = Date.now();
  // 只重置数据目录，保留已有的 bench-*.json —— 否则跑 after 会把 before 的结果删掉，
  // 前后对照就没法复现了。
  fs.rmSync(HOME, { recursive: true, force: true });
  const base = Date.now() - 30 * 86400_000;
  let written = 0;
  for (let p = 0; p < P; p++) {
    const dir = path.join(PROJ, `p-${String(p).padStart(3, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let s = 0; s < S; s++) {
      const sid = `s-${p}-${s}`;
      let ts = base + (((p * S + s) * 3_600_000) % (29 * 86400_000));
      const lines = [
        JSON.stringify({ type: 'session-meta', timestamp: ts, sessionId: sid }),
        JSON.stringify({
          type: 'ai-title',
          timestamp: ts,
          aiTitle: `合成会话 ${p}-${s}`,
          sessionId: sid,
          cwd: `D:\\code\\perf-p-${p}`,
        }),
      ];
      for (let i = 0; i < R; i++) {
        ts += 1500 + (i % 7) * 300;
        lines.push(makeUsageLine(sid, ts, `m-${p}-${s}-${i}`, i));
        written++;
      }
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
    }
  }
  const ms = Date.now() - t0;
  console.log(`[perf] 生成 ${P * S} 个会话 / ${written} 条请求，耗时 ${ms}ms`);
  return written;
}

const TARGET_FILE = path.join(PROJ, 'p-000', 's-0-0.jsonl');
/** 往一个会话尾部追加 n 条，时间戳接着文件最后一行，保证是最新活动 */
function appendRows(n, salt) {
  const text = fs.readFileSync(TARGET_FILE, 'utf8').trim();
  let ts = JSON.parse(text.split('\n').pop()).timestamp + 1000;
  const lines = [];
  for (let i = 0; i < n; i++) {
    ts += 1000;
    lines.push(makeUsageLine('s-0-0', ts, `perf-extra-${salt}-${i}`, 1000 + i));
  }
  fs.appendFileSync(TARGET_FILE, lines.join('\n') + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;
const serverLogs = [];
function startServer() {
  server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOME: HOME,
      PORT: String(PORT),
      SCAN_INTERVAL_MS: '100000', // 基准里不让定时扫描干扰，全部手动触发
      FORCE_FULL_LOAD: '1', // 基准口径固定在第一阶段全量路径，数字才可与历史产物对照
    },
  });
  server.stdout.on('data', (d) => serverLogs.push(d.toString()));
  server.stderr.on('data', (d) => serverLogs.push(d.toString()));
}
async function waitReady(timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/meta`);
      if (r.ok) return Date.now() - t0;
    } catch {
      /* 还在解析 */
    }
    if (server && server.exitCode != null) break;
    await sleep(500);
  }
  throw new Error('服务未就绪：\n' + serverLogs.join('').slice(-2000));
}
async function hit(url, init) {
  const t = performance.now();
  const r = await fetch(BASE + url, init);
  const body = await r.text();
  // 500 的小错误页反而会比正常聚合「更快」；不检查状态会把故障误记成性能提升。
  if (!r.ok) throw new Error(`${init?.method || 'GET'} ${url} HTTP ${r.status}: ${body.slice(0, 300)}`);
  return { ms: performance.now() - t, bytes: Buffer.byteLength(body), body };
}
function stats(samples) {
  const xs = samples.slice().sort((a, b) => a - b);
  return {
    n: xs.length,
    min: +xs[0].toFixed(1),
    median: +xs[Math.floor(xs.length / 2)].toFixed(1),
    max: +xs[xs.length - 1].toFixed(1),
    avg: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1),
  };
}
async function measure(label, url, init, n = 5) {
  const xs = [];
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const r = await hit(url, init);
    xs.push(r.ms);
    bytes = r.bytes;
  }
  const out = { label, ...stats(xs), bytes };
  console.log(
    `  ${label.padEnd(34)} avg ${String(out.avg).padStart(8)}ms  ` +
      `min ${String(out.min).padStart(8)}  max ${String(out.max).padStart(8)}  ${bytes}B`,
  );
  return out;
}
function rssMB() {
  if (!server || !server.pid) return null;
  try {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${server.pid}).WorkingSet64`],
      { encoding: 'utf8', timeout: 10000 },
    );
    const v = Number(String(r.stdout).trim());
    return Number.isFinite(v) && v > 0 ? +(v / 1048576).toFixed(1) : null;
  } catch {
    return null;
  }
}

async function main() {
  if (DO_GEN) generate();
  if (GEN_ONLY) return;
  if (!fs.existsSync(TARGET_FILE)) {
    console.error('没有基准数据，请先执行 npm run perf:gen 或加 --gen');
    process.exit(1);
  }

  startServer();
  const bootMs = await waitReady();
  const boot = JSON.parse((await hit('/api/meta')).body);
  console.log(`[perf] 冷启动 ${bootMs}ms；recordCount=${boot.recordCount}，sessionCount=${boot.sessionCount}`);
  if (path.resolve(boot.home || '') !== path.resolve(HOME)) {
    throw new Error('拒绝继续：服务读到了非 .perf 数据源');
  }

  const result = {
    tag: TAG,
    at: new Date().toISOString(),
    scale: { projects: P, sessions: P * S, requests: boot.recordCount },
    bootMs,
    rssMB: rssMB(),
    revision: boot.revision ?? null,
    api: [],
    append: [],
  };

  console.log('\n【无变化 / 常规 API】');
  result.api.push(await measure('GET /api/meta', '/api/meta'));
  result.api.push(await measure('GET /api/overview', '/api/overview'));
  result.api.push(await measure('GET /api/sessions', '/api/sessions'));
  result.api.push(await measure('GET /api/session (单会话)', '/api/session?sessionId=s-0-0'));
  result.api.push(await measure('GET /api/requests', '/api/requests?page=1&size=50'));
  result.api.push(await measure('POST /api/refresh 无变化', '/api/refresh', { method: 'POST' }, 3));

  console.log('\n【稳定态一拍：前端按 revision 跳过重绘】');
  const steady = [];
  for (let i = 0; i < 5; i++) {
    const r = await hit('/api/meta');
    steady.push(r.ms);
    // 前端逻辑：revision 未变就整拍收工，不再请求当前页签 / 抽屉 / 摘要条
  }
  const apiAvg = (label) => result.api.find((x) => x.label === label).avg;
  result.steady = {
    revisionSkip: { requests: 1, ...stats(steady) },
    legacyFullPoll: {
      requests: 3,
      estimatedMs: +(
        apiAvg('GET /api/meta') +
        apiAvg('GET /api/overview') +
        apiAvg('GET /api/session (单会话)')
      ).toFixed(1),
      note: '优化前每拍无条件发 meta + 当前页签 + 会话详情，按本轮各 API 实测耗时相加估算',
    },
  };
  console.log(`  revision 跳过：1 个请求，avg ${result.steady.revisionSkip.avg}ms`);
  console.log(`  旧行为估算：3 个请求，约 ${result.steady.legacyFullPoll.estimatedMs}ms`);

  console.log('\n【少量追加后的强制重扫（核心指标）】');
  let expectedCount = boot.recordCount;
  for (const n of [1, 10, 100]) {
    const xs = [];
    for (let k = 0; k < 3; k++) {
      appendRows(n, `${TAG}-${n}-${k}`);
      expectedCount += n;
      const r = await hit('/api/refresh', { method: 'POST' });
      const body = JSON.parse(r.body);
      // 计时之外还要证明追加真的被解析；否则「变快」可能只是没有扫到新行。
      if (!body.ok || body.recordCount !== expectedCount) {
        throw new Error(`追加 ${n} 条后数量不符：期望 ${expectedCount}，响应 ${r.body.slice(0, 300)}`);
      }
      xs.push(r.ms);
    }
    const row = { added: n, ...stats(xs) };
    result.append.push(row);
    console.log(
      `  追加 ${String(n).padStart(3)} 条 → refresh avg ${String(row.avg).padStart(8)}ms  ` +
        `min ${String(row.min).padStart(8)}  max ${String(row.max).padStart(8)}`,
    );
  }
  result.rssAfterMB = rssMB();

  const outFile = path.join(root, '.perf', `bench-${TAG}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`\n[perf] 结果已写入 ${outFile}`);
}

try {
  await main();
} catch (e) {
  console.error('[perf] 失败：', e.message);
  console.error(serverLogs.join('').slice(-2000));
  process.exitCode = 1;
} finally {
  if (server) server.kill();
}
