/** 后端 API 封装 */
const BASE = '/api';

function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || v === 'all') continue;
    sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * 同一个 URL 的 GET 正在飞行时复用同一个 Promise。
 * 抽屉、最近活跃摘要条和当前视图可能在同一拍请求同一个 /api/session，
 * 去重后既省一次请求，也避免两个响应先后顺序不同造成数据回闪。
 */
const inflight = new Map();

/**
 * 正在飞行的 GET 数 + 累计发起数，供 whenIdle() 判断"这一波请求是否落地"。
 * 纯计数、不引入新依赖：
 *   - getStarted 能感知"刚发起就结束"的短请求（否则轮询间隙可能整段错过）；
 *   - activeGets 能感知"在途很久"的长请求（例如首次读历史时服务端要解析全量文件）。
 */
let activeGets = 0;
let getStarted = 0;

async function get(path, params) {
  const url = BASE + path + qs(params);
  const pendingJob = inflight.get(url);
  if (pendingJob) return pendingJob;
  getStarted++;
  activeGets++;
  const job = (async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `请求失败 ${res.status}`);
    }
    return res.json();
  })();
  inflight.set(url, job);
  try {
    return await job;
  } finally {
    inflight.delete(url);
    activeGets--;
  }
}

export const api = {
  meta: () => get('/meta'),
  overview: (f) => get('/overview', f),
  sessions: (f) => get('/sessions', f),
  session: (f) => get('/session', f),
  /**
   * 会话抽屉专用：显式声明轮次列表上限。
   * 后端 turnLimit 默认 200、上限 500；写在这里而不是散落在组件里，
   * 是为了让「抽屉最多拿多少轮」这件事只有一个地方可改。
   * turnLimit 放在展开之后，确保调用方无法顺手把它覆盖掉。
   */
  sessionDetail: (f) => get('/session', { ...f, turnLimit: 200 }),
  requests: (f) => get('/requests', f),
  refresh: async () => {
    // 先让刷新前的 GET 收尾，否则强制刷新后的重取可能复用到旧 in-flight 响应。
    await Promise.allSettled([...inflight.values()]);
    const res = await fetch(BASE + '/refresh', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `刷新失败 ${res.status}`);
    return body;
  },
  // 也挂一份到 api 上，调用方可写 api.whenIdle()；具名导出同时保留
  whenIdle,
};

/**
 * 等到"连续 quietMs 毫秒没有新的在途 GET"才 resolve。
 * 切到更宽档位后用来判断这一波视图请求是否已全部落地，再撤销加载提示。
 * 轮询检查 + 超时兜底（MAX_WAIT），不引入新依赖、不改变 get() 的复用语义。
 */
export function whenIdle(quietMs = 120) {
  return new Promise((resolve) => {
    const TICK = 30;
    const MAX_WAIT = 20000;
    const startedAt = Date.now();
    let quietSince = startedAt;
    let seen = getStarted;
    const check = () => {
      const now = Date.now();
      if (getStarted !== seen || activeGets > 0) {
        seen = getStarted;
        quietSince = now;
      }
      if (now - quietSince >= quietMs || now - startedAt >= MAX_WAIT) {
        resolve();
        return;
      }
      setTimeout(check, TICK);
    };
    setTimeout(check, TICK);
  });
}

/** 把筛选状态转成查询参数 */
export function toParams(filter) {
  const p = {
    from: filter.from || undefined,
    to: filter.to || undefined,
    projectId: filter.projectId,
    model: filter.model,
    kind: filter.kind,
    keyword: filter.keyword,
    granularity: filter.granularity,
  };
  return p;
}
