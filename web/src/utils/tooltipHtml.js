/**
 * ECharts tooltip 的 HTML 模板，集中放在这里有两个原因：
 *
 * 1. **可测试**：formatter 写在 .vue 的 <script setup> 里只能靠真实鼠标悬停验证，
 *    而 ECharts 是 canvas 渲染，触发坐标很脆弱。抽成纯函数后，恶意模型名／工具名／
 *    时间桶文本、marker 保留、固定样式与数值格式都能直接用 Node 断言覆盖。
 * 2. **不漏点**：所有"日志字符串 → HTML"的拼接只在这一处，新增 tooltip 时
 *    不会出现某个组件忘了转义。
 *
 * 规则：来自数据的字符串一律 esc()；p.marker 原样保留；<b>/<br/>/固定 style
 * 属于模板结构，不能动。
 */
import { esc } from './escapeHtml.js';
import {
  fmtNum,
  fmtCompact,
  fmtCredit,
  fmtPct,
  fmtSec,
  fmtTime,
  fmtSpeed,
} from './format.js';

/** 分隔线：固定样式，属于模板而不是数据 */
const DIV = '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee">';

/** 总览 · 用量趋势（堆叠柱 + credit 折线） */
export function trendTooltipHtml(bucket, points) {
  const hit = bucket.prompt ? bucket.cacheRead / bucket.prompt : 0;
  return `<b>${esc(bucket.key)}</b><br/>
          ${points
            .map((p) => `${p.marker} ${esc(p.seriesName)}：<b>${esc(fmtNum(p.value))}</b>`)
            .join('<br/>')}
          ${DIV}
          输入合计 ${esc(fmtNum(bucket.prompt))} ｜ 缓存命中率 <b>${esc(fmtPct(hit))}</b><br/>
          请求 <b>${esc(fmtNum(bucket.requests))}</b> 次 ｜ 结算 <b>${esc(fmtCredit(bucket.credit))}</b></div>`;
}

/** 总览 · 时间去向趋势 */
export function phaseTooltipHtml(bucket, points) {
  return `<b>${esc(bucket.key)}</b><br/>
          ${points
            .map((x) => `${x.marker} ${esc(x.seriesName)}：<b>${esc(fmtSec(x.value * 60000))}</b>`)
            .join('<br/>')}
          ${DIV}
          在岗合计 <b>${esc(fmtSec(bucket.activeMs))}</b> ｜ 离开 <b>${esc(fmtSec(bucket.awayMs))}</b></div>`;
}

/** 总览 · 模型分布（饼图） */
export function modelTooltipHtml(p, metricKey) {
  const d = p.data;
  const zero = metricKey === 'credit' && d.realCredit === 0;
  return `<b>${esc(p.name)}</b><br/>
          ${esc(fmtNum(d.req))} 次请求 ｜ ${esc(fmtCompact(d.total))} token<br/>
          结算 <b>${esc(fmtCredit(d.realCredit))}</b> credit
          <div style="color:#9aa3b0;margin-top:4px">${
            zero ? '该模型未产生 credit（免费/预览模型）' : `占本口径 ${esc(p.percent)}%`
          }</div>`;
}

/** 总览 · 工具调用分布 */
export function toolTooltipHtml(item, tm) {
  return `<b>${esc(item.name)}</b><br/>请求 ${esc(fmtNum(item.calls))} 次<br/>输入 ${esc(fmtCompact(item.prompt))} ｜ 输出 ${esc(fmtCompact(item.completion))}<br/>结算 ${esc(fmtCredit(item.credit))}${
    tm
      ? `${DIV}
                实测耗时 <b>${esc(fmtSec(tm.totalMs))}</b>（均值 ${esc(fmtSec(tm.avgMs))} ｜ 最长 ${esc(fmtSec(tm.maxMs))}）</div>`
      : ''
  }`;
}

/** 会话抽屉 · 上下文增长曲线（逐次请求） */
export function stepTooltipHtml(step, index) {
  return `<b>第 ${esc(fmtNum(index + 1))} 次请求</b> · ${esc(fmtTime(step.ts))}<br/>
          ${step.toolName ? '工具：<b>' + esc(step.toolName) + '</b><br/>' : ''}
          输入 <b>${esc(fmtNum(step.prompt))}</b>（命中 ${esc(fmtNum(step.cacheRead))}）<br/>
          输出 <b>${esc(fmtNum(step.completion))}</b>（思考 ${esc(fmtNum(step.reasoning))}）<br/>
          耗时 <b>${esc(fmtSec(step.durMs))}</b>${
            step.tps != null ? ` · 吐字 <b>${esc(fmtSpeed(step.tps))}</b> t/s` : ''
          }<br/>
          结算 <b>${esc(fmtCredit(step.credit))}</b>`;
}
