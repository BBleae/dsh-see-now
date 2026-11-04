/**
 * listen.js — 把"视频里在说什么"接进来。
 *
 * ## 为什么需要它
 *
 * see-now 抓的是**屏幕**：`capture.js` 那条 ffmpeg 管道挂着 `-an`，一个音频字节都没有。
 * 所以模型看到的永远只有画面 —— 它不知道画面里的人在说什么、旁白讲到哪了。
 * `dsh-video-storyboard` 有 ASR，是因为它读的是文件、有音轨；实时看屏幕没有这条捷径。
 *
 * ## 这条链怎么分工
 *
 *    Python（examples/floating-chat/listen.py）
 *      WASAPI loopback 抓系统输出 → 16k 单声道 → 按静音断句 → `seg-<epochMs>.wav`
 *    Node（这里）
 *      扫目录取 wav → canonicalizeWav → 宿主 speechToText / 本地 HTTP → `{t0,t1,text}`
 *
 * 采集放 Python、转写放 Node，不是随手分的：
 *   - 抓回环只能走 pyaudiowpatch（PortAudio 官方不暴露 loopback 设备，实测 sounddevice
 *     的 WASAPI host API 里只有麦克风），那是 Python 包；
 *   - 宿主 `speechToText` 是 Node 侧的服务，只能在 Node 里调。
 *
 * ## 时间码为什么用 epoch 毫秒
 *
 * WASAPI loopback **静音时不推送数据**（实测 3 秒静音 callback 触发 0 次），
 * 样本数累加出来的时间是错的。而墙上时间是真实世界在走 —— 所以文件名里带
 * 段首的 epoch 毫秒，Node 侧拿它跟画面帧的 wall clock 对齐，中间静音多久都不漂。
 *
 * ## 部署（三级降级，永远不让"看屏幕"起不来）
 *
 *   1. 宿主 `speechToText`（DSH 桌面版自带 SenseVoice）—— 社区用户零安装
 *   2. `~/.dsh/asr.json` 指的 OpenAI 兼容服务（本地 :8000 那种）
 *   3. 都没有 → 不起 Python、不出字幕，`status` 里说明原因，看画面一切照旧
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LISTEN_SCRIPT = join(HERE, '..', 'examples', 'floating-chat', 'listen.py');

/** 台词缓冲保留多久（毫秒）。看屏幕是长期会话，不修剪会一直涨。 */
const KEEP_MS = 180_000;
/** 连续失败几次就停（每 3 秒一句，坏一次不算坏，一直坏就别耗着了）。 */
const MAX_FAILS = 3;
/**
 * 失败到上限后隔多久重试。
 *
 * 30 秒是照着"本地服务冷启动"定的：模型加载实测要 20~30 秒，
 * 比这更短只是在它还没 ready 的时候反复打空。
 */
const RETRY_MS = 30_000;

/**
 * 把 ffmpeg/PortAudio 风格的 WAV 改写成宿主认的 **canonical** 形式。
 *
 * 宿主的 `validateWave()` 逐字节认死三条：`RIFF size === len - 8`、`data` 块
 * **必须正好在偏移 36**、`data size === len - 44`。而**管道写的 WAV 做不到前两条**
 * （长度回填不了，只能写 0xFFFFFFFF），ffmpeg 还会插一个 `LIST/INFO` 把 data 顶到 70。
 * 三条全灭 → 宿主抛 "Audio must be a canonical 16 kHz mono PCM16 WAV recording"，
 * 上层只看到一句 asr-failed，日志里毫无线索（2026-11-02 macOS 实报）。
 *
 * 这段和 `dsh-video-storyboard/src/storyboard/host-asr.js` 是同一套逻辑 ——
 * 两边都不想去依赖对方（see-now 对 storyboard 没有依赖），所以各自留一份。
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer} 44 字节头 + PCM
 */
export function canonicalizeWav(input) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF'
    || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（缺 RIFF/WAVE 头）');
  }
  let p = 12;
  let fmt = null;
  let payload = null;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('latin1', p, p + 4);
    const size = bytes.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'data') {
      const end = size === 0xFFFFFFFF ? bytes.length : Math.min(bytes.length, body + size);
      payload = bytes.subarray(body, end - ((end - body) & 1));
      break;
    }
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) fmt = bytes.subarray(body, body + 16);
    if (size === 0xFFFFFFFF || body + size > bytes.length) break;
    p = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV 里没有 fmt 块');
  if (!payload) throw new Error('WAV 里没有 data 块');

  const out = Buffer.alloc(44 + payload.length);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  fmt.copy(out, 20);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(payload.length, 40);
  payload.copy(out, 44);
  return out;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh');
}

// ------------------------------------------------------------------ 转写

/**
 * 宿主 `speechToText` 适配器。取法和 storyboard 一致：`ctx.get(name)`，
 * **不能写 `ctx.speechToText`** —— cordis 对未声明的服务在 get 陷阱里直接抛，`?.` 挡不住。
 *
 * @returns {null | ((wav:Buffer) => Promise<string>)}
 */
export function hostTranscriber(ctx, { language = 'zh', timeoutMs = 30_000 } = {}) {
  let svc = null;
  try { svc = ctx?.get?.('speechToText') ?? null; } catch { svc = null; }
  if (!svc || typeof svc.resolve !== 'function' || typeof svc.transcribe !== 'function') return null;

  /** 模型不会因为"服务在"就自动加载；先 prepare 再等它 ready（最多 5 秒，等不到就直接试）。 */
  async function providerId() {
    if (typeof svc.snapshot !== 'function') return undefined;
    const id = svc.snapshot()?.selection?.providerId;
    if (!id) return undefined;
    const view = () => svc.snapshot()?.providers?.find((v) => v.id === id);
    const phase = () => view()?.preparation?.phase;
    if (!phase() || phase() === 'ready' || phase() === 'standby') return id;
    if (typeof svc.prepare !== 'function') return id;
    try { svc.prepare(id); } catch { return id; }
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 150));
      const p = phase();
      if (p === 'ready' || p === 'standby' || p === 'failed') return id;
    }
    return id;
  }

  return async function viaHost(wav) {
    const id = await providerId();
    const spec = svc.resolve({
      audio: new Uint8Array(wav), language, ...(id ? { providerId: id } : {}),
    });
    const r = await svc.transcribe(spec, AbortSignal.timeout(timeoutMs));
    return String(r?.text ?? '').trim();
  };
}

/** `~/.dsh/asr.json`（和 storyboard 共用同一份配置）：`{baseUrl, key, model, language}` */
export function asrConfig(env = process.env) {
  const home = dshHome(env);
  const cfg = readJson(join(home, 'asr.json'));
  const baseUrl = env.DSH_ASR_BASE_URL || cfg.baseUrl || '';
  if (!baseUrl) return null;
  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    key: env.DSH_ASR_KEY || cfg.key || '',
    model: env.DSH_ASR_MODEL || cfg.model || 'paraformer-zh-2024-03-09',
    language: env.DSH_ASR_LANGUAGE || cfg.language || 'zh',
    /**
     * `manage` 必须原样带出来 —— 它是"服务没起时怎么拉起"的唯一来源。
     * 早先这里只挑了 4 个字段，于是 `ensureService` 永远报"没写 manage.start"，
     * 服务永远不会被拉起（2026-11-04 排查"看不到字幕"时发现）。
     */
    manage: cfg.manage && typeof cfg.manage === 'object' ? cfg.manage : undefined,
  };
}

/** OpenAI 兼容 HTTP（see-now 自己不发请求给模型，只把音频丢给这个服务）。 */
export function httpTranscriber(cfg, { timeoutMs = 30_000, log = () => {} } = {}) {
  if (!cfg?.baseUrl) return null;
  return async function viaHttp(wav) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
    form.append('model', cfg.model);
    form.append('response_format', 'json');
    form.append('language', cfg.language || 'zh');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {},
        body: form,
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 120)}`);
      const j = await res.json();
      return String(j?.text ?? '').trim();
    } catch (e) {
      log(`转写失败：${e?.message ?? e}`);
      // **必须抛**。以前这里 `return ''`，于是上层看到的只是"这段没说话"：
      // 失败计数永远不涨、永远不停、status 里永远是"在听、0 句" ——
      // 服务根本没起的时候，界面上和"视频是默片"一模一样（2026-11-04 实报）。
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ------------------------------------------------------------------ 本地服务

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端点活着吗。2 秒超时 —— 本地服务要么秒回要么没起，等再久没意义。 */
export async function probeService(baseUrl, { timeoutMs = 2000 } = {}) {
  try {
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

/**
 * 本地转写服务没在跑就拉起来（按 `~/.dsh/asr.json` 的 `manage.start`）。
 *
 * 为什么必须有：那个服务是**空闲就退**的（`idleMs: 5000`），平时根本不在。
 * storyboard 有 `asr-lifecycle.js` 负责按需拉起，see-now 原来没有 ——
 * 表现就是"听得见、但一句台词都转不出来"，而界面上还显示"在听"。
 *
 * **只管拉、不管关**：服务自己有 idleMs，用完自己走。我们只保证"要用的时候它在"。
 */
export async function ensureService(cfg, { log = () => {}, waitMs = 60_000 } = {}) {
  const start = cfg?.manage?.start;
  if (!start) return { ok: false, reason: 'asr.json 里没写 manage.start' };
  if (await probeService(cfg.baseUrl)) return { ok: true, already: true };

  const cmd = Array.isArray(start) ? start.map(String) : [String(start)];
  const [exe, ...args] = cmd;
  log(`转写服务没在跑，拉起：${cmd.join(' ')}`);
  try {
    // 脚本目录当 cwd：很多服务按相对路径找模型
    const cwd = args[0] ? dirname(args[0]) : undefined;
    const child = spawn(exe, args, {
      detached: true, stdio: 'ignore', windowsHide: true, ...(cwd ? { cwd } : {}),
    });
    child.unref();
  } catch (e) {
    return { ok: false, reason: `起不来：${e?.message ?? e}` };
  }

  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(1000);
    if (await probeService(cfg.baseUrl)) return { ok: true, waitedMs: waitMs - (until - Date.now()) };
  }
  return { ok: false, reason: `等了 ${Math.round(waitMs / 1000)} 秒还没就绪` };
}

/** 选一个能用的转写器。宿主优先 —— 社区用户那边不用装任何东西。 */
export function resolveTranscriber(ctx, { env = process.env, log = () => {} } = {}) {
  const host = hostTranscriber(ctx);
  if (host) return { kind: 'host', transcribe: host, label: '宿主 SenseVoice' };
  const cfg = asrConfig(env);
  const http = httpTranscriber(cfg, { log });
  if (http) return { kind: 'http', transcribe: http, label: `本地 ${cfg.baseUrl}` };
  return null;
}

// ------------------------------------------------------------------ 静音窗口

/**
 * 静音窗口文件的路径。**默认和陪看共用同一个文件**（`$DSH_HOME/watch/out/quiet-until.json`）。
 *
 * 共用的理由：这个文件回答的是"这台机器上现在有没有人在念话"，跟是哪个插件在念无关。
 * 陪看的 `bin/watch.mjs` 写它（防两个 SAPI 抢话），`mic.py` 读它（防麦克风听见自己），
 * 我们两边都要 —— 写自己那份的话，麦克风那条就漏了。
 */
export function quietFile(env = process.env) {
  return env.DSH_QUIET_FILE || join(dshHome(env), 'watch', 'out', 'quiet-until.json');
}

/**
 * 占住静音窗口：告诉采集"接下来这几秒我在念，别听"。
 *
 * ⚠️ 这不是"屏蔽自己"，是**闭嘴不听** —— 窗口内整段音频直接丢，代价是：
 * 如果用户正好在这几秒说话、或者视频里正好有人在说台词，那一段也没了。
 *
 * 为什么不真做回声消除（AEC）：回环抓的是**系统混音后的成品**，AI 的声音和视频的声音
 * 在同一个信号里线性叠加，要减干净得知道它播出的每一个样本、确切时刻、以及系统音量与
 * 重采样链 —— 差一点就是减不干净的残差，而 ASR 对残差比对人声更敏感（会吐出更怪的句子）。
 * `aec.py` 那套是给麦克风用的（电信号 vs 空气传播，两条不同路径），套到回环上不成立。
 *
 * 真正的"只抓视频、不抓自己"要**按进程分轨**（Windows 的 process loopback），
 * 只能抓浏览器/播放器的音频树，AI 从别的进程出来的声音根本进不来。那是另一件事，
 * 要写 COM（`ActivateAudioInterfaceAsync`），pyaudiowpatch 没有这个能力。
 *
 * @returns {number|null} 静音到什么时候（epoch ms）
 */
export function markSpeaking(text, { env = process.env, extraMs = 1200 } = {}) {
  const chars = String(text ?? '').trim().length;
  if (!chars) return null;
  // 中文约 4~5 字/秒，取 4 再乘 1.5 倍余量，加收尾 —— **宁可多静音，也别把自己的话变成台词**
  const ms = Math.ceil((chars / 4) * 1000 * 1.5) + extraMs;
  const until = Date.now() + ms;
  try {
    const p = quietFile(env);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ until, at: Date.now(), by: 'see-now' }), 'utf8');
  } catch { /* 写不了最多是"可能听见自己"，别让它影响念 */ }
  return until;
}

// ------------------------------------------------------------------ Python

const PY_PROBE = 'import pyaudiowpatch, numpy';

/** 这个解释器有没有抓回环要的两个包（真跑一次 import，名字像没用）。 */
export function canListen(python) {
  const r = spawnSync(python, ['-c', PY_PROBE], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
  return r?.status === 0;
}

/**
 * 找解释器。顺序：
 *   1. `DSH_SEE_PYTHON`（调试/临时）
 *   2. `~/.dsh/see-window.json` 的 `listenPython` / `python`
 *   3. PATH 上的 python3/python/pythonw（win32 顺序不同）
 *
 * 注意 **window.py 用的那个解释器未必有 pyaudiowpatch**（商店版 Python 往往没有），
 * 所以这里不看 tkinter，只看能不能 import。
 */
export function findListenPython({ env = process.env } = {}) {
  const cfg = readJson(join(dshHome(env), 'see-window.json'));
  const list = [
    env.DSH_SEE_PYTHON,
    cfg.listenPython,
    cfg.python,
    env.DSH_FLOAT_PYTHON,
    ...(process.platform === 'win32' ? ['python.exe', 'pythonw.exe'] : ['python3', 'python']),
  ].filter(Boolean);
  for (const py of [...new Set(list)]) {
    if (canListen(py)) return py;
  }
  return null;
}

// ------------------------------------------------------------------ 台词缓冲

/**
 * 台词缓冲。抽出来是为了可测 —— 时间窗过滤这种东西，靠"起个 Python 真录一段"
 * 是测不出边界（跨窗、超长、乱序）的。
 *
 * `t0/t1` 都是 epoch 毫秒。
 */
export function createLineBuffer({ keepMs = KEEP_MS } = {}) {
  let lines = [];
  return {
    add(t0, t1, text) {
      const t = String(text ?? '').trim();
      if (!t) return null;
      const entry = { t0, t1, text: t };
      lines.push(entry);
      // 修剪：只留最近 keepMs。看屏幕是长期会话，两三小时不修剪就是几千条
      if (lines.length > 8) {
        const cut = Date.now() - keepMs;
        lines = lines.filter((l) => l.t1 >= cut);
      }
      return entry;
    },
    /**
     * 取某段时间窗里的台词。**窗口按相交算**（`l.t1 >= from && l.t0 <= to`），
     * 跨窗的那句两边都算 —— 宁可让模型看到同一句两次（它只会觉得啰嗦），
     * 也不要漏掉（漏了它就完全不知道这段说了什么）。
     *
     * 超长时**从新往旧丢**：最近的话更相关。
     */
    between(fromMs, toMs, { maxChars = 1200 } = {}) {
      if (!lines.length) return [];
      const out = [];
      let chars = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (l.t1 < fromMs || l.t0 > toMs) continue;
        if (chars + l.text.length > maxChars && out.length) break;
        out.push(l);
        chars += l.text.length;
      }
      return out.reverse();
    },
    get size() { return lines.length; },
    get all() { return lines.slice(); },
  };
}

// ------------------------------------------------------------------ 主体

/**
 * @param {object} o
 * @param {object|null} o.ctx        宿主 ctx（取 speechToText）
 * @param {string} [o.dir]           wav 落盘目录（默认 `~/.dsh/see-now/audio`）
 * @param {string} [o.python]        解释器（默认自动找）
 * @param {string} [o.script]        listen.py（默认包内那份）
 * @param {NodeJS.ProcessEnv} [o.env]
 */
export function createListener({
  ctx = null, dir = null, python = null, script = LISTEN_SCRIPT,
  // 200ms：这个轮询直接计进"说完到模型能看见"的延迟里（见 README 的延迟分解）。
  // 再快意义不大 —— 下面静音判定那 450ms 才是大头。
  env = process.env, log = () => {}, pollMs = 200,
} = {}) {
  const audioDir = dir || join(dshHome(env), 'see-now', 'audio');
  const buffer = createLineBuffer();
  let child = null;
  let timer = null;
  let busy = false;
  let fails = 0;
  let enabled = false;
  let reason = '没启动';
  let transcriber = null;
  let lastSegAt = 0;
  let total = 0;
  /** 音量条数据：`{step, from, db[]}`，Python 那边每秒原子重写一次 levels.json */
  let levels = null;
  let levelsAt = 0;
  /** 转写连续失败时的暂停截止时间（epoch ms）。见 drain 里的注释。 */
  let pausedUntil = 0;
  /** 最近一次转写错误（status 里要看得见，不能只进日志） */
  let lastError = null;

  function state() {
    return {
      enabled,
      reason,
      backend: transcriber?.label ?? null,
      python: python ?? null,
      dir: audioDir,
      lines: buffer.size,
      total,
      lastSegAt: lastSegAt || null,
      /** 转写出过错就带上原因 —— "在听但没台词"必须能分清是没人说话还是转写挂了 */
      error: lastError,
      paused: pausedUntil > Date.now(),
    };
  }

  /**
   * 读音量序列（每秒最多读一次 —— Python 那边就是这么写的，读更勤只是白扫盘）。
   *
   * 这东西**和转写是两条独立的线**：转写要等一整句说完，音量条是即时的。
   * 所以哪怕转写服务挂了、或者全是纯音乐没人说话，音量条照样有。
   */
  function pollLevels() {
    if (Date.now() - levelsAt < 900) return;
    levelsAt = Date.now();
    try {
      const raw = JSON.parse(readFileSync(join(audioDir, 'levels.json'), 'utf8'));
      if (Array.isArray(raw?.db) && raw.db.length) levels = raw;
    } catch { /* 还没写出来 / 正在 rename，下一次再说 */ }
  }

  /**
   * 取某段时间窗的音量序列，**对齐到 `wallFrom`**（第一格就是这一秒的声音）。
   *
   * 返回的 `db` 长度按 `span/step` 算死 —— 画条时按列聚合，长度不对就整体错位
   * （图上的柱子比声音晚半秒，看着像卡带）。
   *
   * @returns {null | {step:number, db:number[]}}
   */
  function levelsBetween(wallFrom, wallTo, { maxPoints = 900 } = {}) {
    pollLevels();     // 自己读一次：转写那条线挂了（或者全是纯音乐）也照样有音量条
    if (!levels || !(wallTo > wallFrom)) return null;
    const stepMs = (Number(levels.step) || 0.1) * 1000;
    const span = wallTo - wallFrom;
    const n = Math.round(span / stepMs);
    if (n < 2) return null;
    const count = Math.min(n, maxPoints);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const t = wallFrom + (i * span) / count;
      const k = Math.round((t - levels.from) / stepMs);
      const v = k >= 0 && k < levels.db.length ? levels.db[k] : -120;
      out.push(Number.isFinite(v) ? v : -120);
    }
    return { step: span / count / 1000, db: out };
  }

  /** 扫目录，处理没见过的 wav。一次一条，串行 —— 并发打同一个模型只会互相排队。 */
  async function drain() {
    if (busy || !transcriber) return;
    /**
     * **连续失败不 stop，只暂停**。
     *
     * 以前是"3 次就收工"，可最常见的那种失败（本地服务没起 / 正在冷启动 30 秒）
     * 完全会自己好起来 —— 那时候把整条链停掉，等于永久放弃。而且停掉会连带
     * kill 采集进程，音量条也没了。
     *
     * 暂停期间**不删文件**（留着等重试），到点先重新探活/拉起服务。
     */
    if (pausedUntil) {
      if (Date.now() < pausedUntil) return;
      pausedUntil = 0;
      fails = 0;
      ensureService(asrConfig(env), { log }).catch(() => {});
    }
    busy = true;
    try {
      pollLevels();       // 音量条和转写共用这一拍，但它自己节流到 1 秒一次
      let names = [];
      try { names = readdirSync(audioDir); } catch { names = []; }
      let segs = names
        .filter((n) => /^seg-\d+\.wav$/.test(n))
        .sort((a, b) => Number(a.slice(4, -4)) - Number(b.slice(4, -4)));
      // 转写长期不通时目录会堆 —— 只留最新的 40 段，老的直接扔
      if (segs.length > 40) {
        for (const old of segs.slice(0, segs.length - 40)) {
          try { unlinkSync(join(audioDir, old)); } catch { /* 删不掉算了 */ }
        }
        segs = segs.slice(-40);
      }
      if (env.DSH_SEE_NOW_DEBUG) log(`[listen] drain: 目录里 ${names.length} 个文件，待处理 ${segs.length}`);
      for (const name of segs) {
        const path = join(audioDir, name);
        let wav = null;
        try {
          // Python 侧是「写 .tmp 再 rename」，所以这里看到的都是完整的；
          // 但如果是老版本/被手动塞进来的，size 为 0 就跳过，别拿去转写。
          if (statSync(path).size < 1024) continue;
          wav = readFileSync(path);
        } catch { continue; }
        const t0 = Number(name.slice(4, -4));
        let text = '';
        try {
          text = await transcriber.transcribe(canonicalizeWav(wav));
          fails = 0;
          lastError = null;
        } catch (e) {
          fails += 1;
          lastError = String(e?.message ?? e);
          log(`转写出错（${fails}/${MAX_FAILS}）：${lastError}`);
          if (fails >= MAX_FAILS) {
            pausedUntil = Date.now() + RETRY_MS;
            reason = `在听（音量条还在），但转写连续失败：${lastError}`;
          }
          continue;      // **不删文件** —— 服务起来之后这些段还要用
        }
        // 处理完就删：目录是工作区，不是档案。留着会几小时涨到几千个文件。
        try { unlinkSync(path); } catch { /* 删不掉就下次再说 */ }
        if (!text) continue;
        const dur = Math.max(0.2, (wav.length - 44) / 2 / 16_000);
        buffer.add(t0, t0 + Math.round(dur * 1000), text);
        lastSegAt = Date.now();
        total += 1;
      }
    } finally {
      busy = false;
    }
  }

  /**
   * 起采集。**幂等**，失败只记状态不抛 —— 音频是加分项，装不上最多没字幕。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function start() {
    if (child) return { ok: true, reason: 'already' };
    if (env.DSH_SEE_AUDIO === '0') {
      reason = '被 DSH_SEE_AUDIO=0 关掉了';
      enabled = false;
      return { ok: false, reason };
    }
    transcriber = resolveTranscriber(ctx, { env, log });
    if (!transcriber) {
      reason = '没有可用的转写服务（宿主没有 speechToText，也没有 ~/.dsh/asr.json）';
      enabled = false;
      return { ok: false, reason };
    }
    /**
     * 走 HTTP 就先确认本地服务在不在。
     *
     * **不 await**：服务冷启动要 20~30 秒，挡在这里会让"开始看"变成一个几十秒的空转。
     * 采集和音量条先跑，转写在后台等它就绪 —— 期间的段不删，起来之后照常处理。
     */
    if (transcriber.kind === 'http') {
      ensureService(asrConfig(env), { log })
        .then((r) => { if (!r.ok) log(`转写服务没起来：${r.reason}`); })
        .catch(() => { /* 已经在里面兜过了 */ });
    }
    if (!existsSync(script)) {
      reason = `找不到 listen.py（${script}）`;
      enabled = false;
      return { ok: false, reason };
    }
    python ??= findListenPython({ env });
    if (!python) {
      reason = '没有能用的 Python（要 `pip install pyaudiowpatch numpy`，'
        + '或把解释器路径写进 ~/.dsh/see-window.json 的 listenPython）';
      enabled = false;
      return { ok: false, reason };
    }

    mkdirSync(audioDir, { recursive: true });
    try {
      child = spawn(python, [script, '--out', audioDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...env, DSH_VIDEO_CACHE_DIR: join(dshHome(env), 'see-now') },
      });
    } catch (e) {
      reason = `起不来：${e?.message ?? e}`;
      enabled = false;
      child = null;
      return { ok: false, reason };
    }

    child.stdout?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`[listen] ${s.slice(0, 400)}`);
    });
    child.stderr?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`[listen] ${s.slice(-400)}`);
    });
    child.on('exit', (code) => {
      const wasEnabled = enabled;
      child = null;
      enabled = false;
      if (timer) { clearInterval(timer); timer = null; }
      if (wasEnabled) {
        reason = `采集进程退出了（code=${code}）`;
        log(reason);
      }
    });

    // 等它把设备打开：不确认就报"在听"，用户会以为功能开了其实一句都没录（踩过）
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 4000);
      const onData = (d) => {
        if (!String(d).includes('"event": "device"')) return;
        clearTimeout(t);
        child?.stdout?.off('data', onData);
        resolve(true);
      };
      child?.stdout?.on('data', onData);
      child?.once('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (!ok) {
      stop('回环设备没打开（没有可用的 WASAPI loopback？）');
      reason = '回环设备没打开 —— 这台机器抓不到系统输出的声音';
      return { ok: false, reason };
    }

    enabled = true;
    reason = '在听';
    timer = setInterval(() => {
      // 这里**不能静默吞**：drain 里的意外（权限、编码、表单构造）如果被 `.catch(() => {})`
      // 吃掉，表现就是"在听、但永远没台词"，日志里一条线索都没有。
      drain().catch((e) => log(`[listen] drain 出错：${e?.message ?? e}`));
    }, pollMs);
    timer.unref?.();
    return { ok: true };
  }

  function stop(why = null) {
    if (timer) { clearInterval(timer); timer = null; }
    if (child) {
      try { child.kill(); } catch { /* 已经没了 */ }
      child = null;
    }
    enabled = false;
    reason = why || '停了';
  }

  /**
   * 取某段时间窗里的台词（见 `createLineBuffer().between`）。
   */
  function between(fromMs, toMs, opts) {
    return buffer.between(fromMs, toMs, opts);
  }

  return { start, stop, state, between, levelsBetween, drain };
}
