/**
 * 档位阈值曲线（`tierCurve`）。
 *
 * `docx` 是照抄《取帧分档算法.docx》的七道（每帧概率 × 30 → 帧/秒）；
 * `perceptual` 是按人眼瞬时记忆 / 主观现在的实测时长重排的七道。
 *
 * 这一组守四件事：
 *   ① 两套表都是"7 道切 8 档"，且严格递增 —— 少一道就少一档，乱序会让滞回判据失效；
 *   ② 感知表的两个端点确实落在 1/3.0s 与 1/0.3s 上（实验值改了要一起改，别只改注释）；
 *   ③ 中间六道是等比的（时长辨别按比例，不是按差值）；
 *   ④ `curve` 真的被 `createTiers` 用上了 —— 别出现"加了参数但没接线"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  LEVEL_THRESHOLDS, PERCEPTUAL_THRESHOLDS, TIER_CURVES, createTiers,
  PERCEPTUAL_DWELL, dwellLevel, TIER_MAX,
} = await import('../src/tiers.js');

test('两套表都是 7 道、严格递增、落在 1..8 档的边界上', () => {
  for (const [name, t] of Object.entries(TIER_CURVES)) {
    assert.equal(t.length, 7, `${name} 应该是 7 道阈值`);
    for (let i = 1; i < t.length; i += 1) {
      assert.ok(t[i] > t[i - 1], `${name} 第 ${i + 1} 道应大于第 ${i} 道`);
    }
    assert.ok(t[0] > 0, `${name} 第一道必须为正`);
  }
});

test('感知表的端点是 1/3.0s 与 1/0.3s', () => {
  const first = PERCEPTUAL_THRESHOLDS[0];
  const last = PERCEPTUAL_THRESHOLDS[PERCEPTUAL_THRESHOLDS.length - 1];
  assert.ok(Math.abs(first - 1 / 3.0) < 1e-3, `下界 ${first} 应≈0.333（一格 3 秒）`);
  assert.ok(Math.abs(last - 1 / 0.3) < 1e-3, `上界 ${last} 应≈3.333（一格 0.3 秒）`);
});

test('感知表中间六道是等比的', () => {
  const r = (PERCEPTUAL_THRESHOLDS[6] / PERCEPTUAL_THRESHOLDS[0]) ** (1 / 6);
  for (let i = 1; i < PERCEPTUAL_THRESHOLDS.length; i += 1) {
    const got = PERCEPTUAL_THRESHOLDS[i] / PERCEPTUAL_THRESHOLDS[i - 1];
    assert.ok(Math.abs(got - r) < 4e-3, `第 ${i + 1} 道步长 ${got.toFixed(4)} 偏离 ${r.toFixed(4)}`);
  }
  assert.ok(Math.abs(r - 1.4678) < 1e-3, `公比应≈1.4678，实际 ${r.toFixed(4)}`);
});

test('同一密度下两套表给出不同档位（curve 真的接线了）', () => {
  // 10 秒窗里稳定 8 个边界 → 密度 0.80 帧/秒（smoothFrames:1 = 不平滑，直接看原始值）
  const feed = (curve) => {
    const t = createTiers({ curve, dtFrames: 120, smoothFrames: 1 });
    let level = 1;
    for (let i = 0; i < 60; i += 1) {
      t.mark(i * 1.25);
      level = t.tick(i * 1.25 + 0.001);
    }
    return level;
  };
  // docx: 0.80 落在 0.6~0.9 → 3 档；perceptual: 0.80 落在 0.718~1.054 → 4 档
  assert.equal(feed('docx'), 3);
  assert.equal(feed('perceptual'), 4);
});

test('不传 curve 时退回 docx，行为不变', () => {
  for (let i = 0; i < PERCEPTUAL_THRESHOLDS.length; i += 1) {
    assert.equal(TIER_CURVES.docx[i], LEVEL_THRESHOLDS[i]);
  }
  const a = createTiers();
  const b = createTiers({ curve: 'docx' });
  for (let i = 0; i < 20; i += 1) {
    a.mark(i * 0.4);
    b.mark(i * 0.4);
    assert.equal(a.tick(i * 0.4 + 0.01), b.tick(i * 0.4 + 0.01));
  }
});

test('dwell：停留多久 → 几档（1 最大，8 最小）', () => {
  // 两个端点：3 s 仍是最大格，2.99 s 掉一档；0.30 s 还是 7 档，0.29 s 才是 8 档
  assert.equal(dwellLevel(Infinity), 1, '第一段没有可比对象，按最大格');
  assert.equal(dwellLevel(30), 1, '长镜头一直给最大格');
  assert.equal(dwellLevel(3.0), 1);
  assert.equal(dwellLevel(2.99), 2);
  assert.equal(dwellLevel(2.044), 2);
  assert.equal(dwellLevel(0.301), 7);
  assert.equal(dwellLevel(0.299), 8);
  assert.equal(dwellLevel(0), 8, '非法时长按最小格，不给大格');
  assert.equal(dwellLevel(NaN), 8);
});

test('dwell：时长越长档位只会更小，不会反着走', () => {
  let prev = TIER_MAX + 1;
  for (let s = 0.05; s <= 6; s += 0.01) {
    const k = dwellLevel(s);
    assert.ok(k >= 1 && k <= 8, `${s}s 给出越界档位 ${k}`);
    assert.ok(k <= prev, `${s.toFixed(2)}s 的档位 ${k} 比更短的 ${prev} 还大`);
    prev = k;
  }
  assert.equal(prev, 1, '扫到 6 秒必须已经落到 1 档');
});

test('dwell 端点与密度表互为倒数（同一套感知锚点，别改一个漏一个）', () => {
  assert.equal(PERCEPTUAL_DWELL.length, PERCEPTUAL_THRESHOLDS.length);
  for (let i = 0; i < PERCEPTUAL_DWELL.length; i += 1) {
    const inv = 1 / PERCEPTUAL_THRESHOLDS[i];
    assert.ok(Math.abs(PERCEPTUAL_DWELL[i] - inv) < 0.01,
      `第 ${i + 1} 道：停留 ${PERCEPTUAL_DWELL[i]}s 应对应密度 ${inv.toFixed(3)}`);
  }
});

test('显式 thresholds 压过 curve 名（设置页「自定义」走的就是这条）', () => {
  const feed = (opts) => {
    const t = createTiers({ dtFrames: 120, smoothFrames: 1, ...opts });
    let level = 1;
    for (let i = 0; i < 60; i += 1) {
      t.mark(i * 1.25);
      level = t.tick(i * 1.25 + 0.001);
    }
    return level;
  };
  // 密度 0.80：docx → 3 档、perceptual → 4 档
  assert.equal(feed({ curve: 'docx' }), 3);
  assert.equal(feed({ curve: 'perceptual' }), 4);
  // 手动把第二道压到 0.85 以下 → 0.80 只够 2 档（说明数组真的被用了，不是看名字）
  assert.equal(feed({ curve: 'docx', thresholds: [0.26, 0.85, 0.9, 1.2, 1.8, 2.4, 3] }), 2);
  assert.equal(feed({ curve: 'perceptual', thresholds: [0.26, 0.85, 0.9, 1.2, 1.8, 2.4, 3] }), 2);
});
