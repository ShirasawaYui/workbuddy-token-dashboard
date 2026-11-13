/**
 * 第 7 步：最近活跃会话的口径单测。
 *
 * 刻意用真实临时文件跑 Scanner.scan()，而不是手动塞 files Map —— 这样
 * 「增量追加时 lastEventTs / lastRecordTs 有没有跟着更新」才会被真正检验，
 * 否则跟随模式在长会话里会一直停在第一次扫到的那个文件上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scanner, maxTsOf } from '../src/scanner.js';

/** 造一份临时 home，把 discover() 指到其中的两个会话文件 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-active-test-'));
  const dir = path.join(root, 'projects', 'p-test');
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'session-a.jsonl');
  const b = path.join(dir, 'session-b.jsonl');
  // 阶段 1 起 Scanner 默认冷启动：mtime 超过 7 天的文件只登记指纹、不解析。
  // 本用例刻意把 mtime 用 utimesSync 设成 2023 年，若走默认路径会全部变冷文件，
  // latestActivity() 返回 null。这里显式走全量路径（与回归夹具口径一致），
  // 保持「最近活跃」这组单测检验的是时间口径而不是冷热判断。
  const scanner = new Scanner({ forceFullLoad: true });
  scanner.discover = async () => [
    { filePath: a, projectId: 'p-test', sessionId: 'session-a' },
    { filePath: b, projectId: 'p-test', sessionId: 'session-b' },
  ];
  return {
    root,
    a,
    b,
    scanner,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

const append = (file, sessionId, rows) =>
  fs.appendFileSync(file, rows.map((o) => JSON.stringify({ sessionId, ...o })).join('\n') + '\n');

const metaRows = (ts) => [
  { type: 'session-meta', timestamp: ts },
  { type: 'ai-title', timestamp: ts, aiTitle: '测试会话' },
];
const userRow = (ts) => ({ type: 'message', role: 'user', timestamp: ts, message: { text: '请继续' } });
const usageRow = (ts, id) => ({
  type: 'message',
  role: 'assistant',
  timestamp: ts,
  providerData: {
    messageId: id,
    model: 'test-model',
    rawUsage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, credit: 0.12 },
  },
});

test('maxTsOf：大量事件也不爆栈，且忽略非法值', () => {
  const rows = Array.from({ length: 120_000 }, (_, i) => ({ t: i }));
  rows.push({ t: 999_999 }, { t: NaN }, { t: undefined });
  assert.equal(maxTsOf(rows, 't'), 999_999);
  assert.equal(maxTsOf(null, 't'), 0);
  assert.equal(maxTsOf([{ t: '2000' }], 't'), 2000);
});

test('只有元信息的会话不算活跃，不产生凭空的 0 消耗会话', async () => {
  const f = fixture();
  try {
    append(f.a, 'session-a', metaRows(1000));
    await f.scanner.scan();
    assert.equal(f.scanner.latestActivity(), null, '纯 session-meta / ai-title 必须被跳过');
  } finally {
    f.cleanup();
  }
});

test('刚创建、只有用户消息而没有 credit 的会话会被识别，明确标记 hasUsage=false', async () => {
  const f = fixture();
  try {
    append(f.a, 'session-a', [...metaRows(1000), userRow(2000)]);
    await f.scanner.scan();
    const active = f.scanner.latestActivity();
    assert.equal(active.sessionId, 'session-a');
    assert.equal(active.hasUsage, false);
    assert.ok(active.eventCount > 0, '用户消息事件应计入活动');
    assert.equal(active.recordCount, 0);
    assert.equal(active.title, '测试会话');
  } finally {
    f.cleanup();
  }
});

test('多会话交替追加：跟随目标随之切换，增量维护的活动时间生效', async () => {
  const f = fixture();
  try {
    append(f.a, 'session-a', [...metaRows(1000), userRow(1100), usageRow(1200, 'a-1')]);
    await f.scanner.scan();
    assert.equal(f.scanner.latestActivity().sessionId, 'session-a', '初始 A 活跃');

    append(f.b, 'session-b', [...metaRows(3000), userRow(3100), usageRow(3200, 'b-1')]);
    await f.scanner.scan();
    assert.equal(f.scanner.latestActivity().sessionId, 'session-b', 'B 后来写入 → 切到 B');

    // 关键：这是「追加」路径（不是全量重解析），必须更新 lastEventTs / lastRecordTs
    append(f.a, 'session-a', [userRow(5000), usageRow(5100, 'a-2')]);
    await f.scanner.scan();
    assert.equal(f.scanner.latestActivity().sessionId, 'session-a', 'A 再追加 → 切回 A');
    assert.equal(f.scanner.latestActivity().recordCount, 2, 'A 的累计用量记录数正确');
  } finally {
    f.cleanup();
  }
});

test('时间相同时结果确定，不随 Map 遍历顺序抖动', async () => {
  const f = fixture();
  try {
    append(f.a, 'session-a', [...metaRows(1000), usageRow(1000, 'a-1')]);
    append(f.b, 'session-b', [...metaRows(1000), usageRow(1000, 'b-1')]);
    // 抹平 mtime 差异：两个文件都设成同一个整数秒，只比日志时间戳
    const fixed = 1_700_000_000;
    fs.utimesSync(f.a, fixed, fixed);
    fs.utimesSync(f.b, fixed, fixed);
    await f.scanner.scan();
    const active = f.scanner.latestActivity();
    assert.equal(active.sessionId, 'session-a', '平局取 sessionId 字典序较小者');
    assert.equal(f.scanner.latestActivity().sessionId, active.sessionId, '重复调用结果稳定');
  } finally {
    f.cleanup();
  }
});

test('文件被删除后不再作为活跃候选', async () => {
  const f = fixture();
  try {
    append(f.a, 'session-a', [...metaRows(1000), usageRow(1100, 'a-1')]);
    await f.scanner.scan();
    assert.ok(f.scanner.latestActivity());
    fs.rmSync(f.a);
    f.scanner.discover = async () => [];
    await f.scanner.scan();
    assert.equal(f.scanner.latestActivity(), null);
  } finally {
    f.cleanup();
  }
});
