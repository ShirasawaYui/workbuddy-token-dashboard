<script setup>
/**
 * 会话内的「本轮卡片 + 轮次列表 + 展开明细」。
 *
 * 设计约束（来自执行计划第 6 步）：
 *  - 不新增第二套轮询：整个组件只吃 SessionDrawer 传进来的 data，
 *    抽屉原有的 silentReload() 每次成功都会让这里响应式更新。
 *  - 长会话不铺全量 DOM：轮次列表和展开明细都走定高虚拟窗口，
 *    DOM 行数只跟视口高度有关，跟会话长度无关。
 *  - 不复用 .kpi：抽屉累计 KPI 恰好 6 张是既有 E2E 断言，
 *    本轮指标用 .turn-metric，避免两套数字混在一起。
 *  - 所有文本走 Vue 插值（自动转义），不用 v-html。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { fmtCompact, fmtNum, fmtCredit, fmtTime } from '../utils/format.js';
import {
  isActiveTurn,
  hitRateText,
  turnLabel,
  stepsOfTurn,
  virtualWindow,
  turnCardState,
} from '../utils/turnView.js';

const props = defineProps({
  /** /api/session 的完整响应 */
  data: { type: Object, default: null },
  /** 最近一次静默刷新失败：保留上一拍数据，但必须明确告知 */
  stale: { type: Boolean, default: false },
});
const emit = defineEmits(['locate']);

const TURN_ROW_H = 38;
const STEP_ROW_H = 30;
const OVERSCAN = 6;

const turns = computed(() => props.data?.turns || []);
const turnTotal = computed(() => props.data?.turnTotal || 0);
const steps = computed(() => props.data?.steps || []);
const summary = computed(() => props.data?.turnSummary || {});
const truncated = computed(() => !!props.data?.turnTruncated);
const card = computed(() => turnCardState(props.data));
const maxTurnTotal = computed(() => Math.max(1, ...turns.value.map((t) => t.total)));

/** 服务端只返回最近 N 轮时，可见行的序号必须接着被裁掉的那部分往下数 */
const hiddenBefore = computed(() => Math.max(0, turnTotal.value - turns.value.length));
function labelOf(i) {
  return turnLabel(turns.value[i], hiddenBefore.value + i);
}

/* ---------- 轮次选中与展开 ---------- */
const selectedKey = ref('');
watch(
  () => props.data?.sessionId,
  () => {
    // 换会话必须主动归零两个窗口，不能依赖父组件把 data 置 null 来卸载本组件。
    // 残留的大 scrollTop 会被 virtualWindow 夹到列表末尾，导致轮次列表整片空白。
    resetWindows();
  },
);
watch(
  () => props.data?.turns,
  (list) => {
    // 该轮被 turnLimit 裁掉、或数据集换了，就收起明细；否则保持选中，
    // 这样 live 追加时展开着的那一轮会随刷新一起长出新请求。
    if (selectedKey.value && !(list || []).some((t) => t.turnKey === selectedKey.value)) {
      selectedKey.value = '';
    }
    // 服务端按尾部裁剪（turnLimit），列表变短时旧 scrollTop 可能已越过末尾；
    // 浏览器自动收缩 scrollTop 不保证触发 scroll 事件，这里主动夹回合法范围。
    const n = list?.length || 0;
    const maxTop = Math.max(0, n * TURN_ROW_H + 60 - listViewH.value);
    if (listScrollTop.value > maxTop) {
      listScrollTop.value = maxTop;
      if (listEl.value) listEl.value.scrollTop = maxTop;
    }
  },
);
const selectedTurn = computed(() => turns.value.find((t) => t.turnKey === selectedKey.value) || null);
const selectedIndex = computed(() => turns.value.findIndex((t) => t.turnKey === selectedKey.value));
const turnSteps = computed(() => stepsOfTurn(steps.value, selectedKey.value));
function toggle(key) {
  selectedKey.value = selectedKey.value === key ? '' : key;
}

/* ---------- 两个定高虚拟窗口 ----------
 * 用同一个 observer 管理器：展开明细是 v-if，选中/收起时 DOM 会挂载/卸载，
 * watch(ref) 负责在每次挂载后重新实测视口高度并接上 ResizeObserver。
 */
const observers = new Map();
function observeHeight(elRef, viewHRef) {
  watch(elRef, (el) => {
    const prev = observers.get(elRef);
    if (prev) {
      prev.disconnect();
      observers.delete(elRef);
    }
    if (!el) return;
    const measure = () => {
      viewHRef.value = el.clientHeight || viewHRef.value;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observers.set(elRef, ro);
  });
}
onBeforeUnmount(() => {
  for (const ro of observers.values()) ro.disconnect();
  observers.clear();
});

const listEl = ref(null);
const listViewH = ref(300);
const listScrollTop = ref(0);
observeHeight(listEl, listViewH);
const listWin = computed(() =>
  virtualWindow(turns.value.length, listScrollTop.value, listViewH.value, TURN_ROW_H, OVERSCAN),
);
const visibleTurns = computed(() => turns.value.slice(listWin.value.start, listWin.value.end));
function onListScroll(e) {
  listScrollTop.value = e.target.scrollTop;
}

const detailEl = ref(null);
const detailViewH = ref(220);
const detailScrollTop = ref(0);
observeHeight(detailEl, detailViewH);
const detailWin = computed(() =>
  virtualWindow(turnSteps.value.length, detailScrollTop.value, detailViewH.value, STEP_ROW_H, OVERSCAN),
);
const visibleTurnSteps = computed(() => turnSteps.value.slice(detailWin.value.start, detailWin.value.end));
function onDetailScroll(e) {
  detailScrollTop.value = e.target.scrollTop;
}
watch(selectedKey, () => {
  detailScrollTop.value = 0;
  if (detailEl.value) detailEl.value.scrollTop = 0;
});

/** 换会话 / 数据集整体替换时，把选中与两个窗口都拉回初始状态。
 *  函数声明会被提升到模块顶部，供上面的 watch(sessionId) 调用。 */
function resetWindows() {
  selectedKey.value = '';
  listScrollTop.value = 0;
  detailScrollTop.value = 0;
  if (listEl.value) listEl.value.scrollTop = 0;
  if (detailEl.value) detailEl.value.scrollTop = 0;
}
</script>

<template>
  <section class="turn-section">
    <!-- 静默刷新失败：数据还在，但不能让人误以为它是实时的 -->
    <div v-if="stale" class="turn-alert">
      自动刷新未成功，下方显示上一次成功获取的数据（抽屉仍会在下一拍重试）。
    </div>

    <!-- ① 本轮摘要 -->
    <div class="panel turn-current">
      <div class="tc-head">
        <div>
          <div class="panel-title">本轮用量</div>
          <div class="panel-sub">
            {{ card.status === 'ok' ? card.label + ' · 最近更新的轮次' : '按 traceId 聚合一次提问后的全部模型请求' }}
          </div>
        </div>
        <div class="tc-flags">
          <span v-if="card.status === 'ok'" class="tag" :class="{ gray: !card.active }">
            {{ card.active ? '活跃 · 最近更新' : '最近一轮' }}
          </span>
          <span v-if="card.orphanTurns" class="tag warn">{{ card.orphanTurns }} 个未归属请求</span>
        </div>
      </div>

      <div v-if="card.status === 'loading'" class="tc-empty">正在读取轮次数据…</div>
      <div v-else-if="card.status === 'empty'" class="tc-empty">
        该会话暂无轮次数据。
      </div>
      <div v-else-if="card.status === 'ok'" class="tc-metrics">
        <div class="turn-metric" data-k="prompt">
          <span>输入</span><b class="num">{{ fmtCompact(card.turn.prompt) }}</b>
          <i>含缓存命中部分</i>
        </div>
        <div class="turn-metric" data-k="completion">
          <span>输出</span><b class="num">{{ fmtCompact(card.turn.completion) }}</b>
          <i>思考 {{ fmtCompact(card.turn.reasoning) }}</i>
        </div>
        <div class="turn-metric" data-k="hitRate">
          <span>缓存命中率</span><b class="num">{{ hitRateText(card.turn) }}</b>
          <i>命中 {{ fmtCompact(card.turn.cacheRead) }}</i>
        </div>
        <div class="turn-metric" data-k="credit">
          <span>消耗积分</span><b class="num">{{ fmtCredit(card.turn.credit) }}</b>
          <i>平台 credit 实测值</i>
        </div>
        <div class="turn-metric" data-k="requests">
          <span>请求</span><b class="num">{{ fmtNum(card.turn.requests) }}</b>
          <i>工具调用 {{ fmtNum(card.turn.toolCalls) }} 次</i>
        </div>
        <div class="turn-metric" data-k="total">
          <span>总 Token</span><b class="num">{{ fmtCompact(card.turn.total) }}</b>
          <i>输入 + 输出</i>
        </div>
      </div>
      <div v-else class="tc-empty">轮次数据暂不可用。</div>
      <div v-if="card.status === 'ok'" class="tc-foot">
        {{ fmtTime(card.turn.startTs) }} — {{ fmtTime(card.turn.endTs, false) }}
        <span v-if="card.turn.models?.length"> · {{ card.turn.models.join('、') }}</span>
        <span v-if="card.active"> · 该轮可能仍在写入，数字会继续增长</span>
      </div>
    </div>

    <!-- ② 会话内轮次列表 -->
    <div class="panel turn-panel" :data-turn-total="turnTotal">
      <div class="panel-head">
        <div>
          <div class="panel-title">会话轮次</div>
          <div class="panel-sub">
            共 {{ fmtNum(turnTotal) }} 轮 / {{ fmtNum(summary.requests) }} 次请求
            <span v-if="summary.orphanTurns"> · {{ summary.orphanTurns }} 轮缺少 traceId，已各自独立</span>
            <span v-if="truncated"> · 列表仅显示最近 {{ turns.length }} 轮，汇总仍覆盖全部</span>
          </div>
        </div>
        <span class="tc-hint">点任意一轮展开逐请求明细</span>
      </div>

      <div v-if="!turns.length" class="tc-empty">暂无轮次数据</div>
      <div v-else ref="listEl" class="scroll turn-scroll" @scroll.passive="onListScroll">
        <table class="turn-table">
          <thead>
            <tr>
              <th style="width: 44px">#</th>
              <th style="width: 132px">轮次</th>
              <th style="width: 92px">开始</th>
              <th class="right" style="width: 62px">请求</th>
              <th class="right">输入</th>
              <th class="right">命中率</th>
              <th class="right">输出</th>
              <th class="right" style="width: 92px">credit</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="listWin.padTop > 0" class="vpad" :style="{ height: listWin.padTop + 'px' }">
              <td colspan="8" />
            </tr>
            <tr
              v-for="(t, i) in visibleTurns"
              :key="t.turnKey"
              class="turn-row"
              :class="{ on: t.turnKey === selectedKey, latest: t.turnKey === card.turn?.turnKey }"
              @click="toggle(t.turnKey)"
            >
              <td class="num muted">{{ listWin.start + i + 1 }}</td>
              <td>
                <div class="turn-name">
                  <span>{{ labelOf(listWin.start + i) }}</span>
                  <span v-if="t.isOrphan" class="tag warn">未归属</span>
                  <span v-else-if="isActiveTurn(t)" class="tag">活跃</span>
                </div>
                <div class="turn-id mono" :title="t.turnId">{{ t.turnId }}</div>
              </td>
              <td class="num muted">{{ fmtTime(t.startTs, false) }}</td>
              <td class="right num">{{ fmtNum(t.requests) }}</td>
              <td class="right num">
                {{ fmtCompact(t.prompt) }}
                <!-- 占比条属于「这一行这一轮」，随虚拟窗口一起只渲染可见行；
                     放在 td 内而不是表格外的图例，滚动时不会张冠李戴。 -->
                <span class="turn-share" :title="'该轮总 Token ' + fmtCompact(t.total)">
                  <i :style="{ width: Math.max(2, (t.total / maxTurnTotal) * 100) + '%' }" />
                </span>
              </td>
              <td class="right num">{{ hitRateText(t) }}</td>
              <td class="right num">{{ fmtCompact(t.completion) }}</td>
              <td class="right num"><b>{{ fmtCredit(t.credit) }}</b></td>
            </tr>
            <tr v-if="listWin.padBottom > 0" class="vpad" :style="{ height: listWin.padBottom + 'px' }">
              <td colspan="8" />
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ③ 展开的逐请求明细（同样窗口化） -->
      <div v-if="selectedTurn" class="turn-detail">
        <div class="td-head">
          <div>
            <div class="panel-title">
              {{ labelOf(selectedIndex) }} · 逐请求明细
              <span class="muted">（{{ turnSteps.length }} 次）</span>
            </div>
            <div class="panel-sub">
              输入 {{ fmtCompact(selectedTurn.prompt) }} · 输出 {{ fmtCompact(selectedTurn.completion) }}
              · 命中率 {{ hitRateText(selectedTurn) }} · 积分 {{ fmtCredit(selectedTurn.credit) }}
            </div>
          </div>
          <div class="td-actions">
            <button class="btn" @click="emit('locate', selectedKey)">在完整明细中定位</button>
            <button class="btn ghost" @click="selectedKey = ''">收起</button>
          </div>
        </div>
        <div ref="detailEl" class="scroll detail-scroll" @scroll.passive="onDetailScroll">
          <table class="detail-table">
            <thead>
              <tr>
                <th style="width: 40px">#</th>
                <th style="width: 92px">时间</th>
                <th>类型</th>
                <th>工具</th>
                <th>模型</th>
                <th class="right">输入</th>
                <th class="right">命中率</th>
                <th class="right">credit</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="detailWin.padTop > 0" class="vpad" :style="{ height: detailWin.padTop + 'px' }">
                <td colspan="8" />
              </tr>
              <tr v-for="(r, i) in visibleTurnSteps" :key="r.id">
                <td class="num muted">{{ detailWin.start + i + 1 }}</td>
                <td class="num muted">{{ fmtTime(r.ts, false) }}</td>
                <td><span class="tag gray">{{ r.kind }}</span></td>
                <td><span v-if="r.toolName" class="tag">{{ r.toolName }}</span><span v-else class="muted">—</span></td>
                <td class="mono">{{ r.model }}</td>
                <td class="right num">{{ fmtNum(r.prompt) }}</td>
                <td class="right num">{{ hitRateText(r) }}</td>
                <td class="right num"><b>{{ fmtCredit(r.credit) }}</b></td>
              </tr>
              <tr v-if="detailWin.padBottom > 0" class="vpad" :style="{ height: detailWin.padBottom + 'px' }">
                <td colspan="8" />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.turn-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.turn-alert {
  padding: 9px 13px;
  border: 1px solid var(--amber-edge);
  background: var(--amber-soft);
  border-radius: var(--radius-sm);
  color: var(--amber);
  font-size: 11.5px;
}

.turn-section :deep(.panel) {
  background: var(--bg-surface);
}

.turn-current {
  border-left: 3.5px solid var(--accent);
}

.tc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 18px 10px;
}
.tc-flags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.tc-hint {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}

.tc-metrics {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  padding: 4px 18px 10px;
}
.turn-metric {
  min-width: 0;
  padding: 9px 11px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.turn-metric[data-k='credit'] {
  background: var(--accent-soft);
  border-color: var(--accent-edge);
}
.turn-metric > span {
  font-size: 10.5px;
  color: var(--text-3);
  letter-spacing: 0.2px;
}
.turn-metric > b {
  font-size: 17px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.turn-metric[data-k='credit'] > b {
  color: var(--accent);
}
.turn-metric > i {
  font-size: 10px;
  font-style: normal;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tc-foot {
  padding: 0 18px 13px;
  font-size: 10.5px;
  color: var(--text-3);
}
.tc-empty {
  padding: 26px 18px 30px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}

/* ---------- 轮次表：行高固定是虚拟化的前提 ---------- */
.turn-scroll {
  max-height: 300px;
}
.turn-table,
.detail-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.turn-table th,
.detail-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--thead-bg);
  font-weight: 600;
  font-size: 10.5px;
  color: var(--text-2);
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-hairline);
}
.turn-table th.right,
.detail-table th.right {
  text-align: right;
}
.turn-table td,
.detail-table td {
  padding: 0 10px;
  font-size: 11.5px;
  border-bottom: 1px solid var(--border-hairline);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.turn-table td {
  height: 38px;
}
.detail-table td {
  height: 30px;
}
.turn-table tr.vpad td,
.detail-table tr.vpad td,
.turn-table tr.vpad:hover td,
.detail-table tr.vpad:hover td {
  padding: 0;
  border: none;
  background: none;
}
.turn-row {
  cursor: pointer;
  transition: background 0.15s;
}
.turn-row:hover {
  background: var(--bg-hover);
}
.turn-row.on {
  background: var(--accent-soft);
}
.turn-row.latest {
  box-shadow: inset 3px 0 0 var(--accent);
}
.turn-name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
}
.turn-name .tag {
  padding: 0 5px;
  font-size: 9.5px;
  flex: none;
}
.turn-id {
  color: var(--text-3);
  font-size: 9.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.turn-share {
  display: block;
  height: 3px;
  margin-top: 2px;
  border-radius: 2px;
  background: var(--bg-subtle);
  overflow: hidden;
}
.turn-share > i {
  display: block;
  height: 100%;
  margin-left: auto;
  border-radius: 2px;
  background: var(--teal);
}

/* ---------- 展开明细 ---------- */
.turn-detail {
  border-top: 1px solid var(--border-hairline);
  background: var(--bg-subtle);
}
.td-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px 10px;
}
.td-actions {
  display: flex;
  gap: 6px;
  flex: none;
}
.td-actions .btn {
  height: 27px;
  padding: 0 10px;
  font-size: 11px;
}
.detail-scroll {
  max-height: 220px;
  margin: 0 12px 14px;
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}

@media (max-width: 900px) {
  .tc-metrics {
    grid-template-columns: repeat(3, 1fr);
  }
  .tc-head,
  .td-head {
    flex-direction: column;
  }
  .tc-flags {
    justify-content: flex-start;
  }
}
</style>
