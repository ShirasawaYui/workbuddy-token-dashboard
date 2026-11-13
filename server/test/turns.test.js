/**
 * 轮次数据模型单测（第 5 步）。
 *
 * 覆盖执行计划里的验收口径：同一轮多次请求不拆轮、同一请求不重复计费、
 * 空 traceId 不合并、跨会话同 traceId 不合并、轮次合计等于逐项独立复算，
 * 以及"跨块追加 / 文件重写"后 Store 的轮次索引能正确重建。
 *
 * 运行：node --test server/test/turns.test.js（根 npm test 会一并执行）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Store,
  applyFilter,
  summarize,
  buildTurns,
  summarizeTurns,
  turnKeyOf,
} from '../src/store.js';
import { Scanner } from '../src/scanner.js';

/** 造一条规范化记录；字段与 parser.js 输出对齐 */
function rec(over = {}) {
  const prompt = over.prompt ?? 1000;
  const completion = over.completion ?? 200;
  return {
    id: 'm1',
    sessionId: 's1',
    projectId: 'p1',
    ts: 1790000000000,
    traceId: 't1',
    requestId: '',
    model: 'm1',
    kind: 'message',
    toolName: null,
    prompt,
    completion,
    total: prompt + completion,
    cacheRead: 800,
    cacheMiss: 200,
    reasoning: 10,
    credit: 0.5,
    ...over,
  };
}

test('turnKeyOf：有 traceId 按 (session, trace)，无 traceId 按 messageId 独立', () => {
  assert.equal(turnKeyOf(rec({ traceId: 't1' })), 's1\u0000t1');
  assert.equal(turnKeyOf(rec({ traceId: '' })), 's1\u0000__orphan__\u0000m1');
  // 跨会话即便 traceId 相同也不能并成一轮
  assert.notEqual(turnKeyOf(rec({ sessionId: 's1', traceId: 't1' })), turnKeyOf(rec({ sessionId: 's2', traceId: 't1' })));
  // 两个不同的无 traceId 请求不能合并
  assert.notEqual(turnKeyOf(rec({ id: 'a', traceId: '' })), turnKeyOf(rec({ id: 'b', traceId: '' })));
});

test('同一轮多次请求聚合成一轮，各指标为逐项和', () => {
  const rows = [
    rec({ id: 'm1', ts: 1000, prompt: 1000, completion: 200, credit: 0.5, model: 'm1' }),
    rec({ id: 'm2', ts: 2000, prompt: 2000, completion: 300, credit: 1.5, model: 'm2', kind: 'function_call' }),
    rec({ id: 'm3', ts: 3000, prompt: 3000, completion: 400, credit: 2.0, model: 'm1' }),
  ];
  const turns = buildTurns(rows);
  assert.equal(turns.length, 1);
  const t = turns[0];
  assert.equal(t.turnId, 't1');
  assert.equal(t.isOrphan, false);
  assert.equal(t.requests, 3);
  assert.equal(t.prompt, 6000);
  assert.equal(t.completion, 900);
  assert.equal(t.total, 6900);
  assert.equal(t.cacheRead, 2400);
  assert.equal(t.cacheMiss, 600);
  assert.equal(t.cacheHitRate, 0.4);
  assert.equal(t.credit, 4);
  assert.deepEqual(t.models.sort(), ['m1', 'm2']);
  assert.equal(t.toolCalls, 1);
  assert.equal(t.startTs, 1000);
  assert.equal(t.endTs, 3000);
  assert.equal(t.lastTs, 3000);
});

test('连续两轮按起始时间升序，不会被合并', () => {
  const rows = [
    rec({ id: 'm1', traceId: 't1', ts: 1000 }),
    rec({ id: 'm2', traceId: 't1', ts: 2000 }),
    rec({ id: 'm3', traceId: 't2', ts: 3000 }),
    rec({ id: 'm4', traceId: 't2', ts: 4000 }),
  ];
  const turns = buildTurns(rows);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.turnId), ['t1', 't2']);
  assert.deepEqual(turns.map((t) => t.requests), [2, 2]);
});

test('空 traceId 各自独立成轮，不合并成一个空轮', () => {
  const rows = [
    rec({ id: 'a', traceId: '', ts: 1000 }),
    rec({ id: 'b', traceId: '', ts: 2000 }),
    rec({ id: 'c', traceId: '', ts: 3000 }),
  ];
  const turns = buildTurns(rows);
  assert.equal(turns.length, 3);
  assert.ok(turns.every((t) => t.isOrphan && t.requests === 1));
  assert.equal(new Set(turns.map((t) => t.turnId)).size, 3);
  assert.equal(summarizeTurns(turns).orphanTurns, 3);
});

test('跨会话相同 traceId 不合并；重复 messageId 不重复计费', () => {
  const rows = [
    rec({ id: 'a', sessionId: 's1', traceId: 'same', ts: 1000 }),
    rec({ id: 'b', sessionId: 's2', traceId: 'same', ts: 2000 }),
    rec({ id: 'a', sessionId: 's1', traceId: 'same', ts: 1000 }), // 完全重复
  ];
  const turns = buildTurns(rows);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.requests), [1, 1]);
  assert.equal(summarizeTurns(turns).requests, 2);
});

test('轮次合计等于所属请求逐项独立复算（含小数 credit 的舍入容差）', () => {
  const rows = [
    rec({ id: 'm1', traceId: 't1', ts: 1000, prompt: 1111, completion: 222, cacheRead: 900, cacheMiss: 211, credit: 0.3333 }),
    rec({ id: 'm2', traceId: 't1', ts: 2000, prompt: 2222, completion: 333, cacheRead: 1800, cacheMiss: 422, credit: 0.6667 }),
    rec({ id: 'm3', traceId: 't2', ts: 3000, prompt: 500, completion: 50, cacheRead: 400, cacheMiss: 100, credit: 0.1111 }),
    rec({ id: 'm4', traceId: '', ts: 4000, prompt: 77, completion: 7, cacheRead: 70, cacheMiss: 7, credit: 0.0001 }),
  ];
  const turns = buildTurns(rows);
  const s = summarizeTurns(turns);
  // 完全独立的一遍求和，不复用 buildTurns / summarizeTurns
  const keys = ['prompt', 'completion', 'total', 'cacheRead', 'cacheMiss', 'reasoning', 'credit'];
  const independent = Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + r[k], 0)]));
  assert.equal(s.turns, 3);
  assert.equal(s.requests, rows.length);
  assert.equal(s.prompt, independent.prompt);
  assert.equal(s.completion, independent.completion);
  assert.equal(s.total, independent.total);
  assert.equal(s.cacheRead, independent.cacheRead);
  assert.equal(s.cacheMiss, independent.cacheMiss);
  assert.equal(s.reasoning, independent.reasoning);
  assert.ok(Math.abs(s.credit - independent.credit) < 0.001, `credit ${s.credit} vs ${independent.credit}`);
  assert.equal(s.maxRequests, 2);
  assert.equal(s.latestTurnId, 'orphan:m4');
  assert.equal(s.avgRequests, 1.33);
});

test('筛选后的轮次与 summary 同口径（from/to 不产生口径分裂）', () => {
  const rows = [
    rec({ id: 'm1', traceId: 't1', ts: 1000 }),
    rec({ id: 'm2', traceId: 't1', ts: 2000 }),
    rec({ id: 'm3', traceId: 't2', ts: 9000 }),
  ];
  const list = applyFilter(rows, { from: 500, to: 5000 });
  const turns = buildTurns(list);
  const s = summarizeTurns(turns);
  const expect = summarize(list);
  assert.equal(turns.length, 1);
  assert.equal(s.requests, expect.requests);
  assert.equal(s.prompt, expect.prompt);
  assert.equal(s.credit, expect.credit);
  assert.equal(s.turns, 1);
});

test('Scanner 跨块追加 / 下一轮 / 无 traceId / 文件重写后，Store 轮次索引正确重建', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-dash-turns-'));
  const dir = path.join(tmp, 'projects', 'e-WORK-Demo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session-turns.jsonl');

  const line = (i, traceId, ts) =>
    JSON.stringify({
      type: 'function_call',
      timestamp: ts,
      sessionId: 'session-turns',
      cwd: 'e:\\WORK\\Demo',
      name: 'Bash',
      providerData: {
        messageId: 'msg-' + i,
        ...(traceId ? { traceId } : {}),
        model: 'demo-model',
        rawUsage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_tokens: 1100,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
          credit: 1,
        },
      },
    });

  const l1 = line(1, 'trace-A', 1790000000000);
  const l2 = line(2, 'trace-A', 1790000001000);
  const l3 = line(3, 'trace-A', 1790000002000);
  const l4 = line(4, 'trace-B', 1790000003000);
  const l5 = line(5, '', 1790000004000);

  const scanner = new Scanner();
  scanner.discover = async () => [
    { filePath: file, projectId: 'e-WORK-Demo', sessionId: 'session-turns' },
  ];
  const store = new Store(scanner);

  // 第 1 次扫描：同一轮 2 条请求
  fs.writeFileSync(file, l1 + '\n' + l2 + '\n');
  await store.refresh();
  assert.equal(store.size(), 2);
  assert.equal(store.turnIndex.size, 1, '同轮 2 请求应聚合成 1 轮');
  assert.equal([...store.turnIndex.values()][0].requests, 2);

  // 第 2 次追加：补完第 1 轮的第 3 条 + 开启第 2 轮
  fs.appendFileSync(file, l3 + '\n' + l4 + '\n');
  await store.refresh();
  assert.equal(store.turnIndex.size, 2);
  const byId = new Map([...store.turnIndex.values()].map((t) => [t.turnId, t]));
  assert.equal(byId.get('trace-A').requests, 3, '跨块追加应并入原轮次，不拆成新轮');
  assert.equal(byId.get('trace-B').requests, 1);

  // 第 3 次追加：无 traceId 的孤立请求
  fs.appendFileSync(file, l5 + '\n');
  await store.refresh();
  assert.equal(store.turnIndex.size, 3);
  assert.equal([...store.turnIndex.values()].filter((t) => t.isOrphan).length, 1);
  assert.equal(store.turnsBySession.get('session-turns').length, 3);
  assert.ok(store.records().every((r) => r.turnKey), '每条记录都应带 turnKey');

  // 文件被重写（变小）：旧轮次不能残留
  fs.writeFileSync(file, l1 + '\n');
  await store.refresh();
  assert.equal(store.size(), 1);
  assert.equal(store.turnIndex.size, 1, '重写后不应残留旧轮次');
  assert.equal([...store.turnIndex.values()][0].requests, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});
