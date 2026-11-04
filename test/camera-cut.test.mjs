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

/** 暗底 + 一个小白块：abs 约 13.6，但 mc 只有 16，用来模拟“低覆盖高尖峰”的过渡帧。 */
function flashFrame(size = 20) {
  const buf = Buffer.alloc(W * H * 3, 20);
  for (let y = 10; y < 10 + size; y += 1) {
    for (let x = 20; x < 20 + size; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = 255;
      buf[i + 1] = 255;
      buf[i + 2] = 255;
    }
  }
  return buf;
}

/** 低对比块状纹理：换纹理时 abs 低（约 22），但 mc 覆盖高。 */
function blockTexture(seed, block = 16) {
  const buf = Buffer.alloc(W * H * 3);
  let x = seed >>> 0;
  const rnd = () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x >>> 24;
  };
  for (let by = 0; by < H; by += block) {
    for (let bx = 0; bx < W; bx += block) {
      const v = rnd();
      for (let y = by; y < Math.min(H, by + block); y += 1) {
        for (let j = bx; j < Math.min(W, bx + block); j += 1) {
          const i = (y * W + j) * 3;
          buf[i] = v;
          buf[i + 1] = v;
          buf[i + 2] = v;
        }
      }
    }
  }
  return buf;
}

/** 平滑随机纹理，整屏平移 off 格；用于“快速运镜”。 */
function pattern(off) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      buf[i] = Math.max(0, Math.min(255, 128 + 70 * Math.sin((x + off) * 0.31 + y * 0.17)));
      buf[i + 1] = Math.max(0, Math.min(255, 128 + 55 * Math.sin((x + off) * 0.23 + y * 0.41)));
      buf[i + 2] = Math.max(0, Math.min(255, 128 + 45 * Math.sin((x + off) * 0.19 - y * 0.29)));
    }
  }
  return buf;
}

test('mc 切点：低 abs（约 22）但换纹理，不能只靠 80 分台阶', () => {
  const p = createPipeline({
    width: W, height: H, fps: 12, queueDepth: 0,
    cutSpikeAbs: 999, cutJumpAbs: 0, cutIsolatedAbs: 0, cutMcAbs: 60,
  });
  let f = 0;
  const a = blockTexture(1);
  const b = blockTexture(2);
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: a });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: b });
  p.finish();

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `应只留一个切点，实际 ${cuts.length}`);
  assert.ok(Math.abs(cuts[0].t - 2) < 0.01, `切点应在 2.0s，实际 ${cuts[0].t}s`);
  assert.ok(cuts[0].score < 80, `这应是低 abs 切点，实际 ${cuts[0].score}`);
});

test('cutMcAbs=0 时 mc 路径完全关闭：低 abs 换纹理不会再切', () => {
  const p = createPipeline({
    width: W, height: H, fps: 12, queueDepth: 0,
    cutSpikeAbs: 999, cutJumpAbs: 0, cutIsolatedAbs: 0, cutMcAbs: 0,
  });
  let f = 0;
  const a = blockTexture(1);
  const b = blockTexture(2);
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: a });
  for (let i = 0; i < 24; i += 1) p.push({ t: f++ / 12, buf: b });
  p.finish();
  assert.equal(p.log.filter((x) => x.via === 'cut').length, 0);
});

test('尖峰 mc 门槛：低覆盖的过渡帧不能先切，等真正的换镜头', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  const dark = Buffer.alloc(W * H * 3, 20);
  const a = blockTexture(1);
  for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: dark });
  // 两帧小面积高对比：abs 约 13.6、mc 约 16，尖峰成立但覆盖不够
  for (let i = 0; i < 2; i += 1) p.push({ t: f++ / 12, buf: flashFrame() });
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: a });
  p.finish();

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `过渡帧不该单独切，实际 ${cuts.length} 刀`);
  assert.ok(cuts[0].t > 1.1, `应等到换纹理后再切，实际 ${cuts[0].t}s`);
});

test('尖峰 mc 门槛可以关掉：同一序列恢复旧行为，先切过渡帧', () => {
  const p = createPipeline({
    width: W, height: H, fps: 12, queueDepth: 0, cutSpikeMcAbs: 0,
  });
  let f = 0;
  const dark = Buffer.alloc(W * H * 3, 20);
  const a = blockTexture(1);
  for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: dark });
  for (let i = 0; i < 2; i += 1) p.push({ t: f++ / 12, buf: flashFrame() });
  for (let i = 0; i < 36; i += 1) p.push({ t: f++ / 12, buf: a });
  p.finish();

  const cuts = p.log.filter((x) => x.via === 'cut');
  assert.equal(cuts.length, 1, `应只留第一个尖峰，实际 ${cuts.length} 刀`);
  assert.ok(cuts[0].t < 1.2, `关掉门槛后应在过渡帧切，实际 ${cuts[0].t}s`);
});

test('mc 不把快速平移当切点：radius=4 吸收整屏位移', () => {
  const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
  let f = 0;
  for (let i = 0; i < 48; i += 1) p.push({ t: f++ / 12, buf: pattern(i * 4) });
  // 收尾静止一段：最后帧没有 nextScore，旧逻辑会用 null 当尖峰；这里隔离掉收尾效应
  for (let i = 0; i < 12; i += 1) p.push({ t: f++ / 12, buf: pattern(47 * 4) });
  p.finish();
  assert.equal(p.log.filter((x) => x.via === 'cut').length, 0);
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
