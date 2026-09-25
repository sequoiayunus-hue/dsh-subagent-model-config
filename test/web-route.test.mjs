/**
 * wire 协议单测 —— dsh-subagent-model-config 阶段二的传输层。
 *
 * 为什么必须有这一组：阶段二首轮上线时 RPC **挂载失败**（`rpc.handle` 在新版抛
 * `cannot get property "webServer" without inject`），浏览器侧表现为
 * `transport failure … HTTP 405` —— 当时没有任何测试覆盖「路由挂载 + 请求分发」，
 * 所以静态全绿也拦不住。本组用 mock req/res 把每条 wire 分支钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endpointFromPath, serverResponseJson, mountWebRoute } from '../lib/web-route.js';

const CHANNEL = '/smc';

/** 最小 node:http 请求替身（readBody 依赖异步迭代）。 */
function makeReq({ method = 'POST', url = `${CHANNEL}/config.get`, headers = { host: '127.0.0.1:3080' }, body = '' } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield Buffer.from(body, 'utf8');
    },
  };
}

/** 最小 node:http 响应替身。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, h) { this.statusCode = status; this.headers = h; return this; },
    end(b) { this.body = typeof b === 'string' ? b : ''; this.writableEnded = true; return this; },
  };
}

/** 挂载并取回被注册的 route。 */
function mount(handler, options = {}) {
  let captured = null;
  const webServer = { register(route) { captured = route; return () => { captured = null; }; } };
  const dispose = mountWebRoute({
    webServer,
    channel: CHANNEL,
    handler,
    log: { warn() {} },
    ...options,
  });
  assert.ok(captured !== null, 'route 应被注册到 webServer');
  return { route: captured, dispose };
}

const envelope = (method, payload = {}, rpcId = 'rpc-1') => JSON.stringify({ rpcId, method, payload });

test('endpointFromPath — 正常与非法段', () => {
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/config.get`), 'config.get');
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/a/b`), 'a/b');
  assert.equal(endpointFromPath(CHANNEL, '/other/config.get'), undefined, '通道不符');
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/`), undefined, '空段');
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/..`), undefined, '父目录段');
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/a b`), undefined, '非法字符');
});

test('serverResponseJson — 信封形状与官方 fullResponse 对齐', () => {
  const parsed = JSON.parse(serverResponseJson('rpc-9', { ok: true, value: 1 }));
  assert.deepEqual(parsed, { type: 'server-response', rpcId: 'rpc-9', result: { ok: true, value: 1 } });
});

test('挂载：webServer 缺失时返回 null（调用方据此判失败）', () => {
  assert.equal(mountWebRoute({ webServer: undefined, channel: CHANNEL, handler: async () => ({}) }), null);
  assert.equal(mountWebRoute({ webServer: {}, channel: CHANNEL, handler: async () => ({}) }), null);
});

test('405 —— 非 POST', async () => {
  const { route } = mount(async () => ({ ok: true, value: 1 }));
  const res = makeRes();
  await route.handler(makeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
});

test('404 —— 路径不在通道下', async () => {
  const { route } = mount(async () => ({ ok: true, value: 1 }));
  const res = makeRes();
  await route.handler(makeReq({ url: '/elsewhere/config.get' }), res);
  assert.equal(res.statusCode, 404);
});

test('403 —— 非 loopback Host（无 requestRejection 时的兜底栅栏）', async () => {
  const { route } = mount(async () => ({ ok: true, value: 1 }));
  const res = makeRes();
  await route.handler(makeReq({ headers: { host: 'evil.example.com' } }), res);
  assert.equal(res.statusCode, 403);
});

test('403 —— connection.requestRejection 判 forbidden（以方法形式调用）', async () => {
  let called = false;
  const connection = {
    trustedHosts: ['127.0.0.1'],
    requestRejection(req) {
      called = true;
      // 必须是方法调用，否则 this 丢失 —— 这里读 this.trustedHosts 就是那个断言
      return this.trustedHosts.includes(String(req.headers.host).split(':')[0]) ? undefined : 403;
    },
  };
  const { route } = mount(async () => ({ ok: true, value: 1 }), { connection });
  const denied = makeRes();
  await route.handler(makeReq({ headers: { host: 'evil.example.com' } }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(called, true, 'requestRejection 应被调用');

  const allowed = makeRes();
  await route.handler(makeReq({ body: envelope('config.get') }), allowed);
  assert.equal(allowed.statusCode, 200, 'loopback 应放行');
});

test('400 —— body 不是 JSON', async () => {
  const { route } = mount(async () => ({ ok: true, value: 1 }));
  const res = makeRes();
  await route.handler(makeReq({ body: 'not json{' }), res);
  assert.equal(res.statusCode, 400);
});

test('200 + bad-request —— 信封缺 rpcId 或 method', async () => {
  const { route } = mount(async () => ({ ok: true, value: 1 }));
  for (const bad of ['{}', JSON.stringify({ rpcId: 'r' }), JSON.stringify({ method: 'config.get' })]) {
    const res = makeRes();
    await route.handler(makeReq({ body: bad }), res);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.type, 'server-response');
    assert.equal(parsed.result.ok, false);
    assert.equal(parsed.result.error.code, 'bad-request');
  }
});

test('200 + bad-request —— method 与 endpoint 不匹配', async () => {
  const { route } = mount(async () => ({ ok: true, value: 1 }));
  const res = makeRes();
  await route.handler(makeReq({ body: envelope('config.set') }), res);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.rpcId, 'rpc-1');
  assert.equal(parsed.result.ok, false);
  assert.match(parsed.result.error.message, /does not match endpoint/);
});

test('200 —— 正常分发：payload 透传、result 原样回填、rpcId 回显', async () => {
  let seen = null;
  const { route } = mount(async (endpoint, payload) => {
    seen = { endpoint, payload };
    return { ok: true, value: { echo: payload.n } };
  });
  const res = makeRes();
  await route.handler(makeReq({ body: envelope('config.get', { n: 42 }, 'rpc-abc') }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(seen, { endpoint: 'config.get', payload: { n: 42 } });
  assert.deepEqual(JSON.parse(res.body), {
    type: 'server-response',
    rpcId: 'rpc-abc',
    result: { ok: true, value: { echo: 42 } },
  });
});

test('500 —— handler 抛错', async () => {
  const { route } = mount(async () => { throw new Error('boom'); });
  const res = makeRes();
  await route.handler(makeReq({ body: envelope('config.get') }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body, /boom/);
});

test('413 —— 声明 content-length 超限', async () => {
  const { route } = mount(async () => ({ ok: true, value: 1 }), { maxBodyBytes: 16 });
  const res = makeRes();
  await route.handler(makeReq({ headers: { host: '127.0.0.1', 'content-length': '9999' }, body: envelope('config.get') }), res);
  assert.equal(res.statusCode, 413);
});

test('413 —— 流式读取超限（未声明 content-length）', async () => {
  const { route } = mount(async () => ({ ok: true, value: 1 }), { maxBodyBytes: 8 });
  const res = makeRes();
  await route.handler(makeReq({ body: envelope('config.get') }), res);
  assert.equal(res.statusCode, 413);
});

test('disposer 规整 —— register 返回函数 / Promise / undefined 三种形态都可调用', async () => {
  for (const shape of ['fn', 'promise', 'none']) {
    let captured = null;
    const webServer = {
      register(route) {
        captured = route;
        if (shape === 'fn') return () => {};
        if (shape === 'promise') return Promise.resolve(() => {});
        return undefined;
      },
    };
    const dispose = mountWebRoute({ webServer, channel: CHANNEL, handler: async () => ({}) });
    assert.ok(captured !== null, `${shape}: route 应被注册`);
    assert.equal(typeof dispose, 'function', `${shape}: 应返回可调用 disposer`);
    await dispose();
  }
});
