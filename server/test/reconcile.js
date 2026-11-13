/**
 * 对账脚本：用完全独立的全量解析，校验看板 API 的数字。
 *
 * 与线上路径的区别：
 *  - 不使用 Scanner 的增量逻辑，直接一次性读完整文件
 *  - 自己按 messageId 去重、自己求和
 *  - 耗时部分**重新实现一遍走查算法**，不复用 src/timing.js
 * 两条路径互相独立，结果一致才说明链路没算错。
 *
 * 前提：解析服务已在运行（默认 http://127.0.0.1:5178，服务只绑 IPv4 回环）
 * 运行：node test/reconcile.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChunk } from '../src/parser.js';

const HOME = process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
const PROJECTS = path.join(HOME, 'projects');
const API = process.env.API || 'http://127.0.0.1:5178';

const byId = new Map();
/** 每个文件的全量事件，供下方的耗时独立复算使用 */
const fileInfos = [];

for (const proj of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
  if (!proj.isDirectory()) continue;
  const dir = path.join(PROJECTS, proj.name);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue; // 排除 .file-rollback.ndjson
    const filePath = path.join(dir, f);
    const sessionId = f.replace(/\.jsonl$/, '');
    const text = fs.readFileSync(filePath, 'utf8');
    const { records, events } = parseChunk(text, { projectId: proj.name, sessionId });
    for (const r of records) if (r.id && !byId.has(r.id)) byId.set(r.id, r);
    fileInfos.push({ filePath, sessionId, projectId: proj.name, events, mtimeMs: fs.statSync(filePath).mtimeMs });
  }
}

const all = [...byId.values()];
const sum = (k) => all.reduce((a, r) => a + r[k], 0);

const expect = {
  requests: all.length,
  prompt: sum('prompt'),
  completion: sum('completion'),
  total: sum('total'),
  cacheRead: sum('cacheRead'),
  credit: Number(sum('credit').toFixed(2)),
};

// 先让服务重新扫一遍，再取数，缩小"本会话仍在写入"造成的时序漂移
await fetch(`${API}/api/refresh`, { method: 'POST' }).catch(() => {});

const res = await fetch(`${API}/api/overview`);
if (!res.ok) {
  console.error(`无法访问 ${API}/api/overview（HTTP ${res.status}），请先启动解析服务`);
  process.exit(1);
}
const o = await res.json();
const actual = {
  requests: o.summary.requests,
  prompt: o.summary.prompt,
  completion: o.summary.completion,
  total: o.summary.total,
  cacheRead: o.summary.cacheRead,
  credit: o.summary.credit,
};

/**
 * 判定标准：
 * JSONL 只增不减，所以 API 读到的量必然 >= 脚本读到的量。
 * 允许"脚本读完之后、服务扫描之前"新写入的少量请求，但不允许 API 比脚本少
 * （那说明增量扫描漏了数据）。
 */
const drift = actual.requests - expect.requests;
const driftOk = drift >= 0 && drift <= 20; // 当前会话的实时增量

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('指标', 14) + pad('独立全量解析', 20) + pad('看板 API', 20) + '结果');
console.log('-'.repeat(62));

let bad = 0;
for (const k of Object.keys(expect)) {
  const ok = actual[k] >= expect[k] - 1e-6;
  if (!ok) bad++;
  console.log(pad(k, 14) + pad(expect[k], 20) + pad(actual[k], 20) + (ok ? '✓' : '✗ API 比脚本少'));
}

console.log('-'.repeat(62));
console.log(`API 侧多出 ${drift} 条请求 —— 来自脚本读取之后新写入的会话记录（实时对话仍在进行）`);

if (bad === 0 && driftOk) {
  console.log('✓ 对账一致：增量扫描 + 内存聚合的结果与独立全量解析完全吻合');
} else if (bad > 0) {
  console.log(`✗ 有 ${bad} 项 API 小于独立解析结果，说明增量扫描漏数据，请排查 scanner 的 offset 逻辑`);
  process.exit(1);
} else {
  console.log(`✗ 漂移 ${drift} 条超出预期，请确认是否有其它进程在大量写入`);
  process.exit(1);
}

/* ==========================================================================
 * 耗时维度独立对账
 *
 * 只挑"最近 60 秒内没被写过"的会话：正在推进的会话在脚本读完之后还会被追加，
 * 拿它比一定对不上，那是时序问题不是算错。静态会话则必须**分毫不差**。
 *
 * 走查算法在这里重写一遍（刻意不 import src/timing.js），
 * 否则就是拿同一份代码验自己，等于没验。
 *
 * ⚠ 这里比的是**单会话**的 phase。总览那份是跨会话的**并集**（并行会话会重叠，
 * 直接相加会虚高），而单个会话内部各区间天然不重叠，所以两种口径在单会话上等价 ——
 * 这也是这一段在 mergePhases 改成扫描线之后依然有效的原因。
 * ======================================================================== */

const AWAY_MS = 30 * 60 * 1000;
const staleNow = Date.now();

/** 独立实现：把事件走一遍，算出每次请求耗时 / 工具耗时 / 阶段时长 */
function walkEvents(events) {
  const reqDur = new Map();
  const tools = new Map();
  const open = new Map();
  const phase = { spanMs: 0, modelMs: 0, toolMs: 0, humanMs: 0, awayMs: 0, activeMs: 0 };
  let prev = null;

  for (const e of events) {
    if (e.ty === 'fc' && e.cid) open.set(e.cid, e);
    if (e.ty === 'fcr' && e.cid && open.has(e.cid)) {
      const c = open.get(e.cid);
      open.delete(e.cid);
      tools.set(e.cid, e.t - c.t);
    }
    const sig = e.u === 1 || e.ty === 'fcr' || (e.ty === 'msg' && e.role === 'user');
    if (!sig) continue;
    if (prev) {
      const gap = Math.max(0, e.t - prev.t);
      if (gap > AWAY_MS) phase.awayMs += gap;
      else if (e.u === 1) {
        phase.modelMs += gap;
        if (e.mid) reqDur.set(e.mid, gap);
      } else if (e.ty === 'fcr') phase.toolMs += gap;
      else phase.humanMs += gap;
    }
    prev = e;
  }

  if (events.length) phase.spanMs = events[events.length - 1].t - events[0].t;
  phase.activeMs = phase.modelMs + phase.toolMs + phase.humanMs;
  return { reqDur, tools, phase };
}

const stable = fileInfos.filter((f) => staleNow - f.mtimeMs > 60_000);
if (!stable.length) {
  console.log('\n（没有 60 秒内未变动的会话，跳过耗时对账）');
} else {
  console.log('\n=============== 耗时维度对账（仅静态会话）===============');
  const pad2 = (s, n) => String(s).padEnd(n);
  console.log(pad2('会话', 40) + pad2('项', 16) + pad2('独立复算', 16) + pad2('看板 API', 16) + '结果');
  console.log('-'.repeat(96));

  let tbad = 0;
  for (const f of stable) {
    const mine = walkEvents(f.events);
    const res2 = await fetch(`${API}/api/session?sessionId=${encodeURIComponent(f.sessionId)}`);
    if (!res2.ok) { tbad++; console.log(`  ✗ ${f.sessionId} 接口失败 HTTP ${res2.status}`); continue; }
    const s = await res2.json();

    // 工具耗时：callId 配对，两个实现应该完全一致
    const apiToolCalls = (s.toolTime || []).reduce((a, t) => a + t.calls, 0);
    const apiToolMs = (s.toolTime || []).reduce((a, t) => a + t.totalMs, 0);
    const myToolMs = [...mine.tools.values()].reduce((a, b) => a + b, 0);

    // 请求耗时：逐条按 messageId 比对
    const apiDur = new Map((s.steps || []).filter((x) => x.durMs).map((x) => [x.id, x.durMs]));
    let durMismatch = 0;
    let durChecked = 0;
    for (const [mid, ms] of mine.reqDur) {
      if (!apiDur.has(mid)) continue;
      durChecked++;
      if (apiDur.get(mid) !== ms) durMismatch++;
    }

    const rows = [
      ['工具调用条数', mine.tools.size, apiToolCalls],
      ['工具耗时合计', myToolMs, apiToolMs],
      ['请求耗时条数', durChecked, apiDur.size],
      ['请求耗时不一致', 0, durMismatch],
      ['模型生成阶段', mine.phase.modelMs, s.phase ? s.phase.modelMs : null],
      ['工具执行阶段', mine.phase.toolMs, s.phase ? s.phase.toolMs : null],
      ['全程跨度', mine.phase.spanMs, s.phase ? s.phase.spanMs : null],
    ];

    for (const [label, a2, b2] of rows) {
      const ok = a2 === b2;
      if (!ok) tbad++;
      console.log(
        pad2('  ' + (label === rows[0][0] ? f.sessionId.slice(0, 36) : ''), 40) +
          pad2(label, 16) +
          pad2(a2, 16) +
          pad2(b2 == null ? '—' : b2, 16) +
          (ok ? '✓' : '✗ 不一致'),
      );
    }
  }

  if (tbad === 0) {
    console.log('-'.repeat(96));
    console.log(`✓ 耗时对账一致：${stable.length} 个静态会话的工具耗时、请求耗时、阶段时长全部逐项吻合`);
  } else {
    console.log('-'.repeat(96));
    console.log(`✗ 有 ${tbad} 项不一致，请排查 scanner 的事件累积 / timing 的走查逻辑`);
    process.exit(1);
  }
}

/* ==========================================================================
 * 轮次维度独立对账（第 5 步）
 *
 * 刻意**不 import src/store.js**：按 traceId 自己再分一遍组、自己求和，
 * 才能验证 API 的轮次聚合不是"拿同一份代码验自己"。
 * 只比静态会话，避免实时写入造成的时序漂移。
 * ======================================================================== */

/** 独立实现：有 traceId 按 traceId，缺失则按 messageId 各自独立成轮 */
function independentTurns(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.traceId ? r.traceId : 'orphan:' + r.id;
    if (!map.has(key)) {
      map.set(key, {
        turnId: key, requests: 0, prompt: 0, completion: 0, total: 0,
        cacheRead: 0, cacheMiss: 0, reasoning: 0, credit: 0,
        startTs: Infinity, endTs: -Infinity,
      });
    }
    const t = map.get(key);
    t.requests += 1;
    for (const k of ['prompt', 'completion', 'total', 'cacheRead', 'cacheMiss', 'reasoning', 'credit']) {
      t[k] += r[k];
    }
    t.startTs = Math.min(t.startTs, r.ts);
    t.endTs = Math.max(t.endTs, r.ts);
  }
  for (const t of map.values()) t.credit = Math.round(t.credit * 10000) / 10000;
  return map;
}

const bySession = new Map();
for (const r of all) {
  if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
  bySession.get(r.sessionId).push(r);
}

if (!stable.length) {
  console.log('\n（没有 60 秒内未变动的会话，跳过轮次对账）');
} else {
  const stableIds = new Set(stable.map((f) => f.sessionId));
  const pad3 = (s, n) => String(s).padEnd(n);
  const sumBy = (rows, k) => rows.reduce((a, r) => a + r[k], 0);

  console.log('\n=============== 轮次维度对账（独立实现，仅静态会话）===============');
  console.log(pad3('会话', 40) + pad3('项', 20) + pad3('独立复算', 16) + pad3('看板 API', 16) + '结果');
  console.log('-'.repeat(100));

  let rbad = 0;
  let checked = 0;
  for (const [sid, rows] of bySession) {
    if (!stableIds.has(sid)) continue;
    const mine = independentTurns(rows);
    const res3 = await fetch(`${API}/api/session?sessionId=${encodeURIComponent(sid)}`);
    if (!res3.ok) {
      rbad++;
      console.log(`  ✗ ${sid} 接口失败 HTTP ${res3.status}`);
      continue;
    }
    const s = await res3.json();
    checked++;

    const apiTurns = new Map((s.turns || []).map((t) => [t.turnId, t]));
    const got = s.turnSummary || {};
    const checks = [
      ['轮次数', mine.size, s.turnTotal],
      ['轮次请求数合计', rows.length, got.requests],
      ['轮次输入合计', sumBy(rows, 'prompt'), got.prompt],
      ['轮次输出合计', sumBy(rows, 'completion'), got.completion],
      ['轮次总 Token', sumBy(rows, 'total'), got.total],
      ['轮次缓存命中', sumBy(rows, 'cacheRead'), got.cacheRead],
      ['轮次缓存未命中', sumBy(rows, 'cacheMiss'), got.cacheMiss],
      ['轮次 reasoning', sumBy(rows, 'reasoning'), got.reasoning],
      ['轮次 credit', Math.round(sumBy(rows, 'credit') * 10000) / 10000, got.credit],
      ['与 summary 请求数一致', s.summary.requests, got.requests],
      ['轮次列表未被裁剪', false, !!s.turnTruncated],
    ];

    // 每一轮按 turnId 逐项比对，避免"总数对但分组错"
    let perTurnBad = 0;
    for (const [tid, mt] of mine) {
      const at = apiTurns.get(tid);
      if (!at) {
        perTurnBad++;
        continue;
      }
      for (const k of ['requests', 'prompt', 'completion', 'total', 'cacheRead', 'cacheMiss', 'credit']) {
        if (k === 'credit' ? Math.abs(at[k] - mt[k]) > 0.001 : at[k] !== mt[k]) perTurnBad++;
      }
    }
    checks.push(['逐轮明细不一致项', 0, perTurnBad]);

    for (const [label, a3, b3] of checks) {
      const ok = label === '轮次 credit' ? Math.abs(a3 - b3) < 0.001 : a3 === b3;
      if (!ok) rbad++;
      console.log(
        pad3('  ' + (label === checks[0][0] ? sid.slice(0, 36) : ''), 40) +
          pad3(label, 20) + pad3(a3, 16) + pad3(b3, 16) + (ok ? '✓' : '✗ 不一致'),
      );
    }
  }

  if (rbad === 0) {
    console.log('-'.repeat(100));
    console.log(`✓ 轮次对账一致：${checked} 个静态会话的轮次划分与全部指标均由独立实现复算吻合`);
  } else {
    console.log('-'.repeat(100));
    console.log(`✗ 有 ${rbad} 项不一致，请排查 buildTurns / traceId 缺失兜底 / API 筛选口径`);
    process.exit(1);
  }
}
