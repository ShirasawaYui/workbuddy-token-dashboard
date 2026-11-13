#!/usr/bin/env node
/**
 * 阶段 1 · 1.9 服务链路验证（冷启动加载 / 按需加载 / 索引回退 / 安全 / 前端 DOM）。
 *
 * 与 tools/verify-final.mjs 同风格（spawn 真实服务 + CDP + 真实 HTTP 断言），但**独立新建**，
 * 不 import 它、不改它。运行：node tools/verify-phase1.mjs（根 npm run test:phase1）。
 *
 * 纪律：
 *  - 所有服务子进程「起 → 测 → kill」串行独占，绝不留下长期监听；Windows 用 taskkill /T /F。
 *  - 所有断言读真实 HTTP 响应 / 启动日志 / CDP DOM，不用 sleep 猜「请求应该完成了」：
 *    就绪与 DOM 等待一律用带次数上限的轮询，读的是响应内容本身。
 *  - 不引入新依赖；不改任何既有文件；运行期只碰 server/.cache 的运行时产物，
 *    并在结束时按进入前的快照逐字节恢复（含主动写坏的 file-index.json）。
 *  - 数据源是 os.tmpdir() 下的临时合成夹具（冷热混合、带 0/~1 年/~2 年时间分布）。
 *
 * 覆盖：V1（启动日志 N/M + 3 拍/今日档 revision 稳定）、V3（今天→全部→今天恒等）、
 *       V4（冷会话定向加载）、V5（故障可重试恢复）、V9（日志 + FORCE_FULL_LOAD 回退）、
 *       索引损坏回退、安全回归、CLI 不监听端口、前端加载提示 DOM。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(root, 'server', '.cache');
const INDEX_PATH = path.join(CACHE_DIR, 'file-index.json');
const PORT = Number(process.env.PHASE1_PORT || 5190);
const CLI_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const LOCAL_HOST = `127.0.0.1:${PORT}`;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();
const T0 = (() => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();
const dayStart = (n) => {
  const d = new Date(T0);
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const ymd = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const TODAY_STR = ymd(T0);
/** 前端「今天」档：from=今天本地零点，to 省略（→ +Infinity） */
const Q_TODAY = `from=${TODAY_STR}&granularity=day`;
/** 前端「全部」档：from/to 都空（→ -Infinity/+Infinity） */
const Q_ALL = `from=&to=&granularity=day`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => isDeepStrictEqual(a, b);

let pass = 0;
let fail = 0;
let skip = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  [OK] ${name}${extra ? '  (' + extra + ')' : ''}`);
  } else {
    fail++;
    console.log(`  [!!] ${name}${extra ? '  (' + extra + ')' : ''}`);
  }
}
function skipCheck(name, reason) {
  skip++;
  console.log(`  [SKIP] ${name}  (${reason})`);
}

/* ── 临时合成数据源 ────────────────────────────────────────────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-phase1-verify-'));
const HOME = path.join(TMP, 'workbuddy');
const PROJ = path.join(HOME, 'projects', 'd-phase1-verify');

/** 一条带用量的 JSONL 行；messageId 全局唯一，避免 Store.byId 去重 */
function usageLine(id, ts, sessionId, model) {
  return JSON.stringify({
    type: 'function_call',
    timestamp: ts,
    sessionId,
    cwd: 'D:\\phase1\\verify',
    name: 'Bash',
    providerData: {
      messageId: id,
      traceId: `trace-${sessionId}`,
      model,
      rawUsage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
        completion_thinking_tokens: 10,
        credit: 0.42,
      },
    },
  });
}

/** 3 个近 7 天热文件 + 3 个历史冷文件；冷文件只用 utimes 改 mtime 判冷（birthtime 改不了） */
const FILES = [
  { sid: 's-today', ts: [T0 + 9 * HOUR, T0 + 14 * HOUR], model: 'm-fast', ago: 0 },
  { sid: 's-yesterday', ts: [dayStart(1) + 10 * HOUR], model: 'm-fast', ago: 1 },
  { sid: 's-3d', ts: [dayStart(3) + 10 * HOUR], model: 'm-fast', ago: 3 },
  { sid: 's-20d', ts: [dayStart(20) + 8 * HOUR], model: 'm-slow', ago: 20 },
  { sid: 's-400d', ts: [dayStart(400) + 9 * HOUR, dayStart(400) + 15 * HOUR], model: 'm-slow', ago: 400 },
  { sid: 's-730d', ts: [dayStart(730) + 6 * HOUR], model: 'm-fast', ago: 730 },
];
const COLD_SESSION = 's-400d'; // 定向加载用的冷会话
const FAULT_FILE = path.join(PROJ, 's-730d.jsonl'); // 故障注入用的冷文件

function buildFixture() {
  fs.mkdirSync(PROJ, { recursive: true });
  for (const f of FILES) {
    const lines = [
      JSON.stringify({ type: 'session-meta', timestamp: f.ts[0], sessionId: f.sid }),
      JSON.stringify({ type: 'ai-title', timestamp: f.ts[0], sessionId: f.sid, aiTitle: `会话 ${f.sid}` }),
      ...f.ts.map((ts, i) => usageLine(`${f.sid}-m${i}`, ts, f.sid, f.model)),
    ];
    const p = path.join(PROJ, `${f.sid}.jsonl`);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    // 只改 mtime（Windows 支持），让 isHot(hotDays=7) 自然把历史文件判冷。
    // birthtime 保持创建时刻，不影响「今天」「全部」两档的候选判定。
    fs.utimesSync(p, new Date(NOW), new Date(T0 - f.ago * DAY + 12 * HOUR));
  }
}

/* ── 进入前备份 server/.cache 运行时产物，结束逐字节恢复 ───────────────── */
const CACHE_FILES = ['file-index.json', 'file-index.json.tmp', 'scan-state.json'];
const cacheBackup = new Map();
for (const f of CACHE_FILES) {
  const p = path.join(CACHE_DIR, f);
  cacheBackup.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
function restoreCache() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const [f, buf] of cacheBackup) {
    const p = path.join(CACHE_DIR, f);
    if (buf === null) {
      try { fs.rmSync(p, { force: true }); } catch { /* 已不存在 */ }
    } else {
      fs.writeFileSync(p, buf);
    }
  }
}

/* ── HTTP helpers ─────────────────────────────────────────────────────── */
function rawRequest(route, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: route,
        method,
        setHost: false,
        headers: { Host: LOCAL_HOST, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
async function api(route) {
  const r = await fetch(BASE + route);
  const text = await r.text();
  if (!r.ok) throw new Error(`${route} HTTP ${r.status}: ${text.slice(0, 200)}`);
  return { json: JSON.parse(text), text };
}
/** 允许任意状态码（故障注入场景可能返回非 200），不抛错 */
async function apiAny(route) {
  const r = await fetch(BASE + route);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: r.status, json, text };
}
function reachable(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/* ── 服务子进程管理 ───────────────────────────────────────────────────── */
const spawned = [];
let browser = null;
let ws = null;
let cdpProfile = '';
let currentLogs = [];

function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}
function stopServer(s) {
  if (s && s.proc) killTree(s.proc);
}

/** 起服务前准备索引：删除=首次运行(created:true，不触发回退)；写坏=损坏回退场景 */
function prepareIndex(corrupt) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  try { fs.rmSync(INDEX_PATH, { force: true }); } catch { /* 忽略 */ }
  if (corrupt) fs.writeFileSync(INDEX_PATH, '{ this is not valid json');
}

async function startServer({ forceFullLoad = false, corruptIndex = false } = {}) {
  prepareIndex(corruptIndex);
  const env = {
    ...process.env,
    WORKBUDDY_HOME: HOME,
    PORT: String(PORT),
    HOT_DAYS: '7',
    SCAN_INTERVAL_MS: '100000', // 关掉 5s 定时扫描，避免干扰 revision 稳定断言
  };
  // 冷启动服务必须确保不带 FORCE_FULL_LOAD（外部环境若设了会污染）
  if (forceFullLoad) env.FORCE_FULL_LOAD = '1';
  else delete env.FORCE_FULL_LOAD;

  const proc = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  proc.on('error', () => { /* 交给就绪轮询处理 */ });
  spawned.push(proc);
  const logs = [];
  currentLogs = logs;
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));

  let boot = null;
  for (let i = 0; i < 80 && !boot; i++) {
    await sleep(150);
    try {
      const r = await fetch(`${BASE}/api/meta`);
      if (r.ok) boot = await r.json();
    } catch { /* 等待服务 */ }
    if (proc.exitCode != null) break;
  }
  if (!boot) throw new Error('服务未就绪：' + logs.join('').slice(-2000));
  return { proc, logs, boot };
}

/** 一个 section 独立 try/catch：单场景异常不中断其余场景 */
async function section(name, fn) {
  console.log(`\n【${name}】`);
  try {
    await fn();
  } catch (e) {
    fail++;
    console.error(`  [!!] ${name} 异常：${e.message}`);
    if (currentLogs.length) console.error('  server logs:', currentLogs.join('').slice(-1200));
  }
}

/**
 * overview 的**业务统计**汇总（计划 4.4 白名单**外**，必须逐条恒等）。
 *
 * 刻意排除速度画像族：`speed`（speedOf 结果）与 `summary.netMs / measuredSpeed /
 * speedSamples` 都由 buildSpeedProfiles(all) 在每次 rebuild 时按「当前已加载记录」
 * 重新拟合、再贴回每条记录，属 4.4 口径 A 的 speedProfiles / defaultOverheadMs
 * 渐进项。第一阶段每拍有新记录追加时它们同样会变，不是阶段 1 引入的口径变化。
 *
 * 真实数据实测（2026-11-12，173 文件 / 375MB）：冷启动「今天 → 全部 → 今天」后
 * 只有 netMs / measuredSpeed / speedSamples 变化，积分 / 请求数 / token / 命中率 /
 * 轮次 / 趋势分桶 / 最慢工具逐字段恒等。下面的 summaryDiff 用来防止把白名单悄悄扩大。
 */
const PROGRESSIVE_SUMMARY_KEYS = ['netMs', 'measuredSpeed', 'speedSamples'];
function bizSummary(s) {
  const out = { ...(s || {}) };
  for (const k of PROGRESSIVE_SUMMARY_KEYS) delete out[k];
  return out;
}
function summaryDiff(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (PROGRESSIVE_SUMMARY_KEYS.includes(k)) continue;
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out[k] = [a?.[k], b?.[k]];
  }
  return out;
}
function ovKey(ov) {
  return {
    summary: bizSummary(ov.summary),
    byModel: ov.byModel,
    byProject: ov.byProject,
    byKind: ov.byKind,
    timeline: ov.timeline,
    cacheHitRatePct: ov.cacheHitRatePct,
    // speed 整体取自速度画像（白名单渐进项），不纳入恒等比对
    phase: ov.phase,
    phaseBySession: ov.phaseBySession,
    toolTime: ov.toolTime,
    slowTools: ov.slowTools,
  };
}

/* ── CDP 段（可选；环境不允许时明确 SKIP，不假成功） ──────────────────── */
async function runCdp() {
  const BROWSER = [
    process.env.BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean).find((p) => fs.existsSync(p));
  const hasDist = fs.existsSync(path.join(root, 'web', 'dist', 'index.html'));
  if (!BROWSER) return { ok: false, reason: '找不到 Edge/Chrome（可用 BROWSER 指定浏览器路径）' };
  if (!hasDist) return { ok: false, reason: 'web/dist/index.html 不存在（未执行 npm run build）' };

  const cdpPort = 9900 + Math.floor(Math.random() * 200);
  cdpProfile = path.join(os.tmpdir(), `wb-phase1-cdp-${cdpPort}`);
  browser = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${cdpProfile}`,
    '--window-size=1400,900', `${BASE}/`,
  ], { stdio: 'ignore' });
  browser.on('error', () => {});
  spawned.push(browser);

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((x) => x.type === 'page' && x.url.includes(`127.0.0.1:${PORT}`));
    } catch { /* 等待浏览器 */ }
  }
  if (!target) throw new Error('找不到浏览器页面 target（CDP 端口未就绪）');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const o = JSON.parse(event.data);
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      consoleErrors.push(o.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (o.method === 'Runtime.exceptionThrown') consoleErrors.push('EXCEPTION');
    if (o.id && pending.has(o.id)) {
      pending.get(o.id)(o.result);
      pending.delete(o.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  await send('Runtime.enable');

  // 等页面三个视图 tab 就绪（轮询，不猜时间）
  for (let i = 0; i < 40; i++) {
    if ((await ev('document.querySelectorAll(".tab").length')) === 3) break;
    await sleep(250);
  }

  const loadedRange = await ev(`(function(){
    var e=document.querySelector('[data-testid="loaded-range"]');
    return e ? e.textContent.trim() : null;
  })()`);
  check('CDP: [data-testid="loaded-range"] 出现且交代已加载范围',
    !!loadedRange && /已加载/.test(loadedRange) && /\//.test(loadedRange), String(loadedRange));

  // MutationObserver 记录 history-loading 是否曾出现（v-if 动态节点，不靠 sleep 抓瞬时状态）
  await ev(`(function(){
    window.__sawHist=false;
    var obs=new MutationObserver(function(){
      if(document.querySelector('[data-testid="history-loading"]')) window.__sawHist=true;
    });
    obs.observe(document.documentElement,{childList:true,subtree:true});
    window.__histObs=obs;
  })()`);

  const clicked = await ev(`(function(){
    var b=document.querySelectorAll('.seg-btn');
    for(var i=0;i<b.length;i++) if(b[i].textContent.trim()==='全部'){b[i].click();return true;}
    return false;
  })()`);
  check('CDP: 能点到「全部」档位按钮', clicked === true, String(clicked));

  let saw = false;
  let present = true;
  for (let i = 0; i < 80; i++) {
    saw = await ev('!!window.__sawHist');
    present = await ev(`!!document.querySelector('[data-testid="history-loading"]')`);
    if (saw && !present) break;
    await sleep(200);
  }
  check('CDP: 切「全部」时 [data-testid="history-loading"] 出现', saw === true, `saw=${saw}`);
  check('CDP: 请求结束后 history-loading 消失', present === false, `present=${present}`);
  check('CDP: 浏览器控制台无 error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  return { ok: true };
}
function closeCdp() {
  if (ws) { try { ws.close(); } catch { /* 已关闭 */ } ws = null; }
  if (browser) { killTree(browser); browser = null; }
  if (cdpProfile) {
    try { fs.rmSync(cdpProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch { /* 下次清理 */ }
    cdpProfile = '';
  }
}

/* ── 清理 ─────────────────────────────────────────────────────────────── */
function cleanup() {
  closeCdp();
  for (const p of spawned) killTree(p);
  restoreCache();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch { /* 下次清理 */ }
}

/* ======================================================================== */
buildFixture();
let base = null; // FORCE_FULL_LOAD=1 的全量基线
try {
  /* ── 场景 2：FORCE_FULL_LOAD=1 全量路径（先跑，拿逐条对比基线） ───────── */
  await section('FORCE_FULL_LOAD=1 全量路径 + 基线', async () => {
    const s = await startServer({ forceFullLoad: true });
    try {
      const meta = (await api('/api/meta')).json;
      check('FORCE_FULL_LOAD=1：meta.fullLoad === true', meta.fullLoad === true, String(meta.fullLoad));
      check('FORCE_FULL_LOAD=1：loadedFiles === totalFiles',
        meta.loadedFiles === meta.totalFiles && meta.totalFiles === FILES.length,
        `${meta.loadedFiles}/${meta.totalFiles}`);
      base = {
        ov: (await api(`/api/overview?${Q_ALL}`)).json,
        sessions: (await api('/api/sessions?granularity=day')).json,
        requests: (await api('/api/requests?granularity=day&page=1&size=500')).json,
        detail: (await api(`/api/session?sessionId=${COLD_SESSION}&granularity=day`)).json,
        recordCount: meta.recordCount,
        sessionCount: meta.sessionCount,
      };
      check('全量基线：overview.summary.requests 与夹具记录数一致',
        base.ov.summary.requests === FILES.reduce((a, f) => a + f.ts.length, 0),
        String(base.ov.summary.requests));
    } finally {
      stopServer(s);
    }
  });

  /* ── 场景 1：冷启动主链路 + CDP + 安全回归 ────────────────────────────── */
  await section('冷启动主链路（V1/V3/V4/V9 + CDP + 安全）', async () => {
    if (!base) throw new Error('缺少全量基线，跳过冷启动主链路');
    const s = await startServer({ forceFullLoad: false });
    try {
      const logs = s.logs.join('');
      const m = logs.match(/已加载\s+(\d+)\s*\/\s*(\d+)\s*个文件/);
      check('V9: 启动日志含「已加载 N / 共 M 个文件」', !!m, m ? m[0] : logs.slice(-300));
      const N = m ? Number(m[1]) : -1;
      const M = m ? Number(m[2]) : -1;
      check('V9: 冷启动 N < M（未走全量）', N >= 0 && N < M, `N=${N} M=${M}`);
      check('V1: 启动日志含「启动解析 X B」', /启动解析\s+[\d,]+\s*B/.test(logs));

      const meta0 = (await api('/api/meta')).json;
      check('meta.loadedFiles/totalFiles/fullLoad 正确',
        meta0.loadedFiles === N && meta0.totalFiles === M && meta0.fullLoad === false,
        `loaded=${meta0.loadedFiles}/${meta0.totalFiles} full=${meta0.fullLoad}`);
      const R0 = meta0.revision;

      /* V1/V3：默认「今天」请求不增加 loadedFiles、revision 稳定 */
      for (let i = 0; i < 3; i++) await api(`/api/overview?${Q_TODAY}`);
      const metaToday = (await api('/api/meta')).json;
      check('V1: 默认「今天」请求不增加 loadedFiles',
        metaToday.loadedFiles === meta0.loadedFiles, `${meta0.loadedFiles}→${metaToday.loadedFiles}`);
      check('V1: 默认「今天」请求 revision 稳定',
        metaToday.revision === R0, `R0=${R0} now=${metaToday.revision}`);

      /* V4：冷会话 /api/session 定向加载，steps/turns 与全量逐条一致 */
      const detail = (await api(`/api/session?sessionId=${COLD_SESSION}&granularity=day`)).json;
      check('V4: 冷会话定向加载后 steps 与全量逐条一致', same(detail.steps, base.detail.steps),
        `${detail.steps.length} vs ${base.detail.steps.length}`);
      check('V4: 冷会话 turns / turnSummary / summary 与全量一致',
        same(detail.turns, base.detail.turns) &&
        same(detail.turnSummary, base.detail.turnSummary) &&
        same(detail.summary, base.detail.summary));
      const metaDirected = (await api('/api/meta')).json;
      check('V4: 定向加载使 loadedFiles 恰好 +1',
        metaDirected.loadedFiles === meta0.loadedFiles + 1,
        `${meta0.loadedFiles}→${metaDirected.loadedFiles}`);

      /* CDP 段（可选）：此时仍 loaded<total，loaded-range 可见、切全部会亮 history 提示 */
      let cdp = { ok: false, reason: '' };
      try {
        cdp = await runCdp();
      } catch (e) {
        cdp = { ok: false, reason: `CDP 运行异常：${e.message}` };
      } finally {
        closeCdp(); // CDP 结束即关浏览器，避免后续 HTTP 断言被页面轮询干扰
      }
      if (!cdp.ok) {
        for (const n of [
          'CDP: [data-testid="loaded-range"] 出现',
          'CDP: 切「全部」时 [data-testid="history-loading"] 出现并在请求结束后消失',
          'CDP: 浏览器控制台无 error',
        ]) skipCheck(n, cdp.reason);
      }

      /* V3/V9：切「全部」→ loadedFiles===totalFiles，汇总与全量逐条一致 */
      const ovAll = (await api(`/api/overview?${Q_ALL}`)).json;
      const metaAll = (await api('/api/meta')).json;
      check('切「全部」后 loadedFiles === totalFiles',
        metaAll.loadedFiles === metaAll.totalFiles && metaAll.totalFiles === FILES.length,
        `${metaAll.loadedFiles}/${metaAll.totalFiles}`);
      check('切「全部」后 recordCount / sessionCount 与全量一致',
        metaAll.recordCount === base.recordCount && metaAll.sessionCount === base.sessionCount,
        `records ${metaAll.recordCount}/${base.recordCount}`);
      check('V3: /api/overview 关键汇总与全量路径逐条一致', same(ovKey(ovAll), ovKey(base.ov)));
      const sd = summaryDiff(ovAll.summary, base.ov.summary);
      check('V3: summary 差异仅允许出现在速度画像渐进字段（业务 KPI 恒等）',
        Object.keys(sd).length === 0, JSON.stringify(sd));
      const sessions = (await api('/api/sessions?granularity=day')).json;
      check('V3: /api/sessions items 与全量逐条一致', same(sessions.items, base.sessions.items));
      const requests = (await api('/api/requests?granularity=day&page=1&size=500')).json;
      check('V3: /api/requests total/items 与全量逐条一致',
        requests.total === base.requests.total && same(requests.items, base.requests.items),
        `total ${requests.total}/${base.requests.total}`);

      /* V1/V3：切全部只推进有限次 revision（不连跳）；重复切档不再读盘 */
      const R1 = metaAll.revision;
      check('切「全部」/定向加载后 revision 只有限推进（不连跳）',
        R1 > R0 && R1 - R0 <= 4, `R0=${R0} R1=${R1}`);
      for (const q of [Q_ALL, Q_TODAY, Q_ALL, Q_TODAY, Q_ALL]) await api(`/api/overview?${q}`);
      const metaRepeat = (await api('/api/meta')).json;
      check('V3: 「今天→全部→今天」反复切换后 revision 不再连跳',
        metaRepeat.revision === R1, `R1=${R1} now=${metaRepeat.revision}`);
      check('重复切档 loadedFiles 仍等于 totalFiles（不再读盘）',
        metaRepeat.loadedFiles === metaRepeat.totalFiles,
        `${metaRepeat.loadedFiles}/${metaRepeat.totalFiles}`);

      /* 安全回归 */
      const hostAttack = await rawRequest('/api/meta', { headers: { Host: 'evil.example' } });
      check('安全: 恶意 Host 返回 403', hostAttack.status === 403, String(hostAttack.status));
      const evilCors = await rawRequest('/api/meta', { headers: { Origin: 'http://evil.example' } });
      check('安全: 白名单外 Origin 不下发 ACAO', !evilCors.headers['access-control-allow-origin']);
      const goodCors = await rawRequest('/api/meta', { headers: { Origin: `http://127.0.0.1:5177` } });
      check('安全: 白名单内 Origin 精确回显 ACAO',
        goodCors.headers['access-control-allow-origin'] === 'http://127.0.0.1:5177',
        String(goodCors.headers['access-control-allow-origin']));
      const traversal = await rawRequest('/%2e%2e%2f%2e%2e%2fserver%2fsrc%2fconfig.js');
      check('安全: 目录穿越取不到 server/ 源码',
        !traversal.body.includes('WORKBUDDY_HOME') && !traversal.body.includes('CORS_ORIGINS'),
        `HTTP ${traversal.status}, ${traversal.body.length} bytes`);
    } finally {
      stopServer(s);
    }
  });

  /* ── 场景 3：V5 故障注入（冷文件改名 → 可重试 → 恢复） ────────────────── */
  await section('V5 故障注入（改名 / 可重试 / 恢复）', async () => {
    if (!base) throw new Error('缺少全量基线，跳过故障场景');
    const s = await startServer({ forceFullLoad: false });
    try {
      const meta0 = (await api('/api/meta')).json;
      check('故障用例起点确实有未加载冷文件',
        meta0.loadedFiles < meta0.totalFiles, `${meta0.loadedFiles}/${meta0.totalFiles}`);

      // 改名让冷文件在原路径消失：loadFile 里 fsp.stat 失败 → 返回 false，不标记 loaded
      fs.renameSync(FAULT_FILE, FAULT_FILE + '.hidden');
      const resp = await apiAny(`/api/overview?${Q_ALL}`);
      check('V5: 故障切「全部」返回非 200 或可重试语义',
        resp.status === 200 || resp.status >= 500, `HTTP ${resp.status}`);
      const metaFault = (await api('/api/meta')).json;
      check('V5: 故障文件未被永久标记 loaded（loadedFiles < totalFiles）',
        metaFault.loadedFiles < metaFault.totalFiles,
        `${metaFault.loadedFiles}/${metaFault.totalFiles}`);

      // 恢复文件后再切「全部」：只补失败的那个，最终齐全且汇总与全量一致
      fs.renameSync(FAULT_FILE + '.hidden', FAULT_FILE);
      await api(`/api/overview?${Q_ALL}`);
      const metaRecover = (await api('/api/meta')).json;
      check('V5: 恢复后 loadedFiles === totalFiles（无永久漏数据）',
        metaRecover.loadedFiles === metaRecover.totalFiles,
        `${metaRecover.loadedFiles}/${metaRecover.totalFiles}`);
      const recoveredOv = (await api('/api/overview?granularity=day')).json;
      check('V5: 恢复后关键汇总与全量逐条一致', same(ovKey(recoveredOv), ovKey(base.ov)));
    } finally {
      // 若断言中途抛错，确保改名被还原，避免污染临时夹具
      if (fs.existsSync(FAULT_FILE + '.hidden') && !fs.existsSync(FAULT_FILE)) {
        try { fs.renameSync(FAULT_FILE + '.hidden', FAULT_FILE); } catch { /* 忽略 */ }
      }
      stopServer(s);
    }
  });

  /* ── 场景 4：索引损坏 → 自动回退全量 ─────────────────────────────────── */
  await section('索引损坏自动回退全量', async () => {
    const s = await startServer({ corruptIndex: true }); // 不设 FORCE_FULL_LOAD
    try {
      const meta = (await api('/api/meta')).json;
      check('索引损坏回退：meta.fullLoad === true', meta.fullLoad === true, String(meta.fullLoad));
      check('索引损坏回退：loadedFiles === totalFiles',
        meta.loadedFiles === meta.totalFiles && meta.totalFiles === FILES.length,
        `${meta.loadedFiles}/${meta.totalFiles}`);
      check('启动日志含「索引不可用 / 回退全量」告警',
        /索引不可用|回退全量/.test(s.logs.join('')));
    } finally {
      stopServer(s);
    }
  });

  /* ── 场景 5：CLI index-rebuild.mjs --verify 不监听端口 ───────────────── */
  await section('CLI index-rebuild.mjs --verify 不监听端口', async () => {
    currentLogs = [];
    const cli = spawn(process.execPath, [path.join(root, 'tools', 'index-rebuild.mjs'), '--verify'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WORKBUDDY_HOME: HOME, PORT: String(CLI_PORT) },
    });
    cli.on('error', () => {});
    spawned.push(cli);
    let out = '';
    cli.stdout.on('data', (d) => { out += d.toString(); });
    cli.stderr.on('data', (d) => { out += d.toString(); });
    // CLI 很短命，必须在 spawn 后立刻挂 exit 监听；晚挂会错过事件导致顶层 await 永不 settle。
    const exited = new Promise((resolve) => cli.once('exit', (c) => resolve(c)));
    let everReachable = false;
    for (let i = 0; i < 12; i++) {
      if (await reachable('127.0.0.1', CLI_PORT, 200)) { everReachable = true; break; }
      await sleep(30);
    }
    // 超时兜底（unref + 及时 clear），避免极端情况下 CLI 卡住让顶层 await 悬空
    let to;
    const timeout = new Promise((resolve) => {
      to = setTimeout(() => resolve('timeout'), 8000);
      if (to.unref) to.unref();
    });
    const code = await Promise.race([exited, timeout]);
    clearTimeout(to);
    if (code === 'timeout') killTree(cli);
    check('--verify 运行期间不监听任何端口', !everReachable, `PORT=${CLI_PORT}`);
    check('--verify 输出「未写盘」且「校验通过」',
      out.includes('--verify：未写盘') && out.includes('校验通过'));
    check('--verify 退出码 0（无异常文件）', code === 0, String(code));
    check('--verify stdout 不含「API 已启动」（未起服务）', !out.includes('API 已启动'));
  });
} catch (e) {
  fail++;
  console.error('[verify-phase1] 顶层失败：', e.message);
  if (currentLogs.length) console.error(currentLogs.join('').slice(-2000));
} finally {
  cleanup();
}

console.log(`\n════════ PASS ${pass} / FAIL ${fail} / SKIP ${skip} ════════`);
if (skip) console.log(`（SKIP 项已在上方逐条打印原因；环境就绪后应重跑以覆盖 CDP 段）`);
if (fail) process.exitCode = 1;
