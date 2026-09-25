/**
 * dsh-subagent-model-config — Client 半边：设置页卡片
 *
 * 挂在 `settings.section`（顶层设置入口，owner props = SettingsSectionOwnerProps { close }）。
 * 通过 `ctx.connection.rpc.call` 与 Host 侧 lib/rpc.js 通信；通道名与端点在此**重复定义**
 * —— 浏览器半边是 `__ModuleLoader__` 工厂，无法 import Host 模块（dsh-pocket 同款做法）。
 *
 * 输入控件统一走 `Choice`：**有候选就渲染 `<select>`，没有候选才退回自由输入 `<input>`**。
 * 为什么不用 `<datalist>`：它原生做**前缀过滤** —— 字段里有旧值时，下拉只显示与当前值
 * 前缀匹配的选项。实测踩过：provider 改成 zai-coding-cn 后，model 字段还是旧值
 * deepseek-v4-1-flash，与 zai 的模型无前缀匹配 ⇒ 下拉看似空、无法切换。
 * 而模型目录本身是 **advisory**（官方原话：catalog membership is advisory and never
 * changes routing），所以查不到候选时必须允许自由输入，不该被下拉锁死。
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-model-config',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CHANNEL = '/subagent-model-config';
    const EP = Object.freeze({
      get: 'config.get',
      set: 'config.set',
      catalog: 'config.catalog',
      efforts: 'config.efforts',
    });

    /** 档位中文名（只影响显示，提交的仍是 id）。 */
    const EFFORT_LABEL = {
      off: '关闭 (off)',
      minimal: '最低 (minimal)',
      low: '低 (low)',
      medium: '中 (medium)',
      high: '高 (high)',
      max: '最高 (max)',
    };

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13, lineHeight: 1.6, maxWidth: 760 },
      h1: { fontSize: 15, fontWeight: 600, margin: 0 },
      hint: { fontSize: 12, opacity: 0.6, margin: 0 },
      card: {
        border: '1px solid rgba(128,128,128,.28)', borderRadius: 8, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 10,
      },
      row: { display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' },
      grow: { flex: '1 1 160px', minWidth: 0 },
      field: {
        background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 6, padding: '5px 8px', fontSize: 13, minWidth: 0, width: '100%', boxSizing: 'border-box',
      },
      // 原生 <select> 的**展开弹层**由浏览器自己绘制，默认白底 —— 只给文字白色会变成
      // 「白底白字」全部不可读（深色主题实测缺陷）。两件事一起做：
      //   · colorScheme:'dark' —— 声明控件色彩方案，让浏览器以深色渲染原生部件
      //     （弹层、滚动条、焦点环）。这是标准做法，且不会污染卡片自身的配色。
      //   · option 显式背景/前景 —— Windows 上 Chromium 弹层真正吃的是这条，与
      //     color-scheme 互为双保险（缺任一条都可能在某些浏览器上失效）。
      // 取 #1f1f1f/#f5f5f5 与卡片深底一致；hover/选中仍由浏览器用系统高亮灰绘制。
      select: {
        background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 6, padding: '5px 8px', fontSize: 13, minWidth: 0, width: '100%', boxSizing: 'border-box',
        colorScheme: 'dark',
      },
      option: { backgroundColor: '#1f1f1f', color: '#f5f5f5' },
      label: { fontSize: 11, opacity: 0.55, display: 'block', marginBottom: 2 },
      btn: {
        background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.4)',
        borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer',
      },
      btnPrimary: { background: 'rgba(90,150,255,.16)', borderColor: 'rgba(90,150,255,.5)' },
      btnDanger: { borderColor: 'rgba(229,83,75,.5)', color: '#e5534b', padding: '5px 10px' },
      ok: { fontSize: 12, color: '#3fb950', margin: 0 },
      err: { fontSize: 12, color: '#e5534b', whiteSpace: 'pre-wrap', margin: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, opacity: 0.5, wordBreak: 'break-all', margin: 0 },
      checkboxRow: { display: 'flex', gap: 8, alignItems: 'center' },
      ruleHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
      ruleIndex: { fontSize: 11, opacity: 0.5 },
      chip: {
        background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.4)',
        borderRadius: 999, padding: '3px 10px', fontSize: 12, cursor: 'pointer', lineHeight: 1.5,
      },
      warn: { fontSize: 12, color: '#d29922', margin: 0 },
    };

    /**
     * 常用编队角色 —— **只给名字，模型留给用户指定**（不替用户预设模型，避免误用贵模型）。
     * 点一下即添加一条该 match 的规则；模型空着的规则不注入任何东西，卡片上会显式标注
     * 「未指定模型」，不会静默失效。
     */
    const COMMON_ROLES = [
      { name: 'verifier', hint: '独立验证者：拿独立证据核对，不采信文字自述' },
      { name: 'reviewer', hint: '审查者：代码 / 文档审查' },
      { name: 'researcher', hint: '调研者：取证、方案比较' },
      { name: 'implementer', hint: '实现者：改码、落地' },
      { name: 'tester', hint: '测试者：复现、回归' },
      { name: 'extract*', hint: '摘句提取员：摘句库管线 W1 提取' },
      { name: 'wiki*', hint: '词条撰写员：WIKI / repowiki 词条写作' },
      { name: 'plan*', hint: '规划员：任务拆解与排程' },
    ];

    function Field({ label, children }) {
      return h('label', { style: S.grow }, h('span', { style: S.label }, label), children);
    }

    /**
     * 候选选择控件：**有候选就渲染 `<select>`，没有候选才退回自由输入 `<input>`**。
     *
     * 为什么弃用 `<datalist>`：它是**原生前缀过滤**的 —— 字段里有旧值时，下拉只显示
     * 与当前值前缀匹配的选项。实测症状：provider 改成 zai-coding-cn 后，model 字段
     * 还是旧值 deepseek-v4-1-flash，与 zai 的模型无前缀匹配 ⇒ 下拉看似空、无法切换；
     * provider 下拉同理只显示当前供应商自己。`<select>` 没有这个行为。
     *
     * 当前值不在候选里时**必须补一个选项**：否则 `<select>` 会静默显示第一个候选，
     * 用户以为值变了、实际没变 —— 比下拉空更糟。
     */
    function Choice({ value, options, emptyLabel, placeholder, labelOf, onChange }) {
      const list = Array.isArray(options) ? options : [];
      if (list.length === 0) {
        return h('input', {
          style: S.field,
          value: value ?? '',
          placeholder: placeholder ?? '',
          onChange: (e) => onChange(e.target.value),
        });
      }
      const current = value ?? '';
      const orphan = current.length > 0 && !list.includes(current);
      return h('select', {
        style: S.select,
        value: current,
        onChange: (e) => onChange(e.target.value),
      },
        h('option', { value: '', style: S.option }, emptyLabel ?? '（留空）'),
        orphan ? h('option', { key: '__orphan', value: current, style: S.option }, `${current}（当前值，不在目录中）`) : null,
        ...list.map((id) => h('option', { key: id, value: id, style: S.option }, labelOf ? labelOf(id) : id)));
    }

    function makeSection(rpcCall) {
      return function SubagentModelConfigSection() {
        const [config, setConfig] = React.useState(null);
        const [catalog, setCatalog] = React.useState([]);
        const [effortsMap, setEffortsMap] = React.useState({});
        const [configFile, setConfigFile] = React.useState('');
        const [status, setStatus] = React.useState({ kind: 'info', text: '加载中…' });
        const [saving, setSaving] = React.useState(false);

        React.useEffect(() => {
          let alive = true;
          (async () => {
            try {
              const res = await rpcCall(EP.get, {});
              if (!alive) return;
              if (!res?.ok) throw new Error(res?.error?.message ?? '读取失败');
              setConfig(res.value.config);
              setConfigFile(res.value.configFile ?? '');
              setStatus({ kind: 'info', text: '' });
            } catch (error) {
              if (alive) setStatus({ kind: 'error', text: `读取配置失败：${error?.message ?? error}` });
            }
            try {
              const cat = await rpcCall(EP.catalog, {});
              if (alive && cat?.ok) setCatalog(cat.value.providers ?? []);
            } catch {
              /* 目录拉取失败不该阻塞编辑：输入框仍可自由填 */
            }
          })();
          return () => { alive = false; };
        }, []);

        const loadEfforts = React.useCallback(async (provider, model) => {
          if (!provider || !model) return;
          const key = `${provider}::${model}`;
          try {
            const res = await rpcCall(EP.efforts, { provider, model });
            if (res?.ok) setEffortsMap((prev) => ({ ...prev, [key]: res.value.efforts ?? [] }));
          } catch {
            /* 档位查不到时输入框仍可自由填 */
          }
        }, []);

        const patchRule = (index, patch) => {
          setConfig((prev) => {
            const rules = prev.rules.slice();
            rules[index] = { ...rules[index], ...patch };
            return { ...prev, rules };
          });
        };
        // match 可预置（常用角色一键添加，备注自动带上中文说明）；model 留空由用户自己在卡片里指定。
        const addRule = (match = '', note = '') =>
          setConfig((prev) => ({ ...prev, rules: [...prev.rules, note ? { match, note } : { match }] }));
        const removeRule = (index) => setConfig((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== index) }));

        const save = async () => {
          setSaving(true);
          setStatus({ kind: 'info', text: '保存中…' });
          try {
            const res = await rpcCall(EP.set, { config });
            if (!res?.ok) throw new Error(res?.error?.message ?? '保存失败');
            setConfig(res.value.config);
            setStatus({ kind: 'ok', text: `已保存（${new Date(res.value.savedAt).toLocaleTimeString()}）—— 下一次 spawn 队员即生效，无需重启。` });
          } catch (error) {
            setStatus({ kind: 'error', text: `保存失败：${error?.message ?? error}` });
          } finally {
            setSaving(false);
          }
        };

        if (config === null) {
          return h('div', { style: S.wrap },
            h('h2', { style: S.h1 }, 'Subagent Models'),
            h('p', { style: status.kind === 'error' ? S.err : S.hint }, status.text || '加载中…'));
        }

        const providerIds = catalog.map((p) => p.id);
        // 只按**当前 provider** 取模型；**不再跨 provider 兜底** —— 旧的
        // `byProvider.length ? byProvider : allModels` 会让未选 provider 的规则列出
        // 全量模型，用户极易选到不属于该 provider 的模型，是同一个 bug 的另一面。
        const modelsOf = (providerId) => (catalog.find((p) => p.id === providerId)?.models ?? []).map((m) => m.id);

        return h('div', { style: S.wrap },
          h('div', null,
            h('h2', { style: S.h1 }, 'Subagent Models'),
            h('p', { style: S.hint },
              '按队员名（支持 * 通配）为编队队员指定模型与推理档位。规则按顺序求值，第一条命中即生效。'),
            configFile ? h('p', { style: S.mono }, configFile) : null),

          h('div', { style: S.card },
            h('div', { style: S.checkboxRow },
              h('input', {
                id: 'smc-enabled', type: 'checkbox', checked: config.enabled,
                onChange: (e) => setConfig({ ...config, enabled: e.target.checked }),
              }),
              h('label', { htmlFor: 'smc-enabled' }, '启用（取消勾选 = 一键关闭：包装仍在位，但不注入）')),
            h('div', { style: S.checkboxRow },
              h('input', {
                id: 'smc-debug', type: 'checkbox', checked: config.debug,
                onChange: (e) => setConfig({ ...config, debug: e.target.checked }),
              }),
              h('label', { htmlFor: 'smc-debug' }, '取证（开启后每次 spawn 追加一行到 .probe.jsonl，排查用；平时关掉）'))),

          h('div', { style: S.card },
            h('span', { style: S.label }, '常用角色（点一下添加一条规则；模型留给你指定）'),
            h('div', { style: S.row },
              ...COMMON_ROLES.map((role) => h('button', {
                key: role.name, type: 'button', style: S.chip, title: role.hint,
                onClick: () => addRule(role.name, role.hint),
              }, role.name)))),

          config.rules.length === 0
            ? h('p', { style: S.hint }, '当前没有规则 —— 队员继承 Lead 的默认模型，与未装本插件时行为一致。')
            : null,

          ...config.rules.map((rule, index) => {
            const efforts = effortsMap[`${rule.provider ?? ''}::${rule.model ?? ''}`] ?? [];
            return h('div', { key: index, style: S.card },
              h('div', { style: S.ruleHead },
                h('span', { style: S.ruleIndex }, rule.note ? `规则 ${index + 1} · ${rule.note}` : `规则 ${index + 1}`),
                h('button', { type: 'button', style: { ...S.btn, ...S.btnDanger }, onClick: () => removeRule(index) }, '删除')),

              // 「待指定模型」必须**显式标注**：这类规则不注入任何东西（resolver 命中后
              // ruleToAgentOptions 返回 null，队员仍继承 Lead 的模型），不标注就成了
              // 「存了却不生效」的静默失效 —— 比报错更难排查。
              (rule.model ?? '').length === 0 && (rule.provider ?? '').length === 0
                ? h('p', { style: S.warn }, '未指定模型 —— 此规则不会生效，队员仍继承 Lead 的模型。请在下面选/填 model。')
                : null,

              h('div', { style: S.row },
                h(Field, { label: '队员名匹配（支持 * 通配）' },
                  h('input', {
                    style: S.field, value: rule.match ?? '', placeholder: '例如 reviewer* 或 crew-alpha',
                    onChange: (e) => patchRule(index, { match: e.target.value }),
                  }))),

              h('div', { style: S.row },
                h(Field, { label: '备注（中文名，只用于显示，不影响匹配）' },
                  h('input', {
                    style: S.field, value: rule.note ?? '', placeholder: '例如：独立验证员',
                    onChange: (e) => patchRule(index, { note: e.target.value }),
                  }))),

              h('div', { style: S.row },
                h(Field, { label: 'provider（留空 = 继承 Lead 的）' },
                  h(Choice, {
                    value: rule.provider,
                    options: providerIds,
                    emptyLabel: '（继承 Lead 的 provider）',
                    placeholder: 'arkcli-agent-plan',
                    // 换 provider 必须同时清掉 model 与档位：旧模型属于旧 provider，
                    // 留着既无意义又必然不匹配 —— 这正是那个「下拉看似空」bug 的现场。
                    onChange: (provider) => patchRule(index, { provider, model: '', reasoningEffort: '' }),
                  })),

                h(Field, { label: 'model' },
                  h(Choice, {
                    value: rule.model,
                    options: modelsOf(rule.provider),
                    emptyLabel: '（留空 = 该 provider 默认模型）',
                    placeholder: 'deepseek-v4-1-flash',
                    onChange: (model) => {
                      // 换模型同样清档位：旧档位未必被新模型支持，留着会让 spawn 被拒。
                      patchRule(index, { model, reasoningEffort: '' });
                      loadEfforts(rule.provider, model);
                    },
                  }))),

              h('div', { style: S.row },
                h(Field, { label: '推理档位 reasoningEffort（留空 = 目标模型默认档）' },
                  h(Choice, {
                    value: rule.reasoningEffort,
                    options: efforts.map((e) => e.id),
                    emptyLabel: '（留空 = 目标模型默认档）',
                    placeholder: 'high',
                    labelOf: (id) => EFFORT_LABEL[id] ?? id,
                    onChange: (reasoningEffort) => patchRule(index, { reasoningEffort }),
                  }))));
          }),

          h('div', { style: S.row },
            h('button', { type: 'button', style: S.btn, onClick: addRule }, '＋ 添加规则'),
            h('button', {
              type: 'button', style: { ...S.btn, ...S.btnPrimary }, disabled: saving, onClick: save,
            }, saving ? '保存中…' : '保存')),
          status.text
            ? h('p', { style: status.kind === 'error' ? S.err : status.kind === 'ok' ? S.ok : S.hint }, status.text)
            : null);
      };
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal);
        const Section = makeSection(rpcCall);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'subagent-model-config',
          order: 60,
          label: 'Subagent Models',
        }, Section));
      },
    };
  },
});
