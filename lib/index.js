/**
 * dsh-subagent-model-config — Host 半边
 *
 * 让「编队队员（Team teammate）」跑在用户配置的模型与推理档位上。
 *
 * ── 断点（为什么要做这个插件）────────────────────────────────────────
 * 编队工具 `spawn_teammate` 只有 name/description/prompt/context 四个参数，
 * **没有 model**；而官方 `SubagentStartRequest.agentOptions` 原生支持
 * provider/model/reasoningEffort。编队路径没把它接上，队员只能继承默认模型。
 *
 * ── 包装点（P0 双证：静态接线 + 运行时实证）──────────────────────────
 * 静态链（行号以 0.1.7-alpha.2 为准，可能随版本漂移）：
 *   `spawn_teammate`(tool-agent-team:271) → `agentTeams.spawnTeammate`
 *   → `TeamRoster.spawn` → `spawnAdmitted`(agent-team:544)
 *   → `this.ctx.subagents.startContinuable`(agent-team:573)
 *   → `SubagentRuntime.prototype.startContinuable`(dsh-subagent:3046 → :3047 委托)
 *   → `SubagentContinuationManager.startContinuable`(:1671)
 *   → `resolveChildAgentOptions(parent, request.agentOptions, …)`(:1680)
 *   → `materialize({ agentOptions })`(:1730) → `agents.create({ agentOptions })`(:1082)
 * 单例依据：`super(ctx, "subagents")`（dsh-subagent 约 :3001）—— 同一 service key
 *   全局一个实例，故 TeamRoster 的 `this.ctx.subagents` 与我们 `ctx.get('subagents')` 同源。
 * 运行时实证（P0 冒烟，见 .probe.jsonl）：wrapper 被真实调用，且
 *   `spawnTeammate-called{name:"verifier"}` 与
 *   `startContinuable-called{hasStore:true, resolvedName:"verifier"}` 成对出现。
 *
 * ── 为什么「实例 + 原型」双装 ────────────────────────────────────────
 * `ctx.get('subagents')` 每次返回**新的 cordis 服务代理**，其 get trap 返回的
 * 也不是同引用函数。P0 实测出现过「实例包装明明生效、`obj[m] === wrapper`
 * 却报 false」的假阴性，所以：
 *   · 判定是否装上，一律用 `Object.getOwnPropertyDescriptor`（走 defineProperty
 *     转发后的真实值），**绝不**用 `===` 比较经 get trap 取回的函数；
 *   · 实例与原型装**同一个** wrapper 函数 —— 实例自有属性命中时不会走到原型，
 *     两层天然只有一层执行，不需要额外的去重逻辑，但任一层失效另一层仍兜住。
 *   · 另有 `APPLIED` 符号做最终幂等保险。
 *
 * ── 为什么需要 AsyncLocalStorage 传名 ────────────────────────────────
 * startContinuable 的 spec 里**没有队员名**（agent-team:573 只传
 * `{ childId, provider, label: description, request:{prompt,parent}, signal }`，
 * 实测 `requestKeys:["prompt","parent"]`）。队员名只出现在上游
 * `agentTeams.spawnTeammate(caller, { name, … })`。两者在同一条 await 链上，
 * 用 ALS 随异步上下文传递，对并发 spawn 天然隔离。
 *
 * ── 取证纪律（F3 修复后）────────────────────────────────────────────
 * 启动自检（每次插件加载一次，有界）无条件写；**每次 startContinuable 的取证
 * 只在 `config.json` 的 `debug:true` 时写** —— 取证代码不留在生产热路径上。
 * 写盘有大小上限并轮转，不会无界增长。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────
 * 官方文件零接触；包装全部可逆；配置为空或 enabled:false 时行为与未装本插件
 * 完全一致；任何内部异常只记录、不抛出，绝不阻断 spawn。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, resolveRule, ruleToAgentOptions } from './config.js';
import { RPC_CHANNEL, createHandler } from './rpc.js';
import { mountWebRoute } from './web-route.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = join(ROOT, 'config.json');
const PROBE_FILE = join(ROOT, '.probe.jsonl');
const PROBE_PREV = join(ROOT, '.probe.prev.jsonl');
/** 取证文件上限：超过即轮转一次（旧的直接覆盖），保证有界。 */
const PROBE_MAX_BYTES = 256 * 1024;
/** 每写这么多次检查一次大小，避免每次写都 statSync。 */
const PROBE_SIZE_CHECK_EVERY = 200;

/** 队员名随异步链传播的载体：spawnTeammate 写入，startContinuable 读取。 */
export const teammateScope = new AsyncLocalStorage();

/** 幂等标记：同一份 spec 被本插件处理过就不再处理。 */
const APPLIED = Symbol('dsh-subagent-model-config.applied');

let probeWrites = 0;

/**
 * 写一行取证。任何失败都吞掉 —— 取证绝不能影响 spawn。
 * @param entry - 要记录的对象。
 */
function writeProbe(entry) {
  try {
    probeWrites += 1;
    if (probeWrites % PROBE_SIZE_CHECK_EVERY === 0) {
      try {
        if (statSync(PROBE_FILE).size > PROBE_MAX_BYTES) renameSync(PROBE_FILE, PROBE_PREV);
      } catch { /* 文件不存在等情况忽略 */ }
    }
    appendFileSync(PROBE_FILE, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* 取证写盘失败绝不能影响主流程 */
  }
}

/**
 * 读配置，按 mtime 缓存。
 *
 * 为什么需要缓存：`startContinuable` 在 spawn 关键路径上，每次同步读盘是白付的
 * 代价（F3）。mtime 变了就重读，所以「改配置立即生效、无需重启」的语义不变。
 * @returns 规范化配置。
 */
let configCache = { mtimeMs: -1, size: -1, config: null };
function currentConfig() {
  try {
    const stat = statSync(CONFIG_FILE);
    if (configCache.config !== null && configCache.mtimeMs === stat.mtimeMs && configCache.size === stat.size) {
      return configCache.config;
    }
    const config = loadConfig(CONFIG_FILE);
    configCache = { mtimeMs: stat.mtimeMs, size: stat.size, config };
    return config;
  } catch {
    return loadConfig(CONFIG_FILE);
  }
}

/**
 * 在一个对象（实例或原型）上换方法，返回安装证据与还原函数。
 *
 * ⚠️ 判定「是否装上」必须用 `Object.getOwnPropertyDescriptor`，**不能**用
 * `obj[method] === wrapper`：cordis 服务代理的 get trap 返回的不是同引用
 * （P0 实测：实例包装已生效、wrapper 被真实调用，`===` 却报 false）。
 * @param target - 实例或原型。
 * @param method - 方法名。
 * @param wrapper - 新实现。
 * @returns {{installed:boolean, viaOwn:boolean, error?:string, restore:() => void}}
 */
function patchMethod(target, method, wrapper) {
  const own = Object.getOwnPropertyDescriptor(target, method);
  const proto = Object.getPrototypeOf(target);
  const inherited = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, method);
  const before = own ?? inherited;
  if (before === undefined || before.value === undefined) {
    return { installed: false, viaOwn: false, error: 'method not found', restore: () => {} };
  }
  try {
    Object.defineProperty(target, method, {
      value: wrapper,
      writable: true,
      configurable: true,
      enumerable: before.enumerable,
    });
  } catch (error) {
    return { installed: false, viaOwn: false, error: String(error?.message ?? error), restore: () => {} };
  }
  const after = Object.getOwnPropertyDescriptor(target, method);
  return {
    installed: after?.value === wrapper,
    viaOwn: own === undefined,
    restore: () => {
      try {
        if (own === undefined) delete target[method];
        else Object.defineProperty(target, method, own);
      } catch { /* 还原失败时原方法仍在闭包里，不影响后续重装 */ }
    },
  };
}

/**
 * 把同一 wrapper 装到实例与原型两层，返回合并证据与还原函数。
 * @param instance - 服务实例（可能是代理）。
 * @param proto - 该实例的原型。
 * @param method - 方法名。
 * @param wrapper - 新实现。
 * @returns {{anyInstalled:boolean, instance:object, proto:object, restore:() => void}}
 */
function patchBoth(instance, proto, method, wrapper) {
  const onInstance = patchMethod(instance, method, wrapper);
  const onProto = proto === null
    ? { installed: false, viaOwn: false, error: 'no prototype', restore: () => {} }
    : patchMethod(proto, method, wrapper);
  return {
    anyInstalled: onInstance.installed || onProto.installed,
    instance: { installed: onInstance.installed, viaOwn: onInstance.viaOwn, error: onInstance.error ?? null },
    proto: { installed: onProto.installed, viaOwn: onProto.viaOwn, error: onProto.error ?? null },
    // 还原顺序：先撤实例自有属性，再还原原型 —— 反过来会留下实例层的 wrapper。
    restore: () => {
      onInstance.restore();
      onProto.restore();
    },
  };
}

/** 当前进程内是否已装过（防重入：HMR / 重复 apply 时不叠加包装）。 */
let installed = null;

function install(scoped) {
  const subagents = scoped.get('subagents');
  const agentTeams = scoped.get('agentTeams');
  const restores = [];

  const subProto = subagents === undefined ? null : Object.getPrototypeOf(subagents);
  const teamProto = agentTeams === undefined ? null : Object.getPrototypeOf(agentTeams);

  // ── 启动自检（有界：每次插件加载一次，无条件写）────────────────────
  writeProbe({
    phase: 'self-check',
    subProtoName: subProto?.constructor?.name ?? null,
    teamProtoName: teamProto?.constructor?.name ?? null,
    subProtoStable: subProto !== null && subProto === Object.getPrototypeOf(scoped.get('subagents')),
    subStartWritable: subProto === null ? null : Object.getOwnPropertyDescriptor(subProto, 'startContinuable')?.writable ?? null,
    teamSpawnWritable: teamProto === null ? null : Object.getOwnPropertyDescriptor(teamProto, 'spawnTeammate')?.writable ?? null,
    configFile: CONFIG_FILE,
  });

  // ── ① 队员名采集点（纯 ALS，无任何 I/O）──────────────────────────
  let spawnWrapper = null;
  if (agentTeams !== undefined && teamProto !== null) {
    const original = teamProto.spawnTeammate;
    spawnWrapper = function spawnTeammateWithScope(...args) {
      const request = args[1];
      return teammateScope.run(
        { name: request?.name, provider: request?.provider },
        () => original.apply(this ?? agentTeams, args),
      );
    };
    const result = patchBoth(agentTeams, teamProto, 'spawnTeammate', spawnWrapper);
    writeProbe({ phase: 'patch-spawnTeammate', ...result });
    if (result.anyInstalled) restores.push(result.restore);
    else spawnWrapper = null;
  }

  // ── ② 注入点 ────────────────────────────────────────────────────
  let startWrapper = null;
  if (subagents !== undefined && subProto !== null) {
    const original = subProto.startContinuable;
    startWrapper = function startContinuableWithModel(spec) {
      if (spec?.[APPLIED] === true) return original.call(this ?? subagents, spec);
      let nextSpec = spec;
      try {
        const store = teammateScope.getStore();
        const config = currentConfig();
        const rule = resolveRule(config, store?.name);
        const injected = ruleToAgentOptions(rule);
        if (config.debug === true) {
          writeProbe({
            phase: 'startContinuable-called',
            hasStore: store !== undefined,
            resolvedName: store?.name ?? null,
            enabled: config.enabled,
            matched: rule?.match ?? null,
            injected,
            specProvider: spec?.provider ?? null,
          });
        }
        if (injected !== null && spec?.request !== undefined) {
          // 不改原对象：另起一份 spec/request，其余引用原样带过。
          nextSpec = {
            ...spec,
            [APPLIED]: true,
            request: {
              ...spec.request,
              agentOptions: { ...(spec.request.agentOptions ?? {}), ...injected },
            },
          };
        }
      } catch (error) {
        // 异常低频且值得留痕，不受 debug 开关约束。
        writeProbe({ phase: 'startContinuable-error', error: String(error?.message ?? error) });
      }
      return original.call(this ?? subagents, nextSpec);
    };
    const result = patchBoth(subagents, subProto, 'startContinuable', startWrapper);
    writeProbe({ phase: 'patch-startContinuable', ...result });
    if (result.anyInstalled) restores.push(result.restore);
    else startWrapper = null;
  }

  // ── ③ 决定性自检：重新 get 后，描述符里读到的确为我们的 wrapper ──
  const freshSub = scoped.get('subagents');
  const freshTeam = scoped.get('agentTeams');
  writeProbe({
    phase: 'post-patch-identity',
    freshIsNewProxy: freshSub !== subagents,
    // 描述符判定（可靠）：绕过 get trap 直接读 defineProperty 后的真实值。
    instanceCarriesStart: Object.getOwnPropertyDescriptor(freshSub, 'startContinuable')?.value === startWrapper,
    protoCarriesStart: subProto !== null && Object.getOwnPropertyDescriptor(subProto, 'startContinuable')?.value === startWrapper,
    instanceCarriesSpawn: Object.getOwnPropertyDescriptor(freshTeam, 'spawnTeammate')?.value === spawnWrapper,
    protoCarriesSpawn: teamProto !== null && Object.getOwnPropertyDescriptor(teamProto, 'spawnTeammate')?.value === spawnWrapper,
  });

  return () => {
    for (const restore of restores) restore();
    writeProbe({ phase: 'disposed' });
  };
}

export function apply(ctx) {
  writeProbe({ phase: 'apply-enter', version: '0.1.0' });

  // ── 设置页 ⇄ Host 的 RPC 通道（阶段二）──────────────────────────
  // ⚠️ 必须挂在**作用域闭包**里，不能在 apply 里直接调：
  // 新版 dsh 的 client-connection 把 inject 收缩为 ['credentials']，直接调
  // rpc.handle 时其内部访问 owner.webServer 会抛 "cannot get property without inject"
  // 并**阻断整个 web boot**（dsh-pocket 为此发过 pnpm patch）。官方 api-gateway
  // 同款模式：依赖就绪后才注册。失败只记取证，绝不影响下面的包装安装。
  ctx.inject(['connection', 'webServer'], (rpcScope) => {
    try {
      const handler = createHandler({
        configFile: CONFIG_FILE,
        llm: rpcScope.get('llm'),
        log: ctx.logger ?? console,
      });
      // ⚠️ 不用 rpcScope.connection.rpc.handle：新版 dsh 的 client-connection 自身
      // inject 已收缩为 ['credentials']，其内部访问 owner.webServer 必抛
      // "cannot get property \"webServer\" without inject" —— 实测挂载失败过一次，
      // 且**插件侧的作用域闭包救不了它**（抛错的是 connection 自己的 ctx）。
      // 故走 dsh-pocket 的优先路径：自己 inject webServer 并 register 一条 prefix 路由。
      const dispose = mountWebRoute({
        webServer: rpcScope.get('webServer'),
        connection: rpcScope.get('connection'),
        channel: RPC_CHANNEL,
        handler,
        log: ctx.logger ?? console,
      });
      if (dispose === null) {
        writeProbe({ phase: 'rpc-mount-failed', error: 'webServer.register unavailable' });
        return undefined;
      }
      writeProbe({ phase: 'rpc-mounted', channel: RPC_CHANNEL, via: 'webServer.register' });
      return dispose;
    } catch (error) {
      writeProbe({ phase: 'rpc-mount-failed', error: String(error?.message ?? error) });
      return undefined;
    }
  });

  ctx.inject(['subagents', 'agentTeams'], (scoped) => {
    if (installed !== null) {
      writeProbe({ phase: 'skip-reinstall' });
      return installed;
    }
    const dispose = install(scoped);
    installed = () => {
      installed = null;
      dispose();
    };
    if (typeof ctx.effect === 'function') {
      return ctx.effect(() => installed, 'subagent-model-config.prototype-patch');
    }
    return installed;
  });
}
