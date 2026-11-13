<script setup>
/**
 * 「最近活跃」摘要卡（第 7 步 + 阶段 2 侧边栏内嵌升级）。
 *
 * 定位：内嵌在左侧固定导航栏中，无论用户在总览、会话还是明细页，
 * 都能实时盯住最近被写入的会话消耗；详情仍复用会话抽屉。
 *
 * 语义边界：本地 JSONL 里没有 WorkBuddy 前台窗口信号，
 * 因此这里一律叫「最近活跃」，指的是最后被写入的会话文件，
 * 绝不叫「当前打开」。并发多个会话时提供「固定」让用户自己锁定。
 */
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';
import { fmtNum, fmtCredit, fmtTime } from '../utils/format.js';

const props = defineProps({
  /** /api/meta 的完整响应 */
  meta: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['open-session']);

const KEY = 'wb-token-dashboard:active-session:v1';
function loadMode() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      follow: o.follow !== false,
      pinned: typeof o.pinned === 'string' ? o.pinned : '',
    };
  } catch {
    return { follow: true, pinned: '' };
  }
}
const saved = loadMode();
const followMode = ref(saved.follow);
const pinnedSessionId = ref(saved.pinned);
if (!followMode.value && !pinnedSessionId.value) followMode.value = true;
watch([followMode, pinnedSessionId], () => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ follow: followMode.value, pinned: pinnedSessionId.value }));
  } catch {
    /* 隐私模式下写不了 localStorage，不影响本轮使用 */
  }
});

const targetId = computed(() =>
  followMode.value ? props.meta?.latestActiveSessionId || '' : pinnedSessionId.value,
);
/** 固定模式下，别的会话又变活跃了：给一句可见交代，但不抢走视图 */
const drifted = computed(() =>
  !followMode.value && props.meta?.latestActiveSessionId &&
  props.meta.latestActiveSessionId !== targetId.value
    ? props.meta.latestActiveSessionId
    : '',
);

const data = ref(null);
const error = ref('');
let lastKey = '';
let lastAt = 0;
let requestVersion = 0;

async function reload(force = false) {
  const id = targetId.value;
  if (!id) {
    requestVersion += 1;
    data.value = null;
    error.value = '';
    return true;
  }
  const now = Date.now();
  if (!force && lastKey === id && now - lastAt < 1000) return true;
  lastKey = id;
  lastAt = now;
  const version = ++requestVersion;
  try {
    const next = await api.sessionDetail({ sessionId: id });
    if (version !== requestVersion || targetId.value !== id) return false;
    data.value = next;
    error.value = '';
    return true;
  } catch (e) {
    if (version === requestVersion) {
      error.value = e.message;
      console.warn('[最近活跃] 取数失败，保留上一拍数据：', e);
    }
    return false;
  }
}
watch(targetId, () => reload(true), { immediate: true });
defineExpose({
  reload,
  needsRetry: () => !!(error.value || (targetId.value && data.value?.sessionId !== targetId.value)),
});

const hasNumbers = computed(() => {
  const d = data.value;
  if (!d) return false;
  return (d.summary?.requests || 0) > 0 || (d.turnTotal || 0) > 0;
});
const title = computed(
  () => data.value?.meta?.title || props.meta?.latestActive?.title || targetId.value || '—',
);
const project = computed(
  () => data.value?.meta?.cwd || props.meta?.latestActive?.cwd || props.meta?.latestActive?.projectId || '',
);
const activityTs = computed(() => {
  const d = data.value;
  if (!d) return 0;
  if (d.latestTurn?.endTs) return d.latestTurn.endTs;
  const steps = d.steps || [];
  return steps.length ? steps[steps.length - 1].ts : 0;
});

function pin() {
  if (!targetId.value) return;
  pinnedSessionId.value = targetId.value;
  followMode.value = false;
}
</script>

<template>
  <div class="active-bar" :data-mode="followMode ? 'follow' : 'pinned'" :data-session-id="targetId">
    <div class="as-head">
      <span class="as-dot" :class="{ pinned: !followMode }" />
      <span class="as-title">最近活跃</span>
      <span class="tag" :class="{ teal: followMode, warn: !followMode }">{{ followMode ? '跟随中' : '已固定' }}</span>
      <span class="as-hint" title="依据本地日志最后写入时间，并非 WorkBuddy 前台窗口信号">最后写入会话</span>
    </div>

    <div v-if="!targetId" class="as-empty">
      暂无活跃会话（还没有产生任何对话记录）。
    </div>
    <div v-else-if="error && !data" class="as-empty">读取失败：{{ error }}</div>
    <div v-else-if="!data" class="as-empty">正在读取会话用量…</div>
    <div v-else-if="!hasNumbers" class="as-empty">
      {{ title }} 尚无用量记录（会话可能刚创建，还没有结算请求）。
    </div>
    <div v-else class="as-body">
      <div class="as-who">
        <div class="as-name" :title="targetId">{{ title }}</div>
        <div class="as-meta mono">
          <span v-if="project">{{ project }} · </span>{{ activityTs ? fmtTime(activityTs, false) : '-' }}
          <span v-if="drifted"> · 最近活跃已切到 {{ drifted.slice(0, 12) }}（已固定，不跟随）</span>
          <span v-if="error" class="as-stale"> · 自动刷新未成功，显示上一拍数据</span>
        </div>
      </div>
      <div class="as-metrics">
        <div class="as-metric highlight" data-k="turnCredit">
          <span>本轮积分</span><b class="num">{{ fmtCredit(data.latestTurn?.credit ?? 0) }}</b>
        </div>
        <div class="as-metric" data-k="credit">
          <span>累计积分</span><b class="num">{{ fmtCredit(data.summary?.credit ?? 0) }}</b>
        </div>
        <div class="as-metric" data-k="requests">
          <span>请求</span><b class="num">{{ fmtNum(data.summary?.requests ?? 0) }}</b>
        </div>
        <div class="as-metric" data-k="turns">
          <span>轮次</span><b class="num">{{ fmtNum(data.turnTotal ?? 0) }}</b>
        </div>
      </div>
    </div>

    <div class="as-actions">
      <div class="seg as-switch">
        <button class="seg-btn" :class="{ on: followMode }" @click="followMode = true">跟随最近活跃</button>
        <button class="seg-btn" :class="{ on: !followMode }" :disabled="!targetId" @click="pin">固定此会话</button>
      </div>
      <button class="btn as-detail-btn" :disabled="!targetId" @click="emit('open-session', targetId)">查看详情</button>
    </div>
  </div>
</template>

<style scoped>
.active-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 11px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-hairline);
  border-left: 3.5px solid var(--teal);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}

.active-bar[data-mode='pinned'] {
  border-left-color: var(--amber);
}

.as-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.as-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--teal);
  box-shadow: 0 0 0 3px var(--teal-soft);
  flex: none;
}

.as-dot.pinned {
  background: var(--amber);
  box-shadow: 0 0 0 3px var(--amber-soft);
}

.as-title {
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.as-head .tag {
  padding: 1px 6px;
  font-size: 10px;
}

.as-hint {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.as-empty {
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-3);
  padding: 4px 0;
}

.as-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.as-who {
  min-width: 0;
}

.as-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.as-meta {
  margin-top: 2px;
  color: var(--text-3);
  font-size: 9.5px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.as-stale {
  color: var(--warn);
}

.as-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding-top: 7px;
  border-top: 1px dashed var(--border-hairline);
}

.as-metric {
  padding: 5px 8px;
  border-radius: var(--radius-xs);
  background: var(--bg-subtle);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.as-metric > span {
  font-size: 9.5px;
  color: var(--text-3);
}

.as-metric > b {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.15;
}

.as-metric.highlight {
  background: var(--accent-soft);
  border: 1px solid var(--accent-edge);
}

.as-metric.highlight > b {
  color: var(--accent);
}

.as-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.as-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 100%;
}

.as-switch .seg-btn {
  height: 24px;
  padding: 0 4px;
  font-size: 10.5px;
}

.as-detail-btn {
  width: 100%;
  height: 26px;
  font-size: 11px;
  color: var(--accent);
  border-color: var(--accent-edge);
  background: var(--accent-soft);
  font-weight: 600;
}

.as-detail-btn:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

/* 窄屏回退为横向单条 */
@media (max-width: 1180px) {
  .active-bar {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  .as-body {
    flex: 1;
    flex-direction: row;
    align-items: center;
    gap: 14px;
  }
  .as-who {
    flex: 1;
  }
  .as-metrics {
    display: flex;
    border-top: none;
    padding-top: 0;
  }
  .as-actions {
    flex-direction: row;
    align-items: center;
  }
  .as-switch,
  .as-detail-btn {
    width: auto;
  }
}
</style>
