/**
 * tuning.js — `~/.dsh/see-now.json`：用户自己的节奏参数。
 *
 * 为什么要这个文件：`MAX_AUTONOMOUS_WAKES`（8 次）和 `IDLE_STOP_MS`（3 分钟）
 * 原来写死在 `loop.js`，而**悬浮窗开着时「3 分钟没人说话」那条不判** ——
 * 于是 8 次叫醒就是实际的最长陪看时长（normal 档 15 秒一次 ≈ 2 分钟）。
 * 想让它多陪一会儿的用户只能改源码，或者每次开新会话先手动 `pace:"calm"`（#8）。
 *
 * 和 voice.json / tts.json / asr.json 一个套路：放 `$DSH_HOME`，不进 profile，
 * 所以 `dsh plugin update` 不会覆盖。**改完要重开 DSH**（启动时读一次，
 * 每帧读盘是拿帧率换便利，不划算）。
 *
 * 所有字段都可选；写错类型就退回默认值并记一条 warn —— 配置永远不该把插件弄挂。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 与 loop.js 的常量保持一致；这里放默认值是为了不形成反向依赖。 */
export const TUNING_DEFAULTS = Object.freeze({
  maxAutonomousWakes: 8,
  idleStopMin: 3,
  defaultPace: 'normal',
  // 「上一句说多久，就等多久再叫下一轮」（见 pacing.js）。false = 退回固定 8 秒。
  speechPacing: true,
});

/**
 * 「听声音」那一链的延迟参数（`see-now.json` 的 `listen` 段）。
 *
 * 这几个数决定"视频里说的话多久之后能变成台词"，是全链路唯一能调的地方：
 *
 * ```
 * 开口 ──silence/maxSeg 断句──▶ 落盘 ──pollMs──▶ 转写 ──▶ 台词可读
 *        └─ liveMin/liveStep：长句不等断句，先给一版临时台词
 * ```
 *
 * `live` 那组是 2026-11-04 加的：实测本地 paraformer 转 1.5 秒音频只要 140ms，
 * 而长句要等 `maxSeg`（3 秒）强切才动 —— **等断句的时间是转写本身的 20 倍**。
 */
export const LISTEN_DEFAULTS = Object.freeze({
  /** 长句「边说边出字幕」：说满 `liveMin` 秒就先转一版，整句落盘后覆盖它。 */
  live: true,
  /** 说满这么多秒才发第一版快照。1.0 秒的片段质量明显掉（实测丢一半），1.5 可用，1.8 稳。 */
  liveMin: 1.8,
  /** 之后每这么多秒刷新一次。**别低于 1.0** —— 转写服务是串行的，压太密只会互相排队。 */
  liveStep: 1.2,
  /** 静音多久算一句说完。0.35 是"人话气口"的下限，再低会把"第一个维/度是技术"切成两半。 */
  silence: 0.35,
  /** 一句话最长多少秒强切。长句靠 `live` 提前出字幕，这里不必再压。 */
  maxSeg: 3.0,
  /** Node 扫目录的间隔（毫秒）。直接计进延迟，200 → 100 净省 100ms。 */
  pollMs: 100,
});

/** 可用节奏。和 runner.js 的 PACES 同步，但不在模块层 import（避免环形依赖）。 */
export const PACES_KEYS = Object.freeze(['calm', 'normal', 'dense', 'game-economic']);

function dshHome(env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function tuningPath(env = process.env) {
  return join(dshHome(env), 'see-now.json');
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

const clampNum = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/**
 * `listen` 段。每项都夹在自己那段区间里，越界退回默认并记一条 warn ——
 * 写成 `"silence": "0.3"`（字符串）这种也必须能跑，配置不该把听声音弄停。
 */
function readListen(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = { ...LISTEN_DEFAULTS };
  const bad = [];

  if (src.live !== undefined) {
    if (typeof src.live === 'boolean') out.live = src.live;
    else bad.push('listen.live 只能是 true / false');
  }
  const num = (key, min, max) => {
    if (src[key] === undefined) return;
    const v = clampNum(src[key], min, max, out[key]);
    if (v !== out[key]) bad.push(`listen.${key} 必须在 ${min}–${max} 之间（秒）`);
    out[key] = v;
  };
  num('liveMin', 0.8, 6);
  num('liveStep', 0.4, 4);
  num('silence', 0.15, 1.5);
  num('maxSeg', 0.8, 15);

  if (src.pollMs !== undefined) {
    const v = clampInt(src.pollMs, 50, 1000, out.pollMs);
    if (v !== out.pollMs) bad.push('listen.pollMs 必须是 50–1000 的整数（毫秒）');
    out.pollMs = v;
  }
  // 快照间隔必须小于强切上限，否则一遍都发不出来
  if (out.live && out.liveStep > out.maxSeg) {
    bad.push('listen.liveStep 不能大于 maxSeg，已按 maxSeg 收窄');
    out.liveStep = out.maxSeg;
  }
  return { listen: out, warnings: bad };
}

/**
 * @param {{env?:NodeJS.ProcessEnv, readFile?:typeof readFileSync}} [opts]
 * @returns {{maxAutonomousWakes:number, idleStopMin:number, idleStopMs:number,
 *            defaultPace:string, path:string, warnings:string[]}}
 */
export function readTuning({ env = process.env, readFile = readFileSync } = {}) {
  const path = tuningPath(env);
  const warnings = [];
  let raw = {};
  try {
    raw = JSON.parse(readFile(path, 'utf8')) ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push('see-now.json 不是 JSON 对象，整份忽略');
      raw = {};
    }
  } catch (err) {
    // ENOENT 是正常的（没配过）；其它错误要说出来，否则用户改坏了也不知道
    if (err?.code !== 'ENOENT') warnings.push(`see-now.json 读不了：${err?.message ?? err}`);
    raw = {};
  }

  const maxAutonomousWakes = clampInt(
    raw.maxAutonomousWakes, 1, 200, TUNING_DEFAULTS.maxAutonomousWakes,
  );
  if (raw.maxAutonomousWakes !== undefined && maxAutonomousWakes === TUNING_DEFAULTS.maxAutonomousWakes) {
    const n = Number(raw.maxAutonomousWakes);
    if (!(Number.isInteger(n) && n >= 1 && n <= 200)) {
      warnings.push('maxAutonomousWakes 必须是 1–200 的整数，已用默认 8');
    }
  }

  // 0 = 关掉这条收工线（愿意一直陪着的人自己负责）
  const idleStopMin = clampInt(raw.idleStopMin, 0, 1440, TUNING_DEFAULTS.idleStopMin);
  if (raw.idleStopMin !== undefined && Number(raw.idleStopMin) !== idleStopMin) {
    warnings.push('idleStopMin 必须是 0–1440 的整数（分钟），已用默认 3');
  }

  let defaultPace = TUNING_DEFAULTS.defaultPace;
  if (typeof raw.defaultPace === 'string' && raw.defaultPace.trim()) {
    const want = raw.defaultPace.trim();
    if (PACES_KEYS.includes(want)) defaultPace = want;
    else warnings.push(`defaultPace 只能是 ${PACES_KEYS.join(' / ')}，已用默认 normal`);
  }

  // true / "follow" = 按上一句时长排；"guard" = 旧间隔与说完取更晚；false = 关掉
  let speechPacing = TUNING_DEFAULTS.speechPacing;
  if (raw.speechPacing !== undefined) {
    if (typeof raw.speechPacing === 'boolean') speechPacing = raw.speechPacing;
    else if (raw.speechPacing === 'guard') speechPacing = 'guard';
    else warnings.push('speechPacing 只能是 true / false / "guard"，已用默认 true');
  }

  const listenCfg = readListen(raw.listen);
  warnings.push(...listenCfg.warnings);

  return {
    maxAutonomousWakes,
    idleStopMin,
    idleStopMs: idleStopMin * 60 * 1000,
    defaultPace,
    speechPacing,
    listen: listenCfg.listen,
    path,
    warnings,
  };
}
