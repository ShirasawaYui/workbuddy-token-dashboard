<script setup>
defineProps({
  label: String,
  value: String,
  sub: String,
  accent: { type: String, default: '' },
  progress: { type: Number, default: null },
  icon: { type: String, default: '' },
  hero: { type: Boolean, default: false },
});
</script>

<template>
  <!--
    进度条槽位**永远占位**（没有数据时 visibility: hidden）。
    恒占位配合 CSS Grid 的 grid-auto-rows: 1fr，保证窄屏多排时所有卡片严格等高。
    阶段 2：修掉原右上角 currentColor 黑灰脏斑，改为 XTHUB 风格的左侧 3.5px 利落彩色竖条。
  -->
  <div
    class="kpi glass"
    :class="{ 'is-hero': hero }"
    :style="{ '--kpi-color': accent || 'var(--accent)' }"
  >
    <div class="kpi-top">
      <span class="kpi-label">{{ label }}</span>
      <span class="kpi-orb" :style="{ background: accent || 'var(--accent)' }" />
    </div>
    <div class="kpi-value num" :style="accent ? { color: accent } : null">{{ value }}</div>
    <div class="kpi-sub num">{{ sub }}</div>
    <div class="bar" :style="{ marginTop: '9px', visibility: progress == null ? 'hidden' : 'visible' }">
      <i
        v-if="progress != null"
        :style="{
          width: Math.min(100, progress * 100) + '%',
          background: accent || 'var(--accent)',
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.kpi {
  position: relative;
  padding: 13px 15px 15px 17px;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s, border-color 0.2s;
}

.kpi:hover {
  transform: translateY(-1.5px);
  box-shadow: var(--shadow-lg);
  border-color: var(--border-strong);
}

/* XTHUB 式左侧彩色指示竖条，干净利落，无灰黑脏印 */
.kpi::before {
  content: '';
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3.5px;
  border-radius: 0 3px 3px 0;
  background: var(--kpi-color, var(--accent));
}

.kpi.is-hero {
  background: linear-gradient(135deg, var(--accent-soft), var(--bg-surface) 68%);
  border-color: var(--accent-edge);
}

.kpi-top {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.kpi-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.2px;
}

.kpi-orb {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  opacity: 0.9;
}

.kpi-value {
  font-size: 24px;
  font-weight: 700;
  margin: 6px 0 3px;
  line-height: 1.12;
  letter-spacing: -0.5px;
  position: relative;
  z-index: 1;
  color: var(--text);
}

.kpi-sub {
  font-size: 11px;
  color: var(--text-3);
  position: relative;
  z-index: 1;
}
</style>
