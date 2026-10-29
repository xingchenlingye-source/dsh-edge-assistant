// DSH Edge Assistant — 側邊欄面板

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r)));
}

function setMsg(text, kind) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function showOutput(text) {
  const el = $("output");
  el.hidden = !text;
  el.textContent = text || "";
}

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8);
  } catch {
    return "";
  }
}

function addLine(container, title, sub, tip) {
  const item = document.createElement("div");
  item.className = "item";
  const b = document.createElement("b");
  b.textContent = title;
  item.appendChild(b);
  if (sub) {
    const s = document.createElement("span");
    s.textContent = " " + sub;
    item.appendChild(s);
  }
  if (tip) item.title = tip;
  container.appendChild(item);
}

let recording = false;

async function refresh() {
  const st = await send({ type: "panelState" });
  if (!st || st.ok === false) {
    $("dot").className = "dot off";
    $("bridge").textContent = "bridge: 未連線（開面板前先確認 server）";
    return;
  }
  $("dot").className = "dot " + (st.wsState === "connected" ? "on" : "off");
  $("host").textContent = (st.tab && st.tab.host) || "—";
  $("pagetitle").textContent = (st.tab && st.tab.title) || "";
  $("control").checked = !!st.control;
  $("bridge").textContent =
    st.wsState === "connected"
      ? "bridge: 已連線 · v" + (st.version || "?")
      : "bridge: 未連線（" + (st.lastError || "請啟動 server") + "）";

  recording = !!st.recording;
  $("rec").textContent = recording ? "停止錄製" : "開始錄製";
  $("rec").classList.toggle("primary", recording);

  const inbox = st.inbox || { count: 0, items: [] };
  $("inboxCount").textContent = inbox.count || 0;
  const inboxEl = $("inbox");
  inboxEl.textContent = "";
  if (!inbox.items || !inbox.items.length) {
    inboxEl.textContent = "—";
  } else {
    inbox.items.slice(0, 6).forEach((it) => {
      addLine(
        inboxEl,
        (it.kind || "item") + " · " + fmtTime(it.ts * 1000),
        (it.title || it.text || it.url || "").slice(0, 120),
        it.text || it.url || ""
      );
    });
  }

  const recentEl = $("recent");
  recentEl.textContent = "";
  const cmds = (st.recentCmds || []).slice(0, 8);
  if (!cmds.length) recentEl.textContent = "—";
  cmds.forEach((c) => addLine(recentEl, c.method, fmtTime(c.at), ""));

  if (st.panelMsg) {
    setMsg(st.panelMsg.text, st.panelMsg.kind);
    if (st.panelMsg.output) showOutput(st.panelMsg.output);
  }
}

async function action(name, extra) {
  const res = await send({ type: "panelAction", action: name, ...(extra || {}) });
  if (res && res.ok) {
    setMsg(res.message || "完成", "ok");
    if (res.output) showOutput(res.output);
  } else {
    setMsg((res && res.error) || "失敗", "err");
  }
  await refresh();
  return res;
}

$("read").addEventListener("click", async () => {
  setMsg("讀取中…");
  $("read").disabled = true;
  const res = await action("read");
  $("read").disabled = false;
  if (res && res.ok && res.output) {
    showOutput(res.output);
    setMsg("已讀取 " + (res.chars || 0) + " 字", "ok");
  }
});

$("shot").addEventListener("click", async () => {
  setMsg("截圖中…");
  $("shot").disabled = true;
  await action("shot");
  $("shot").disabled = false;
});

$("send").addEventListener("click", async () => {
  setMsg("送出中…");
  $("send").disabled = true;
  await action("send");
  $("send").disabled = false;
});

$("ax").addEventListener("click", async () => {
  setMsg("掃描頁面…");
  $("ax").disabled = true;
  await action("controls");
  $("ax").disabled = false;
});

$("rec").addEventListener("click", async () => {
  await action(recording ? "recordStop" : "recordStart");
});

$("clearInbox").addEventListener("click", async () => {
  await action("clearInbox");
});

$("control").addEventListener("change", async () => {
  const enabled = $("control").checked;
  await send({ type: "setControl", enabled });
  setMsg(enabled ? "控制模式已開啟（agent 可操作）" : "控制模式已關閉", "ok");
  await refresh();
});

(async () => {
  await refresh();
  setInterval(refresh, 2000);
})();

/* ================= DSH 對話（走 dsh-browser-chat 插件的 127.0.0.1:8766） ================= */

const CHAT_BASE = "http://127.0.0.1:8766";
let chatES = null;
let chatSessionId = null;
let chatLast = null; // 目前正在串流的 assistant 氣泡

function setChatState(text, cls) {
  const el = $("chatState");
  el.textContent = text;
  el.className = "chatstate" + (cls ? " " + cls : "");
}

function chatBubble(role, text) {
  const list = $("chatList");
  const el = document.createElement("div");
  el.className = "chatmsg " + role;
  el.textContent = text || "";
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
  return el;
}

function chatClear() {
  $("chatList").textContent = "";
  chatLast = null;
}

function chatHandleEvent(m) {
  if (!m || !m.role) return;
  const list = $("chatList");
  if (m.role === "user") {
    const last = list.lastElementChild;
    if (last && last.classList.contains("user") && last.textContent === (m.text || "")) return;
    chatBubble("user", m.text);
    chatLast = null;
  } else if (m.role === "assistant") {
    if (m.text) {
      chatBubble("assistant", m.text);
      chatLast = null;
    }
  } else if (m.role === "tool") {
    chatBubble("tool", "🔧 " + (m.name || "tool"));
    chatLast = null;
  } else if (m.role === "turn") {
    if (m.kind && m.kind !== "completed") chatBubble("turn", "— " + m.kind + " —");
    chatLast = null;
  }
}

function chatAppendDelta(text) {
  if (!text) return;
  if (!chatLast) chatLast = chatBubble("assistant", "");
  chatLast.textContent += text;
  const list = $("chatList");
  list.scrollTop = list.scrollHeight;
}

async function chatConnect() {
  try {
    const h = await fetch(CHAT_BASE + "/health", { cache: "no-store" }).then((r) => r.json());
    if (!h || !h.ok) throw new Error("offline");
    const cur = await fetch(CHAT_BASE + "/current").then((r) => r.json());
    chatSessionId = cur.sessionId;
    if (!chatSessionId) {
      setChatState("找不到會話", "off");
      return;
    }
    if (chatES) chatES.close();
    chatES = new EventSource(CHAT_BASE + "/events?sessionId=" + encodeURIComponent(chatSessionId));
    chatES.addEventListener("open", () => setChatState("已連線", "on"));
    chatES.addEventListener("error", () => {
      if (chatES && chatES.readyState === EventSource.CLOSED) {
        setChatState("未連線（DSH 插件未啟動？）", "off");
      }
    });
    chatES.addEventListener("snapshot", (e) => {
      try {
        const d = JSON.parse(e.data);
        chatClear();
        (d.messages || []).forEach(chatHandleEvent);
        chatLast = null;
        setChatState("已連線 · " + String(d.sessionId || "").slice(0, 14), "on");
      } catch {}
    });
    chatES.addEventListener("event", (e) => {
      try {
        chatHandleEvent(JSON.parse(e.data));
      } catch {}
    });
    chatES.addEventListener("delta", (e) => {
      try {
        chatAppendDelta(JSON.parse(e.data).text);
      } catch {}
    });
  } catch (e) {
    setChatState("未連線（DSH 插件未啟動）", "off");
  }
}

async function chatSend() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  chatBubble("user", text);
  chatLast = null;
  try {
    const r = await fetch(CHAT_BASE + "/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sessionId: chatSessionId || undefined }),
    }).then((x) => x.json());
    if (!r.ok) chatBubble("error", r.error || "送出失敗");
    else setMsg("已送給 DSH", "ok");
  } catch (e) {
    chatBubble("error", "送出失敗：" + String((e && e.message) || e));
  }
}

$("chatSend").addEventListener("click", chatSend);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatSend();
  }
});

chatConnect();
setInterval(() => {
  if (!chatES || chatES.readyState === EventSource.CLOSED) chatConnect();
}, 5000);

