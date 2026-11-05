/**
 * dsh-see-now —— 浏览器半身。
 *
 * 只做一件事：在 DSH 设置里放一页「看你在干什么」，让 `~/.dsh/see-now.json`
 * 里那九个值从"要改源码"变成"看得见、改得动、改错了会告诉你为什么"。
 *
 * ## 为什么这件事必须有界面
 *
 * 这些值原本写死在 `loop.js` 里。作者在 `tuning.js` 的注释里自己记着这件事
 * （读过源码的人只会在那儿看到一个 issue 编号），后来抽出了配置层和校验，
 * 但用户要动它仍然得手写 JSON —— 而写错一个类型就是"永远不停"或"立刻停"。
 *
 * ## 数据从哪来
 *
 * 走本插件自己的同源 `/api/see-now/*` 路由：`GET /status` 读、`POST /config` 写。
 * 校验规则**一条都不在这里**——全在 `src/tuning.js` 的 `readTuning` 里，
 * 前端只负责显示它给出的 `warnings`。前端另写一套规则，就一定会和宿主吵起来。
 *
 * ## 手写 ModuleLoader 包
 *
 * 不需要构建步骤，除 shell 已提供的 `react` 之外没有依赖。
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  // 必须是包名，不是插件的短名。client-modules 的 `arrive()` 拿着包名去查已经
  // 注册的 factory，名字对不上就一路抛 `loaded without registering "dsh-see-now"`，
  // 而那条错误只进浏览器控制台 —— 宿主那头毫无异样，设置里就是干脆没有这一栏。
  id: 'dsh-see-now',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useCallback, Fragment } = React;

    const NS = 'settings.seeNow';
    /** 路由前缀；与 `src/settings-api.mjs` 的 `ROUTE_PREFIX` 必须一致。 */
    const API = '/api/see-now';
    const inject = ['slots', 'locale'];

    // ── 文案 ──────────────────────────────────────────────────────────────────
    // 先只写中文：这一版的目标是"跑通"，双语等它成立之后再补一份 en 字典。
    const TEXT = {
      nav: '看你看的东西',
      title: '看你看的东西',
      sub: '让 AI 实时看屏幕、听声音，只在画面真的变了才交图。这里调的是"陪多久、多久看一次、一句听到哪儿算完"。',
      'state.loading': '读取中…',
      'state.reload': '重新读取',
      'state.save': '保存',
      'state.saving': '保存中…',
      'state.saved': '已保存。重开 DSH 生效。',
      'state.savedLocal': '已保存。下一次转写就用新地址。',
      'state.nosave': '没有改动。',
      'sec.common': '常用',
      'sec.advanced': '高级（一般不用动）',
      'field.prefer': '用哪个转写服务',
      'field.prefer.hint': '宿主自带的是 SenseVoice（桌面版内置、零配置、不占显存）。下面那块 asr.json 是可选的自建或在线服务 —— 选「只用宿主自带的」时它不参与，那块配置会收起来。',
      'prefer.auto': '自动 —— 宿主自带的优先',
      'prefer.host': '只用宿主自带的（SenseVoice）',
      'prefer.local': '只用下面那个服务（asr.json）',
      'local.title': '转写服务（asr.json）',
      'local.sub': '这个文件决定"声音用谁听写"。它与 video-storyboard 共用一份 —— 两个插件都读它，所以改这里对两边都生效。',
      'local.api': '接口形态',
      'local.api.hint': '多数服务是音频接口。只有聊天接口的服务（小米 MiMo 这类）才选第二种 —— 端点不一样，选错会 404。',
      'local.api.openai': '音频接口 /audio/transcriptions',
      'local.api.chat': '聊天接口 /chat/completions',
      'local.baseUrl': '服务地址',
      'local.baseUrl.hint': '要带版本路径，例如 https://api.example.com/v1。留空 = 不用这个文件。',
      'local.baseUrl.ph': 'https://api.example.com/v1',
      'local.model': '模型名',
      'local.model.hint': '按服务方的文档填。',
      'local.language': '语言',
      'local.language.hint': 'auto / zh / en，按服务支持的填。',
      'local.key': '密钥',
      'local.key.hint': '只写不读：文件里的 key 不会回显到页面上。留空表示不改。',
      'local.key.keep': '已设置，留空不改',
      'local.key.ph': '没设置',
      'local.empty': '这里还是空的。填了地址就能用；留空则由上面「用哪个转写服务」的规则决定。',
      'local.save': '保存转写服务',
      'local.sample': '看看这个文件长什么样',
      'local.sample.body': '{\n  "api": "openai-audio",\n  "baseUrl": "http://127.0.0.1:8000/v1",\n  "model": "paraformer-zh-2024-03-09",\n  "language": "auto"\n}',
      'local.manage': '文件里还有 manage（怎么把服务拉起来）一类的键，面板不动它们，原样保留。',
      'local.env': '环境变量正在覆盖这些字段',
      'field.pace': '默认节奏',
      'field.pace.hint': '决定多长时间醒一次、一次说多少。理解为"话多话少"。',
      'pace.calm': '平缓 —— 很久才出声',
      'pace.normal': '正常 —— 默认',
      'pace.dense': '密集 —— 反应快，话也多',
      'pace.game-economic': '游戏省流 —— 只在动作明显时才看',
      'field.batch': '超省模式（攒几张再交）',
      'field.batch.hint': '攒够几张图才叫醒你一次。1 张 = 攒满就交（默认，最及时）。'
        + '调到 3 张：模型一次看三张，少两轮请求 —— 省的是"每轮都要把整个上下文重过一遍"那笔，'
        + '一张图本身只要 222 token，多带两张几乎不要钱。代价是画面更晚到：'
        + '每张要 15~40 秒，攒 3 张就是 1~2 分钟。会话越长越值。',
      'batch.1': '1 张 —— 攒满就交（默认）',
      'batch.2': '2 张',
      'batch.3': '3 张 —— 省得明显',
      'batch.4': '4 张 —— 最省，也最慢',
      'field.idleStop': '空闲多久自己收工',
      'field.idleStop.hint': '单位分钟。0 = 关掉这条线，你不理它它就一直陪着（会一直花 token）。',
      'field.pacing': '说话停顿跟着句长走',
      'field.pacing.hint': '长句之后多留一点，短句之后紧一点。',
      'pacing.follow': '跟随句长（默认）',
      'pacing.guard': '取更晚的那个',
      'pacing.off': '关掉，固定间隔',
      'field.silence': '静音多久算一句说完',
      'field.silence.hint': '单位秒。0.35 是人喘口气的下限 —— 再低会把一句话从中间切开，后半截被当成新的一句。',
      'field.maxSeg': '一句最长多久',
      'field.maxSeg.hint': '单位秒。说到这么久还没停就强行断开，否则一句话一直不断，字幕永远出不来。',
      'field.tierStyle': '每帧多大（档位）',
      'field.tierStyle.hint': '档位 1 = 一格占满，8 = 只占 1/8 边。'
        + '默认跟着变化密度走：帧越密格子越小，这样一张图覆盖的时长才稳定。'
        + '所以换「节奏」时格子会跟着变 —— 那是设计，不是错。'
        + '要自己说了算就选「固定一档」，两件事就分开了。',
      'tier.native': '跟随密度 —— 算出来几档就是几档（默认）',
      'tier.full': '更大 —— 在密度基础上整体降一档',
      'tier.compact': '更小 —— 在密度基础上整体升一档',
      'tier.custom': '自定义 —— 逐档指定映射',
      'tier.lock': '固定一档 —— 不随密度变',
      'field.tierLock': '固定用哪一档',
      'field.tierLock.hint': '节奏怎么改都不影响尺寸，这就是把「时间」和「空间」拆开。'
        + '代价：帧很稀的时候（省流档、游戏档）一格可能只放一两帧，剩下的画布是空的。',
      'field.tierMap': '逐档映射',
      'field.tierMap.hint': '左边是算出来的档位，右边选它实际落到哪一档。'
        + '想把"1 档"也缩小就把它改成 2；想让 8 档别那么碎就改成 6。',
      'tier.from': '档',
      'field.wakes': '自主唤醒上限',
      'field.wakes.hint': '你一句话都没说，它自己最多醒几次就收工。',
      'field.live': '说长句时先出半截字幕',
      'field.live.hint': '关掉的话，一句话必须等说完才显示 —— 说满十几秒的时候屏幕上一个字都没有。',
      'field.liveMin': '多长开始给半截',
      'field.liveMin.hint': '单位秒。说满这么久先生成一份快照去转写。',
      'field.liveStep': '半截多久更新一次',
      'field.liveStep.hint': '单位秒。越小字幕跟得越紧，转写次数也越多。不能超过「一句最长」。',
      'field.pollMs': '多久查一次有没有新声音',
      'field.pollMs.hint': '单位毫秒。这个不是转写的开销，主要成本是等断句。',
      'hint.restart': '改这里不会当场生效：这些值决定的是循环的收工线和断句节奏，插件在启动时读一次。保存后重开 DSH。',
      'hint.path': '配置文件',
      'hint.origin': '这里显示的默认值直接来自插件源码，不是在界面里另写一套。',
      'warn.title': '配置里有几处它没接受，用的是默认值',
      'err.rejected': '这几项没通过校验，文件没有被改动：',
      'err.load': '读不到配置',
      'err.save': '保存失败',
      'note.file': '文件还不存在。现在保存会新建它，只写你改过的那几项。',
    };

    const t = key => TEXT[key] ?? key;

    // ── 样式 ──────────────────────────────────────────────────────────────────
    const CSS = `
.sn_root{display:flex;flex-direction:column;gap:14px;padding:2px 0 8px}
.sn_hero{display:flex;flex-direction:column;gap:8px;padding:18px 20px;border-radius:16px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);
  background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 86%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent))}
.sn_title{margin:0;font-size:19px;font-weight:740;letter-spacing:-.3px;color:var(--dsw-alias-label-primary)}
.sn_sub{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);max-width:78ch}
.sn_card{display:flex;flex-direction:column;gap:12px;padding:16px 18px;border-radius:14px;
  border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.sn_cardhd{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.sn_cardname{font-size:13.5px;font-weight:660;color:var(--dsw-alias-label-primary)}
.sn_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.sn_field{display:flex;flex-direction:column;gap:5px;min-width:0}
.sn_label{font-size:12px;font-weight:620;color:var(--dsw-alias-label-primary)}
.sn_hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.sn_input,.sn_select{height:32px;padding:0 10px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sn_input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sn_select{cursor:pointer}
.sn_input:focus-visible,.sn_select:focus-visible{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.sn_check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
.sn_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sn_btn{height:30px;padding:0 14px;border-radius:8px;font-size:12px;font-weight:620;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent);
  color:var(--dsw-alias-label-primary)}
.sn_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l2)}
.sn_btn.primary{border-color:transparent;color:#fff;background:var(--dsw-alias-state-business-primary)}
.sn_btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 86%,#fff)}
.sn_btn:disabled{opacity:.5;cursor:not-allowed}
.sn_ok{font-size:11.5px;color:var(--dsw-alias-state-success-primary)}
.sn_note{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.sn_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.sn_box{padding:10px 12px;border-radius:10px;font-size:11.5px;line-height:1.6;word-break:break-word}
.sn_box.warn{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 40%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 8%,transparent);color:var(--dsw-alias-state-warning-primary,#f0a441)}
.sn_box.bad{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.sn_box ul{margin:4px 0 0;padding-left:18px}
.sn_box li{margin:2px 0}
.sn_det summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:2px 0}
.sn_pre{margin:8px 0 0;padding:10px 12px;border-radius:8px;overflow-x:auto;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
`;

    /**
     * 一个带超时的 JSON 请求。
     *
     * 没有超时的话，Host 正忙时一次挂起的 fetch 会让整页永远停在"读取中"。
     */
    async function api(path, options) {
      const { timeout = 15000, ...rest } = options ?? {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(API + path, { ...rest, signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const why = body && Array.isArray(body.rejected) ? body.rejected.join('；') : `HTTP ${res.status}`;
          throw new Error(why);
        }
        if (body === null) throw new Error('返回值不是 JSON');
        return body;
      } finally {
        clearTimeout(timer);
      }
    }

    /** 表单草稿：扁平结构，读起来比嵌套少一层心智负担。 */
    function draftOf(values) {
      const listen = values?.listen ?? {};
      return {
        maxAutonomousWakes: values.maxAutonomousWakes,
        idleStopMin: values.idleStopMin,
        defaultPace: values.defaultPace,
        speechPacing: values.speechPacing,
        prefer: listen.prefer,
        live: listen.live,
        liveMin: listen.liveMin,
        liveStep: listen.liveStep,
        silence: listen.silence,
        maxSeg: listen.maxSeg,
        pollMs: listen.pollMs,
      };
    }

    /**
     * 按段浅合并两份 values。
     *
     * 宿主 `/config` 的回包现在给的是**写完之后文件里的完整快照**，但面板不该赌
     * 宿主一定是新版 —— 老实现回的是 `writeTuning().values`，按"只写提交过的键"
     * 的语义只有本次提交的那几个，合并一次两种都能用。
     */
    function mergeValues(prev, next) {
      const base = prev ?? {};
      const patch = next ?? {};
      return {
        ...base,
        ...patch,
        listen: { ...(base.listen ?? {}), ...(patch.listen ?? {}) },
      };
    }

    /** 输入框里的字符串换成数字；空串或非数就原样交给宿主去判（它会拒，并给出原因）。 */
    const num = value => {
      if (typeof value === 'number') return value;
      const text = String(value ?? '').trim();
      if (text === '') return Number.NaN;
      return Number(text);
    };

    /**
     * 只把**改过**的键做成补丁。
     *
     * 整体提交虽然也能跑，但它会在用户什么都没动的情况下把一整份默认值写进文件 ——
     * 而 `tuning.js` 的初衷是"用户只写自己想改的那几项"。
     */
    function patchOf(draft, values) {
      const patch = {};
      for (const key of ['maxAutonomousWakes', 'idleStopMin', 'defaultPace', 'speechPacing']) {
        if (draft[key] !== values[key]) patch[key] = key === 'defaultPace' || key === 'speechPacing'
          ? draft[key]
          : num(draft[key]);
      }
      if (draft.tierStyle !== values.tierStyle) patch.tierStyle = String(draft.tierStyle ?? '');
      /**
       * 锁定档位：**缺失也算 0**。直接 `Number(undefined) !== Number(undefined)` 是
       * `NaN !== NaN`（恒真），values 里没有这个键时每次保存都会顺手写一个 `tierLock: NaN`。
       */
      const lockOf = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));
      if (lockOf(draft.tierLock) !== lockOf(values.tierLock)) patch.tierLock = num(draft.tierLock);
      // 数组比引用永远不等，只能比内容；顺序有意义（第 i 个 = 档位 i+1）
      if (JSON.stringify(draft.tierMap ?? null) !== JSON.stringify(values.tierMap ?? null)) {
        patch.tierMap = (Array.isArray(draft.tierMap) ? draft.tierMap : []).map((n) => num(n));
      }
      const listen = {};
      for (const key of ['prefer', 'live', 'liveMin', 'liveStep', 'silence', 'maxSeg', 'pollMs']) {
        if (draft[key] === values.listen[key]) continue;
        // prefer 是枚举字符串，不能交给 num()（那会把 'host' 换成 NaN）
        listen[key] = key === 'live' ? draft[key] === true
          : key === 'prefer' ? String(draft[key] ?? '')
          : num(draft[key]);
      }
      if (Object.keys(listen).length > 0) patch.listen = listen;
      return patch;
    }

    // ── asr.json 的那一份草稿 ─────────────────────────────────────────────────
    // 单独一套，因为它写的是另一个文件：改了立刻对下一次转写生效，不用重开 DSH。
    // key 永远是空串起步 —— 后端不回传密钥，所以"草稿里没有 key" 与 "文件里没有 key"
    // 是两件事，靠 hasKey 区分。
    const ASR_FIELDS = ['api', 'baseUrl', 'model', 'language'];

    function localDraftOf(local) {
      if (!local || typeof local !== 'object') return null;
      return {
        api: local.api || 'openai-audio',
        baseUrl: local.baseUrl || '',
        model: local.model || '',
        language: local.language || '',
        key: '',
      };
    }

    /** 只提交真的改过的那几个键；key 只在用户真填了的时候才带。 */
    function localPatchOf(draft, local) {
      const patch = {};
      if (!draft || !local) return patch;
      for (const key of ASR_FIELDS) {
        const next = String(draft[key] ?? '').trim();
        if (next !== String(local[key] ?? '').trim()) patch[key] = next;
      }
      const key = String(draft.key ?? '').trim();
      if (key !== '') patch.key = key;
      return patch;
    }

    /**
     * asr.json 那块只在**可能用到它**的时候出现。
     *
     * 原来它顶在最上面，看起来像"转写已经换成这个自建服务了"——实际上宿主自带的
     * SenseVoice 一直在，选了 local 才轮到 asr.json。所以：选「只用宿主自带的」
     * 时整块收起来，别让配置项的存在暗示了不存在的替换关系。
     */
    const shouldShowLocal = (prefer) => prefer !== 'host';

    // ── 设置页 ────────────────────────────────────────────────────────────────
    function SettingsPage() {
      const [data, setData] = useState(null);
      const [draft, setDraft] = useState(null);
      const [error, setError] = useState('');
      const [rejected, setRejected] = useState([]);
      const [busy, setBusy] = useState(true);
      const [savedAt, setSavedAt] = useState(0);
      // asr.json 那一套是独立的：不同文件、不同生效方式（改完立刻生效）。
      const [localDraft, setLocalDraft] = useState(null);
      const [localRejected, setLocalRejected] = useState([]);
      const [localAt, setLocalAt] = useState(0);

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const next = await api('/status');
          setData(next);
          setDraft(draftOf(next.values));
          setLocalDraft(localDraftOf(next.local));
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const set = (key, value) => {
        setSavedAt(0);
        setRejected([]);
        setDraft(current => ({ ...current, [key]: value }));
      };

      /**
       * 改逐档映射里的一项。
       *
       * 必须**整份数组换新**（不能原地改）：`patchOf` 靠比较两份 draft 来算补丁，
       * 原地改会让"改过"和"没改"看起来一样，那一项就永远提交不上去。
       */
      const setTierMap = (i, v) => {
        const base = Array.isArray(draft?.tierMap) ? draft.tierMap : [1, 2, 3, 4, 5, 6, 7, 8];
        const next = base.map((x) => Number(x));
        next[i] = Number(v);
        set('tierMap', next);
      };

      const save = async () => {
        if (data === null || draft === null) return;
        const patch = patchOf(draft, data.values);
        if (Object.keys(patch).length === 0 && patch.listen === undefined) {
          setSavedAt(-1);
          return;
        }
        setBusy(true);
        setError('');
        setRejected([]);
        try {
          const result = await api('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          });
          if (result.ok) {
            // 用宿主回的值重建，而不是把草稿当成新真相：这样面板显示的永远是
            // "文件里实际是什么"，连派生值（idleStopMs）都对。合并是因为回包
            // 可能是增量（见 mergeValues）。
            const merged = mergeValues(data.values, result.values);
            setData(current => ({ ...current, values: merged, warnings: result.warnings, path: result.path }));
            setDraft(draftOf(merged));
            setSavedAt(Date.now());
          } else {
            setRejected(result.rejected ?? []);
          }
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      };

      const setLocal = (key, value) => {
        setLocalAt(0);
        setLocalRejected([]);
        setLocalDraft(current => ({ ...(current ?? {}), [key]: value }));
      };

      const saveLocal = async () => {
        if (data === null || localDraft === null) return;
        const patch = localPatchOf(localDraft, data.local);
        if (Object.keys(patch).length === 0) {
          setLocalAt(-1);
          return;
        }
        setBusy(true);
        setError('');
        setLocalRejected([]);
        try {
          const result = await api('/local', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          });
          if (result.ok) {
            // 同 save()：以宿主回的快照为准，别把草稿当真相。
            setData(current => ({ ...current, local: result.local }));
            setLocalDraft(localDraftOf(result.local));
            setLocalAt(Date.now());
          } else {
            setLocalRejected(result.rejected ?? []);
          }
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      };

      if (data === null || draft === null) {
        return h('div', { className: 'sn_root' },
          h('div', { className: 'sn_hero' },
            h('h2', { className: 'sn_title' }, t('title')),
            h('p', { className: 'sn_sub' }, t('sub'))),
          error !== '' ? h('div', { className: 'sn_box bad' }, `${t('err.load')}：${error}`) : h('div', { className: 'sn_note' }, t('state.loading')),
          h('div', { className: 'sn_row' }, h('button', { className: 'sn_btn', onClick: load, disabled: busy }, t('state.reload'))));
      }

      const field = (key, labelKey, hintKey, props) => h('label', { className: 'sn_field', key },
        h('span', { className: 'sn_label' }, t(labelKey)),
        h('input', {
          className: 'sn_input',
          type: 'number',
          value: String(draft[key] ?? ''),
          onChange: e => set(key, e.target.value),
          ...props,
        }),
        h('span', { className: 'sn_hint' }, t(hintKey)));

      const select = (key, labelKey, hintKey, options) => h('label', { className: 'sn_field', key },
        h('span', { className: 'sn_label' }, t(labelKey)),
        h('select', {
          className: 'sn_select',
          value: String(draft[key]),
          onChange: e => set(key, e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value),
        }, options.map(([value, text]) => h('option', { key: String(value), value: String(value) }, text))),
        h('span', { className: 'sn_hint' }, t(hintKey)));

      // asr.json 那一套的控件：数据源是 localDraft，不是 draft（两个不同的文件）。
      const localField = (key, labelKey, hintKey, props) => h('label', { className: 'sn_field', key: `l_${key}` },
        h('span', { className: 'sn_label' }, t(labelKey)),
        h('input', {
          className: 'sn_input',
          value: String(localDraft?.[key] ?? ''),
          onChange: e => setLocal(key, e.target.value),
          ...props,
        }),
        h('span', { className: 'sn_hint' }, t(hintKey)));

      const localSelect = (key, labelKey, hintKey, options) => h('label', { className: 'sn_field', key: `l_${key}` },
        h('span', { className: 'sn_label' }, t(labelKey)),
        h('select', {
          className: 'sn_select',
          value: String(localDraft?.[key] ?? ''),
          onChange: e => setLocal(key, e.target.value),
        }, options.map(([value, text]) => h('option', { key: String(value), value: String(value) }, text))),
        h('span', { className: 'sn_hint' }, t(hintKey)));

      // ── 转写服务：asr.json ──
      // 放在「常用」**下面**：先看"用哪个"，再看"那个服务的细节"。顶在最上面会让
      // 人以为这是在替换宿主自带的转写 —— 它只是备选，选「只用宿主的」时整块收起。
      const localCard = data.local && localDraft && shouldShowLocal(draft.prefer)
        ? h('div', { className: 'sn_card' },
          h('div', { className: 'sn_cardhd' }, h('span', { className: 'sn_cardname' }, t('local.title'))),
          h('p', { className: 'sn_note', style: { margin: '0 0 10px' } }, t('local.sub')),
          h('div', { className: 'sn_mono', style: { marginBottom: '10px' } }, data.local.path),
          !data.local.exists ? h('div', { className: 'sn_hint', style: { marginBottom: '10px' } }, t('local.empty')) : null,
          h('div', { className: 'sn_grid' },
            localSelect('api', 'local.api', 'local.api.hint', [
              ['openai-audio', t('local.api.openai')],
              ['chat-audio', t('local.api.chat')],
            ]),
            localField('baseUrl', 'local.baseUrl', 'local.baseUrl.hint', { type: 'text', placeholder: t('local.baseUrl.ph') }),
            localField('model', 'local.model', 'local.model.hint', { type: 'text' }),
            localField('language', 'local.language', 'local.language.hint', { type: 'text' }),
            localField('key', 'local.key', 'local.key.hint', {
              type: 'password',
              autoComplete: 'off',
              placeholder: data.local.hasKey ? t('local.key.keep') : t('local.key.ph'),
            })),

          data.local.manage ? h('div', { className: 'sn_hint', style: { marginTop: '8px' } }, t('local.manage')) : null,
          data.local.envKeys && data.local.envKeys.length > 0
            ? h('div', { className: 'sn_box warn', style: { marginTop: '10px' } },
              `${t('local.env')}：${data.local.envKeys.join('、')}`)
            : null,

          localRejected.length > 0
            ? h('div', { className: 'sn_box bad', style: { marginTop: '10px' } },
              t('err.rejected'),
              h('ul', {}, localRejected.map((line, i) => h('li', { key: i }, line))))
            : null,

          h('div', { className: 'sn_row', style: { marginTop: '10px' } },
            h('button', { className: 'sn_btn', onClick: saveLocal, disabled: busy }, t('local.save')),
            localAt > 0 ? h('span', { className: 'sn_ok' }, t('state.savedLocal')) : null,
            localAt < 0 ? h('span', { className: 'sn_note' }, t('state.nosave')) : null),

          h('details', { className: 'sn_det', style: { marginTop: '10px' } },
            h('summary', {}, t('local.sample')),
            h('pre', { className: 'sn_pre' }, t('local.sample.body'))))
        : null;

      return h('div', { className: 'sn_root' },
        h('div', { className: 'sn_hero' },
          h('h2', { className: 'sn_title' }, t('title')),
          h('p', { className: 'sn_sub' }, t('sub')),
          h('div', { className: 'sn_mono' }, `${t('hint.path')}：${data.path}`)),

        data.warnings.length > 0
          ? h('div', { className: 'sn_box warn', role: 'status' },
            t('warn.title'),
            h('ul', {}, data.warnings.map((line, i) => h('li', { key: i }, line))))
          : null,

        h('div', { className: 'sn_box' }, t('hint.restart')),

        // ── 常用 ──
        h('div', { className: 'sn_card' },
          h('div', { className: 'sn_cardhd' }, h('span', { className: 'sn_cardname' }, t('sec.common'))),
          h('div', { className: 'sn_grid' },
            select('prefer', 'field.prefer', 'field.prefer.hint', [
              ['auto', t('prefer.auto')],
              ['host', t('prefer.host')],
              ['local', t('prefer.local')],
            ]),
            select('defaultPace', 'field.pace', 'field.pace.hint', [
              ['calm', t('pace.calm')],
              ['normal', t('pace.normal')],
              ['dense', t('pace.dense')],
              ['game-economic', t('pace.game-economic')],
            ]),
            select('wakeBatch', 'field.batch', 'field.batch.hint', [
              [1, t('batch.1')],
              [2, t('batch.2')],
              [3, t('batch.3')],
              [4, t('batch.4')],
            ]),
            field('idleStopMin', 'field.idleStop', 'field.idleStop.hint', { min: 0, max: 1440, step: 1 }),
            select('speechPacing', 'field.pacing', 'field.pacing.hint', [
              [true, t('pacing.follow')],
              ['guard', t('pacing.guard')],
              [false, t('pacing.off')],
            ]),
            field('silence', 'field.silence', 'field.silence.hint', { min: 0.15, max: 1.5, step: 0.05 }),
            field('maxSeg', 'field.maxSeg', 'field.maxSeg.hint', { min: 0.8, max: 15, step: 0.1 }))),

        localCard,

        // ── 高级 ──
        h('details', { className: 'sn_det sn_card' },
          h('summary', {}, t('sec.advanced')),
          h('div', { className: 'sn_grid', style: { marginTop: '12px' } },
            select('tierStyle', 'field.tierStyle', 'field.tierStyle.hint', [
              ['native', t('tier.native')],
              ['full', t('tier.full')],
              ['compact', t('tier.compact')],
              ['custom', t('tier.custom')],
              ['lock', t('tier.lock')],
            ]),
            draft.tierStyle === 'lock'
              ? select('tierLock', 'field.tierLock', 'field.tierLock.hint', [
                [1, '1 档 —— 一格占满'],
                [2, '2 档 —— 1/2 边'],
                [3, '3 档 —— 1/3 边'],
                [4, '4 档 —— 1/4 边'],
                [5, '5 档 —— 1/5 边'],
                [6, '6 档 —— 1/6 边'],
                [7, '7 档 —— 1/7 边'],
                [8, '8 档 —— 1/8 边'],
              ])
              : null,
            field('maxAutonomousWakes', 'field.wakes', 'field.wakes.hint', { min: 1, max: 200, step: 1 }),
            field('liveMin', 'field.liveMin', 'field.liveMin.hint', { min: 0.8, max: 6, step: 0.1 }),
            field('liveStep', 'field.liveStep', 'field.liveStep.hint', { min: 0.4, max: 4, step: 0.1 }),
            field('pollMs', 'field.pollMs', 'field.pollMs.hint', { min: 50, max: 1000, step: 10 })),

          /**
           * 选了「自定义」才展开这 8 个下拉。
           *
           * 左边是**算出来的档位**，右边选它实际落到哪一档 —— 不是"把第 i 格画多大"，
           * 是"这一档的帧应该长多大"。两者容易搞混，所以第一列写 `i →` 而不是"第 i 档"。
           */
          draft.tierStyle === 'custom'
            ? h('div', { className: 'sn_grid', style: { marginTop: '12px' } },
              h('span', { className: 'sn_label', style: { gridColumn: '1 / -1' } }, t('field.tierMap')),
              [0, 1, 2, 3, 4, 5, 6, 7].map((i) => h('label', { className: 'sn_field', key: `tm${i}` },
                h('span', { className: 'sn_label' }, `${i + 1} →`),
                h('select', {
                  className: 'sn_select',
                  value: String(draft.tierMap?.[i] ?? i + 1),
                  onChange: (e) => setTierMap(i, e.target.value),
                }, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { key: n, value: String(n) }, String(n)))))))
            : null,
          draft.tierStyle === 'custom'
            ? h('span', { className: 'sn_hint' }, t('field.tierMap.hint'))
            : null,
          h('label', { className: 'sn_check', style: { marginTop: '12px' } },
            h('input', {
              type: 'checkbox',
              checked: draft.live === true,
              onChange: e => set('live', e.target.checked),
            }),
            h('span', {}, t('field.live'))),
          h('span', { className: 'sn_hint' }, t('field.live.hint'))),

        // ── 保存 ──
        rejected.length > 0
          ? h('div', { className: 'sn_box bad', role: 'alert' },
            t('err.rejected'),
            h('ul', {}, rejected.map((line, i) => h('li', { key: i }, line))))
          : null,

        error !== ''
          ? h('div', { className: 'sn_box bad', role: 'alert' }, `${t('err.save')}：${error}`)
          : null,

        h('div', { className: 'sn_row' },
          h('button', { className: 'sn_btn primary', onClick: save, disabled: busy },
            busy ? t('state.saving') : t('state.save')),
          h('button', { className: 'sn_btn', onClick: load, disabled: busy }, t('state.reload')),
          savedAt > 0 ? h('span', { className: 'sn_ok', role: 'status' }, t('state.saved')) : null,
          savedAt < 0 ? h('span', { className: 'sn_note' }, t('state.nosave')) : null),

        h('div', { className: 'sn_note' }, t('hint.origin')));
    }

    // ── 接进 shell ────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', 'dsh-see-now');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-see-now: styles');

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'see-now',
        order: 43,
        label: () => t('nav'),
        locale: NS,
      }, () => h(SettingsPage)));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-see-now';
    exports.__test = { draftOf, mergeValues, patchOf, num, TEXT, localDraftOf, localPatchOf, shouldShowLocal };
    return module.exports;
  },
});
