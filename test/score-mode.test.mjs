/**
 * score-mode.test.mjs — 可选打分口径（mc = 运动补偿）的守卫。
 *
 * 默认仍走 'abs'；mc 一旦打开，最怕的是"平移也被算成换画面"——那正是它要解决的问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createScorer, mcRatioScore, SCAN_W, SCAN_H } from '../src/cuts.js';

const W = SCAN_W;
const H = SCAN_H;
const N = W * H;

/** 造一帧 rgb24：底色 + 可选竖条纹（offset 用来模拟整屏平移） */
function frame({ r = 30, g = 40, b = 70, stripe = false, offset = 0 } = {}) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      const on = stripe && ((x + offset) % 2 === 0);
      buf[i] = on ? 240 : r;
      buf[i + 1] = on ? 240 : g;
      buf[i + 2] = on ? 240 : b;
    }
  }
  return buf;
}

/** 把 rgb24 转成 cuts.js 内部使用的 HSV 网格 */
function hsvOf(buf) {
  const scorer = createScorer({ width: W, height: H });
  return Float32Array.from(scorer(buf).hsv);
}

test('mcRatioScore：同一帧 → 0', () => {
  const a = hsvOf(frame());
  assert.equal(mcRatioScore(a, hsvOf(frame())), 0);
});

test('mcRatioScore：整屏换色 → 满格 255', () => {
  const a = hsvOf(frame({ r: 240, g: 240, b: 30 }));
  const b = hsvOf(frame({ r: 20, g: 30, b: 220 }));
  assert.ok(mcRatioScore(a, b) > 240, `应接近满格，实际 ${mcRatioScore(a, b)}`);
});

test('mcRatioScore：整屏平移一格应被邻域吸收', () => {
  const a = hsvOf(frame({ stripe: true, offset: 0 }));
  const b = hsvOf(frame({ stripe: true, offset: 1 }));
  const noSearch = mcRatioScore(a, b, { radius: 0 });
  const searched = mcRatioScore(a, b, { radius: 1 });
  assert.ok(noSearch > 100, `不搜索时应大片判变，实际 ${noSearch}`);
  assert.ok(searched < 40, `半径 1 的搜索应吸收平移，实际 ${searched}`);
});

test('createScorer：默认口径不变，切到 mc 后同一对帧分数不同', () => {
  const abs = createScorer({ width: W, height: H });
  const mc = createScorer({ width: W, height: H, scoreMode: 'mc' });
  const a = frame({ stripe: true, offset: 0 });
  const b = frame({ stripe: true, offset: 1 });
  abs(a); mc(a);
  const sAbs = abs(b).score;
  const sMc = mc(b).score;
  assert.ok(sAbs > 0, 'abs 口径下平移仍有分数（这正是缺点）');
  assert.ok(sMc < sAbs, `mc 应该更安静：abs=${sAbs} mc=${sMc}`);
});
