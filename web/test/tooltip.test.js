/**
 * tooltip HTML 转义的纯函数单测。
 *
 * 为什么不用浏览器触发 tooltip：ECharts 是 canvas 渲染，鼠标坐标触发很脆弱，
 * 断言"恶意名字有没有变成 DOM 元素"就成了概率测试。把模板抽成纯函数后，
 * 每个拼接点都能被确定性覆盖，包括 marker 必须原样保留这一条。
 *
 * 运行：npm run test:web（也由根 npm test 一并执行）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, esc } from '../src/utils/escapeHtml.js';
import {
  trendTooltipHtml,
  phaseTooltipHtml,
  modelTooltipHtml,
  toolTooltipHtml,
  stepTooltipHtml,
} from '../src/utils/tooltipHtml.js';

/** ECharts 自己生成的合法 HTML 色块，绝不能被转义 */
const MARKER = '<span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:#27618c"></span>';
const XSS_IMG = '<img src=x onerror="alert(1)">';
const XSS_SVG = "<svg onload='alert(2)'>";
const XSS_NAME = `model-${XSS_IMG}-${XSS_SVG}`;

/** 危险标签不得原样出现在结果里；模板自身的 <b>/<br/>/<div>/marker 不在检查范围 */
function assertNoRawTag(html, { expectEscaped = true } = {}) {
  assert.ok(!/<img\b/i.test(html), '不应出现未转义的 <img 标签');
  assert.ok(!/<svg\b/i.test(html), '不应出现未转义的 <svg 标签');
  assert.ok(!/<script\b/i.test(html), '不应出现未转义的 <script 标签');
  // 有恶意输入时必须按转义后的字面量显示，不能悄悄把整段丢掉
  if (expectEscaped) assert.ok(html.includes('&lt;'), '恶意文本应按转义后的字面量出现');
}

test('escapeHtml：五个危险字符与特殊值', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(1234.5), '1234.5');
  assert.equal(escapeHtml(false), 'false');
  // 一次性替换：输入里已有实体时不会被二次转义成 &amp;amp;
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(esc, escapeHtml, 'esc 是同一函数的别名');
});

test('escapeHtml：数字格式化结果不受影响', () => {
  assert.ok(!/[<>&"']/.test(escapeHtml('1,234,567')));
  assert.equal(escapeHtml('1,234,567'), '1,234,567');
  assert.equal(escapeHtml('46.2%'), '46.2%');
});

test('趋势 tooltip：时间桶与 seriesName 转义、marker 与固定样式保留', () => {
  const bucket = {
    key: `2026-11-12 ${XSS_IMG}`,
    prompt: 1234567,
    cacheRead: 1000000,
    requests: 42,
    credit: 3.5,
  };
  const points = [
    { marker: MARKER, seriesName: `缓存命中输入 ${XSS_SVG}`, value: 1000000 },
    { marker: MARKER, seriesName: '结算 (credit)', value: 3.5 },
  ];
  const html = trendTooltipHtml(bucket, points);
  assertNoRawTag(html);
  assert.ok(html.includes(MARKER), 'marker 必须原样保留');
  assert.ok(html.includes('<b>') && html.includes('<br/>'), '固定模板标签保留');
  assert.ok(html.includes('border-top:1px solid #eee'), '固定样式保留');
  assert.ok(html.includes('1,234,567'), '数值格式化结果保留');
  assert.ok(html.includes('81.0%'), '缓存命中率按原口径计算');
  assert.ok(html.includes('42'), '请求数保留');
});

test('时间去向 tooltip：时间桶与 seriesName 转义', () => {
  const html = phaseTooltipHtml(
    { key: XSS_IMG, activeMs: 123456, awayMs: 789 },
    [{ marker: MARKER, seriesName: XSS_SVG, value: 5 }],
  );
  assertNoRawTag(html);
  assert.ok(html.includes(MARKER));
  assert.ok(html.includes('border-top:1px solid #eee'));
  assert.ok(html.includes('在岗合计') && html.includes('离开'));
});

test('模型分布 tooltip：恶意模型名只按文本显示', () => {
  const p = {
    name: XSS_NAME,
    percent: 33.3,
    data: { req: 12, total: 98765, realCredit: 2.5 },
  };
  const html = modelTooltipHtml(p, 'credit');
  assertNoRawTag(html);
  assert.ok(html.includes('占本口径 33.3%'), '数值口径不回归');
  assert.ok(html.includes('98.8K'), 'token 压缩格式不回归');
  assert.ok(html.includes('<div style="color:#9aa3b0;margin-top:4px">'), '固定样式保留');

  const zero = modelTooltipHtml(
    { name: XSS_IMG, percent: 0, data: { req: 1, total: 10, realCredit: 0 } },
    'credit',
  );
  assertNoRawTag(zero);
  assert.ok(zero.includes('该模型未产生 credit'), '零 credit 分支保留');
});

test('工具分布 tooltip：恶意工具名与耗时分支', () => {
  const item = { name: `${XSS_IMG}-Bash`, calls: 7, prompt: 12345, completion: 678, credit: 0.5 };
  const withTime = toolTooltipHtml(item, { totalMs: 3000, avgMs: 500, maxMs: 1200 });
  assertNoRawTag(withTime);
  assert.ok(withTime.includes('3.0s') && withTime.includes('500ms'), '耗时格式不回归');
  assert.ok(withTime.includes('border-top:1px solid #eee'));

  const noTime = toolTooltipHtml(item, null);
  assertNoRawTag(noTime);
  assert.ok(!noTime.includes('实测耗时'), '无耗时数据时不渲染该段');
});

test('会话抽屉 tooltip：工具名转义、无工具/无速度分支', () => {
  const step = {
    ts: new Date(2026, 10, 12, 9, 30, 0).getTime(),
    toolName: `${XSS_SVG}-Read`,
    prompt: 1000,
    completion: 200,
    cacheRead: 800,
    reasoning: 10,
    durMs: 3400,
    tps: 31.5,
    credit: 0.25,
  };
  const html = stepTooltipHtml(step, 0);
  assertNoRawTag(html);
  assert.ok(html.includes('第 1 次请求'));
  assert.ok(html.includes('31.5'), '吐字速度不回归');
  assert.ok(html.includes('1,000') && html.includes('0.250'), '数值格式不回归');

  const plain = stepTooltipHtml({ ...step, toolName: null, tps: null }, 8);
  assertNoRawTag(plain, { expectEscaped: false });
  assert.ok(!plain.includes('alert'), '无工具名时不应残留任何恶意片段');
  assert.ok(plain.includes('第 9 次请求'));
  assert.ok(!plain.includes('工具：'), '无工具名时不渲染工具段');
  assert.ok(!plain.includes('吐字'), '无速度时不渲染吐字段');
});

test('所有模板：marker 不被转义，而同名文本被转义', () => {
  const html = trendTooltipHtml(
    { key: XSS_IMG, prompt: 10, cacheRead: 5, requests: 1, credit: 0 },
    [{ marker: MARKER, seriesName: XSS_IMG, value: 10 }],
  );
  // 同一段恶意文本：作为数据被转义，作为 marker 原样保留
  assert.ok(html.includes(MARKER));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
});
