/**
 * 子代理（subagents/）识别 —— 单元测试。
 *
 * 背景：WorkBuddy 5.x 起，Agent 派生的子代理（后台队友）会话写在
 * <projects>/<项目>/<父会话ID>/subagents/agent-*.jsonl，每条请求带
 * rawUsage；父会话文件只留 credit-usage 结算镜像行。旧扫描器只扫单层
 * *.jsonl，子代理 token / credit 整块隐形（真实机器实测漏 41 文件 /
 * 666 请求 / 6380 万 token / 539 credit）。
 *
 * 本文件覆盖：
 *   F1 discover 递归收 subagents/（含更深层级），归到父会话
 *   F2 归父：记录 sessionId=父会话、isSubAgent、agent 名（行内 sessionId 是
 *      子代理内部 ID，不得外泄为会话键）
 *   F3 防双计：子代理文件已加载时，credit-usage 镜像行被丢弃
 *   F4 兜底：没有 subagent 文件的会话，credit-usage 行合成记录不丢钱
 *   F5 子代理事件不并入父时间线（耗时按相邻事件差推导，跨并行流会算错）
 *   F6 会话行兜底：父文件没加载时子代理记录也要能撑出会话行
 *
 * 运行：node --test server/test/subagent.test.js（根 npm test 已纳入）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scanner } from '../src/scanner.js';
import { parseChunk } from '../src/parser.js';
import { Store, summarize } from '../src/store.js';

/** 一条带用量的主线 JSONL 行 */
function usageLine(id, ts, sessionId, opts = {}) {
  const { model = 'main-model', credit = 0.5, prompt = 100, completion = 40, agent = 'cli' } = opts;
  return JSON.stringify({
    type: 'function_call',
    timestamp: ts,
    sessionId,
    cwd: 'D:\\subagent-test',
    name: 'Bash',
    providerData: {
      messageId: id,
      traceId: `trace-${sessionId}`,
      model,
      agent,
      rawUsage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        credit,
      },
    },
  });
}

/**
 * 一条子代理请求行：行内 sessionId 是**子代理自己的内部 ID**（与父会话、
 * 文件名都不一致），providerData 带 isSubAgent + agent 名。
 */
function subagentLine(id, ts, innerSessionId, agentName, opts = {}) {
  const { model = 'kimi-k3.1-pro', credit = 3.3, prompt = 200, completion = 80 } = opts;
  return JSON.stringify({
    type: 'function_call',
    timestamp: ts,
    sessionId: innerSessionId,
    cwd: 'D:\\subagent-test',
    name: 'TaskList',
    providerData: {
      messageId: id,
      traceId: `trace-${id}`,
      stepSeq: 1,
      model,
      agent: agentName,
      isSubAgent: true,
      rawUsage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        credit,
      },
    },
  });
}

/** 一条 credit-usage 结算镜像行（父会话文件里，pd.messageId 会重复） */
function creditUsageLine(id, ts, credit, opts = {}) {
  const { source = 'team_member' } = opts;
  return JSON.stringify({
    id,
    parentId: 'parent-step-x',
    timestamp: ts,
    type: 'credit-usage',
    providerData: {
      conversationRequestId: 'req-x',
      credit,
      source,
      stageId: `team:${id}`,
      messageId: 'shared-mid-repeats', // 故意重复：合成记录必须用行级 id
    },
    cwd: 'D:\\subagent-test',
  });
}

/** 临时数据源：projects/<项目>/... 结构 */
function makeTmp(tag = 'sub') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  const projectsDir = path.join(home, 'projects');
  const projDir = path.join(projectsDir, 'd-subagent-demo');
  fs.mkdirSync(projDir, { recursive: true });
  return {
    home,
    projectsDir,
    projDir,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }),
  };
}

function writeJsonl(p, lines) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
}

function newScanner(tmp) {
  return new Scanner({ projectsDir: tmp.projectsDir, forceFullLoad: true, hotDays: 7 });
}

/* ── F1 discover ─────────────────────────────────────────────────────── */

test('F1 discover 递归收 subagents/ 并归到父会话', async () => {
  const tmp = makeTmp('f1');
  try {
    const parent = path.join(tmp.projDir, 'sess-parent.jsonl');
    writeJsonl(parent, [usageLine('m1', Date.now(), 'sess-parent')]);
    writeJsonl(path.join(tmp.projDir, 'sess-parent/subagents/agent-aaa.jsonl'), [
      subagentLine('s1', Date.now(), 'inner-1', 'agent-a'),
    ]);
    // 更深层级（agent 目录附件子树里的 jsonl）也必须收到
    writeJsonl(path.join(tmp.projDir, 'sess-parent/subagents/agent-bbb/nested.jsonl'), [
      subagentLine('s2', Date.now(), 'inner-2', 'agent-b'),
    ]);
    // 附件目录（非 subagents）不得被扫
    writeJsonl(path.join(tmp.projDir, 'sess-parent/some-uuid/junk.jsonl'), ['{"type":"x"}']);

    const scanner = newScanner(tmp);
    const found = await scanner.discover();
    const byPath = new Map(found.map((f) => [f.filePath, f]));

    assert.equal(found.length, 3, `应只收 3 个 jsonl，实际 ${found.length}`);
    const main = byPath.get(parent);
    assert.equal(main.sessionId, 'sess-parent');
    assert.equal(main.isSubagent, false);

    const a = byPath.get(path.join(tmp.projDir, 'sess-parent/subagents/agent-aaa.jsonl'));
    assert.equal(a.sessionId, 'sess-parent', '子代理文件必须归到父会话');
    assert.equal(a.isSubagent, true);
    assert.equal(a.agentId, 'agent-aaa');

    const b = byPath.get(path.join(tmp.projDir, 'sess-parent/subagents/agent-bbb/nested.jsonl'));
    assert.equal(b.sessionId, 'sess-parent');
    assert.equal(b.isSubagent, true);
  } finally {
    tmp.cleanup();
  }
});

/* ── F2 归父 ────────────────────────────────────────────────────────── */

test('F2 子代理记录归父会话并带标记，行内 sessionId 不外泄', async () => {
  const tmp = makeTmp('f2');
  try {
    const now = Date.now();
    writeJsonl(path.join(tmp.projDir, 'sess-p.jsonl'), [usageLine('m1', now, 'sess-p')]);
    writeJsonl(path.join(tmp.projDir, 'sess-p/subagents/agent-aaa.jsonl'), [
      subagentLine('s1', now + 1, 'inner-session-uuid', 'phase1-tests'),
      subagentLine('s2', now + 2, 'inner-session-uuid', 'phase1-tests', { credit: 2.2 }),
    ]);

    const scanner = newScanner(tmp);
    await scanner.scan();
    const { records, sessions } = scanner.all();

    const sub = records.filter((r) => r.isSubAgent);
    assert.equal(sub.length, 2);
    for (const r of sub) {
      assert.equal(r.sessionId, 'sess-p', '记录必须归到父会话');
      assert.equal(r.agent, 'phase1-tests');
    }
    assert.equal(sessions.length, 1, '子代理不得另立会话');
    assert.equal(sessions[0].sessionId, 'sess-p');

    const mainRec = records.find((r) => !r.isSubAgent);
    assert.equal(mainRec.isSubAgent, false);
    assert.equal(mainRec.agent, '');

    // 汇总含子代理 credit
    const s = summarize(records);
    assert.equal(s.credit, 0.5 + 3.3 + 2.2);
  } finally {
    tmp.cleanup();
  }
});

/* ── F3 防双计 ──────────────────────────────────────────────────────── */

test('F3 子代理文件已加载时 credit-usage 镜像行被丢弃（防双计）', async () => {
  const tmp = makeTmp('f3');
  try {
    const now = Date.now();
    writeJsonl(path.join(tmp.projDir, 'sess-p.jsonl'), [
      usageLine('m1', now, 'sess-p'),
      creditUsageLine('cu-1', now + 1, 3.3),
      creditUsageLine('cu-2', now + 2, 2.2),
    ]);
    writeJsonl(path.join(tmp.projDir, 'sess-p/subagents/agent-aaa.jsonl'), [
      subagentLine('s1', now + 1, 'inner-1', 'agent-a', { credit: 3.3 }),
      subagentLine('s2', now + 2, 'inner-1', 'agent-a', { credit: 2.2 }),
    ]);

    const scanner = newScanner(tmp);
    await scanner.scan();
    const { records } = scanner.all();

    const creditOnly = records.filter((r) => r.creditOnly);
    assert.equal(creditOnly.length, 0, '镜像行必须被丢弃');
    // 总 credit = 主线 0.5 + 子代理 5.5，不含镜像 5.5
    assert.equal(summarize(records).credit, 0.5 + 3.3 + 2.2);
    assert.equal(records.filter((r) => r.isSubAgent).length, 2);
  } finally {
    tmp.cleanup();
  }
});

/* ── F4 兜底 ────────────────────────────────────────────────────────── */

test('F4 无 subagent 文件的会话：credit-usage 行合成记录不丢钱', async () => {
  const tmp = makeTmp('f4');
  try {
    const now = Date.now();
    writeJsonl(path.join(tmp.projDir, 'sess-p.jsonl'), [
      usageLine('m1', now, 'sess-p'),
      creditUsageLine('cu-1', now + 1, 7.5),
      creditUsageLine('cu-2', now + 2, 2.5),
    ]);

    const scanner = newScanner(tmp);
    await scanner.scan();
    const { records } = scanner.all();

    const cu = records.filter((r) => r.creditOnly);
    assert.equal(cu.length, 2);
    assert.equal(summarize(records).credit, 0.5 + 7.5 + 2.5);
    // 行级 id 去重：共享 messageId 的镜像行不得互相覆盖
    assert.notEqual(cu[0].id, cu[1].id);
    assert.equal(new Set(records.map((r) => r.id)).size, records.length, '记录 id 必须唯一');
  } finally {
    tmp.cleanup();
  }
});

/* ── F5 时间线隔离 ──────────────────────────────────────────────────── */

test('F5 子代理事件不并入父时间线', async () => {
  const tmp = makeTmp('f5');
  try {
    const now = Date.now();
    writeJsonl(path.join(tmp.projDir, 'sess-p.jsonl'), [usageLine('m1', now, 'sess-p')]);
    writeJsonl(path.join(tmp.projDir, 'sess-p/subagents/agent-aaa.jsonl'), [
      subagentLine('s1', now + 1, 'inner-1', 'agent-a'),
      subagentLine('s2', now + 2, 'inner-1', 'agent-a'),
    ]);

    const scanner = newScanner(tmp);
    await scanner.scan();
    const { timelines, records } = scanner.all();

    assert.equal(timelines.length, 1, '只有父会话一条时间线');
    assert.equal(timelines[0].sessionId, 'sess-p');
    // 子代理的两条 function_call 事件不得混入
    assert.equal(timelines[0].events.length, 1, `父时间线应只有 1 个事件，实际 ${timelines[0].events.length}`);
    // 但记录必须在
    assert.equal(records.filter((r) => r.isSubAgent).length, 2);
  } finally {
    tmp.cleanup();
  }
});

/* ── F6 会话行兜底 ──────────────────────────────────────────────────── */

test('F6 父文件未加载时子代理记录也撑得出会话行', async () => {
  const tmp = makeTmp('f6');
  try {
    const now = Date.now();
    // 父文件只有 session-meta（无用量、无事件）——被 all() 跳过的形态
    writeJsonl(path.join(tmp.projDir, 'sess-p.jsonl'), [
      JSON.stringify({ type: 'session-meta', timestamp: now, sessionId: 'sess-p' }),
    ]);
    writeJsonl(path.join(tmp.projDir, 'sess-p/subagents/agent-aaa.jsonl'), [
      subagentLine('s1', now + 1, 'inner-1', 'agent-a'),
    ]);

    const scanner = newScanner(tmp);
    await scanner.scan();
    const { records, sessions } = scanner.all();

    assert.equal(records.filter((r) => r.isSubAgent).length, 1);
    assert.equal(sessions.length, 1, '必须兜底出会话行');
    assert.equal(sessions[0].sessionId, 'sess-p');
  } finally {
    tmp.cleanup();
  }
});

/* ── F7 Store 集成：会话详情能看到子代理记录 ─────────────────────────── */

test('F7 Store.recordsForSession 归父可见，上下文曲线口径排除子代理', async () => {
  const tmp = makeTmp('f7');
  try {
    const now = Date.now();
    writeJsonl(path.join(tmp.projDir, 'sess-p.jsonl'), [
      usageLine('m1', now, 'sess-p'),
      usageLine('m2', now + 10, 'sess-p'),
    ]);
    writeJsonl(path.join(tmp.projDir, 'sess-p/subagents/agent-aaa.jsonl'), [
      subagentLine('s1', now + 5, 'inner-1', 'agent-a', { credit: 9.9 }),
    ]);

    const scanner = newScanner(tmp);
    const store = new Store(scanner);
    await store.refresh();

    const list = store.recordsForSession('sess-p');
    assert.equal(list.length, 3, '父会话明细应含子代理记录');
    const s = summarize(list);
    assert.equal(s.credit, 0.5 + 0.5 + 9.9);

    // 与 /api/session 的 contextGrowth 同口径：排除子代理与镜像行
    const curve = list.filter((r) => !r.isSubAgent && !r.creditOnly);
    assert.equal(curve.length, 2);
  } finally {
    tmp.cleanup();
  }
});

/* ── F8 parseChunk 直测：credit-usage 行 + isSubAgent 行内标记 ────────── */

test('F8 parseChunk：credit-usage 合成 + 行内 isSubAgent 标记', () => {
  const now = Date.now();
  const text = [
    usageLine('m1', now, 'sess-x'),
    creditUsageLine('cu-1', now + 1, 4.2),
    // 行内 isSubAgent=true（不依赖文件位置）
    JSON.stringify({
      type: 'message',
      timestamp: now + 2,
      sessionId: 'sess-x',
      role: 'assistant',
      providerData: {
        messageId: 'inline-sub-1',
        model: 'm',
        agent: 'inline-agent',
        isSubAgent: true,
        rawUsage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, credit: 1.1 },
      },
    }),
  ].join('\n');

  const { records } = parseChunk(text + '\n', { projectId: 'p', sessionId: 'sess-x' });
  assert.equal(records.length, 3);
  const cu = records.find((r) => r.creditOnly);
  assert.equal(cu.credit, 4.2);
  assert.equal(cu.kind, 'credit-usage');
  const inline = records.find((r) => r.id === 'inline-sub-1');
  assert.equal(inline.isSubAgent, true);
  assert.equal(inline.agent, 'inline-agent');
  const main = records.find((r) => r.id === 'm1');
  assert.equal(main.isSubAgent, false);
});
