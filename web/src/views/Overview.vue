<script setup>
import { computed, ref, watch } from 'vue';
import { api, toParams } from '../api.js';
import { useChart, theme, baseTooltip, baseAxisLabel } from '../composables/useChart.js';
import {
  trendTooltipHtml,
  phaseTooltipHtml,
  modelTooltipHtml,
  toolTooltipHtml,
} from '../utils/tooltipHtml.js';
import {
  fmtCompact,
  fmtNum,
  fmtCredit,
  fmtPct,
  fmtSec,
  fmtSpeed,
  colorOf,
  baseName,
} from '../utils/format.js';
import KpiCard from '../components/KpiCard.vue';
import PhaseBar from '../components/PhaseBar.vue';
import PhaseMiniBar from '../components/PhaseMiniBar.vue';

const props = defineProps({ filter: Object, meta: Object });
const emit = defineEmits(['open-session']);

const data = ref(null);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.overview(toParams(props.filter));
    return true;
  } catch (e) {
    error.value = e.message;
    return false;
  } finally {
    loading.value = false;
  }
}

watch(() => props.filter, load, { deep: true, immediate: true });
defineExpose({ reload: load, needsRetry: () => !!error.value });

const s = computed(() => data.value?.summary || {});

/**
 * 吐字速度。
 *
 * 两个口径必须分开说，否则数字前后矛盾：
 *   speed.tps        拟合斜率（按输出量加权）—— 模型的固有速度，看板主指标
 *   speed.measuredTps  Σ输出 / Σ净时长 —— 实测口径，系统性偏低
 */
const sp = computed(() => data.value?.speed || {});
const speedSub = computed(() => {
  const v = sp.value;
  if (v.tps == null) return '耗时样本不足，无法拟合';
  const parts = [`${v.dominantModel || '—'} 拟合`, `每请求开销 ${fmtSec(v.overheadMs)}`];
  if (!v.reliable) parts.push('样本少，仅供参考');
  return parts.join(' · ');
});

/** 时间去向（所选范围涉及会话的合计） */
const phase = computed(() => data.value?.phase || null);

/** 按会话拆的时间去向，用来回答"这些在岗时间花在哪个会话上" */
const bySessionPhase = computed(() => data.value?.phaseBySession || []);
const maxPhaseActiveMs = computed(() =>
  Math.max(1, ...bySessionPhase.value.map((s) => s.activeMs)),
);

/** 工具耗时：按名字查表，给「工具调用分布」的 tooltip 补上真实耗时 */
const toolTimeByName = computed(() => {
  const m = new Map();
  for (const t of data.value?.toolTime || []) m.set(t.name, t);
  return m;
});
const toolTime = (name) => toolTimeByName.value.get(name) || null;

/** ECharts 竖向线性渐变（从上到下） */
function grad(from, to) {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ],
  };
}

/** ECharts 横向线性渐变（从左到右） */
function gradH(from, to) {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 1,
    y2: 0,
    colorStops: [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ],
  };
}

/* ---------- 趋势图：冷暖撞色堆叠用量 + credit 折线 ---------- */
const trendEl = ref(null);
useChart(trendEl, () => {
  const t = data.value?.timeline || [];
  const gran = props.filter.granularity || 'day';
  const fmtLabel = (b) => (gran === 'hour' ? b.key.slice(5) : gran === 'month' ? b.key : b.key.slice(5));
  const bw = t.length <= 8 ? 58 : t.length <= 20 ? 38 : 22;
  return {
    grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps) => trendTooltipHtml(t[ps[0].dataIndex], ps),
    },
    legend: { top: 0, right: 0, itemWidth: 9, itemHeight: 9, textStyle: { color: theme.sub, fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: t.map(fmtLabel),
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: baseAxisLabel,
    },
    yAxis: [
      {
        type: 'value',
        axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      {
        type: 'value',
        axisLabel: { ...baseAxisLabel, formatter: (v) => v },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '缓存命中输入',
        type: 'bar',
        stack: 'tok',
        data: t.map((b) => b.cacheRead),
        barMaxWidth: bw,
        // 阶段 2：冷调松石青，在暖砂米白面板上清晰醒目，不再与背景顺色隐身
        itemStyle: {
          color: grad('#0f766e', '#14b8a6'),
          borderRadius: [0, 0, 3, 3],
        },
      },
      {
        name: '未命中输入',
        type: 'bar',
        stack: 'tok',
        data: t.map((b) => b.cacheMiss),
        barMaxWidth: bw,
        // 未命中按全价计费，用主强调色树莓玫红一眼标出
        itemStyle: { color: grad('#b01b4d', '#e63973'), borderRadius: [3, 3, 0, 0] },
      },
      {
        name: '输出',
        type: 'bar',
        stack: 'tok',
        data: t.map((b) => b.completion),
        barMaxWidth: bw,
        itemStyle: { color: grad('#b45309', '#f59e0b'), borderRadius: [3, 3, 0, 0] },
      },
      {
        name: '结算 (credit)',
        type: 'line',
        yAxisIndex: 1,
        smooth: t.length > 6 ? 0.35 : false,
        symbolSize: 7,
        data: t.map((b) => b.credit),
        itemStyle: { color: '#d92662', borderColor: '#fbf9f5', borderWidth: 2 },
        lineStyle: { width: 2.5, shadowColor: 'rgba(217,38,98,.35)', shadowBlur: 10, shadowOffsetY: 3 },
      },
    ],
  };
});

/* ---------- 时间去向趋势（与 PhaseBar、PhaseMiniBar 严格同色） ---------- */
const phaseTrendEl = ref(null);
useChart(phaseTrendEl, () => {
  const t = data.value?.phaseTimeline || [];
  if (!t.length) return null;
  const gran = props.filter.granularity || 'day';
  const fmtLabel = (b) => (gran === 'hour' ? b.key.slice(5) : gran === 'month' ? b.key : b.key.slice(5));
  const bw = t.length <= 8 ? 58 : t.length <= 20 ? 38 : 22;
  const mins = (ms) => Math.round(ms / 600) / 100;
  return {
    grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps) => phaseTooltipHtml(t[ps[0].dataIndex], ps),
    },
    legend: { top: 0, right: 0, itemWidth: 9, itemHeight: 9, textStyle: { color: theme.sub, fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: t.map(fmtLabel),
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: baseAxisLabel,
    },
    yAxis: {
      type: 'value',
      axisLabel: { ...baseAxisLabel, formatter: (v) => v + 'm' },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: [
      {
        name: '模型生成',
        type: 'bar',
        stack: 'ph',
        barMaxWidth: bw,
        itemStyle: { color: '#d92662' },
        data: t.map((b) => mins(b.modelMs)),
      },
      {
        name: '工具执行',
        type: 'bar',
        stack: 'ph',
        barMaxWidth: bw,
        itemStyle: { color: '#0f766e' },
        data: t.map((b) => mins(b.toolMs)),
      },
      {
        name: '人的环节',
        type: 'bar',
        stack: 'ph',
        barMaxWidth: bw,
        itemStyle: { color: '#c86d1f', borderRadius: [3, 3, 0, 0] },
        data: t.map((b) => mins(b.humanMs)),
      },
    ],
  };
});

/* ---------- 模型分布 ---------- */
const modelEl = ref(null);
const modelMetric = ref('credit');
const MODEL_METRICS = [
  { key: 'credit', label: '按 credit' },
  { key: 'total', label: '按 token' },
  { key: 'requests', label: '按请求数' },
];

useChart(modelEl, () => {
  const list = data.value?.byModel || [];
  const key = modelMetric.value;
  return {
    tooltip: {
      ...baseTooltip,
      formatter: (p) => modelTooltipHtml(p, modelMetric.value),
    },
    legend: {
      orient: 'vertical',
      left: '56%',
      top: 'center',
      itemWidth: 9,
      itemHeight: 9,
      itemGap: 8,
      textStyle: { color: theme.sub, fontSize: 11 },
      formatter: (n) => (n.length > 28 ? n.slice(0, 27) + '…' : n),
    },
    series: [
      {
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['34%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        itemStyle: {
          borderColor: '#fbf9f5',
          borderWidth: 3,
          borderRadius: 6,
          shadowBlur: 12,
          shadowColor: 'rgba(28,25,23,.12)',
          shadowOffsetY: 2,
        },
        data: list.map((m, i) => ({
          name: m.model,
          value: m[key],
          req: m.requests,
          total: m.total,
          realCredit: m.credit,
          itemStyle: { color: colorOf(i) },
        })),
      },
    ],
  };
});

/* ---------- 项目排行 ---------- */
const maxProjectCredit = computed(() =>
  Math.max(1, ...(data.value?.byProject || []).map((p) => p.credit)),
);

/* ---------- 最慢的工具调用 ---------- */
const maxToolMs = computed(() => Math.max(1, ...(data.value?.slowTools || []).map((t) => t.ms)));

/* ---------- 工具调用 ---------- */
const toolEl = ref(null);
useChart(toolEl, () => {
  const list = [...(data.value?.byTool || [])].slice(0, 12).reverse();
  return {
    grid: { left: 8, right: 24, top: 8, bottom: 4, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps) => {
        const d = list[ps[0].dataIndex];
        return toolTooltipHtml(d, toolTime(d.name));
      },
    },
    xAxis: {
      type: 'value',
      axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    yAxis: {
      type: 'category',
      data: list.map((d) => d.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...baseAxisLabel, color: theme.sub },
    },
    series: [
      {
        type: 'bar',
        data: list.map((d) => d.calls),
        itemStyle: {
          color: gradH('#0f766e', '#14b8a6'),
          borderRadius: [0, 5, 5, 0],
        },
        barMaxWidth: 14,
        label: { show: true, position: 'right', color: theme.faint, fontSize: 11 },
      },
    ],
  };
});
</script>

<template>
  <!--
    必须包一层单一根节点：父组件用 v-show 控制显隐，
    而 v-show 对多根节点（fragment）的组件不生效，会导致切 tab 时内容叠加。
  -->
  <div class="view">
    <div v-if="error" class="empty">{{ error }}</div>

    <template v-else-if="data">
      <!-- KPI（保持 6 张卡片与原有标签名称，首张请求总数保持第 1 位供 E2E 筛选校验，结算用量设为 hero 高亮） -->
      <div class="kpis">
        <KpiCard
          label="请求总数"
          :value="fmtNum(s.requests)"
          :sub="`平均 ${fmtCompact(s.avgPrompt)} 输入 / ${fmtNum(s.avgCompletion)} 输出`"
          accent="#1c1917"
        />
        <KpiCard
          label="Token 总量"
          :value="fmtCompact(s.total)"
          :sub="`输入 ${fmtCompact(s.prompt)} ｜ 输出 ${fmtCompact(s.completion)}`"
          accent="#c86d1f"
        />
        <KpiCard
          label="缓存命中率"
          :value="fmtPct(s.cacheHitRate)"
          :sub="`命中 ${fmtCompact(s.cacheRead)} ｜ 未命中 ${fmtCompact(s.cacheMiss)}`"
          accent="#0f766e"
          :progress="s.cacheHitRate"
        />
        <KpiCard
          label="吐字速度"
          :value="sp.tps == null ? '—' : `${fmtSpeed(sp.tps)} t/s`"
          :sub="speedSub"
          accent="#6d28d9"
        />
        <KpiCard
          label="思考 Token"
          :value="fmtCompact(s.reasoning)"
          :sub="`占输出 ${fmtPct(s.completion ? s.reasoning / s.completion : 0)}`"
          accent="#4d7c0f"
        />
        <KpiCard
          label="结算用量 (credit)"
          :value="fmtCredit(s.credit)"
          :sub="`平均每次 ${fmtCredit(s.avgCredit)}`"
          accent="#d92662"
          :hero="true"
        />
      </div>

      <!-- 趋势 -->
      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">用量趋势</div>
            <div class="panel-sub">堆叠柱 = token 构成（松石青=缓存命中，树莓玫红=未命中，焦糖琥珀=输出），折线 = 结算用量</div>
          </div>
        </div>
        <div ref="trendEl" class="chart chart-lg" />
      </div>

      <!-- 第一组 Bento 非对称双栏：项目排行 (5) : 模型分布 (7) -->
      <div class="grid2 bento-5-7">
        <!-- 项目排行 -->
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">项目用量排行</div>
            <div class="panel-sub">按结算用量</div>
          </div>
          <div class="rank">
            <div v-for="(p, i) in data.byProject" :key="p.projectId" class="rank-row">
              <div class="rank-idx num">{{ String(i + 1).padStart(2, '0') }}</div>
              <div class="rank-main">
                <div class="rank-name" :title="p.cwd || p.projectId">
                  {{ baseName(p.cwd) || p.projectId }}
                  <span class="muted rank-path">{{ p.cwd || p.projectId }}</span>
                </div>
                <div class="bar">
                  <i :style="{ width: (p.credit / maxProjectCredit) * 100 + '%', background: colorOf(i) }" />
                </div>
              </div>
              <div class="rank-vals num">
                <div class="rank-credit">{{ fmtCredit(p.credit) }} <span class="muted">cr</span></div>
                <div class="rank-sub muted">
                  {{ fmtCompact(p.total) }} tok · {{ p.requests }} req · {{ p.sessionCount }} 会话
                </div>
              </div>
            </div>
            <div v-if="!data.byProject.length" class="empty">暂无数据</div>
          </div>
        </div>

        <!-- 模型分布 -->
        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">模型用量分布</div>
              <div class="panel-sub">默认按结算 credit 看成本占比</div>
            </div>
            <div class="seg">
              <button
                v-for="m in MODEL_METRICS"
                :key="m.key"
                class="seg-btn"
                :class="{ on: modelMetric === m.key }"
                @click="modelMetric = m.key"
              >
                {{ m.label }}
              </button>
            </div>
          </div>
          <div ref="modelEl" class="chart" />
        </div>
      </div>

      <!-- 第二组 Bento 非对称双栏：模型明细宽表 (7) : 工具调用分布 (5) -->
      <div class="grid2 bento-7-5">
        <!-- 模型明细 -->
        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">模型明细</div>
              <div class="panel-sub">单价与出字速度一目了然 · 速度由样本拟合得出</div>
            </div>
          </div>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th class="right">请求</th>
                  <th class="right">输入</th>
                  <th class="right">输出</th>
                  <th class="right">缓存命中率</th>
                  <th class="right">credit</th>
                  <th class="right">均次</th>
                  <th class="right">吐字速度</th>
                  <th class="right">每请求开销</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(m, idx) in data.byModel" :key="m.model">
                  <td>
                    <span class="tag gray">
                      <i class="model-dot" :style="{ background: colorOf(idx) }" />
                      <span class="mono">{{ m.model }}</span>
                    </span>
                  </td>
                  <td class="right num">{{ m.requests }}</td>
                  <td class="right num">{{ fmtCompact(m.prompt) }}</td>
                  <td class="right num">{{ fmtCompact(m.completion) }}</td>
                  <td class="right num" :style="{ color: m.cacheHitRate >= 0.85 ? 'var(--teal)' : undefined }">
                    {{ fmtPct(m.cacheHitRate) }}
                  </td>
                  <td class="right num">
                    <span class="stat-bar-cell">
                      <i class="v-bar rose" />
                      <b>{{ fmtCredit(m.credit) }}</b>
                    </span>
                  </td>
                  <td class="right num muted">{{ fmtCredit(m.avgCredit) }}</td>
                  <td class="right num">
                    <span v-if="m.speed == null" class="muted">—</span>
                    <span
                      v-else
                      :class="{ lowconf: !m.speedReliable }"
                      :title="`${m.speedSamples} 条样本拟合，R²=${m.speedR2}${m.speedReliable ? '' : '，样本偏少仅供参考'}`"
                    >
                      <b>{{ fmtSpeed(m.speed) }}</b> <span class="unit">t/s</span>
                    </span>
                  </td>
                  <td class="right num muted">
                    {{ m.speedReliable && m.overheadMs != null ? fmtSec(m.overheadMs) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 工具调用 -->
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">工具调用分布</div>
            <div class="panel-sub">带 tool 的请求次数 Top 12 · 悬停看实测耗时</div>
          </div>
          <div ref="toolEl" class="chart" />
        </div>
      </div>

      <!-- 第三组双栏：时间去向 + 最慢工具调用 -->
      <div class="grid2">
        <!-- 时间去向：总量 + 按会话下钻 -->
        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">时间去向</div>
              <div class="panel-sub">在岗时间拆成三段：模型在生成、工具在执行、你在读和写。离开电脑的时段不计入</div>
            </div>
          </div>
          <div class="pad">
            <PhaseBar :phase="phase" :credit="s.credit" />

            <div v-if="bySessionPhase.length" class="breakdown">
              <div class="breakdown-head">
                <span>时间花在哪</span>
                <span class="muted">按会话在岗耗时 · 点击查看</span>
              </div>
              <div
                v-for="s in bySessionPhase"
                :key="s.sessionId"
                class="bd-row"
                @click="emit('open-session', s.sessionId)"
              >
                <span class="bd-name" :title="s.title">{{ s.title || '(无标题会话)' }}</span>
                <PhaseMiniBar :phase="s" :max-ms="maxPhaseActiveMs" />
                <span class="bd-val num">{{ fmtSec(s.activeMs) }}</span>
              </div>
            </div>
            <div v-else class="empty">所选范围内没有可用的会话耗时数据</div>
          </div>
        </div>

        <!-- 慢工具 -->
        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">最慢的工具调用</div>
              <div class="panel-sub">按 callId 把调用与返回配对算出的实测耗时，不需要任何推算</div>
            </div>
          </div>
          <div class="scroll slow">
            <div v-for="t in data.slowTools" :key="t.callId" class="slow-row" @click="emit('open-session', t.sessionId)">
              <div class="slow-main">
                <div class="slow-name">
                  <span class="tag">{{ t.name }}</span>
                  <span class="muted slow-title" :title="t.title">{{ t.title || '(无标题会话)' }}</span>
                </div>
                <div class="bar"><i :style="{ width: (t.ms / maxToolMs) * 100 + '%' }" /></div>
              </div>
              <div class="slow-val num">{{ fmtSec(t.ms) }}</div>
            </div>
            <div v-if="!data.slowTools.length" class="empty">暂无可用的工具耗时数据</div>
          </div>
        </div>
      </div>

      <!-- 时间去向趋势 -->
      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">时间去向趋势</div>
            <div class="panel-sub">按当前粒度分桶 · 只画在岗，离开量见悬停提示</div>
          </div>
        </div>
        <div ref="phaseTrendEl" class="chart chart-lg" />
      </div>
    </template>

    <div v-else class="empty">加载中…</div>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.kpis {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
  grid-auto-rows: 1fr;
}

@media (max-width: 1420px) {
  .kpis {
    grid-template-columns: repeat(3, 1fr);
  }
}

/* ---------- Bento 非对称双栏网格 ---------- */
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  grid-auto-rows: minmax(320px, auto);
}

.grid2.bento-5-7 {
  grid-template-columns: 5fr 7fr;
}

.grid2.bento-7-5 {
  grid-template-columns: 7fr 5fr;
}

.grid2 > .panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.grid2 > .panel > .rank,
.grid2 > .panel > .scroll {
  flex: 1;
  min-height: 0;
}

.grid2 > .panel > .chart {
  flex: 1;
  min-height: 240px;
}

@media (max-width: 1100px) {
  .grid2,
  .grid2.bento-5-7,
  .grid2.bento-7-5 {
    grid-template-columns: 1fr;
    grid-auto-rows: auto;
  }
}

.chart {
  width: 100%;
}

.chart-lg {
  height: 300px;
}

.rank {
  padding: 8px 14px 14px;
}

.rank-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  transition: background 0.15s;
}

.rank-row:hover {
  background: var(--bg-subtle);
}

.rank-row + .rank-row {
  border-top: 1px solid var(--border-hairline);
}

.rank-idx {
  width: 22px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--accent);
  text-align: center;
}

.rank-main {
  flex: 1;
  min-width: 0;
}

.rank-name {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-path {
  font-size: 10px;
  font-weight: 400;
  margin-left: 6px;
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.rank-vals {
  text-align: right;
}

.rank-credit {
  font-size: 13px;
  font-weight: 700;
}

.rank-sub {
  font-size: 11px;
  margin-top: 2px;
}

.model-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

/* ---------- 时间去向 / 慢工具 ---------- */
.pad {
  padding: 12px 16px 16px;
  flex: 1;
  min-height: 0;
}

.breakdown {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border-hairline);
}

.breakdown-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
}

.breakdown-head .muted {
  font-size: 11px;
  font-weight: 400;
}

.bd-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;
}

.bd-row:hover {
  background: var(--bg-subtle);
}

.bd-name {
  width: 180px;
  flex: none;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bd-row :deep(.mini) {
  flex: 1;
  min-width: 0;
}

.bd-val {
  flex: none;
  width: 58px;
  text-align: right;
  font-size: 12px;
  font-weight: 600;
}

.lowconf {
  opacity: 0.62;
}

.unit {
  font-size: 10px;
  color: var(--text-3);
}

.slow {
  padding: 8px 14px 14px;
}

.slow-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;
}

.slow-row:hover {
  background: var(--bg-subtle);
}

.slow-row + .slow-row {
  border-top: 1px solid var(--border-hairline);
}

.slow-main {
  flex: 1;
  min-width: 0;
}

.slow-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.slow-title {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slow-val {
  font-size: 13px;
  font-weight: 600;
  flex: none;
}
</style>
