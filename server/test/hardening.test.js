/**
 * 第 4 步加固项的服务端单测：本地边界 + 扫描防重入。
 *
 * 这些都是纯逻辑，不需要启动服务、也不需要真实 WorkBuddy 数据。
 * 运行：node --test server/test/hardening.test.js（根 npm test 会一并执行）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST,
  PORT,
  CORS_ORIGINS,
  CORS_ALLOW_ALL,
  corsAllowOrigin,
  isAllowedHost,
} from '../src/config.js';
import { Store } from '../src/store.js';

test('默认只绑定 IPv4 回环', () => {
  assert.equal(HOST, '127.0.0.1', 'HOST 不应默认暴露到局域网');
  assert.equal(PORT, 5178);
});

test('CORS 默认白名单只包含回环来源', () => {
  assert.equal(CORS_ALLOW_ALL, false, '默认不能放行任意来源');
  assert.ok(!CORS_ORIGINS.has('*'));
  assert.ok(CORS_ORIGINS.has('http://127.0.0.1:5178'));
  assert.ok(CORS_ORIGINS.has('http://localhost:5178'));
  assert.ok(CORS_ORIGINS.has('http://127.0.0.1:5177'), 'Vite dev server 需保留');
  assert.ok(!CORS_ORIGINS.has('http://192.168.1.10:5178'));
});

test('corsAllowOrigin：同源不下发、白名单回显、其它来源拒绝', () => {
  assert.equal(corsAllowOrigin(undefined), null);
  assert.equal(corsAllowOrigin(''), null);
  assert.equal(corsAllowOrigin('http://127.0.0.1:5177'), 'http://127.0.0.1:5177');
  assert.equal(corsAllowOrigin('http://[::1]:5178'), 'http://[::1]:5178');
  assert.equal(corsAllowOrigin('http://evil.example'), null);
  assert.equal(corsAllowOrigin('http://127.0.0.1.evil.example'), null);
  assert.equal(corsAllowOrigin('null'), null);
});

test('isAllowedHost：只放行本机主机名，挡非本机 Host 头', () => {
  assert.equal(isAllowedHost('127.0.0.1:5178'), true);
  assert.equal(isAllowedHost('localhost:5178'), true);
  assert.equal(isAllowedHost('LOCALHOST:5178'), true, 'Host 不区分大小写');
  assert.equal(isAllowedHost('[::1]:5178'), true);
  assert.equal(isAllowedHost(undefined), true, 'HTTP/1.0 无 Host 时放行回环直连');
  assert.equal(isAllowedHost('evil.example'), false);
  assert.equal(isAllowedHost('evil.example:5178'), false);
  assert.equal(isAllowedHost('192.168.1.10:5178'), false);
  assert.equal(isAllowedHost('127.0.0.1.evil.example:5178'), false);
});

test('Store.refresh 并发调用只扫描一次', async () => {
  let scans = 0;
  const fakeScanner = {
    scan: async () => {
      scans++;
      // 故意慢一点，让三个调用撞在同一拍
      await new Promise((r) => setTimeout(r, 25));
      return false;
    },
    all: () => ({ records: [], sessions: [], timelines: [] }),
  };
  const store = new Store(fakeScanner);
  const results = await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
  assert.equal(scans, 1, '并发 refresh 应共享同一个 in-flight Promise');
  assert.deepEqual(results, [false, false, false]);
  assert.equal(store.refreshing, null, '结束后必须清空 in-flight 标记');
  assert.ok(store.lastScanAt > 0);

  // 下一拍应能重新开始扫描，不能被上一次的锁永久挡住
  await store.refresh();
  assert.equal(scans, 2);
});

test('Store.refresh 扫描失败后仍能重试', async () => {
  let calls = 0;
  const fakeScanner = {
    scan: async () => {
      calls++;
      if (calls === 1) throw new Error('模拟 IO 失败');
      return false;
    },
    all: () => ({ records: [], sessions: [], timelines: [] }),
  };
  const store = new Store(fakeScanner);
  await assert.rejects(store.refresh(), /模拟 IO 失败/);
  assert.equal(store.refreshing, null, '失败也要释放锁，否则定时扫描会永久停摆');
  await store.refresh();
  assert.equal(calls, 2);
});
