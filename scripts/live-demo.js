/**
 * 实时追加调试夹具（live-append demo）。
 *
 * 与 scripts/demo.js 的区别：那份是一次性生成 3 项目 / 10 会话的静态快照，
 * 用来截图和回归；这份只维护**一个会话**，按节拍持续往 JSONL 尾部追加，
 * 专门复现"边写边读"的真实场景：
 *
 *   - 一次用户提问（一轮）对应 3 次模型请求，共享同一个 traceId；
 *   - 每批只追加 1 次请求，所以能观察到"同一轮多次请求逐步出现"；
 *   - 中间夹 function_call / function_call_result，验证工具耗时配对；
 *   - 每轮结束换 traceId（下一轮 user 消息）；
 *   - 每隔几批额外插一条**缺失 traceId** 的用量行，供轮次兜底逻辑测试；
 *   - 模型名、工具名、会话标题故意带 HTML 特殊字符，用来验证 tooltip 转义。
 *
 * 数据全部是合成的，写在 .live/（已加进 .gitignore），不读取真实会话。
 *
 * 用法：
 *   npm run demo:live                       重置 + 启动服务 + 持续追加
 *   node scripts/live-demo.js --gen        只重置生成初始两行
 *   node scripts/live-demo.js --no-serve --steps=6 --interval=600
 *                                          不启服务，追加 6 批后退出（自动化用）
 *   node scripts/live-demo.js --half-line  每批拆成半行写入，验证 scanner 半行等待
 *
 * 环境变量：PORT、SCAN_INTERVAL_MS、LIVE_INTERVAL_MS
 * 服务默认只监听 127.0.0.1（见 server/src/config.js），数据源固定为 .live/workbuddy。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, '.live', 'workbuddy');
const PROJECT = 'd-code-livedemo';
const SESSION_ID = 'live-session-0001';
const FILE = path.join(OUT, 'projects', PROJECT, `${SESSION_ID}.jsonl`);
const CWD = 'D:\\code\\live-demo';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
function opt(name, def) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
}

const intervalMs = Number(process.env.LIVE_INTERVAL_MS) || opt('interval', 1500);
const maxSteps = opt('steps', Infinity);
const halfLine = flag('--half-line') || process.env.LIVE_HALF_LINE === '1';
const noServe = flag('--no-serve');
const onlyGen = flag('--gen');
const shouldServe = !onlyGen && !noServe && maxSteps === Infinity;
const port = Number(process.env.PORT || 5178);

/* ---------------- 确定性随机与 ID ---------------- */

let seed = 20261112;
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const int = (min, max) => Math.floor(min + rnd() * (max - min + 1));
const hex = (n) =>
  Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');

/* 故意混入 HTML 特殊字符：验证"日志里的名字只按文本显示" */
const MODELS = ['live-model-flash', 'live-model-<img src=x onerror=alert(1)>'];
const TOOLS = ['Bash', 'Read', 'Edit', 'Grep<svg onload=alert(2)>'];
const TITLE = '实时调试会话 <img src=x onerror=alert(1)>';

let t = Date.now();
let seq = 0; // messageId 序号
let callSeq = 0;
let turn = 0;
let inTurn = 0; // 本轮已追加的请求数（每轮 3 次）
let traceId = hex(16);
let batches = 0;
let emittedRequests = 0;

function ts() {
  t += int(1200, 3200);
  return t;
}

function line(o) {
  return JSON.stringify({ sessionId: SESSION_ID, cwd: CWD, ...o });
}

/** 一条带用量的模型请求：messageId 全局唯一，是"一次请求"的主键 */
function usageLine({ model, isFinal, noTrace }) {
  const messageId = `live-mid-${String(++seq).padStart(4, '0')}`;
  const prompt = 40000 + seq * 3000;
  const hit = Math.round(prompt * 0.9);
  const completion = 200 + seq * 37;
  const rawUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: prompt - hit,
    credit: Number((0.02 + (prompt - hit) * 8e-6 + completion * 2.2e-5).toFixed(2)),
  };
  const pd = {
    messageId,
    conversationRequestId: `live-req-${seq}`,
    model,
    rawUsage,
  };
  // 缺失 traceId 的样本：不能把所有空值合并成一轮
  if (!noTrace) pd.traceId = traceId;
  emittedRequests++;
  return pd;
}

/** 追加一批 = 一次模型请求（含工具调用与返回），同轮共享 traceId */
function emitBatch() {
  const out = [];
  if (inTurn === 0) {
    turn += 1;
    traceId = hex(16);
    out.push(
      line({
        type: 'message',
        role: 'user',
        timestamp: ts(),
        message: { text: `第 ${turn} 轮：请继续` },
      }),
    );
  }

  const model = MODELS[(seq + turn) % MODELS.length];
  const isFinal = inTurn === 2;
  const pd = usageLine({ model, isFinal });
  const stamp = ts();

  if (isFinal) {
    // 最终回答：message / assistant 行承担用量
    out.push(line({ type: 'message', role: 'assistant', timestamp: stamp, providerData: pd }));
  } else {
    const callId = `live-call-${String(++callSeq).padStart(4, '0')}`;
    const toolName = TOOLS[(callSeq + turn) % TOOLS.length];
    out.push(
      line({ type: 'function_call', timestamp: stamp, callId, name: toolName, providerData: pd }),
    );
    out.push(
      line({ type: 'function_call_result', timestamp: ts(), callId, name: toolName }),
    );
  }

  inTurn += 1;
  if (inTurn >= 3) inTurn = 0;

  // 每 5 批插一条无 traceId 的孤立请求，供第 5 步的兜底口径使用
  if (batches > 0 && batches % 5 === 0) {
    const orphan = usageLine({ model: MODELS[0], isFinal: true, noTrace: true });
    out.push(
      line({ type: 'message', role: 'assistant', timestamp: ts(), providerData: orphan }),
    );
  }

  batches += 1;
  return { out, trace: traceId, turn, inTurn, requests: emittedRequests };
}

/** 半行写入：让扫描器有机会看到"只写了一半"的状态 */
function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}
function appendLines(lines) {
  const text = lines.join('\n') + '\n';
  if (!halfLine) {
    fs.appendFileSync(FILE, text);
    return;
  }
  const cut = Math.floor(text.length / 2);
  fs.appendFileSync(FILE, text.slice(0, cut));
  sleepSync(80);
  fs.appendFileSync(FILE, text.slice(cut));
}

/** 夹具自检：直接读回 JSONL，按 traceId 统计每轮的请求数 */
function selfCheck() {
  const rows = fs
    .readFileSync(FILE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.providerData && r.providerData.rawUsage);
  const groups = {};
  for (const r of rows) {
    const k = r.providerData.traceId || '(缺失 traceId)';
    groups[k] = (groups[k] || 0) + 1;
  }
  console.log(
    '[live] 夹具自检：' +
      JSON.stringify({ 请求数: rows.length, 轮次数: Object.keys(groups).length, 分组: groups }),
  );
}

/* ---------------- 入口 ---------------- */

fs.rmSync(path.join(root, '.live'), { recursive: true, force: true });
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(
  FILE,
  [
    line({ type: 'session-meta', timestamp: t }),
    line({ type: 'ai-title', timestamp: t, aiTitle: TITLE }),
  ].join('\n') + '\n',
);
console.log(`[live] 已重置：${FILE}`);
console.log(`[live] 每轮 3 次请求；每批追加 1 次；间隔 ${intervalMs}ms；半行模拟 ${halfLine ? '开' : '关'}`);

if (onlyGen) {
  selfCheck();
  process.exit(0);
}

let child = null;
if (shouldServe) {
  if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
    console.error('还没有前端构建产物，请先执行：npm run build');
    process.exit(1);
  }
  child = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], {
    stdio: 'inherit',
    env: { ...process.env, WORKBUDDY_HOME: OUT, PORT: String(port) },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  console.log(`[live] 看板地址：http://127.0.0.1:${port}  （Ctrl+C 退出）`);
} else {
  console.log('[live] 未启动服务：请另开一个终端，把 WORKBUDDY_HOME 指向 .live/workbuddy 后启动解析服务');
}

let timer = null;
function stop() {
  if (timer) clearTimeout(timer);
  selfCheck();
  if (child) child.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function tick() {
  const { out, turn: turnNo, inTurn: nth, trace } = emitBatch();
  appendLines(out);
  console.log(
    `[live] 第 ${turnNo} 轮 / 本轮第 ${nth || 3} 次 / trace=${trace} / 累计 ${emittedRequests} 条请求`,
  );
  if (batches >= maxSteps) {
    stop();
    return;
  }
  timer = setTimeout(tick, intervalMs);
}
timer = setTimeout(tick, shouldServe ? 1200 : 0);
