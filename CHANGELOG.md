# Changelog

本文件从 `0.0.4` 起记录；更早的版本见 GitHub Releases。

## [Unreleased]

### Added

- **按"上一句说了多长"排下一次叫醒**。固定间隔（calm 30s / normal 15s / dense 8s / 逐场景 4s）
  是从**叫醒那一刻**起算的，跟上一句说了多久没关系：上一句长的时候，下一轮会在它还在说时被叫起来。
  现在默认**跟随上一句**——下一轮最早落在「上一句说完 + 0.8 秒气口」，并保留 3 秒地板防连珠炮。
  想保持旧节奏写 `"speechPacing": "guard"`（取旧间隔与"说完+气口"更晚的那个），写 `false` 完全关掉。
  用户插话不受限制。时长按文本估（中文约 5 字/秒、英文约 14 字/秒，±20% 足够），
  不需要问 TTS 引擎要音频时长。有声音适配器时以 `spoken`（开始播放）为起点；
  没有声音时以 `due` 为起点，避免文字刷屏。`status` 的循环行会显示
  `上一句约 X.Xs` 和 `下一轮最早 Ns 后`。

## [0.0.10] - 2026-11-04

### Added — 它开始听得见了：视频里的台词跟画面一起交给模型

之前只看画面：视频里的人在说什么、旁白讲到哪，模型全靠猜。
`see_now` 返回的清单里现在多一段 `台词`，时间码和每帧那个 `24.1s` 是同一个坐标系，
模型能把"这句话"和"第几格画面"对上。

链路：`examples/floating-chat/listen.py`（WASAPI loopback → 16k 单声道 → 按静音断句
→ `seg-<epochMs>.wav`）→ Node 扫目录 → 宿主 `speechToText` 或 `~/.dsh/asr.json` 的
OpenAI 兼容服务 → 台词缓冲 → `runner.attachLines()` 挂到 sheet 上。

实测（i9-12900HX / Win11）：抓回环绕 **0.3% 单核**，转写 3 秒段 **130–160ms**、
10 秒段 400ms；按静音断句，一句话说完到文字可用约 1 秒。
对比画面侧 ddagrab 0.18 核 —— 音频是零头。

**三级降级，永远不会让"看屏幕"起不来**：宿主 `speechToText`（DSH 桌面版自带
SenseVoice，社区用户零安装）→ 本地 HTTP → 都没有就只出图不出字幕，
`status` 里写明原因（`听声音：没在听 —— …`）。关掉：`DSH_SEE_AUDIO=0`。

- **"只听"模式：循环收工之后，窗口里的输入不再扔进黑洞**。以前 idle 或连续叫不醒就
  `dispose()` 整条循环，可那扇窗还摆在屏幕上 —— 用户之后打的字没有任何人读，他当然
  以为自己在跟它说话。
  现在 idle 时先看窗还在不在（`idleAction()`）：窗开着就只停采集、**留着耳朵**（`mode: 'listen'`），
  窗没了才真收工。窗口里一开口立刻回到 active 唤醒模型。
  采集**不会**自动重启 —— 模型要看图会调 `peek`，那条路才按用户原来的 region / 清晰度起管道。
  为此加了 `pausedByListen` 标志：退出只听后的第一拍会看到 `!alive`，那本来是我们自己停的，
  没有标志就会被判成 `capture-stopped`，用户刚说一句话循环就整个收工。
  `status` 里也会显示「循环：只听（…）」。
- **缺 Python 包时打印安装命令**。窗口脚本要 Pillow / mss / numpy，缺任何一个都是
  "启动后 700ms 退出、code=1"，而插件以前只把 code 原样抛出去。现在启动全失败后会跑一次
  import 探测，把缺的包名和 `python -m pip install ...` 一起报出来。

- `test/pack.test.mjs`：四条排布测试（容差、flat 判据、缓存键、部分拉伸上限）。
  这套原来缺位 —— 三个新行为改回旧代码，138 条测试一条都不红。

### Changed

- `see_now` 返回的文本多一段台词，`status` 多一行「听声音」。
- `pipeline.js` 的帧多带一个 `wall`（epoch ms），sheet 多 `wallFrom` / `wallTo` ——
  台词只有时间码没有帧号，对齐只能靠同一个时钟（`t` 是"第几秒"，掉帧就漂）。

声音适配器和 `dsh-watch-together` **共用同一个模块**（`~/.dsh/voice.json` 只写一份），
所以那边把 `examples/voice-edge-tts` 换成常驻合成器之后，这里一起变快：

| 场景 | 之前 | 现在 |
|---|---|---|
| `say` 一句（`at: null`，没有预取窗口） | 2.4~2.5 秒 | **~230ms** |

`see_now` 的事件仍然发 `at: null` 的 `due` —— 它没有时间轴，本来也预取不了。
变快不是因为提前知道台词，是常驻进程省掉了"每句重付 python 启动 + import 建连 + ffplay 启动"
这四笔固定开销。协议和 `spoken` / `skipped` 的语义都没有变。




> 社区（Win10）报的 5 条。核心是**关窗后再也回不来**，以及**出了问题只给一个 exit code**。

- 跟 storyboard 0.6.6 对齐三个排布行为：`DEFAULT_STRETCH` 0.3、flat 判据改成 `(1+τ)²`、
  逐格部分拉伸。**实时性没受影响**：240 帧全流程 30.5 → 29.1ms（帧预算 83ms/帧），
  而且排布只在判"这张该封了"的时候跑一次，不是每帧。fill 77.3% → 83.8%，箱数 -5%。
- **画布仍是 800×450，没跟着对齐 42px**：本包的 `width` 同时是采集管道的 rawvideo 尺寸
  （ffmpeg 直接按它出帧），改它要动 scale / region / PNG 三处，收益只有每张 11 token。

### Fixed

- **手动重开悬浮窗之后仍然被"挂断"拦住，只能重启 DSH**。`hangUp()` 改的是本进程内存里的一个
  布尔值，而 `bin/see-window.mjs --force` 是**另一个 node 进程** —— 它只杀/重开 python 窗口，
  碰不到那个值。用户体感就是"窗明明回来了，它还说我把窗关掉了"。
  现在 `start()` 里会判断：挂断之后 **pid 文件被重写过**（= 有人主动开过窗）就解除挂断。
  判据刻意不用 `windowAlive()` —— 残留进程同样为真，那样会把窗重新弹出来（正是以前修过的问题）。
  新增 `resumeFromReopen()` 纯判据 + 4 条回归。
- **采集提前退出时看不出原因**。以前只有 `code !== 0 且 stderr 非空` 才算失败，`code === 0`
  会静默 resolve —— 上层看起来和"正常收工"一模一样。屏幕采集**不存在自然播完**，所以现在
  code 0 和非 0 一律报错，并且带上**运行时长与已收帧数**（12fps 下 141s/1686 帧说明是跑着跑着停的，
  不是启动就崩 —— 这正是区分"缺包秒退"和"中途掉线"的关键）。
- **`capture-stopped` 之后还在连发「有新画面了」，文案里「上一句 say N 秒前」的秒数越来越大**。
  `lastSaidNote()` 用 `Date.now()` 实时算，采集停了还在造新提词，那句当然是过期的。
  现在采集死后**只允许第一拍**把已经攒好的那张报出去，之后不再产生唤醒（队列里的图仍能 `peek` 到，不丢东西）。

- **`rowOptions` 缓存键只编码了 `stretch > 0.15` 这一个布尔**，0.2 和 0.3 共用同一份候选。
  改默认容差时踩到：先算 0.2 再算 0.3，后者拿到的是没有 flat 的候选，
  `[3,4,4,4,7,7,7,2,2]` 从 1 张装下变成 2 张。改成字符串键（档位|grow|stretch|fillRows）。

### 三个踩过的坑（都有回归）

- **静音段 WASAPI loopback 一个字节都不推**（实测 3 秒静音 callback 触发 0 次）。
  所以时间码只取每块到达的墙上时间，绝不累加样本数 —— 否则静音 10 秒后一开口，
  字幕整体漂 10 秒。另外**不能用阻塞 `stream.read()`**：静音时它会一直挂着
  （实测想读 4 秒、实际卡了 19 秒），断句判据根本没机会跑。改成回调 + 队列 + `tick()`。
- **立体声必须先混单声道再降采样**。`reshape(-1, 3).mean()` 一步做完会让两个声道
  相位抵消，ASR 只认出"嗯。"。正确顺序 `reshape(-1, ch).mean(1)` → 3 点箱式平均，
  纯 numpy 就够（不用 scipy / ffmpeg）。
- **它听得见自己**。TTS 念台词 → 音箱出声 → 回环收回去 → 变成"视频里的台词"，
  然后模型接着那句话往下聊，停不下来。

  修的时候才发现：**`quiet-until.json` 只有陪看在写**（`bin/watch.mjs` 拿它防两个 SAPI 抢话），
  see-now 从来没写过 —— 也就是说 `mic.py` 的 `tts_busy()` 在 see-now 下一直是空转。
  现在在 `say` 的 `due` 事件上挂了一个**只观察、不出声**的订阅者（`voice:false`，标 true 会顶高
  `speechSubscribers()`，展示层就会一直等一个不来的 `spoken`），按字数估一个保守窗口
  （中文 4 字/秒 × 1.5 余量 + 1.2 秒收尾）。**这是"闭嘴不听"，不是"屏蔽自己"** —— 窗口内整段丢弃，
  代价是用户正好在说话、或视频里正好有人说话时，那一段也没了。

  判据还必须按**段的时间窗**、不能按"落盘那一刻"：一句话跨过窗口末尾时，落盘时已经出窗口了，
  但它的前半段仍然是 AI 的声音 —— 实测窗口只剩 0.25 秒时，整段 6 秒被当成视频台词收了进去。

### 为什么是 pyaudiowpatch

`ffmpeg -f dshow` 在这台机器上枚举不到"立体声混音"（注册表里有、设备管理器也显示启用，
dshow 就是看不到）；`soundcard` 的 loopback 两个端点、四组采样率**恒返回 0**；
`sounddevice`（PortAudio 原生）的 WASAPI host API 里**根本没有 loopback 设备**
—— 官方 PortAudio 不暴露，只有 pyaudiowpatch 那个 fork 打了补丁。它也不需要虚拟声卡。
缺这个包就静默降级，`status` 里会说缺什么。

## [0.0.9] - 2026-11-03

> 自选一块屏幕给它看（框一下就行，不用报坐标）；接社区三条反馈：
> 抓屏失败不再变透明玻璃、对话记全、语音模型可以自定义。

### Added — 自选区域（`action:"region"`）

`region:"x,y,w,h"` 是 PR #9 加的，但**谁来量这四个数**没人管：让用户去截图软件里读像素
不现实，让模型猜更不行。现在补上交互那一半：

- `see_now({action:"region"})` 起一个全屏取框窗（`pick_region.py`，和悬浮窗共用同一个
  带 tkinter 的 python），屏幕变暗 → 拖一个框 → 松手，坐标自动落盘
- 落盘在 `~/.dsh/see-now/region.json`，之后每轮 `watch` **默认就用它** ——
  模型不用记数字，用户也不用每次再说一遍
- `region:"off"` 取消，回到整屏（顺手修了撤回不生效：原来"一边有一边没有"不触发重开，
  用户点了取消画面还在抓那一小块）
- 取框前声明 per-monitor v2 DPI 感知：Tk 的坐标是逻辑像素，150% 缩放下拿去做
  `-offset_x` 会偏（和 `window.py` 同一个坑）
- 只支持主屏：虚拟桌面起点可能是负坐标，Tk 的 `+x+y` 表达不了，gdigrab 也不接受负
  offset —— 与其给一个错的矩形，不如明确说"请在主屏里框"
- **能力边界要说清**：抓的是屏幕上正在显示的像素，被别的窗口挡住就只看到挡住它的东西；
  没接 OBS，抓不到后台 / 最小化窗口（这条写进了工具描述，模型会如实转述）

### Fixed — 悬浮窗被藏起来之后没有任何办法叫回来

`hidden` 是 `~/.dsh/watch-window.json` 里的**粘性**状态，由窗口进程每 250ms 读一次。
用户点过一次「藏起来」之后，下一次 `watch` 开出来的窗**带着 `hidden:true` 启动**：
进程活着、心跳在跳、日志一行不报，但屏幕上什么都没有。工具以前完全不碰这个文件，
也没有「显示」这条 action —— 模型只能去读配置，又没有写权限，于是答
"我这边只有读权限，发不了「显示」指令"（2026-11-03 社区反馈原话）。

- 新 action `see_now({action:"window", show:true|false})`：不传 `show` 只报状态；
  改的是窗口进程轮询的那份文件，**不用重启窗口**，一拍（250ms）生效；
- `watch` / `peek` / `start` 开出一个**新**进程时自动清掉 `hidden`（`already` 时不动 ——
  那是用户自己开着的窗，可能正故意藏着）；
- `watch` 的结果、`status` 都带上 `窗口：进程 N 活着 · 心跳 0s 前 · 藏起来的（用户看不见）`；
  藏着时 `watch` 会明说「用户看不到你的 `say`」并给出那条指令。

### Fixed — 抓屏失败时窗变成一块透明玻璃

BitBlt 会在锁屏 / UAC 安全桌面 / 远程桌面 / 某些 HDR 或全屏独占的机器上失败。
以前 `grab()` 把异常直接抛给渲染线程：每帧一条 `capture error`，一帧都画不出来，
窗口只剩文字浮在桌面上 ——「背景不知道为什么变成透明的了」（2026-11-03 社区反馈）。

- 抓不到就返回一块**纯色底板**的替身截图（同尺寸复用，不每帧分配），
  模糊 / 透镜 / 圆角 / 文字全都不受影响；
- 替身同时给 `.rgb`（CPU）和 `.bgra`（GPU）：只给 rgb 的话 `DSH_GLASS_GPU=1` 的机器
  会每帧在 GPU 路径 `AttributeError`；
- 失败日志 30 秒最多一条（每帧刷屏等于没有日志）。

### Fixed — 对话现在记全了

小窗原来只有 `say` 气泡和用户自己打的字，模型正常回的话一句都不在里面，
于是它只好跟用户解释"我们的对话不会记录在窗口"。现在每轮的**正文**也会追加进
`chat.jsonl`（不朗读 —— 只有 `say` 会念），并且：窗没开着不写、`say` 已经进过窗的跳过
（避免同一句出现两遍）、超长截到 600 字。工具描述里那句"你的正文永远不会到窗里"
也改掉了，模型不会再说反话。

### Added — 语音模型可以自定义（`voice.json` 的 `options`）

核心仍然不内置任何引擎，但以前除了"用哪个适配器"没有任何透传入口，适配器只能把模型
路径写死在自己代码里 —— 用户换一个自己训的模型就得改别人的源码（2026-11-03 社区反馈）。
现在：

```json
// ~/.dsh/voice.json
{ "adapter": "D:/my-voice/index.mjs", "options": { "model": "D:/my/models/xxx" } }
```

`options` 原样交给 `attach(api, options)`，并计入挂载指纹（改了就重挂，不用重启）。
老适配器不受影响：它们本来就只接一个参数。

### Fixed — 加载失败只写进 logger，用户那一侧完全无声

`apply()` 以前把异常吞成一行 `logger.error`（只在开发者工具里）。用户看到的现象是
"这个会话里根本没有 `see_now`" —— 模型只能靠读文件猜，还把猜出来的调用当正文吐出来。
现在同一份错误追加到 `~/.dsh/see-now/plugin-error.log`（超 64KB 自动截断），
注册成功也打一行 `已注册工具 see_now（v0.0.9）`：空日志 + 有注册行 = 插件没问题，
找宿主/沙箱；有错误行 = 看堆栈。装了两份时只记一行并**整份退出**，不留两套常驻循环
各叫一次模型。

### Changed — `install-dev.mjs --check` 报版本对账

以前只说"已安装 / 已注册"，装的是哪一版要靠自己翻文件。现在直接对：

```
源码版本  : 0.0.9
副本版本  : 0.0.3  ⚠️ 和源码不一致（跑的是旧代码）
  ⚠️ 副本里 dsh.plugin.json 写的是 0.0.2 —— 和 package.json 不一致
→ 跑 `node scripts/install-dev.mjs` 同步，然后**重启 DSH Desktop**。
  （新开一个会话不够：插件树是进程启动时组合的，已加载的代码不会换。）
```

### Tests

135 条通过（新增 `region-file` 5 条、`visibility` 5 条、`picker` 1 条；
`picker` 默认 skip —— 它会真的闪一个全屏罩子，`DSH_PICK_SELFTEST=1` 才跑）。

## [0.0.8] - 2026-11-03

> 跟上上游的悬浮窗重构：窗口从一个 1931 行的单文件拆成五层。

### Changed — 同步 `dsh-watch-together` 0.2.11 的窗口

`examples/floating-chat/` 是 `scripts/sync-window.mjs` 从上游生成的产物，这次跟着更新：

- `window.py` 1931 → 1218 行，玻璃拆成 `glass_geometry`（不可变 `Geometry`）/
  `glass_capture`（抓屏 + 运动判定，CPU/GPU 共用）/ `glass_cpu` / `glass_gpu` /
  `window_widgets`；
- GPU 路径修了三个真 bug：OpenGL context 建在主线程（每帧 `cannot create texture`）、
  录屏模式没挖掉自己（永不跳帧）、`DSH_GLASS_NATIVE=1` 是假开关。
  这台机器上实测 87.9% → 32.1% 单核；
- `capturable` 模式下桌面图标被沿上下 / 左右拉成条的问题修掉了（填充只用窗口外
  四角的中位色，不再沿边缘插值）。

细节见 `dsh-watch-together` 的 CHANGELOG 0.2.11。

### Fixed — 同步脚本会漏掉拆分后的玻璃模块

`scripts/sync-window.mjs` 原来只拷 `window.py` + `mic.py` + `window_protocol.py` +
`mic-dsh.png`。上游拆包之后，只装了 see-now 的机器会直接崩在
`ModuleNotFoundError: glass_geometry` —— 而且开发机上永远复现不了（兄弟仓库里
那几个文件一直都在）。ASSETS 补上 `glass_*.py` / `window_widgets.py`。

### Fixed — 包内窗口的守卫用「单文件大小」当代理，拆包后变成假失败

`test/packaged-window.test.mjs` 原来断言 `window.py` 大于 50000 字符。拆包后它从
78KB 掉到 43KB，这条直接红。而且它本来就没守住真正的问题（漏一个模块照样发得出去）。
改成逐文件存在性 + 单文件非空 + 总量 > 90k。

## [0.0.7] - 2026-11-03

### Fixed — 心跳抖一下就被当成"用户关窗"，会话再也回不来

社区 1 例反馈"会话自己结束了"。链路是：窗口心跳 6 秒没更新（机器睡一觉醒来、
窗口主线程被拖住几秒）→ `windowAlive()` 判否 → 常驻循环**第一拍**就
`stop('window-closed')` → 落挂断说明（"用户关掉了窗……不要再调 see_now"）+ `hangUp()`
→ 之后 `watch` 一律被硬闸拦，这个会话只能重开。

根因是**一个判据回答了两个问题**：`windowAlive()` 的语义是"这窗还能不能用"
（过期就该重开），而循环要的是"用户是不是不看了"。现在分开：

- 新增 `windowPidAlive()`：只看进程在不在，不看心跳。
- 新增纯函数 `windowVerdict()`：进程没了才算 `closed`（照旧挂断）；
  进程还在、只是心跳断了算 `stalled`，连续 `WINDOW_GONE_TICKS`（3 拍 = 6 秒）才停，
  而且**不挂断** —— 下一条 `watch` 能自己把窗重开起来。
- 停因照旧能从 `see_now({action:"status"})` 的 `循环：已停（…）` 看到，
  现在多了 `window-stalled` 这个值，正好用来区分"用户关的"和"它自己卡了"。

回归：`test/heartbeat.test.mjs`。

## [0.0.6] - 2026-11-02

> 主题：**macOS 能用**（avfoundation 移植），外加 issue #1 / #2 / #3 一起收掉。
> macOS 与声音适配器那两块来自 **布丁** 的补丁（`macos-port.patch`，13 文件 / +735−35）。

### Added — `avfoundation` 屏幕/摄像头源

- 屏幕：`-f avfoundation -framerate 12 -pixel_format nv12 -capture_cursor 0 -i "Capture screen 0:none"`。
  音频写 `none`，否则某些系统会去开麦克风、多弹一次权限。
- 摄像头 / OBS 虚拟摄像头：同样走 avfoundation，`-i "<设备名或索引>:none"`。
- 局部裁剪：avfoundation 没有 gdigrab 的 `-video_size`，改在滤镜里 `crop`（坐标按采集分辨率算）。
- `pickScreenEngine()` 按平台分派：macOS 探 avfoundation、Windows 探 ddagrab、其它平台**明确报错**，
  不再假装能用。

### Added — 像素格式探针

屏幕输入**不支持** ffmpeg 默认的 `yuv420p`，每个进程都会刷一行 "not supported" 到 stderr
（真出错时被截断的 300 字里全是它）。现在探针按 CPU 从省到费试
`nv12` → `uyvy422` → `bgr0` → 设备默认，挑第一个真能出帧的并缓存。

### Added — `binaries.js`：自己找 ffmpeg

DSH 桌面版把 ffmpeg 放在 `~/.dsh/tools/ffmpeg/bin`，**不进 PATH**。原来写死裸 `'ffmpeg'`，
在 macOS 上就是 ENOENT，而且看起来像"插件坏了"。现在按
`DSH_FFMPEG_PATH` → `FFMPEG_PATH` → `DSH_FFMPEG_DIR` → `$DSH_HOME/tools/ffmpeg/bin` → `$DSH_HOME/bin` → PATH 找。

### Added — 屏幕录制权限提示

macOS 没给「屏幕录制」权限时 ffmpeg **不报错**：exit 0、帧数正常、画面全黑。
探针算平均像素，全黑就在 `start` 的返回里带一句去系统设置的提示。

### Fixed — 每次 `stop` 都往 `lastError` 里写一条假错误

`stop()` 是 SIGKILL，子进程 `code` 是 `null`。原来的判断 `err.trim() && code !== 0`
把"我们主动杀的"也算成失败 —— 只要 stderr 有过任何一行输出（macOS 上就有），
每次收工都会盖一条 `ffmpeg exit null`。现在 `code === null` 一律按正常收尾处理。

### Fixed — 测试改成了平台无关

原来的采集参数断言全是 Windows 引擎行为，在 Mac 上跑会走 avfoundation 分支。
现在显式传 `platform`，并补了 macOS 屏幕/摄像头/裁剪三条和"其它平台明确报错"一条。
#### Added — 声音适配器（macOS / `say`）

`examples/voice-say-mac.mjs`：把「该念了」翻译成一次 `say`，音色语速读 `~/.dsh/tts.json`
（和 `dsh-watch-together` 共用）。核心仍然不内置引擎，只认 `~/.dsh/voice.json` 里的
`adapter` 路径。

三条实现上的决定：**不排队**（正在念时新句子直接 `skipped` —— 等它念完，画面早就过去了）、
**`spoken` 在进程起来那一刻发**（展示层"字跟着声音走"）、**detach 要杀进程**
（关窗时正在念的那句必须立刻停）。

#### Added — `ensureConfiguredVoice()`：每次调用前检查一次

原来只在插件启动时读一次 `~/.dsh/voice.json`，于是「配置文件是插件启动之后才写的」这种情况
必须重启整个 DSH。现在工具入口每次都过一遍：

- 没配 → 什么都不做；
- 配了指纹没变 → 一次读文件的代价就返回；
- 指纹变了（换了适配器，或改了 `tts.json` 内容）→ 卸载重挂。

指纹用 `tts.json` 的**内容摘要**而不是 mtime：mtime 只到毫秒，同一毫秒内两次等长写入会被判成
"没变"—— 写这个的单测里当场踩到，改成 sha256 前 16 位。代价是这个几十字节的文件每轮读一次。


### Fixed — 持续陪看链路（#1）

- **`peek` 不再丢弃已拼好的图**：它原来走 `flushNow()`（插话专用），会把 `sheets` 清空、
  再把"此刻那一帧"塞成一张新图 —— 后台喊"有新画面了"、模型调 peek，拿到的是当场截的一张，
  攒好的多帧摘要反而没了（复现：`queued [0,2,4]` → `[5.92]`、`pending 0`）。现在走 `take()`，
  取一张少一张；队列空就返回 `null`，不再凭空造图。
- **循环 owner 在 watch 开始前锁定**：`watch` 阻塞 15~40 秒，期间任何会话的 `session/event`
  都会改写 `lastSessionId`；循环是等它返回才建的，现取就会绑到"等待期间最后说话的那个会话"
  （复现：A 发起 watch，结束后 `loop.session === B`）。
- **`minFrames` 在正常返回路径也生效**：以前只有超时分支检查，队列先到的路会交一张 1 帧的图
  还报 `ok: true`。现在不够就丢掉接着等。顺带理清"逐帧模式 × minFrames"：逐帧一张图只有 1 帧，
  `minFrames > 1` 永远等不满，会让路并说明。

### Fixed — 悬浮窗可用性（#2）

- **关窗后能自己重开**：新增 `bin/see-window.mjs`（`npx dsh-see-window`，支持 `--status` /
  `--force` / `--close`）。原来只有模型调 `watch` 才能拉起来，点了 × 就只能重启 DSH。
- **高 DPI 下窗口不再变小**：进程声明了 per-monitor v2 DPI 感知，Tk 坐标因此全是物理像素 ——
  150% 屏上摆 760×560 观感只有 506×373。现在默认尺寸按 `GetDpiForSystem()/96` 放大，
  字号同步走 `tk scaling`。用户已有的 `geometry` 配置仍然优先，不会被强行改大。
- **spawn 失败不再"假成功"**：窗口每秒写一个心跳文件，`windowAlive()` 除了 pid 还会看它 ——
  pid 被复用、进程活着但界面卡死、或是一张全透明的空窗，都会判死，于是下次能重开。
  `--force` 现在真的会先收掉旧进程（原来会叠两个窗）。没有心跳文件的旧窗口不误杀。

### Changed — 安装方式规范化（#3）

README 的主路径改成 `dsh plugin --profile web add dsh-see-now`（DSH 自带的 profile 级 pnpm
包装器，装前预检 engines/peer、装后自动登记 `dsh.bundle`），`install-dev.mjs` 收进
"从源码装（改代码时用）"折叠块。

## [0.0.5] - 2026-11-02

`examples/floating-chat/window.py` 同步上游 `dsh-watch-together` **0.2.4**（生成产物，
`npm run sync:window` 自动更新）。0.0.4 带出去的那份窗口有两个问题，这个版本一起修掉：

### Fixed — 气泡里的字一直黑白闪

字色是按背景亮度选的（气泡透明，背后就是桌面/视频）。原来每 0.12 秒按
`p50 < 0.50` 硬切白/深两色，画面一动亮度就在阈值附近来回穿，字一秒能翻七八次。
现在改成**滞回**（白的暗到 0.38 才翻深、深的亮到 0.62 才翻白）+ **连续两次同向才切**，
同样 16 次抖动从翻 15 次降到 0 次。顶部细条同样处理。

### Changed — 玻璃合成与气泡布局（上游 PR #28）

- 小框（气泡/输入框）边缘改用 blur 1.45 的帧做 smoothstep 过渡，不再二值硬切。
- CPU 管线补齐外缘 R/B 色散与上一帧运动混合（原来只有 GPU 有）；移动帧跳过色散，
  拖动/滚动响应更快。
- 消息气泡改成按正文实测的自适应宽高，时间戳移到气泡上方不再占框内空间。
- 麦克风回到玻璃帧合成（`MIC_POS`），不再在 Canvas 上单独建图。

## [0.0.4] - 2026-11-02

> 主题两件：**协议换成 Apache-2.0**，以及**常驻循环学会自己收工**。

### License — 改成 Apache-2.0

- `PolyForm-Noncommercial-1.0.0` → **`Apache-2.0`**。个人、公司内部、闭源产品、SaaS、
  二次分发都不需要授权、不收费，保留 `LICENSE` 与 `NOTICE` 即可。
- **删掉 `CLA.md` 与 `COMMERCIAL.md`**：Apache-2.0 下不需要贡献者签 CLA，
  也没有"商业授权"这回事了。`package.json` 的 `files` 同步移除这两个文件。
- `NOTICE` 重写：标准 Apache 声明 + 保留原来那份"这个项目**不做什么**"（不上传屏幕、
  不连续录制、不内置采集驱动、不内置 TTS 引擎）。
- `README` 的「授权说明」与「协议」两节、`CONTRIBUTING.md` 第一节、PR 模板里的 CLA 勾选项
  全部同步；`examples/floating-chat/` 不再需要"单独 Apache"的例外说明 —— 整个包同一个协议。
- README 挂上**赞赏码**（`docs/images/reward-qr.png`）：纯自愿，**不解锁任何功能**，
  也不影响以后的授权方式。

### Fixed — 常驻循环不再"卡读图循环"

社区实报：装上之后会话会一轮一轮读图，用户什么都没问也不停。根因是常驻循环
**只有"采集停了"一个退出条件** —— 屏幕一直在动（放视频、刷网页）就会每 `wakeMinGapSec`
叫醒模型一次、模型看一眼图回一句、下一张再叫一次，永远不停，而且每次都是一轮模型调用。

- 新增 `shouldGoIdle()`，两条收工线互为兜底：
  - `IDLE_STOP_MS`（3 分钟）：**没开悬浮窗**且用户超过 3 分钟没说话 → 停。
    悬浮窗开着就不按这条判 —— 那是陪看场景，两小时的电影中途不说话是正常的。
  - `MAX_AUTONOMOUS_WAKES`（8 次）：连续自动唤醒都没人搭理 → 停，窗开着也算
    （防"窗开着但人走了"）。
  - 用户一说话，计数与时间戳都重置。
- 收工不是"突然哑掉"：会在窗口里留一行灰字（`（有一阵没人说话了，我先停一停；要看再说一声。）`），
  且不朗读。
- `test/idle.test.mjs` 三条用例钉住：上限到就停、没窗+久不说话就停、窗开着不按时间判。

### Changed — 悬浮窗同步到 `dsh-watch-together` 0.2.3

`examples/floating-chat/window.py` 是**生成产物**（`npm run sync:window` / `prepack` 自动同步），
这次带上游 0.2.3 的一整轮窗口修复：

- 气泡改成「时间头 + 两行正文」，88px 统一高度，超长按框高折行/截断，标点不落行首。
- 折叠不再重建整窗几何（原来会在 `rounded_mask` 抛 `y1 must be >= y0`）；折叠不跳回原位、
  折叠背景有圆角、配置存展开高度。
- 每 1.8 秒重新置顶一次，DSH 抢焦点后浮窗不再被压下去。
- 拖动/缩放越界钳位，抓屏前挡掉非正尺寸（`Region has zero or negative size` 每帧刷日志、
  背景永久花不了）。
- snapshot 模式不再被 `_tick` 重新打开 WDA；`window` 接口 hide/show 兼容只返回布尔的实现。
- 麦克风改 Canvas 矢量图标，不再往合成帧上贴第二层。

### Fixed — 版本号漂移

`dsh.plugin.json` 还写着 `0.0.2`，与 `package.json` 的 `0.0.3` 不一致。这次一起对齐到 `0.0.4`
（宿主按 `dsh.plugin.json` 认版本，漂着会让"装了新版但页面显示旧版"）。

## [0.0.3] - 2026-11-01

首个公开版本：让 AI 实时看见屏幕 —— 按画面变化量筛帧、拼成一张图推进会话。
