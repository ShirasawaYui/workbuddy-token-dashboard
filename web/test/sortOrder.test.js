import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ORDER,
  isDesc,
  nextOrder,
  orderedByTime,
  displayIndexOf,
  displaySeq,
} from '../src/utils/sortOrder.js';

const steps = [
  { id: 'a', ts: 1 },
  { id: 'b', ts: 2 },
  { id: 'c', ts: 3 },
  { id: 'd', ts: 4 },
];

test('默认是时间逆序；异常值一律安全落回逆序', () => {
  assert.equal(DEFAULT_ORDER, 'desc');
  assert.equal(isDesc(DEFAULT_ORDER), true);
  assert.equal(isDesc(undefined), true);
  assert.equal(isDesc('bogus'), true);
  assert.equal(isDesc('asc'), false);
});

test('点击一次在逆序 / 正序之间切换，再点一次回到原状', () => {
  assert.equal(nextOrder('desc'), 'asc');
  assert.equal(nextOrder('asc'), 'desc');
  assert.equal(nextOrder(nextOrder('desc')), 'desc');
  assert.equal(nextOrder(undefined), 'asc');
});

test('orderedByTime：逆序翻转、正序照原样，且不修改原数组', () => {
  const snapshot = JSON.stringify(steps);
  assert.deepEqual(orderedByTime(steps, 'desc').map((r) => r.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(orderedByTime(steps, 'asc').map((r) => r.id), ['a', 'b', 'c', 'd']);
  assert.equal(JSON.stringify(steps), snapshot, '原数组不能被 reverse 就地改动');
  assert.notEqual(orderedByTime(steps, 'asc'), steps, '应返回新数组，避免污染曲线数据源');
});

test('orderedByTime：空 / 非数组输入不抛错', () => {
  assert.deepEqual(orderedByTime([], 'desc'), []);
  assert.deepEqual(orderedByTime(undefined, 'asc'), []);
  assert.deepEqual(orderedByTime(null, 'desc'), []);
});

test('displayIndexOf / displaySeq：任意顺序下 # 都还原成「第几次请求」', () => {
  for (const order of ['asc', 'desc']) {
    const total = steps.length;
    const shown = orderedByTime(steps, order);
    for (let rawIndex = 0; rawIndex < total; rawIndex++) {
      const displayIndex = displayIndexOf(rawIndex, total, order);
      assert.equal(shown[displayIndex].id, steps[rawIndex].id, `${order} 第 ${rawIndex} 条映射错位`);
      assert.equal(displaySeq(displayIndex, total, order), rawIndex + 1, `${order} 第 ${rawIndex} 条序号错位`);
    }
  }
});

test('逆序时首行 # = 总条数，正序时首行 # = 1', () => {
  assert.equal(displaySeq(0, 1061, 'desc'), 1061);
  assert.equal(displaySeq(0, 1061, 'asc'), 1);
  assert.equal(displaySeq(1060, 1061, 'desc'), 1);
  assert.equal(displaySeq(1060, 1061, 'asc'), 1061);
});

test('轮次定位：逆序下该轮第一条映射后仍在同一组连续区间里', () => {
  // 第 3、4 条属于同一轮；逆序后它们显示在下标 0、1
  const total = 4;
  assert.equal(displayIndexOf(2, total, 'desc'), 1);
  assert.equal(displayIndexOf(3, total, 'desc'), 0);
  assert.equal(displayIndexOf(2, total, 'asc'), 2);
});
