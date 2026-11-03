/**
 * audio-to-sheet.mjs — 手工验「台词真的挂到图上去了」。
 *
 * 单测只测得了缓冲和渲染，测不了这条缝：pipeline 的帧有没有带 `wall`、
 * runner 的 `attachLines()` 取的时间窗对不对、最终 sheet 上是不是真有 `lines`。
 *
 * 用法（需要转写服务在 :8000，或者环境里有 asr.json）：
 *
 *     node debug/audio-to-sheet.mjs
 *
 * 它会：生成一段 20 秒的合成视频 → 用 file 源真跑采集 → 同时播一段人声 →
 * 调一次 watch → 打印 sheet 上的台词。**不碰你的屏幕**（file 源）。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunner } from '../src/runner.js';
import { resolveFfmpeg } from '../src/binaries.js';

const ffmpeg = resolveFfmpeg().path;
const src = process.env.TEST_MEDIA;
if (!src) {
  console.error('要 TEST_MEDIA=<一个视频文件>（用 `--source file` 跑，不碰屏幕）');
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'see-sheet-'));
mkdirSync(join(home, 'see-now'), { recursive: true });
writeFileSync(join(home, 'asr.json'), JSON.stringify({
  baseUrl: process.env.ASR_URL || 'http://127.0.0.1:8000/v1',
}));

process.env.DSH_HOME = home;
process.env.DSH_SEE_NO_WINDOW = '1';

const runner = createRunner({ ffmpegPath: ffmpeg, log: (m) => console.log('[log]', m) });

const started = await runner.start({ src: { kind: 'file', path: src, realtime: true } });
console.log('start →', started.started, started.source?.kind, started.params?.width + 'x' + started.params?.height);

// 等声音那条链起来（它是不 await 的，故意不挡采集）
await new Promise((r) => setTimeout(r, 4000));
console.log('listen →', runner.status().listen);

/**
 * 连看两张。**第一张拿不到台词是正常的** —— 它是"此刻"，那时这句话还没说完；
 * 第二张的时间窗覆盖了第一段音频，就该有了。这也正是真实使用的节奏。
 */
let anyLines = false;
for (let i = 1; i <= 2; i += 1) {
  const r = await runner.watch({ seconds: 8 });
  console.log(`\n== watch #${i} ==`);
  console.log('→', { ok: r.ok, frames: r.sheet?.frames?.length, from: r.sheet?.from, to: r.sheet?.to });
  console.log('wallFrom/wallTo →', r.sheet?.wallFrom, r.sheet?.wallTo);
  console.log('lines →', JSON.stringify(r.sheet?.lines ?? null, null, 1));
  console.log('listen →', runner.status().listen);
  if (r.sheet?.lines?.length) anyLines = true;
}

runner.stop();
process.exit(anyLines ? 0 : 2);
