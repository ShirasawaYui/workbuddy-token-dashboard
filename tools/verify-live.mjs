/**
 * 实时夹具的浏览器级验证（第 4 步验收）。
 *
 * 一条命令同时验证两件事：
 *  1) live-append 夹具能稳定复现"同一轮多次请求逐步出现"：启动一个独立解析服务
 *     （默认 5179，只绑回环），让 scripts/live-demo.js 按批追加，观察 /api/meta
 *     的 recordCount 逐拍增长，并读回 JSONL 核对 traceId 分组。
 *  2) 恶意名称不进入 tooltip 的 HTML 解析：把 tooltipHtml.js 真实生成的 HTML
 *     插进真实浏览器的 innerHTML，断言不会生成 img/svg/[onerror] 元素，
 *     而 marker、<b> 与固定样式都还在。
 *
 * 为什么不靠鼠标悬停触发 ECharts tooltip：它是 canvas 渲染，坐标触发很脆弱。
 * 直接把同一段模板输出交给浏览器解析，验证的是同一件事且完全确定。
 *
 * 运行：npm run test:live
 * 前置：npm run build 已生成 web/dist；本机有 Edge 或 Chrome
 * 环境变量：LIVE_PORT（默认 5179）、BROWSER
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LIVE_PORT || 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE_HOME = path.join(root, '.live', 'workbuddy');
const LIVE_FILE = path.join(
  LIVE_HOME,
  'projects',
  'd-code-livedemo',
  'live-session-0001.jsonl',
);

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

const serverLogs = [];
let server = null;

/**
 * ⚠ 必须在 scripts/live-demo.js --gen 建好 .live/workbuddy/projects 之后再启动。
 * config.resolveHome() 在模块加载时就固定 HOME；若目录还不存在，它会回退到
 * ~/.workbuddy，把真实会话日志读进来——既污染验证结果，也不该拿真实数据做测试。
 */
function startServer() {
  server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKBUDDY_HOME: LIVE_HOME,
      PORT: String(PORT),
      SCAN_INTERVAL_MS: '1000',
      FORCE_FULL_LOAD: '1',
    },
  });
  server.stdout.on('data', (d) => serverLogs.push(d.toString()));
  server.stderr.on('data', (d) => serverLogs.push(d.toString()));
}

async function meta() {
  const r = await fetch(`${BASE}/api/meta`);
  if (!r.ok) throw new Error('meta HTTP ' + r.status);
  return r.json();
}

let browser = null;
let profile = '';
let ws = null;

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
      try {
        browser.kill('SIGKILL');
      } catch {
        /* 同上 */
      }
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
  const gen = spawnSync(process.execPath, ['scripts/live-demo.js', '--gen'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (gen.status !== 0) throw new Error('生成初始数据失败：' + gen.stderr);
  console.log(gen.stdout.trim());

  // 目录就绪后才启动服务，避免 resolveHome() 回退到真实 ~/.workbuddy
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
  const bootMeta = await meta();
  const actualHome = path.resolve(bootMeta.home || '');
  const expectedHome = path.resolve(LIVE_HOME);
  check('数据源确认为 live 合成夹具', actualHome === expectedHome, actualHome);
  if (actualHome !== expectedHome) {
    throw new Error('拒绝继续：解析服务读到了非夹具数据源，避免把真实日志计入验证');
  }
  check('初始夹具没有用量记录', bootMeta.recordCount === 0, String(bootMeta.recordCount));

  /* ---------- 2. 按批追加，观察记录数逐步增长 ---------- */
  const counts = [];
  const writer = spawn(
    process.execPath,
    ['scripts/live-demo.js', '--no-serve', '--steps=6', '--interval=700'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let writerLog = '';
  writer.stdout.on('data', (d) => (writerLog += d.toString()));
  writer.stderr.on('data', (d) => (writerLog += d.toString()));
  const poller = setInterval(async () => {
    try {
      counts.push((await meta()).recordCount);
    } catch {
      /* 忽略单拍抖动 */
    }
  }, 350);

  await new Promise((res) => writer.on('exit', res));
  await sleep(2500); // 等最后一次增量扫描落库
  clearInterval(poller);
  console.log(writerLog.trim());

  const finalMeta = await meta();
  const rising = [...new Set(counts)].filter((n) => n > 0);
  check('recordCount 随追加逐步增长', rising.length >= 3, '观测 ' + rising.join('→'));
  check('6 批 = 2 轮 × 3 请求 + 1 条无 traceId', finalMeta.recordCount === 7, String(finalMeta.recordCount));

  /* ---------- 3. 读回 JSONL 核对轮次口径 ---------- */
  const rows = fs
    .readFileSync(LIVE_FILE, 'utf8')
    .trim()
    .split('\n')
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.providerData && r.providerData.rawUsage);
  const groups = new Map();
  for (const r of rows) {
    const k = r.providerData.traceId || '(缺失 traceId)';
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  const realTurns = [...groups.entries()].filter(([k]) => k !== '(缺失 traceId)');
  check(
    '同一轮多次请求共享 traceId',
    realTurns.length >= 2 && realTurns.every(([, n]) => n === 3),
    JSON.stringify(Object.fromEntries([...groups].map(([k, v]) => [k.slice(0, 10), v]))),
  );
  check('存在缺失 traceId 的孤立请求', (groups.get('(缺失 traceId)') || 0) >= 1);
  const userMsgs = fs
    .readFileSync(LIVE_FILE, 'utf8')
    .split('\n')
    .filter((s) => s.includes('"role":"user"')).length;
  check('轮次边界有用户消息', userMsgs === 2, userMsgs + ' 条');

  /* ---------- 4. 真实浏览器验证 tooltip HTML 转义 ---------- */
  const CDP_PORT = 9400 + Math.floor(Math.random() * 400);
  profile = path.join(os.tmpdir(), 'wb-live-verify-' + CDP_PORT);
  browser = spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,900',
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

  ws = new WebSocket(target.webSocketDebuggerUrl); // Node 22+ 内置
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
  for (let i = 0; i < 20; i++) {
    if ((await ev('document.querySelectorAll(".tab").length')) === 3) break;
    await sleep(400);
  }
  check('live 页面正常挂载', (await ev('document.querySelectorAll(".tab").length')) === 3);

  // 默认档位改「今天」后，后面「切回总览时 visibleRequests === meta.recordCount」
  // 这类断言要求页面 KPI 与全量 meta 同口径；显式切回「全部」把前置条件恢复到全量视图。
  // 按按钮文本点击，不按索引；切档在下方 fetch 故障注入之前完成，不污染其计数器。
  await ev(
    '(function(){var b=[...document.querySelectorAll(".fb-row .seg-btn")]' +
      '.find(function(x){return x.textContent.trim()===' + JSON.stringify('全部') + ';});' +
      'if(b)b.click();})()',
  );
  await sleep(2200); // 等切档后的视图请求落地

  const {
    trendTooltipHtml,
    modelTooltipHtml,
    toolTooltipHtml,
    stepTooltipHtml,
  } = await import('../web/src/utils/tooltipHtml.js');
  const MARKER = '<span style="display:inline-block;background-color:#27618c"></span>';
  const XSS = '<img src=x onerror="alert(1)">';
  const html = [
    trendTooltipHtml(
      { key: `2026-11-12 ${XSS}`, prompt: 1000, cacheRead: 900, requests: 3, credit: 0.5 },
      [{ marker: MARKER, seriesName: `缓存命中 ${XSS}`, value: 900 }],
    ),
    modelTooltipHtml(
      { name: `model-${XSS}`, percent: 50, data: { req: 2, total: 1000, realCredit: 1 } },
      'credit',
    ),
    toolTooltipHtml({ name: `Bash-${XSS}`, calls: 2, prompt: 1000, completion: 100, credit: 0.2 }, null),
    stepTooltipHtml(
      {
        ts: Date.now(),
        toolName: `Read-${XSS}`,
        prompt: 1000,
        completion: 100,
        cacheRead: 900,
        reasoning: 0,
        durMs: 3000,
        tps: null,
        credit: 0.2,
      },
      0,
    ),
  ].join('<hr/>');

  const probe = await ev(`(function(){
    var d=document.createElement('div'); d.id='__escape_probe';
    d.innerHTML=${JSON.stringify(html)};
    document.body.appendChild(d);
    return {
      imgs: d.querySelectorAll('img').length,
      svgs: d.querySelectorAll('svg').length,
      onerror: d.querySelectorAll('[onerror]').length,
      onload: d.querySelectorAll('[onload]').length,
      markers: d.querySelectorAll('span[style*="background-color"]').length,
      bold: d.querySelectorAll('b').length,
      hasLiteral: d.textContent.indexOf(${JSON.stringify(XSS)}) >= 0,
      hasStyle: d.innerHTML.indexOf('border-top:1px solid #eee') >= 0
    };
  })()`);
  check('恶意名称未生成 img/svg 元素', !!probe && probe.imgs === 0 && probe.svgs === 0, JSON.stringify(probe));
  check('恶意名称未生成 onerror/onload 属性', !!probe && probe.onerror === 0 && probe.onload === 0);
  check('恶意名称按字面文本显示', !!probe && probe.hasLiteral === true);
  check('marker、加粗与固定样式保留', !!probe && probe.markers >= 1 && probe.bold > 0 && probe.hasStyle === true);

  /* ---------- 4b. revision 门控的故障恢复与页签切换 ----------
   * 这两条不是锦上添花：revision 一旦提前记成「已处理」，一次短暂的 503
   * 就可能让页面永久停在旧数据；隐藏页签也可能带着旧版本直接露出来。 */
  await sleep(6000); // 先让首次 poll 对齐 revision，排除启动阶段的额外请求
  const appendProbeRow = (id, traceId) => {
    const tail = fs.readFileSync(LIVE_FILE, 'utf8').trim().split('\n').pop();
    const ts = Math.max(JSON.parse(tail).timestamp || 0, Date.now()) + 1000;
    fs.appendFileSync(
      LIVE_FILE,
      JSON.stringify({
        sessionId: 'live-session-0001',
        cwd: 'D:\\code\\live-demo',
        type: 'message',
        role: 'assistant',
        timestamp: ts,
        providerData: {
          messageId: id,
          conversationRequestId: `req-${id}`,
          model: 'live-model-flash',
          traceId,
          rawUsage: {
            prompt_tokens: 12000,
            completion_tokens: 120,
            total_tokens: 12120,
            prompt_cache_hit_tokens: 10000,
            prompt_cache_miss_tokens: 2000,
            credit: 0.12,
          },
        },
      }) + '\n',
    );
  };
  await ev(`(function(){
    window.__liveOriginalFetch=window.fetch;
    window.__liveOverviewAttempts=0;
    window.__liveFailOverviewOnce=true;
    window.fetch=function(u){
      var url=String((u&&u.url)||u);
      if(url.indexOf('/api/overview')>=0){
        window.__liveOverviewAttempts++;
        if(window.__liveFailOverviewOnce){
          window.__liveFailOverviewOnce=false;
          return Promise.resolve(new Response(JSON.stringify({error:'injected once'}),{
            status:503,headers:{'Content-Type':'application/json'}
          }));
        }
      }
      return window.__liveOriginalFetch.apply(this,arguments);
    };
  })()`);
  appendProbeRow('live-retry-mid-1', 'live-retry-turn-1');
  await sleep(12000); // 一拍失败 + 下一拍重试；旧实现第二拍会被 revision 直接跳过
  const retryAttempts = await ev('window.__liveOverviewAttempts');
  const retryError = await ev('document.querySelectorAll(".content > *")[0].querySelector(".empty")?.textContent || ""');
  check(
    '总览取数失败后，下一拍即使 revision 不变也会重试并恢复',
    retryAttempts >= 2 && !retryError,
    `attempts=${retryAttempts} error=${retryError}`,
  );
  await ev('window.fetch=window.__liveOriginalFetch;delete window.__liveOriginalFetch');

  await ev('document.querySelectorAll(".tab")[1].click()');
  appendProbeRow('live-tab-mid-1', 'live-tab-turn-1');
  await sleep(7000); // 在「会话」页接收一个新 revision，总览保持隐藏
  const expectedRequests = (await meta()).recordCount;
  await ev('document.querySelectorAll(".tab")[0].click()');
  await sleep(1200);
  const visibleRequests = await ev(
    'Number(document.querySelectorAll(".content > *")[0].querySelector(".kpi-value")?.textContent.replace(/,/g,""))',
  );
  check(
    '从其他页签切回总览时立即补齐最新 revision',
    visibleRequests === expectedRequests,
    `overview=${visibleRequests} meta=${expectedRequests}`,
  );

  /* ---------- 5. 打开会话抽屉，验证本轮卡片随 live 追加自动更新 ----------
   * 这一段验证的是「自动」：不点任何刷新按钮，只等服务端 1s 增量扫描 +
   * 前端 5s 静默轮询自己把新数据带进抽屉。 */
  await ev('document.querySelectorAll(".tab")[1].click()');
  await sleep(1500);
  const srow = 'document.querySelectorAll(".content > *")[1].querySelector("tbody tr.srow")';
  check('live 会话列表有行', await ev('!!' + srow));

  /* 第 9 步：抽屉首次取数失败的故障注入。此前只有代码审查，没有自动化断言。
     一次 503 后不能永久卡错误态；revision 未变也应靠 needsRetry 自动补拍。 */
  await ev(`(function(){
    window.__finalFaultOriginal=window.fetch;
    window.__finalFailSessionOnce=true;
    window.__finalSessionAttempts=0;
    window.fetch=function(u){
      var url=String((u&&u.url)||u);
      if(url.indexOf('/api/session')>=0){
        window.__finalSessionAttempts++;
        if(window.__finalFailSessionOnce){
          window.__finalFailSessionOnce=false;
          window.__finalFailUsed=true;
          return Promise.resolve(new Response(JSON.stringify({error:'drawer injected once'}),{
            status:503,headers:{'Content-Type':'application/json'}
          }));
        }
      }
      return window.__finalFaultOriginal.apply(this,arguments);
    };
  })()`);
  await ev(srow + '.click()');
  await sleep(1200);
  const firstFailUsed = await ev('window.__finalFailUsed===true');
  const firstError = await ev('!!document.querySelector(".drawer > .empty")');
  check('抽屉首次取数失败会显示错误态', firstFailUsed && firstError, `used=${firstFailUsed} error=${firstError}`);
  await sleep(6500);
  const faultAttempts = await ev('window.__finalSessionAttempts');
  const recovered = await ev(
    '!!document.querySelector(".drawer .turn-current") && !document.querySelector(".drawer > .empty")',
  );
  check('抽屉故障后 revision 不变也会自动重试并清除错误',
    recovered && faultAttempts >= 2,
    `attempts=${faultAttempts} recovered=${recovered}`,
  );
  await ev('window.fetch=window.__finalFaultOriginal;delete window.__finalFaultOriginal');
  consoleErrors.length = 0; // 故障注入刻意产生的一次 warning 已单独断言，不污染末尾检查

  await sleep(800);
  check('live 本轮卡片已渲染', await ev('!!document.querySelector(".drawer .turn-current")'));

  const readCard = () =>
    ev(`(function(){
      var c=document.querySelector(".drawer .turn-current");
      if(!c) return null;
      var m={};
      c.querySelectorAll(".turn-metric").forEach(function(e){
        m[e.getAttribute("data-k")]=e.querySelector("b").textContent.trim();
      });
      var p=document.querySelector(".drawer .turn-panel");
      return {
        metrics:m,
        rows:document.querySelectorAll(".drawer .turn-row").length,
        total:p ? Number(p.getAttribute("data-turn-total")) : -1,
        orphanTags:document.querySelectorAll(".drawer .turn-row .tag.warn").length,
        stateTags:[...document.querySelectorAll(".drawer .turn-current .tag")].map(function(e){return e.textContent.trim();})
      };
    })()`);

  const before = await readCard();
  check('本轮卡片读出 6 项指标', !!before && Object.keys(before.metrics).length === 6, JSON.stringify(before && before.metrics));
  check('缺失 traceId 的请求有独立状态标签', !!before && before.orphanTags > 0, '标签 ' + (before && before.orphanTags));
  check(
    '活跃轮次标为「活跃 · 最近更新」而非已结算',
    !!before && before.stateTags.some((x) => x.indexOf('活跃') >= 0),
    JSON.stringify(before && before.stateTags),
  );

  /* 第 9 步：最近活跃摘要条的 stale / error 分支故障注入。
     先关抽屉，让这一拍里 /api/session 只可能来自摘要条；故意打掉第一次，
     验证它保留上一拍数据、显示「不是实时」，且下一拍自动恢复。 */
  await ev('document.querySelector(".drawer .head .btn").click()');
  await sleep(600);
  await ev(`(function(){
    window.__activeFaultOriginal=window.fetch;
    window.__activeSessionAttempts=0;
    window.__activeFailStart=0;
    window.__activeFailUsed=false;
    window.fetch=function(u){
      var url=String((u&&u.url)||u);
      if(url.indexOf('/api/session')>=0){
        window.__activeSessionAttempts++;
        if(!window.__activeFailStart) window.__activeFailStart=Date.now();
        /* 同一目标可能有 watch 与 poll 两个并发 reload；只失败一次会被
           另一条成功响应立刻清掉 error，连 stale 都来不及渲染。这里把
           首次失败后的 1.2 秒都置为失败窗口，确保该拍确实进入失败态。 */
        if(Date.now()-window.__activeFailStart<1200){
          window.__activeFailUsed=true;
          return Promise.resolve(new Response(JSON.stringify({error:'active injected'}),{
            status:503,headers:{'Content-Type':'application/json'}
          }));
        }
      }
      return window.__activeFaultOriginal.apply(this,arguments);
    };
  })()`);
  appendProbeRow('live-active-fault-mid-1', 'live-active-fault-turn-1');
  let staleSeen = false;
  for (let i = 0; i < 40 && !staleSeen; i++) {
    await sleep(250);
    staleSeen = await ev(
      'window.__activeFailUsed===true && !!document.querySelector(".active-bar .as-stale")',
    );
  }
  const activeDiag = await ev(`JSON.stringify({
    used:window.__activeFailUsed,
    attempts:window.__activeSessionAttempts,
    stale:!!document.querySelector('.active-bar .as-stale'),
    empty:document.querySelector('.active-bar .as-empty')?.textContent.trim()||'',
    bar:(document.querySelector('.active-bar')?.textContent||'').slice(0,240)
  })`);
  check('最近活跃取数失败时保留上一拍并显示非实时标记', staleSeen, String(activeDiag));
  let activeRecovered = false;
  for (let i = 0; i < 40 && !activeRecovered; i++) {
    await sleep(250);
    activeRecovered = await ev(
      'window.__activeSessionAttempts>=2 && !document.querySelector(".active-bar .as-stale")',
    );
  }
  check('最近活跃摘要条在下一拍自动清除失败标记', activeRecovered, String(activeRecovered));
  await ev('window.fetch=window.__activeFaultOriginal;delete window.__activeFaultOriginal');
  consoleErrors.length = 0;
  check('摘要条故障恢复后会话行仍可点击', await ev('!!' + srow));
  await ev(srow + '.click()');
  await sleep(1200);
  check('摘要条故障恢复后抽屉仍可重新打开', await ev('!!document.querySelector(".drawer .turn-current")'));

  /* 直接往夹具文件尾部追加一轮。刻意不再跑 live-demo.js —— 它会 rmSync 整个
     .live 目录，把前面已经写入的 7 条记录抹掉。时间戳取「文件最后一行」与
     当前时钟的较大值，保证新轮排在最后、成为 latestTurn。 */
  const lastLine = fs.readFileSync(LIVE_FILE, 'utf8').trim().split('\n').pop();
  const lastTs = JSON.parse(lastLine).timestamp || Date.now();
  const extraTs = Math.max(lastTs, Date.now()) + 1000;
  const extraRows = [1, 2, 3].map((n) =>
    JSON.stringify({
      sessionId: 'live-session-0001',
      cwd: 'D:\\code\\live-demo',
      type: 'message',
      role: 'assistant',
      timestamp: extraTs + n * 1000,
      providerData: {
        messageId: `live-extra-mid-${n}`,
        conversationRequestId: `live-extra-req-${n}`,
        model: 'live-model-flash',
        traceId: 'live-extra-turn-0001',
        rawUsage: {
          prompt_tokens: 70000 + n * 1000,
          completion_tokens: 600 + n * 50,
          total_tokens: 70600 + n * 1050,
          prompt_cache_hit_tokens: 63000 + n * 900,
          prompt_cache_miss_tokens: 7000 + n * 100,
          credit: 3.21,
        },
      },
    }),
  );

  /* 再追加 60 个单请求轮次，把会话拉到 60+ 轮。
     这样「长会话不一次性渲染全部轮次 DOM」能在真实浏览器里被断言，
     而不只是靠 virtualWindow 的纯函数单测。10 万级压力留到第 8 步。 */
  for (let i = 1; i <= 60; i++) {
    extraRows.push(
      JSON.stringify({
        sessionId: 'live-session-0001',
        cwd: 'D:\\code\\live-demo',
        type: 'message',
        role: 'assistant',
        timestamp: extraTs + (3 + i) * 1000,
        providerData: {
          messageId: `live-bulk-mid-${i}`,
          conversationRequestId: `live-bulk-req-${i}`,
          model: 'live-model-flash',
          traceId: `live-bulk-turn-${String(i).padStart(3, '0')}`,
          rawUsage: {
            prompt_tokens: 20000 + i * 100,
            completion_tokens: 120 + i,
            total_tokens: 20120 + i * 101,
            prompt_cache_hit_tokens: 18000 + i * 90,
            prompt_cache_miss_tokens: 2000 + i * 10,
            credit: 0.77,
          },
        },
      }),
    );
  }
  fs.appendFileSync(LIVE_FILE, extraRows.join('\n') + '\n');

  await sleep(9000); // 1s 扫描 + 5s 轮询，留两拍余量
  const after = await readCard();
  check(
    '本轮 credit 随 live 追加自动更新',
    !!after && before.metrics.credit !== after.metrics.credit,
    (before && before.metrics.credit) + ' → ' + (after && after.metrics.credit),
  );
  check(
    '轮次总数随 live 追加自动增加',
    !!after && after.total > before.total,
    (before && before.total) + ' → ' + (after && after.total),
  );
  check(
    '长会话轮次 DOM 不随总轮数膨胀',
    !!after && after.total >= 60 && after.rows <= 30,
    '总 ' + (after && after.total) + ' 轮 / DOM ' + (after && after.rows) + ' 行',
  );
  check('刷新后抽屉没有进入错误/加载态', await ev('!document.querySelector(".drawer > .empty")'));
  check('刷新后本轮指标仍完整', !!after && Object.keys(after.metrics).length === 6);
  check('浏览器控制台无 error/warning', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (err) {
  fail++;
  console.error('[verify-live] 失败：', err.message);
  console.error(serverLogs.join('').trim());
} finally {
  await cleanup();
}

console.log(`\n════ 通过 ${pass} 项，失败 ${fail} 项 ════`);
process.exit(fail ? 1 : 0);
