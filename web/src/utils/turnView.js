/**
 * 会话轮次视图的纯函数层（不依赖 Vue / DOM，可直接单测）。
 *
 * 为什么单独抽一层：轮次卡片有四种状态（活跃 / 空数据 / 未归属 / 刷新失败），
 * 还有命中率分母为 0、长会话窗口裁剪这些边界。把它们留在模板里就只能靠人眼
 * 点开抽屉看，抽成纯函数后才能被自动化断言覆盖。
 */

/** 活跃判定窗口：与服务端 sessions.active 的「最近 5 分钟有调用」保持同一口径 */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 一轮是否活跃。
 *
 * 刻意用绝对值：live 夹具的时间戳是按固定步长累加出来的，会比真实时钟快几十秒；
 * 真实日志也可能因本机时钟调整略有偏差。无论超前还是滞后，只要落在 5 分钟内
 * 都算「最近更新」，但**不**据此断言该轮已结算 —— 界面只显示「活跃／最近更新」。
 */
export function isActiveTurn(turn, now = Date.now(), windowMs = ACTIVE_WINDOW_MS) {
  if (!turn || !Number.isFinite(turn.lastTs)) return false;
  return Math.abs(now - turn.lastTs) <= windowMs;
}

/** 命中率：没有输入时显示破折号，不把「无数据」伪装成 0% */
export function hitRateText(turn) {
  if (!turn || !turn.prompt || !Number.isFinite(turn.cacheRead)) return '—';
  const v = Math.max(0, Math.min(1, turn.cacheRead / turn.prompt));
  return (v * 100).toFixed(1) + '%';
}

/** 轮次标签。缺失 traceId 的请求各自独立成轮，不能叫「第 N 轮」 */
export function turnLabel(turn, index) {
  if (!turn) return '—';
  if (turn.isOrphan) return '未归属请求';
  return `第 ${index + 1} 轮`;
}

/** 按 turnKey 取这一轮的请求，保持 steps 原有的时间顺序 */
export function stepsOfTurn(steps, turnKey) {
  if (!turnKey) return [];
  return (steps || []).filter((r) => r.turnKey === turnKey);
}

/**
 * 定高虚拟列表的可见窗口。
 *
 * 长会话可能有几百轮，全量铺 DOM 会让 5 秒一次的静默刷新整表重绘。
 * 只渲染视口内 +/- overscan 行，上下用占位行撑出滚动高度。
 * 返回的 padTop / padBottom 单位是 px，行高必须严格等于 rowH。
 */
export function virtualWindow(total, scrollTop = 0, viewH = 300, rowH = 38, overscan = 6) {
  const n = Math.max(0, Math.floor(total) || 0);
  const h = Math.max(rowH, viewH || rowH);
  const top = Math.max(0, scrollTop || 0);
  const start = Math.max(0, Math.min(n, Math.floor(top / rowH) - overscan));
  const end = Math.max(start, Math.min(n, Math.ceil((top + h) / rowH) + overscan));
  return {
    start,
    end,
    padTop: start * rowH,
    padBottom: Math.max(0, (n - end) * rowH),
  };
}

/**
 * 本轮卡片的整体状态。
 * status: loading（首次取数） / empty（会话无轮次） / ok
 */
export function turnCardState(data, now = Date.now()) {
  if (!data) return { status: 'loading' };
  const turns = data.turns || [];
  const turnSummary = data.turnSummary || {};
  const latestTurn = data.latestTurn || null;
  if (!latestTurn || !turns.length) {
    return { status: 'empty', orphanTurns: turnSummary.orphanTurns || 0 };
  }
  return {
    status: 'ok',
    turn: latestTurn,
    label: turnLabel(latestTurn, (data.turnTotal || turns.length) - 1),
    active: isActiveTurn(latestTurn, now),
    orphanTurns: turnSummary.orphanTurns || 0,
  };
}
