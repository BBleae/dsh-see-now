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
      'state.nosave': '没有改动。',
      'sec.common': '常用',
      'sec.advanced': '高级（一般不用动）',
      'field.pace': '默认节奏',
      'field.pace.hint': '决定多长时间醒一次、一次说多少。理解为"话多话少"。',
      'pace.calm': '平缓 —— 很久才出声',
      'pace.normal': '正常 —— 默认',
      'pace.dense': '密集 —— 反应快，话也多',
      'pace.game-economic': '游戏省流 —— 只在动作明显时才看',
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
      const listen = {};
      for (const key of ['live', 'liveMin', 'liveStep', 'silence', 'maxSeg', 'pollMs']) {
        if (draft[key] !== values.listen[key]) listen[key] = key === 'live' ? draft[key] === true : num(draft[key]);
      }
      if (Object.keys(listen).length > 0) patch.listen = listen;
      return patch;
    }

    // ── 设置页 ────────────────────────────────────────────────────────────────
    function SettingsPage() {
      const [data, setData] = useState(null);
      const [draft, setDraft] = useState(null);
      const [error, setError] = useState('');
      const [rejected, setRejected] = useState([]);
      const [busy, setBusy] = useState(true);
      const [savedAt, setSavedAt] = useState(0);

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const next = await api('/status');
          setData(next);
          setDraft(draftOf(next.values));
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
            select('defaultPace', 'field.pace', 'field.pace.hint', [
              ['calm', t('pace.calm')],
              ['normal', t('pace.normal')],
              ['dense', t('pace.dense')],
              ['game-economic', t('pace.game-economic')],
            ]),
            field('idleStopMin', 'field.idleStop', 'field.idleStop.hint', { min: 0, max: 1440, step: 1 }),
            select('speechPacing', 'field.pacing', 'field.pacing.hint', [
              [true, t('pacing.follow')],
              ['guard', t('pacing.guard')],
              [false, t('pacing.off')],
            ]),
            field('silence', 'field.silence', 'field.silence.hint', { min: 0.15, max: 1.5, step: 0.05 }),
            field('maxSeg', 'field.maxSeg', 'field.maxSeg.hint', { min: 0.8, max: 15, step: 0.1 }))),

        // ── 高级 ──
        h('details', { className: 'sn_det sn_card' },
          h('summary', {}, t('sec.advanced')),
          h('div', { className: 'sn_grid', style: { marginTop: '12px' } },
            field('maxAutonomousWakes', 'field.wakes', 'field.wakes.hint', { min: 1, max: 200, step: 1 }),
            field('liveMin', 'field.liveMin', 'field.liveMin.hint', { min: 0.8, max: 6, step: 0.1 }),
            field('liveStep', 'field.liveStep', 'field.liveStep.hint', { min: 0.4, max: 4, step: 0.1 }),
            field('pollMs', 'field.pollMs', 'field.pollMs.hint', { min: 50, max: 1000, step: 10 })),
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
    exports.__test = { draftOf, mergeValues, patchOf, num, TEXT };
    return module.exports;
  },
});
