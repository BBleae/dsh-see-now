/**
 * client-wiring.test.mjs — 浏览器半身的**接线**检查（不渲染）。
 *
 * 这一层的失败方式特别安静：`id` 和包名差一个字、槽位名字打错、`exports.inject`
 * 漏一项，宿主都毫无异样，只会在浏览器控制台留一句 `loaded without registering`，
 * 用户看到的现象是"设置里没有这一栏"。所以把它拉出来在这里断言。
 *
 * 用一个假的 `window.__ModuleLoader__` 抓下 factory，再用一个假 React 跑一遍
 * `apply()`，看它到底注册了哪个槽位、传了什么。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── 假宿主 ────────────────────────────────────────────────────────────────────

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

/** 假 React：只需要形状对，不需要渲染。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
};

/** 假 document：`apply` 会插一段 `<style>`。 */
const styleNodes = [];
globalThis.document = {
  head: {
    appendChild(node) {
      styleNodes.push(node);
    },
  },
  createElement() {
    return {
      setAttribute() {},
      remove() {
        styleNodes.pop();
      },
      textContent: '',
    };
  },
};

await import('../client.js');

const mod = captured.factory((name) => (name === 'react' ? fakeReact : {}));

// ── 包与工厂 ──────────────────────────────────────────────────────────────────

test('ModuleLoader 的 id 必须是包名', () => {
  assert.equal(captured.id, 'dsh-see-now');
  assert.equal(mod.name, 'dsh-see-now');
});

test('inject 声明了 slots 与 locale', () => {
  assert.deepEqual(mod.inject, ['slots', 'locale']);
});

test('apply 是个函数', () => {
  assert.equal(typeof mod.apply, 'function');
});

// ── 槽位注册 ──────────────────────────────────────────────────────────────────

function runApply() {
  styleNodes.length = 0;
  const effects = [];
  const registered = [];
  const injected = [];
  const ctx = {
    effect: (fn, label) => {
      effects.push(label);
      return fn();
    },
    slots: {
      inject: (name, fn) => {
        injected.push(name);
        return fn();
      },
      register: (def, render) => {
        registered.push({ def, render });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  return { effects, registered, injected };
}

test('注册进 settings.section，id 与 order 固定', () => {
  const { registered, injected } = runApply();
  assert.deepEqual(injected, ['settings.section']);
  assert.equal(registered.length, 1);
  const { def } = registered[0];
  assert.equal(def.name, 'settings.section');
  assert.equal(def.id, 'see-now');
  assert.equal(def.order, 43);
  assert.equal(def.locale, 'settings.seeNow');
  assert.equal(def.label(), '看你看的东西');
});

test('样式表挂上了，并且带一个能摘掉的清理函数', () => {
  const { effects } = runApply();
  assert.deepEqual(effects, ['dsh-see-now: styles']);
  assert.equal(styleNodes.length, 1);
  // effect 的返回值就是 disposer：跑一次应该把它摘掉
  assert.equal(typeof styleNodes[0].remove, 'function');
});

test('第一帧（还在读）也能渲染出一个元素，不会抛', () => {
  const { registered } = runApply();
  // 槽位拿到的是 `() => h(SettingsPage)`：外面这层是组件引用，真渲染要再调一次
  const outer = registered[0].render();
  assert.equal(typeof outer.type, 'function');
  const element = outer.type(outer.props);
  assert.equal(element.type, 'div');
  assert.equal(element.props.className, 'sn_root');
});

// ── 补丁构造（纯函数部分）─────────────────────────────────────────────────────

test('patchOf 只带改过的键', () => {
  const { __test } = mod;
  const values = {
    maxAutonomousWakes: 8,
    idleStopMin: 3,
    defaultPace: 'normal',
    speechPacing: true,
    listen: { live: true, liveMin: 1.8, liveStep: 1.2, silence: 0.35, maxSeg: 3, pollMs: 100 },
  };
  const draft = __test.draftOf(values);
  assert.deepEqual(__test.patchOf(draft, values), {});

  draft.silence = '0.5';
  assert.deepEqual(__test.patchOf(draft, values), { listen: { silence: 0.5 } });

  draft.defaultPace = 'calm';
  draft.idleStopMin = '10';
  assert.deepEqual(__test.patchOf(draft, values), {
    idleStopMin: 10,
    defaultPace: 'calm',
    listen: { silence: 0.5 },
  });
});

test('空输入框交给宿主去拒，不在前端偷偷兜底成默认值', () => {
  const { __test } = mod;
  assert.ok(Number.isNaN(__test.num('')));
  assert.ok(Number.isNaN(__test.num('   ')));
  assert.equal(__test.num('1.5'), 1.5);
  assert.equal(__test.num(2), 2);
});

test('文案里不出现占位符', () => {
  const { __test } = mod;
  for (const [key, value] of Object.entries(__test.TEXT)) {
    assert.equal(typeof value, 'string', key);
    assert.ok(value.length > 0, key);
    assert.ok(!/[{}]/.test(value), `${key} 里留着模板占位符`);
  }
});

// ── 回包的两种形态都要能用 ────────────────────────────────────────────────────

test('draftOf 拿到缺 listen 段的回包也不抛', () => {
  const { __test } = mod;
  const draft = __test.draftOf({ idleStopMin: 10 });
  assert.equal(draft.idleStopMin, 10);
  assert.equal(draft.silence, undefined, '缺的段留空，不编默认值');
});

test('mergeValues 把增量回包并进整份配置', () => {
  const { __test } = mod;
  const prev = {
    maxAutonomousWakes: 8,
    idleStopMin: 3,
    defaultPace: 'normal',
    speechPacing: true,
    listen: { live: true, liveMin: 1.8, liveStep: 1.2, silence: 0.35, maxSeg: 3, pollMs: 100 },
  };

  // 老宿主：只回提交过的键 —— 顶层其他项与整个 listen 段都得留住
  const merged = __test.mergeValues(prev, { idleStopMin: 10 });
  assert.equal(merged.idleStopMin, 10);
  assert.equal(merged.maxAutonomousWakes, 8);
  assert.equal(merged.listen.silence, 0.35);

  // 只改 listen 一项时，顶层项也不能丢
  const merged2 = __test.mergeValues(prev, { listen: { silence: 0.5 } });
  assert.equal(merged2.idleStopMin, 3);
  assert.equal(merged2.listen.silence, 0.5);
  assert.equal(merged2.listen.maxSeg, 3);

  // 新宿主：回完整快照，照单全收
  const full = { ...prev, idleStopMin: 20, listen: { ...prev.listen, maxSeg: 9 } };
  assert.deepEqual(__test.mergeValues(prev, full), full);
});
