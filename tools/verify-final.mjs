/**
 * 第 9 步：完整回归的边界与安全集成验证。
 *
 * 在独立合成夹具上启动真实 Node 服务与真实浏览器，覆盖：
 *  - 脏行 / 半行补完 / 文件被重写 / 跨天记录与日期筛选联动
 *  - 仅回环监听、恶意 Host、白名单 CORS、静态资源目录穿越
 *  - 原始提示词等敏感字段不进入 API 或 DOM，恶意标题按文本显示
 *  - 前端不向外部服务发起请求，浏览器控制台干净
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(root, '.final', 'workbuddy');
const PROJ = path.join(HOME, 'projects', 'd-code-final');
const FILE = path.join(PROJ, 'final-session.jsonl');
const PORT = Number(process.env.FINAL_PORT || 5182);
const BASE = `http://127.0.0.1:${PORT}`;
const LOCAL_HOST = `127.0.0.1:${PORT}`;
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

const SECRET = 'FINAL_SECRET_PROMPT_DO_NOT_DISPLAY_7f3a91';
const XSS = '<img src=x onerror="window.__finalPwned=1">';
const now = new Date();
const yesterday = new Date(now);
yesterday.setDate(yesterday.getDate() - 1);
yesterday.setHours(23, 58, 0, 0);
const today = new Date(now);
today.setHours(0, 1, 0, 0);
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function usageLine(id, ts, traceId, prompt) {
  return JSON.stringify({
    type: 'message',
    role: 'assistant',
    timestamp: ts,
    sessionId: 'final-session',
    cwd: 'D:\\code\\final',
    /** 故意放入原始提示词：解析器只允许提取 usage，不允许把它带到 API/DOM。 */
    content: SECRET,
    providerData: {
      messageId: id,
      conversationRequestId: `req-${id}`,
      model: 'final-model',
      traceId,
      promptText: SECRET,
      rawUsage: {
        prompt_tokens: prompt,
        completion_tokens: 100,
        total_tokens: prompt + 100,
        prompt_cache_hit_tokens: Math.round(prompt * 0.8),
        prompt_cache_miss_tokens: prompt - Math.round(prompt * 0.8),
        credit: 0.25,
      },
    },
  });
}
const titleLine = JSON.stringify({
  type: 'ai-title',
  timestamp: yesterday.getTime() - 60_000,
  sessionId: 'final-session',
  cwd: 'D:\\code\\final',
  aiTitle: `最终验证 ${XSS}`,
});
const line1 = usageLine('final-m1', yesterday.getTime(), 'final-turn-day1', 1000);
const line2 = usageLine('final-m2', today.getTime(), 'final-turn-day2', 2000);
const half = Math.floor(line2.length / 2);

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
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
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
function reachable(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

let server = null;
let browser = null;
let ws = null;
let profile = '';
const logs = [];
async function cleanup() {
  if (ws) {
    try { ws.close(); } catch { /* 已关闭 */ }
  }
  if (browser?.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      browser.kill('SIGKILL');
    }
  }
  if (server) server.kill();
  if (profile) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch { /* 下次清理 */ }
  }
}

try {
  if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
    throw new Error('请先执行 npm run build');
  }
  fs.mkdirSync(PROJ, { recursive: true });
  // 不递归删除：每次只覆盖这一个合成文件，便于保留夹具供复查。
  fs.writeFileSync(
    FILE,
    [titleLine, line1, 'not-json-{{{', line2.slice(0, half)].join('\n'),
  );

  server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOME: HOME,
      PORT: String(PORT),
      SCAN_INTERVAL_MS: '100000',
      FORCE_FULL_LOAD: '1',
    },
  });
  server.stdout.on('data', (d) => logs.push(d.toString()));
  server.stderr.on('data', (d) => logs.push(d.toString()));

  let boot = null;
  for (let i = 0; i < 60 && !boot; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${BASE}/api/meta`);
      if (r.ok) boot = await r.json();
    } catch { /* 等待服务 */ }
  }
  if (!boot) throw new Error('服务未就绪：' + logs.join('').slice(-2000));
  check('数据源确认为 .final 合成夹具', path.resolve(boot.home) === path.resolve(HOME), boot.home);
  if (path.resolve(boot.home) !== path.resolve(HOME)) throw new Error('拒绝读取非合成数据源');
  check('启动跳过脏行与半行，只计入 1 条', boot.recordCount === 1, String(boot.recordCount));
  check('半行尚未写入完整记录', boot.maxTs === yesterday.getTime(), String(boot.maxTs));

  console.log('\n【跨天、半行补完与筛选联动】');
  fs.appendFileSync(FILE, line2.slice(half) + '\n');
  const refreshed = await rawRequest('/api/refresh', { method: 'POST' });
  check('强制重扫返回 HTTP 200', refreshed.status === 200, String(refreshed.status));
  check('补全半行后记录数变为 2', JSON.parse(refreshed.body).recordCount === 2, refreshed.body);
  const allOverview = (await api('/api/overview?granularity=day')).json;
  check('跨天数据形成 2 个日桶', allOverview.timeline.length === 2, allOverview.timeline.map((x) => x.key).join(' , '));

  const day1 = ymd(yesterday);
  const day2 = ymd(today);
  for (const [label, day, expectedId] of [['跨天前一天', day1, 'final-m1'], ['跨天后一天', day2, 'final-m2']]) {
    const q = `from=${day}&to=${day}`;
    const [ov, sessions, requests, detail] = await Promise.all([
      api(`/api/overview?${q}`),
      api(`/api/sessions?${q}`),
      api(`/api/requests?${q}&page=1&size=50`),
      api(`/api/session?${q}&sessionId=final-session`),
    ]);
    check(`${label}：总览 / 会话 / 分页 / 会话详情筛选口径一致`,
      ov.json.summary.requests === 1 &&
      sessions.json.items[0]?.requests === 1 &&
      requests.json.total === 1 &&
      detail.json.summary.requests === 1,
      `overview=${ov.json.summary.requests} sessions=${sessions.json.items[0]?.requests} requests=${requests.json.total} session=${detail.json.summary.requests}`,
    );
    check(`${label}：命中的是当天的请求`, requests.json.items[0]?.id === expectedId, String(requests.json.items[0]?.id));
  }

  console.log('\n【敏感数据与本地边界】');
  const apiRoutes = [
    '/api/meta', '/api/overview', '/api/sessions',
    '/api/session?sessionId=final-session', '/api/requests?page=1&size=50',
  ];
  const bodies = [];
  for (const route of apiRoutes) bodies.push((await api(route)).text);
  check('API 响应不携带原始提示词 / promptText', bodies.every((b) => !b.includes(SECRET)), `${apiRoutes.length} 个端点`);

  const hostAttack = await rawRequest('/api/meta', { headers: { Host: 'evil.example' } });
  check('恶意 Host 被拒绝', hostAttack.status === 403, String(hostAttack.status));
  const allowedCors = await rawRequest('/api/meta', {
    headers: { Origin: 'http://127.0.0.1:5177' },
  });
  check('白名单 Origin 精确回显 ACAO',
    allowedCors.status === 200 && allowedCors.headers['access-control-allow-origin'] === 'http://127.0.0.1:5177',
    String(allowedCors.headers['access-control-allow-origin']),
  );
  const evilCors = await rawRequest('/api/meta', {
    headers: { Origin: 'http://evil.example' },
  });
  check('非白名单 Origin 不下发 ACAO', !evilCors.headers['access-control-allow-origin']);
  const rootPage = await rawRequest('/');
  check('生产静态产物由本地服务托管', rootPage.status === 200 && rootPage.body.includes('id="app"'), String(rootPage.status));
  const traversal = await rawRequest('/%2e%2e%2f%2e%2e%2fserver%2fsrc%2fconfig.js');
  check('目录穿越读取不到服务端源码',
    !traversal.body.includes('CORS_ORIGINS') && !traversal.body.includes('WORKBUDDY_HOME') && !traversal.body.includes(SECRET),
    `HTTP ${traversal.status}, ${traversal.body.length} bytes`,
  );

  // ---------- 新 CLI（tools/index-rebuild.mjs）的安全回归 ----------
  // 入口定为 CLI 而非 HTTP，不扩大 Host / CORS 写面；验证它能跑通、给出校验结论，
  // 且落盘索引只记汇总量、不含标题 / 提示词 / cwd 等敏感字段。--verify 只读 JSONL、不写盘。
  const cli = spawnSync(
    process.execPath,
    ['tools/index-rebuild.mjs', '--verify'],
    { cwd: root, env: { ...process.env, WORKBUDDY_HOME: HOME }, encoding: 'utf8', timeout: 60000 },
  );
  const cliOut = (cli.stdout || '') + (cli.stderr || '');
  check('index-rebuild --verify 退出码为 0', cli.status === 0,
    `exit=${cli.status}${cli.error ? ' ' + cli.error.message : ''}`);
  check('index-rebuild --verify 输出含「校验通过」', cliOut.includes('校验通过'));
  const indexFile = path.join(root, 'server', '.cache', 'file-index.json');
  if (fs.existsSync(indexFile)) {
    const indexText = fs.readFileSync(indexFile, 'utf8');
    const sensitive = /"(title|prompt|promptText|cwd|content|aiTitle)"\s*:/.test(indexText);
    check('索引 JSON 不含 title / prompt / cwd 等敏感字段', !sensitive);
  } else {
    console.log('  [跳过] file-index.json 不存在，跳过内容检查（退出码已单独断言）');
  }

  const lanIp = Object.values(os.networkInterfaces())
    .flat()
    .find((x) => x && x.family === 'IPv4' && !x.internal)?.address;
  if (lanIp) {
    check('回环服务可从 127.0.0.1 连接', await reachable('127.0.0.1', PORT), '127.0.0.1');
    check('局域网地址未监听', !(await reachable(lanIp, PORT)), lanIp);
  } else {
    check('本机无可用局域网地址，跳过局域网可达性断言', true, '未发现非内部 IPv4');
  }

  console.log('\n【文件重写】');
  fs.writeFileSync(FILE, [titleLine, line1].join('\n') + '\n');
  const rewritten = await rawRequest('/api/refresh', { method: 'POST' });
  const afterRewrite = (await api('/api/session?sessionId=final-session')).json;
  check('文件变小后整体重解析', JSON.parse(rewritten.body).recordCount === 1, rewritten.body);
  check('重写后不残留旧记录',
    afterRewrite.summary.requests === 1 && afterRewrite.steps[0]?.id === 'final-m1',
    `requests=${afterRewrite.summary.requests} id=${afterRewrite.steps[0]?.id}`,
  );

  console.log('\n【真实浏览器：注入面与外部请求】');
  const BROWSER = [
    process.env.BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean).find((p) => fs.existsSync(p));
  if (!BROWSER) throw new Error('找不到 Edge / Chrome，请用 BROWSER 指定');
  const cdpPort = 9800 + Math.floor(Math.random() * 200);
  profile = path.join(os.tmpdir(), `wb-final-verify-${cdpPort}`);
  browser = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--window-size=1400,900', `${BASE}/`,
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((x) => x.type === 'page' && x.url.includes(`127.0.0.1:${PORT}`));
    } catch { /* 等待浏览器 */ }
  }
  if (!target) throw new Error('找不到浏览器页面 target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const o = JSON.parse(event.data);
    if (o.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(o.params.type)) {
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
  await send('Runtime.enable');
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  for (let i = 0; i < 30 && (await ev('document.querySelectorAll(".tab").length')) !== 3; i++) await sleep(300);

  await ev(`(function(){
    window.__finalExternal=[];
    var f=window.fetch;
    window.fetch=function(u){
      var url=String((u&&u.url)||u);
      if(/^https?:/.test(url) && url.indexOf(location.origin)!==0) window.__finalExternal.push(url);
      return f.apply(this,arguments);
    };
  })()`);
  await ev('document.querySelectorAll(".tab")[1].click()');
  await sleep(700);
  await ev('document.querySelectorAll(".tab")[2].click()');
  await sleep(700);
  await ev('document.querySelectorAll(".tab")[0].click()');
  await sleep(700);
  check('页面操作期间没有外部网络请求', (await ev('window.__finalExternal.length')) === 0,
    JSON.stringify(await ev('window.__finalExternal')));
  const domProbe = await ev(`(function(){
    return {
      imgs:document.querySelectorAll('img').length,
      pwned:!!window.__finalPwned,
      literal:document.body.textContent.indexOf('<img src=x')>=0,
      secret:document.body.textContent.indexOf(${JSON.stringify(SECRET)})>=0,
      externalResources:performance.getEntriesByType('resource')
        .map(function(e){return e.name;})
        .filter(function(n){return /^https?:/.test(n) && n.indexOf(location.origin)!==0;}).length
    };
  })()`);
  check('恶意标题按字面文本显示且未生成 img', !!domProbe && domProbe.imgs === 0 && domProbe.literal && !domProbe.pwned,
    JSON.stringify(domProbe));
  check('浏览器 DOM 不含原始提示词', !!domProbe && !domProbe.secret && domProbe.externalResources === 0,
    JSON.stringify(domProbe));
  check('浏览器控制台无 error/warning', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  fail++;
  console.error('[verify-final] 失败：', e.message);
  console.error(logs.join('').slice(-2000));
} finally {
  await cleanup();
}

console.log(`\n════ 通过 ${pass} 项，失败 ${fail} 项 ════`);
process.exit(fail ? 1 : 0);
