const $ = (id) => document.getElementById(id);

let wsState = "disconnected";

function setMsg(text, kind) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function renderWs(state) {
  wsState = state || "disconnected";
  const d = $("wsDot");
  d.className = "dot " + (wsState === "connected" ? "on" : "off");
  if (wsState === "connected") {
    $("bridgeInfo").textContent = "bridge: 已連線 · 可接收指令";
  } else if (wsState === "connecting") {
    $("bridgeInfo").textContent = "bridge: 連線中…";
  } else {
    $("bridgeInfo").textContent = "bridge: 未連線（請啟動 bridge server）";
  }
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refresh() {
  const st = await send({ type: "status" });
  if (st && st.ok) {
    renderWs(st.wsState);
    const info = st.info || {};
    if (Array.isArray(info.clients) && info.clients.length) {
      $("bridgeInfo").textContent =
        "bridge: 已連線 · " + info.clients.length + " 個瀏覽器 · v" + (st.version || "?");
    }
  } else {
    renderWs((st && st.wsState) || "disconnected");
    if (st && st.info) renderWs("connected");
  }
  const ctl = await send({ type: "getControl" });
  if (ctl && ctl.ok) $("controlToggle").checked = !!ctl.enabled;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/.test(tab.url)) {
      $("host").textContent = new URL(tab.url).hostname;
      $("pagetitle").textContent = tab.title || "";
    } else {
      $("host").textContent = "（不是網頁）";
      $("pagetitle").textContent = "";
    }
  } catch {
    $("host").textContent = "—";
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stateUpdate") {
    renderWs(msg.wsState);
  }
});

$("send").addEventListener("click", async () => {
  setMsg("傳送中…");
  $("send").disabled = true;
  const res = await send({ type: "sync" });
  $("send").disabled = false;
  if (res && res.ok) {
    const r = res.result || {};
    setMsg(`已同步 ${res.count} 個 cookie → ${r.saved || ""}`, "ok");
  } else {
    setMsg((res && res.error) || "失敗", "err");
  }
});

$("download").addEventListener("click", async () => {
  setMsg("準備下載…");
  $("download").disabled = true;
  const res = await send({ type: "download" });
  $("download").disabled = false;
  if (res && res.ok) {
    setMsg(`已下載 dsh-cookies-${res.host}.txt（${res.count} 個 cookie）`, "ok");
  } else {
    setMsg((res && res.error) || "失敗", "err");
  }
});

$("panel").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } catch (e) {
    setMsg("開啟側邊欄失敗：" + String((e && e.message) || e), "err");
  }
});

$("controlToggle").addEventListener("change", async () => {
  const enabled = $("controlToggle").checked;
  await send({ type: "setControl", enabled });
  setMsg(enabled ? "控制模式已開啟（agent 可操作瀏覽器）" : "控制模式已關閉", "ok");
});

(async () => {
  const st = await send({ type: "status" });
  if (!st || st.wsState !== "connected") {
    await send({ type: "reconnect" }).catch(() => {});
  }
  await refresh();
  setInterval(refresh, 2000);
})();
