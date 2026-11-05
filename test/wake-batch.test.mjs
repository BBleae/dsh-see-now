/**
 * wake-batch.test.mjs — 超省模式（`wakeBatch`）。
 *
 * 动机是钱：**一张 798×450 的图只有 222 token，多带两张几乎不要钱**，
 * 真正贵的是每一轮请求都要把整个上下文重过一遍。3 张一起交比分 3 次交，
 * 输入侧按实测能省约 2/3。
 *
 * 但"攒"必须和"一次全交"配套，否则一点不省：
 * 叫醒一次只给一张，剩下两张模型还得再 `peek` 两次，等于又变回三轮。
 *
 * 要守住的三条：
 *   ① 队列要压得住 N 张（`queueDepth` 跟着 `wakeBatch` 走，否则第 3 张出来时前两张已被挤掉）；
 *   ② `peek` 一次把攒的全交出去，按**时间正序**；
 *   ③ `wakeBatch: 1`（默认）行为不变 —— 一次只给一张，那是以前所有测试的前提。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG, ffmpegOk } from './ffmpeg.mjs';

// **必须在 import 之前**：chat.js 在模块加载时就把 DSH_HOME 定下来了
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-see-batch-'));
process.env.DSH_SEE_NO_WINDOW = '1';

const FIXTURE = join('.tmp', 'batch-clip.mp4');

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '30',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = !ffmpegOk();
const { createRunner } = skip ? {} : await import('../src/runner.js');

/** 等队列涨到 n 张。**不要写死 sleep**：出图节奏随机器变。 */
async function waitPending(runner, n, { tries = 120, every = 250 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (runner.status().pending >= n) return true;
    await sleep(every);
  }
  return false;
}

/** 每张 1 帧、1 秒兜底 —— 先把图攒快一点，测试不用等 20 秒 */
const FAST = { maxFrames: 1, maxWaitSec: 1 };

test('wakeBatch: 3 —— 队列压得住三张，peek 一次全给', { skip }, async () => {
  const runner = createRunner({ ffmpegPath: FFMPEG, wakeBatch: 3 });
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts: FAST });
    assert.ok(await waitPending(runner, 3),
      `前置条件：队列该攒到 3 张，实际 ${runner.status().pending}（压不住 = queueDepth 没跟着 wakeBatch 走）`);
    runner.stop();

    const got = runner.peek();
    assert.equal(got.length, 3, `一次该交 3 张，实际 ${got.length} —— 分成几次交就等于没攒`);
    assert.ok(got[0].from <= got[1].from && got[1].from <= got[2].from,
      `要按时间正序给，实际 ${got.map((s) => s.from).join(' / ')}`);
    assert.equal(runner.peek().length, 0, '取完就该空，同一张不许给两次');
  } finally {
    runner.stop();
  }
});

test('wakeBatch: 1 —— 默认行为不变，一次只给一张', { skip }, async () => {
  const runner = createRunner({ ffmpegPath: FFMPEG });
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts: FAST });
    assert.ok(await waitPending(runner, 1), '前置条件：先攒出一张');
    runner.stop();

    const got = runner.peek();
    assert.equal(got.length, 1, '默认仍然是"有新图就给一张"，这是以前所有行为的前提');
  } finally {
    runner.stop();
  }
});

test('队列上限就是 wakeBatch —— 攒有上限，不会无限堆', { skip }, async () => {
  // `wakeBatch: 2` 时队列最多压 2 张：再多就该挤掉最老的那张（queueDepth 的语义）。
  // 这条守的是"攒"不会退化成"无限缓冲"—— 那会把画面越攒越旧，换来的图还是一样的钱。
  const runner = createRunner({ ffmpegPath: FFMPEG, wakeBatch: 2 });
  try {
    await runner.start({ src: { kind: 'file', path: makeFixture(), realtime: true }, opts: FAST });
    let max = 0;
    for (let i = 0; i < 24; i += 1) {
      await sleep(250);
      max = Math.max(max, runner.status().pending);
    }
    assert.ok(max >= 1, '前置条件：6 秒里该攒出至少一张');
    assert.ok(max <= 2, `队列上限必须是 wakeBatch，实际最多到 ${max} 张`);
    assert.ok(await waitPending(runner, Math.min(max, 2)), '状态与队列要一致');
  } finally {
    runner.stop();
  }
});
