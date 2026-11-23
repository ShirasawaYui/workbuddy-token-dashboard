<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api.js';
import { useChart, theme, baseTooltip, baseAxisLabel } from '../composables/useChart.js';
import { fmtCompact, fmtNum, fmtCredit, fmtPct, fmtTime, fmtSec, fmtSpeed } from '../utils/format.js';
import { stepTooltipHtml } from '../utils/tooltipHtml.js';
import KpiCard from './KpiCard.vue';
import PhaseBar from './PhaseBar.vue';
import TurnPanel from './TurnPanel.vue';
import SortTag from './SortTag.vue';
import {
  DEFAULT_ORDER,
  nextOrder,
  orderedByTime,
  displayIndexOf,
  displaySeq,
} from '../utils/sortOrder.js';

const props = defineProps({ sessionId: String });
const emit = defineEmits(['close']);

const data = ref(null);
const error = ref('');
/** 静默刷新失败：保留上一拍数据，但轮次卡片要把「不是实时」明说 */
const stale = ref(false);

let sessionVersion = 0;
watch(
  () => props.sessionId,
  async (id) => {
    sessionVersion += 1;
    data.value = null;
    error.value = '';
    stale.value = false;
    if (id) await silentReload();
  },
  { immediate: true },
);

/**
 * 供 App 的自动刷新调用：只换数据，**不**把 data 置空——
 * 否则每 5 秒抽屉会闪一下空态。出错也保持上一拍的内容，
 * 一次网络抖动不该把整个抽屉清掉。
 *
 * 同 URL 的网络去重由 api.js 负责；这里的版本号负责另一件事：
 * 用户切换会话后，较慢的旧会话响应绝不能盖掉新会话。
 */
async function silentReload() {
  const id = props.sessionId;
  if (!id) return true;
  const version = sessionVersion;
  try {
    const next = await api.sessionDetail({ sessionId: id });
    if (version !== sessionVersion || props.sessionId !== id) return false;
    data.value = next;
    stale.value = false;
    error.value = '';
    return true;
  } catch (e) {
    if (version === sessionVersion) {
      stale.value = true;
      if (!data.value) error.value = e.message;
      console.warn('[抽屉刷新] 取数失败，保留上一拍数据：', e);
    }
    return false;
  }
}
defineExpose({
  reload: silentReload,
  needsRetry: () =>
    !!(error.value || stale.value || (props.sessionId && data.value?.sessionId !== props.sessionId)),
});

const s = computed(() => data.value?.summary || {});

/** 吐字速度：拟合斜率（模型固有速度）与实测口径分开给，见 Overview 的注释 */
const sp = computed(() => data.value?.speed || {});
const speedSub = computed(() => {
  const v = sp.value;
  if (v.tps == null) return '耗时样本不足';
  const parts = [`每请求开销 ${fmtSec(v.overheadMs)}`];
  if (!v.reliable) parts.push('样本少，仅供参考');
  return parts.join(' · ');
});

const maxToolMs = computed(() => Math.max(1, ...(data.value?.slowTools || []).map((t) => t.ms)));

/** 上下文增长曲线。
 *
 * 原来输入（动辄上万 token）和输出（几百 token）共用一根 Y 轴，量级差约 100 倍，
 * 结果输出被压成贴着底边的一条直线 —— 等于没画。实测最长会话 331 次请求，
 * 输入能爬到 8 万+，而输出长期在 200~1500 之间。
 *
 * 改成双 Y 轴：左轴输入（堆叠面积，就是"上下文"本身），右轴输出（柱）。
 * 双轴唯一站得住的场景就是**同单位、不同量级** —— 这里两边都是 token，
 * 看的人只要记住"右轴是输出"就行；换成 token vs 百分比那种异单位双轴就开始骗人了。
 *
 * 另外补 dataZoom：300 多次请求挤在 260px 里，一根柱子不到 1px，
 * 不给放大能力就只能看个轮廓。
 *
 * ⚠ 长会话（真实数据里最长 1381 次请求）把所有点铺进约 950px 时每点不足 1px；
 *   缓存命中率又会在某些请求从 99% 骤降到 2% 再立刻弹回（实测 26 处，
 *   如第 248/249 次：命中 347,136 → 28,672 → 350,208）。平滑的青绿分界线
 *   在凹口处近乎垂直、半透明面积在同一列反复叠加，看起来像凭空多出一根
 *   深绿色柱。按结衣的方案：默认只铺前 100 次请求，用底部滚动杆 / 滚轮
 *   缩放把曲线放宽，凹口就还原成可读的玫红斜坡，而不是一根柱。
 */
const growthEl = ref(null);
useChart(growthEl, () => {
  const steps = data.value?.steps || [];
  if (!steps.length) return null; // 空会话不画，交给容器的空态

  /** 默认窗口按「点数」而不是百分比算：会话短就整条铺满，长则固定 100 点 */
  const WINDOW_POINTS = 100;
  const zoomEnd = steps.length > WINDOW_POINTS ? (WINDOW_POINTS / steps.length) * 100 : 100;

  const axisName = { color: theme.faint, fontSize: 10 };
  return {
    grid: { left: 8, right: 18, top: 46, bottom: 46, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      formatter: (ps) => {
        const step = steps[ps[0].dataIndex];
        if (!step) return '';
        return stepTooltipHtml(step, ps[0].dataIndex);
      },
    },
    /* 图例居中放顶部，两个轴的名称分列左右两端：
       原来图例靠右，正好和右轴名「输出」压在同一个角落。
       ⚠ ECharts 图例图标取 series.itemStyle.color，**不取** lineStyle.color：
       只给 line 设 lineStyle / areaStyle 时，图例会落回默认调色板（蓝 / 黄绿 / 橙），
       与阶段 2 的新配色对不上。下面三个 series 都显式补一次主色。 */
    legend: { top: 0, left: 'center', itemWidth: 9, itemHeight: 9, textStyle: { color: theme.sub, fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: steps.map((_, i) => '#' + (i + 1)),
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: baseAxisLabel,
    },
    yAxis: [
      {
        type: 'value',
        name: '输入',
        nameTextStyle: axisName,
        axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      {
        type: 'value',
        name: '输出',
        nameTextStyle: axisName,
        axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
        splitLine: { show: false }, // 双轴的网格线重叠会糊成一片，只留左轴的
      },
    ],
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        start: 0,
        end: zoomEnd,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        /** 短会话本来就没东西可滚，别挂一根无用的杆 */
        show: steps.length > WINDOW_POINTS,
        start: 0,
        end: zoomEnd,
        height: 16,
        bottom: 4,
        borderColor: '#d2c9bc',
        backgroundColor: 'rgba(126,118,108,.12)',
        fillerColor: 'rgba(217,38,98,.18)',
        handleSize: '110%',
        handleStyle: { color: '#d92662', borderColor: '#d92662' },
        /** 杆里显示整条曲线的缩略轮廓，拖动时能看见自己翻到了哪一段 */
        dataBackground: {
          lineStyle: { color: 'rgba(15,118,110,.55)', width: 1 },
          areaStyle: { color: 'rgba(15,118,110,.14)' },
        },
        textStyle: { color: theme.faint, fontSize: 10 },
      },
    ],
    series: [
      {
        name: '缓存命中输入',
        type: 'line',
        stack: 'ctx',
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        areaStyle: { color: 'rgba(15,118,110,.20)' },
        lineStyle: { color: '#0f766e', width: 1.5 },
        itemStyle: { color: '#0f766e' },
        data: steps.map((r) => r.cacheRead),
      },
      {
        name: '未命中输入',
        type: 'line',
        stack: 'ctx',
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        areaStyle: { color: 'rgba(217,38,98,.22)' },
        lineStyle: { color: '#d92662', width: 1.5 },
        itemStyle: { color: '#d92662' },
        data: steps.map((r) => r.cacheMiss),
      },
      {
        name: '输出',
        type: 'bar',
        yAxisIndex: 1,
        barMaxWidth: 6,
        itemStyle: { color: '#c86d1f', borderRadius: [2, 2, 0, 0] },
        data: steps.map((r) => r.completion),
      },
    ],
  };
});

/* ---------- 逐次请求明细：窗口化渲染 ----------
 *
 * 一个会话最多能有 300+ 条请求（实测最长 331 条）。13 列全量铺开就是 4000+ 个
 * 单元格，而看板每 5 秒重取一次数据 → 整张表跟着重渲染，滚动明显掉帧。
 * 这里只渲染视口内的行，上下各用一行占位撑出滚动高度，DOM 节点数与会话长度脱钩。
 *
 * 为什么不引三方虚拟列表：需求只有"定高行 + 单列滚动"这一种，手写不到 30 行；
 * 引个库反而要额外处理它和 sticky 表头、和 5 秒轮询的配合。
 *
 * ⚠ 前提是行高必须严格等于 ROW_H（见 .steps-table td 的固定高度）。
 * 行高一旦被内容撑开，占位高度就对不上，滚动条会跳。
 */
const ROW_H = 34;
/** 视口外多渲染几行，抵消快速滚动时的白屏 */
const OVERSCAN = 6;

/** 上下文增长曲线始终消费后端原始（时间正序）steps：横轴是「第几次请求」，不随表格排序翻转 */
const rawSteps = computed(() => data.value?.steps || []);
/** 逐次请求明细默认时间逆序（最新在前）；顶部 Tag 可在正序 / 逆序间切换 */
const detailOrder = ref(DEFAULT_ORDER);
const steps = computed(() => orderedByTime(rawSteps.value, detailOrder.value));
const maxStepTotal = computed(() => Math.max(1, ...rawSteps.value.map((r) => r.total)));

const listEl = ref(null);
const viewH = ref(380);
const scrollTop = ref(0);

const winStart = computed(() => {
  const n = steps.value.length;
  return Math.max(0, Math.min(n, Math.floor(scrollTop.value / ROW_H) - OVERSCAN));
});
const winEnd = computed(() =>
  Math.min(steps.value.length, Math.ceil((scrollTop.value + viewH.value) / ROW_H) + OVERSCAN),
);
const visibleSteps = computed(() => steps.value.slice(winStart.value, winEnd.value));
const padTop = computed(() => winStart.value * ROW_H);
const padBottom = computed(() => Math.max(0, (steps.value.length - winEnd.value) * ROW_H));

/** 视口高度要实测：容器是 max-height，会话短的时候它比 380 矮 */
let ro = null;
watch(listEl, (el) => {
  if (ro) {
    ro.disconnect();
    ro = null;
  }
  if (!el) return;
  viewH.value = el.clientHeight || 380;
  ro = new ResizeObserver(() => {
    viewH.value = el.clientHeight || 380;
  });
  ro.observe(el);
});
onBeforeUnmount(() => ro && ro.disconnect());

/** 换会话时把滚动位置拉回顶部：停在上一会话的滚动位置上没有意义 */
watch(
  () => props.sessionId,
  () => {
    scrollTop.value = 0;
  },
);

function onScroll(e) {
  scrollTop.value = e.target.scrollTop;
}

/** 轮次视图点「在完整明细中定位」：滚到该轮并把同轮的行标出来。
 *  两者要一起设：窗口由 scrollTop 驱动，只改 DOM 的 scrollTop 在快速重取时会被拉回。
 *  下标一律先在原始正序里查、再换算到当前显示顺序，逆序下定位才不会跑到另一轮。 */
const highlightTurnKey = ref('');
function locateTurn(turnKey) {
  const rawIdx = rawSteps.value.findIndex((r) => r.turnKey === turnKey);
  if (rawIdx < 0) return;
  highlightTurnKey.value = turnKey;
  const idx = displayIndexOf(rawIdx, rawSteps.value.length, detailOrder.value);
  scrollTop.value = Math.max(0, (idx - 2) * ROW_H);
  if (listEl.value) listEl.value.scrollTop = scrollTop.value;
}

/** 顶部排序 Tag：切方向后若已有定位高亮，按新顺序重新定位；否则回到第一条 */
function toggleDetailOrder() {
  const key = highlightTurnKey.value;
  detailOrder.value = nextOrder(detailOrder.value);
  if (key) {
    locateTurn(key);
  } else {
    scrollTop.value = 0;
    if (listEl.value) listEl.value.scrollTop = 0;
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <aside class="drawer">
      <header class="head">
        <div class="head-main">
          <div class="title">{{ data?.meta?.title || '(无标题会话)' }}</div>
          <div class="sub mono">
            {{ sessionId }}
            <span v-if="data?.meta?.cwd"> · {{ data.meta.cwd }}</span>
          </div>
        </div>
        <button class="btn" @click="emit('close')">关闭</button>
      </header>

      <div v-if="error" class="empty">{{ error }}</div>
      <div v-else-if="!data" class="empty">加载中…</div>

      <div v-else class="body scroll">
        <!-- 本轮摘要 + 会话内轮次列表。它只消费本抽屉的 data，
             复用下面的 silentReload()，不新增第二套定时器。 -->
        <TurnPanel :data="data" :stale="stale" @locate="locateTurn" />

        <div class="kpis">
          <KpiCard label="请求" :value="fmtNum(s.requests)" :sub="`工具调用 ${data.steps.filter((x) => x.toolName).length} 次`" accent="#1c1917" />
          <KpiCard label="输入" :value="fmtCompact(s.prompt)" :sub="`平均 ${fmtCompact(s.avgPrompt)}`" accent="#c86d1f" />
          <KpiCard label="输出" :value="fmtCompact(s.completion)" :sub="`思考 ${fmtCompact(s.reasoning)}`" accent="#4d7c0f" />
          <KpiCard
            label="缓存命中率"
            :value="fmtPct(s.cacheHitRate)"
            :sub="`命中 ${fmtCompact(s.cacheRead)}`"
            accent="#0f766e"
            :progress="s.cacheHitRate"
          />
          <KpiCard
            label="吐字速度"
            :value="sp.tps == null ? '—' : `${fmtSpeed(sp.tps)} t/s`"
            :sub="speedSub"
            accent="#6d28d9"
          />
          <KpiCard label="结算" :value="fmtCredit(s.credit)" :sub="`平均 ${fmtCredit(s.avgCredit)}`" accent="#d92662" :hero="true" />
        </div>

        <div class="grid2">
          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">时间去向</div>
                <div class="panel-sub">在岗时间拆成模型生成 / 工具执行 / 人的环节（你在读和写）</div>
              </div>
            </div>
            <div class="pad">
              <PhaseBar :phase="data.phase" :credit="s.credit" />
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">最慢的工具调用</div>
                <div class="panel-sub">调用与返回配对得到，最长 8 条</div>
              </div>
            </div>
            <div class="scroll slow">
              <div v-for="t in data.slowTools" :key="t.callId" class="slow-row">
                <span class="tag">{{ t.name }}</span>
                <div class="bar"><i :style="{ width: (t.ms / maxToolMs) * 100 + '%' }" /></div>
                <span class="slow-val num">{{ fmtSec(t.ms) }}</span>
              </div>
              <div v-if="!data.slowTools.length" class="empty">暂无可用的工具耗时数据</div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">上下文增长曲线</div>
              <div class="panel-sub">横轴为第几次请求；面积越高说明单次请求携带的上下文越大</div>
            </div>
          </div>
          <div ref="growthEl" style="height: 260px; width: 100%" />
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">逐次请求明细</div>
              <div class="panel-sub">{{ steps.length }} 条 · # 为第几次请求，不随排序变化</div>
            </div>
            <SortTag :order="detailOrder" @toggle="toggleDetailOrder" />
          </div>
          <div ref="listEl" class="scroll" style="max-height: 380px" @scroll.passive="onScroll">
            <table class="steps-table">
              <thead>
                <tr>
                  <th style="width: 40px">#</th>
                  <th>时间</th>
                  <th>类型</th>
                  <th>工具</th>
                  <th>模型</th>
                  <th class="right">输入</th>
                  <th class="right">命中</th>
                  <th class="right">输出</th>
                  <th class="right">思考</th>
                  <th class="right">耗时</th>
                  <th class="right">吐字</th>
                  <th class="right">credit</th>
                  <th style="width: 70px" title="单条规模 = 本条请求的总 token（含输出）÷ 本会话单条最大总 token；反映单次请求的相对大小，只在本会话内横向比较，跨会话不可比">单条规模</th>
                </tr>
              </thead>
              <tbody>
                <!-- 上占位：把顶部滚出去的行"撑"出来，行高按 ROW_H 精确折算 -->
                <tr v-if="padTop > 0" class="vpad" :style="{ height: padTop + 'px' }">
                  <td colspan="13" />
                </tr>

                <tr
                  v-for="(r, i) in visibleSteps"
                  :key="r.id"
                  :class="{ 'turn-hit': r.turnKey === highlightTurnKey }"
                >
                  <td class="num muted">{{ displaySeq(winStart + i, steps.length, detailOrder) }}</td>
                  <td class="num muted">{{ fmtTime(r.ts, false) }}</td>
                  <td>
                    <span class="tag gray">{{ r.kind }}</span>
                    <span
                      v-if="r.isSubAgent"
                      class="tag plum"
                      :title="`子代理${r.agent ? '：' + r.agent : ''}（Agent 派生的后台队友）。消耗已归入本会话`"
                    >子代理</span>
                  </td>
                  <td>
                    <span v-if="r.toolName" class="tag">{{ r.toolName }}</span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td class="mono" :title="r.isSubAgent && r.agent ? `子代理：${r.agent}` : undefined">{{ r.model }}</td>
                  <td class="right num">{{ fmtNum(r.prompt) }}</td>
                  <td class="right num" :style="{ color: r.prompt && r.cacheRead / r.prompt > 0.9 ? '#12885a' : undefined }">
                    {{ fmtPct(r.prompt ? r.cacheRead / r.prompt : 0, 0) }}
                  </td>
                  <td class="right num">{{ fmtNum(r.completion) }}</td>
                  <td class="right num muted">{{ fmtNum(r.reasoning) }}</td>
                  <td class="right num" :title="`含每请求固定开销 ${fmtSec(r.overheadMs)}`">{{ fmtSec(r.durMs) }}</td>
                  <td class="right num">
                    <span
                      v-if="r.tps == null"
                      class="muted"
                      title="净出字时长不足，算不出可信的瞬时速度"
                    >—</span>
                    <span
                      v-else
                      title="瞬时速度 = 输出 ÷（耗时 − 该模型每请求固定开销）。净出字时长里仍含处理输入的时间，未命中缓存输入很大的请求读数会偏低"
                    >{{ fmtSpeed(r.tps) }}</span>
                  </td>
                  <td class="right num"><b>{{ fmtCredit(r.credit) }}</b></td>
                  <td>
                    <div class="bar"><i :style="{ width: (r.total / maxStepTotal) * 100 + '%' }" /></div>
                  </td>
                </tr>

                <tr v-if="padBottom > 0" class="vpad" :style="{ height: padBottom + 'px' }">
                  <td colspan="13" />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: flex-end;
  padding: 14px;
  background: rgba(28, 25, 23, 0.38);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  animation: fade 0.16s ease;
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

.drawer {
  position: relative;
  width: min(1160px, 95vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--bg-canvas);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-lg);
  animation: slide 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes slide {
  from {
    transform: translateX(32px);
    opacity: 0.4;
  }
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 20px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-hairline);
  position: relative;
  z-index: 3;
}

.title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.1px;
}

.sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 3px;
}

.body {
  padding: 16px 20px 26px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  position: relative;
  z-index: 1;
}

.kpis {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  grid-auto-rows: 1fr;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  grid-auto-rows: minmax(210px, auto);
}
.grid2 > .panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.grid2 > .panel > .pad,
.grid2 > .panel > .slow {
  flex: 1;
  min-height: 0;
}
.pad {
  padding: 12px 16px 16px;
}
.slow {
  padding: 8px 12px 12px;
}
.slow-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
}
.slow-row + .slow-row {
  border-top: 1px solid var(--border-hairline);
}
.slow-row .bar {
  flex: 1;
  min-width: 0;
}
.slow-val {
  font-size: 12px;
  font-weight: 600;
  flex: none;
  min-width: 52px;
  text-align: right;
}

.body .panel {
  background: var(--bg-surface);
}

/* 固定行高是窗口化渲染的前提：严格保持 34px */
.steps-table td {
  height: 34px;
  padding-top: 0;
  padding-bottom: 0;
}

.steps-table tr.turn-hit td {
  background: var(--accent-soft);
}

.steps-table tr.vpad td,
.steps-table tr.vpad:hover td {
  padding: 0;
  border: none;
  background: none;
}

@media (max-width: 900px) {
  .kpis {
    grid-template-columns: repeat(2, 1fr);
  }
  .grid2 {
    grid-template-columns: 1fr;
    grid-auto-rows: auto;
  }
}
</style>
