/**
 * camera-cut.test.mjs — 切机位 / 相似构图的漏检回归。
 *
 * 两条漏检路径：
 *   ① 相似构图：整屏平均分只有 7.3（低于 cutAbs=12），但前后邻居是 0；
 *   ② 运动中切机位：真切点 117 分，前后帧 73/54，spike 的 2.5 倍卡掉。
 *
 * 这里用合成帧把两条路径钉住；真实素材的阈值仍应继续跑调参报告。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';

const W = 64;
const H = 36;

/** 同背景 + 一个方块。用于“相似构图”的机位/主体切换。 */
function objectAt(pos, size = 10) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 30;
      buf[i + 1] = 60;
      buf[i + 2] = 110;
    }
  }
  for (let y = 10; y < 10 + size; y += 1) {
    for (let x = pos; x < pos + size; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 240;
      buf[i + 1] = 220;
      buf[i + 2] = 30;
    }
  }
  return buf;
}

/** 整屏条纹，每帧平移 off；用于“运镜中切机位”。 */
function stripes(kind, off) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      const on = ((x + off) % 8) < 4;
      buf[i] = on ? 240 : 20;
      if (kind === 'a') {
        buf[i + 1] = on ? 240 : 20;
        buf[i + 2] = on ? 240 : 20;
      } else {
        buf[i + 1] = on ? 40 : 200;
        buf[i + 2] = on ? 40 : 200;
      }
    }
  }
  return buf;
}

test('相似构图：7.3 分的孤立切点要留下', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: objectAt(10) });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: objectAt(30) });
  p.finish();

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `应只留一个切点，实际 ${cuts.length}`);
  assert.ok(Math.abs(cuts[0].t - 2) < 0.01, `切点应在 2.0s，实际 ${cuts[0].t}s`);
  assert.ok(cuts[0].score >= 6 && cuts[0].score < 12,
    `这应是弱切点（6~12 分），实际 ${cuts[0].score}`);
});

test('运动中切机位：117 分、前后 73/54，不能被 2.5 倍卡掉', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: stripes('a', i * 4) });
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: stripes('b', i * 4) });

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `应只留一个机位切换，实际 ${cuts.length}`);
  assert.ok(Math.abs(cuts[0].t - 3) < 0.01, `切点应在 3.0s，实际 ${cuts[0].t}s`);
  assert.ok(cuts[0].score >= 80, `这应是强切点，实际 ${cuts[0].score}`);
});

test('只改亮度（5 分左右）仍不能当切点', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  const a = objectAt(10);
  const b = Buffer.from(a);
  for (let i = 0; i < b.length; i += 3) {
    b[i] = Math.min(255, b[i] + 4);
    b[i + 1] = Math.min(255, b[i + 1] + 4);
    b[i + 2] = Math.min(255, b[i + 2] + 4);
  }
  let f = 0;
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: a });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: b });
  p.finish();
  assert.equal(p.log.filter((x) => x.via === 'cut').length, 0);
});
