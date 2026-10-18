![version](https://img.shields.io/badge/version-0.3-blue) ![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.7--alpha.1-4D6BFE) ![license](https://img.shields.io/badge/license-MIT-green)

# dsh-subagent-model-config

给 DeepSeek Harness（DSH）原生 Team 编队的队员**单独配模型和推理档位**——在设置页点两下就配好，不改官方任何文件。

Per-teammate model & reasoning-effort configuration for DSH native agent teams — two clicks in the settings UI, zero official files modified.

[中文](#中文) | [English](#english)

---

## 中文

### 这解决什么问题

DSH 原生 Team 编队的 `spawn_teammate` 只有 name / description / prompt / context 四个参数，**没有 model**（官方讨论 [#6985](https://github.com/deepseek-ai/dsh/discussions/6985)）——所有队员只能继承主会话的默认模型：想给审查队员配个便宜快的、给写手配个强模型的，做不到。

本插件把这个缺口补上：按**队员名**配规则，每个队员跑在你指定的 provider / model / 推理档位上，全部在设置页点选完成。

- **零官方改动**：不改官方文件、不打补丁；包装可逆，取消勾选「启用」即回到原生行为
- **热生效**：保存规则后，下一次 `spawn_teammate` 即生效，无需重启
- **一张规则表管全部**：队员名支持 `*` / `?` 通配、大小写不敏感，按顺序求值、第一条命中即生效；每条规则可加中文备注（纯显示，不注入）
- **待指定安全**：只写队员名、模型留空的规则不注入任何东西（队员继承默认模型），UI 黄条提醒——可以先建角色、后补模型
- **取证开关**：`debug` 开启后每次 spawn 追加一行到 `.probe.jsonl` 供排查，默认关闭

### 快速开始

**安装**

方式一（推荐）：DSH 设置 → 插件市场 → 搜索 `dsh-subagent-model-config` → 安装并启用。

方式二（手动）：克隆本仓库，在 profile 的 `package.json` 里加：

```json
{ "dsh-subagent-model-config": "link:/path/to/dsh-subagent-model-config" }
```

并把它加入 profile 的 `dsh.bundles`，重启 DSH。

**配置**

打开 设置 → **Subagent Models**，添加规则：

| 字段 | 说明 |
|---|---|
| 队员名匹配 | glob 模式，如 `verifier*`；`*` 任意串、`?` 单字符 |
| 备注 | 中文名，只用于显示 |
| provider | 留空 = 继承主会话的供应商 |
| model | 留空 = 该 provider 的默认模型；**整条规则 provider/model 全空 = 不注入** |
| 推理档位 | 下拉选择，候选 = 所选模型自己声明的档位；留空 = 目标模型默认档 |

设置页全貌——左侧入口、启用开关、常用角色一键条与规则卡：

![设置页：入口、开关、常用角色与规则卡](https://raw.githubusercontent.com/sequoiayunus-hue/dsh-subagent-model-config/main/docs/images/submc-settings-hero.png)

典型配置（节选）：

```json
{
  "enabled": true,
  "rules": [
    { "match": "verifier*",   "note": "独立验证员——便宜快的", "provider": "…", "model": "…", "reasoningEffort": "low" },
    { "match": "writer*",     "note": "写手——强模型高思考",   "provider": "…", "model": "…", "reasoningEffort": "high" },
    { "match": "researcher*", "note": "检索员——角色先建，模型后补" }
  ]
}
```

通用工程编队的实际用法——验证员用强模型高思考、测试编队用 flash 省额度，一张规则表各跑各的：

![通用工程编队规则示例](https://raw.githubusercontent.com/sequoiayunus-hue/dsh-subagent-model-config/main/docs/images/submc-crew-rules.png)

### 工作原理

插件在运行时包装两个 DSH 内部接口：`agentTeams.spawnTeammate`（采集队员名）与 `SubagentRuntime.<seam>`（注入点；`<seam>` 随 DSH 版本改名 —— ≤0.2.0 叫 `startContinuable`，0.2.1 起叫 `startActivation`，插件按存在性自适应挑选，两个版本都能挂上；只认老名字会在新版上静默失效）。派单发生时按队员名匹配规则表，把命中的 provider / model / reasoningEffort 写进官方原生支持的 `SubagentStartRequest.agentOptions`——只接上编队路径没接的线，不改任何官方行为。包装装在实例与原型两层（幂等防重入），内部异常一律只记录不抛出；配置为空或关闭时，行为与未装本插件完全一致。

### 兼容性与测试

- **声明范围**：`engines.dsh >= 0.1.7-alpha.1`，Node >= 22
- **实测**：DSH 0.1.7-alpha.2（首发实测）；DSH 0.2.0 桌面端（日常在用）；DSH 0.2.1-rc.2（nightly，注入点已改名 `startActivation`）
- `npm test`：143 用例（17 套件）全过
- 本插件钩在 DSH 内部运行时接口上，官方未来版本可能改变这些接口导致失效；遇到问题欢迎提 issue

### 视频预设配套：队员闸门与能力限制

这是 `video` 解析预设的配套约束。判定只看父会话 preset——不用视频预设的用户完全无感。

**① 视频队员名硬闸门**

视频解析任务用哪个模型、开不开思考，必须人工点名。名字以 `video-` / `video_` 开头却未命中任何规则 ⇒ **抛错拒绝启动**（错误码 `DSH_SUBAGENT_MODEL_CONFIG_UNROUTED_VIDEO`），报错实时列出当前规则表允许的命名清单。fail-closed：配置缺失、损坏或规则为空时，视频名一律拒绝。非视频名字与 `enabled: false` 完全不受影响。

**② 队员侧能力限制**（父会话 preset 为 `video` 时注入）

| 注入项 | 作用 |
|---|---|
| `request.persona` | 队员角色卡，遮蔽部署 persona（主窗身份卡对队员不再生效） |
| `request.toolFilter.allow` | 工具白名单（fail-closed）：`watch_video` / `read` `write` `edit` `glob` `grep` / `pwsh` / `job_list` `job_output` `job_kill` / `skill` / `todo_write` |

白名单只列「继承层」工具；团队通信工具（`send_message` / `team_task_*` 等）注册在成员自己的 scope，天然保留。standard / cordis / minimal 模式的子代理完全不受影响。

## English

### The problem it solves

In DSH's native agent teams, `spawn_teammate` takes only name / description / prompt / context — **no model parameter** (upstream discussion [#6985](https://github.com/deepseek-ai/dsh/discussions/6985)). Every teammate inherits the main session's default model: you cannot give the reviewer a cheap fast model or the writer a strong one.

This plugin fills that gap: name-based rules, each teammate runs on the provider / model / reasoning effort you pick — all editable in the settings UI, effective on the next spawn.

- **Zero official changes**: no official files modified; the wrap is reversible — untick "enabled" and you are back to stock behavior
- **Hot reload**: saved rules apply to the next `spawn_teammate`, no restart needed
- **One rule table decides who runs on what**: glob matching (`*` / `?`, case-insensitive), first match wins; per-rule display notes
- **Safe "model pending" rules**: a rule with an empty model injects nothing (teammate inherits the default); the UI flags it in amber — create roles first, fill models later
- **Evidence switch**: with `debug: true` each spawn appends a line to `.probe.jsonl`; off by default

### Quick start

Install: DSH Settings → Plugins → search `dsh-subagent-model-config`. Manual: clone this repo, link it in your profile's `package.json`, add it to `dsh.bundles`, restart DSH.

Configure: Settings → **Subagent Models** — add rules with a name pattern, optional provider / model / reasoning effort (dropdown candidates come from the selected model itself).

### How it works

The plugin wraps two DSH internals at runtime: `agentTeams.spawnTeammate` (captures the teammate name) and `SubagentRuntime.<seam>` (injection point; `<seam>` was renamed across DSH releases — `startContinuable` up to 0.2.0, `startActivation` from 0.2.1 — and the plugin picks whichever exists, so a hardcoded old name no longer silently disables every rule). On spawn it matches the name against the rule table and writes the resolved fields into `SubagentStartRequest.agentOptions` — a field DSH natively supports but the team path never wired up. Wraps are installed on both instance and prototype (idempotent); internal errors are logged, never thrown; with an empty or disabled config the behavior is identical to not having the plugin.

### Compatibility & tests

- `engines.dsh >= 0.1.7-alpha.1`, Node >= 22
- Tested on DSH 0.1.7-alpha.2, the 0.2.0 desktop app (daily driver), and the 0.2.1-rc.2 nightly (injection point = `startActivation`)
- `npm test`: 143 cases, 17 suites, all passing
- The plugin hooks DSH internal runtime APIs that may change in future releases — please open an issue if it breaks

### Video-preset companion: gate & teammate restrictions

For the `video` analysis preset only — detection reads the parent session's preset, so other modes are untouched:

1. **Hard gate on video teammate names**: a name starting with `video-`/`video_` that matches no rule is rejected outright (error code `DSH_SUBAGENT_MODEL_CONFIG_UNROUTED_VIDEO`) with a live list of allowed names. Fail-closed: missing, corrupt, or empty config rejects every video name.
2. **Teammate-side restrictions** (injected when the parent preset is `video`): `request.persona` (masks the deployment persona) and `request.toolFilter.allow` (fail-closed whitelist: `watch_video`, `read`/`write`/`edit`/`glob`/`grep`, `pwsh`, `job_list`/`job_output`/`job_kill`, `skill`, `todo_write`). Team-communication tools live on the member's own scope and are naturally preserved. Standard / cordis / minimal subagents are unaffected.

## License

[MIT](LICENSE)
