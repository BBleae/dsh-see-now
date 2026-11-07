/**
 * interject-steer.test.mjs — **窗口里的插话走 steer** 的整链回归（魔改 #3）。
 *
 * steer-wake.test.mjs 测的是"投递层选哪条通道"；这里测**循环层真的选了它**：
 * 从 `chat.jsonl`（用户就是在悬浮窗里打字）→ 循环 tick → 叫醒，全程只用真代码，
 * 只把宿主的 `sessionController` 换成假的。
 *
 * 旧行为（followup）在宿主里会写成 `agent/inbox/spliced target=next-turn` —— 排到下一轮；
 * 新行为（steer）是 `next-step` / `steering/message` —— 当前这一轮立刻看得见。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-interject-'));
process.env.DSH_HOME = home;
process.env.DSH_SEE_NO_WINDOW = '1';

const { startLoop } = await import('../src/loop.js');
const { appendChat } = await import('../src/chat.js');

/** 假 ctx：agent 两条投递通道都记下来。 */
function fakeCtx() {
  const via = [];
  const services = {
    sessionController: {
      async resolveAgent() {
        const agent = {
          status: 'running',
          session: { id: 's1' },
          steer: (m) => via.push(['steer', m.content?.[0]?.text ?? '']),
          followup: (m) => via.push(['followup', m.content?.[0]?.text ?? '']),
        };
        return { agent };
      },
    },
    sessions: { async flush() { return true; } },
  };
  return { via, ctx: { get: (n) => services[n] ?? undefined } };
}

function fakeRunner({ pending = 0, running = true } = {}) {
  const st = { pending, running, windowOpened: false, secondsSinceWake: 8 };
  return {
    st,
    windowWasOpen: () => st.windowOpened,
    status: () => ({ running: st.running, pending: st.pending, secondsSinceWake: st.secondsSinceWake }),
    stop() { st.running = false; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('悬浮窗里打字 → 循环用 steer 投递（不是排队的 followup），并记进 state().steers', async () => {
  const { ctx, via } = fakeCtx();
  const loop = startLoop({ ctx, getSessionId: () => 's1', runner: fakeRunner({ pending: 0 }) });
  try {
    // 用户就在悬浮窗里打了这句 —— 落盘即 `chat.jsonl`
    appendChat('user', '这个表格最后一列是啥');
    await sleep(2400);            // 一拍 2 秒

    assert.ok(via.length >= 1, `插话该叫醒，实际 ${via.length} 次`);
    assert.deepEqual(
      via.map((v) => v[0]), via.map(() => 'steer'),
      '插话必须走 steer —— followup 会排到下一轮，用户看到的就是"打进去没反应"',
    );
    assert.match(via[0][1], /这个表格最后一列是啥/, '要把用户原话带过去');

    const st = loop.state();
    assert.equal(st.steers, 1, 'state().steers 要记下这次即时投递');
    assert.equal(st.followups, 0);
    assert.equal(st.lastVia, 'steer');
  } finally {
    loop.dispose();
  }
});

test('机器自己叫的「有新画面了」仍走 followup（不打断正在跑的任务）', async () => {
  const { ctx, via } = fakeCtx();
  const loop = startLoop({ ctx, getSessionId: () => 's1', runner: fakeRunner({ pending: 1 }) });
  try {
    await sleep(2400);
    assert.ok(via.length >= 1, `有新图该叫醒，实际 ${via.length} 次`);
    assert.deepEqual(via.map((v) => v[0]), via.map(() => 'followup'));
    assert.equal(loop.state().followups, via.length);
    assert.equal(loop.state().steers, 0);
  } finally {
    loop.dispose();
  }
});
