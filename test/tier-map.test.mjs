/**
 * 档位映射（`tierStyle` / `tierMap`）。
 *
 * 这一组守的是设置页里那个"自定义 —— 逐档指定"：用户能把算出来的第 i 档
 * 按到任意一档去（整体升/降一档只是它的特例）。
 *
 * 三条不能退化的约束：
 *   ① 0 档（自由尺寸的补位帧）不参与映射 —— 它本来就"占剩下的地方"；
 *   ② 表里的坏值**逐项忽略**，不能因为一个错数字把另外 7 档全打回默认；
 *   ③ 不传表 / 传空 —— 原样返回，不能悄悄改成恒等以外的什么东西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-see-tiermap-'));
process.env.DSH_HOME = home;

const { applyStrategy, DEFAULT_TIER_MAP } = await import('../src/tiers.js');
const { readTuning, writeTuning, tuningPath, TUNING_DEFAULTS } = await import('../src/tuning.js');

test('custom：逐档查表，整体升一档就是 [2,3,4,5,6,7,8,8]', () => {
  const tiers = [1, 2, 3, 4, 5, 6, 7, 8];
  const got = applyStrategy(tiers, 'custom', [2, 3, 4, 5, 6, 7, 8, 8]);
  assert.deepEqual(got, [2, 3, 4, 5, 6, 7, 8, 8]);
});

test('custom：整体降一档（1 档不再降）就是 [1,1,2,3,4,5,6,7]', () => {
  const got = applyStrategy([1, 2, 3, 4, 5, 6, 7, 8], 'custom', [1, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(got, [1, 1, 2, 3, 4, 5, 6, 7]);
});

test('custom：0 档是自由尺寸的补位帧，不参与映射', () => {
  const got = applyStrategy([0, 3], 'custom', [8, 8, 8, 8, 8, 8, 8, 8]);
  assert.equal(got[0], 0, '0 要保持 0 —— 那是"占剩下的地方"，映射成 8 会把版面搞坏');
  assert.equal(got[1], 8);
});

test('custom：表里某一项坏了只影响那一项，不整份作废', () => {
  const got = applyStrategy([1, 2, 3], 'custom', ['x', 5, 99]);
  assert.equal(got[0], 1, '非数字 → 保留原档位');
  assert.equal(got[1], 5, '好值照用');
  assert.equal(got[2], 8, '越界按 TIER_MAX 夹住，不是丢弃');
});

test('custom：没给表就原样返回（别悄悄换成什么别的）', () => {
  assert.deepEqual(applyStrategy([1, 4, 8], 'custom', null), [1, 4, 8]);
  assert.deepEqual(applyStrategy([1, 4, 8], 'custom', undefined), [1, 4, 8]);
});

test('默认映射是恒等，和 native 结果一致', () => {
  const tiers = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(DEFAULT_TIER_MAP, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(applyStrategy(tiers, 'custom', DEFAULT_TIER_MAP), applyStrategy(tiers, 'native'));
});

test('readTuning：tierMap 逐项校验，坏的那一项用默认值并给警告', () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(tuningPath({ DSH_HOME: home }), JSON.stringify({
    tierStyle: 'custom',
    tierMap: [3, 0, 5, 'x', 8, 1, 2, 4],
  }), 'utf8');

  const t = readTuning({ env: { DSH_HOME: home } });
  assert.equal(t.tierStyle, 'custom');
  assert.deepEqual(t.tierMap, [3, 2, 5, 4, 8, 1, 2, 4],
    '0 和 "x" 这两项回默认（档位 i+1），其余照用');
  assert.ok(t.warnings.some((w) => w.includes('tierMap[2]')), `该报第 2 项：${t.warnings.join(' | ')}`);
  assert.ok(t.warnings.some((w) => w.includes('tierMap[4]')), '该报第 4 项');
});

test('readTuning：tierStyle 不认识就用 native', () => {
  writeFileSync(tuningPath({ DSH_HOME: home }), JSON.stringify({ tierStyle: 'huge' }), 'utf8');
  const t = readTuning({ env: { DSH_HOME: home } });
  assert.equal(t.tierStyle, TUNING_DEFAULTS.tierStyle);
  assert.ok(t.warnings.some((w) => w.includes('tierStyle')));
});

test('writeTuning：自定义映射能落盘，读回来还是那八个数', () => {
  const path = tuningPath({ DSH_HOME: home });
  writeFileSync(path, '{}', 'utf8');
  const r = writeTuning({ tierStyle: 'custom', tierMap: [2, 2, 3, 4, 5, 6, 7, 8] }, { env: { DSH_HOME: home } });
  assert.equal(r.ok, true, JSON.stringify(r.rejected));
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.tierStyle, 'custom');
  assert.deepEqual(raw.tierMap, [2, 2, 3, 4, 5, 6, 7, 8]);
});

test('writeTuning：坏的 tierMap 会被拒，而不是悄悄写进去', () => {
  writeFileSync(tuningPath({ DSH_HOME: home }), '{}', 'utf8');
  const r = writeTuning({ tierMap: [1, 2, 3] }, { env: { DSH_HOME: home } });
  assert.equal(r.ok, false, '少了五项应该被拒（补齐会长出一份用户没写过的默认值）');
  assert.ok(r.rejected.some((x) => x.includes('tierMap')), JSON.stringify(r.rejected));
});

// ---- 锁定档位：把"时间"和"空间"拆开 ---------------------------------------

test('lock：不管密度算出几档，全部压到锁定的那一档', () => {
  const tiers = [1, 3, 6, 8];
  assert.deepEqual(applyStrategy(tiers, 'native', null, 4), [4, 4, 4, 4]);
});

test('lock：**压过** strategy 和 tierMap（它就是"我说了算"）', () => {
  const tiers = [1, 5, 8];
  // 自定义映射本来会把 1→3、5→4，锁定时一条都不该生效
  assert.deepEqual(applyStrategy(tiers, 'custom', { 1: 3, 5: 4 }, 2), [2, 2, 2]);
  assert.deepEqual(applyStrategy(tiers, 'compact', null, 2), [2, 2, 2]);
});

test('lock：0 档是自由尺寸补位帧，锁也不动它', () => {
  assert.deepEqual(applyStrategy([0, 3], 'native', null, 6), [0, 6]);
});

test('lock：0 / 越界 = 不锁，走原来的密度路径', () => {
  const base = [1, 4, 8];
  assert.deepEqual(applyStrategy(base, 'native', null, 0), base);
  assert.deepEqual(applyStrategy(base, 'native', null, 9), base);
  assert.deepEqual(applyStrategy(base, 'native', null, null), base);
});

test('readTuning：tierLock 必须是 0–8', () => {
  writeFileSync(tuningPath({ DSH_HOME: home }), JSON.stringify({ tierLock: 12 }), 'utf8');
  const t = readTuning({ env: { DSH_HOME: home } });
  assert.equal(t.tierLock, 0, '越界回默认 0（不锁定）');
  assert.ok(t.warnings.some((w) => w.includes('tierLock')), t.warnings.join(' | '));

  writeFileSync(tuningPath({ DSH_HOME: home }), JSON.stringify({ tierLock: 5 }), 'utf8');
  assert.equal(readTuning({ env: { DSH_HOME: home } }).tierLock, 5);
});
