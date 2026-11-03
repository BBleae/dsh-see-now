/**
 * pack.test.mjs — 实时排布（`src/pack.js`）的三条前提。
 *
 * see-now 原来没有这个文件：排布只有 `boost.test.mjs` 里那条端到端断言间接碰过。
 * 2026-11-04 把 `DEFAULT_STRETCH` 提到 0.3、收紧 flat 判据、加了逐格部分拉伸，
 * 做完变异测试发现**这三处改回旧行为，整个套件一条都不会红**。所以补上。
 *
 * 为什么单独一个文件而不是塞进 boost：boost 那套要跑完整 pipeline（打分、去重、flush
 * 时机），一次几百毫秒；这三条是纯几何，几毫秒，改排布时应该能单独快跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_GROW, DEFAULT_STRETCH, rowOptions, solve } from '../src/pack.js';

test('DEFAULT_STRETCH 是 0.3，而且它确实比 0.2 排得紧', () => {
  assert.equal(DEFAULT_STRETCH, 0.3, '容差被回滚的话这条会红');
  // 这条序列在 0.2 下要 2 张（44.3%），0.3 下 1 张（89.7%）。挑它是因为差一整张图，
  // 不是靠小数点后的 fill —— 那种断言换平台就飘。
  const seq = [3, 4, 4, 4, 7, 7, 7, 2, 2];
  const now = solve(seq, { binCost: 1.02 });
  const old = solve(seq, { stretch: 0.2, binCost: 1.02 });
  assert.equal(old.bins, 2, '0.2 容差下这 9 帧应该装不下');
  assert.equal(now.bins, 1, '0.3 容差下应该刚好一张');
  assert.ok(now.fill > old.fill + 0.2, `占用率该明显更高：${now.fill} vs ${old.fill}`);
});

test('flat 只在该行 最宽/最窄 <= (1+τ)² 时出现（别偷偷拉过头）', () => {
  // [2,4,4,4] 的水位解是 s = [1/3, 2/9, 2/9, 2/9]，wmax/wmin = 1.5。
  //   τ=0.2：边界 (1.2)² = 1.44 → 1.5 超了，不许 flat。
  //          旧的 (1+τ)/(1−τ) = 1.5 会放行，最窄格被拉到 1.25（+25%）。
  //   τ=0.3：边界 (1.3)² = 1.69 → 1.5 放行。
  assert.equal(rowOptions([2, 4, 4, 4], DEFAULT_GROW, 0.2, true).some((o) => o.flat), false,
    '20% 容差下这行不该有 flat 候选');
  assert.equal(rowOptions([2, 4, 4, 4], DEFAULT_GROW, 0.3, true).some((o) => o.flat), true,
    '30% 容差下应该允许');
});

test('缓存键必须区分 stretch（0.2 和 0.3 不能共用候选）', () => {
  // 这两个值命中的是不同的 flat 行高。键里只编码 "stretch > 0.15" 的旧实现会串。
  const a = rowOptions([2, 4, 4, 4], DEFAULT_GROW, 0.2, true);
  const b = rowOptions([2, 4, 4, 4], DEFAULT_GROW, 0.3, true);
  assert.notDeepEqual(a, b, '0.2 和 0.3 必须算出不同的候选');
  assert.deepEqual(rowOptions([2, 4, 4, 4], DEFAULT_GROW, 0.2, true), a, '回头再算 0.2 仍要拿到 0.2 的结果');
});

test('部分拉伸：矮格被拉高，但不超过行高、也不超过 (1+τ) 倍', () => {
  // [1,4,4] 一行里宽度差 2 倍，flat 不可行（超过 (1+τ)²），只能靠逐格拉。
  const tau = 0.3;
  const p = solve([1, 4, 4], { stretch: tau, binCost: 1.02 });
  const stretched = p.cells.filter((c) => c.h > c.w + 1e-9);
  assert.ok(stretched.length > 0, '宽度不等又没有 flat 的行，应该有格子被拉高');
  for (const c of p.cells) {
    assert.ok(c.h <= c.w * (1 + tau) + 1e-9, `拉伸超过容差：${c.w.toFixed(3)} -> ${c.h.toFixed(3)}`);
    assert.ok(Math.abs(c.h * c.stretch - c.w) < 1e-9, 'h 与 stretch 字段必须自洽');
  }
});
