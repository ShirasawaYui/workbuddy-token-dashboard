/**
 * 重新生成 README 用截图：CDP 驱动无头浏览器，逐个视图 / 交互状态截图，
 * 直接覆盖 docs/screenshots/ 下的同名文件。
 *
 * 与 tools/e2e-verify.js 的区别：e2e 关注「断言对不对」，这里关注「图好不好看」——
 *   - deviceScaleFactor=2，README 在 retina 屏上不发虚
 *   - 每次截图前等图表动画与数据加载彻底结束
 *   - 数据源是 scripts/demo.js 生成的合成数据（截图不能暴露真实用量）
 *
 * 阶段 2 改版后重截为 6 张：
 *   01-overview-light / 02-overview-dark / 03-sessions /
 *   04-session-detail / 05-requests / 06-narrow
 * 页面默认档位已改成「今天」（demo 里只有 44 条），所以必须先按文本切「全部」，
 * 否则截出来是空荡荡的图表。暗色图点侧栏 .theme-btn 切换，截完切回亮色。
 *
 * 前置：演示服务已启动（npm run demo 或手动 WORKBUDDY_HOME=<demo> node server/src/index.js）
 * 运行：BASE_URL=http://127.0.0.1:5199 node tools/screenshots.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CDP_PORT = Number(process.env.CDP_PORT || 9300 + Math.floor(Math.random() * 600));
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5199';
const HOST = new URL(BASE_URL).host;
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

/** 本版 README 只引用这 6 张；成功生成后清掉其它历史 PNG */
const SHOTS = [
  '01-overview-light.png',
  '02-overview-dark.png',
  '03-sessions.png',
  '04-session-detail.png',
  '05-requests.png',
  '06-narrow.png',
];

const BROWSER_CANDIDATES = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const BROWSER = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.error('找不到浏览器，请用 BROWSER=<可执行文件路径> 指定');
  process.exit(1);
}

/** 截图统一参数：宽 × 高为 CSS 像素，dsf=2 输出两倍分辨率 */
const VIEW = { width: 1560, height: 1020, dsf: 2 };
/** 阶段 2 的窄屏断点是 1180px，1150px 会折成「顶栏 + 内容」上下结构 */
const NARROW = { width: 1150, height: 1500, dsf: 2 };

/**
 * 浏览器 profile 放系统临时目录，不放 .cache/。
 * 它不是项目产物；而且 Windows 上 Chromium 退出后句柄还要释放一会儿，删除经常失败 ——
 * 留在 .cache/ 里失败一次就是 57MB，实测那边攒到过 743MB。
 */
const PROFILE_PREFIX = 'wb-shots-profile-';
const PROFILE_DIR = path.join(os.tmpdir(), PROFILE_PREFIX + CDP_PORT);

/** 清掉一小时前的遗留 profile：并发运行时另一个进程的 profile 一直有写入，不会被误删 */
function sweepStaleProfiles() {
  let names = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(dir).mtimeMs > cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
      n++;
    } catch {
      /* 还被锁着就留给下次 */
    }
  }
  if (n) console.log('顺便清掉 ' + n + ' 个遗留的浏览器 profile');
}
sweepStaleProfiles();
const proc = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + PROFILE_DIR,
    `--window-size=${VIEW.width},${VIEW.height}`,
    BASE_URL + '/',
  ],
  { stdio: 'ignore' },
);
const cleanup = async () => {
  /* Windows 上 proc.kill() 只杀主进程，Edge 的渲染/GPU 子进程还活着、还占着
     profile 里的文件 —— 必须连子进程一起杀（taskkill /T），否则后面的 rm 必然失败。 */
  if (proc.pid) {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* 进程可能已经退了 */
      }
    } else {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
    }
  }
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
      return;
    } catch {
      /* 句柄还没释放完，再试 */
    }
  }
  console.log('提示：本次的浏览器 profile 没能删干净（在系统临时目录），下次运行会扫掉');
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(1000);
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      target = list.find((x) => x.type === 'page' && x.url.includes(HOST));
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error('未找到可调试的页面 target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
  ws.addEventListener('message', (e) => {
    const o = JSON.parse(e.data);
    if (o.id && pending.has(o.id)) {
      pending.get(o.id)(o.result);
      pending.delete(o.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'THREW: ' + (r.exceptionDetails.exception?.description || '');
    return r.result ? r.result.value : undefined;
  };
  const setView = (v) =>
    send('Emulation.setDeviceMetricsOverride', {
      width: v.width,
      height: v.height,
      deviceScaleFactor: v.dsf,
      mobile: false,
    });
  const written = [];
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
    written.push(name);
    console.log('  ' + name + '  ' + Math.round(fs.statSync(p).size / 1024) + ' KB');
  };
  const top = () => ev('window.scrollTo(0, 0)');
  /** 等到条件成立（最多 maxMs），避免截图截到半加载状态 */
  const until = async (expr, maxMs = 15000) => {
    for (let i = 0; i < maxMs / 300; i++) {
      if ((await ev(expr)) === true) return true;
      await sleep(300);
    }
    return false;
  };
  const V = (i) => `document.querySelectorAll(".content > *")[${i}]`;

  // ---------- 初始化：切「全部」，否则默认「今天」只有 44 条 ----------
  console.log('【初始化】');
  // 只给 --window-size 不够：CDP 截图按实际视口走，不显式覆盖就只有 1x，
  // retina 下 README 会发虚。窄屏那张也是靠 setView 才拿到 dsf=2。
  await setView(VIEW);
  await until(`document.querySelectorAll(".tab").length === 3`);
  await ev(`[...document.querySelectorAll(".fb-row .seg-btn")].find(function(b){return b.textContent.trim()==="全部";}).click()`);
  await until(`${V(0)}.querySelectorAll(".kpi").length === 6`);
  await until(`[...document.querySelectorAll(".content canvas")].filter(function(c){return c.offsetWidth>0;}).length >= 3`);
  await sleep(2600); // 等 ECharts 动画与切档后的取数收尾

  // ---------- 1. 暖砂亮色总览 ----------
  console.log('【亮色总览】');
  await top();
  await sleep(400);
  await shot('01-overview-light.png');

  // ---------- 2. 深焙暗色总览（同一视角） ----------
  console.log('【暗色总览】');
  await ev(`document.querySelector(".theme-btn").click()`);
  await sleep(1400);
  await top();
  await shot('02-overview-dark.png');
  await ev(`document.querySelector(".theme-btn").click()`);
  await sleep(900);

  // ---------- 3. 会话列表 ----------
  console.log('【会话列表】');
  await ev('document.querySelectorAll(".tab")[1].click()');
  await until(`${V(1)}.querySelectorAll("tbody tr.srow").length > 0`);
  await sleep(1800);
  await shot('03-sessions.png');

  // ---------- 4. 会话详情抽屉 ----------
  console.log('【会话详情】');
  await ev(`${V(1)}.querySelector("tbody tr.srow").click()`);
  await until(`!!document.querySelector(".drawer")`);
  await until(`document.querySelectorAll(".drawer canvas").length === 1`);
  await sleep(2400);
  // 滚到 KPI / 上下文增长曲线一带，比抽屉首屏信息密度更高
  await ev('var d=document.querySelector(".drawer .body"); if(d) d.scrollTop = 700;');
  await sleep(700);
  await shot('04-session-detail.png');
  // 阶段 2 后抽屉里有多处 .btn，关闭必须锁定 head
  await ev('document.querySelector(".drawer .head .btn").click()');
  await sleep(800);

  // ---------- 5. 请求明细（展开首行看耗时推导） ----------
  console.log('【请求明细】');
  await ev('document.querySelectorAll(".tab")[2].click()');
  await until(`${V(2)}.querySelectorAll("tbody tr").length >= 50`);
  await sleep(1500);
  await ev(`${V(2)}.querySelector("tbody tr").click()`);
  await until(`!!document.querySelector(".detail")`);
  await sleep(600);
  await shot('05-requests.png');

  // ---------- 6. 窄屏 ----------
  console.log('【窄屏】');
  await ev('document.querySelectorAll(".tab")[0].click()');
  await sleep(1600);
  await setView(NARROW);
  await sleep(1600);
  await top();
  await sleep(500);
  await shot('06-narrow.png');
  await setView(VIEW);

  // 只有在 6 张全部成功生成后才清理历史截图，避免失败时留下断链
  if (written.length === SHOTS.length) {
    let removed = 0;
    for (const name of fs.readdirSync(OUT_DIR)) {
      if (!name.endsWith('.png') || SHOTS.includes(name)) continue;
      fs.rmSync(path.join(OUT_DIR, name));
      removed++;
    }
    if (removed) console.log('清理历史截图 ' + removed + ' 张');
  }

  console.log('完成：' + OUT_DIR + '（' + written.length + ' 张）');
  ws.close();
  await cleanup();
  process.exit(0);
})().catch(async (e) => {
  console.error('截图失败: ' + e.message);
  await cleanup();
  process.exit(1);
});
