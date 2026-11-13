import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';

// ECharts 按需引入：只注册用到的图表与组件，产物从 1.1MB 降到 ~690KB（含 dataZoom）
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  // ⚠ 不注册这两个，option 里的 dataZoom 会被 ECharts **静默忽略**：
  // 滚动杆不渲染、默认窗口也不生效，全部点照旧铺满（不报错，极难发现）。
  DataZoomInsideComponent,
  DataZoomSliderComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  CanvasRenderer,
]);

/** 统一图表风格（暖砂羊皮纸 / 深焙黑曜石双主题兼容） */
export const theme = {
  text: '#1c1917',
  sub: '#57524b',
  faint: '#7e766c',
  grid: 'rgba(126,118,108,.16)',
  axis: 'rgba(126,118,108,.32)',
};

/** 与页面暖砂卡片一致的浮层 tooltip */
export const baseTooltip = {
  backgroundColor: 'rgba(251,249,245,.96)',
  borderColor: '#cfc6b8',
  borderWidth: 1,
  padding: [9, 12],
  textStyle: { color: theme.text, fontSize: 12 },
  extraCssText: [
    'box-shadow:0 12px 32px -8px rgba(28,25,23,.18)',
    'border-radius:10px',
  ].join(';'),
};

export const baseAxisLabel = { color: theme.faint, fontSize: 11 };

/**
 * 把一个 DOM ref 变成 ECharts 实例。
 *
 * 用法（elRef 必须是在组件里直接声明的 ref，模板上用 ref="xxx" 绑定）：
 *   const trendEl = ref(null)
 *   useChart(trendEl, () => ({ ...option }))
 *
 * 两个必须处理的现实情况：
 * 1. 图表常常在 v-if / v-else-if 分支里，首次挂载时容器还不存在
 *    （数据没回来）。所以不能只在 onMounted 里 init 一次，必须监听
 *    elRef 从 null 变成真实元素的那一刻再补一次初始化。
 * 2. 分支切换会让容器被销毁重建，此时要重新绑定，否则画在废弃的 DOM 上。
 *
 * 另外刻意接收 ref 本身而不是返回 ref —— 从返回值里解构出来的 ref
 * 无法被 <script setup> 的模板 ref 绑定识别。
 *
 * @param {{value: HTMLElement|null}} elRef 容器 ref
 * @param {() => object} optionGetter 每次重绘时重新求值的 option 工厂
 */
export function useChart(elRef, optionGetter) {
  let chart = null;
  let ro = null;

  function render() {
    if (!chart) return;
    const option = optionGetter();
    if (!option) return;
    /**
     * 5s 轮询重绘用 notMerge=true 才能清掉旧 series，但它也会顺手把用户
     * 拖动的 dataZoom 窗口冲掉 —— 「翻到第 500 次请求」下一拍就被拉回 #1。
     * 先把当前窗口取出来并回新 option，拖到哪儿就停在哪儿。
     * 切会话时容器被销毁重建，新实例没有旧窗口，自然回到默认区间。
     */
    const prevZoom = chart.getOption()?.dataZoom;
    if (Array.isArray(prevZoom) && Array.isArray(option.dataZoom)) {
      option.dataZoom = option.dataZoom.map((z, i) => {
        const s = prevZoom[i]?.start;
        const e = prevZoom[i]?.end;
        return Number.isFinite(s) && Number.isFinite(e) ? { ...z, start: s, end: e } : z;
      });
    }
    chart.setOption(option, true);
  }

  /** 容器可用则初始化/重新绑定；返回是否已就绪 */
  function ensure() {
    const dom = elRef.value;
    if (!dom) return false;
    if (chart && chart.getDom() === dom) return true;

    // 容器被重建（v-if 切换）——丢掉旧实例
    if (chart) {
      if (ro) ro.disconnect();
      chart.dispose();
      chart = null;
    }

    chart = echarts.init(dom, null, { renderer: 'canvas' });
    render();

    ro = new ResizeObserver(() => {
      if (chart) chart.resize();
    });
    ro.observe(dom);
    return true;
  }

  onMounted(() => {
    nextTick(ensure);
  });

  // 容器晚于组件挂载才出现（数据加载完成后才渲染 v-else-if 分支）
  watch(elRef, () => {
    nextTick(ensure);
  });

  onBeforeUnmount(() => {
    if (ro) ro.disconnect();
    if (chart) chart.dispose();
    chart = null;
  });

  // 数据变化时重绘。deep 保证 option 工厂读到的嵌套数据变化也能触发。
  watch(optionGetter, render, { deep: true });

  return { render, ensure, isReady: () => !!chart };
}
