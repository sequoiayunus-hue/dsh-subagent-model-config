/**
 * dsh-subagent-model-config — Host 侧 HTTP 路由挂载（wire 协议复刻）
 *
 * ## 为什么不直接用 ctx.connection.rpc.handle（实测踩过，别再试）
 * 新版 dsh 的 client-connection 把自身 inject 收缩为 `['credentials']`，其 `rpc.handle`
 * 内部访问 `owner.webServer` 必抛 `cannot get property "webServer" without inject`。
 * **在插件侧用 `ctx.inject(['connection','webServer'], …)` 作用域闭包也救不了它** ——
 * 抛错的是 connection 服务自己的 ctx，与插件的 scope 是否就绪无关。
 * （2026-09-23 实测：`.probe.jsonl` 记 `rpc-mount-failed`，error 正是此串；表现为
 * 浏览器点开卡片报 `transport failure … HTTP 405`，因为请求落到了静态文件服务。）
 *
 * 故走 dsh-pocket 的**优先路径**：插件自己 inject `webServer` 并 `webServer.register`
 * 一条 prefix 路由，逐分支复刻 dsh-client-connection 的 `/api` 传输语义。
 *
 * ## wire 协议（与官方 rpcFetchHandler 对齐，逐字节）
 *   请求   POST `<channel>/<endpoint>`   content-type: application/json
 *          body `{ rpcId: string, method: string, payload?: any }`
 *   响应   200 `{ type: 'server-response', rpcId, result }`（result = handler 返回值）
 *   异常   404 非 POST 或无 endpoint ／ 415 content-type 不对 ／ 400 body 非 JSON
 *          413 body 超限 ／ 500 handler 抛错
 *
 * ## 两个用 issue 换来的坑
 * 1. **必须持有 connection 本体并以方法形式调 `requestRejection`**：它是类方法，内部读
 *    `this.trustedHosts` / `this.browserAuth`。抽成裸函数再调会丢 this → TypeError →
 *    被 catch 兜底成 403 → **任何**请求（本机/浏览器/移动端）都被判 forbidden。
 * 2. `webServer.register()` 返回值三态：disposer ／ `Promise<disposer>` ／ `undefined`，
 *    不规整会漏清理。
 */
import { Buffer } from 'node:buffer';

/** endpoint 段字符（与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 对齐）。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** 信封校验失败时的兜底 rpcId（与 dsh 内部 INVALID_REQUEST_RPC_ID 对齐）。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** 默认请求体上限：1 MB（本插件所有载荷都是小控制 JSON）。 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** 从 `<channel>/<endpoint>` 取 endpoint，段非法时返回 undefined。 */
export function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT_PATTERN.test(seg))) {
    return undefined;
  }
  return endpoint;
}

/** 构造 server-response JSON 串（字段与官方 fullResponse 对齐）。 */
export function serverResponseJson(rpcId, result) {
  return JSON.stringify({ type: 'server-response', rpcId, result });
}

/** 旧版 dsh / 无 connection.requestRejection 时的最小信任栅栏：仅放行 loopback。 */
function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (host === undefined) return false;
  const hostName = host.split(':')[0];
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 读满请求体，超限返回 null（调用方回 413）。 */
async function readBody(req, maxBytes) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) return null;
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * 把一条 prefix 路由挂到插件自己 inject 的 webServer 上。
 * @param options.webServer - 已就绪的 webServer 服务。
 * @param options.connection - 已就绪的 connection 服务（用于鉴权栅栏）。
 * @param options.channel - 通道前缀，如 `/subagent-model-config`。
 * @param options.handler - 业务 handler `(endpoint, payload, signal) => result`。
 * @param options.log - 日志。
 * @returns 幂等清理函数；webServer 不可用时返回 null（调用方应视为挂载失败）。
 */
export function mountWebRoute({ webServer, connection, channel, handler, log = console, maxBodyBytes = DEFAULT_MAX_BODY_BYTES }) {
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return null;

  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      // ── ① 鉴权栅栏（以方法形式调用，见文件头坑 1）──
      let rejection;
      if (typeof connection?.requestRejection === 'function') {
        try {
          rejection = connection.requestRejection(req);
        } catch {
          rejection = 403;
        }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
      if (rejection !== undefined) {
        sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }

      // ── ② 方法与路径 ──
      if (req.method !== 'POST') {
        sendText(res, 405, 'method not allowed');
        return;
      }
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname;
      const endpoint = endpointFromPath(channel, pathname);
      if (endpoint === undefined) {
        sendText(res, 404, 'not found');
        return;
      }

      // ── ③ 请求体 ──
      let raw;
      try {
        raw = await readBody(req, maxBodyBytes);
      } catch (error) {
        log?.warn?.(`dsh-subagent-model-config: 读取请求体失败 ${error?.message ?? error}`);
        sendText(res, 400, 'body read failed');
        return;
      }
      if (raw === null) {
        sendText(res, 413, 'payload too large');
        return;
      }

      // ── ④ 信封校验 ──
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendText(res, 400, 'body is not JSON');
        return;
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID;
      const method = typeof body?.method === 'string' ? body.method : null;
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        sendJson(res, 200, serverResponseJson(INVALID_REQUEST_RPC_ID, {
          ok: false,
          error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: [] } },
        }));
        return;
      }
      if (method !== endpoint) {
        sendJson(res, 200, serverResponseJson(rpcId, {
          ok: false,
          error: {
            code: 'bad-request',
            message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          },
        }));
        return;
      }

      // ── ⑤ 业务 ──
      // ⚠️ 桌面宿主（Electron app 协议转发）给的 req.signal 实测进入即 aborted——
      // 官方路由从不拿它做准入闸门。这里同样只把它当"尽力而为的取消合作"：
      // 已废的信号按无信号处理，绝不据此拒绝服务（2026-10-01 探针定案）。
      const handlerSignal = req.signal?.aborted === true ? undefined : req.signal;
      try {
        const result = await handler(endpoint, body.payload, handlerSignal);
        sendJson(res, 200, serverResponseJson(rpcId, result));
      } catch (error) {
        log?.warn?.(`dsh-subagent-model-config: rpc ${endpoint} 失败 ${error?.stack ?? error}`);
        sendText(res, 500, `handler failure: ${String(error)}`);
      }
    },
  };

  const registered = webServer.register(route);
  // register 返回值三态（见文件头坑 2），统一规整成可幂等调用的清理函数。
  if (typeof registered === 'function') {
    return () => { try { registered(); } catch { /* 已清理 */ } };
  }
  if (registered !== null && typeof registered?.then === 'function') {
    return async () => {
      try {
        const disposer = await registered;
        if (typeof disposer === 'function') disposer();
      } catch { /* 已清理 */ }
    };
  }
  return () => {};
}
