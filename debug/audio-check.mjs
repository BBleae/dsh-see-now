/**
 * audio-check.mjs — 手工探针：真抓一段系统声音，看整条链通不通。
 *
 * 它不是单测（要真声卡、真在放东西、还得有转写服务）。用法：
 *
 *     # 1. 先把转写服务起来（或者在 ~/.dsh/asr.json 里配一个）
 *     # 2. 随便放个带人声的视频/音频
 *     node debug/audio-check.mjs 20
 *
 * 判据：终端里应该逐条出现 `+ [3.2s] 评价一个镜头的好坏…`。
 * 一条都没有 → 先看它打印的 `state()`：是没起、抓不到设备、还是转写全失败。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createListener } from '../src/listen.js';

const secs = Number(process.argv[2]) || 20;
const baseUrl = process.env.ASR_URL || 'http://127.0.0.1:8000/v1';

const home = mkdtempSync(join(tmpdir(), 'see-audio-check-'));
mkdirSync(join(home, 'see-now'), { recursive: true });
writeFileSync(join(home, 'asr.json'), JSON.stringify({ baseUrl }));
const env = { ...process.env, DSH_HOME: home };

const l = createListener({
  env,
  log: (m) => console.log('[log]', m),
});

const r = await l.start();
console.log('start →', r);
console.log('state →', l.state());
if (!r.ok) process.exit(1);

if (process.env.PLAY) {
  const p = spawn(process.env.PLAY, { shell: true, stdio: 'ignore', detached: true });
  p.unref();
  console.log('已开始播放:', process.env.PLAY);
}

const t0 = Date.now();
let shown = 0;
const timer = setInterval(() => {
  const got = l.between(t0 - 60_000, Date.now() + 60_000, { maxChars: 4000 });
  while (shown < got.length) {
    const line = got[shown];
    console.log(`+ [${((line.t0 - t0) / 1000).toFixed(1)}s] ${line.text}`);
    shown += 1;
  }
}, 700);
timer.unref?.();

setTimeout(() => {
  clearInterval(timer);
  l.stop('探针结束');
  console.log('最终 state →', l.state());
  console.log(`共 ${shown} 句`);
  process.exit(shown > 0 ? 0 : 2);
}, secs * 1000);
