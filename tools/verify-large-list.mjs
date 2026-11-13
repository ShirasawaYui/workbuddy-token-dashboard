/** 第 8 步复审：用 .perf 的 500 会话验证主列表的真实 DOM 上限与交互。 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(root, '.perf', 'workbuddy');
const PORT = Number(process.env.LARGE_PORT || 5181);
const BASE = `http://127.0.0.1:${PORT}`;
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

if (!fs.existsSync(path.join(HOME, 'projects'))) {
  console.error('请先执行 npm run perf:gen 生成大数据合成夹具');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  console.error('请先执行 npm run build');
  process.exit(1);
}
const BROWSER = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((p) => fs.existsSync(p));
if (!BROWSER) throw new Error('找不到 Edge / Chrome，请用 BROWSER 指定');

let server = null;
let browser = null;
let ws = null;
let profile = '';
const logs = [];
async function cleanup() {
  if (ws) {
    try { ws.close(); } catch { /* 已断开 */ }
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
  server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKBUDDY_HOME: HOME, PORT: String(PORT), SCAN_INTERVAL_MS: '100000', FORCE_FULL_LOAD: '1' },
  });
  server.stdout.on('data', (d) => logs.push(d.toString()));
  server.stderr.on('data', (d) => logs.push(d.toString()));

  let meta = null;
  for (let i = 0; i < 80 && !meta; i++) {
    await sleep(300);
    try {
      const r = await fetch(`${BASE}/api/meta`);
      if (r.ok) meta = await r.json();
    } catch { /* 等待启动 */ }
  }
  if (!meta) throw new Error('大数据服务未就绪：' + logs.join(''));
  check('数据源确认为 .perf 合成夹具', path.resolve(meta.home) === path.resolve(HOME), meta.home);
  if (path.resolve(meta.home) !== path.resolve(HOME)) throw new Error('拒绝读取非合成数据源');
  check('夹具规模超过渲染阈值', meta.sessionCount > 200, `${meta.sessionCount} 会话`);

  const cdpPort = 9400 + Math.floor(Math.random() * 400);
  profile = path.join(os.tmpdir(), `wb-large-list-${cdpPort}`);
  browser = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--window-size=1500,1000', `${BASE}/`,
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
  let id = 0;
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
    const next = ++id;
    pending.set(next, resolve);
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  await send('Runtime.enable');
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  for (let i = 0; i < 30 && (await ev('document.querySelectorAll(".tab").length')) !== 3; i++) await sleep(300);
  // 默认档位改「今天」后，.perf 夹具跨 30 天，会话列表会被筛到远少于 500 个，撑不起
  // 「200 行 / 400 行 / 共 meta.sessionCount 个会话」这些断言。页面初始化后显式切回
  // 「全部」，让会话列表回到全量口径（按按钮文本点击，不按索引）。
  await ev(
    '(function(){var b=[...document.querySelectorAll(".fb-row .seg-btn")]' +
      '.find(function(x){return x.textContent.trim()===' + JSON.stringify('全部') + ';});' +
      'if(b)b.click();})()',
  );
  await sleep(2200); // 等切档后的全量请求落地
  await ev('document.querySelectorAll(".tab")[1].click()');
  const view = 'document.querySelectorAll(".content > *")[1]';
  const rowCount = () => ev(`${view}.querySelectorAll("tbody tr.srow").length`);
  for (let i = 0; i < 30 && (await rowCount()) !== 200; i++) await sleep(300);

  check('默认只渲染前 200 个会话行', (await rowCount()) === 200, String(await rowCount()));
  check(
    '组头小计仍覆盖全部会话',
    await ev(`(function(){var t=${view}.querySelector('.panel-sub').textContent;return t.indexOf('共 ${meta.sessionCount} 个会话')>=0 && t.indexOf('仅渲染前 200 行')>=0;})()`),
  );
  check('所有项目组头仍可见', (await ev(`${view}.querySelectorAll('tr.group-head').length`)) === 20);

  const clickHead = (label) => ev(
    `(function(){var b=[...${view}.querySelectorAll('.panel-head .btn')].find(function(x){return x.textContent.indexOf(${JSON.stringify(label)})>=0;});if(b)b.click();return !!b;})()`,
  );
  await clickHead('显示更多');
  await sleep(500);
  check('显示更多后再增加 200 行', (await rowCount()) === 400, String(await rowCount()));
  await clickHead('显示全部');
  await sleep(700);
  check('显示全部后行数等于会话总数', (await rowCount()) === meta.sessionCount, String(await rowCount()));
  await clickHead('全部收起');
  await sleep(300);
  check('全部收起后不渲染会话行', (await rowCount()) === 0);
  await clickHead('全部展开');
  await sleep(500);
  check('全部展开后恢复全部会话行', (await rowCount()) === meta.sessionCount, String(await rowCount()));
  check('大列表浏览器控制台无 error/warning', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  fail++;
  console.error('[verify-large-list] 失败：', e.message);
  console.error(logs.join('').slice(-2000));
} finally {
  await cleanup();
}

console.log(`\n════ 通过 ${pass} 项，失败 ${fail} 项 ════`);
process.exit(fail ? 1 : 0);
