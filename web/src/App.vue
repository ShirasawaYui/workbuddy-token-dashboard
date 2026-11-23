<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from './api.js';
import { fmtNum, fmtTime } from './utils/format.js';
import { pickGranularity, spanDaysOf } from './utils/granularity.js';
import { loadFilter, saveFilter, sanitizeFilter } from './composables/useFilterStorage.js';
import { RELATIVE_PRESETS, rangeOfPreset, toDayStr } from './utils/ranges.js';
import FilterBar from './components/FilterBar.vue';
import SessionDrawer from './components/SessionDrawer.vue';
import ActiveSessionBar from './components/ActiveSessionBar.vue';
import Overview from './views/Overview.vue';
import Sessions from './views/Sessions.vue';
import Requests from './views/Requests.vue';

const TABS = [
  { key: 'overview', label: '总览' },
  { key: 'sessions', label: '会话' },
  { key: 'requests', label: '明细' },
];

const tab = ref('overview');
const meta = ref({});
const loading = ref(false);
const openSessionId = ref('');

/* ---------- 阶段 2：暖砂亮色 / 焦茶暗色双主题切换 ---------- */
const THEME_KEY = 'wb-token-dashboard:theme:v1';
const isDark = ref(false);
function applyTheme(dark) {
  isDark.value = !!dark;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
  }
  try {
    localStorage.setItem(THEME_KEY, isDark.value ? 'dark' : 'light');
  } catch {
    /* 隐私模式下忽略 */
  }
}
try {
  const savedTheme = localStorage.getItem(THEME_KEY);
  applyTheme(savedTheme === 'dark');
} catch {
  applyTheme(false);
}
function toggleTheme() {
  applyTheme(!isDark.value);
}

/* 上次的筛选条件：从 localStorage 恢复（只在当天有效，见 useFilterStorage 的注释） */
const boot = loadFilter();
const filter = ref(boot.filter);
/** 是否确实沿用了一份存下来的筛选 —— 顶栏要给个可见的交代 */
const restoredHint = ref(boot.restored);

/* ---------- 阶段 1：跨零点 / 历史加载提示 / stale 的共享状态 ---------- */
/** 自动刷新是否 stale（上一拍取数失败）；与历史加载提示共用一处容器，且 stale 优先 */
const pollStale = ref(false);
/** 是否成功连上过解析服务：服务从未启动（meta 为空）时不常驻显示任何状态提示 */
const connected = computed(() => !!meta.value?.projectsDir && !meta.value?.error);
/** 品牌副标题（项目数据目录）：按路径分隔符切段插 <wbr>，窄侧栏里整条路径铺开换行而非省略折叠 */
const brandSubText = computed(() =>
  meta.value.error ? '未连接到解析服务' : meta.value.projectsDir || '读取中…'
);
const brandSubSegs = computed(() => {
  const t = brandSubText.value;
  // 仅对盘符开头的路径按 \ 与 / 切段；错误/占位文案整段返回
  return /^[A-Za-z]:[\\/]/.test(t) ? t.split(/(?<=[\\/])/) : [t];
});
/** 历史数据加载提示：'' 无 | 'loading' 正在读取 | 'failed' 读取未成功 */
const historyState = ref('');
let historyTimer = null;
let historySeq = 0;
/** 页面打开那天的本地日期串，用于跨零点检测 */
let lastDayStr = toDayStr(new Date());

/** 稳定态 / 历史加载 / stale 统一一处容器按优先级显示，避免互抢（stale 优先） */
const banner = computed(() => {
  if (connected.value && pollStale.value) {
    return { kind: 'stale', text: '自动刷新未成功，显示上一拍数据' };
  }
  if (historyState.value === 'failed') {
    return { kind: 'failed', text: '历史数据读取未成功，可重试' };
  }
  if (historyState.value === 'loading') {
    return { kind: 'loading', text: '正在读取历史数据…' };
  }
  return null;
});

/** 用户动了筛选：从这一刻起就不再是"沿用"，把提示收掉 */
function onFilter(next) {
  const prev = filter.value;
  filter.value = next;
  restoredHint.value = false;
  maybeShowHistoryLoading(next, prev);
}

/**
 * loadFilter() 只在启动时调一次；页面跨零点一直开着时，相对档位的 from/to
 * 会停在昨天零点（标签写「今天」却筛出「昨天 + 今天」）。
 * poll() 每拍与切回前台都会经过这里：日期变了就按 preset 重算区间，
 * 换一个新对象让各视图 watch 触发一次刷新（复用既有链路，不动 revision 门控）。
 */
function syncDayBoundary() {
  const today = toDayStr(new Date());
  if (today === lastDayStr) return;
  lastDayStr = today;
  const f = filter.value;
  if (!RELATIVE_PRESETS.includes(f.preset)) return;
  filter.value = { ...f, ...rangeOfPreset(f.preset) };
}

/* ---------- 历史数据加载提示（4.3） ----------
   切到更宽档位时前端先亮提示；服务端会在 handler 里 await ensureLoaded，
   该请求返回时数据已是新版本，不需要再做一次 revision 换数。
   当前视图数据不清空、不闪空态，提示只是独立的一条 banner。 */

/** 区间起点排序键：空 = 不限 = 最早（最宽）；否则用 YYYYMMDD 数字比较 */
function startKey(f) {
  return f.from ? Number(f.from.replace(/-/g, '')) : 0;
}
/** 前端预测：新范围是否比旧范围宽（起点更早 / 由限定变不限） */
function isWiderRange(next, prev) {
  const ns = startKey(next);
  const ps = startKey(prev);
  if (ns !== ps) return ns < ps;
  return !!prev.to && !next.to;
}

/**
 * 触发用任务给的近似口径：范围变宽 且 还有未加载文件；fullLoad 时不显示。
 * meta 为空对象（服务未启动）时 loadedFiles/totalFiles 缺失，条件不成立 → 不常驻。
 */
function maybeShowHistoryLoading(next, prev) {
  const m = meta.value || {};
  if (m.fullLoad) return;
  if (!(Number(m.loadedFiles) < Number(m.totalFiles))) return;
  if (next.from === prev.from && next.to === prev.to) return; // 只改项目/模型/关键词，不涉及范围
  if (!isWiderRange(next, prev)) return;
  showHistoryLoading();
}

function showHistoryLoading() {
  const seq = ++historySeq;
  historyState.value = 'loading';
  clearTimeout(historyTimer);
  // 15s 兜底：请求失败或一直不返回也不能让提示常驻
  historyTimer = setTimeout(() => finishHistoryLoading(seq, true), 15000);
  // nextTick 后各视图因 filter 变化发出的 GET 已在途，等它们全部落地再撤销
  nextTick(async () => {
    await api.whenIdle();
    finishHistoryLoading(seq, false);
  });
}

function finishHistoryLoading(seq, timedOut) {
  if (seq !== historySeq) return; // 已被更新的切档覆盖
  clearTimeout(historyTimer);
  historyTimer = null;
  if (historyState.value !== 'loading') return;
  // 请求落地后当前视图仍报 error（needsRetry）→ 判定读取未成功；超时只做撤销
  historyState.value = !timedOut && currentView()?.needsRetry?.() ? 'failed' : '';
}

const overviewRef = ref(null);
const sessionsRef = ref(null);
const requestsRef = ref(null);
const drawerRef = ref(null);
const activeRef = ref(null);

/**
 * 前端自动取数间隔，与服务端扫描间隔（SCAN_INTERVAL_MS，默认 5s）对齐，
 * 保证每一拍拉到的都是刚扫进内存的新数据。
 */
const AUTO_REFRESH_MS = 5000;
let timer = null;
let saveTimer = null;
/** 自动刷新自己的 in-flight 锁：loading 只覆盖手动刷新，挡不住两个 poll 叠加 */
let pollInFlight = false;
/** 手动刷新等待当前 poll 完全收尾，而不是只等它此刻已经发出的某个 GET。 */
const pollWaiters = new Set();
/**
 * 上一拍的数据版本。revision 只在后端 rebuild（有新记录）时 +1，
 * 因此它没变就说明这一拍没有任何新数据 —— 整拍跳过视图重取与重绘。
 * 初始 -1 保证首次 poll 会完整加载一次。
 */
let lastRevision = -1;

function currentView() {
  return { overview: overviewRef, sessions: sessionsRef, requests: requestsRef }[tab.value]?.value;
}

/** revision 只表达「服务端变了」；本地一次取数失败也必须能在下一拍重试。 */
function needsRetry() {
  return !!(
    currentView()?.needsRetry?.() ||
    (openSessionId.value && drawerRef.value?.needsRetry?.()) ||
    activeRef.value?.needsRetry?.()
  );
}

/** 返回 false 时绝不能提交 revision，否则后续 poll 会把失败那一拍当成已完成。 */
async function syncData() {
  let ok = true;
  if ((await currentView()?.reload()) === false) ok = false;
  if (openSessionId.value && (await drawerRef.value?.reload()) === false) ok = false;
  if ((await activeRef.value?.reload()) === false) ok = false;
  return ok;
}

async function loadMeta() {
  try {
    meta.value = await api.meta();
    /* meta 到手后才能校验存下来的项目/模型/类型是否还在数据里。
       直接还原一个已经消失的选项，界面上是空选择器 + 恒 0 条结果，
       比不还原更让人困惑。 */
    const fixed = sanitizeFilter(filter.value, meta.value);
    if (JSON.stringify(fixed) !== JSON.stringify(filter.value)) filter.value = fixed;
  } catch (e) {
    meta.value = { error: e.message };
  }
}

async function refresh() {
  loading.value = true;
  try {
    if (pollInFlight) await new Promise((resolve) => pollWaiters.add(resolve));
    await api.refresh();
    await loadMeta();
    // 手动刷新一律强制重取；只有全部成功才提交版本，失败留给下一拍重试。
    if (await syncData()) lastRevision = meta.value.revision ?? -1;
  } catch (e) {
    console.error('[手动刷新] 失败：', e);
  } finally {
    loading.value = false;
  }
}

/**
 * 静默重取：不动 loading 骨架（会闪），只拉 meta + 当前页签 + 已打开的会话抽屉。
 *
 * 刻意**不**调 /api/refresh —— 那是"立刻强制重扫"，属于手动按钮的语义；
 * 自动这一路只负责把服务端已经扫好的结果拉下来，两边职责分开。
 */
async function poll() {
  syncDayBoundary(); // 跨零点：poll 每拍与 visibilitychange 回前台都会经过这里
  if (document.hidden) return; // 切到后台就停，回来时补一拍
  if (loading.value) return; // 上一拍还没回来（比如刚点过刷新），跳过
  if (pollInFlight) return; // 定时器与 visibilitychange 补拍撞在一起时也只跑一次
  pollInFlight = true;
  try {
    const next = await api.meta();
    meta.value = next;
    pollStale.value = false;
    // 稳定态仍只花一个 /api/meta；但「上一拍失败 / 目标还没同步」不属于稳定态，
    // 即使 revision 没变也必须补拍，否则一次短暂 503 就会让页面永久停在旧数据。
    // 这里刻意不调 sanitizeFilter：poll 每拍都跑，若在此改 filter 会再触发
    // 各视图 watch 取数形成请求链。渐进补全期间的 sanitize 只在 loadMeta() /
    // refresh() 做，行为差异见 useFilterStorage.sanitizeFilter 的注释。
    if (next.revision === lastRevision && !needsRetry()) return;
    if (await syncData()) lastRevision = next.revision ?? -1;
  } catch (e) {
    pollStale.value = true;
    /* 网络抖动跳过这一拍，下一拍再试；不要把页面顶成错误态，但要留痕 */
    console.warn('[自动刷新] 本拍取数失败，保留上一拍数据：', e);
  } finally {
    pollInFlight = false;
    for (const resolve of pollWaiters) resolve();
    pollWaiters.clear();
  }
}

/** 从后台切回前台立刻补一拍，省得干等满一个周期 */
function onVisibilityChange() {
  if (!document.hidden) poll();
}

/* poll 只刷新当前页签；切到另一个已挂载页签时必须主动补齐，不能等下一次数据变更。 */
watch(tab, () => {
  currentView()?.reload();
});

onMounted(() => {
  loadMeta();
  timer = setInterval(poll, AUTO_REFRESH_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
  clearInterval(timer);
  clearTimeout(saveTimer);
  clearTimeout(historyTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

/**
 * 筛选条件存盘。
 * 关键词是逐字符改的，debounce 一下，别每个按键都写一次 localStorage。
 * 粒度被自动兜正（下面那个 watch）也会走这里，正好把兜正后的结果一并存下来。
 */
watch(
  filter,
  (f) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveFilter(f), 300);
  },
  { deep: true },
);

/**
 * 粒度跟区间绑定：区间一变，原来选中的粒度可能就不适用了
 * （从"近 7 天"切到"今天"，按天只剩 1 根柱子）。
 * 在这里统一兜正，省得用户改完区间还要手动再点一次粒度。
 * 阈值口径与禁用哪些档位都在 utils/granularity.js，FilterBar 共用同一套。
 * meta.minTs 后端已保证稳定，这里不新增依赖它的额外请求。
 */
watch(
  () => [filter.value.from, filter.value.to, filter.value.granularity, meta.value.minTs],
  () => {
    const next = pickGranularity(spanDaysOf(filter.value, meta.value), filter.value.granularity);
    if (next !== filter.value.granularity) filter.value = { ...filter.value, granularity: next };
  },
  { immediate: true },
);
</script>

<template>
  <!-- 阶段 2：左侧固定导航栏 (Sidebar) + 右侧 100% 自适应全宽工作台 -->
  <div class="app">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand">
          <div class="logo" role="img" aria-label="品牌头像" />
          <div class="brand-text">
            <div class="brand-title">WorkBuddy Token 用量看板</div>
            <div class="brand-sub mono" :title="brandSubText">
              <template v-for="(seg, i) in brandSubSegs" :key="i">{{ seg }}<wbr /></template>
            </div>
          </div>
        </div>
        <button
          class="theme-btn"
          type="button"
          :title="isDark ? '切换为暖砂亮色主题' : '切换为深焙黑曜石暗色主题'"
          @click="toggleTheme"
        >
          {{ isDark ? '🌙' : '☀️' }}
        </button>
      </div>

      <div class="nav-block">
        <div class="nav-label">工作台视图</div>
        <nav class="tabs seg">
          <button
            v-for="t in TABS"
            :key="t.key"
            class="seg-btn tab"
            :class="{ on: tab === t.key }"
            @click="tab = t.key"
          >
            {{ t.label }}
          </button>
        </nav>
      </div>

      <!-- 最近活跃摘要卡：内嵌在左侧栏随时盯盘，同时释放右侧首屏垂直空间 -->
      <div class="active-block">
        <div class="nav-label">实时盯盘</div>
        <ActiveSessionBar
          ref="activeRef"
          :meta="meta"
          @open-session="openSessionId = $event"
        />
      </div>

      <div class="stats">
        <div class="stats-grid">
          <div class="stat">
            <span class="stat-k">累计请求</span>
            <span class="stat-v num">{{ fmtNum(meta.recordCount || 0) }}</span>
          </div>
          <div class="stat">
            <span class="stat-k">累计会话</span>
            <span class="stat-v num">{{ fmtNum(meta.sessionCount || 0) }}</span>
          </div>
        </div>
        <div class="stats-foot">
          <span class="dot" title="解析服务正常" />
          <span class="auto-hint" title="页面每 5 秒自动拉取最新数据（切到后台会暂停）">自动刷新 5s</span>
          <span class="scan-at num mono">{{ meta.lastScanAt ? fmtTime(meta.lastScanAt, false) : '-' }}</span>
        </div>
      </div>
    </aside>

    <!-- 右侧全宽自适应主工作台 -->
    <div class="workspace">
      <section class="toolbar">
        <FilterBar
          :filter="filter"
          :meta="meta"
          :loading="loading"
          :restored="restoredHint"
          @update:filter="onFilter"
          @dismiss-restored="restoredHint = false"
          @refresh="refresh"
        />
        <!-- 状态提示统一容器：stale 优先于历史加载 / 失败提示，避免互抢 -->
        <div v-if="banner" class="status-banner glass" :class="'sb-' + banner.kind">
          <span v-if="banner.kind === 'loading'" data-testid="history-loading">{{ banner.text }}</span>
          <span v-else>{{ banner.text }}</span>
        </div>
      </section>

      <!-- 内容（直接子元素严格保持 [0]=总览、[1]=会话、[2]=明细） -->
      <main class="content">
        <Overview
          v-show="tab === 'overview'"
          ref="overviewRef"
          :filter="filter"
          :meta="meta"
          @open-session="openSessionId = $event"
        />
        <Sessions
          v-show="tab === 'sessions'"
          ref="sessionsRef"
          :filter="filter"
          @open-session="openSessionId = $event"
        />
        <Requests
          v-show="tab === 'requests'"
          ref="requestsRef"
          :filter="filter"
          @open-session="openSessionId = $event"
        />
      </main>
    </div>
  </div>

  <SessionDrawer
    v-if="openSessionId"
    ref="drawerRef"
    :session-id="openSessionId"
    @close="openSessionId = ''"
  />
</template>

<style scoped>
/* 全局左右分栏骨架：左侧固定 252px 侧栏 + 右侧 100% 自适应全宽工作台（不写死 max-width，2K 大屏自动铺满） */
.app {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 252px minmax(0, 1fr);
  min-height: 100vh;
  width: 100%;
}

/* ---------- 左侧固定导航栏 (Sidebar) ---------- */
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-hairline);
  padding: 16px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.brand-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

/*
 * 桌面窄侧栏（252px）：品牌区改为「头像 + 主题钮」一行 + 标题/路径整行铺开，
 * 标题单行完整显示，路径沿分隔符换行铺开 —— 不再省略折叠（窄屏 ≤1180px 时回落单行内联）。
 */
.brand {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
  flex: 1;
}

/* 品牌图标：src/assets/logo.jpg（罐装啤酒少女，900×900 方图） */
.logo {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--radius-sm);
  background-color: var(--accent);
  background-image: url('./assets/logo.jpg');
  background-size: cover;
  background-position: 50% 50%;
  box-shadow: 0 3px 10px -3px var(--accent-glow);
}

.brand-text {
  min-width: 0;
  flex: 1 0 100%; /* 独占整行：文字铺开到头像下方的全宽 */
}

.brand-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: -0.1px;
  white-space: normal;
  word-break: keep-all; /* 需要换行时断在「Token」与「用量看板」之间 */
  line-height: 1.35;
}

.brand-sub {
  font-size: 10px;
  color: var(--text-3);
  margin-top: 2px;
  white-space: normal;
  overflow-wrap: break-word; /* 路径按 <wbr> 分段换行铺开，不再省略折叠 */
  line-height: 1.55;
}

.theme-btn {
  width: 30px;
  height: 30px;
  flex: none;
  margin-top: 2px; /* 与 34px 头像光学居中对齐 */
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-2);
  cursor: pointer;
  display: grid;
  place-items: center;
  font-size: 13px;
  transition: border-color 0.15s, background 0.15s;
}

.theme-btn:hover {
  border-color: var(--accent);
  background: var(--bg-elevated);
}

.nav-block,
.active-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nav-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 0 4px;
}

/* 侧栏竖向导航菜单（保持 .tabs.seg 与 .seg-btn.tab 选择器） */
.tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
}

.tabs .tab {
  position: relative;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  font-size: 12.5px;
  font-weight: 500;
  text-align: left;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  color: var(--text-2);
}

.tabs .tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.tabs .tab.on {
  background: var(--bg-surface);
  border-color: var(--border-hairline);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.tabs .tab.on::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 7px;
  bottom: 7px;
  width: 3.5px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

/* 侧栏底部服务状态与全局统计 */
.stats {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--border-hairline);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.stat {
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-xs);
  padding: 6px 9px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.stat-k {
  font-size: 10px;
  color: var(--text-3);
}

.stat-v {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.stats-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 2px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-ring);
  flex: none;
}

.auto-hint {
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
}

.scan-at {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-3);
}

/* ---------- 右侧主工作台（100% 自适应全宽，不限死最大宽度） ---------- */
.workspace {
  min-width: 0;
  width: 100%;
  padding: 16px 24px 36px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100vh;
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.status-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  color: var(--text-2);
  border: 1px solid var(--border-hairline);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}

.status-banner.sb-loading {
  border-left: 3px solid var(--accent);
  color: var(--accent);
}

.status-banner.sb-stale,
.status-banner.sb-failed {
  border-left: 3px solid var(--warn);
  color: var(--warn);
}

.content {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

/* 窄屏（含 E2E 的 1150px 窄屏测试）自动折叠为上下结构，保证主内容有充足宽度 */
@media (max-width: 1180px) {
  .app {
    grid-template-columns: 1fr;
  }
  .sidebar {
    position: relative;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--border-hairline);
    padding: 12px 18px;
    gap: 10px;
  }
  /* 顶栏横排：宽度充裕，品牌区回落「头像 | 文字 | 主题钮」单行内联 */
  .brand-row {
    align-items: center;
  }
  .brand {
    flex-wrap: nowrap;
    align-items: center;
    gap: 10px;
  }
  .brand-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .theme-btn {
    margin-top: 0;
  }
  .tabs {
    flex-direction: row;
  }
  .tabs .tab {
    width: auto;
    padding: 0 16px;
    height: 30px;
  }
  .tabs .tab.on::before {
    display: none;
  }
  .stats {
    margin-top: 0;
    padding-top: 8px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
  .stats-grid {
    display: flex;
    gap: 12px;
  }
  .workspace {
    padding: 14px 18px 32px;
    min-height: auto;
  }
}
</style>
