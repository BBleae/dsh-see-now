/**
 * apply-command-wiring.test.mjs — **`apply()` 真的把命令注册进去了**（魔改 #1 的接线）。
 *
 * 前面的 command.test.mjs 只测命令对象本身；如果 `index.js` 忘了调注册器（或者
 * `serviceOf(ctx,'commands')` 拿不到服务），单测全绿、用户打 `/` 还是找不到它。
 * 这条专门盯接线，并且顺带确认 `status` 会如实报"已注册 / 未注册"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-cmdwire-'));
process.env.DSH_HOME = home;
process.env.DSH_SEE_NO_WINDOW = '1';

const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
process.env.DSH_TOOLS_PATH = TOOLS_PATH;

const skip = !existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools，跳过（设 DSH_TOOLS_PATH 可指定）';

/** 假 ctx：带一个 records 用的 `commands` 服务（走 `ctx.get`，和 `serviceOf` 的取法一致）。 */
function fakeCtx({ withCommands = true } = {}) {
  const tools = [];
  const commands = [];
  const services = withCommands
    ? { commands: { register(definition) { commands.push(definition); return () => {}; } } }
    : {};
  const ctx = {
    tools: { register(t) { tools.push(t); return () => {}; } },
    attachments: { compression: 'png', async saveImage() { return { attachmentId: 'fake' }; } },
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {}; },
    get: (name) => services[name],
  };
  return { ctx, tools, commands };
}

test('apply() 会注册 /seenow，并在 status 里报"已注册"', { skip }, async () => {
  const mod = await import('../src/index.js');
  const { ctx, tools, commands } = fakeCtx();
  const dispose = await mod.apply(ctx);
  try {
    assert.equal(tools.length, 1, '工具还是要注册的');
    assert.equal(commands.length, 1, '命令必须真的注册进去 —— 否则用户打 / 还是找不到它');
    assert.equal(commands[0].name, 'seenow');
    assert.equal(typeof commands[0].handler, 'function');
    assert.match(String(commands[0].description ?? ''), /悬浮窗|看屏幕/);

    const st = await tools[0].execute({ action: 'status' });
    assert.match(st.text, /命令：\/seenow 已注册/, 'status 要能自证命令装上了');
  } finally {
    dispose();
  }
});

test('宿主没有 commands 服务时：工具照样注册，status 老实说"未注册"', { skip }, async () => {
  const mod = await import('../src/index.js');
  const { ctx, tools } = fakeCtx({ withCommands: false });
  const dispose = await mod.apply(ctx);
  try {
    assert.equal(tools.length, 1, '没有命令服务也不能拖垮工具');
    const st = await tools[0].execute({ action: 'status' });
    assert.match(st.text, /命令：\/seenow 未注册/);
  } finally {
    dispose();
  }
});
