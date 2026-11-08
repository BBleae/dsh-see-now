import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunner, guardReason } from '../src/runner.js';

/**
 * 回归：社区实报「文件回放解 1955 帧、攒一堆唤醒、关窗也停不干净，得卸载才行」。
 *
 * 根因是 `watch` 在采集停掉时会**自动重启**：
 *   - 对文件源 = 从头再放一遍 → 无限重播 → 无限出图 → 无限叫醒
 *   - 对关过窗的用户 = 把窗重新开起来 → 关不掉
 */

test('硬闸：挂断/文件放完 只有显式指定来源才放行', () => {
  assert.equal(guardReason({}), null);
  assert.equal(guardReason({ explicitSrc: true }), null);

  assert.equal(guardReason({ hungUp: true }), 'hung-up');
  assert.equal(guardReason({ fileEnded: true }), 'file-ended');
  // 显式来源能覆盖两个闸
  assert.equal(guardReason({ hungUp: true, fileEnded: true, explicitSrc: true }), null);
});

test('挂断之后再调 watch：立刻返回 hung-up，且不会去开窗', async () => {
  const r = createRunner({ graceSec: 0 });
  r.hangUp();
  assert.equal(r.isHungUp(), true);

  const out = await r.watch({ seconds: 5 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'hung-up');
  // 关键：没有真的去拉悬浮窗（否则等于"关掉又弹出来"）
  assert.equal(r.windowWasOpen(), false);
  // 也没有启动采集
  assert.equal(r.status().running, false);
});

test('没挂断时 watch 不会被误拦', async () => {
  const r = createRunner({ graceSec: 0 });
  assert.equal(r.isHungUp(), false);
  assert.equal(r.endedFile(), null);
  assert.notEqual(guardReason({ hungUp: r.isHungUp(), fileEnded: Boolean(r.endedFile()) }), 'hung-up');
});

// ---- 手动重开窗之后要能继续看（社区实报 2026-11-03）----
import { resumeFromReopen } from '../src/runner.js';

test('重开窗解除挂断：必须看 pid 文件有没有被重写，不能只看窗口活着', () => {
  // 挂断、窗活着、但 pid 文件没变过 → 是残留进程，**不许解除**
  assert.equal(resumeFromReopen({ hungUp: true, winAlive: true, pidNow: 1000, pidAtHangUp: 1000 }), false,
    '残留窗口不能把挂断解掉，否则就是"关掉又弹出来"');
  // 挂断之后 pid 文件被重写（用户跑了 --force）→ 解除
  assert.equal(resumeFromReopen({ hungUp: true, winAlive: true, pidNow: 2000, pidAtHangUp: 1000 }), true);
  // 窗没活着 → 还是要看真有没有重开；这里不解除（挂断成立）
  assert.equal(resumeFromReopen({ hungUp: true, winAlive: false, pidNow: 2000, pidAtHangUp: 1000 }), false);
  // 本来就没挂断 → 不需要解除
  assert.equal(resumeFromReopen({ hungUp: false, winAlive: true, pidNow: 2000, pidAtHangUp: 1000 }), false);
  // 空参数不抛
  assert.equal(resumeFromReopen({}), false);
});

// ---- 关窗之后要有一条明确的出路（issue #59）----

test('用户要求重新显示 → 解除挂断，下一次 watch 不再被拦', async () => {
  process.env.DSH_SEE_NO_WINDOW = '1';
  process.env.DSH_SEE_NOW_INDICATOR = '0';
  // ffmpeg 指向不存在的路径：这里只验"闸开了没有"，不该真的抓到画面
  const r = createRunner({ graceSec: 0, ffmpegPath: 'no-such-ffmpeg-xyz' });
  r.hangUp();
  assert.equal(r.isHungUp(), true);

  assert.deepEqual(r.resumeByUser(), { wasHungUp: true }, '要告诉调用方"刚才确实是挂断状态"');
  assert.equal(r.isHungUp(), false);

  const out = await r.watch({ seconds: 0.2 });
  assert.notEqual(out.reason, 'hung-up', '解除之后不许再被硬闸拦');
  assert.equal(r.isHungUp(), false, '放行之后也不许被重新置回挂断');

  // 幂等：没挂断时再调一次不会误报
  assert.deepEqual(r.resumeByUser(), { wasHungUp: false });
  r.stop?.();
});

test('watch 本身**不会**自动解除挂断（那条门必须由显式动作打开）', async () => {
  process.env.DSH_SEE_NO_WINDOW = '1';
  const r = createRunner({ graceSec: 0, ffmpegPath: 'no-such-ffmpeg-xyz' });
  r.hangUp();
  const out = await r.watch({ seconds: 0.2 });
  assert.equal(out.reason, 'hung-up', '不带显式来源的 watch 仍要被拦 —— 否则就是"关掉又弹出来"');
  assert.equal(r.isHungUp(), true);
  r.stop?.();
});
