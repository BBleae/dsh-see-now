#!/usr/bin/env python3
"""
portal_stream.py — Linux（KDE/GNOME Wayland 与 X11 均可）屏幕采集 worker。

流程：xdg-desktop-portal ScreenCast 握手（一次）→ pipewiresrc 连续收流
      → 限帧 / 缩放 / 转 rgb24 → 写到 stdout（每帧 width*height*3 字节）。

stdout 只放帧；日志和握手结果都走 stderr。
stderr 第一行是 JSON：{"ready":true,"node":85,"fps":12,...}，父进程靠它知道
帧长和帧率，之后按固定长度切流即可。

退出码约定（父进程 portal-capture.js 按它分类报错）：
  0  被父进程正常停止（SIGTERM / 父进程死掉）
  1  依赖缺失（python3-gi / gstreamer / gst-plugin-pipewire）
  2  用户取消或拒绝了选屏授权
  3  流中断（gst 自己退出：用户点了"停止共享"、显示器休眠、KWin 重启）
  4  portal 握手失败 / 超时

授权：首次运行桌面会弹一次选屏框；返回的 restore_token 存在
~/.dsh/see-now/portal-token.json，之后不再弹。
"""

import argparse
import json
import os
import random
import select
import signal
import string
import subprocess
import sys

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"
TOKEN_PATH = os.path.expanduser("~/.dsh/see-now/portal-token.json")

SOURCE_MONITOR = 1        # SelectSources types: 1 = 整个显示器
CURSOR_HIDDEN = 1         # cursor_mode: 1 = 不画光标
PERSIST_PERMANENT = 2     # persist_mode: 2 = 授权永久保留（配合 restore_token）


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fail(code, msg):
    log(f"[portal] ERROR {msg}")
    sys.exit(code)


def token(prefix):
    """portal 的 handle_token 必须是合法 object path 片段。"""
    tail = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefix}_{tail}"


def die_with_parent():
    """父进程（node）没了就跟着退出，避免留下孤儿 gst / portal 会话。"""
    try:
        import ctypes
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, signal.SIGKILL)      # PR_SET_PDEATHSIG = 1
    except Exception:
        pass
    if os.getppid() == 1:
        sys.exit(0)


def load_token():
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh).get("restore_token")
    except (OSError, ValueError):
        return None


def save_token(value):
    if not value:
        return
    try:
        os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
        with open(TOKEN_PATH, "w", encoding="utf-8") as fh:
            json.dump({"restore_token": value}, fh)
        os.chmod(TOKEN_PATH, 0o600)
    except OSError as e:
        # 存不下只是"下次还要再弹一次框"，不该让采集失败
        log(f"[portal] 保存 restore_token 失败: {e}")


class Portal:
    def __init__(self, GLib, Gio):
        self.GLib = GLib
        self.Gio = Gio
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.loop = GLib.MainLoop()

    def call(self, method, params, timeout=300):
        """调一个返回 (o) request handle 的 portal 方法，阻塞等 Response 信号。"""
        GLib, Gio = self.GLib, self.Gio
        req_token = token(method.lower())
        path = f"/org/freedesktop/portal/desktop/request/{self.sender}/{req_token}"
        box = {"done": False, "code": None, "results": None, "error": None}

        def on_response(_conn, _sender, _obj, _iface, _sig, prm):
            code, results = prm.unpack()
            box.update(done=True, code=code, results=results)
            self.loop.quit()

        sub = self.bus.signal_subscribe(
            PORTAL, "org.freedesktop.portal.Request", "Response", path, None,
            Gio.DBusSignalFlags.NO_MATCH_RULE, on_response,
        )

        def on_timeout():
            box["error"] = "timeout"
            self.loop.quit()
            return False

        timer = GLib.timeout_add_seconds(timeout, on_timeout)
        try:
            ret = self.bus.call_sync(
                PORTAL, PORTAL_PATH, SCREENCAST, method, params,
                GLib.VariantType.new("(o)"), Gio.DBusCallFlags.NONE, -1, None,
            )
            returned = ret.unpack()[0]
        except GLib.Error as e:
            self.bus.signal_unsubscribe(sub)
            GLib.source_remove(timer)
            fail(4, f"{method} 调用失败: {e.message}")

        # 有的 portal 会改写 request handle：以返回值为准重新订阅
        if returned != path:
            self.bus.signal_unsubscribe(sub)
            sub = self.bus.signal_subscribe(
                PORTAL, "org.freedesktop.portal.Request", "Response", returned, None,
                Gio.DBusSignalFlags.NO_MATCH_RULE, on_response,
            )
        self.loop.run()
        # 超时那条路是 on_timeout 自己把 source 移除的，这里再删会刷一条 GLib 警告
        if not box["error"]:
            GLib.source_remove(timer)
        self.bus.signal_unsubscribe(sub)

        if box["error"]:
            fail(4, f"{method} 超时（{timeout}s）：portal 没有响应 —— "
                    "多半是没有图形会话（在 SSH / 服务器里跑），或者桌面后端没起。")
        if box["code"] != 0:
            # code 1 = 用户取消，2 = 其它失败
            fail(2 if box["code"] == 1 else 4, f"{method} 被拒绝（Response code={box['code']}）")
        return box["results"] or {}


def close_session(p, session):
    """尽力关掉 portal 会话（org.freedesktop.portal.Session.Close）。

    不关的话 GNOME 的 portal 会把会话留在表里，后续 CreateSession 可能一直不返回。
    失败无所谓：进程退出时 D-Bus 连接断开，大多数实现也会回收。
    """
    try:
        p.bus.call_sync(
            PORTAL, str(session), "org.freedesktop.portal.Session", "Close", None,
            p.GLib.VariantType.new("()"), p.Gio.DBusCallFlags.NONE, 2000, None,
        )
        log("[portal] 会话已关闭")
    except Exception as e:      # noqa: BLE001 —— 关不掉不能影响退出
        log(f"[portal] 关闭会话失败（忽略）：{e}")


def check_deps():
    try:
        import gi
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib
    except Exception as e:
        log(f"[portal] python3-gi 不可用: {e}")
        fail(1, "缺 python-gobject（pacman -S python-gobject）")
    try:
        out = subprocess.run(
            ["gst-inspect-1.0", "pipewiresrc"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        )
        if out.returncode != 0:
            fail(1, "gst 里没有 pipewiresrc（pacman -S gst-plugin-pipewire）")
    except FileNotFoundError:
        fail(1, "找不到 gst-inspect-1.0（pacman -S gstreamer）")
    except subprocess.TimeoutExpired:
        fail(1, "gst-inspect-1.0 无响应（gstreamer 装坏了吗）")
    return Gio, GLib


def main():
    die_with_parent()
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--width", type=int, default=798)
    ap.add_argument("--height", type=int, default=450)
    ap.add_argument("--mode", choices=["screencast"], default="screencast",
                    help="预留：screenshot 回退模式在 M2 加")
    # 指示框裁剪：给**逻辑**尺寸和逻辑像素的边宽，设备像素的换算由 gst 在管线里做。
    # （Qt 报的 dpr 不可靠：这台机器上 125% 缩放它报 2.0，按 dpr 算会裁掉一大块。）
    ap.add_argument("--logical-width", type=int, default=0)
    ap.add_argument("--logical-height", type=int, default=0)
    ap.add_argument("--edge", type=int, default=0)
    ap.add_argument("--top-band", type=int, default=0)
    # 只看一块：坐标是**采集流的坐标系**（逻辑像素，KDE 上等于 Qt 报的屏幕尺寸）。
    # 例："100,80,900,600"；空 = 整屏。越界直接报错，不静默裁成别的区域。
    ap.add_argument("--region", default="")
    # 静止画面下多久重发一次最后一帧（毫秒）。太小费 CPU，太大帧率上不去。
    ap.add_argument("--keepalive", type=int, default=250)
    ap.add_argument("--handshake-timeout", type=int, default=300)
    args = ap.parse_args()

    Gio, GLib = check_deps()
    p = Portal(GLib, Gio)

    # 先确认这台机器真的有 xdg-desktop-portal（+ ScreenCast 后端）。
    # 没有的话 CreateSession 会拿到一个"永远收不到 Response"的请求，
    # 用户看到的就是三行 "[portal] CreateSession/SelectSources/Start …" 之后一直等 ——
    # 在无桌面的服务器/容器里很容易踩到。宁可立刻说清楚。
    try:
        names = p.bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "ListNames", None, GLib.VariantType.new("(as)"), Gio.DBusCallFlags.NONE, 3000, None,
        ).unpack()[0]
    except GLib.Error as e:
        fail(1, f"连不上会话总线（没有桌面会话？）：{e.message}")
    if PORTAL not in names:
        fail(1, "没有 xdg-desktop-portal：这是无桌面环境（服务器/容器），屏幕采集用不了。"
                "需要装 xdg-desktop-portal + 对应桌面后端（KDE: xdg-desktop-portal-kde，"
                "GNOME: xdg-desktop-portal-gnome），并且要在图形会话里运行。")

    log("[portal] CreateSession …")
    res = p.call(
        "CreateSession",
        GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", token("cs")),
            "session_handle_token": GLib.Variant("s", token("sess")),
        },)),
        timeout=15,
    )
    session = res["session_handle"]

    opts = {
        "handle_token": GLib.Variant("s", token("ss")),
        "types": GLib.Variant("u", SOURCE_MONITOR),
        "multiple": GLib.Variant("b", False),
        "cursor_mode": GLib.Variant("u", CURSOR_HIDDEN),
        "persist_mode": GLib.Variant("u", PERSIST_PERMANENT),
    }
    restore = load_token()
    if restore:
        opts["restore_token"] = GLib.Variant("s", restore)
        log("[portal] 用已保存的 restore_token（不再弹选屏框）")
    log("[portal] SelectSources …")
    p.call("SelectSources", GLib.Variant("(oa{sv})", (session, opts)), timeout=20)

    log("[portal] Start …（首次会弹选屏框）")
    res = p.call(
        "Start",
        GLib.Variant("(osa{sv})", (session, "", {
            "handle_token": GLib.Variant("s", token("st")),
        })),
        timeout=args.handshake_timeout,
    )
    streams = res.get("streams") or []
    if not streams:
        fail(4, f"没有 stream：{res}")
    node = streams[0][0]
    props = streams[0][1] or {}
    # portal 会告诉我们流的真实尺寸（KDE 上是**逻辑像素**，不是设备像素）
    size = props.get("size")
    stream_w, stream_h = (int(size[0]), int(size[1])) if size else (0, 0)
    if res.get("restore_token"):
        save_token(res["restore_token"])
        log("[portal] restore_token 已保存")

    # **GNOME 必须用 OpenPipeWireRemote 拿 fd**：GNOME 的 screencast 跑在一个私有的
    # pipewire 实例里（`pipewire -c filter-chain.conf`），会话总线上的客户端看不见那个
    # 节点 —— 只给 `path=` 时 gst 会立刻退出、一帧都没有。KDE 的节点就在用户自己的
    # pipewire 里，`path=` 就够。所以这里尽力拿 fd，拿不到就回退到 path=。
    pw_fd = None
    try:
        _reply, _fdlist = p.bus.call_with_unix_fd_list_sync(
            PORTAL, PORTAL_PATH, SCREENCAST, "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (session, {})),
            GLib.VariantType.new("(h)"),
            Gio.DBusCallFlags.NONE, 5000, None, None,
        )
        fds = _fdlist.peek_fds() if _fdlist is not None else []
        if fds:
            pw_fd = int(fds[0])
            log(f"[portal] OpenPipeWireRemote → fd {pw_fd}")
    except GLib.Error as e:
        log(f"[portal] OpenPipeWireRemote 失败（回退 path=）：{e.message}")

    region = None
    if args.region.strip():
        try:
            parts = [int(v) for v in args.region.replace(" ", ",").split(",") if v != ""]
        except ValueError:
            parts = []
        if len(parts) != 4:
            fail(5, f'region 要 "x,y,w,h" 四个整数，收到 {args.region!r}')
        x, y, w, h = parts
        if stream_w and stream_h:
            if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > stream_w or y + h > stream_h:
                fail(5, f"region {x},{y},{w},{h} 超出采集范围 {stream_w}x{stream_h}（坐标就是流坐标）")
        elif x < 0 or y < 0 or w <= 0 or h <= 0:
            fail(5, f"region {x},{y},{w},{h} 不合法（宽高要正数、坐标不能为负）")
        region = (x, y, w, h)

    frame_bytes = args.width * args.height * 3
    # 顺序不能动：限帧必须在 convert/scale 之前，否则 gst 会对原始分辨率做转换，
    # 12fps 全屏下 CPU 高一个数量级。add-borders 让 16:10 的屏幕进 16:9 画布时
    # 上下留黑边，而不是把画面横向拉扁。
    # 裁掉指示框：先把画面缩到**逻辑尺寸**（和光晕画在同一个坐标系里），
    # 再按逻辑像素裁掉四边光晕和顶部状态条，最后缩到目标画布。
    #
    # 为什么不按设备像素一次裁掉：设备像素的缩放比只能从流里反推（Qt 的 dpr 不可靠），
    # 而逻辑尺寸是光晕自己的坐标系 —— 多显示器/改缩放都不用重算。
    # 代价是多一次缩放；12fps 下实测 CPU 增加约 3%。
    crop = ""
    if region and stream_w and stream_h:
        x, y, w, h = region
        # 流的坐标系里直接裁：left/right/top/bottom 都是相对整条流
        crop = (f"videocrop left={x} right={stream_w - x - w} "
                f"top={y} bottom={stream_h - y - h} ! ")
    elif args.edge > 0 and args.logical_width > 0 and args.logical_height > 0:
        crop = (f"videoscale add-borders=true ! "
                f"video/x-raw,width={args.logical_width},height={args.logical_height} ! "
                f"videocrop left={args.edge} right={args.edge} "
                f"top={args.top_band} bottom={args.edge} ! ")
    # `keepalive-time`：**静止画面也得有帧**。GNOME/Mutter 的 screencast 是"有 damage 才发帧"，
    # 桌面不动时上游一帧都不给 —— 实测 9 秒 0 字节，`see_now` 会一直空等。
    # 让它每 250ms 重发最后一帧，videorate 再按目标帧率复制；重复帧的判帧是几乎免费的
    # （pipeline 自己会跳过 dup）。
    src_opts = (f"path={node}"
                + (f" fd={pw_fd}" if pw_fd is not None else "")
                + f" keepalive-time={max(20, args.keepalive)}")
    pipeline = (
        f"pipewiresrc {src_opts} ! "
        f"videorate ! video/x-raw,framerate={args.fps}/1 ! "
        f"videoconvert ! "
        f"{crop}"
        f"videoscale add-borders=true ! "
        f"video/x-raw,format=RGB,width={args.width},height={args.height} ! "
        f"fdsink fd=1"
    )
    log(f"[gst] {pipeline}")
    gst = subprocess.Popen(
        ["gst-launch-1.0", "-q"] + pipeline.split(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        # fd 必须在子进程里保持同一个编号，gst-launch 的 `fd=` 才能对上
        **(dict(pass_fds=(pw_fd,)) if pw_fd is not None else {}),
    )

    STOP = {"flag": False}

    def on_signal(*_):
        # **不能在这里直接干活**：主线程可能正阻塞在读 gst.stdout，信号处理器里做
        # 阻塞的 D-Bus 调用会跟主线程抢同一个连接。只置标志，让主循环收尾。
        STOP["flag"] = True
        try:
            gst.terminate()
        except Exception:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, on_signal)

    print(json.dumps({
        "ready": True, "node": node, "fps": args.fps,
        "width": args.width, "height": args.height, "frame_bytes": frame_bytes,
        "stream_width": stream_w, "stream_height": stream_h,
        "region": list(region) if region else None,
        "source": "portal",
    }), file=sys.stderr, flush=True)

    out = sys.stdout.buffer
    while True:
        if STOP["flag"]:
            break
        # 用 select 带超时读：只有这样才能在 200ms 内响应 SIGTERM 并**把 portal 会话关掉**。
        # 以前是阻塞 read，杀进程后会话留在 portal 里 —— GNOME 上实测会把后续
        # CreateSession 挂死（要重启 xdg-desktop-portal 才能恢复）。
        try:
            ready, _, _ = select.select([gst.stdout], [], [], 0.2)
        except (OSError, ValueError):
            break
        if not ready:
            continue
        chunk = os.read(gst.stdout.fileno(), 1 << 16)
        if not chunk:
            break
        try:
            out.write(chunk)
            out.flush()
        except BrokenPipeError:
            # 父进程不读了（被 kill 或 stop），安静收工
            try:
                gst.terminate()
            except Exception:
                pass
            sys.exit(0)

    close_session(p, session)
    if STOP["flag"]:
        # 正常停止：gst 是我们自己 terminate 的，别当成"流中断"
        sys.exit(0)
    err = (gst.stderr.read() or b"").decode("utf-8", "replace").strip()
    if err:
        log(f"[gst] {err[-800:]}")
    code = gst.wait()
    fail(3, f"gst 流中断（exit {code}）")


if __name__ == "__main__":
    sys.exit(main())
