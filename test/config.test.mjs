/**
 * dsh-subagent-model-config — lib/config.js 独立单测（对抗性视角）
 *
 * 期望值全部由 `lib/config.js` 源码推导，并已在写断言前用探针实测确认
 * （审计脚本见 .verify/glob-equivalence.mjs 与 .verify/check-linerefs.mjs）。
 * 本文件不依赖 cordis、不依赖运行时，可直接 `node --test` 复现。
 *
 * 本文件覆盖 F1–F5 修复后的当前语义，以及配套的回归防线
 * （BOM 全链、debug 严格 true、条目级防御、glob 穷举等价性、F4 性能上限）。
 *
 * 所有临时夹具写在 test/.tmp-fixtures 下，after() 负责清理 —— 不碰仓库其他目录。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG,
  loadConfig,
  matchPattern,
  normalizeConfig,
  resolveRule,
  ruleToAgentOptions,
} from '../lib/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = join(HERE, '.tmp-fixtures');

/** 规范化后的默认形态（F3 起恒含 debug 字段）。 */
const DEFAULT_SHAPE = { enabled: true, debug: false, rules: [] };

/** 建一个全新的临时夹具目录，返回目录路径。 */
function freshDir(tag) {
  const dir = join(TMP_ROOT, `${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 写一个夹具文件并返回路径。 */
function fixtureFile(tag, name, content) {
  const dir = freshDir(tag);
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// normalizeConfig
// ────────────────────────────────────────────────────────────────────────────
describe('normalizeConfig — 非法输入一律退回默认值', () => {
  for (const [label, input] of [
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['非空数组', [{ match: '*' }]],
    ['字符串', 'nope'],
    ['数字', 42],
    ['布尔', true],
  ]) {
    it(`${label} ⇒ 默认值`, () => {
      assert.deepEqual(normalizeConfig(input), DEFAULT_SHAPE);
    });
  }

  it('默认值与 DEFAULT_CONFIG 一致，且 DEFAULT_CONFIG 未被冻结失败/污染', () => {
    assert.deepEqual(DEFAULT_SHAPE, {
      enabled: DEFAULT_CONFIG.enabled,
      debug: DEFAULT_CONFIG.debug,
      rules: [],
    });
    assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(), ['debug', 'enabled', 'rules']);
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  });

  it('每次返回全新对象，调用方改它不影响下一次', () => {
    const first = normalizeConfig(null);
    first.rules.push({ match: '*' });
    first.enabled = false;
    assert.deepEqual(normalizeConfig(null), DEFAULT_SHAPE);
  });
});

describe('normalizeConfig — enabled 的取值语义', () => {
  it('{} ⇒ enabled 为 true（缺字段不关闭）', () => {
    assert.deepEqual(normalizeConfig({}), DEFAULT_SHAPE);
  });

  it('enabled:false ⇒ 保持 false', () => {
    assert.equal(normalizeConfig({ enabled: false }).enabled, false);
  });

  it('判定是严格 !== false：0 / null / "" / "false" 都被当成启用', () => {
    // 源码 `parsed.enabled !== false` —— 只有布尔 false 才关闭。
    for (const value of [0, null, '', 'false', 'no', undefined]) {
      assert.equal(
        normalizeConfig({ enabled: value }).enabled,
        true,
        `enabled=${JSON.stringify(value)} 应当被当作启用`,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// debug 语义（F3 新增字段）
// ────────────────────────────────────────────────────────────────────────────
describe('normalizeConfig — debug 只认严格 true', () => {
  it('缺字段 / undefined / null ⇒ false', () => {
    assert.equal(normalizeConfig({}).debug, false);
    assert.equal(normalizeConfig({ debug: undefined }).debug, false);
    assert.equal(normalizeConfig({ debug: null }).debug, false);
  });

  it('debug:true ⇒ true；debug:false ⇒ false', () => {
    assert.equal(normalizeConfig({ debug: true }).debug, true);
    assert.equal(normalizeConfig({ debug: false }).debug, false);
  });

  it('真值但非布尔 true 一律 ⇒ false（1 / "true" / [] / {} 都不算）', () => {
    // 有意严格：debug 会打开生产热路径上的写盘，误开代价比误关大。
    for (const value of [1, 0, 'true', 'false', '', [], {}, 'yes']) {
      assert.equal(
        normalizeConfig({ debug: value }).debug,
        false,
        `debug=${JSON.stringify(value)} 必须被当作关闭`,
      );
    }
  });

  it('debug 字段恒存在且恒为布尔（下游 `config.debug === true` 判定依赖它）', () => {
    for (const input of [null, [], 'x', {}, { debug: 1 }, { debug: true }]) {
      assert.equal(typeof normalizeConfig(input).debug, 'boolean', JSON.stringify(input));
    }
  });

  it('debug 与 enabled 互不影响', () => {
    assert.deepEqual(normalizeConfig({ enabled: false, debug: true }), { enabled: false, debug: true, rules: [] });
    assert.deepEqual(normalizeConfig({ enabled: true, debug: false }), DEFAULT_SHAPE);
  });
});

describe('normalizeConfig — rules 的形状与逐条过滤', () => {
  it('缺 rules / rules 非数组 ⇒ 空数组', () => {
    for (const rules of [undefined, 'x', 42, {}, null, true]) {
      assert.deepEqual(normalizeConfig({ rules }).rules, [], `rules=${JSON.stringify(rules)}`);
    }
  });

  it('rules 里的非对象垃圾条目被整体丢弃', () => {
    assert.deepEqual(normalizeConfig({ rules: [null, 1, 'x', true, []] }).rules, []);
  });

  it('缺 match / match 非字符串 / match 为空串 ⇒ 丢弃', () => {
    for (const match of [undefined, null, 42, '', ['*'], {}]) {
      assert.deepEqual(
        normalizeConfig({ rules: [{ match, provider: 'p' }] }).rules,
        [],
        `match=${JSON.stringify(match)}`,
      );
    }
  });

  it('只填 match 的规则**保留**（「待指定模型」用法）', () => {
    // 2026-09-23 有意变更：用户要能先配角色名、再逐个指定模型（「常用 AGENTS」），
    // 故不再要求「至少一个路由字段」。这类规则被 resolveRule 命中后
    // ruleToAgentOptions 返回 null ⇒ 不注入任何东西，放宽是安全的；
    // 而旧口径会在 loadConfig 读盘时把它**静默过滤掉**（存了却消失，更难排查）。
    assert.deepEqual(normalizeConfig({ rules: [{ match: 'a' }] }).rules, [{ match: 'a' }]);
    assert.deepEqual(normalizeConfig({ rules: [{ match: 'a', provider: '', model: '' }] }).rules, [{ match: 'a' }]);
    assert.deepEqual(
      normalizeConfig({ rules: [{ match: 'a', provider: 1, model: null, reasoningEffort: [] }] }).rules,
      [{ match: 'a' }],
      '非字符串的路由字段仍被逐字段剔除，但整条不再丢弃',
    );
  });

  it('路由字段逐个过滤，只要 match 合法整条就保留', () => {
    assert.deepEqual(
      normalizeConfig({ rules: [{ match: 'a', model: 123 }] }).rules,
      [{ match: 'a' }],
      'model 非字符串 ⇒ 该字段被剔除，整条保留',
    );
    assert.deepEqual(
      normalizeConfig({ rules: [{ match: 'a', model: 'm', provider: '', reasoningEffort: 'high' }] }).rules,
      [{ match: 'a', model: 'm', reasoningEffort: 'high' }],
    );
  });

  it('多余字段被剔除（脏数据不得透进 agentOptions）', () => {
    const out = normalizeConfig({
      rules: [{ match: 'a', provider: 'p', junk: 1, enabled: false, agentOptions: { x: 1 }, debug: true }],
    });
    assert.deepEqual(out.rules, [{ match: 'a', provider: 'p' }]);
    assert.deepEqual(Object.keys(out.rules[0]).sort(), ['match', 'provider']);
  });

  it('保留原顺序', () => {
    const out = normalizeConfig({
      rules: [
        { match: 'a*', model: 'm1' },
        { match: 'b*', model: 'm2' },
        { match: 'c*', model: 'm3' },
      ],
    });
    assert.deepEqual(out.rules.map((rule) => rule.model), ['m1', 'm2', 'm3']);
  });

  it('输出 rules 是新数组：改输入数组不回溯影响输出', () => {
    const input = { rules: [{ match: 'a', model: 'm' }] };
    const out = normalizeConfig(input);
    assert.notEqual(out.rules, input.rules);
    assert.notEqual(out.rules[0], input.rules[0]);
    input.rules[0].model = 'HACKED';
    assert.equal(out.rules[0].model, 'm');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// loadConfig
// ────────────────────────────────────────────────────────────────────────────
describe('loadConfig — 读盘失败必须静默退回默认值且不抛错', () => {
  it('文件不存在', () => {
    const missing = join(freshDir('missing'), 'no-such-config.json');
    assert.equal(existsSync(missing), false);
    assert.deepEqual(loadConfig(missing), DEFAULT_SHAPE);
  });

  it('内容不是 JSON', () => {
    const file = fixtureFile('badjson', 'config.json', '{ this is not json ');
    assert.deepEqual(loadConfig(file), DEFAULT_SHAPE);
  });

  it('空文件', () => {
    const file = fixtureFile('empty', 'config.json', '');
    assert.deepEqual(loadConfig(file), DEFAULT_SHAPE);
  });

  it('合法 JSON 但不是对象：null / 数字 / 字符串 / 数组', () => {
    for (const text of ['null', '42', '"nope"', 'true', '[]', '[{"match":"*"}]']) {
      const file = fixtureFile('nonobj', 'config.json', text);
      assert.deepEqual(loadConfig(file), DEFAULT_SHAPE, `内容=${text}`);
    }
  });

  it('路径是目录（EISDIR）也退回默认值', () => {
    const dir = freshDir('isdir');
    assert.deepEqual(loadConfig(dir), DEFAULT_SHAPE);
  });

  it('合法对象 ⇒ 走规范化（enabled:false 生效、脏规则被清、debug 透出）', () => {
    const file = fixtureFile(
      'ok',
      'config.json',
      JSON.stringify({
        enabled: false,
        debug: true,
        rules: [{ match: 'reviewer*', model: 'm', junk: 1 }, { match: '' }, null],
      }),
    );
    assert.deepEqual(loadConfig(file), {
      enabled: false,
      debug: true,
      rules: [{ match: 'reviewer*', model: 'm' }],
    });
  });

  it('返回值每次独立', () => {
    const file = fixtureFile('indep', 'config.json', JSON.stringify({ rules: [{ match: 'a', model: 'm' }] }));
    const first = loadConfig(file);
    first.rules.length = 0;
    assert.equal(loadConfig(file).rules.length, 1);
  });

  it('夹具全部落在 test/ 之内（不污染仓库其他目录）', () => {
    assert.ok(existsSync(TMP_ROOT));
    assert.ok(TMP_ROOT.startsWith(`${HERE}\\`) || TMP_ROOT.startsWith(`${HERE}/`), TMP_ROOT);
    const entries = readdirSync(TMP_ROOT);
    assert.ok(entries.length > 0, '本用例应当已经建出夹具目录');
    for (const name of entries) {
      assert.match(name, /^[a-z][a-z-]*-\d+-[a-z0-9]{1,6}$/, `意外的夹具条目：${name}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F1 回归：UTF-8 BOM
// ────────────────────────────────────────────────────────────────────────────
describe('F1 回归 — UTF-8 BOM 必须被剥掉，规则必须真的生效', () => {
  const withBom = (obj) => `\uFEFF${JSON.stringify(obj)}`;

  it('带 BOM 的合法 JSON 被正确解析（不再静默退回默认值）', () => {
    const file = fixtureFile('bom', 'config.json', withBom({ enabled: true, rules: [{ match: '*', model: 'm' }] }));
    assert.deepEqual(loadConfig(file), { enabled: true, debug: false, rules: [{ match: '*', model: 'm' }] });
  });

  it('BOM 全链生效：loadConfig → resolveRule → ruleToAgentOptions', () => {
    // F1 的真正验收点 —— 只证明「解析出来了」不够，必须证明规则能走到注入片段。
    const file = fixtureFile(
      'bom-chain',
      'config.json',
      withBom({
        enabled: true,
        debug: false,
        rules: [{ match: 'reviewer*', provider: 'ark', model: 'glm-5-3-flash', reasoningEffort: 'high' }],
      }),
    );
    const config = loadConfig(file);
    const rule = resolveRule(config, 'reviewer-1');
    assert.deepEqual(rule, { match: 'reviewer*', provider: 'ark', model: 'glm-5-3-flash', reasoningEffort: 'high' });
    assert.deepEqual(ruleToAgentOptions(rule), {
      provider: 'ark',
      model: 'glm-5-3-flash',
      reasoningEffort: 'high',
    });
  });

  it('BOM 与 enabled:false 组合：BOM 不影响关闭语义', () => {
    const file = fixtureFile('bom-off', 'config.json', withBom({ enabled: false, rules: [{ match: '*', model: 'm' }] }));
    const config = loadConfig(file);
    assert.equal(config.enabled, false);
    assert.equal(resolveRule(config, 'anything'), null);
  });

  it('只剥开头一个 BOM：内容中间的 \\uFEFF 不被误剥', () => {
    // 模式里带一个字面 U+FEFF，剥 BOM 的正则锚定 ^，不得碰到中间这个字符。
    const match = 'a\uFEFFb';
    const file = fixtureFile('bom-middle', 'config.json', `\uFEFF${JSON.stringify({ rules: [{ match, model: 'm' }] })}`);
    const config = loadConfig(file);
    assert.equal(config.rules.length, 1);
    assert.equal(config.rules[0].match, match);
    assert.equal(config.rules[0].match.length, 3, '中间的 U+FEFF 必须还在');
    assert.equal(resolveRule(config, 'a\uFEFFb')?.model, 'm');
    assert.equal(resolveRule(config, 'ab'), null);
  });

  it('两个连续 BOM 属畸形输入 ⇒ 退回默认值（不抛错，且只剥一个）', () => {
    const file = fixtureFile('bom-double', 'config.json', `\uFEFF\uFEFF${JSON.stringify({ rules: [{ match: '*', model: 'm' }] })}`);
    assert.deepEqual(loadConfig(file), DEFAULT_SHAPE);
  });

  it('无 BOM 与有 BOM 的同一份配置解析结果一致', () => {
    const body = JSON.stringify({ enabled: true, debug: true, rules: [{ match: 'x*', model: 'm' }] });
    const plain = loadConfig(fixtureFile('bom-cmp-a', 'config.json', body));
    const bom = loadConfig(fixtureFile('bom-cmp-b', 'config.json', `\uFEFF${body}`));
    assert.deepEqual(bom, plain);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// matchPattern
// ────────────────────────────────────────────────────────────────────────────
describe('matchPattern — 精确匹配与通配', () => {
  it('精确匹配', () => {
    assert.equal(matchPattern('reviewer', 'reviewer'), true);
    assert.equal(matchPattern('reviewer', 'reviewers'), false);
    assert.equal(matchPattern('reviewer', 'reviewe'), false);
  });

  it('* 前缀 / 后缀 / 中间 / 单独', () => {
    assert.equal(matchPattern('review*', 'reviewer-1'), true);
    assert.equal(matchPattern('*er-1', 'reviewer-1'), true);
    assert.equal(matchPattern('re*w*r-1', 'reviewer-1'), true);
    assert.equal(matchPattern('*', 'anything-at-all'), true);
    assert.equal(matchPattern('*', ''), true);
    assert.equal(matchPattern('review*', 'review'), true, '`*` 可匹配空串');
    assert.equal(matchPattern('review*', 'preview'), false);
  });

  it('多个 * 与多次出现', () => {
    assert.equal(matchPattern('*a*b*', 'xxayybzz'), true);
    assert.equal(matchPattern('*a*b*', 'xxbyyazz'), false);
    assert.equal(matchPattern('**', ''), true);
    assert.equal(matchPattern('a**b', 'ab'), true);
  });

  it('? 单字符', () => {
    assert.equal(matchPattern('?', 'a'), true);
    assert.equal(matchPattern('?', 'ab'), false);
    assert.equal(matchPattern('?', ''), false);
    assert.equal(matchPattern('a?c', 'abc'), true);
    assert.equal(matchPattern('a?c', 'ac'), false);
    assert.equal(matchPattern('a?c', 'abbc'), false);
  });

  it('大小写不敏感（双向）', () => {
    assert.equal(matchPattern('Reviewer', 'reviewer'), true);
    assert.equal(matchPattern('reviewer', 'REVIEWER'), true);
    assert.equal(matchPattern('REV*', 'reviewer-1'), true);
    assert.equal(matchPattern('*ER-1', 'reviewer-1'), true);
  });

  it('正则元字符被当作字面量（9 类，与旧正则实现逐条等价）', () => {
    assert.equal(matchPattern('a.b', 'axb'), false, '`.` 必须是字面点');
    assert.equal(matchPattern('a.b', 'a.b'), true);
    assert.equal(matchPattern('a+b', 'aab'), false, '`+` 不得当量词');
    assert.equal(matchPattern('a+b', 'ab'), false);
    assert.equal(matchPattern('a+b', 'a+b'), true);
    assert.equal(matchPattern('a(b)', 'ab'), false, '`(` `)` 不得当分组');
    assert.equal(matchPattern('a(b)', 'a(b)'), true);
    assert.equal(matchPattern('a|b', 'a'), false, '`|` 不得当或');
    assert.equal(matchPattern('a|b', 'a|b'), true);
    assert.equal(matchPattern('[a]', 'a'), false, '`[` `]` 不得当字符类');
    assert.equal(matchPattern('[a]', '[a]'), true);
    assert.equal(matchPattern('a{2}', 'aa'), false, '`{` `}` 不得当量词');
    assert.equal(matchPattern('a{2}', 'a{2}'), true);
    assert.equal(matchPattern('a$b', 'ab'), false, '`$` 不得当结尾锚');
    assert.equal(matchPattern('a$b', 'a$b'), true);
    assert.equal(matchPattern('^a', 'a'), false, '`^` 不得当开头锚');
    assert.equal(matchPattern('^a', '^a'), true);
    assert.equal(matchPattern('a\\b', 'a\\b'), true, '反斜杠按字面');
    assert.equal(matchPattern('a\\b', 'ab'), false);
  });

  it('通配符与元字符混用', () => {
    assert.equal(matchPattern('v?r.*', 'ver-1x'), false);
    assert.equal(matchPattern('v?r.*', 'ver.x'), true);
    assert.equal(matchPattern('*+*', 'a+b'), true);
  });

  it('整体锚定（不是子串匹配）', () => {
    assert.equal(matchPattern('view', 'reviewer'), false);
    assert.equal(matchPattern('view', 'preview'), false);
  });

  it('非字符串入参 ⇒ false，不抛错', () => {
    for (const pattern of [undefined, null, 42, {}, [], true]) {
      assert.equal(matchPattern(pattern, 'name'), false, `pattern=${JSON.stringify(pattern)}`);
    }
    for (const name of [undefined, null, 42, {}, [], true]) {
      assert.equal(matchPattern('*', name), false, `name=${JSON.stringify(name)}`);
    }
  });

  it('空模式只匹配空串', () => {
    assert.equal(matchPattern('', ''), true);
    assert.equal(matchPattern('', 'a'), false);
  });

  it('有意语义变更：`*` / `?` 现在匹配换行（旧正则实现不匹配）', () => {
    // 旧实现把 `?` 编译成 `.`、`*` 编译成 `.*`，而 JS 的 `.` 不匹配 \n \r \u2028 \u2029。
    // 新实现是字符级比较，故匹配。**这是 F4 修复的已知副作用，不是缺陷**：
    // 官方 MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u，队员名不含任何换行类字符，
    // 实际不可达；且新语义（通配符匹配任意字符）比旧语义更符合 glob 直觉。
    assert.equal(matchPattern('*', 'a\nb'), true);
    assert.equal(matchPattern('?', '\n'), true);
    assert.equal(matchPattern('?', '\r'), true);
    assert.equal(matchPattern('a?b', 'a\nb'), true);
    assert.equal(matchPattern('a*b', 'a\u2028b'), true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F4 回归：glob 等价性 + 性能
// ────────────────────────────────────────────────────────────────────────────
describe('F4 回归 — 新线性 glob 与旧正则实现等价', () => {
  /** 上一轮已废弃的正则实现，仅作等价性基准，不参与生产路径。 */
  function legacyMatch(pattern, name) {
    if (typeof pattern !== 'string' || typeof name !== 'string') return false;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(name);
  }

  function* strings(alphabet, maxLen) {
    yield '';
    let level = [''];
    for (let len = 1; len <= maxLen; len++) {
      const next = [];
      for (const prefix of level) {
        for (const ch of alphabet) next.push(prefix + ch);
      }
      level = next;
      yield* level;
    }
  }

  it('穷举差分：17 类字符 × 长度 ≤3 的模式 × 长度 ≤3 的名字，零不一致', () => {
    // 换行类字符不在名字字母表里 —— 那是已记录的、有意的语义变更（见上一条用例）。
    const PATTERN_ALPHABET = ['a', 'b', '*', '?', '.', '+', '|', '$', '^', '(', ')', '[', ']', '{', '}', '\\', '-'];
    const NAME_ALPHABET = ['a', 'b', 'A', 'B'];
    const patterns = [...strings(PATTERN_ALPHABET, 3)];
    const names = [...strings(NAME_ALPHABET, 3)];

    const mismatches = [];
    for (const p of patterns) {
      for (const n of names) {
        const legacy = legacyMatch(p, n);
        const current = matchPattern(p, n);
        if (legacy !== current) {
          mismatches.push(`pattern=${JSON.stringify(p)} name=${JSON.stringify(n)} legacy=${legacy} current=${current}`);
        }
      }
    }
    assert.equal(
      mismatches.length,
      0,
      `${patterns.length * names.length} 组比对中出现 ${mismatches.length} 处不一致：\n${mismatches.slice(0, 20).join('\n')}`,
    );
    assert.ok(patterns.length * names.length > 400000, '比对规模不得缩水');
  });
});

describe('F4 回归 — 灾难性回溯必须消失', () => {
  /** 旧实现的杀手用例：10 个 `*a` 后面跟一个失配的 `b`。 */
  const KILLER = '*a*a*a*a*a*a*a*a*a*a*b';

  it('杀手用例 × 官方队员名上限（64 字符）必须远快于 50ms', () => {
    const name = 'a'.repeat(64); // MEMBER_NAME 允许的最长合法队员名
    const started = process.hrtime.bigint();
    const result = matchPattern(KILLER, name);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(result, false, '10 个 *a 之后跟 b，纯 a 名字必须失配');
    // 旧实现在 n=40 时已需 8.7s，n=64 外推小时级；新实现实测约 0.007ms。
    // 阈值取 50ms 是为了容忍 CI 抖动，仍有约 4 个数量级的余量。
    assert.ok(elapsedMs < 50, `耗时 ${elapsedMs.toFixed(3)}ms 超过 50ms 上限`);
  });

  it('同族模式在多种长度下都不爆炸', () => {
    for (const n of [32, 48, 64, 128]) {
      const started = process.hrtime.bigint();
      matchPattern(KILLER, 'a'.repeat(n));
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(elapsedMs < 50, `n=${n} 耗时 ${elapsedMs.toFixed(3)}ms`);
    }
  });

  it('最坏情形族：50 个 `*a` + 一个失配尾巴，长名字仍是毫秒级', () => {
    const pattern = `${'*a'.repeat(50)}*b`;
    const started = process.hrtime.bigint();
    const result = matchPattern(pattern, 'a'.repeat(10000));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result, false);
    assert.ok(elapsedMs < 200, `耗时 ${elapsedMs.toFixed(3)}ms`);
  });

  it('杀手用例确实会命中合法输入（不是靠提前返回骗过性能断言）', () => {
    // 同族但尾部能配上：证明匹配路径本身也走完了。
    assert.equal(matchPattern('*a*a*b', `${'a'.repeat(64)}b`), true);
    assert.equal(matchPattern(KILLER, `${'a'.repeat(64)}b`), true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// resolveRule
// ────────────────────────────────────────────────────────────────────────────
describe('resolveRule — 命中判定', () => {
  it('config 非对象 / 为 null ⇒ null', () => {
    for (const config of [null, undefined, 'x', 42, true]) {
      assert.equal(resolveRule(config, 'name'), null, `config=${JSON.stringify(config)}`);
    }
  });

  it('enabled:false ⇒ 恒 null（即使有全匹配规则）', () => {
    const config = { enabled: false, rules: [{ match: '*', model: 'm' }] };
    assert.equal(resolveRule(config, 'anything'), null);
    assert.equal(resolveRule(config, ''), null);
    assert.equal(resolveRule(config, undefined), null);
  });

  it('name 为 undefined / 空串 / 非字符串 ⇒ null（非编队路径不命中）', () => {
    const config = { enabled: true, rules: [{ match: '*', model: 'm' }] };
    for (const name of [undefined, null, '', 42, {}, []]) {
      assert.equal(resolveRule(config, name), null, `name=${JSON.stringify(name)}`);
    }
  });

  it('缺 rules 键 / rules 为 null / 非数组 ⇒ null，不抛错', () => {
    assert.equal(resolveRule({ enabled: true }, 'x'), null);
    assert.equal(resolveRule({ enabled: true, rules: null }, 'x'), null);
    assert.equal(resolveRule({ enabled: true, rules: undefined }, 'x'), null);
    assert.equal(resolveRule({ enabled: true, rules: 'xyz' }, 'x'), null, 'F2 起：非数组直接返回 null');
    assert.equal(resolveRule({ enabled: true, rules: { 0: { match: '*' }, length: 1 } }, 'x'), null);
  });

  it('enabled 缺省视为启用', () => {
    assert.deepEqual(resolveRule({ rules: [{ match: '*' }] }, 'x'), { match: '*' });
  });

  it('第一条命中即生效（顺序语义）', () => {
    const first = { match: 'rev*', model: 'm1' };
    const second = { match: '*', model: 'm2' };
    const config = { enabled: true, rules: [first, second] };
    assert.equal(resolveRule(config, 'reviewer'), first, '必须返回第一条，且是同一引用');
    assert.equal(resolveRule(config, 'other'), second);
  });

  it('无命中 ⇒ null', () => {
    assert.equal(resolveRule({ enabled: true, rules: [{ match: 'a*', model: 'm' }] }, 'zzz'), null);
    assert.equal(resolveRule({ enabled: true, rules: [] }, 'zzz'), null);
  });

  it('大小写不敏感同样适用于 resolveRule', () => {
    const rule = { match: 'REVIEWER', model: 'm' };
    assert.equal(resolveRule({ enabled: true, rules: [rule] }, 'reviewer'), rule);
  });
});

describe('F2 回归 — resolveRule 条目级防御（脏数据不得抛 TypeError）', () => {
  const DIRTY_ENTRIES = [
    ['null', null],
    ['undefined', undefined],
    ['数字', 42],
    ['字符串', 'x'],
    ['布尔', true],
    ['空数组', []],
    ['match:null', { match: null }],
    ['match:数字', { match: 42 }],
    ['match:空串', { match: '' }],
    ['match:数组', { match: ['*'] }],
  ];

  for (const [label, entry] of DIRTY_ENTRIES) {
    it(`单项 ${label} ⇒ 不抛、返回 null`, () => {
      assert.doesNotThrow(() => resolveRule({ enabled: true, rules: [entry] }, 'x'));
      assert.equal(resolveRule({ enabled: true, rules: [entry] }, 'x'), null, label);
    });
  }

  it('全脏数组 ⇒ 不抛、返回 null', () => {
    const rules = DIRTY_ENTRIES.map(([, entry]) => entry);
    assert.doesNotThrow(() => resolveRule({ enabled: true, rules }, 'x'));
    assert.equal(resolveRule({ enabled: true, rules }, 'x'), null);
  });

  it('混合数组：脏条目被跳过，后面命中的规则照常生效', () => {
    const good = { match: 'a*', model: 'm' };
    const cases = [
      [null, good],
      [42, good],
      ['x', good],
      [[], good],
      [{ match: null }, good],
      [{ match: '' }, good],
      [null, 42, 'x', { match: 7 }, good],
    ];
    for (const rules of cases) {
      assert.equal(
        resolveRule({ enabled: true, rules }, 'abc'),
        good,
        `rules=${JSON.stringify(rules)} 应当跳过脏条目命中后面的 good`,
      );
    }
  });

  it('混合数组：脏条目在前但后面的规则不命中 ⇒ null（不是抛错）', () => {
    assert.equal(resolveRule({ enabled: true, rules: [null, { match: 'z*', model: 'm' }] }, 'abc'), null);
  });

  it('脏条目不影响「第一条命中即生效」', () => {
    const first = { match: 'a*', model: 'm1' };
    const second = { match: '*', model: 'm2' };
    assert.equal(resolveRule({ enabled: true, rules: [null, first, second] }, 'abc'), first);
  });

  it('{match:""} 不会意外匹配一切', () => {
    assert.equal(resolveRule({ enabled: true, rules: [{ match: '', model: 'm' }] }, 'anything'), null);
    assert.equal(resolveRule({ enabled: true, rules: [{ match: '', model: 'm' }] }, ' '), null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ruleToAgentOptions
// ────────────────────────────────────────────────────────────────────────────
describe('ruleToAgentOptions — 只透出白名单字段', () => {
  it('null / undefined ⇒ null', () => {
    assert.equal(ruleToAgentOptions(null), null);
    assert.equal(ruleToAgentOptions(undefined), null);
  });

  it('无任何可用路由字段 ⇒ null', () => {
    assert.equal(ruleToAgentOptions({}), null);
    assert.equal(ruleToAgentOptions({ match: 'a' }), null);
    assert.equal(ruleToAgentOptions({ match: 'a', provider: '', model: '', reasoningEffort: '' }), null);
    assert.equal(ruleToAgentOptions({ match: 'a', provider: 1, model: null }), null);
  });

  it('match 绝不进入 agentOptions', () => {
    const out = ruleToAgentOptions({ match: 'a', provider: 'p' });
    assert.deepEqual(out, { provider: 'p' });
    assert.equal('match' in out, false);
  });

  it('三个字段齐全时全部透出', () => {
    assert.deepEqual(
      ruleToAgentOptions({ match: 'a', provider: 'ark', model: 'glm', reasoningEffort: 'high' }),
      { provider: 'ark', model: 'glm', reasoningEffort: 'high' },
    );
  });

  it('空串与非字符串字段被剔除，其余保留', () => {
    assert.deepEqual(ruleToAgentOptions({ match: 'a', provider: '', model: 'm', reasoningEffort: 5 }), { model: 'm' });
    assert.deepEqual(ruleToAgentOptions({ match: 'a', provider: 'p', model: '', reasoningEffort: 'low' }), {
      provider: 'p',
      reasoningEffort: 'low',
    });
  });

  it('多余字段一律不透出（官方 resolveChildAgentOptions 会整体展开 requested）', () => {
    const out = ruleToAgentOptions({
      match: 'a',
      provider: 'p',
      junk: 1,
      subagentDepth: 99,
      maxTokens: 1,
      persona: 'x',
      toolFilter: {},
      debug: true,
    });
    assert.deepEqual(out, { provider: 'p' });
    assert.deepEqual(Object.keys(out), ['provider']);
  });

  it('返回全新对象，改它不影响入参', () => {
    const rule = { match: 'a', provider: 'p', model: 'm' };
    const out = ruleToAgentOptions(rule);
    assert.notEqual(out, rule);
    out.model = 'HACKED';
    assert.equal(rule.model, 'm');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 端到端：配置 → 注入片段
// ────────────────────────────────────────────────────────────────────────────
describe('端到端：loadConfig → resolveRule → ruleToAgentOptions', () => {
  it('真实配置全链路给出预期注入片段', () => {
    const file = fixtureFile(
      'e2e',
      'config.json',
      JSON.stringify({
        enabled: true,
        debug: false,
        rules: [
          { match: 'verifier*', provider: 'ark', model: 'glm-5-3-flash', reasoningEffort: 'high' },
          { match: '*', model: 'fallback' },
        ],
      }),
    );
    const config = loadConfig(file);
    const options = ruleToAgentOptions(resolveRule(config, 'verifier'));
    assert.deepEqual(options, { provider: 'ark', model: 'glm-5-3-flash', reasoningEffort: 'high' });
  });

  it('空规则配置（当前 config.json 的实际内容）⇒ 不注入，零副作用', () => {
    const file = fixtureFile('empty-rules', 'config.json', JSON.stringify({ enabled: true, debug: false, rules: [] }));
    assert.equal(ruleToAgentOptions(resolveRule(loadConfig(file), 'verifier')), null);
  });

  it('enabled:false ⇒ 不注入', () => {
    const file = fixtureFile(
      'disabled',
      'config.json',
      JSON.stringify({ enabled: false, rules: [{ match: '*', model: 'm' }] }),
    );
    assert.equal(ruleToAgentOptions(resolveRule(loadConfig(file), 'verifier')), null);
  });

  it('未命中队员名 ⇒ 不注入', () => {
    const file = fixtureFile(
      'nomatch',
      'config.json',
      JSON.stringify({ enabled: true, rules: [{ match: 'reviewer', model: 'm' }] }),
    );
    assert.equal(ruleToAgentOptions(resolveRule(loadConfig(file), 'verifier')), null);
  });

  it('仓库内真实 config.json 可被本模块读成合法配置', () => {
    const real = join(HERE, '..', 'config.json');
    const config = loadConfig(real);
    assert.equal(typeof config.enabled, 'boolean');
    assert.equal(typeof config.debug, 'boolean');
    assert.ok(Array.isArray(config.rules));
    for (const rule of config.rules) {
      assert.equal(typeof rule.match, 'string');
      assert.ok(rule.match.length > 0);
      assert.deepEqual(
        Object.keys(rule).filter((key) => key !== 'match').every((key) =>
          ['provider', 'model', 'reasoningEffort', 'note'].includes(key),
        ),
        true,
      );
    }
  });
});

// ---- note（中文备注）----
// 备注是给用户看的显示字段：随规则持久化，但绝不进 agentOptions。
describe('note 字段 — 持久化保留与注入隔离', () => {
  it('normalizeConfig 保留字符串 note', () => {
    assert.deepEqual(
      normalizeConfig({ rules: [{ match: 'a', note: '独立验证员' }] }).rules,
      [{ match: 'a', note: '独立验证员' }],
    );
  });

  it('note 非字符串或空串 ⇒ 丢弃，不影响其余字段', () => {
    assert.deepEqual(
      normalizeConfig({ rules: [{ match: 'a', note: 123 }, { match: 'b', note: '' }] }).rules,
      [{ match: 'a' }, { match: 'b' }],
    );
  });

  it('ruleToAgentOptions 绝不把 note 带进 agentOptions', () => {
    const rule = { match: 'a', provider: 'p', model: 'm', reasoningEffort: 'high', note: '独立验证员' };
    assert.deepEqual(ruleToAgentOptions(rule), { provider: 'p', model: 'm', reasoningEffort: 'high' });
  });

  it('只有 match + note（无路由字段）⇒ 命中但返回 null（不注入任何东西）', () => {
    assert.equal(ruleToAgentOptions({ match: 'a', note: '独立验证员' }), null);
  });

  it('loadConfig 走盘上一轮：note 原样读回', () => {
    const file = fixtureFile(
      'note-roundtrip',
      'config.json',
      JSON.stringify({ enabled: true, rules: [{ match: 'verifier*', model: 'glm-5-3-flash', note: '独立验证员' }] }),
    );
    const config = loadConfig(file);
    assert.deepEqual(config.rules, [{ match: 'verifier*', model: 'glm-5-3-flash', note: '独立验证员' }]);
    assert.deepEqual(ruleToAgentOptions(resolveRule(config, 'verifier-1')), { model: 'glm-5-3-flash' });
  });
});
