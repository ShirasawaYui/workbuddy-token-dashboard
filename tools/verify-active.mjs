/**
 * 第 7 步验收：多会话交替追加 + 跟随／固定模式。
 *
 * 一条命令验证四件事：
 *  1) 只有 session-meta / ai-title 的文件不算活跃，不产生凭空的 0 消耗会话；
 *  2) 只有用户消息、还没有 credit 的新会话能被识别；
 *  3) A → B → C → A 交替追加时，/api/meta 的最近活跃目标正确切换；
 *  4) 真实浏览器里「固定」后不被别的会话活动抢走，切回「跟随」立刻跟上。
 *
 * 数据源全部是合成的 .active/ 目录（已加进 .gitignore），不读真实会话。
 * 服务只绑 127.0.0.1，端口默认 5180。
 *
 * 运行：npm run test:active   （前置：npm run build；本机有 Edge 或 Chrome）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ACTIVE_PORT || 5180);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = path.join(root, '.active', 'workbuddy');
const DIR = path.join(HOME, 'projects', 'p-active');
const F = {
  a: path.join(DIR, 'session-a.jsonl'),
  b: path.join(DIR, 'session-b.jsonl'),
  c: path.join(DIR, 'session-c.jsonl'),
  d: path.join(DIR, 'session-d.jsonl'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  [OK] ${name}${extra ? '  (' + extra + ')' : ''}`);
  } else {
    fail++;
    console.log(`  [!!] ${name}${extra ? '  (' + extra + ')' : ''}`);
  }
}

if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  console.error('还没有前端构建产物，请先执行：npm run build');
  process.exit(1);
}
const BROWSER = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
  .filter(Boolean)
  .find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.error('找不到浏览器，请用 BROWSER=<可执行文件路径> 指定');
  process.exit(1);
}

/* 时钟严格递增：日志时间戳与文件 mtime 都用它，保证「最后写入者胜出」确定可复现，
   不依赖文件系统 mtime 精度。 */
let clock = Date.now();
const nextTs = () => (clock += 1000);
function touch(file) {
  const sec = clock / 1000;
  fs.utimesSync(file, sec, sec);
}
function rowsOf(sid, rows) {
  return rows.map((o) => JSON.stringify({ sessionId: sid, ...o })).join('\n') + '\n';
}
function writeRows(file, sid, rows) {
  fs.appendFileSync(file, rowsOf(sid, rows));
  clock += 1000;
  touch(file);
}
const metaRow = (t) => ({ type: 'session-meta', timestamp: t });
const titleRow = (t, title) => ({ type: 'ai-title', timestamp: t, aiTitle: title });
const userRow = (t) => ({ type: 'message', role: 'user', timestamp: t, message: { text: '请继续' } });
function usageRow(t, id) {
  return {
    type: 'message',
    role: 'assistant',
    timestamp: t,
    providerData: {
      messageId: id,
      model: 'active-test-model',
      traceId: `trace-${id}`,
      rawUsage: {
        prompt_tokens: 20000,
        completion_tokens: 300,
        total_tokens: 20300,
        prompt_cache_hit_tokens: 18000,
        prompt_cache_miss_tokens: 2000,
        credit: 0.35,
      },
    },
  };
}

const serverLogs = [];
let server = null;
let browser = null;
let profile = '';
let ws = null;

/** ⚠ 必须在 .active/workbuddy/projects 建好之后再启动，否则 resolveHome() 会回退到真实 ~/.workbuddy */
function startServer() {
  server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOME: HOME,
      PORT: String(PORT),
      SCAN_INTERVAL_MS: '1000',
      FORCE_FULL_LOAD: '1',
    },
  });
  server.stdout.on('data', (d) => serverLogs.push(d.toString()));
  server.stderr.on('data', (d) => serverLogs.push(d.toString()));
}
async function apiJson(route, init) {
  const r = await fetch(BASE + route, init);
  const text = await r.text();
  // 不检查状态会让一次 500 被当成「刷新成功」，后续断言可能假通过。
  if (!r.ok) throw new Error(`${route} HTTP ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
const meta = async () => apiJson('/api/meta');
const refresh = async () => {
  const body = await apiJson('/api/refresh', { method: 'POST' });
  if (!body.ok) throw new Error('/api/refresh 返回非成功状态：' + JSON.stringify(body));
  await sleep(150);
};

async function cleanup() {
  if (ws) {
    try {
      ws.close();
    } catch {
      /* 已断开 */
    }
  }
  if (browser && browser.pid) {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* 进程可能已退出 */
      }
    } else {
      browser.kill('SIGKILL');
    }
  }
  if (server) server.kill();
  if (profile) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch {
      /* 句柄没释放干净就留给系统临时目录 */
    }
  }
}

try {
  /* ---------- 1. 重置夹具并启动服务 ---------- */
  fs.rmSync(path.join(root, '.active'), { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const t0 = nextTs();
  fs.writeFileSync(F.a, rowsOf('session-a', [metaRow(t0), titleRow(t0, 'A 会话')]));
  touch(F.a);

  startServer();
  let ready = false;
  for (let i = 0; i < 25 && !ready; i++) {
    await sleep(300);
    try {
      await meta();
      ready = true;
    } catch {
      /* 服务还在启动 */
    }
  }
  if (!ready) throw new Error('解析服务未就绪：\n' + serverLogs.join(''));
  const boot = await meta();
  check(
    '数据源确认为 .active 合成夹具',
    path.resolve(boot.home || '') === path.resolve(HOME),
    path.resolve(boot.home || ''),
  );
  if (path.resolve(boot.home || '') !== path.resolve(HOME)) {
    throw new Error('拒绝继续：解析服务读到了非夹具数据源，避免把真实日志计入验证');
  }
  check('初始无用量记录', boot.recordCount === 0, String(boot.recordCount));
  check('纯元信息文件不算活跃会话', boot.latestActiveSessionId === null, String(boot.latestActiveSessionId));

  /* ---------- 2. 尚无 credit 的新会话 ---------- */
  writeRows(F.a, 'session-a', [userRow(nextTs())]);
  await refresh();
  let m = await meta();
  check('只有用户消息也能被识别', m.latestActiveSessionId === 'session-a', String(m.latestActiveSessionId));
  check('明确标记尚无用量记录', m.latestActive?.hasUsage === false, JSON.stringify(m.latestActive));
  check('没有凭空产生用量记录', m.recordCount === 0, String(m.recordCount));

  /* ---------- 3. 多会话交替追加，跟随目标随之切换 ---------- */
  const tb = nextTs();
  fs.writeFileSync(F.b, rowsOf('session-b', [metaRow(tb), titleRow(tb, 'B 会话'), usageRow(nextTs(), 'b-1')]));
  clock += 1000;
  touch(F.b);
  await refresh();
  m = await meta();
  check('B 写入 → 切到 B', m.latestActiveSessionId === 'session-b', String(m.latestActiveSessionId));
  check('B 有用量记录', m.latestActive?.hasUsage === true);

  const tc = nextTs();
  fs.writeFileSync(F.c, rowsOf('session-c', [metaRow(tc), titleRow(tc, 'C 会话'), usageRow(nextTs(), 'c-1')]));
  clock += 1000;
  touch(F.c);
  await refresh();
  m = await meta();
  check('C 写入 → 切到 C', m.latestActiveSessionId === 'session-c', String(m.latestActiveSessionId));

  writeRows(F.a, 'session-a', [usageRow(nextTs(), 'a-1')]);
  await refresh();
  m = await meta();
  check('A 再追加 → 切回 A（交替切换成立）', m.latestActiveSessionId === 'session-a', String(m.latestActiveSessionId));
  check('A 已有用量记录', m.latestActive?.hasUsage === true);

  /* ---------- 4. 真实浏览器：跟随 / 固定 ---------- */
  const CDP_PORT = 9500 + Math.floor(Math.random() * 400);
  profile = path.join(os.tmpdir(), 'wb-active-verify-' + CDP_PORT);
  browser = spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,1000',
      BASE + '/',
    ],
    { stdio: 'ignore' },
  );
  let target = null;
  for (let i = 0; i < 25 && !target; i++) {
    await sleep(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((x) => x.type === 'page' && x.url.includes(`127.0.0.1:${PORT}`));
    } catch {
      /* 浏览器还没起来 */
    }
  }
  if (!target) throw new Error('未找到可调试的页面 target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (e) => {
    const o = JSON.parse(e.data);
    if (o.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(o.params.type)) {
      consoleErrors.push(o.params.type + ': ' + o.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (o.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + (o.params.exceptionDetails.exception?.description || ''));
    }
    if (o.id && pending.has(o.id)) {
      pending.get(o.id)(o.result);
      pending.delete(o.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++msgId;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
  await send('Runtime.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r && r.result ? r.result.value : undefined;
  };
  for (let i = 0; i < 25 && (await ev('document.querySelectorAll(".tab").length')) !== 3; i++) {
    await sleep(400);
  }
  check('页面正常挂载', (await ev('document.querySelectorAll(".tab").length')) === 3);
  const bar = 'document.querySelector(".active-bar")';
  const attr = (name) => ev(`${bar}?.getAttribute("${name}")`);
  check('摘要条默认跟随模式', (await attr('data-mode')) === 'follow');
  check('跟随目标为 A', (await attr('data-session-id')) === 'session-a', String(await attr('data-session-id')));
  // 页面挂载 ≠ 摘要条数据已落地：App.onMounted 的 loadMeta 与摘要条的
  // sessionDetail 是两条异步链。批量串行跑时偶发「指标 0 项」的抢跑假失败，
  // 这里最多等 4 秒让指标卡渲染；真没数据仍会在下面的断言里如实失败。
  for (let i = 0; i < 20 && (await ev('document.querySelectorAll(".active-bar .as-metric").length')) === 0; i++) {
    await sleep(200);
  }
  check('有用量时渲染 4 项指标', (await ev('document.querySelectorAll(".active-bar .as-metric").length')) === 4);

  const clickSwitch = (label) =>
    ev(
      `(function(){var b=[...document.querySelectorAll(".active-bar .as-switch .seg-btn")]` +
        `.find(function(x){return x.textContent.indexOf(${JSON.stringify(label)})>=0;});` +
        `if(b)b.click();return !!b;})()`,
    );
  await clickSwitch('固定');
  await sleep(350);
  check('可切换到固定模式', (await attr('data-mode')) === 'pinned');
  check('固定后目标仍是 A', (await attr('data-session-id')) === 'session-a');

  /* 别的会话又变活跃：固定视图不能被抢走 */
  writeRows(F.c, 'session-c', [usageRow(nextTs(), 'c-2')]);
  await refresh();
  m = await meta();
  check('服务端最近活跃已切到 C', m.latestActiveSessionId === 'session-c', String(m.latestActiveSessionId));
  await sleep(7000); // 服务端 1s 扫描 + 前端 5s 静默轮询，留足一拍余量
  check('固定模式下摘要条仍锁定 A', (await attr('data-session-id')) === 'session-a', String(await attr('data-session-id')));
  check(
    '固定模式给出「已固定，不跟随」交代',
    await ev(`${bar}.textContent.indexOf("已固定，不跟随")>=0`),
  );

  await clickSwitch('跟随');
  await sleep(400);
  check('切回跟随立刻跟上 C', (await attr('data-mode')) === 'follow' && (await attr('data-session-id')) === 'session-c', String(await attr('data-session-id')));

  /* ---------- 5. 无 credit 新会话：前端不显示虚假的 0 消耗 ---------- */
  const td = nextTs();
  fs.writeFileSync(F.d, rowsOf('session-d', [metaRow(td), titleRow(td, 'D 会话'), userRow(nextTs())]));
  clock += 1000;
  touch(F.d);
  await refresh();
  m = await meta();
  check('无 credit 的 D 成为最近活跃', m.latestActiveSessionId === 'session-d' && m.latestActive?.hasUsage === false);
  await sleep(7000);
  check('前端给出空态而非数字', await ev('!!document.querySelector(".active-bar .as-empty")'));
  check(
    '空态明确说明「尚无用量记录」',
    await ev('document.querySelector(".active-bar .as-empty")?.textContent.indexOf("尚无用量记录")>=0'),
  );
  check('空态下不渲染指标卡', (await ev('document.querySelectorAll(".active-bar .as-metric").length')) === 0);
  check('浏览器控制台无 error/warning', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (err) {
  fail++;
  console.error('[verify-active] 失败：', err.message);
  console.error(serverLogs.join('').trim());
} finally {
  await cleanup();
}

console.log(`\n════ 通过 ${pass} 项，失败 ${fail} 项 ════`);
process.exit(fail ? 1 : 0);
