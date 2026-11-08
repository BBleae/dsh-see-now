/**
 * timer.js — 「钟」：定时跑 tick、该叫时叫醒模型。照搬 `dsh-watch-together/src/timer.js`。
 *
 * 职责只有两件：`startTicker`（起钟）、`wakeSession`（叫醒）。它不取图、不做判断。
 *
 * ## 为什么必须是插件自己起钟，而不是靠模型反复调工具
 *
 * 一开始 see-now 是"模型调 `watch(20s)` → 拿一张图 → 说话 → 再调一次"。
 * 实测这样跑不住：**模型拿到图、回完话就停了**，用户看到的是"它答一句就没下文了"。
 * 模型没有理由主动再调一次 —— 它不知道下一次该什么时候调。
 *
 * 所以钟必须在插件里：tick 每 2 秒敲一次（几乎不花钱），只有真的攒够一张图才叫醒。
 * 叫醒一次 = 往会话投一条消息 = 模型跑一轮，这才贵。
 *
 * ## 取服务必须容错
 *
 * cordis 的 `ctx` 是 Proxy：服务没在 `inject` 里声明时，`get` 陷阱**直接抛**
 * `cannot get property "x" without inject`。`?.` 只挡 null/undefined，**挡不住异常**。
 * 所以一律走 `ctx.get(name)`，再包一层 try。
 */

import { randomUUID } from 'node:crypto';

/**
 * 从 cordis 上下文里取一个**可选**服务（取不到返回 null，绝不抛）。
 */
export function serviceOf(ctx, name) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet) return viaGet;
    }
  } catch { /* 没有 get() / 服务没注册，往下走 */ }
  try {
    return ctx[name] ?? null;
  } catch {
    return null;      // Proxy 抛的那个 "without inject"，在这里收住
  }
}

/** 取 `sessionController`：先 `ctx.get()`，老环境才退回属性访问。 */
export function controllerOf(ctx) {
  return serviceOf(ctx, 'sessionController');
}

/** 唤醒用的消息：DSH 的 `followup()` / `steer()` 要的都是 user 角色的消息（`MessageBase`） */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    // 自定义 source.kind 是 DSH 文档里给插件用的形状
    source: { kind: 'see-now' },
  };
}

/**
 * 把一条 user 消息投给**指定的 agent**（命令里用：手上已经有 agent，不需要按 id 反查）。
 *
 * 两种投递的差别是这一版的重点（见下面 `wakeSession`）：
 *   - `steer` → `send(msg,'next-step',true)`：**下一个 step 就交给模型**，正在跑的轮次也立刻看得见
 *   - `followup` → `send(msg,'next-turn',true)`：排到**下一轮**，当前轮次不结束就永远在队列里
 *
 * @param {object} agent - 宿主的 Agent（`invocation.agent`）
 * @param {string} text
 * @param {{mode?:'steer'|'followup'}} [o]
 */
export function deliverToAgent(agent, text, { mode = 'steer' } = {}) {
  if (!agent) return { ok: false, reason: 'no-agent' };
  const message = userMessage(text);
  try {
    if (mode === 'steer' && typeof agent.steer === 'function') {
      agent.steer(message);
      return { ok: true, via: 'steer' };
    }
    agent.followup(message);
    return { ok: true, via: 'followup' };
  } catch (e) {
    // steer 抛了（宿主版本老 / 轮次边界冲突）就退回排队那条路 —— 投不到才是真丢话
    try {
      agent.followup(message);
      return { ok: true, via: 'followup', fallback: String(e?.message ?? e) };
    } catch (e2) {
      return { ok: false, reason: String(e2?.message ?? e2) };
    }
  }
}

/**
 * 起钟。返回 dispose；`unref()` 保证它不阻止宿主退出。
 *
 * @param {{everyMs?:number, tick:()=>(void|Promise<void>), immediate?:boolean}} opts
 */
export function startTicker({ everyMs = 2000, tick, immediate = true } = {}) {
  let disposed = false;
  let running = false;

  const guard = async () => {
    if (disposed || running) return;   // 上一轮还没跑完就别叠上去
    running = true;
    try {
      await tick();
    } catch {
      /* 钟自己出问题不该把宿主带崩 */
    } finally {
      running = false;
    }
  };

  const timer = setInterval(guard, everyMs);
  timer.unref?.();
  if (immediate) void guard();

  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

/**
 * 把"叫醒"包起来：叫不醒就返回原因，**绝不抛**（不然又被 ticker 的 catch 吞掉）。
 *
 * 叫醒的写法是宿主定的（DSH 内置 schedule 插件就是范本）：
 *   1. `sessionController.resolveAgent(sessionId)` → `{ agent }`
 *   2. `agent.followup(message)` 排队下一轮并唤醒驱动器
 *   3. `sessions.flush(agent.session)` 确认真的落进会话（followup 只进收件箱）
 *
 * ## `mode`：`followup` 还是 `steer`
 *
 * DSH 的 agent 有两个收件箱：`next-turn` 和 `next-step`。
 *   - `followup()` = 投 `next-turn`：**等这一轮跑完才看得到**。会话正忙的时候，
 *     人打进来的字就全堆在队列里 —— 用户侧表现是"我在悬浮窗说话，那边一点动静都没有，
 *     过好一阵才冒出来一条排队消息"（实测就是这个）。
 *   - `steer()` = 投 `next-step`：**下一个 step 就交给模型**，正在跑的轮次也立刻看得见；
 *     会话空闲时它同样会开一轮（wakeup=true）。这就是 Web 端"边跑边插话"走的那条路。
 *
 * 所以"用户打在窗口里的话"走 `steer`，"机器自己叫（有新画面了）"仍走 `followup`：
 * 前者是人，即时性就是全部；后者是噪音源，插断一轮任务反而更糟。
 *
 * @param {object} ctx
 * @param {{sessionId?:string, text?:string, mode?:'steer'|'followup'}} [o]
 */
export async function wakeSession(ctx, { sessionId, text, mode = 'followup' } = {}) {
  const sc = controllerOf(ctx);
  if (!sc?.resolveAgent) return { ok: false, reason: 'no-session-controller' };
  if (!sessionId) return { ok: false, reason: 'no-session-id' };

  try {
    const resolved = await sc.resolveAgent(sessionId);
    if (!resolved || resolved.error || !resolved.agent) {
      const reason = resolved?.error?.message ?? resolved?.error ?? 'resolve-failed';
      return { ok: false, reason: String(reason).slice(0, 160) };
    }
    const agent = resolved.agent;
    let via = 'followup';
    if (mode === 'steer' && typeof agent.steer === 'function') {
      try {
        agent.steer(userMessage(text));
        via = 'steer';
      } catch {
        // 老宿主 / 边界冲突：退回排队那条，别把话丢了
        agent.followup(userMessage(text));
      }
    } else {
      agent.followup(userMessage(text));
    }
    let flushed = null;
    try {
      const sessions = serviceOf(ctx, 'sessions');
      if (sessions?.flush) flushed = await sessions.flush(agent.session);
    } catch { flushed = false; }
    return { ok: true, via, flushed, agentStatus: typeof agent.status === 'string' ? agent.status : null };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
  }
}

/**
 * 叫醒失败要**看得见**：重试一次；还失败就写一条进悬浮窗。
 *
 * 以前这里是 `void wakeSession(...)`，返回 `{ok:false}` 也没人看 ——
 * 用户看到的现象就是"突然不理我了"（陪看那边实报过）。
 */
export async function wakeWithRetry({ ctx, sessionId, text, mode = 'followup', note = () => {}, appendMeta = null }) {
  let r = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { r = await wakeSession(ctx, { sessionId, text, mode }); } catch (e) { r = { ok: false, reason: String(e?.message ?? e) }; }
    if (r?.ok) return r;
    if (attempt === 0) await new Promise((res) => setTimeout(res, 800));
  }
  const reason = String(r?.reason ?? 'unknown').slice(0, 120);
  try { appendMeta?.(`[看屏幕] 叫醒失败：${reason}`); } catch { /* 写不进流也要留日志 */ }
  note(`wake failed: ${reason}`);
  return r ?? { ok: false, reason: 'unreachable' };
}
