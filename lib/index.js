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
 *   → `this.ctx.subagents.<seam>`(agent-team:573)
 *   → `SubagentRuntime.prototype.<seam>`(dsh-subagent:3046 → :3047 委托)
 *   → `SubagentContinuationManager.<seam>`(:1671)
 *
 *   ⚠️ <seam> 随 DSH 版本改名：≤0.2.0 叫 `startContinuable`，0.2.1 起叫 `startActivation`。
 *      0.2.1-rc.2 实测：老名字在实例与原型上都不存在，包装会静默失败（probe 记
 *      `patch-startContinuable {"error":"method not found"}`）⇒ 规则全部不生效。
 *      本文件按存在性自适应挑选两个名字，两个版本都能挂上。
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
 * 完全一致。除下面这道闸门外，任何内部异常只记录、不抛出。
 *
 * ── 视频队员名闸门（用户硬要求：执行模型必须人工点名可控）─────────────
 * 视频解析任务用哪个模型、开不开思考，必须由队员名点名决定，禁止任何形式的
 * 自动决定。规则表已无 `video-*` 通配兜底，于是「名字拼错 ⇒ 未命中规则 ⇒
 * 不注入 agentOptions ⇒ 子代理静默继承默认模型」就是一条不可控后门。
 * 故在 spawn 入口直接拒绝：名字以 `video-`/`video_` 开头却未命中任何规则，
 * 立刻抛错、不启动该队员。非视频名字、以及 enabled:false 时行为不变。
 *
 * ── 视频预设下的队员侧能力限制（2026-10-07 用户口径，v0.3.0）──────────
 * 预设管窗口、管不了队员：子代理继承父会话预设（dsh-subagent 的 childSessionMeta），
 * 所以「主窗不限制、队员受限」只能落在子代理级机制上。本插件在同一个包装点，
 * 判定 `composedPreset(parent.ctx) === 'video'` 后注入：
 *   request.persona    —— 队员角色卡，遮蔽部署 persona（主窗身份卡）
 *   request.toolFilter —— { allow } 白名单，进程内后端以 tools.restrict() 执行
 * 判定只看父会话 preset，因此只作用于 video 预设，其它模式的子代理完全不受影响。
 * ⚠️ 白名单只列**继承层**工具：团队通信工具注册在成员 own 层，而 restrict() 从不碰
 *    own 层，故它们天然保留；写进名单反而会抛 unknown global tool、队员起不来。
 * 明细见常量 VIDEO_TEAMMATE_ALLOW，契约用例见 test/video-restrictions.test.mjs。
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

/** 视频队员名的形状：`video-` / `video_` 前缀（与 MEMBER_NAME 的连字符约定一致，大小写不敏感）。 */
const VIDEO_TEAMMATE_RE = /^video[-_]/i;

/**
 * 报错信息里给出的合法点名式队员名样例：**从规则表动态生成**。
 * 规则表是唯一事实源——写死清单会随 config.json 增删规则而脱节（曾导致「按报错引导命名必被闸门再拒」）。
 */
export function videoNameHint(config) {
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  const hints = rules
    .map((rule) => (typeof rule?.match === 'string' ? rule.match.trim() : ''))
    .filter((match) => VIDEO_TEAMMATE_RE.test(match))
    .map((match) => `${match.replace(/\*+$/, '')}-<序号>`);
  return hints.length > 0
    ? [...new Set(hints)].join(' / ')
    : '（当前规则表没有 video- 前缀规则——先补一条通配规则再派单）';
}

/** 拒绝启动的专用错误码，便于调用方与本插件自身的用例断言。 */
export const UNROUTED_VIDEO_CODE = 'DSH_SUBAGENT_MODEL_CONFIG_UNROUTED_VIDEO';

// ── 视频预设（preset id: video）下的队员侧限制 ──────────────────────────
// 用户 2026-10-07 口径：主窗不设限（工具/记忆/技能照给）；队员必须只带视频解析必需工具、
// 且被遮蔽主窗身份卡。预设本身做不到这件事（子代理继承父会话预设，预设无法区分主窗与队员），
// 故在本包装点按「父会话 preset」判定后注入：
//   request.persona    —— 逐子代理 persona，遮蔽部署 persona（主窗身份卡）
//   request.toolFilter —— { allow } 白名单，进程内后端执行 tools.restrict()：
//                         命名工具从子代理 prompt 消失且拒绝执行（fail-closed）
// 判定只看父会话 preset，因此只作用于 video 预设，其它模式的子代理完全不受影响。

/** 施加队员侧限制的预设标识。 */
export const VIDEO_PRESET_ID = 'video';

/** 队员角色卡：复用设计文档 §三 的 persona prefix（用户 2026-10-07 裁定，后续按测试调整）。 */
const VIDEO_TEAMMATE_PERSONA = [
  '你是视频事实提取员，只为这一件事工作：看片、听声、出事实。',
  '与本任务无关的一切探索都不是你的活——市场调研、题材分析、工程改造、文档清理、身份自述，一律不做。',
  '视频只认派单里给出的绝对路径，不得凭记忆、猜测或拼接路径。',
  '产物与留痕只写派单指定的唯一路径，不得自建目录。',
].join('\n');

/**
 * 队员工具白名单（allow 形态，fail-closed）。
 *
 * ⚠️ 只列子代理**继承层**的工具：tools.restrict() 只过滤继承层（global 层 + 祖先层），
 * 从不碰 agent 自己 scope 注册的工具。团队工具（send_message / team_task_* / list_agents /
 * wait_agent / interrupt_agent / spawn_teammate）由 agent-team 注册在成员自己的 scope 上 ——
 * 它们天然保留，**写进本名单反而会因 "unknown global tool" 报错**。
 * 这正是用户要求的「与主窗的通信收发必须保留」，无需为此列名。
 *
 * 名字必须与真实工具注册名逐字一致：restrict() 对未知名字抛错并列出全部合法名字
 * （dsh-tools/lib/index.js 的 tools.restrict()）。
 */
const VIDEO_TEAMMATE_ALLOW = [
  'watch_video',
  'read', 'write', 'edit', 'glob', 'grep',
  'pwsh',
  'job_list', 'job_output', 'job_kill',
  'skill',
  'todo_write',
];

/**
 * 读父会话当前生效的 preset id。与 dsh-subagent 的 childSessionMeta 同款读法：
 * 从父的活 scope 链取（header 可能记着切换前的旧值）。
 * @param parent - 派单的父 Agent。
 * @returns preset id；读不到时 null。
 */
function composedPresetOf(parent) {
  try {
    const presets = parent?.ctx?.get?.('agentPresets');
    return presets?.composedPreset?.(parent.ctx) ?? null;
  } catch {
    return null;
  }
}

/**
 * 视频预设下的队员限制；其它预设返回 null（不注入任何东西）。
 * @param parent - 派单的父 Agent。
 * @returns {{persona: string, toolFilter: {allow: string[]}} | null}
 */
export function videoTeammateRestrictions(parent) {
  if (composedPresetOf(parent) !== VIDEO_PRESET_ID) return null;
  return { persona: VIDEO_TEAMMATE_PERSONA, toolFilter: { allow: [...VIDEO_TEAMMATE_ALLOW] } };
}

/**
 * 视频队员名闸门：视频前缀的队员名必须命中一条规则，否则抛错拒绝启动。
 *
 * 为什么必须抛：未命中规则时 ruleToAgentOptions 返回 null，插件不注入任何
 * agentOptions，子代理就会静默继承默认模型 —— 那正是「执行模型不可控」。
 * 宁可炸掉一次派单，也不让视频任务跑在一个没人点名的模型上。
 *
 * @param name - 队员名（非编队路径传 undefined，直接放行）。
 * @param config - 规范化配置；enabled:false 时闸门整体关闭。
 * @throws {Error} code = UNROUTED_VIDEO_CODE，message 含队员名与合法名字清单。
 */
export function assertVideoNamed(name, config) {
  if (typeof name !== 'string' || !VIDEO_TEAMMATE_RE.test(name)) return;
  if (config?.enabled === false) return;
  if (resolveRule(config, name) !== null) return;
  writeProbe({ phase: 'spawn-rejected-unrouted-video', name });
  const error = new Error(
    `[dsh-subagent-model-config] 拒绝启动视频队员「${name}」：名字未命中任何规则，`
    + '执行模型与思考开关无法确定。视频任务必须点名式命名（video-前缀 + 模型名 + 思考开关 + 序号），'
    + `可选：${videoNameHint(config)}。规则表：${CONFIG_FILE}`,
  );
  error.code = UNROUTED_VIDEO_CODE;
  throw error;
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
    // 0.2.1 起的注入点名（null = 该构型不存在这个方法）
    startActivationWritable: subProto === null ? null : Object.getOwnPropertyDescriptor(subProto, 'startActivation')?.writable ?? null,
    teamSpawnWritable: teamProto === null ? null : Object.getOwnPropertyDescriptor(teamProto, 'spawnTeammate')?.writable ?? null,
    configFile: CONFIG_FILE,
  });

  // ── ① 队员名采集点（纯 ALS，无任何 I/O）──────────────────────────
  let spawnWrapper = null;
  if (agentTeams !== undefined && teamProto !== null) {
    const original = teamProto.spawnTeammate;
    spawnWrapper = function spawnTeammateWithScope(...args) {
      const request = args[1];
      // 闸门（创建队员之前判定）：未命中规则的视频名字直接拒绝，不留半成品队员。
      assertVideoNamed(request?.name, currentConfig());
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
  // 方法名随 DSH 版本变过：≤0.2.0 = startContinuable，0.2.1 起 = startActivation。
  // 只认老名字会在 0.2.1 上静默挂空（method not found）⇒ 这里按存在性自适应。
  const START_METHODS = ['startActivation', 'startContinuable'];
  let startMethod = null;
  for (const candidate of START_METHODS) {
    const onInstance = subagents !== undefined && Object.getOwnPropertyDescriptor(subagents, candidate) !== undefined;
    const onProto = subProto !== null && Object.getOwnPropertyDescriptor(subProto, candidate) !== undefined;
    if (onInstance || onProto) { startMethod = candidate; break; }
  }
  let startWrapper = null;
  if (subagents !== undefined && subProto !== null && startMethod !== null) {
    const original = subProto[startMethod] ?? subagents[startMethod];
    startWrapper = function startWithModel(spec) {
      if (spec?.[APPLIED] === true) return original.call(this ?? subagents, spec);
      // 闸门（兜底：spawnTeammate 包装万一未装上时仍拦住）。取不到队员名则放行 ——
      // 非编队路径（官方 subagent 工具）本来就不带名字，也与本闸门无关。
      assertVideoNamed(teammateScope.getStore()?.name, currentConfig());
      let nextSpec = spec;
      try {
        const store = teammateScope.getStore();
        const config = currentConfig();
        const rule = resolveRule(config, store?.name);
        const injected = ruleToAgentOptions(rule);
        // 视频预设下的队员侧限制（persona 遮蔽 + 工具白名单）；其它预设为 null。
        const restrictions = videoTeammateRestrictions(spec?.request?.parent);
        if (config.debug === true) {
          writeProbe({
            phase: 'startContinuable-called',
            method: startMethod,
            hasStore: store !== undefined,
            resolvedName: store?.name ?? null,
            enabled: config.enabled,
            matched: rule?.match ?? null,
            injected,
            restrictions: restrictions === null
              ? null
              : { persona: true, allow: restrictions.toolFilter.allow },
            specProvider: spec?.provider ?? null,
          });
        }
        if ((injected !== null || restrictions !== null) && spec?.request !== undefined) {
          // 不改原对象：另起一份 spec/request，其余引用原样带过。
          nextSpec = {
            ...spec,
            [APPLIED]: true,
            request: {
              ...spec.request,
              ...(injected === null
                ? {}
                : { agentOptions: { ...(spec.request.agentOptions ?? {}), ...injected } }),
              ...(restrictions ?? {}),
            },
          };
        }
      } catch (error) {
        // 异常低频且值得留痕，不受 debug 开关约束。
        writeProbe({ phase: 'startContinuable-error', error: String(error?.message ?? error) });
      }
      return original.call(this ?? subagents, nextSpec);
    };
    const result = patchBoth(subagents, subProto, startMethod, startWrapper);
    writeProbe({ phase: `patch-${startMethod}`, method: startMethod, ...result });
    if (result.anyInstalled) restores.push(result.restore);
    else startWrapper = null;
  } else if (subagents !== undefined && subProto !== null) {
    // 两个候选名都不在 ⇒ 该 DSH 版本换了第三个名字，必须显式留痕而不是静默不生效。
    writeProbe({ phase: 'patch-injection-point', method: null, tried: START_METHODS, error: 'no known start method on subagents' });
  }

  // ── ③ 决定性自检：重新 get 后，描述符里读到的确为我们的 wrapper ──
  const freshSub = scoped.get('subagents');
  const freshTeam = scoped.get('agentTeams');
  writeProbe({
    phase: 'post-patch-identity',
    freshIsNewProxy: freshSub !== subagents,
    // 描述符判定（可靠）：绕过 get trap 直接读 defineProperty 后的真实值。
    startMethod,
    instanceCarriesStart: Object.getOwnPropertyDescriptor(freshSub, startMethod ?? 'startContinuable')?.value === startWrapper,
    protoCarriesStart: subProto !== null && Object.getOwnPropertyDescriptor(subProto, startMethod ?? 'startContinuable')?.value === startWrapper,
    instanceCarriesSpawn: Object.getOwnPropertyDescriptor(freshTeam, 'spawnTeammate')?.value === spawnWrapper,
    protoCarriesSpawn: teamProto !== null && Object.getOwnPropertyDescriptor(teamProto, 'spawnTeammate')?.value === spawnWrapper,
  });

  return () => {
    for (const restore of restores) restore();
    writeProbe({ phase: 'disposed' });
  };
}

export function apply(ctx) {
  writeProbe({ phase: 'apply-enter', version: '0.3.0' });

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
