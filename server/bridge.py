#!/usr/bin/env python3
"""DSH Bridge CLI v2 — 從終端機 / agent 操作 Edge。

基本：
  python bridge.py health
  python bridge.py clients
  python bridge.py domains

便捷指令（--tab ID 可指定分頁，省略＝目前分頁）：
  python bridge.py status
  python bridge.py tabs
  python bridge.py active
  python bridge.py open <url>
  python bridge.py close [tabId]
  python bridge.py info [--tab ID]
  python bridge.py text [--max N] [--tab ID]
  python bridge.py markdown [--max N] [--tab ID]
  python bridge.py links [--limit N] [--tab ID]
  python bridge.py images [--limit N] [--tab ID]
  python bridge.py html [--max N] [--tab ID]
  python bridge.py shot [--out PATH] [--tab ID]
  python bridge.py click <selector> [--tab ID]
  python bridge.py type <selector> <text> [--tab ID]
  python bridge.py scroll [px] [--tab ID]
  python bridge.py eval <expression> [--tab ID]
  python bridge.py history [query]
  python bridge.py bookmarks [query]
  python bridge.py downloads [max]
  python bridge.py cookies <domain>
  python bridge.py getcookie <domain> <out>

通用指令（args 用檔案避開 PowerShell 引號問題）：
  python bridge.py cmd <method> --args-file args.json
  python bridge.py cmd <method> --args-json "<json>"   # 或在 bash/CMD 用
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8765"


def configure_stdio():
    """避免輸出編碼讓指令整個爛掉。

    - 被 agent / 管線擷取（非 tty）：一律 UTF-8，否則 Windows 的 GBK 主控台
      遇到 emoji 會丟 UnicodeEncodeError，`text` / `markdown` 直接失敗。
    - 在真實終端（tty）：保留系統編碼（中文才不會亂碼），只把無法編碼的
      字元換成 ?，不再中斷。
    """
    for stream in (sys.stdout, sys.stderr):
        if stream is None:
            continue
        try:
            if stream.isatty():
                stream.reconfigure(errors="replace")
            else:
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def http(path, method="GET", payload=None, timeout=45):
    url = BASE + path
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        print("ERROR: 無法連線 bridge（%s）。請先跑 server\\ensure-bridge.ps1" % e, file=sys.stderr)
        raise SystemExit(2)


def cmd(method, args=None, client=None, timeout=25):
    code, body = http(
        "/cmd",
        "POST",
        {"method": method, "args": args or {}, "client": client, "timeout": timeout},
        timeout=timeout + 10,
    )
    try:
        res = json.loads(body)
    except Exception:
        print("bridge 回應不是 JSON:", body, file=sys.stderr)
        raise SystemExit(1)
    if code != 200 or not res.get("ok"):
        print("指令失敗 [%s]: %s" % (method, res.get("error")), file=sys.stderr)
        raise SystemExit(1)
    return res.get("data")


def dump(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def with_tab(args, extra=None):
    out = dict(extra or {})
    if getattr(args, "tab", None):
        out["tabId"] = args.tab
    return out


# ---------------- cookies ----------------

def normalize_host(value):
    """把各種輸入（網域 / URL / 前導點 / host:port）正規化成 hostname。"""
    v = (value or "").strip()
    if not v:
        return ""
    if "://" in v:
        try:
            from urllib.parse import urlsplit

            v = urlsplit(v).hostname or ""
        except Exception:
            pass
    v = v.strip().strip(".").lower()
    # "example.com:443" → "example.com"；但 "about:blank" 這種不是 port，不動
    if v.count(":") == 1:
        head, _, port = v.partition(":")
        if port.isdigit():
            v = head
    return v.strip(".")


def cookie_domains(host):
    """列出與該 host 相關的 cookie 查詢網域（由長到短）。

    chrome.cookies.getAll({domain}) 只會回「該網域與其子網域」的 cookie，
    不會回父網域。登入 cookie（如 SESSDATA）通常掛在 `.bilibili.com`，
    所以查 `www.bilibili.com` 會一個都拿不到 —— 必須順便查父網域。
    """
    host = normalize_host(host)
    if not host:
        return []
    parts = host.split(".")
    out = [host]
    for i in range(1, len(parts) - 1):
        out.append(".".join(parts[i:]))
    return out


def collect_cookies(domain):
    """取回整個網站（含父網域）的 cookie，去重後回傳。

    新版擴充自己就會補父網域；這裡仍逐層查詢並去重，讓舊版擴充也正確。
    """
    merged = {}
    for d in cookie_domains(domain):
        data = cmd("cookies.get", {"domain": d, "save": False}) or {}
        for c in data.get("cookies") or []:
            merged[(c.get("name"), c.get("domain"), c.get("path"))] = c
    return list(merged.values())


def save_cookie_payload(host, cookies):
    """把 cookie 清單交給 bridge 存成 data/cookies/<host>.{json,txt}。"""
    payload = {
        "origin": "https://" + host + "/",
        "hostname": host,
        "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "count": len(cookies),
        "cookies": cookies,
    }
    code, body = http("/cookies", "POST", payload)
    if code != 200:
        print("儲存 cookie 失敗:", body, file=sys.stderr)
        raise SystemExit(1)
    return json.loads(body)


# ---------------- 自動識別目前頁面的 cookie ----------------

SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
SESSION_RE = re.compile(
    r"(?i)(sess|session|sid|token|auth|jwt|bearer|login|passport|ticket|remember|"
    r"jsessionid|phpsessid|csrftoken|cookie|uid)"
)
STRONG_SESSION_RE = re.compile(
    r"(?i)(?:sessdata|sessionid|sessid|jsessionid|phpsessid|asp\.net_sessionid|"
    r"csrftoken|bili_jct|dedeuserid|access_token|refresh_token|auth_?token|passport|"
    # Google / YouTube 登入憑證
    r"__secure-\dpsid|^(?:sid|sapisid|hsid|apisid|ssid|login_info)$)"
)


def safe_name(host):
    """與 bridge_server.py 的 safe_name 一致（存檔檔名）。"""
    return (SAFE_RE.sub("_", (host or "unknown").lower()) or "unknown")[:120]


def is_session_cookie(cookie):
    """寬鬆判斷：名稱像 session/token 且值夠長。"""
    name = str(cookie.get("name") or "")
    if not name or not SESSION_RE.search(name):
        return False
    return len(str(cookie.get("value") or "")) >= 6


def strong_session_cookie(cookie):
    name = str(cookie.get("name") or "")
    return bool(STRONG_SESSION_RE.search(name)) and len(str(cookie.get("value") or "")) >= 6


HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")


def valid_host(host):
    if not host:
        return False
    if host == "localhost":
        return True
    return bool(HOST_RE.match(host)) and "." in host


def tab_host(tab_id=None):
    """自動取得「目前分頁」或指定分頁的 host；不是 http(s) 就報錯。"""
    raw = ""
    if tab_id:
        data = cmd("tabs.list")
        found = None
        for t in data.get("tabs") or []:
            if t.get("id") == tab_id:
                found = t
                break
        if not found:
            raise SystemExit("找不到分頁 %s" % tab_id)
        raw = found.get("url") or ""
        if not re.match(r"^https?://", raw, re.I):
            raise SystemExit("分頁 %s 不是網頁（%s），請直接指定網域" % (tab_id, raw or "空白頁"))
    else:
        data = cmd("tabs.active")
        raw = data.get("url") or ""
        if not re.match(r"^https?://", raw, re.I):
            raise SystemExit("目前分頁不是網頁（%s），請直接指定網域或用 --tab" % (raw or "空白頁"))
    host = normalize_host(raw)
    if not valid_host(host):
        raise SystemExit("無法從這個網址辨識網域：%s" % raw)
    return host


def resolve_cookie_host(domain, tab_id=None):
    """有給網域就用；沒給就自動抓目前分頁（或 --tab 指定分頁）。"""
    if domain:
        host = normalize_host(domain)
        if not valid_host(host):
            raise SystemExit("網域格式不對：%s" % domain)
        return host
    return tab_host(tab_id)


def cookie_summary(host, cookies):
    session = sorted({str(c.get("name")) for c in cookies if is_session_cookie(c)})
    strong = sorted({str(c.get("name")) for c in cookies if strong_session_cookie(c)})
    return {
        "host": host,
        "count": len(cookies),
        "sessionCookies": session,
        # 啟發式：有強 session-like cookie 就當作「可能已登入」
        "loggedIn": bool(strong),
        "loginHints": strong,
        "names": sorted({str(c.get("name") or "") for c in cookies}),
    }


def trim_dir(path, max_files=100, ext=".pdf"):
    """PDF 預設存檔會累積；超過張數就刪最舊的。"""
    try:
        if not os.path.isdir(path):
            return
        files = [os.path.join(path, f) for f in os.listdir(path) if f.lower().endswith(ext)]
        files.sort(key=lambda p: os.path.getmtime(p))
        while len(files) > max_files:
            oldest = files.pop(0)
            try:
                os.remove(oldest)
            except Exception:
                pass
    except Exception:
        pass


def main():
    global BASE
    configure_stdio()
    ap = argparse.ArgumentParser(description="DSH Bridge CLI v2")
    ap.add_argument("--port", type=int, default=8765)
    sub = ap.add_subparsers(dest="cmdname", required=True)

    for name in ["health", "clients", "domains", "status", "tabs", "active", "downloads"]:
        sub.add_parser(name)

    p = sub.add_parser("cmd")
    p.add_argument("method")
    p.add_argument("--args-file", default=None)
    p.add_argument("--args-json", default="{}")
    p.add_argument("--timeout", type=float, default=25)
    p.add_argument("--client", default=None)

    p = sub.add_parser("open")
    p.add_argument("url")
    p.add_argument("--no-focus", action="store_true")

    p = sub.add_parser("close")
    p.add_argument("tabId", nargs="?", type=int, default=None)

    p = sub.add_parser("info")
    p.add_argument("--tab", type=int, default=None)

    for name in ["text", "markdown", "html"]:
        p = sub.add_parser(name)
        p.add_argument("--max", type=int, default=200000)
        p.add_argument("--tab", type=int, default=None)

    for name in ["links", "images"]:
        p = sub.add_parser(name)
        p.add_argument("--limit", type=int, default=300)
        p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("shot")
    p.add_argument("--out", default=None)
    p.add_argument("--format", choices=["png", "jpeg"], default="png")
    p.add_argument("--selector", default=None, help="只截這個元素")
    p.add_argument("--full", action="store_true", help="整頁截圖（不限視窗）")
    p.add_argument("--marks", default=None, help='標記點擊位置："x,y;x,y" 或 "x,y:標籤;..."')
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("click")
    p.add_argument("selector")
    p.add_argument("--dom", action="store_true", help="退回舊的 DOM click（預設走 CDP 真實滑鼠）")
    p.add_argument("--button", choices=["left", "right", "middle"], default="left")
    p.add_argument("--click-count", type=int, default=1)
    p.add_argument("--modifiers", type=int, default=0)
    p.add_argument("--frame", type=int, default=None, help="在指定 iframe 內點（用 controls 查 frameId）")
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("type")
    p.add_argument("selector")
    p.add_argument("text")
    p.add_argument("--submit", action="store_true", help="打完按 Enter")
    p.add_argument("--delay", type=int, default=0, help="逐字輸入延遲（毫秒）")
    p.add_argument("--no-clear", action="store_true")
    p.add_argument("--dom", action="store_true", help="退回舊的 JS 設值")
    p.add_argument("--frame", type=int, default=None, help="在指定 iframe 內輸入")
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("scroll")
    p.add_argument("px", nargs="?", type=int, default=600)
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("eval")
    p.add_argument("expression")
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("history")
    p.add_argument("query", nargs="?", default="")
    p.add_argument("--max", type=int, default=20)

    p = sub.add_parser("bookmarks")
    p.add_argument("query", nargs="?", default="")
    p.add_argument("--max", type=int, default=50)

    p = sub.add_parser("cookies", help="讀 cookie；省略 domain＝自動用目前分頁")
    p.add_argument("domain", nargs="?", default=None)
    p.add_argument("--tab", type=int, default=None, help="從指定分頁自動推導網域")
    p.add_argument("--no-save", action="store_true")

    p = sub.add_parser("getcookie", help="存成 cookies.txt；省略 out＝存到 data/cookies/")
    p.add_argument("domain", nargs="?", default=None)
    p.add_argument("out", nargs="?", default=None)
    p.add_argument("--tab", type=int, default=None, help="從指定分頁自動推導網域")

    p = sub.add_parser("save")
    p.add_argument("domain")
    p.add_argument("path")

    p = sub.add_parser("read")
    p.add_argument("--max", type=int, default=200000)
    p.add_argument("--screens", type=int, default=40)
    p.add_argument("--start", type=int, default=0)
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("ax")
    p.add_argument("--max", type=int, default=600)
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("controls")
    p.add_argument("--limit", type=int, default=60)
    p.add_argument("--no-frames", action="store_true", help="只看主頁面，不含 iframe")
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("waitfor")
    p.add_argument("--selector", default=None)
    p.add_argument("--text", default=None)
    p.add_argument("--url", default=None)
    p.add_argument("--network-idle", action="store_true")
    p.add_argument("--timeout", type=int, default=10000)
    p.add_argument("--poll", type=int, default=250)
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("press")
    p.add_argument("keys")
    p.add_argument("--selector", default=None)
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("select")
    p.add_argument("selector")
    p.add_argument("value")
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("hover")
    p.add_argument("selector")
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("pdf")
    p.add_argument("--out", default=None)
    p.add_argument("--landscape", action="store_true")
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("network")
    p.add_argument("action", nargs="?", default="list", choices=["start", "list", "clear", "stop", "body"])
    p.add_argument("--max", type=int, default=50)
    p.add_argument("--request-id", default=None, dest="request_id", help="network body 用：請求 id")
    p.add_argument("--max-bytes", type=int, default=65536, dest="max_bytes")
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("console")
    p.add_argument("action", nargs="?", default="get", choices=["start", "get", "clear", "stop"])
    p.add_argument("--max", type=int, default=50)
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("dialog")
    p.add_argument("action", nargs="?", default="list", choices=["list", "accept", "dismiss"])
    p.add_argument("--text", default=None)
    p.add_argument("--tab", type=int, default=None)

    p = sub.add_parser("record")
    p.add_argument("action", nargs="?", default="status", choices=["start", "stop", "status"])

    p = sub.add_parser("group")
    p.add_argument("--title", default="")
    p.add_argument("--color", default=None)
    p.add_argument("--tabs", default=None)
    p.add_argument("--tab", type=int, default=None)
    p.add_argument("--collapsed", action="store_true")

    p = sub.add_parser("ungroup")
    p.add_argument("--tabs", required=True)

    p = sub.add_parser("groups")
    p.add_argument("--window", type=int, default=None)

    p = sub.add_parser("inbox")
    p.add_argument("--clear", action="store_true")
    p.add_argument("--limit", type=int, default=50)

    args = ap.parse_args()
    BASE = "http://127.0.0.1:%d" % args.port
    n = args.cmdname

    if n == "health":
        print(http("/health")[1])
        return
    if n == "clients":
        print(http("/clients")[1])
        return
    if n == "domains":
        print(http("/domains")[1])
        return

    if n == "cmd":
        if args.args_file:
            # utf-8-sig：PowerShell「Set-Content -Encoding utf8」會寫 BOM，
            # 用純 utf-8 讀會炸 JSONDecodeError（README 的範例就是這樣）。
            with open(args.args_file, encoding="utf-8-sig") as f:
                parsed = json.load(f)
        else:
            try:
                parsed = json.loads(args.args_json)
            except Exception:
                print("--args-json 必須是合法 JSON；PowerShell 會吃掉引號，建議改用 --args-file", file=sys.stderr)
                raise SystemExit(1)
        dump(cmd(args.method, parsed, args.client, args.timeout))
        return

    if n == "status":
        dump(cmd("status"))
        return
    if n == "tabs":
        dump(cmd("tabs.list"))
        return
    if n == "active":
        dump(cmd("tabs.active"))
        return
    if n == "info":
        dump(cmd("page.info", with_tab(args)))
        return
    if n == "open":
        dump(cmd("tabs.open", {"url": args.url, "active": not args.no_focus}))
        return
    if n == "close":
        dump(cmd("tabs.close", {"tabId": args.tabId}))
        return
    if n == "text":
        data = cmd("page.text", with_tab(args, {"max": args.max}))
        print(data.get("text", ""))
        return
    if n == "markdown":
        data = cmd("page.markdown", with_tab(args, {"max": args.max}))
        print(data.get("markdown", ""))
        return
    if n == "html":
        data = cmd("page.html", with_tab(args, {"max": args.max}))
        print(data.get("html", ""))
        return
    if n == "links":
        dump(cmd("page.links", with_tab(args, {"limit": args.limit})))
        return
    if n == "images":
        dump(cmd("page.images", with_tab(args, {"limit": args.limit})))
        return
    if n == "shot":
        extra = {"format": args.format}
        if args.selector:
            extra["selector"] = args.selector
        if args.full:
            extra["fullPage"] = True
        if args.marks:
            marks = []
            for part in str(args.marks).split(";"):
                part = part.strip()
                if not part:
                    continue
                label = ""
                coord = part
                if ":" in part:
                    coord, label = part.split(":", 1)
                try:
                    x, y = [float(v) for v in coord.split(",")]
                except Exception:
                    continue
                marks.append({"x": x, "y": y, "label": label.strip()})
            if marks:
                extra["marks"] = marks
        data = cmd("page.screenshot", with_tab(args, extra), timeout=60)
        path = data.get("path")
        print("screenshot saved at bridge:", path, "bytes:", data.get("bytes"))
        if args.out and path and os.path.exists(path):
            import shutil

            shutil.copyfile(path, args.out)
            print("copied ->", args.out)
        return
    if n == "click":
        extra = {
            "selector": args.selector,
            "button": args.button,
            "clickCount": args.click_count,
            "modifiers": args.modifiers,
        }
        if args.dom:
            extra["dom"] = True
        if args.frame is not None:
            extra["frameId"] = args.frame
        dump(cmd("page.click", with_tab(args, extra), timeout=40))
        return
    if n == "type":
        extra = {
            "selector": args.selector,
            "text": args.text,
            "clear": not args.no_clear,
            "submit": args.submit,
            "delay": args.delay,
        }
        if args.dom:
            extra["dom"] = True
        if args.frame is not None:
            extra["frameId"] = args.frame
        dump(cmd("page.type", with_tab(args, extra), timeout=60))
        return
    if n == "scroll":
        dump(cmd("page.scroll", with_tab(args, {"by": args.px})))
        return
    if n == "eval":
        dump(cmd("page.eval", with_tab(args, {"expression": args.expression})))
        return
    if n == "history":
        dump(cmd("history.search", {"text": args.query, "max": args.max}))
        return
    if n == "bookmarks":
        dump(cmd("bookmarks.search", {"query": args.query, "max": args.max}))
        return
    if n == "downloads":
        dump(cmd("downloads.list", {"max": 20}))
        return
    if n == "cookies":
        host = resolve_cookie_host(args.domain, args.tab)
        cookies = collect_cookies(host)
        result = cookie_summary(host, cookies)
        if not args.no_save:
            saved = save_cookie_payload(host, cookies)
            result["saved"] = saved.get("saved")
        dump(result)
        return
    if n == "getcookie":
        host = resolve_cookie_host(args.domain, args.tab)
        cookies = collect_cookies(host)
        if not cookies:
            print("讀不到 cookie（這個網域沒登入，或目前分頁不屬於該網域）", file=sys.stderr)
            raise SystemExit(1)
        save_cookie_payload(host, cookies)
        out = args.out
        auto = False
        if not out:
            out_dir = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "data",
                "cookies",
            )
            os.makedirs(out_dir, exist_ok=True)
            out = os.path.join(out_dir, safe_name(host) + ".txt")
            auto = True
        code, body = http("/cookies/" + host)
        if code != 200:
            print("取 cookies.txt 失敗:", body, file=sys.stderr)
            raise SystemExit(1)
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        summary = cookie_summary(host, cookies)
        print(
            "saved -> %s (%d bytes, %d cookies, login=%s%s)"
            % (
                out,
                len(body),
                len(cookies),
                "yes" if summary["loggedIn"] else "unknown",
                ", auto" if auto else "",
            )
        )
        if summary["loginHints"]:
            print("login hints: " + ", ".join(summary["loginHints"]), file=sys.stderr)
        return
    if n == "save":
        code, body = http("/cookies/" + args.domain)
        if code != 200:
            print(body, file=sys.stderr)
            raise SystemExit(1)
        with open(args.path, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        print("saved -> %s (%d bytes)" % (args.path, len(body)))
        return

    # ---------------- v2.1：CDP / 讀取強化 / 工作流 ----------------

    if n == "read":
        data = cmd(
            "page.read",
            with_tab(args, {"max": args.max, "screens": args.screens, "start": args.start}),
            timeout=90,
        )
        print(data.get("text", ""))
        print(
            "\n[read] chars=%s totalChars=%s screens=%s complete=%s truncated=%s nextStart=%s"
            % (
                data.get("chars"),
                data.get("totalChars"),
                data.get("screens"),
                data.get("complete"),
                data.get("truncated"),
                data.get("nextStart"),
            ),
            file=sys.stderr,
        )
        return
    if n == "ax":
        dump(cmd("page.ax", with_tab(args, {"max": args.max}), timeout=60))
        return
    if n == "controls":
        extra = {"limit": args.limit}
        if args.no_frames:
            extra["allFrames"] = False
        dump(cmd("page.controls", with_tab(args, extra), timeout=40))
        return
    if n == "waitfor":
        extra = {"timeout": args.timeout, "poll": args.poll}
        if args.selector:
            extra["selector"] = args.selector
        elif args.text:
            extra["text"] = args.text
        elif args.url:
            extra["url"] = args.url
        elif args.network_idle:
            extra["networkIdle"] = True
        else:
            print("需要 --selector / --text / --url / --network-idle 其中之一", file=sys.stderr)
            raise SystemExit(1)
        dump(cmd("page.waitFor", with_tab(args, extra), timeout=args.timeout / 1000 + 20))
        return
    if n == "press":
        extra = {"keys": args.keys}
        if args.selector:
            extra["selector"] = args.selector
        dump(cmd("page.press", with_tab(args, extra), timeout=40))
        return
    if n == "select":
        dump(cmd("page.select", with_tab(args, {"selector": args.selector, "value": args.value})))
        return
    if n == "hover":
        dump(cmd("page.hover", with_tab(args, {"selector": args.selector})))
        return
    if n == "pdf":
        data = cmd("page.pdf", with_tab(args, {"landscape": args.landscape}), timeout=120)
        raw = base64.b64decode(data.get("base64") or "")
        if not raw:
            print("PDF 產生失敗（空資料）", file=sys.stderr)
            raise SystemExit(1)
        out = args.out
        auto = False
        if not out:
            out_dir = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "pdfs"
            )
            os.makedirs(out_dir, exist_ok=True)
            out = os.path.join(out_dir, "page-%s.pdf" % time.strftime("%Y%m%d-%H%M%S"))
            auto = True
        with open(out, "wb") as f:
            f.write(raw)
        if auto:
            trim_dir(os.path.dirname(out), max_files=100)
        print("saved -> %s (%d bytes)" % (out, len(raw)))
        return
    if n == "network":
        if args.action == "start":
            dump(cmd("network.start", with_tab(args)))
        elif args.action == "list":
            dump(cmd("network.list", with_tab(args, {"max": args.max})))
        elif args.action == "clear":
            dump(cmd("network.clear", with_tab(args)))
        elif args.action == "body":
            if not args.request_id:
                print("需要 --request-id（先用 network list 查 id）", file=sys.stderr)
                sys.exit(2)
            dump(
                cmd(
                    "network.body",
                    with_tab(args, {"requestId": args.request_id, "maxBytes": args.max_bytes}),
                    timeout=60,
                )
            )
        else:
            dump(cmd("network.stop", with_tab(args)))
        return
    if n == "console":
        if args.action == "start":
            dump(cmd("console.start", with_tab(args)))
        elif args.action == "get":
            dump(cmd("console.get", with_tab(args, {"max": args.max})))
        elif args.action == "clear":
            dump(cmd("console.clear", with_tab(args)))
        else:
            dump(cmd("console.stop", with_tab(args)))
        return
    if n == "dialog":
        if args.action == "list":
            dump(cmd("dialog.list", with_tab(args)))
        elif args.action == "accept":
            extra = {"text": args.text} if args.text is not None else {}
            dump(cmd("dialog.accept", with_tab(args, extra)))
        else:
            dump(cmd("dialog.dismiss", with_tab(args)))
        return
    if n == "record":
        if args.action == "start":
            dump(cmd("record.start", {}))
        elif args.action == "stop":
            dump(cmd("record.stop", {}, timeout=40))
        else:
            dump(cmd("record.status", {}))
        return
    if n == "group":
        extra = {"title": args.title, "color": args.color, "collapsed": args.collapsed}
        if args.tabs:
            extra["tabIds"] = [int(x) for x in args.tabs.split(",") if x.strip()]
        dump(cmd("tabs.group", with_tab(args, extra)))
        return
    if n == "ungroup":
        ids = [int(x) for x in args.tabs.split(",") if x.strip()]
        dump(cmd("tabs.ungroup", {"tabIds": ids}))
        return
    if n == "groups":
        extra = {"windowId": args.window} if args.window else {}
        dump(cmd("tabs.groups", extra))
        return
    if n == "inbox":
        if args.clear:
            code, body = http("/inbox", "DELETE")
        else:
            code, body = http("/inbox?limit=%d" % args.limit)
        try:
            dump(json.loads(body))
        except Exception:
            print(body)
        return


if __name__ == "__main__":
    main()
