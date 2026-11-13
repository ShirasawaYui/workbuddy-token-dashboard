import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 定位 WorkBuddy 数据目录。
 * 优先级：环境变量 WORKBUDDY_HOME > ~/.workbuddy
 * 校验条件：目录下存在 projects/ 子目录
 */
function resolveHome() {
  const candidates = [
    process.env.WORKBUDDY_HOME,
    path.join(os.homedir(), '.workbuddy'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'projects')).isDirectory()) return dir;
    } catch {
      /* 忽略，尝试下一个 */
    }
  }
  // 兜底返回默认路径，让上层报错更直观
  return path.join(os.homedir(), '.workbuddy');
}

export const HOME = resolveHome();
export const PROJECTS_DIR = path.join(HOME, 'projects');

export const PORT = Number(process.env.PORT || 5178);

/**
 * 默认只绑定 IPv4 回环，局域网与其他网卡都连不上。
 *
 * 为什么不用 `localhost` 当监听地址：本机 DNS 会把 localhost 优先解析成 ::1，
 * 只绑 IPv4 时 Vite proxy / 浏览器走 ::1 会直接连不上。所以相关地址统一
 * 显式写成 127.0.0.1（见 web/vite.config.js、scripts/demo.js、tools/e2e-verify.js、
 * server/test/reconcile.js、tools/screenshots.js）。
 *
 * HOST 允许显式覆盖（例如 HOST=::1），但设成 0.0.0.0 等于主动放开到局域网，
 * 需自行承担后果；正常情况下没有理由改它。
 */
export const HOST = process.env.HOST || '127.0.0.1';

/** Vite 开发服务器端口，仅用于生成默认 CORS 白名单 */
const DEV_PORT = Number(process.env.DEV_PORT || 5177);

/**
 * 后台自动增量扫描间隔。
 * JSONL 是追加写的，扫描只读新增尾巴、未变化的文件直接跳过，所以 5s 一次成本很低。
 * 想调松/调紧用 SCAN_INTERVAL_MS 环境变量，不用改代码。
 */
export const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 5_000);

/**
 * 阶段 1：冷启动只完整加载「近 N 天有写入」的文件，其余冷文件只登记 stat 指纹。
 * FORCE_FULL_LOAD=1 一键回退到第一阶段的全量路径（回归夹具 / 排障用），
 * 不改任何硬断言数字。索引损坏或版本不符时也会自动走这条路。
 */
export const FORCE_FULL_LOAD = process.env.FORCE_FULL_LOAD === '1';
export const COLD_START_HOT_DAYS = Number(process.env.HOT_DAYS || 7);

/**
 * 允许跨域读取 /api 的来源。
 *
 * 默认只有回环地址上的生产服务与 Vite dev server。生产模式前端与 API 同源
 * （同一个 Node 进程托管 web/dist），本来不需要 CORS；这条通道是给 5177 的
 * dev server 直连 5178 的场景留的。
 *
 * CORS_ORIGIN 可追加逗号分隔的白名单；只有显式写 `CORS_ORIGIN=*` 才恢复
 * 旧版的任意来源放行。
 */
const extraOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const CORS_ALLOW_ALL = extraOrigins.includes('*');
export const CORS_ORIGINS = new Set([
  ...[PORT, DEV_PORT].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]),
  ...extraOrigins.filter((o) => o !== '*'),
]);

/** 依据请求 Origin 回显 ACAO；不在白名单时返回 null（不下发该头，浏览器自行拦截） */
export function corsAllowOrigin(origin) {
  if (!origin) return null; // 同源请求不需要 CORS
  if (CORS_ALLOW_ALL) return '*';
  return CORS_ORIGINS.has(origin) ? origin : null;
}

/**
 * Host 头白名单：仅绑回环也挡不住 DNS rebinding
 * （恶意域名解析到 127.0.0.1，但 Host 头是攻击者的域名）。
 * 拒绝非本机主机名是最便宜的一层防护。
 * HOST_ALLOWLIST 可追加逗号分隔的主机名，供特殊本地反代场景使用。
 */
const extraHosts = String(process.env.HOST_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', ...extraHosts]);

export function isAllowedHost(hostHeader) {
  if (!hostHeader) return true; // HTTP/1.0 可以没有 Host，回环直连放行
  const h = String(hostHeader).toLowerCase();
  // IPv6 形如 [::1]:5178，普通 Host 形如 localhost:5178
  const name = h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.split(':')[0];
  return ALLOWED_HOSTS.has(name);
}

/**
 * 项目目录名还原为可读路径。
 * WorkBuddy 把 cwd 编码成 d-CODE-MyApp 这种形式。
 * 注意：cwd 字段本身有真值时优先用真值，这里只是兜底展示。
 */
export function decodeProjectDir(dirName) {
  const m = /^([a-zA-Z])-(.*)$/.exec(dirName);
  if (!m) return dirName;
  return `${m[1].toLowerCase()}:\\${m[2].replace(/-/g, '\\')}`;
}

/** 结算计价单位名称，WorkBuddy 用量里叫 credit */
export const CREDIT_UNIT = 'credit';
