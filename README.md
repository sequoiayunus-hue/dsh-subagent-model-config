# dsh-subagent-model-config

为 DeepSeek Harness（DSH）**原生 Team 编队**的队员（teammate）配置**专属模型与推理档位**——全部在设置页点选完成，不改官方任何文件。

配置 **per-teammate models & reasoning efforts** for DSH native agent teams, editable in the settings UI. Zero official files are modified.

[中文](#中文) | [English](#english)

---

## 中文

### 这是什么

DSH 0.1.7 的原生 Team 编队里，`spawn_teammate` 不支持给队员指定模型（社区讨论 [#6985](https://github.com/deepseek-ai/dsh/discussions/6985)），所有队员只能继承主会话的默认模型。本插件在**运行时**包装 `SubagentRuntime.startContinuable`，按「队员名匹配规则」注入 `agentOptions`（model / reasoningEffort），并在设置页提供可视化编辑。

- **零官方改动**：不改官方文件、不打补丁；包装可逆，取消勾选「启用」即回到原生行为
- **热生效**：保存规则后，下一次 `spawn_teammate` 即生效，无需重启
- **规则匹配**：队员名支持 `*` / `?` 通配、大小写不敏感；规则按顺序求值，第一条命中即生效
- **中文备注**：每条规则可加备注（纯显示，不参与匹配、不注入请求）
- **待指定安全**：只写队员名、模型留空的规则不会注入任何东西（队员继承默认模型），UI 会黄条提醒
- **取证开关**：`debug` 开启后每次 spawn 追加一行到 `.probe.jsonl` 供排查，默认关闭

### 安装

**方式一（推荐）**：DSH 设置 → 插件市场 搜索 `dsh-subagent-model-config`（收录审核中；收录后可直接安装）。

**方式二（手动）**：把本仓库克隆到本地，在 profile 的 `package.json` 里加：

```json
{ "dsh-subagent-model-config": "link:/path/to/dsh-subagent-model-config" }
```

然后把它加入 profile 的 `dsh.bundles`，重启 DSH。

### 使用

设置 → **Subagent Models**：

| 字段 | 说明 |
|---|---|
| 队员名匹配 | glob 模式，如 `verifier*`；`*` 任意串、`?` 单字符 |
| 备注 | 中文名，只用于显示 |
| provider | 留空 = 继承主会话的供应商 |
| model | 留空 = 该 provider 的默认模型；**整条规则 provider/model 全空 = 不注入** |
| 推理档位 | 留空 = 目标模型默认档 |

配置存于插件目录的 `config.json`（`enabled` / `debug` / `rules[]`）。

### 兼容性

- **实测于 DSH 0.1.7-alpha.2**（声明范围 `engines.dsh >=0.1.7-alpha.1 <0.2.0-0`）
- 本插件钩在 DSH 内部运行时接口上，官方未来版本可能改变这些接口导致失效；遇到问题欢迎提 issue
- 节点要求 Node >= 22

### 测试

```bash
npm test    # node --test，110 用例
```

## English

Per-teammate model & reasoning-effort configuration for **DeepSeek Harness 0.1.7 native agent teams**. Wraps `SubagentRuntime.startContinuable` at runtime and injects `agentOptions` resolved from name-matching rules — with a full settings-UI editor. No official files are modified; the wrap is reversible and can be disabled with one checkbox.

Highlights: hot reload (next `spawn_teammate` picks up saved rules), glob name matching (first-match-wins), display-only notes per rule, safe "model pending" rules that inject nothing, optional debug evidence (`.probe.jsonl`).

**Compatibility:** tested on DSH 0.1.7-alpha.2 (`engines.dsh: >=0.1.7-alpha.1 <0.2.0-0`). Hooks internal runtime APIs that may change in future DSH releases — please open an issue if it breaks.

Run `npm test` for the test suite (110 cases).

## License

[MIT](LICENSE)
