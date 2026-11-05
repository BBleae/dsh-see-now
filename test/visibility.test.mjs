// 悬浮窗的**可见性**（`~/.dsh/watch-window.json` 的 `hidden`）。
//
// 这一组是补 2026-11-03 的社区反馈：用户点过「藏起来」之后，`watch` 开出来的窗
// 带着 `hidden:true` 启动 —— 进程活着、心跳在跳，屏幕上什么都没有，而工具
// 没有任何一条能把它叫回来的指令（模型答"我这边只有读权限，发不了显示指令"）。
//
// 三条不能退化的约束：
//   1. 写回必须**保留其它键**（script / geometry / name），否则下次开窗要重新找解释器
//   2. 状态已经是目标值时**不写盘**（少刷一次 mtime）
//   3. 状态行必须把"藏着"说出来 —— 模型靠它判断用户到底看不看得见

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 之前设好：windowConfigPath() 走 dshHome()
const home = mkdtempSync(join(tmpdir(), 'dsh-see-vis-'));
process.env.DSH_HOME = home;

const { windowConfigPath, windowHidden, setWindowHidden, windowReport, windowLine } =
  await import('../src/window.js');

const cfgPath = windowConfigPath();

function seed(patch) {
  writeFileSync(cfgPath, JSON.stringify({ script: 'X/window.py', name: '大肥鱼', ...patch }, null, 2), 'utf8');
}

test('本会话藏起来的，windowHidden 必须是 true', () => {
  seed({});
  setWindowHidden(true);
  assert.equal(windowHidden(), true);
  assert.equal(windowReport().hidden, true);
  assert.match(windowLine(), /藏起来的/);
});

test('上一会话遗留的 hidden 不许继续生效，且要顺手把文件改回去', () => {
  // 旧版本写的：只有 hidden，没有 hiddenBy。Python 侧只认 hidden 字段，
  // 所以光在 Node 这边"当它没藏"不够 —— 必须写回 false 窗口才会真出现。
  seed({ hidden: true });
  assert.equal(windowHidden(), false);
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).hidden, false,
    '遗留状态没自愈 = 进程活着但永远看不见（issue #32 第 1 点）');
  assert.equal(windowHidden(), false, '自愈后第二次读不再写盘');
});

test('显示出来：改 hidden 但不许动其它键', () => {
  seed({ hidden: true, geometry: '700x665+1800+300' });
  const r = setWindowHidden(false);
  assert.deepEqual(r, { changed: true, hidden: false });
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.hidden, false);
  assert.equal(cfg.script, 'X/window.py', 'script 被抹掉 = 下次开窗找不到 window.py');
  assert.equal(cfg.geometry, '700x665+1800+300', 'geometry 被抹掉 = 窗跳回默认位置');
  assert.equal(cfg.name, '大肥鱼');
});

test('已经是目标状态就不写盘', () => {
  seed({ hidden: false });
  const before = readFileSync(cfgPath, 'utf8');
  const r = setWindowHidden(false);
  assert.equal(r.changed, false);
  assert.equal(readFileSync(cfgPath, 'utf8'), before);
});

test('没有 hidden 键（老配置）当成看得见；藏起来是一次真正的写盘', () => {
  seed({});
  assert.equal(windowHidden(), false);
  const r = setWindowHidden(true);
  assert.equal(r.changed, true);
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).hidden, true);
  assert.equal(windowHidden(), true);
});

test('没有配置文件也不抛（第一次装、还没开过窗）', () => {
  try { rmSync(cfgPath, { force: true }); } catch { /* 本来就没有 */ }
  assert.equal(existsSync(cfgPath), false);
  assert.equal(windowHidden(), false);
  assert.equal(setWindowHidden(false).changed, false);
});
