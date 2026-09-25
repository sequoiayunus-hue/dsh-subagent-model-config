/**
 * dsh-subagent-model-config — 配置读取与规则匹配
 *
 * 单独成文件是为了可被独立单测（不依赖 cordis、不依赖运行时）。
 *
 * 配置形态（config.json）：
 *   {
 *     "enabled": true,
 *     "debug": false,
 *     "rules": [
 *       { "match": "reviewer*", "provider": "arkcli-agent-plan",
 *         "model": "glm-5-3-flash", "reasoningEffort": "high" }
 *     ]
 *   }
 *
 * 语义：
 *   · enabled: false ⇒ 一键关闭（包装仍在位，但不注入任何 agentOptions）；
 *   · debug: true   ⇒ 每次 startContinuable 追加一行取证到 .probe.jsonl
 *                     （默认 false：取证不留在生产路径上）；
 *   · rules 按数组顺序求值，**第一条命中即生效**；
 *   · rule.note 是可选中文备注（给用户看，不参与匹配、不注入 agentOptions）；
 *   · match 支持 glob 风格通配：`*` 任意字符序列、`?` 单字符，大小写不敏感；
 *   · 全空 rules ⇒ 行为与未装本插件完全一致（零副作用）。
 */
import { readFileSync } from 'node:fs';

/** 缺配置时的形态：启用、无规则、不取证（= 零副作用）。 */
export const DEFAULT_CONFIG = Object.freeze({ enabled: true, debug: false, rules: [] });

const RULE_FIELDS = ['provider', 'model', 'reasoningEffort'];

/**
 * 只随规则持久化、**绝不注入 agentOptions** 的字段。
 * note 是给用户看的中文备注（如「独立验证员」），纯显示用途 ——
 * 一旦漏进 ruleToAgentOptions 就会被塞进 SubagentStartRequest.agentOptions，
 * 官方多半因 schema 未知字段拒收，spawn 直接挂。
 */
const PERSIST_ONLY_FIELDS = ['note'];

/**
 * 一条规则是否可保留：**只要求 match 合法**。
 *
 * 为什么不再要求「至少一个路由字段」：用户要能**先配好角色名、再逐个指定模型**
 * （「常用 AGENTS」的用法 —— 模型由用户自己填，不替他预设）。这类「待指定模型」
 * 的规则被 resolveRule 命中后，ruleToAgentOptions 返回 null ⇒ **不注入任何东西**，
 * 所以放宽是安全的。
 * 而旧口径会在 loadConfig 读盘时把它**静默过滤掉** —— 用户存了却在界面上消失，
 * 比「不生效」更难排查。
 */
function isUsableRule(rule) {
  if (rule === null || typeof rule !== 'object') return false;
  return typeof rule.match === 'string' && rule.match.length > 0;
}

/** 只保留认识的字段，避免把脏数据透进 agentOptions。 */
function cleanRule(rule) {
  const out = { match: rule.match };
  for (const field of [...RULE_FIELDS, ...PERSIST_ONLY_FIELDS]) {
    if (typeof rule[field] === 'string' && rule[field].length > 0) out[field] = rule[field];
  }
  return out;
}

/**
 * 把任意 JSON 值规范成配置。任何不合法输入都退回默认值，绝不抛错 ——
 * 本插件在子代理启动的关键路径上，读配置失败必须是「不干预」而不是「炸掉 spawn」。
 * @param parsed - JSON.parse 的结果，或任何值。
 * @returns 规范化配置。
 */
export function normalizeConfig(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { enabled: DEFAULT_CONFIG.enabled, debug: DEFAULT_CONFIG.debug, rules: [] };
  }
  return {
    enabled: parsed.enabled !== false,
    debug: parsed.debug === true,
    rules: Array.isArray(parsed.rules) ? parsed.rules.filter(isUsableRule).map(cleanRule) : [],
  };
}

/**
 * 从磁盘读取配置。文件不存在、JSON 损坏、权限失败一律退回默认配置。
 *
 * 剥 UTF-8 BOM 是必需的，不是洁癖：本机 shell 是 Windows PowerShell 5.1，
 * `Out-File` / `Set-Content -Encoding utf8` 默认产出**带 BOM** 的 UTF-8；
 * 而 `JSON.parse` 对 BOM 抛 SyntaxError，会被下面的 catch 吞成「默认配置」——
 * 表现为「用户明明写了规则，插件完全不生效，且没有任何报错」。
 * （AGENTS.md 记过同源坑：本目录 .ps1 掉 BOM 后中文全乱码。）
 * @param file - 配置文件绝对路径。
 * @returns 规范化配置。
 */
export function loadConfig(file) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return normalizeConfig(JSON.parse(text));
  } catch {
    return { enabled: DEFAULT_CONFIG.enabled, debug: DEFAULT_CONFIG.debug, rules: [] };
  }
}

/**
 * glob 风格匹配，大小写不敏感。
 *
 * ⚠️ 刻意**不用正则**：把 glob 编译成 `^…*…$` 形式会引入灾难性回溯 ——
 * 实测模式 `*a*a*a*a*a*a*a*a*a*a*b` 对 `'a'.repeat(40)` 单次调用约 8.8s，
 * 而官方队员名上限 64 字符 ⇒ 外推小时级。本函数在 startContinuable 里**同步**
 * 执行，卡住的是整个 Node 事件循环，所以必须用下面这个线性算法
 * （双指针 + 单星号回溯，最坏 O(n·m) 但无指数回溯）。
 * @param pattern - 含 `*` / `?` 的模式；不含通配符时即精确匹配。
 * @param name - 候选队员名。
 * @returns 是否命中。
 */
export function matchPattern(pattern, name) {
  if (typeof pattern !== 'string' || typeof name !== 'string') return false;
  const p = pattern.toLowerCase();
  const s = name.toLowerCase();
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
      pi += 1;
      si += 1;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi;
      mark = si;
      pi += 1;
    } else if (star >= 0) {
      pi = star + 1;
      mark += 1;
      si = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi += 1;
  return pi === p.length;
}

/**
 * 为一名队员解析生效规则。
 *
 * 条目级也做防御：`rules:[null]` 这类脏数据不能让 spawn 关键路径抛 TypeError
 * （异常会被 index.js 的 catch 吞成一条取证，表现为「规则莫名不生效」，极难排查）。
 * @param config - 配置对象（不要求已规范化）。
 * @param name - 队员名；undefined（非编队路径的 startContinuable）永不命中。
 * @returns 命中的规则对象，或 null。
 */
export function resolveRule(config, name) {
  if (config === null || typeof config !== 'object' || config.enabled === false) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (!Array.isArray(config.rules)) return null;
  for (const rule of config.rules) {
    if (rule === null || typeof rule !== 'object') continue;
    if (typeof rule.match !== 'string') continue;
    if (matchPattern(rule.match, name)) return rule;
  }
  return null;
}

/**
 * 把命中的规则转成 SubagentStartRequest.agentOptions 片段。
 *
 * 为什么原样给 reasoningEffort：dsh-subagent 的 resolveChildAgentOptions 有一条
 * 「换路由但没点档位 ⇒ 清掉继承档位」的规则（见 dsh-subagent/lib/index.js:450）。
 * 用户显式配了档位就照给，没配就让目标模型走它自己的默认档 —— 这正是想要的行为。
 * @param rule - resolveRule 的返回值。
 * @returns agentOptions 片段，或 null（无规则）。
 */
export function ruleToAgentOptions(rule) {
  if (rule === null || rule === undefined) return null;
  const options = {};
  for (const field of RULE_FIELDS) {
    if (typeof rule[field] === 'string' && rule[field].length > 0) options[field] = rule[field];
  }
  return Object.keys(options).length > 0 ? options : null;
}