# Live shopping sample (2026-11-04)

本轮用来验证「连续带货里的大手/产品前景」的真实长流样本，不提交进仓库。

## 来源

- 平台：B 站直播
- 房间：https://live.bilibili.com/6340667
- 标题：也木西翡翠曼德勒开播啦
- 录制：2026-11-04，180s，720x1280，H.264 + AAC
- 本地文件：`D:\DSHwork\bili-live-shop-180.flv`（约 21.7 MB，不提交）

直播 URL 会过期，只记录房间；需要重录时用同一房间重新取流。

## 重录

```powershell
$url = (yt-dlp --no-warnings -f 'best[height<=720]/best' -g 'https://live.bilibili.com/6340667' | Select-Object -First 1)
& 'D:/deepseek-harness-dsh-v0.2.1rc2/.dsh-home/bin/ffmpeg.exe' -y -loglevel error -i $url -t 180 -c copy 'D:\DSHwork\bili-live-shop-180.flv'
```

## 检测结果

旧逻辑（关背景/未来帧守卫）6 刀：

```text
2, 2.42, 59.83, 97.5, 109.33, 121.83
```

当前逻辑 2 刀：

```text
2, 2.42
```

被挡掉的 4 个点都在同一段连续展示里，画面是同一张饰品托盘 + 手拿起/放下产品；
94–114s 的分镜可确认没有换镜头（见 PR #15 的截图/分镜说明）。

## 覆盖到的守卫

- 59.83：手从上方进入，背景稳定，低分背景守卫；
- 97.5：手/产品盖到画面外圈，分数 28.5、`bg=145`、稳定背景仅 270 格；
  低分未来帧确认（`keep=198 < cutFutureLowKeep=210`，余量 12）；
- 109.33：手持产品靠近，分数 18、`bg=45`、`keep=47`，同上；
- 121.83：手离开，低分背景守卫。

## 强灯光样本（第二个直播）

- 平台：B 站直播
- 房间：https://live.bilibili.com/23202464
- 标题：Akko 键盘盲盒
- 录制：2026-11-04，60s，720x1280，强棚灯 + 大字贴片 + 主播手持产品
- 本地文件：`D:\DSHwork\bili-live-key-60.flv`（约 9.9 MB，不提交）

重录命令把房间和时间换掉即可：

```powershell
$url = (yt-dlp --no-warnings -f 'best[height<=720]/best' -g 'https://live.bilibili.com/23202464' | Select-Object -First 1)
& 'D:/deepseek-harness-dsh-v0.2.1rc2/.dsh-home/bin/ffmpeg.exe' -y -loglevel error -i $url -t 60 -c copy 'D:\DSHwork\bili-live-key-60.flv'
```

结果：基线和当前都是 **0 刀**（主播持续展示，没有换镜头）。

又录了同一房间 300s（`bili-live-key-300b.flv`，约 27.5 MB）和暴雪旗舰店 120s
（`bili-live-blizzard-120.flv`，约 14.2 MB）：两段都是 0 刀，仍没有换镜头。

强灯光下的**真切点**由 `makeup-demo.webm`（180s，9 刀）覆盖；这段不是直播间，
但确实是高亮近景演示，当前守卫没有改它的刀数。

## 边界

- 3 分钟带货 + 60 秒强灯光，仍不是完整直播；更长流、不同主播/机位还要样本。
- 强灯光样本没有出现换镜头，不能证明它对真切点不误挡。
- 低分未来帧确认只对「外圈也被改掉 + 稳定背景少 + bg < 160」的候选启用，
  避免像烹饪/开箱/宽银幕那样把静态外框的真切点一起挡掉。
