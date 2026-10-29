// DSH Edge Assistant — 操作錄製 content script
// 只在收到 "rec:start" 後才把使用者操作送回 background；
// 另外提供「目前選取文字」給右鍵選單用（右鍵選單本身用 info.selectionText，不需要這裡）。

(() => {
  if (window.__dshRecorderLoaded) return;
  window.__dshRecorderLoaded = true;

  let recording = false;
  let lastInput = null; // { selector, value, timer }

  function cssPath(el) {
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
  }

  function textOf(el) {
    try {
      const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      return t.slice(0, 160);
    } catch {
      return "";
    }
  }

  function send(ev) {
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({ type: "rec:event", event: ev });
    } catch {}
  }

  function common(el) {
    return {
      selector: cssPath(el),
      tag: (el.tagName || "").toLowerCase(),
      role: el.getAttribute ? el.getAttribute("role") || "" : "",
      text: textOf(el),
      url: location.href,
      ts: Date.now(),
    };
  }

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      if (!el) return;
      send({
        kind: "click",
        ...common(el),
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        button: e.button,
        modifiers: {
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
      });
    },
    true
  );

  function onField(e) {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = (el.tagName || "").toLowerCase();
    if (!["input", "textarea", "select"].includes(tag) && !el.isContentEditable) return;
    const value =
      tag === "select" ? el.value : el.isContentEditable ? el.textContent.slice(0, 500) : String(el.value || "").slice(0, 500);
    // 同一欄位連續輸入合併成一筆（保留最後值）
    if (lastInput && lastInput.selector === cssPath(el)) {
      lastInput.value = value;
      clearTimeout(lastInput.timer);
      lastInput.timer = setTimeout(() => {
        send({ kind: "input", ...common(el), value: lastInput.value });
        lastInput = null;
      }, 600);
      return;
    }
    if (lastInput) {
      clearTimeout(lastInput.timer);
      send({ kind: "input", ...lastInput.el, value: lastInput.value });
    }
    lastInput = { selector: cssPath(el), value, el: common(el), timer: null };
    lastInput.timer = setTimeout(() => {
      if (lastInput) {
        send({ kind: "input", ...lastInput.el, value: lastInput.value });
        lastInput = null;
      }
    }, 600);
  }

  document.addEventListener("input", onField, true);
  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1) return;
      if ((el.tagName || "").toLowerCase() !== "select") return;
      send({ kind: "select", ...common(el), value: String(el.value || "") });
    },
    true
  );
  document.addEventListener(
    "submit",
    (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1) return;
      send({ kind: "submit", ...common(el) });
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "rec:start") {
      recording = true;
      sendResponse({ ok: true, recording: true, url: location.href });
      return;
    }
    if (msg && msg.type === "rec:stop") {
      recording = false;
      if (lastInput) {
        send({ kind: "input", ...lastInput.el, value: lastInput.value });
        lastInput = null;
      }
      sendResponse({ ok: true, recording: false });
      return;
    }
    if (msg && msg.type === "rec:state") {
      sendResponse({ ok: true, recording });
      return;
    }
  });
})();
