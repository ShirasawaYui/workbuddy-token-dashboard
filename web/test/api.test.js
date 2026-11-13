import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('同 URL 的进行中 GET 复用同一个请求，两个调用方拿到同一份结果', async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let calls = 0;
  let release;
  globalThis.fetch = (url) => {
    calls += 1;
    assert.equal(url, '/api/meta');
    return new Promise((resolve) => (release = () => resolve(jsonResponse({ revision: 7 }))));
  };
  const a = api.meta();
  const b = api.meta();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await a, { revision: 7 });
  assert.deepEqual(await b, { revision: 7 });
});

test('失败的 GET 会清理 in-flight，下一次调用可以正常重试', async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(calls === 1 ? jsonResponse({ error: 'once' }, 503) : jsonResponse({ ok: true }));
  };
  await assert.rejects(api.meta(), /once/);
  assert.deepEqual(await api.meta(), { ok: true });
  assert.equal(calls, 2);
});

test('强制刷新先等旧 GET 收尾，并拒绝把 HTTP 500 当成功', async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const order = [];
  let releaseMeta;
  globalThis.fetch = (url, init) => {
    order.push(url);
    if (url === '/api/meta') {
      return new Promise((resolve) => (releaseMeta = () => resolve(jsonResponse({ revision: 1 }))));
    }
    assert.equal(init.method, 'POST');
    return Promise.resolve(jsonResponse({ error: 'scan failed' }, 500));
  };
  const pendingMeta = api.meta();
  const pendingRefresh = api.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['/api/meta'], '旧 GET 未完成时不应开始强制刷新');
  releaseMeta();
  await pendingMeta;
  await assert.rejects(pendingRefresh, /scan failed/);
  assert.deepEqual(order, ['/api/meta', '/api/refresh']);
});
