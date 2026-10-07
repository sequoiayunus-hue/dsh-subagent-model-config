/**
 * dsh-subagent-model-config — Host 侧 RPC（loopback-only）
 *
 * 契约（与 dsh-pocket 同构，wire 协议由官方 connection.rpc 代管）：
 *   服务端  ctx.connection.rpc.handle(CHANNEL, handler, { authority: 'loopback' })
 *   handler async (endpoint, payload, signal) => ok(value) | fail(message)
 *   客户端  ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal)
 *
 * ⚠️ 挂载必须在 `ctx.inject(['connection','webServer'], …)` 的**作用域闭包**里做：
 * 新版 dsh 的 client-connection 把 inject 收缩为 ['credentials']，在 apply 里直接调
 * rpc.handle，其内部访问 owner.webServer 会抛 "cannot get property without inject"
 * 并**阻断整个 web boot**。见 lib/index.js 的挂载点注释。
 *
 * 端点：
 *   config.get      读配置（含 configFile 路径，便于 UI 提示）
 *   config.set      写配置（**严格校验**：不合法即拒绝并回报 issues）
 *   config.catalog  列出 providers 及其模型（供 UI 下拉）
 *   config.efforts  查单个模型的推理档位（选完模型后再拉）
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

import { normalizeConfig } from './config.js';

/** RPC 通道名（客户端 lib/client.js 里有同值副本 —— 浏览器半边无法 import 本模块）。 */
export const RPC_CHANNEL = '/subagent-model-config';

export const ENDPOINTS = Object.freeze({
  get: 'config.get',
  set: 'config.set',
  catalog: 'config.catalog',
  efforts: 'config.efforts',
});

/** 路由字段白名单（与 config.js 的 RULE_FIELDS 一致）。 */
const ROUTE_FIELDS = ['provider', 'model', 'reasoningEffort'];

function ok(value) {
  return { ok: true, value };
}

/** 构造符合 DSH rpcErrorSchema 的错误信封（details 必填且分分支定形）。 */
function fail(message) {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [{ message }] } } };
}

/**
 * 严格校验来自 UI 的配置。
 *
 * 与 `loadConfig` 的「静默退回默认值」刻意不同：读盘失败时静默兜底是对的
 * （不能让 spawn 挂掉），但**写盘**时静默丢弃用户输入是欺骗 —— UI 必须知道错在哪。
 * @param raw - 来自客户端的 payload.config。
 * @returns {{config: object} | {issues: string[]}}
 */
export function validateIncoming(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: ['payload.config 必须是对象'] };
  }
  const issues = [];
  const rules = [];
  if (!Array.isArray(raw.rules)) {
    issues.push('rules 必须是数组');
  } else {
    raw.rules.forEach((rule, index) => {
      const at = `第 ${index + 1} 条`;
      if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
        issues.push(`${at}不是对象`);
        return;
      }
      const match = typeof rule.match === 'string' ? rule.match.trim() : '';
      if (match.length === 0) {
        issues.push(`${at}缺 match（队员名或通配模式，如 reviewer*）`);
        return;
      }
      const out = { match };
      for (const field of ROUTE_FIELDS) {
        if (typeof rule[field] === 'string' && rule[field].trim().length > 0) out[field] = rule[field].trim();
      }
      // note 是给用户看的中文备注，随规则持久化但绝不进路由字段（不注入 agentOptions）。
      if (typeof rule.note === 'string' && rule.note.trim().length > 0) out.note = rule.note.trim();
      // 刻意**不要求**「至少填 model 或 provider」：允许先配角色名、模型待用户指定
      // （「常用 AGENTS」用法）。这类规则不注入任何东西（ruleToAgentOptions 返回
      // null），客户端会标注「未指定模型 —— 此规则不会生效」，所以放宽是安全的。
      rules.push(out);
    });
  }
  if (issues.length > 0) return { issues };
  return { config: { enabled: raw.enabled !== false, debug: raw.debug === true, rules } };
}

/**
 * 构造 RPC handler。
 * @param options.configFile - 配置文件绝对路径。
 * @param options.llm - 可选的 `llm` 服务（取模型目录用；缺失时 catalog 返回空表，UI 退化为自由输入）。
 * @param options.log - 日志（默认 console）。
 * @returns handler(endpoint, payload, signal)。
 */
export function createHandler({ configFile, llm, log = console }) {
  const readConfig = () => {
    try {
      return normalizeConfig(JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')));
    } catch {
      return { enabled: true, debug: false, rules: [] };
    }
  };

  /** 原子写：先写临时文件再 rename，避免半截文件被 loadConfig 读到。 */
  const writeConfig = (config) => {
    const tmp = `${configFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    renameSync(tmp, configFile);
  };

  const buildCatalog = async () => {
    if (typeof llm?.listProviders !== 'function') return { providers: [] };
    let providers = [];
    try {
      providers = llm.listProviders() ?? [];
    } catch (error) {
      log?.warn?.(`dsh-subagent-model-config: listProviders 失败 ${error?.message ?? error}`);
      return { providers: [] };
    }
    const out = [];
    for (const provider of providers) {
      const row = { id: provider.id, name: provider.name ?? provider.id, models: [] };
      try {
        const models = await llm.listModels(provider.id);
        row.models = (models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
      } catch (error) {
        // 单个 provider 拉不到模型不该拖垮整个目录。
        row.error = String(error?.message ?? error);
      }
      out.push(row);
    }
    return { providers: out };
  };

  const resolveEfforts = async (provider, model, signal) => {
    if (typeof llm?.resolveModelInfo !== 'function') return { efforts: [], defaultEffort: null };
    if (typeof provider !== 'string' || typeof model !== 'string') return { efforts: [], defaultEffort: null };
    const info = await llm.resolveModelInfo(provider, model, signal);
    const reasoning = info?.reasoning;
    return {
      efforts: (reasoning?.efforts ?? []).map((e) => ({ id: e.id, name: e.name ?? e.id })),
      defaultEffort: reasoning?.defaultEffort ?? null,
    };
  };

  return async (endpoint, payload = {}, signal) => {
    // 桌面宿主的请求信号进入即 aborted（转发链路特性，2026-10-01 探针定案）——
    // 取消合作降级为尽力而为：废信号当无信号，绝不据此拒绝服务。
    const safeSignal = signal?.aborted === true ? undefined : signal;
    try {
      switch (endpoint) {
        case ENDPOINTS.get:
          return ok({ config: readConfig(), configFile });
        case ENDPOINTS.set: {
          const verdict = validateIncoming(payload?.config);
          if (verdict.issues !== undefined) return fail(`配置不合法：${verdict.issues.join('；')}`);
          writeConfig(verdict.config);
          return ok({ config: verdict.config, savedAt: new Date().toISOString() });
        }
        case ENDPOINTS.catalog:
          return ok(await buildCatalog());
        case ENDPOINTS.efforts:
          return ok(await resolveEfforts(payload?.provider, payload?.model, safeSignal));
        default:
          return fail(`未知端点：${endpoint}`);
      }
    } catch (error) {
      log?.warn?.(`dsh-subagent-model-config RPC 失败（${endpoint}）: ${error?.stack ?? error}`);
      return fail(String(error?.message ?? error));
    }
  };
}
