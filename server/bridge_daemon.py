#!/usr/bin/env python3
"""DSH Bridge 常駐守護程式。

用途：登入後在背景把 bridge server 顧好——
  - server 沒在跑（第一次開機、崩潰、被關掉）→ 自動啟動
  - server 正在跑 → 什麼都不做，只定期檢查

用 pythonw.exe 執行（無視窗）：
  pythonw.exe server\\bridge_daemon.py
"""

import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
SERVER = os.path.join(HERE, "bridge_server.py")
LOG = os.path.join(DATA, "bridge.log")
HEALTH = "http://127.0.0.1:8765/health"
CHECK_EVERY = 20
RETRY_EVERY = 5


def health_ok():
    try:
        with urllib.request.urlopen(HEALTH, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def spawn_server():
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    kwargs = dict(
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if os.name == "nt":
        kwargs["creationflags"] = flags
    return subprocess.Popen([sys.executable, SERVER, "--log-file", LOG], **kwargs)


def main():
    os.makedirs(DATA, exist_ok=True)
    while True:
        if health_ok():
            time.sleep(CHECK_EVERY)
            continue
        try:
            spawn_server()
        except Exception:
            pass
        time.sleep(RETRY_EVERY)


if __name__ == "__main__":
    main()
