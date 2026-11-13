/**
 * 明细时间排序的共用口径。
 *
 * 两个位置必须完全一致：会话抽屉「逐次请求明细」、工作台「明细」版面。
 *  - 'desc' 时间逆序（最新在前），也是这两个位置的默认值；
 *  - 'asc'  时间正序（最早在前）。
 *
 * 抽成纯函数的理由不只是复用：抽屉那张表是定高虚拟窗口，还带「在完整明细中定位」
 * 与「第几次请求」的 # 序号，顺序一翻转就有三处下标要换算。集中在这里，
 * 单测能逐条钉死，不会各写一套慢慢漂移。
 *
 * 约定：入参数组按 ts 正序（后端 /api/session 的 steps、/api/requests 的 asc 结果）。
 */
export const DEFAULT_ORDER = 'desc';

/** 除 'asc' 外一律按逆序处理：老链接 / 未传参 / 异常值都安全落回默认 */
export function isDesc(order) {
  return order !== 'asc';
}

/** 点一次切换一次，正序 ↔ 逆序 */
export function nextOrder(order) {
  return isDesc(order) ? 'asc' : 'desc';
}

/** 返回按当前顺序排列的新数组，不改原数组（曲线还要用原始正序） */
export function orderedByTime(list, order) {
  const arr = Array.isArray(list) ? list : [];
  return isDesc(order) ? [...arr].reverse() : [...arr];
}

/** 原始下标（时间正序里的第几条）→ 显示下标，供轮次定位换算滚动位置 */
export function displayIndexOf(rawIndex, total, order) {
  return isDesc(order) ? total - 1 - rawIndex : rawIndex;
}

/** 显示下标 → 行首 #：始终表示「第几次请求」，与上下文曲线横轴 #N 同义，不随排序翻转 */
export function displaySeq(displayIndex, total, order) {
  return isDesc(order) ? total - displayIndex : displayIndex + 1;
}
