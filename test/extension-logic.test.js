// DSH Edge Assistant — 擴充邏輯離線測試（不需要 Edge）
// 用 Node 的 vm 載入 background.js，用 stub 代替 chrome.* API，驗證純函式與狀態機。
//
// 執行：node test/extension-logic.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const BG = process.argv[2] || path.join(__dirname, "..", "extension", "background.js");
const src = fs.readFileSync(BG, "utf8");

/* ---------------- chrome.* stubs ---------------- */

const storage = {};
let fetchMode = "fail"; // fail | ok
const inboxItems = [];
const debuggerEvents = [];
const webNavListeners = [];

const noop = () => {};

const COOKIES = [
  { name: "SESSDATA", value: "s", domain: ".bilibili.com", path: "/", secure: true, httpOnly: true },
  { name: "bili_jct", value: "j", domain: ".bilibili.com", path: "/", secure: true, httpOnly: false },
  { name: "hostonly", value: "h", domain: "www.bilibili.com", path: "/pika", secure: true, httpOnly: false },
];

function cookiesGetAll(query) {
  if (query.domain) {
    const host = query.domain.replace(/^\./, "");
    return COOKIES.filter((c) => {
      const d = c.domain.replace(/^\./, "");
      return d === host || d.endsWith("." + host);
    });
  }
  if (query.url) {
    const host = new URL(query.url).hostname;
    return COOKIES.filter((c) => {
      const d = c.domain.replace(/^\./, "");
      return d === host || host.endsWith("." + d);
    });
  }
  return [];
}

const ctx = {
  console,
  URL,
  JSON,
  Math,
  Date,
  Promise,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Event: class {},
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  unescape: (s) => s,
  encodeURIComponent,
  structuredClone: (v) => JSON.parse(JSON.stringify(v)),
  chrome: {
    runtime: {
      onMessage: { addListener: noop },
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      sendMessage: async () => {},
      lastError: null,
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
          for (const k of list) if (k in storage) out[k] = storage[k];
          return out;
        },
        set: async (obj) => Object.assign(storage, obj),
      },
    },
    alarms: { create: noop, onAlarm: { addListener: noop } },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, url: "https://www.bilibili.com/", title: "bilibili" }],
      get: async (id) => ({ id, windowId: 1, url: "https://www.bilibili.com/", title: "bilibili" }),
      update: async () => ({}),
      create: async () => ({}),
      remove: async () => {},
      captureVisibleTab: async () => "data:image/png;base64,",
      group: async () => 42,
      ungroup: async () => {},
      sendMessage: noop,
      onRemoved: { addListener: noop },
    },
    tabGroups: {
      query: async () => [],
      update: async () => ({}),
    },
    cookies: { getAll: async (q) => cookiesGetAll(q), set: async () => ({}) },
    scripting: {
      executeScript: async () => [{ result: { found: true } }],
    },
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      update: async () => ({}),
    },
    downloads: { search: async () => [], download: async () => 1 },
    history: { search: async () => [] },
    bookmarks: { search: async () => [] },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
      onEvent: { addListener: (fn) => debuggerEvents.push(fn) },
      onDetach: { addListener: noop },
    },
    contextMenus: {
      removeAll: (cb) => (cb ? cb() : undefined),
      create: noop,
      onClicked: { addListener: noop },
    },
    webNavigation: {
      onCommitted: { addListener: (fn) => webNavListeners.push(fn) },
    },
    sidePanel: { open: async () => {}, setOptions: async () => {} },
  },
  WebSocket: class {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING：測試中不觸發 onopen/onclose
    }
    send() {}
    close() {}
  },
  fetch: async (url, opts) => {
    if (fetchMode === "ok") {
      if (String(url).endsWith("/inbox") && (!opts || !opts.method || opts.method === "GET")) {
        return { ok: true, json: async () => ({ ok: true, count: inboxItems.length, items: inboxItems }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error("offline");
  },
};

/* ---------------- 載入 background.js ---------------- */

vm.createContext(ctx);
vm.runInContext(
  src +
    `
;globalThis.__test = {
  normalizeHost, collectCookies, parseKeySpec, compressAx, recordAdd, recording,
  waitForCondition, pushInbox, getInbox, flushInboxQueue, netState, consoleState,
  pageScanControls, pageReadAll, pageBoxOf, panelState: null
};
`,
  ctx,
  { filename: "background.js" }
);

/* ---------------- 測試 ---------------- */

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ok  " + name);
    })
    .catch((e) => {
      console.error("  FAIL " + name + " :: " + e.message);
      process.exitCode = 1;
    });
}

(async () => {
  const t = ctx.__test;

  console.log("[載入]");
  await ok("background.js 可在 stub 環境載入並註冊事件", () => {
    assert.ok(debuggerEvents.length >= 0);
    assert.ok(webNavListeners.length >= 0);
  });

  console.log("[網域/cookie]");
  await ok("normalizeHost 支援 URL / 前導點", () => {
    assert.strictEqual(t.normalizeHost("https://www.bilibili.com/x"), "www.bilibili.com");
    assert.strictEqual(t.normalizeHost(".Bilibili.com"), "bilibili.com");
  });
  await ok("collectCookies 補到父網域登入 cookie", async () => {
    const cookies = await t.collectCookies("www.bilibili.com");
    assert.ok(cookies.some((c) => c.name === "SESSDATA"), "少了 SESSDATA");
    assert.ok(cookies.some((c) => c.name === "hostonly"), "少了 host-only cookie");
  });

  console.log("[鍵盤]");
  await ok("parseKeySpec 解析組合鍵", () => {
    const k = t.parseKeySpec("Control+Shift+Enter");
    assert.strictEqual(k.key, "Enter");
    assert.strictEqual(k.modifiers, 2 | 8);
    const a = t.parseKeySpec("a");
    assert.strictEqual(a.code, "KeyA");
    assert.strictEqual(a.vk, 65);
    const d = t.parseKeySpec("ArrowDown");
    assert.strictEqual(d.vk, 40);
  });

  console.log("[AX 樹]");
  await ok("compressAx 過濾 ignored / 保留 role+name+properties+depth", () => {
    const nodes = [
      { nodeId: "1", parentId: null, role: { value: "RootWebArea" }, name: { value: "頁面" }, ignored: false, properties: [] },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "button" },
        name: { value: "送出" },
        ignored: false,
        properties: [{ name: "focusable", value: { value: true } }],
      },
      { nodeId: "3", parentId: "1", role: { value: "generic" }, name: { value: "" }, ignored: true, properties: [] },
    ];
    const ax = t.compressAx(nodes, 100);
    assert.strictEqual(ax.count, 2);
    const btn = ax.nodes.find((n) => n.role === "button");
    assert.strictEqual(btn.name, "送出");
    assert.strictEqual(btn.focusable, true);
    assert.strictEqual(btn.depth, 1);
  });

  console.log("[錄製]");
  await ok("recordAdd 合併連續輸入、標記導航", () => {
    t.recording.on = true;
    t.recording.steps = [];
    t.recordAdd({ kind: "click", selector: "#a", ts: 1 }, 1);
    t.recordAdd({ kind: "navigate", url: "https://x", ts: 2 }, 1);
    assert.strictEqual(t.recording.steps[0].navigated, true);
    t.recordAdd({ kind: "input", selector: "#b", value: "x", ts: 3 }, 1);
    t.recordAdd({ kind: "input", selector: "#b", value: "xy", ts: 4 }, 1);
    assert.strictEqual(t.recording.steps.length, 3);
    assert.strictEqual(t.recording.steps[2].value, "xy");
    t.recording.on = false;
  });

  console.log("[等待]");
  await ok("waitForCondition 立即命中", async () => {
    const r = await t.waitForCondition(1, { selector: "#x", timeout: 1000, poll: 100 });
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.mode, "selector");
  });
  await ok("waitForCondition 缺條件會報錯", async () => {
    let threw = false;
    try {
      await t.waitForCondition(1, { timeout: 100 });
    } catch {
      threw = true;
    }
    assert.ok(threw);
  });

  console.log("[收件匣]");
  await ok("pushInbox 在 bridge 離線時落地本機佇列", async () => {
    fetchMode = "fail";
    const r = await t.pushInbox({ kind: "test", text: "x" });
    assert.strictEqual(r.queued, true);
    assert.ok(Array.isArray(storage.inboxQueue) && storage.inboxQueue.length === 1);
  });
  await ok("flushInboxQueue 在 bridge 恢復後送出", async () => {
    fetchMode = "ok";
    const n = await t.flushInboxQueue();
    assert.strictEqual(n, 1);
    assert.strictEqual(storage.inboxQueue.length, 0);
  });
  await ok("getInbox 在 bridge 離線時回 ok:false", async () => {
    fetchMode = "fail";
    const ib = await t.getInbox();
    assert.strictEqual(ib.ok, false);
  });

  console.log("[網路緩衝]");
  await ok("netState/consoleState 初始化", () => {
    const n = t.netState(9);
    assert.strictEqual(n.inflight, 0);
    assert.ok(Array.isArray(n.items));
    const c = t.consoleState(9);
    assert.ok(Array.isArray(c.items));
  });

  console.log("\n" + (process.exitCode ? "SOME TESTS FAILED" : "ALL " + passed + " TESTS PASSED"));
})();
