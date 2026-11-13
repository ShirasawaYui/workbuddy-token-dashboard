<script setup>
/**
 * 明细列表顶部的时间排序 Tag。
 *
 * 交互与会话列表的可点击列头保持一致：点一下在正序 / 逆序之间切换，
 * 控件本身用 ↓ / ↑ 加中文状态把「当前是什么顺序」写明，不靠颜色猜。
 * 两个使用点（会话抽屉「逐次请求明细」、工作台「明细」版面）共用这一个组件，
 * 保证外观、文案、data-* 契约完全相同。
 */
import { computed } from 'vue';
import { isDesc } from '../utils/sortOrder.js';

const props = defineProps({
  /** 'desc' 时间逆序（最新在前） | 'asc' 时间正序（最早在前） */
  order: { type: String, default: 'desc' },
  label: { type: String, default: '时间' },
});
const emit = defineEmits(['toggle']);

const desc = computed(() => isDesc(props.order));
const arrow = computed(() => (desc.value ? '↓' : '↑'));
const state = computed(() => (desc.value ? '最新在前' : '最早在前'));
const hint = computed(
  () =>
    `当前按${props.label}${state.value}（${desc.value ? '逆序' : '正序'}）；点击切换为` +
    (desc.value ? '正序（最早在前）' : '逆序（最新在前）'),
);
</script>

<template>
  <button
    class="tag sort-tag"
    type="button"
    data-testid="sort-order"
    :data-order="desc ? 'desc' : 'asc'"
    :title="hint"
    :aria-label="hint"
    @click="emit('toggle')"
  >
    <span class="sort-label">{{ label }} {{ arrow }}</span>
    <span class="sort-state">{{ state }}</span>
  </button>
</template>

<style scoped>
/* .tag 提供胶囊底色 / 描边 / 字号；这里只补按钮语义与点击反馈 */
.sort-tag {
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  flex: none;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.sort-tag:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-sm);
}
.sort-tag:active {
  transform: translateY(1px);
}
.sort-tag:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sort-label {
  font-weight: 600;
}
.sort-state {
  font-weight: 400;
  opacity: 0.78;
}
</style>
