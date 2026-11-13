/**
 * 第 8 步：查询索引与 revision 的口径 / 行为单测。
 *
 * 重点不是"跑得快"，而是证明这些优化**没有改变统计口径**：
 * 缓存的排序数组、按会话取子集，结果必须与原来的全量过滤完全一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, applyFilter } from '../src/store.js';

function makeRecord(sid, i, ts) {
  return {
    id: `${sid}-${i}`,
    sessionId: sid,
    projectId: 'p-test',
    cwd: 'D:\\work\\p-test',
    ts,
    kind: 'message',
    toolName: null,
    model: i % 2 ? 'm-a' : 'm-b',
    traceId: `trace-${Math.floor(i / 3)}`,
    prompt: 100 + i,
    completion: 10 + i,
    total: 110 + 2 * i,
    cacheRead: 80,
    cacheMiss: 20,
    reasoning: 0,
    credit: 0.1,
  };
}

function fixture() {
  const records = [];
  for (const sid of ['s-a', 's-b']) {
    for (let i = 0; i < 12; i++) records.push(makeRecord(sid, i, 1_000 + i * 10 + (sid === 's-b' ? 5 : 0)));
  }
  const sessions = ['s-a', 's-b'].map((sessionId) => ({
    sessionId,
    projectId: 'p-test',
    title: `会话 ${sessionId}`,
    cwd: 'D:\\work\\p-test',
    cwdPretty: 'p-test',
    filePath: `/tmp/${sessionId}.jsonl`,
  }));
  let changed = true;
  const scanner = {
    all: () => ({
      records: records.map((r) => ({ ...r })),
      sessions: sessions.map((s) => ({ ...s })),
      timelines: sessions.map((s) => ({ sessionId: s.sessionId, projectId: s.projectId, events: [] })),
    }),
    scan: async () => changed,
    latestActivity: () => null,
  };
  return { store: new Store(scanner), setChanged: (v) => (changed = v) };
}

test('records() 复用同一份已排序数组，rebuild 后才换引用', async () => {
  const { store, setChanged } = fixture();
  await store.refresh();
  const a = store.records();
  assert.equal(store.records(), a, '同一 revision 内不应重复复制 + 排序');
  assert.ok(a.every((r, i) => i === 0 || a[i - 1].ts <= r.ts), '按 ts 升序');

  setChanged(false);
  await store.refresh();
  assert.equal(store.records(), a, '无变化的扫描不该换掉缓存数组');

  setChanged(true);
  await store.refresh();
  assert.notEqual(store.records(), a, 'rebuild 后应换成新数组');
});

test('revision 只在 rebuild 时递增，无变化扫描保持不变', async () => {
  const { store, setChanged } = fixture();
  assert.equal(store.revision, 0);
  await store.refresh();
  assert.equal(store.revision, 1);
  setChanged(false);
  await store.refresh();
  assert.equal(store.revision, 1, 'lastScanAt 会变，但 revision 不能变');
  setChanged(true);
  await store.refresh();
  assert.equal(store.revision, 2);
});

test('recordsForSession 与全量过滤结果完全一致（含时间筛选）', async () => {
  const { store } = fixture();
  await store.refresh();
  const all = store.records();
  for (const sid of ['s-a', 's-b']) {
    assert.deepEqual(
      store.recordsForSession(sid).map((r) => r.id),
      applyFilter(all, { sessionId: sid }).map((r) => r.id),
      '不带筛选时口径一致',
    );
    const f = { sessionId: sid, from: 1_020, to: 1_090 };
    assert.deepEqual(
      applyFilter(store.recordsForSession(sid), f).map((r) => r.id),
      applyFilter(all, f).map((r) => r.id),
      '带 from/to 时口径一致',
    );
  }
  assert.deepEqual(store.recordsForSession('不存在的会话'), []);
});

test('按会话索引覆盖全量记录，不丢也不重', async () => {
  const { store } = fixture();
  await store.refresh();
  const all = store.records();
  const ids = new Set();
  for (const sid of ['s-a', 's-b']) {
    for (const r of store.recordsForSession(sid)) ids.add(r.id);
  }
  assert.equal(ids.size, all.length);
  assert.equal(new Set(all.map((r) => r.id)).size, all.length);
});

test('较大数据集下索引仍正确，且 records() 不重复排序', async () => {
  const records = [];
  const sessions = [];
  for (let s = 0; s < 40; s++) {
    const sid = `bulk-${s}`;
    sessions.push({
      sessionId: sid,
      projectId: 'p-bulk',
      title: sid,
      cwd: '',
      cwdPretty: '',
      filePath: `/tmp/${sid}.jsonl`,
    });
    // 时间戳刻意交错，验证排序不是按文件顺序
    for (let i = 0; i < 100; i++) records.push(makeRecord(sid, i, 10_000 + i * 40 + s));
  }
  const scanner = {
    all: () => ({
      records: records.map((r) => ({ ...r })),
      sessions: sessions.map((x) => ({ ...x })),
      timelines: sessions.map((x) => ({ sessionId: x.sessionId, projectId: x.projectId, events: [] })),
    }),
    scan: async () => true,
    latestActivity: () => null,
  };
  const store = new Store(scanner);
  await store.refresh();
  assert.equal(store.size(), 4000);
  assert.equal(store.records().length, 4000);
  assert.equal(store.records(), store.records(), '4000 条也只返回缓存引用');
  assert.equal(store.recordsForSession('bulk-7').length, 100);
  assert.deepEqual(
    store.recordsForSession('bulk-7').map((r) => r.ts),
    store.recordsForSession('bulk-7').map((r) => r.ts).slice().sort((a, b) => a - b),
    '单个会话子集同样按时间升序',
  );
  assert.equal(store.revision, 1);
});
