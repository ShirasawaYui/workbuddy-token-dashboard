/**
 * 轮次视图纯函数单测（第 6 步）。
 * 这些分支靠人眼点抽屉很难稳定复现：活跃窗口、分母为 0 的命中率、
 * 缺 traceId 的独立轮、长会话的虚拟窗口边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_WINDOW_MS,
  isActiveTurn,
  hitRateText,
  turnLabel,
  stepsOfTurn,
  virtualWindow,
  turnCardState,
} from '../src/utils/turnView.js';

const NOW = 1_800_000_000_000;
const turn = (over = {}) => ({
  turnKey: 's1\u0000t1',
  turnId: 't1',
  traceId: 't1',
  sessionId: 's1',
  isOrphan: false,
  requests: 3,
  prompt: 1000,
  completion: 200,
  total: 1200,
  cacheRead: 900,
  cacheMiss: 100,
  reasoning: 0,
  credit: 0.42,
  toolCalls: 2,
  startTs: NOW - 60_000,
  endTs: NOW - 30_000,
  lastTs: NOW - 30_000,
  models: ['m1'],
  ...over,
});

test('活跃轮次：5 分钟窗口内（含时间戳略超前）', () => {
  assert.equal(isActiveTurn(turn(), NOW), true);
  assert.equal(isActiveTurn(turn({ lastTs: NOW + 30_000 }), NOW), true, 'live 夹具时间戳会略超前真实时钟');
  assert.equal(isActiveTurn(turn({ lastTs: NOW - ACTIVE_WINDOW_MS }), NOW), true, '边界闭合');
  assert.equal(isActiveTurn(turn({ lastTs: NOW - ACTIVE_WINDOW_MS - 1 }), NOW), false);
  assert.equal(isActiveTurn(turn({ lastTs: NOW - 7 * 24 * 3600_000 }), NOW), false, '历史会话不算活跃');
});

test('活跃轮次：缺字段不能误判', () => {
  assert.equal(isActiveTurn(null, NOW), false);
  assert.equal(isActiveTurn({}, NOW), false);
  assert.equal(isActiveTurn(turn({ lastTs: NaN }), NOW), false);
  assert.equal(isActiveTurn(turn({ lastTs: undefined }), NOW), false);
});

test('命中率：分母为 0 显示破折号，不伪装成 0%', () => {
  assert.equal(hitRateText(turn()), '90.0%');
  assert.equal(hitRateText(turn({ prompt: 0, cacheRead: 0 })), '—');
  assert.equal(hitRateText(null), '—');
  assert.equal(hitRateText(turn({ prompt: 100, cacheRead: 150 })), '100.0%', '异常值夹到 100%');
});

test('轮次标签：缺失 traceId 的请求不叫「第 N 轮」', () => {
  assert.equal(turnLabel(turn(), 3), '第 4 轮');
  assert.equal(turnLabel(turn({ isOrphan: true }), 3), '未归属请求');
  assert.equal(turnLabel(null, 0), '—');
});

test('按 turnKey 取该轮请求，保持原顺序', () => {
  const steps = [
    { id: 'a', turnKey: 'k1', prompt: 100 },
    { id: 'b', turnKey: 'k2', prompt: 200 },
    { id: 'c', turnKey: 'k1', prompt: 300 },
  ];
  assert.deepEqual(
    stepsOfTurn(steps, 'k1').map((r) => r.id),
    ['a', 'c'],
  );
  assert.deepEqual(stepsOfTurn(steps, ''), []);
  assert.deepEqual(stepsOfTurn(steps, 'missing'), []);
  assert.deepEqual(stepsOfTurn(null, 'k1'), []);
});

test('虚拟窗口：小数据全渲染，大数据窗口大小与总数脱钩', () => {
  const small = virtualWindow(4, 0, 300, 38, 6);
  assert.deepEqual([small.start, small.end, small.padTop, small.padBottom], [0, 4, 0, 0]);

  const first = virtualWindow(100_000, 0, 300, 38, 6);
  const middle = virtualWindow(100_000, 50_000 * 38, 300, 38, 6);
  assert.ok(first.end - first.start < 30, '首屏只渲染视口 + overscan');
  assert.ok(middle.end - middle.start < 30, '滚到中段仍只渲染视口 + overscan');
  assert.ok(
    middle.end - middle.start >= first.end - first.start,
    '中段窗口不会被首屏的 start clamp 削小',
  );
  assert.equal(middle.padTop, middle.start * 38);
  assert.equal(middle.padBottom, (100_000 - middle.end) * 38);

  const bottom = virtualWindow(100, 100 * 38, 300, 38, 6);
  assert.equal(bottom.end, 100, '滚过头也不能越界');
  assert.equal(bottom.padBottom, 0);
  assert.ok(bottom.start <= bottom.end);
});

test('虚拟窗口：异常输入不产生负高度或 NaN', () => {
  const w = virtualWindow(-5, -100, 0, 38, 6);
  assert.deepEqual([w.start, w.end, w.padTop, w.padBottom], [0, 0, 0, 0]);
  assert.ok(Number.isFinite(w.padTop) && w.padTop >= 0);
});

test('本轮卡片状态：加载 / 空 / 正常', () => {
  assert.deepEqual(turnCardState(null, NOW), { status: 'loading' });
  const empty = turnCardState({ turns: [], turnSummary: { orphanTurns: 0 } }, NOW);
  assert.equal(empty.status, 'empty');

  const t = turn();
  const ok = turnCardState(
    { turns: [t], turnTotal: 7, latestTurn: t, turnSummary: { orphanTurns: 2 } },
    NOW,
  );
  assert.equal(ok.status, 'ok');
  assert.equal(ok.label, '第 7 轮', '被 turnLimit 裁掉时仍用绝对轮次号');
  assert.equal(ok.active, true);
  assert.equal(ok.orphanTurns, 2);
  assert.equal(ok.turn.credit, 0.42);
});

test('本轮卡片状态：无 latestTurn 时回落空态，不渲染零值假轮次', () => {
  const s = turnCardState(
    { turns: [], turnTotal: 0, latestTurn: null, turnSummary: { orphanTurns: 0 } },
    NOW,
  );
  assert.equal(s.status, 'empty');
  assert.equal(s.turn, undefined);
});
