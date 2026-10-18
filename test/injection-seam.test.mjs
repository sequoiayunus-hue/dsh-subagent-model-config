/**
 * dsh-subagent-model-config — 注入点（seam）版本自适应回归测试
 *
 * 背景：插件包装的 `subagents.<seam>` 在 DSH 里改过名 —— ≤0.2.0 是
 * `startContinuable`，0.2.1 起是 `startActivation`。只认老名字时，包装在
 * `patchMethod` 里拿到 `{error:'method not found'}` 后**静默**放弃，规则表
 * 全部不生效（实测：spawn 出的队员仍是默认模型，probe 只留一行 method not found）。
 * 本套件锁死「按存在性自适应挑选方法名」这条行为，两个版本都必须能注入。
 *
 * 说明：与 gate.test.mjs 同款取舍 —— 直接构造最小 cordis 形状的假 ctx，
 * 不依赖 cordis 运行时；断言用的是「队员名 → agentOptions 真的进到 spec.request」
 * 这一端到端结果，而不是「wrapper 被装上」这种中间态。
 *
 * ⚠️ 插件把配置读作 <包根>/config.json（ROOT/config.json），本套件会临时写入
 * 一份 fixture 并在结束后还原 —— 因此也能在「干净克隆（没有 config.json）」里跑通。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONFIG_FILE = join(ROOT, 'config.json');
const PROBE_FILE = join(ROOT, '.probe.jsonl');

/** 命中 `seam-probe*` 的规则；provider/model/reasoningEffort 三项都要断言。 */
const FIXTURE = Object.freeze({
  enabled: true,
  debug: false,
  rules: [{ match: 'seam-probe*', provider: 'llmio', model: 'free', reasoningEffort: 'high', note: '回归测试 fixture' }],
});
const EXPECTED = Object.freeze({ provider: 'llmio', model: 'free', reasoningEffort: 'high' });

let savedConfig = null;
let savedProbe = null;

before(() => {
  savedConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
  savedProbe = existsSync(PROBE_FILE) ? readFileSync(PROBE_FILE, 'utf8') : null;
  writeFileSync(CONFIG_FILE, JSON.stringify(FIXTURE, null, 2), 'utf8');
});

after(() => {
  if (savedConfig === null) rmSync(CONFIG_FILE, { force: true });
  else writeFileSync(CONFIG_FILE, savedConfig, 'utf8');
  if (savedProbe === null) rmSync(PROBE_FILE, { force: true });
  else writeFileSync(PROBE_FILE, savedProbe, 'utf8');
});

/** 只声明 `method` 一个方法的假 SubagentRuntime（其余名字一律不存在，模拟真实版本漂移）。 */
function makeRuntime(method) {
  class FakeSubagentRuntime {}
  if (method !== null) {
    FakeSubagentRuntime.prototype[method] = function start(spec) {
      (this.seen ??= []).push(spec);
      return Promise.resolve({ ok: true });
    };
  }
  const runtime = new FakeSubagentRuntime();
  runtime.seen = [];
  return runtime;
}

/** 调用方桩：真实签名是 spawnTeammate(caller, request)，队员名在第二个参数里（agent-team:573）。 */
const CALLER = Object.freeze({ ctx: null });

/** 假 TeamService：spawn 时紧接着调用运行时（同步前缀链，ALS 上下文可见）。 */
function makeTeam(runtime, method) {
  class FakeTeamService {}
  FakeTeamService.prototype.spawnTeammate = function spawnTeammate(caller, request) {
    this.calls.push(request);
    return this.runtime[method]({
      delivery: 'team',
      childId: 'child-1',
      provider: request?.provider ?? 'spawn',
      label: request?.name,
      request: { prompt: 'probe', parent: null },
      signal: undefined,
    });
  };
  const team = new FakeTeamService();
  team.calls = [];
  team.runtime = runtime;
  return team;
}

/** 最小 cordis ctx：只放行 ['subagents','agentTeams'] 那一次 inject（web/RPC 分支跳过）。 */
function install(runtime, team) {
  const captured = [];
  const scope = { get: (key) => (key === 'subagents' ? runtime : key === 'agentTeams' ? team : undefined) };
  apply({
    logger: { info() {}, warn() {}, error() {} },
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('subagents')) captured.push(callback(scope));
      return undefined;
    },
  });
  assert.equal(captured.length, 1, 'apply 必须通过 inject 回调完成子代理包装');
  assert.equal(typeof captured[0], 'function', 'apply 必须交回 dispose，否则用例无法回收包装');
  return captured[0];
}

/** 跑一轮「装 → spawn → 卸」，返回该轮运行时收到的 spec 列表。 */
async function probeOnce({ runtimeMethod, name = 'seam-probe-1' }) {
  const runtime = makeRuntime(runtimeMethod);
  const team = makeTeam(runtime, runtimeMethod ?? 'startActivation');
  const dispose = install(runtime, team);
  try {
    await team.spawnTeammate(CALLER, { name, provider: 'spawn' });
  } finally {
    dispose();
  }
  return { runtime, team };
}

describe('注入点自适应 — 0.2.1 起改名为 startActivation', () => {
  it('运行时只有 startActivation ⇒ 规则照常注入（这是本补丁修的回归）', async () => {
    const { runtime, team } = await probeOnce({ runtimeMethod: 'startActivation' });
    assert.equal(runtime.seen.length, 1, 'startActivation 必须被调用一次');
    assert.deepEqual(
      runtime.seen[0]?.request?.agentOptions,
      EXPECTED,
      'agentOptions 必须带着命中规则的三项进入 spec.request',
    );
    assert.equal(team.calls[0]?.name, 'seam-probe-1');
  });

  it('未命中规则的队员名不注入（名字采集链路同轮验证）', async () => {
    const { runtime } = await probeOnce({ runtimeMethod: 'startActivation', name: 'other-1' });
    assert.equal(runtime.seen.length, 1);
    assert.equal(runtime.seen[0]?.request?.agentOptions, undefined);
  });
});

describe('注入点自适应 — ≤0.2.0 的 startContinuable 不回归', () => {
  it('运行时只有 startContinuable ⇒ 老版本上行为不变', async () => {
    const { runtime } = await probeOnce({ runtimeMethod: 'startContinuable' });
    assert.equal(runtime.seen.length, 1);
    assert.deepEqual(runtime.seen[0]?.request?.agentOptions, EXPECTED);
  });
});

describe('注入点自适应 — 两个候选名都不在时必须留痕', () => {
  it('既不 startActivation 也不 startContinuable ⇒ 不静默：写 patch-injection-point', () => {
    const before = existsSync(PROBE_FILE) ? readFileSync(PROBE_FILE, 'utf8') : '';
    const runtime = makeRuntime(null);
    const team = makeTeam(runtime, 'startContinuable');
    const dispose = install(runtime, team);
    try {
      const appended = readFileSync(PROBE_FILE, 'utf8').slice(before.length);
      assert.match(appended, /"phase":"patch-injection-point"/);
      assert.match(appended, /"startActivation"/);
      assert.equal(runtime.seen.length, 0);
    } finally {
      dispose();
    }
  });
});
