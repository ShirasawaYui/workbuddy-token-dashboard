/**
 * ECharts 的 tooltip.formatter 返回值是 **HTML 字符串**，不是 Vue 模板。
 *
 * 看板会把来自本地 JSONL 的模型名、工具名、时间桶 key 等字符串拼进去。
 * 这些字段目前不是攻击者可控的，但日志内容本身不该被当成可信 HTML：
 * 名字里带 `<img src=x onerror=...>` 就会在 tooltip 里变成真实元素。
 *
 * 这里只转义「插入值」，不转义整段模板 —— p.marker 是 ECharts 生成的
 * 合法 HTML 色块，<b> / <br/> / 固定 style 是模板自己的结构，
 * 粗暴地把整段结果转义会让 marker 与样式一起失效。
 */

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 把任意值安全地转成 HTML 文本；null/undefined 变成空串 */
export function escapeHtml(value) {
  if (value == null) return '';
  // 单次 replace + 回调：只处理原文中的字符，替换出来的 &amp; 不会被二次转义
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export const esc = escapeHtml;
