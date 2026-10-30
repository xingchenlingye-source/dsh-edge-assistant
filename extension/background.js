// DSH Edge Assistant — background service worker (v2)
// 與本機 bridge 建立 WebSocket 雙向通道：
//   ws://127.0.0.1:8765/ws
// 接收 agent 指令（讀頁面 / 截圖 / 操作 / 分頁 / 歷史 / 書籤 / 下載 / cookie），
// 並保留原本的 cookie 同步與下載功能。
//
// 安全：讀取類指令永遠可用；「寫入/操作」類需在 popup 開啟「控制模式」。

const BRIDGE_HTTP = "http://127.0.0.1:8765";
const BRIDGE_WS = "ws://127.0.0.1:8765/ws";
const VERSION = "2.1.4";
const PING_MS = 20000;

/* ================= 狀態 ================= */

let ws = null;
let wsState = "disconnected"; // disconnected | connecting | connected
let clientId = null;
let reconnectDelay = 500;
let pingTimer = null;
let lastError = "";
const recentCmds = [];

/* ================= 工具 ================= */

function tabBrief(t) {
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    active: t.active,
    pinned: t.pinned,
    title: t.title,
    url: t.url,
    status: t.status,
  };
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("沒有作用中的分頁");
  return t;
}

async function tabById(id) {
  if (id) return await chrome.tabs.get(id);
  return await activeTab();
}

async function execInTab(tabId, func, args, world) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || [],
    world: world || "ISOLATED",
  });
  return res ? res.result : null;
}

// 在所有 frame（含 iframe）執行，回傳 [{ frameId, result }]
async function execInAllFrames(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func,
    args: args || [],
    world: "ISOLATED",
  });
  return results || [];
}

// 在指定 iframe 內執行（給 click/type 的 --frame 用）
async function execInFrame(tabId, frameId, func, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [Number(frameId)] },
    func,
    args: args || [],
    world: "ISOLATED",
  });
  return res ? res.result : null;
}

function jsonSafe(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

async function getSetting(keys) {
  return await chrome.storage.local.get(keys);
}

async function ensureClientId() {
  const s = await getSetting(["clientId"]);
  if (s.clientId) return s.clientId;
  const id = "edge-" + Math.random().toString(16).slice(2, 10);
  await chrome.storage.local.set({ clientId: id });
  return id;
}

async function controlEnabled() {
  const s = await getSetting(["controlMode"]);
  return !!s.controlMode;
}

/* ================= Cookie 工具 ================= */

// 把「網域 / URL / 帶前導點的網域」都正規化成 hostname
function normalizeHost(value) {
  if (!value) return "";
  let v = String(value).trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = new URL(v).hostname;
  } catch {}
  return v.replace(/^\.+/, "").toLowerCase();
}

async function resolveCookieHost(domain) {
  const explicit = normalizeHost(domain);
  if (explicit) return explicit;
  const t = await activeTab();
  const host = normalizeHost(t.url);
  if (!host) throw new Error("目前分頁不是網頁，請在 args.domain 指定網域");
  return host;
}

// 取「整個網站」的 cookie。
// 注意：chrome.cookies.getAll({domain}) 只回「該網域與其子網域」，不回父網域；
// 登入 cookie（SESSDATA 等）通常掛在 .bilibili.com，查 www.bilibili.com 會一個都拿不到。
// 所以用兩種查法取聯集：
//   1) url   → 瀏覽器實際送給該網址的 cookie（含父網域）
//   2) domain → 該網域與子網域的 cookie（含 host-only、不限 path）
async function collectCookies(host) {
  const merged = new Map();
  const add = (list) => {
    for (const c of list || []) {
      merged.set([c.name, c.domain, c.path].join("\u0001"), c);
    }
  };
  if (!host) return [];
  try {
    add(await chrome.cookies.getAll({ url: "https://" + host + "/" }));
  } catch {}
  try {
    add(await chrome.cookies.getAll({ domain: host }));
  } catch {}
  return [...merged.values()];
}

function cookieBrief(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate || null,
  };
}

/* ================= CDP（Chrome DevTools Protocol） ================= */
// 用 debugger 權限取得 Kimi 等級的控制能力：真實滑鼠/鍵盤事件、元素截圖、
// 無障礙樹、網路與 Console。策略：用到才 attach，閒置 10 秒後 detach，
// 避免 Edge 一直掛著「偵錯此瀏覽器」的提示條。

const CDP_VER = "1.3";
const CDP_IDLE_MS = 10000;
const cdpSessions = new Map(); // tabId -> { keep, timer, lastUsed, enabled:Set }

async function cdpAttach(tabId, keep) {
  let s = cdpSessions.get(tabId);
  if (s) {
    s.lastUsed = Date.now();
    if (keep) s.keep = true;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    return s;
  }
  try {
    await chrome.debugger.attach({ tabId }, CDP_VER);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (!/already attached/i.test(m)) throw new Error("無法 attach debugger：" + m);
  }
  s = { keep: !!keep, timer: null, lastUsed: Date.now(), enabled: new Set() };
  cdpSessions.set(tabId, s);
  return s;
}

async function cdpSend(tabId, method, params, keep) {
  const s = await cdpAttach(tabId, keep);
  s.lastUsed = Date.now();
  return await chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function cdpEnable(tabId, domain, params, keep) {
  const s = await cdpAttach(tabId, keep);
  if (!s.enabled.has(domain)) {
    await chrome.debugger.sendCommand({ tabId }, domain + ".enable", params || {});
    s.enabled.add(domain);
  }
  return s;
}

function cdpRelease(tabId) {
  const s = cdpSessions.get(tabId);
  if (!s || s.keep) return;
  s.lastUsed = Date.now();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    cdpDetach(tabId).catch(() => {});
  }, CDP_IDLE_MS);
}

async function cdpDetach(tabId) {
  const s = cdpSessions.get(tabId);
  cdpSessions.delete(tabId);
  if (s && s.timer) clearTimeout(s.timer);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}

async function cdpDetachIdle() {
  const now = Date.now();
  for (const [tabId, s] of [...cdpSessions.entries()]) {
    if (!s.keep && now - s.lastUsed >= CDP_IDLE_MS * 2) await cdpDetach(tabId);
  }
}

/* ---------- 鍵盤 ---------- */

const KEYMAP = {
  enter: { key: "Enter", code: "Enter", vk: 13 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  f1: { key: "F1", code: "F1", vk: 112 },
  f2: { key: "F2", code: "F2", vk: 113 },
  f3: { key: "F3", code: "F3", vk: 114 },
  f4: { key: "F4", code: "F4", vk: 115 },
  f5: { key: "F5", code: "F5", vk: 116 },
  f6: { key: "F6", code: "F6", vk: 117 },
  f7: { key: "F7", code: "F7", vk: 118 },
  f8: { key: "F8", code: "F8", vk: 119 },
  f9: { key: "F9", code: "F9", vk: 120 },
  f10: { key: "F10", code: "F10", vk: 121 },
  f11: { key: "F11", code: "F11", vk: 122 },
  f12: { key: "F12", code: "F12", vk: 123 },
};

// "Control+Shift+Enter" / "a" / "Enter" → { key, code, vk, modifiers }
function parseKeySpec(spec) {
  const parts = String(spec || "")
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  let modifiers = 0;
  const plain = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (["ctrl", "control"].includes(low)) modifiers |= 2;
    else if (low === "shift") modifiers |= 8;
    else if (low === "alt" || low === "option") modifiers |= 1;
    else if (["meta", "cmd", "command", "win"].includes(low)) modifiers |= 4;
    else plain.push(p);
  }
  const main = plain.length ? plain[plain.length - 1] : "";
  if (!main) throw new Error("需要按鍵，例如 Enter、Control+A");
  const low = main.toLowerCase();
  if (KEYMAP[low]) return { ...KEYMAP[low], modifiers };
  if (/^[a-z]$/i.test(main)) {
    const upper = main.toUpperCase();
    return {
      key: modifiers & 8 ? upper : low,
      code: "Key" + upper,
      vk: upper.charCodeAt(0),
      modifiers,
    };
  }
  if (/^\d$/.test(main)) {
    return { key: main, code: "Digit" + main, vk: 48 + Number(main), modifiers };
  }
  if (main.length === 1) {
    return { key: main, code: "", vk: main.toUpperCase().charCodeAt(0), modifiers };
  }
  return { key: main, code: main, vk: 0, modifiers };
}

async function cdpKey(tabId, spec) {
  const k = typeof spec === "string" ? parseKeySpec(spec) : spec;
  const base = {
    modifiers: k.modifiers || 0,
    key: k.key,
    code: k.code || "",
    windowsVirtualKeyCode: k.vk || 0,
    nativeVirtualKeyCode: k.vk || 0,
  };
  await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (k.key && k.key.length === 1) {
    await cdpSend(tabId, "Input.dispatchKeyEvent", {
      type: "char",
      ...base,
      text: k.key,
      unmodifiedText: k.key,
    });
  }
  await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/* ---------- 滑鼠 ---------- */

const MOUSE_BUTTONS = { left: 1, right: 2, middle: 4 };

async function elementBox(tabId, selector) {
  const box = await execInTab(tabId, pageBoxOf, [selector]);
  if (!box) throw new Error("找不到元素: " + selector);
  if (!box.visible) throw new Error("元素不可見（display:none / 尺寸 0）: " + selector);
  return box;
}

async function cdpClickAt(tabId, x, y, args) {
  const button = args.button === "right" ? "right" : args.button === "middle" ? "middle" : "left";
  const buttons = MOUSE_BUTTONS[button] || 1;
  const clickCount = Math.max(1, Math.min(Number(args.clickCount) || 1, 3));
  const modifiers = Number(args.modifiers) || 0;
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    modifiers,
    pointerType: "mouse",
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    buttons,
    clickCount,
    modifiers,
    pointerType: "mouse",
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: 0,
    clickCount,
    modifiers,
    pointerType: "mouse",
  });
}

async function cdpClick(tabId, selector, args) {
  const box = await elementBox(tabId, selector);
  await cdpClickAt(tabId, box.x, box.y, args);
  cdpRelease(tabId);
  return { clicked: true, via: "cdp", x: box.x, y: box.y, tag: box.tag, text: box.text };
}

async function cdpHover(tabId, selector) {
  const box = await elementBox(tabId, selector);
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: box.x,
    y: box.y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  cdpRelease(tabId);
  return { hovered: true, x: box.x, y: box.y, tag: box.tag, text: box.text };
}

async function cdpType(tabId, selector, text, args) {
  const prep = await execInTab(tabId, pageFocusForType, [selector, args.clear !== false]);
  if (!prep) throw new Error("找不到元素: " + selector);
  if (args.clear !== false) {
    await cdpKey(tabId, "Control+a");
    await cdpKey(tabId, "Backspace");
  } else {
    await cdpKey(tabId, "End");
  }
  const delay = Math.max(0, Math.min(Number(args.delay) || 0, 300));
  if (delay > 0) {
    for (const ch of String(text)) {
      await cdpSend(tabId, "Input.insertText", { text: ch });
      await sleep(delay);
    }
  } else {
    await cdpSend(tabId, "Input.insertText", { text: String(text) });
  }
  if (args.submit) await cdpKey(tabId, "Enter");
  cdpRelease(tabId);
  const value = await execInTab(tabId, pageFieldValue, [selector]);
  return { ok: true, via: "cdp", value: value || "" };
}

/* ================= 網路 / Console / Dialog 緩衝 ================= */

const MAX_NET = 400;
const MAX_CONSOLE = 300;
const netByTab = new Map(); // tabId -> { items:[], inflight:number, on:boolean }
const consoleByTab = new Map(); // tabId -> { items:[], on:boolean }
const dialogsByTab = new Map(); // tabId -> { type, message, defaultPrompt, url, at }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function netState(tabId) {
  let s = netByTab.get(tabId);
  if (!s) {
    s = { items: [], inflight: 0, on: false };
    netByTab.set(tabId, s);
  }
  return s;
}

function consoleState(tabId) {
  let s = consoleByTab.get(tabId);
  if (!s) {
    s = { items: [], on: false };
    consoleByTab.set(tabId, s);
  }
  return s;
}

function pushConsole(tabId, item) {
  const s = consoleState(tabId);
  s.items.push(item);
  if (s.items.length > MAX_CONSOLE) s.items.splice(0, s.items.length - MAX_CONSOLE);
}

/* ================= 操作錄製 ================= */

const recording = { on: false, startedAt: 0, steps: [] };

function recordAdd(ev, tabId) {
  if (!recording.on || !ev) return;
  const step = { ...ev, tabId: tabId || null };
  const last = recording.steps[recording.steps.length - 1];
  if (step.kind === "input" && last && last.kind === "input" && last.selector === step.selector) {
    last.value = step.value;
    last.ts = step.ts;
    return;
  }
  if (step.kind === "navigate" && last && last.kind === "click") last.navigated = true;
  recording.steps.push(step);
  if (recording.steps.length > 500) recording.steps.splice(0, recording.steps.length - 500);
}

async function broadcastRecorder(type) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id || !/^https?:/.test(t.url || "")) continue;
      chrome.tabs.sendMessage(t.id, { type }, () => void chrome.runtime.lastError);
    }
  } catch {}
}

/* ================= 收件匣（右鍵選單 / 面板 → DSH） ================= */

async function pushInbox(item) {
  const payload = { ...item, ts: item.ts || Date.now() / 1000, source: item.source || "extension" };
  try {
    const r = await fetch(BRIDGE_HTTP + "/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.ok) return { ok: true, queued: false };
  } catch {}
  const s = await getSetting(["inboxQueue"]);
  const q = (s.inboxQueue || []).slice(-99);
  q.push(payload);
  await chrome.storage.local.set({ inboxQueue: q });
  return { ok: true, queued: true };
}

async function flushInboxQueue() {
  const s = await getSetting(["inboxQueue"]);
  const q = s.inboxQueue || [];
  if (!q.length) return 0;
  const left = [];
  for (const item of q) {
    try {
      const r = await fetch(BRIDGE_HTTP + "/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      if (!r.ok) left.push(item);
    } catch {
      left.push(item);
      break;
    }
  }
  await chrome.storage.local.set({ inboxQueue: left });
  return q.length - left.length;
}

async function getInbox() {
  try {
    const r = await fetch(BRIDGE_HTTP + "/inbox");
    if (!r.ok) return { ok: false, count: 0, items: [] };
    return await r.json();
  } catch {
    return { ok: false, count: 0, items: [] };
  }
}

async function clearInbox() {
  try {
    const r = await fetch(BRIDGE_HTTP + "/inbox", { method: "DELETE" });
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}

async function bridgeCmd(method, args, timeout) {
  const r = await fetch(BRIDGE_HTTP + "/cmd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args: args || {}, timeout: timeout || 40 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || "bridge 指令失敗: " + method);
  return j.data;
}

async function activeTabSafe() {
  try {
    return await activeTab();
  } catch {
    return null;
  }
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/* ================= CDP 事件 ================= */

function netItem(tabId, requestId) {
  return netState(tabId).items.find((i) => i.id === requestId);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (tabId == null || !params) return;
  try {
    if (method === "Network.requestWillBeSent") {
      const s = netState(tabId);
      s.on = true;
      s.inflight += 1;
      s.items.push({
        id: params.requestId,
        url: (params.request && params.request.url) || "",
        method: (params.request && params.request.method) || "",
        type: params.type || "",
        status: null,
        mimeType: "",
        finished: false,
        failed: false,
        errorText: "",
        bytes: 0,
        startedAt: Date.now(),
        ms: null,
      });
      if (s.items.length > MAX_NET) s.items.splice(0, s.items.length - MAX_NET);
      return;
    }
    if (method === "Network.responseReceived") {
      const it = netItem(tabId, params.requestId);
      if (it) {
        it.status = params.response && params.response.status;
        it.mimeType = (params.response && params.response.mimeType) || "";
      }
      return;
    }
    if (method === "Network.loadingFinished") {
      const s = netState(tabId);
      s.inflight = Math.max(0, s.inflight - 1);
      const it = netItem(tabId, params.requestId);
      if (it) {
        it.finished = true;
        it.bytes = params.encodedDataLength || 0;
        it.ms = Date.now() - it.startedAt;
      }
      return;
    }
    if (method === "Network.loadingFailed") {
      const s = netState(tabId);
      s.inflight = Math.max(0, s.inflight - 1);
      const it = netItem(tabId, params.requestId);
      if (it) {
        it.failed = true;
        it.errorText = params.errorText || "";
        it.ms = Date.now() - it.startedAt;
      }
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args || [])
        .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
        .join(" ");
      pushConsole(tabId, {
        kind: "console",
        level: params.type || "log",
        text: String(text).slice(0, 2000),
        ts: Date.now(),
      });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails || {};
      const ex = d.exception || {};
      pushConsole(tabId, {
        kind: "exception",
        level: "error",
        text: String(ex.description || ex.value || d.text || "").slice(0, 2000),
        url: d.url || "",
        line: d.lineNumber,
        ts: Date.now(),
      });
      return;
    }
    if (method === "Log.entryAdded") {
      const e = params.entry || {};
      pushConsole(tabId, {
        kind: "log",
        level: e.level || "info",
        text: String(e.text || "").slice(0, 2000),
        url: e.url || "",
        ts: Date.now(),
      });
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      dialogsByTab.set(tabId, {
        type: params.type,
        message: params.message || "",
        defaultPrompt: params.defaultPrompt || "",
        url: params.url || "",
        at: Date.now(),
      });
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      dialogsByTab.delete(tabId);
      return;
    }
  } catch {}
});

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) cdpSessions.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cdpSessions.delete(tabId);
  netByTab.delete(tabId);
  consoleByTab.delete(tabId);
  dialogsByTab.delete(tabId);
});

/* ================= WebSocket ================= */

function scheduleReconnect() {
  setTimeout(() => {
    connect().catch(() => {});
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    } catch {}
  }, PING_MS);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

async function helloPayload() {
  const control = await controlEnabled();
  let tab = null;
  try {
    const t = await activeTab();
    tab = { id: t.id, title: t.title, url: t.url };
  } catch {}
  return {
    type: "hello",
    clientId: (clientId = await ensureClientId()),
    version: VERSION,
    control,
    activeTab: tab,
  };
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  wsState = "connecting";
  try {
    ws = new WebSocket(BRIDGE_WS);
  } catch (e) {
    wsState = "disconnected";
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    wsState = "connected";
    reconnectDelay = 500;
    lastError = "";
    try {
      ws.send(JSON.stringify(await helloPayload()));
    } catch {}
    startPing();
    broadcastState();
    flushInboxQueue().catch(() => {});
  };

  ws.onmessage = async (ev) => {
    try {
      await onBridgeMessage(ev.data);
    } catch (e) {
      console.warn("[DSH] message error", e);
    }
  };

  ws.onclose = () => {
    wsState = "disconnected";
    stopPing();
    ws = null;
    broadcastState();
    scheduleReconnect();
  };

  ws.onerror = () => {
    lastError = "WebSocket error";
  };
}

function wsSend(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
  } catch {}
  return false;
}

async function broadcastState() {
  try {
    await chrome.runtime.sendMessage({
      type: "stateUpdate",
      wsState,
      clientId,
      lastError,
    });
  } catch {}
}

async function pushState() {
  wsSend({
    type: "state",
    control: await controlEnabled(),
    activeTab: await (async () => {
      try {
        const t = await activeTab();
        return { id: t.id, title: t.title, url: t.url };
      } catch {
        return null;
      }
    })(),
  });
}

/* ================= 收到指令 ================= */

async function onBridgeMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "pong") return;
  if (msg.type === "welcome") {
    clientId = msg.clientId || clientId;
    return;
  }
  if (msg.type === "cmd") {
    const started = Date.now();
    recentCmds.unshift({ method: msg.method, at: started });
    recentCmds.splice(12);
    try {
      const data = await run(msg.method, msg.args || {});
      wsSend({ type: "result", id: msg.id, ok: true, data: jsonSafe(data) });
    } catch (e) {
      wsSend({
        type: "result",
        id: msg.id,
        ok: false,
        error: String((e && e.message) || e),
      });
    }
  }
}

/* ================= 執行指令 ================= */

const READ_ONLY = new Set([
  "status",
  "tabs.list",
  "tabs.active",
  "tabs.groups",
  "page.info",
  "page.text",
  "page.markdown",
  "page.links",
  "page.images",
  "page.html",
  "page.screenshot",
  "page.wait",
  "page.waitFor",
  "page.read",
  "page.ax",
  "page.controls",
  "page.pdf",
  "network.list",
  "console.get",
  "dialog.list",
  "cookies.get",
  "history.search",
  "bookmarks.search",
  "downloads.list",
  "record.status",
  "inbox.push",
]);

async function requireControl(method) {
  if (READ_ONLY.has(method)) return;
  if (!(await controlEnabled())) {
    throw new Error("控制模式未開啟：請在 DSH Bridge popup 勾選「允許 agent 操作此瀏覽器」");
  }
}

/* ---------- 無障礙樹壓縮 ---------- */

function propsToObj(props) {
  const o = {};
  const keep = [
    "focusable",
    "focused",
    "disabled",
    "checked",
    "expanded",
    "selected",
    "required",
    "readonly",
    "multiline",
    "level",
    "valuemin",
    "valuemax",
    "valuetext",
    "hasPopup",
    "autocomplete",
  ];
  for (const p of props || []) {
    const k = p && p.name;
    if (!k || !keep.includes(k)) continue;
    const v = p.value && (p.value.value !== undefined ? p.value.value : p.value.type);
    if (v !== undefined) o[k] = v;
  }
  return o;
}

function compressAx(nodes, limit) {
  if (!Array.isArray(nodes)) return { count: 0, nodes: [] };
  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);
  const depthOf = (n) => {
    let d = 0;
    let cur = n;
    while (cur && cur.parentId && byId.has(cur.parentId) && d < 80) {
      cur = byId.get(cur.parentId);
      d++;
    }
    return d;
  };
  const out = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = (n.role && n.role.value) || "";
    const name = (n.name && n.name.value) || "";
    const value = n.value && n.value.value;
    const desc = (n.description && n.description.value) || "";
    if (!role) continue;
    if (/^(none|generic|InlineTextBox)$/.test(role) && !name && (value === undefined || value === "") && !desc) continue;
    out.push({
      role,
      ...(name ? { name: String(name).slice(0, 200) } : {}),
      ...(value !== undefined && value !== "" ? { value: String(value).slice(0, 200) } : {}),
      ...(desc ? { description: String(desc).slice(0, 200) } : {}),
      ...propsToObj(n.properties),
      ...(n.backendDOMNodeId ? { backendNodeId: n.backendDOMNodeId } : {}),
      depth: depthOf(n),
    });
    if (out.length >= limit) break;
  }
  return { count: out.length, nodes: out };
}

/* ---------- 等待條件 ---------- */

async function waitForCondition(tabId, args) {
  const timeout = Math.min(Number(args.timeout) || 10000, 120000);
  const poll = Math.max(Number(args.poll) || 250, 100);
  const started = Date.now();
  const mode = args.selector
    ? "selector"
    : args.text
    ? "text"
    : args.url
    ? "url"
    : args.networkIdle
    ? "networkIdle"
    : "";
  if (!mode) throw new Error("waitFor 需要 selector / text / url / networkIdle 其中之一");
  if (mode === "networkIdle" && !netState(tabId).on) {
    await cdpEnable(tabId, "Network", {}, true);
  }
  let last = null;
  while (Date.now() - started <= timeout) {
    if (mode === "selector") {
      last = await execInTab(tabId, pageWaitSelector, [args.selector, args.visible !== false]);
    } else if (mode === "text") {
      last = await execInTab(tabId, pageWaitText, [String(args.text)]);
    } else if (mode === "url") {
      last = await execInTab(tabId, pageWaitUrl, [String(args.url)]);
    } else {
      const inflight = netState(tabId).inflight;
      last = { found: inflight === 0, inflight };
    }
    if (last && last.found) return { ...last, waited: Date.now() - started, timeout, mode };
    await sleep(poll);
  }
  return { found: false, waited: Date.now() - started, timeout, mode, last: last || null };
}

async function run(method, args) {
  await requireControl(method);

  switch (method) {
    /* ---------- 基本 ---------- */
    case "status": {
      let tab = null;
      try {
        tab = tabBrief(await activeTab());
      } catch {}
      return {
        version: VERSION,
        wsState,
        clientId,
        control: await controlEnabled(),
        activeTab: tab,
        recentCmds: recentCmds.slice(0, 8),
      };
    }

    case "tabs.list": {
      const tabs = await chrome.tabs.query(args.windowId ? { windowId: args.windowId } : {});
      return { count: tabs.length, tabs: tabs.map(tabBrief) };
    }

    case "tabs.active": {
      return tabBrief(await activeTab());
    }

    case "tabs.open": {
      if (!args.url) throw new Error("需要 url");
      let t;
      try {
        t = await chrome.tabs.create({ url: args.url, active: args.active !== false });
      } catch (e) {
        // Edge 只剩背景進程、沒有任何視窗時，tabs.create 會 "No current window"
        if (!/no current window/i.test(String((e && e.message) || e))) throw e;
        const w = await chrome.windows.create({ url: args.url, focused: true });
        t = (w.tabs && w.tabs[0]) || (await activeTab());
      }
      return tabBrief(t);
    }

    case "tabs.close": {
      const t = await tabById(args.tabId);
      await chrome.tabs.remove(t.id);
      return { closed: t.id, title: t.title };
    }

    case "tabs.activate": {
      const t = await tabById(args.tabId);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return tabBrief(t);
    }

    case "focus": {
      const win = await chrome.windows.getLastFocused();
      await chrome.windows.update(win.id, { focused: true });
      return { focused: true, windowId: win.id };
    }

    /* ---------- 頁面讀取 ---------- */
    case "page.info": {
      const t = await tabById(args.tabId);
      const info = await execInTab(t.id, pageGetInfo);
      return { tabId: t.id, ...info };
    }

    case "page.text": {
      const t = await tabById(args.tabId);
      const text = await execInTab(t.id, pageGetText);
      const max = args.max || 200000;
      return {
        tabId: t.id,
        url: t.url,
        title: t.title,
        length: (text || "").length,
        truncated: (text || "").length > max,
        text: (text || "").slice(0, max),
      };
    }

    case "page.markdown": {
      const t = await tabById(args.tabId);
      const md = await execInTab(t.id, pageToMarkdown);
      const max = args.max || 200000;
      return {
        tabId: t.id,
        url: t.url,
        title: t.title,
        length: (md || "").length,
        truncated: (md || "").length > max,
        markdown: (md || "").slice(0, max),
      };
    }

    case "page.links": {
      const t = await tabById(args.tabId);
      const links = await execInTab(t.id, pageGetLinks, [args.limit || 300]);
      return { tabId: t.id, count: (links || []).length, links };
    }

    case "page.images": {
      const t = await tabById(args.tabId);
      const images = await execInTab(t.id, pageGetImages, [args.limit || 200]);
      return { tabId: t.id, count: (images || []).length, images };
    }

    case "page.html": {
      const t = await tabById(args.tabId);
      const html = await execInTab(t.id, pageGetHtml);
      const max = args.max || 300000;
      return {
        tabId: t.id,
        length: (html || "").length,
        truncated: (html || "").length > max,
        html: (html || "").slice(0, max),
      };
    }

    case "page.screenshot": {
      const t = await tabById(args.tabId);
      const format = args.format === "jpeg" ? "jpeg" : "png";
      const quality = format === "jpeg" ? Number(args.quality) || 80 : undefined;
      if (args.selector || args.fullPage) {
        // CDP 截圖：元素截圖 / 整頁截圖
        await cdpEnable(t.id, "Page");
        let clip;
        if (args.selector) {
          const box = await elementBox(t.id, args.selector);
          clip = {
            x: box.x - box.width / 2,
            y: box.y - box.height / 2,
            width: box.width,
            height: box.height,
            scale: 1,
          };
        } else {
          const m = await cdpSend(t.id, "Page.getLayoutMetrics");
          const size = m.cssContentSize || m.contentSize;
          clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
        }
        const shot = await cdpSend(t.id, "Page.captureScreenshot", {
          format,
          quality,
          clip,
          captureBeyondViewport: !!args.fullPage,
          fromSurface: true,
        });
        cdpRelease(t.id);
        return {
          tabId: t.id,
          url: t.url,
          selector: args.selector || null,
          clip,
          dataUrl: "data:image/" + format + ";base64," + shot.data,
        };
      }
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      await sleep(250);
      const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format, quality });
      return { tabId: t.id, url: t.url, dataUrl };
    }

    case "page.wait": {
      const ms = Math.min(Number(args.ms) || 1000, 30000);
      await sleep(ms);
      return { waited: ms };
    }

    case "page.waitFor": {
      const t = await tabById(args.tabId);
      return await waitForCondition(t.id, args);
    }

    /* ---------- 頁面讀取強化 ---------- */

    case "page.read": {
      const t = await tabById(args.tabId);
      const data = await execInTab(t.id, pageReadAll, [
        {
          maxChars: Math.min(Number(args.max) || 200000, 800000),
          maxScreens: Math.min(Number(args.screens) || 40, 200),
          stepMs: Math.max(Number(args.stepMs) || 160, 0),
          start: Math.max(Number(args.start) || 0, 0),
          budgetMs: Math.min(Number(args.budgetMs) || 6000, 20000),
        },
      ]);
      return { tabId: t.id, url: t.url, title: t.title, ...(data || { text: "" }) };
    }

    case "page.ax": {
      const t = await tabById(args.tabId);
      await cdpEnable(t.id, "Accessibility");
      const { nodes } = await cdpSend(t.id, "Accessibility.getFullAXTree");
      cdpRelease(t.id);
      return { tabId: t.id, url: t.url, ...compressAx(nodes, Math.min(Number(args.max) || 600, 3000)) };
    }

    case "page.controls": {
      const t = await tabById(args.tabId);
      const limit = Math.min(Number(args.limit) || 60, 300);
      if (args.allFrames === false) {
        const list = await execInTab(t.id, pageScanControls, [limit]);
        return { tabId: t.id, url: t.url, count: (list || []).length, controls: list || [] };
      }
      const results = await execInAllFrames(t.id, pageScanControls, [limit]);
      const merged = [];
      for (const r of results) {
        for (const c of r.result || []) merged.push({ ...c, frameId: r.frameId });
      }
      const controls = merged.slice(0, 300).map((c, i) => ({ ...c, index: i }));
      return { tabId: t.id, url: t.url, frames: results.length, count: controls.length, controls };
    }

    /* ---------- 頁面操作（需控制模式） ---------- */
    case "page.click": {
      if (!args.selector) throw new Error("需要 selector");
      const t = await tabById(args.tabId);
      if (args.frameId !== undefined && args.frameId !== null) {
        const r = await execInFrame(t.id, args.frameId, pageClick, [args.selector]);
        if (!r || r.ok === false) throw new Error((r && r.error) || "點擊失敗");
        return r;
      }
      if (args.dom === true) {
        const r = await execInTab(t.id, pageClick, [args.selector]);
        if (!r || r.ok === false) throw new Error((r && r.error) || "點擊失敗");
        return r;
      }
      return await cdpClick(t.id, args.selector, args);
    }

    case "page.type": {
      if (!args.selector) throw new Error("需要 selector");
      const t = await tabById(args.tabId);
      if (args.frameId !== undefined && args.frameId !== null) {
        const r = await execInFrame(t.id, args.frameId, pageType, [
          args.selector,
          String(args.text ?? ""),
          args.clear !== false,
        ]);
        if (!r || r.ok === false) throw new Error((r && r.error) || "輸入失敗");
        return r;
      }
      if (args.dom === true) {
        const r = await execInTab(t.id, pageType, [
          args.selector,
          String(args.text ?? ""),
          args.clear !== false,
        ]);
        if (!r || r.ok === false) throw new Error((r && r.error) || "輸入失敗");
        return r;
      }
      return await cdpType(t.id, args.selector, String(args.text ?? ""), args);
    }

    case "page.press": {
      if (!args.keys) throw new Error("需要 keys，例如 Enter / Control+A");
      const t = await tabById(args.tabId);
      if (args.selector) await execInTab(t.id, pageFocusForType, [args.selector, false]);
      await cdpKey(t.id, args.keys);
      cdpRelease(t.id);
      return { pressed: args.keys, via: "cdp" };
    }

    case "page.hover": {
      if (!args.selector) throw new Error("需要 selector");
      const t = await tabById(args.tabId);
      return await cdpHover(t.id, args.selector);
    }

    case "page.select": {
      if (!args.selector) throw new Error("需要 selector 與 value");
      const t = await tabById(args.tabId);
      const r = await execInTab(t.id, pageSelectOption, [args.selector, String(args.value ?? "")]);
      if (!r || r.ok === false) throw new Error((r && r.error) || "選項設定失敗");
      return r;
    }

    case "page.pdf": {
      const t = await tabById(args.tabId);
      await cdpEnable(t.id, "Page");
      const out = await cdpSend(t.id, "Page.printToPDF", {
        printBackground: args.background !== false,
        preferCSSPageSize: true,
        landscape: !!args.landscape,
        scale: Number(args.scale) || 1,
      });
      cdpRelease(t.id);
      const b64 = out.data || "";
      return {
        tabId: t.id,
        url: t.url,
        format: "pdf",
        base64: b64,
        bytes: Math.floor((b64.length * 3) / 4),
      };
    }

    /* ---------- 網路 / Console / Dialog ---------- */

    case "network.start": {
      const t = await tabById(args.tabId);
      netByTab.set(t.id, { items: [], inflight: 0, on: true });
      await cdpEnable(t.id, "Network", {}, true);
      return { tabId: t.id, started: true };
    }

    case "network.list": {
      const t = await tabById(args.tabId);
      const s = netState(t.id);
      const max = Math.min(Number(args.max) || 50, 400);
      return {
        tabId: t.id,
        enabled: s.on,
        inflight: s.inflight,
        count: s.items.length,
        items: s.items.slice(-max).map((i) => ({ ...i, startedAt: new Date(i.startedAt).toISOString() })),
      };
    }

    case "network.clear": {
      const t = await tabById(args.tabId);
      const s = netState(t.id);
      s.items = [];
      s.inflight = 0;
      return { tabId: t.id, cleared: true };
    }

    case "network.stop": {
      const t = await tabById(args.tabId);
      const s = netState(t.id);
      s.on = false;
      s.items = [];
      s.inflight = 0;
      cdpRelease(t.id);
      return { tabId: t.id, stopped: true };
    }

    case "console.start": {
      const t = await tabById(args.tabId);
      consoleState(t.id).on = true;
      await cdpEnable(t.id, "Runtime", {}, true);
      await cdpEnable(t.id, "Log", {}, true);
      return { tabId: t.id, started: true };
    }

    case "console.get": {
      const t = await tabById(args.tabId);
      const s = consoleState(t.id);
      const max = Math.min(Number(args.max) || 50, 300);
      return {
        tabId: t.id,
        enabled: s.on,
        count: s.items.length,
        items: s.items.slice(-max),
      };
    }

    case "console.clear": {
      const t = await tabById(args.tabId);
      consoleState(t.id).items = [];
      return { tabId: t.id, cleared: true };
    }

    case "console.stop": {
      const t = await tabById(args.tabId);
      const s = consoleState(t.id);
      s.on = false;
      s.items = [];
      cdpRelease(t.id);
      return { tabId: t.id, stopped: true };
    }

    case "dialog.list": {
      const t = await tabById(args.tabId);
      // 先啟用 Page domain，才會收到 javascriptDialogOpening 事件
      await cdpEnable(t.id, "Page");
      return { tabId: t.id, dialog: dialogsByTab.get(t.id) || null };
    }

    case "dialog.accept": {
      const t = await tabById(args.tabId);
      await cdpEnable(t.id, "Page");
      await cdpSend(t.id, "Page.handleJavaScriptDialog", {
        accept: true,
        promptText: args.text === undefined ? undefined : String(args.text),
      });
      dialogsByTab.delete(t.id);
      cdpRelease(t.id);
      return { tabId: t.id, accepted: true };
    }

    case "dialog.dismiss": {
      const t = await tabById(args.tabId);
      await cdpEnable(t.id, "Page");
      await cdpSend(t.id, "Page.handleJavaScriptDialog", { accept: false });
      dialogsByTab.delete(t.id);
      cdpRelease(t.id);
      return { tabId: t.id, dismissed: true };
    }

    /* ---------- 分頁群組 / 錄製 / 收件匣 ---------- */

    case "tabs.groups": {
      const groups = await chrome.tabGroups.query(args.windowId ? { windowId: args.windowId } : {});
      return {
        count: groups.length,
        groups: groups.map((g) => ({
          id: g.id,
          title: g.title || "",
          color: g.color,
          collapsed: g.collapsed,
          windowId: g.windowId,
        })),
      };
    }

    case "tabs.group": {
      const ids = Array.isArray(args.tabIds) && args.tabIds.length
        ? args.tabIds
        : [args.tabId ? Number(args.tabId) : (await activeTab()).id];
      const opts = { tabIds: ids };
      if (args.windowId) opts.createProperties = { windowId: args.windowId };
      const groupId = await chrome.tabs.group(opts);
      if (args.title || args.color || args.collapsed !== undefined) {
        await chrome.tabGroups.update(groupId, {
          ...(args.title ? { title: String(args.title) } : {}),
          ...(args.color ? { color: args.color } : {}),
          ...(args.collapsed !== undefined ? { collapsed: !!args.collapsed } : {}),
        });
      }
      return { groupId, tabIds: ids, title: args.title || "" };
    }

    case "tabs.ungroup": {
      const ids = Array.isArray(args.tabIds) && args.tabIds.length ? args.tabIds : [];
      if (!ids.length) throw new Error("需要 tabIds");
      await chrome.tabs.ungroup(ids);
      return { ungrouped: ids };
    }

    case "record.start": {
      recording.on = true;
      recording.startedAt = Date.now();
      recording.steps = [];
      await broadcastRecorder("rec:start");
      return { started: true, at: recording.startedAt };
    }

    case "record.stop": {
      recording.on = false;
      await broadcastRecorder("rec:stop");
      const steps = recording.steps.slice();
      return {
        startedAt: recording.startedAt,
        duration: Date.now() - recording.startedAt,
        count: steps.length,
        steps,
      };
    }

    case "record.status": {
      return {
        on: recording.on,
        startedAt: recording.startedAt,
        duration: recording.on ? Date.now() - recording.startedAt : 0,
        count: recording.steps.length,
      };
    }

    case "inbox.push": {
      return await pushInbox(args || {});
    }

    case "page.scroll": {
      const t = await tabById(args.tabId);
      return await execInTab(t.id, pageScroll, [Number(args.by) || 600]);
    }

    case "page.eval": {
      if (!args.expression) throw new Error("需要 expression");
      const t = await tabById(args.tabId);
      // MV3 隔離世界的 CSP 禁止 eval，改在頁面主世界（MAIN world）求值
      const r = await execInTab(t.id, pageEval, [String(args.expression)], "MAIN");
      if (!r) {
        return {
          result: null,
          warning: "eval 沒有回傳值（頁面可能禁止 eval，或結果不可序列化）",
        };
      }
      if (r.ok === false) throw new Error("eval 失敗: " + r.error);
      return { result: r.value };
    }

    /* ---------- Cookie ---------- */
    case "cookies.get": {
      const host = await resolveCookieHost(args.domain);
      const cookies = await collectCookies(host).catch(() => []);
      const briefs = cookies.map(cookieBrief);
      if (args.save !== false) {
        try {
          await fetch(BRIDGE_HTTP + "/cookies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              origin: "https://" + host,
              hostname: host,
              exportedAt: new Date().toISOString(),
              count: briefs.length,
              cookies: briefs,
            }),
          });
        } catch {}
      }
      return { host, count: briefs.length, cookies: briefs };
    }

    case "cookies.set": {
      if (!args.url || !args.name) throw new Error("需要 url 與 name");
      const c = await chrome.cookies.set({
        url: args.url,
        name: args.name,
        value: String(args.value ?? ""),
        domain: args.domain,
        path: args.path || "/",
        secure: !!args.secure,
        httpOnly: !!args.httpOnly,
        expirationDate: args.expirationDate,
        sameSite: args.sameSite,
      });
      if (!c) throw new Error("設定 cookie 失敗（可能網域不符）");
      return { ok: true, name: c.name, domain: c.domain };
    }

    /* ---------- 瀏覽器資料 ---------- */
    case "history.search": {
      const items = await chrome.history.search({
        text: args.text || "",
        maxResults: Math.min(Number(args.max) || 20, 500),
        startTime: Number(args.since) || 0,
      });
      return {
        count: items.length,
        items: items.map((i) => ({
          url: i.url,
          title: i.title,
          lastVisitTime: i.lastVisitTime,
          visitCount: i.visitCount,
        })),
      };
    }

    case "bookmarks.search": {
      const items = await chrome.bookmarks.search(args.query || {});
      const max = Math.min(Number(args.max) || 50, 500);
      return {
        count: items.length,
        items: items.slice(0, max).map((b) => ({
          id: b.id,
          title: b.title,
          url: b.url || null,
          isFolder: !b.url,
        })),
      };
    }

    case "downloads.list": {
      const items = await chrome.downloads.search({
        limit: Math.min(Number(args.max) || 20, 200),
        orderBy: ["-startTime"],
      });
      return {
        count: items.length,
        items: items.map((d) => ({
          id: d.id,
          filename: d.filename,
          url: d.url,
          state: d.state,
          bytesReceived: d.bytesReceived,
          totalBytes: d.totalBytes,
          startTime: d.startTime,
        })),
      };
    }

    default:
      throw new Error("未知指令: " + method);
  }
}

/* ================= 頁面內執行函式（不可捕獲外部變數） ================= */

function pageGetInfo() {
  const sel = window.getSelection ? String(window.getSelection()) : "";
  const meta = document.querySelector('meta[name="description"]');
  return {
    title: document.title,
    url: location.href,
    selection: sel.slice(0, 5000),
    description: meta ? meta.content : "",
    h1: (document.querySelector("h1") || {}).innerText || "",
    lang: document.documentElement.lang || "",
    textLength: (document.body ? document.body.innerText : "").length,
  };
}

function pageGetText() {
  return document.body ? document.body.innerText : "";
}

function pageGetHtml() {
  return document.documentElement.outerHTML;
}

function pageGetLinks(limit) {
  const seen = new Set();
  const out = [];
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href;
    if (!href || seen.has(href)) return;
    seen.add(href);
    out.push({ text: (a.innerText || "").trim().slice(0, 160), href });
  });
  return out.slice(0, limit || 300);
}

function pageGetImages(limit) {
  return [...document.images].slice(0, limit || 200).map((i) => ({
    alt: i.alt || "",
    src: i.currentSrc || i.src,
    w: i.naturalWidth,
    h: i.naturalHeight,
  }));
}

function pageToMarkdown() {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "IFRAME"]);
  const lines = [];

  function inline(el) {
    let out = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        out += n.nodeValue.replace(/\s+/g, " ");
      } else if (n.nodeType === 1) {
        const tag = n.tagName;
        if (skip.has(tag)) return;
        if (tag === "A") {
          out += "[" + (n.innerText || n.href).trim() + "](" + n.href + ")";
        } else if (tag === "CODE") {
          out += "`" + n.innerText + "`";
        } else if (tag === "STRONG" || tag === "B") {
          out += "**" + (n.innerText || "") + "**";
        } else if (tag === "EM" || tag === "I") {
          out += "*" + (n.innerText || "") + "*";
        } else if (tag === "BR") {
          out += "\n";
        } else {
          out += inline(n);
        }
      }
    });
    return out;
  }

  function walk(el) {
    el.childNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (skip.has(tag)) return;
      if (/^H[1-6]$/.test(tag)) {
        const t = inline(n).trim();
        if (t) {
          lines.push("#".repeat(Number(tag[1])) + " " + t);
          lines.push("");
        }
      } else if (tag === "P") {
        const t = inline(n).trim();
        if (t) {
          lines.push(t);
          lines.push("");
        }
      } else if (tag === "LI") {
        const t = inline(n).trim();
        if (t) lines.push("- " + t);
      } else if (tag === "PRE") {
        lines.push("```");
        lines.push(n.innerText);
        lines.push("```");
        lines.push("");
      } else if (tag === "IMG") {
        if (n.src) lines.push("![" + (n.alt || "") + "](" + n.src + ")");
      } else if (tag === "UL" || tag === "OL") {
        walk(n);
        lines.push("");
      } else if (
        ["DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "TABLE", "TBODY", "TR", "TD", "TH"].includes(tag)
      ) {
        walk(n);
      } else {
        const t = inline(n).trim();
        if (t) {
          lines.push(t);
          lines.push("");
        }
      }
    });
  }

  walk(document.body || document.documentElement);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pageClick(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: "找不到元素: " + selector };
  try {
    el.scrollIntoView({ block: "center" });
    el.click();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  return { ok: true, clicked: true, tag: el.tagName, text: (el.innerText || "").slice(0, 120) };
}

function pageType(selector, text, clear) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: "找不到元素: " + selector };
  try {
    el.focus();
    if (el.isContentEditable) {
      if (clear) el.textContent = "";
      el.textContent += text;
    } else {
      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, (clear ? "" : el.value) + text);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  return { ok: true, value: el.value !== undefined ? String(el.value).slice(0, 300) : "" };
}

function pageScroll(px) {
  window.scrollBy(0, px);
  return {
    scrollY: window.scrollY,
    height: document.documentElement.scrollHeight,
  };
}

function pageEval(expr) {
  try {
    const value = (0, eval)(expr);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ================= 新頁面內函式（不可捕獲外部變數） ================= */

// 回傳元素中心點（viewport 座標）與可見性；順便捲到視窗中央
function pageBoxOf(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  try {
    el.scrollIntoView({ block: "center", inline: "center" });
  } catch {}
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  const visible =
    r.width > 0 &&
    r.height > 0 &&
    st.visibility !== "hidden" &&
    st.display !== "none" &&
    Number(st.opacity) > 0;
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    width: Math.round(r.width),
    height: Math.round(r.height),
    visible,
    tag: el.tagName,
    text: (el.innerText || el.value || el.getAttribute("aria-label") || "").toString().slice(0, 80),
  };
}

// 聚焦到欄位（CDP 打字前用）；回傳欄位資訊
function pageFocusForType(selector, clear) {
  const el = document.querySelector(selector);
  if (!el) return null;
  try {
    el.focus();
  } catch {}
  if (clear && el.isContentEditable) el.textContent = "";
  return {
    tag: el.tagName,
    contentEditable: !!el.isContentEditable,
    value: el.value !== undefined ? String(el.value) : "",
  };
}

function pageFieldValue(selector) {
  const el = document.querySelector(selector);
  if (!el) return "";
  const v = el.value !== undefined ? el.value : el.textContent;
  return String(v || "").slice(0, 300);
}

function pageSelectOption(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: "找不到元素: " + selector };
  if ((el.tagName || "").toUpperCase() !== "SELECT") {
    return { ok: false, error: "不是 select 元素: " + selector };
  }
  const opts = [...el.options];
  const target =
    opts.find((o) => o.value === value) ||
    opts.find((o) => (o.label || o.text || "").trim() === String(value).trim()) ||
    (/^\d+$/.test(String(value)) ? opts[Number(value)] : null);
  if (!target) return { ok: false, error: "找不到選項: " + value };
  el.value = target.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: el.value, label: (target.label || target.text || "").trim() };
}

// 掃描可互動元素，附穩定 selector 與座標（給純文字 agent 判斷「能點什麼」）
function pageScanControls(limit) {
  const MAX = limit || 60;
  const toPath = (el) => {
    if (!el || el.nodeType !== 1) return "";
    try {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return "#" + CSS.escape(el.id);
    } catch {}
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 6) {
      let sel = node.tagName ? node.tagName.toLowerCase() : "";
      if (!sel) break;
      try {
        if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
          parts.unshift("#" + CSS.escape(node.id));
          break;
        }
        const cls = [...(node.classList || [])]
          .filter((c) => /^[A-Za-z_][\w-]*$/.test(c))
          .slice(0, 2);
        if (cls.length) sel += "." + cls.map((c) => CSS.escape(c)).join(".");
        const parent = node.parentElement;
        if (parent) {
          const sibs = [...parent.children].filter((s) => s.tagName === node.tagName);
          if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
        }
      } catch {}
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const labelOf = (el) => {
    const t = (el.innerText || "").trim();
    if (t) return t.replace(/\s+/g, " ").slice(0, 100);
    return String(
      el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.value ||
        el.name ||
        el.id ||
        ""
    ).slice(0, 100);
  };
  const SEL =
    "a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=''],[contenteditable='true'],[tabindex]:not([tabindex='-1']),[onclick]";
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= MAX) break;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width <= 1 || r.height <= 1) continue;
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
    out.push({
      index: out.length,
      tag: (el.tagName || "").toLowerCase(),
      role: el.getAttribute("role") || "",
      type: el.type || "",
      text: labelOf(el),
      value: el.value !== undefined ? String(el.value).slice(0, 80) : "",
      checked: el.checked,
      disabled: !!el.disabled,
      visible: r.bottom > 0 && r.top < window.innerHeight,
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      selector: toPath(el),
    });
  }
  return out;
}

// 滾動收集全文：處理延遲載入 / 無限捲動 / 內部滾動容器 / shadow DOM
async function pageReadAll(opts) {
  const conf = opts || {};
  const maxChars = conf.maxChars || 200000;
  const maxScreens = conf.maxScreens || 40;
  const stepMs = conf.stepMs === undefined ? 160 : conf.stepMs;
  const start = conf.start || 0;
  const budgetMs = conf.budgetMs || 6000;
  const t0 = Date.now();
  const wait = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const vh = window.innerHeight || 800;
  const doc = document.scrollingElement || document.documentElement;
  let scroller = doc;
  if (!(doc && doc.scrollHeight > vh + 2)) {
    let best = doc ? doc.scrollHeight : 0;
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight <= el.clientHeight + 80) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 120 || r.width < 160) continue;
      const score = r.width * r.height;
      if (score > best) {
        best = score;
        scroller = el;
      }
    }
  }
  const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
  const getText = () => {
    const root = isDoc ? document.body : scroller;
    let txt = root ? root.innerText || "" : "";
    const extras = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.shadowRoot) extras.push(el.shadowRoot.textContent || "");
    }
    if (extras.length) txt += "\n" + extras.join("\n");
    return txt;
  };
  const seen = new Set();
  const lines = [];
  let chars = 0;
  let screens = 0;
  let complete = false;
  const viewSize = () => (isDoc ? window.innerHeight : scroller.clientHeight);
  const collect = () => {
    let added = 0;
    for (const line of getText().split("\n")) {
      const t = line.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      lines.push(t);
      chars += t.length + 1;
      added++;
    }
    return added;
  };
  const orig = scroller.scrollTop;
  scroller.scrollTop = 0;
  await wait(stepMs);
  collect();
  const step = Math.max(200, Math.round(viewSize() * 0.85));
  for (; screens < maxScreens; screens++) {
    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    await wait(stepMs);
    collect();
    if (chars >= start + maxChars) {
      complete = true;
      break;
    }
    const atBottom = scroller.scrollTop + viewSize() >= scroller.scrollHeight - 2;
    if (atBottom) {
      await wait(Math.max(stepMs, 80));
      collect();
      complete = true;
      break;
    }
    if (scroller.scrollTop === before) {
      complete = true;
      break;
    }
    if (Date.now() - t0 > budgetMs) break;
  }
  scroller.scrollTop = orig;
  const all = lines.join("\n");
  const text = all.slice(start, start + maxChars);
  const truncated = start + text.length < all.length;
  return {
    text,
    chars: text.length,
    totalChars: all.length,
    screens,
    complete: complete && !truncated,
    truncated,
    nextStart: truncated ? start + text.length : null,
    container: isDoc ? "document" : (scroller.tagName || "element"),
  };
}

function pageWaitSelector(selector, visible) {
  const el = document.querySelector(selector);
  if (!el) return { found: false };
  if (visible) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const vis =
      r.width > 0 &&
      r.height > 0 &&
      st.visibility !== "hidden" &&
      st.display !== "none" &&
      Number(st.opacity) > 0;
    if (!vis) return { found: false, attached: true };
  }
  return { found: true, text: (el.innerText || "").slice(0, 120) };
}

function pageWaitText(text) {
  const body = document.body ? document.body.innerText || "" : "";
  return { found: body.includes(String(text)) };
}

function pageWaitUrl(substr) {
  return { found: String(location.href).includes(String(substr)) };
}

/* ================= popup / 舊介面 ================= */

function toNetscape(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# Generated by DSH Bridge", ""];
  for (const c of cookies) {
    const domain = c.domain;
    lines.push(
      [
        domain,
        domain.startsWith(".") ? "TRUE" : "FALSE",
        c.path || "/",
        c.secure ? "TRUE" : "FALSE",
        String(c.expirationDate ? Math.floor(c.expirationDate) : 0),
        c.name,
        c.value,
      ].join("\t")
    );
  }
  return lines.join("\n") + "\n";
}

async function pushCookies(cookies, origin) {
  const body = {
    origin,
    hostname: new URL(origin).hostname,
    exportedAt: new Date().toISOString(),
    count: cookies.length,
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate || null,
    })),
  };
  try {
    const r = await fetch(BRIDGE_HTTP + "/cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };
    return { ok: true, result: await r.json() };
  } catch (e) {
    return { ok: false, error: "bridge 未啟動：" + String(e) };
  }
}

async function bridgeHealth() {
  try {
    const r = await fetch(BRIDGE_HTTP + "/health");
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };
    return { ok: true, info: await r.json() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "status": {
          const health = await bridgeHealth();
          sendResponse({
            ok: health.ok,
            info: health.info,
            wsState,
            clientId,
            control: await controlEnabled(),
            version: VERSION,
            lastError,
          });
          return;
        }
        case "sync": {
          const tab = await activeTab();
          const cookies = await chrome.cookies.getAll({ url: tab.url });
          if (!cookies.length) {
            sendResponse({ ok: false, error: "這個網站沒有 cookie（或尚未登入）" });
            return;
          }
          const res = await pushCookies(cookies, tab.url);
          sendResponse({ ...res, count: cookies.length, origin: tab.url });
          return;
        }
        case "download": {
          const tab = await activeTab();
          const cookies = await chrome.cookies.getAll({ url: tab.url });
          const host = new URL(tab.url).hostname.replace(/^www\./, "");
          const txt = toNetscape(cookies);
          const url =
            "data:text/plain;charset=utf-8;base64," +
            btoa(unescape(encodeURIComponent(txt)));
          await chrome.downloads.download({
            url,
            filename: "dsh-cookies-" + host + ".txt",
            saveAs: true,
          });
          sendResponse({ ok: true, count: cookies.length, host });
          return;
        }
        case "setControl": {
          await chrome.storage.local.set({ controlMode: !!msg.enabled });
          await pushState();
          sendResponse({ ok: true, enabled: !!msg.enabled });
          return;
        }
        case "getControl": {
          sendResponse({ ok: true, enabled: await controlEnabled() });
          return;
        }
        case "reconnect": {
          try {
            if (ws) ws.close();
          } catch {}
          ws = null;
          wsState = "disconnected";
          await connect();
          sendResponse({ ok: true, wsState });
          return;
        }
        case "panelState": {
          const tab = await activeTabSafe();
          const inbox = await getInbox();
          sendResponse({
            ok: true,
            wsState,
            version: VERSION,
            lastError,
            control: await controlEnabled(),
            recording: recording.on,
            tab: tab
              ? { id: tab.id, title: tab.title, url: tab.url, host: hostOfUrl(tab.url) }
              : null,
            recentCmds: recentCmds.slice(0, 10),
            inbox,
          });
          return;
        }
        case "panelAction": {
          const action = msg.action;
          const tab = await activeTabSafe();
          if (!tab) {
            sendResponse({ ok: false, error: "沒有作用中的分頁" });
            return;
          }
          if (action === "read") {
            const d = await bridgeCmd("page.read", { tabId: tab.id, max: 20000 });
            sendResponse({ ok: true, chars: d.totalChars, output: d.text || "" });
            return;
          }
          if (action === "shot") {
            const d = await bridgeCmd("page.screenshot", { tabId: tab.id });
            sendResponse({
              ok: true,
              message: "截圖已存到 bridge",
              output: JSON.stringify({ path: d.path, bytes: d.bytes }),
            });
            return;
          }
          if (action === "controls") {
            const d = await bridgeCmd("page.controls", { tabId: tab.id, limit: 20 });
            const lines = (d.controls || []).map(
              (c, i) => i + 1 + ". <" + c.tag + "> " + (c.text || "(無文字)") + "  " + c.selector
            );
            sendResponse({
              ok: true,
              output: "可互動元素 " + (d.count || 0) + " 個：\n" + lines.join("\n"),
            });
            return;
          }
          if (action === "send") {
            const res = await pushInbox({
              kind: "page",
              url: tab.url,
              title: tab.title,
              source: "panel",
            });
            sendResponse({
              ok: true,
              message: res.queued ? "bridge 離線，已存本機佇列" : "已送給 DSH",
            });
            return;
          }
          if (action === "clearInbox") {
            const res = await clearInbox();
            sendResponse({
              ok: res.ok,
              message: res.ok ? "收件匣已清空" : "清除失敗（bridge 未連線？）",
            });
            return;
          }
          if (action === "recordStart") {
            await run("record.start", {});
            sendResponse({ ok: true, message: "開始錄製操作" });
            return;
          }
          if (action === "recordStop") {
            const d = await run("record.stop", {});
            sendResponse({
              ok: true,
              message: "錄製結束，共 " + d.count + " 步",
              output: JSON.stringify(d.steps, null, 2),
            });
            return;
          }
          sendResponse({ ok: false, error: "unknown action: " + action });
          return;
        }
        case "rec:event": {
          recordAdd(msg.event, sender && sender.tab ? sender.tab.id : null);
          sendResponse({ ok: true });
          return;
        }
        case "inboxPush": {
          sendResponse(await pushInbox(msg.item || {}));
          return;
        }
        default:
          sendResponse({ ok: false, error: "unknown message: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

/* ================= 生命週期 ================= */

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSetting(["autoDomain", "clientId"]);
  if (!s.clientId) {
    await chrome.storage.local.set({ clientId: "edge-" + Math.random().toString(16).slice(2, 10) });
  }
  if (!s.autoDomain) await chrome.storage.local.set({ autoDomain: "bilibili.com" });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  connect();
});

/* ================= 右鍵選單 → DSH ================= */

chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    id: "dsh-send-selection",
    title: "把選取文字送給 DSH",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "dsh-send-page",
    title: "把目前頁面送給 DSH",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "dsh-send-link",
    title: "把連結送給 DSH",
    contexts: ["link"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const kind =
      info.menuItemId === "dsh-send-selection"
        ? "selection"
        : info.menuItemId === "dsh-send-link"
        ? "link"
        : "page";
    const payload = {
      kind,
      url: info.linkUrl || (tab && tab.url) || "",
      title: (tab && tab.title) || "",
      source: "context-menu",
    };
    if (kind === "selection") payload.text = info.selectionText || "";
    if (kind === "page" && tab && tab.id) {
      try {
        const d = await bridgeCmd("page.text", { tabId: tab.id, max: 20000 }, 30);
        payload.text = d.text || "";
        payload.chars = (payload.text || "").length;
      } catch {}
    }
    await pushInbox(payload);
  } catch {}
});

/* ================= 錄製：追蹤頁面導航 ================= */

chrome.webNavigation.onCommitted.addListener((d) => {
  if (!recording.on || d.frameId !== 0) return;
  recordAdd({ kind: "navigate", url: d.url, ts: Date.now() }, d.tabId);
  setTimeout(() => {
    chrome.tabs.sendMessage(d.tabId, { type: "rec:start" }, () => void chrome.runtime.lastError);
  }, 500);
});

// SW 被喚醒時就確保連線（含每 30 秒 alarm 喚醒）
connect();
chrome.alarms.create("dsh-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "dsh-keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) await connect();
    cdpDetachIdle().catch(() => {});
  }
});
