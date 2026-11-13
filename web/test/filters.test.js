import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RANGES,
  RELATIVE_PRESETS,
  daysAgo,
  toDayStr,
  rangeOfPreset,
} from '../src/utils/ranges.js';
import {
  GRANULARITY_ORDER,
  allowedGranularities,
  pickGranularity,
  spanDaysOf,
} from '../src/utils/granularity.js';
import {
  defaultFilter,
  loadFilter,
  saveFilter,
  clearFilter,
  sanitizeFilter,
} from '../src/composables/useFilterStorage.js';

function installStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}
const KEY = 'wb-token-dashboard:filter:v1';

test('相对区间按本地日历计算，昨天必须是闭区间', () => {
  const y = rangeOfPreset('昨天');
  assert.equal(y.from, toDayStr(daysAgo(1)));
  assert.equal(y.to, toDayStr(daysAgo(1)), '昨天若只给起点会把全部历史算进来');
  assert.deepEqual(rangeOfPreset('今天'), { from: toDayStr(daysAgo(0)), to: '' });
  assert.deepEqual(rangeOfPreset('全部'), { from: '', to: '' });
  assert.equal(RANGES.length, 5);
  assert.ok(RELATIVE_PRESETS.includes('近 7 天'));
});

test('趋势粒度由跨度决定，不可用时选最接近的可用档', () => {
  assert.deepEqual(allowedGranularities(0.5), ['hour']);
  assert.deepEqual(allowedGranularities(7), ['day']);
  assert.deepEqual(allowedGranularities(60), ['day', 'month']);
  assert.deepEqual(allowedGranularities(Number.NaN), [...GRANULARITY_ORDER]);
  assert.equal(pickGranularity(0.5, 'day'), 'hour');
  assert.equal(pickGranularity(7, 'hour'), 'day');
  assert.equal(pickGranularity(7, 'day'), 'day', '可用档不应被改写');
  assert.ok(Number.isNaN(spanDaysOf({}, {})));
});

test('记住筛选：相对档位按今天重算，隔天存档一律失效', () => {
  installStorage();
  const today = toDayStr(new Date());
  saveFilter({ ...defaultFilter(), preset: '近 7 天', from: '2000-01-01', model: 'model-x' });
  const restored = loadFilter();
  assert.equal(restored.filter.from, toDayStr(daysAgo(7)), '不能沿用已冻结的绝对日期');
  assert.equal(restored.filter.model, 'model-x');
  assert.equal(restored.restored, true);

  const map = installStorage();
  map.set(KEY, JSON.stringify({
    v: 1,
    savedAt: toDayStr(daysAgo(1)),
    filter: { ...defaultFilter(), model: 'stale-model' },
  }));
  const stale = loadFilter();
  assert.equal(stale.restored, false);
  assert.equal(stale.filter.model, 'all');
  assert.equal(stale.filter.savedAt, undefined);
  assert.equal(today, toDayStr(new Date()));
});

test('存坏的筛选与空 meta 不会把界面顶成错误态', () => {
  installStorage({ [KEY]: 'not-json-{{{' });
  assert.deepEqual(loadFilter(), { filter: defaultFilter(), restored: false });
  clearFilter();
  assert.equal(globalThis.localStorage.getItem(KEY), null);

  const f = { projectId: 'gone', model: 'all', kind: 'gone' };
  assert.deepEqual(sanitizeFilter(f, { projects: [], models: [], kinds: [] }), f,
    'meta 还没到时不该误清用户条件');
  assert.deepEqual(
    sanitizeFilter(f, { projects: ['p1'], models: ['m1'], kinds: ['message'] }),
    { projectId: 'all', model: 'all', kind: 'all' },
  );
});
