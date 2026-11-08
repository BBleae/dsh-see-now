/**
 * steer-wake.test.mjs — **用户插话要立刻进这一轮**（魔改 #3）的回归网。
 *
 * 病（实测）：悬浮窗里打字 → 循环走 `agent.followup()` → 宿主把它记成
 * `agent/inbox/spliced target=next-turn`，也就是**排到下一轮**。会话正在跑的时候，
 * 那句话就一直躺在队列里，用户侧看到的是"我打进去了，它一动不动"。
 *
 * 修的规矩：
 *   - 人在窗口里说的话 → `steer`（`next-step`，下一个 step 就交给模型）
 *   - 机器自己叫的「有新画面了」 → 仍走 `followup`（不打断正在跑的任务）
 *   - 老宿主没有 `steer` 时退回 `followup` —— 投不到才是真丢话
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { wakeSession, wakeWithRetry, deliverToAgent } = await import('../src/timer.js');

/** 假上下文：一个 agent，记录它走的是哪条投递通道。 */
function fakeCtx({ status = 'running', steer = true } = {}) {
  const calls = [];
  const agent = {
    status,
    session: { id: 'session-A' },
    followup(m) { calls.push(['followup', m.content?.[0]?.text ?? '']); },
  };
  if (steer) agent.steer = (m) => calls.push(['steer', m.content?.[0]?.text ?? '']);
  const services = {
    sessionController: { async resolveAgent() { return { agent }; } },
    sessions: { async flush() { return true; } },
  };
  return { calls, agent, ctx: { get: (n) => services[n] ?? undefined } };
}

test('mode:"steer" 走 next-step（正在跑的轮次也立刻看得见）', async () => {
  const { ctx, calls } = fakeCtx();
  const r = await wakeSession(ctx, { sessionId: 'session-A', text: '现在正常吗', mode: 'steer' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'steer');
  assert.deepEqual(calls.map((c) => c[0]), ['steer'], '不许退化成 followup —— 那就会排到下一轮');
  assert.equal(calls[0][1], '现在正常吗');
});

test('默认（机器叫醒「有新画面了」）仍走 followup，不打断正在跑的任务', async () => {
  const { ctx, calls } = fakeCtx();
  const r = await wakeSession(ctx, { sessionId: 'session-A', text: '[看屏幕] 有新画面了' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'followup');
  assert.deepEqual(calls.map((c) => c[0]), ['followup']);
});

test('会话空闲时 steer 同样能开一轮（宿主 wakeup=true，这里只验证不降级）', async () => {
  const { ctx, calls } = fakeCtx({ status: 'idle' });
  const r = await wakeSession(ctx, { sessionId: 'session-A', text: 'hi', mode: 'steer' });
  assert.equal(r.via, 'steer');
  assert.deepEqual(calls.map((c) => c[0]), ['steer']);
});

test('老宿主没有 steer：退回 followup，不丢话', async () => {
  const { ctx, calls } = fakeCtx({ steer: false });
  const r = await wakeSession(ctx, { sessionId: 'session-A', text: 'hi', mode: 'steer' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'followup');
  assert.deepEqual(calls.map((c) => c[0]), ['followup']);
});

test('steer 抛错也退回 followup（轮次边界冲突不能把话吞了）', async () => {
  const { ctx, agent } = fakeCtx();
  const calls = [];
  agent.steer = () => { throw new Error('phase conflict'); };
  agent.followup = (m) => calls.push(['followup', m.content?.[0]?.text]);
  const r = await wakeSession(ctx, { sessionId: 'session-A', text: 'hi', mode: 'steer' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'followup');
  assert.deepEqual(calls.map((c) => c[0]), ['followup']);
});

test('wakeWithRetry 把 mode 透传下去', async () => {
  const { ctx, calls } = fakeCtx();
  const r = await wakeWithRetry({ ctx, sessionId: 'session-A', text: 'hi', mode: 'steer' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'steer');
  assert.deepEqual(calls.map((c) => c[0]), ['steer']);
});

test('deliverToAgent：手上有 agent 就直接投，不需要按 id 反查', () => {
  const { agent, calls } = fakeCtx();
  const r = deliverToAgent(agent, '你好', { mode: 'steer' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'steer');
  assert.deepEqual(calls.map((c) => c[0]), ['steer']);
  assert.equal(deliverToAgent(null, 'x').ok, false);
});
