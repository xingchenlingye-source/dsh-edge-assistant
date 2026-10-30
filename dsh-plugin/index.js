// dsh-browser-chat — 讓 Edge 側邊欄跟 DSH 會話對話的本地橋。
//
// 為什麼需要這個插件：DSH 的 Web/HTTP API 只對 owner（同一個 GUI 進程）授權，
// 外部程式（瀏覽器擴充）拿不到；但 Host 內的插件可以直接用
// sessionController / sessions 這些 service。
//
// 這個插件只做兩件事：
//   1. 在 127.0.0.1:8766 開一個小 HTTP/SSE 服務（只綁本機）
//   2. 把 Edge 側邊欄的訊息交給 sessionController.prompt，
//      並把該會話的 session/event 與 agent/assistant-stream 即時推回去
//
// 不改 DSH 任何檔案；移除 bundle 即完全消失。

import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const name = 'browser-chat';
export const inject = ['sessionController', 'sessions'];

const DEFAULT_PORT = 8766;
const SURFACE_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'turn/start',
  'turn/end',
]);
const HISTORY_LIMIT = 60;

function textOf(message) {
  if (!message) return '';
  const parts = [];
  const walk = (value) => {
    if (value == null) return;
    if (typeof value === 'string') {
      if (value) parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') parts.push(value.text);
      else if (typeof value.value === 'string') parts.push(value.value);
      else if (value.content !== undefined) walk(value.content);
    }
  };
  walk(message.content !== undefined ? message.content : message);
  return parts.join('');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, obj, status) {
  const code = status || 200;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function apply(ctx) {
  const log = (() => {
    try {
      return ctx.logger('browser-chat');
    } catch {
      return null;
    }
  })();
  const info = (...args) => {
    try {
      (log && log.info ? log.info : console.log)(...args);
    } catch {}
  };
  const warn = (...args) => {
    try {
      (log && log.warn ? log.warn : console.warn)(...args);
    } catch {}
  };

  const port = DEFAULT_PORT;
  let activeSessionId = null;
  let activeUpdatedAt = 0;
  const clients = new Set();

  const send = (client, event, data) => {
    try {
      client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    } catch {}
  };

  const broadcast = (sessionId, event, data) => {
    for (const c of clients) {
      if (!c.sessionId || !sessionId || c.sessionId === sessionId) send(c, event, data);
    }
  };

  const toSimple = (event) => {
    const t = event.type;
    if (t === 'user/message') {
      return { role: 'user', text: textOf(event.data && event.data.message), seq: event.seq };
    }
    if (t === 'assistant/message') {
      return { role: 'assistant', text: textOf(event.data && event.data.message), seq: event.seq };
    }
    if (t === 'tool/call') {
      return {
        role: 'tool',
        name: String((event.data && event.data.name) || ''),
        args: String((event.data && event.data.arguments) || '').slice(0, 300),
        seq: event.seq,
      };
    }
    if (t === 'tool/result') {
      const msg = event.data && event.data.message;
      return { role: 'tool-result', isError: !!(msg && msg.isError), seq: event.seq };
    }
    if (t === 'turn/end') {
      const reason = event.data && event.data.reason;
      return { role: 'turn', kind: (reason && reason.kind) || 'completed', seq: event.seq };
    }
    return null;
  };

  /* ---------- 追蹤「最近有活動的會話」 ---------- */

  ctx.on('api-session/activity', (sessionId, updatedAt) => {
    if (!sessionId) return;
    const ts = Number(updatedAt) || Date.now();
    if (ts >= activeUpdatedAt) {
      activeUpdatedAt = ts;
      activeSessionId = String(sessionId);
      broadcast(null, 'active', { sessionId: activeSessionId, updatedAt: activeUpdatedAt });
    }
  });

  /* ---------- 會話查詢 ---------- */

  // 註：不再用 ctx.on('session/event') / 'agent/assistant-stream' —
  // 後者是 agent-scoped 事件，一般 plugin context 收不到。
  // 歷史與逐字統一由 /events 的 sessionController.follow() 提供。

  const timeout = (ms) => {
    try {
      return AbortSignal.timeout(ms);
    } catch {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), ms);
      return ac.signal;
    }
  };

  async function listSessions() {
    const value = await ctx.sessionController.list({}, timeout(8000));
    const items = (value && value.items) || [];
    return items
      .map((s) => ({
        sessionId: String(s.sessionId),
        updatedAt: Number(s.updatedAt) || 0,
        running: !!s.running,
        blank: !!s.blank,
        origin: s.origin || null,
        parentSessionId: s.parentSessionId ? String(s.parentSessionId) : null,
        cwd: s.cwd || null,
        title:
          (s.projections && s.projections.values && s.projections.values.title) || null,
      }))
      .filter((s) => !s.origin && !s.parentSessionId);
  }

  async function currentSession() {
    if (!activeSessionId) {
      try {
        const items = await listSessions();
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        const top = items.find((s) => !s.blank) || items[0];
        if (top) {
          activeSessionId = top.sessionId;
          activeUpdatedAt = top.updatedAt;
        }
      } catch (e) {
        warn('[browser-chat] list sessions failed:', String(e && e.message ? e.message : e));
      }
    }
    return { sessionId: activeSessionId, updatedAt: activeUpdatedAt };
  }

  /* ---------- HTTP 路由 ---------- */

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      return sendJson(res, { ok: false, error: 'bad url' }, 400);
    }
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, {
          ok: true,
          service: 'browser-chat',
          version: '1.1.0',
          port,
          active: activeSessionId,
          clients: clients.size,
        });
      }
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const { sessionId } = await currentSession();
        return sendJson(res, { ok: true, active: sessionId, items: await listSessions() });
      }
      if (req.method === 'GET' && url.pathname === '/current') {
        return sendJson(res, { ok: true, ...(await currentSession()) });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        return await openEvents(req, res, url);
      }
      if (req.method === 'POST' && url.pathname === '/prompt') {
        return await handlePrompt(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/cancel') {
        return await handleCancel(req, res);
      }
      return sendJson(res, { ok: false, error: 'not found' }, 404);
    } catch (e) {
      return sendJson(res, { ok: false, error: String((e && e.message) || e) }, 500);
    }
  });

  async function openEvents(req, res, url) {
    let sessionId = url.searchParams.get('sessionId');
    if (!sessionId) sessionId = (await currentSession()).sessionId;
    if (!sessionId) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('event: error\ndata: ' + JSON.stringify({ error: 'no session' }) + '\n\n');
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 2000\n\n');

    const client = { res, sessionId: String(sessionId) };
    clients.add(client);
    const ac = new AbortController();
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {}
    }, 15000);
    const close = () => {
      clearInterval(heartbeat);
      clients.delete(client);
      try {
        ac.abort();
      } catch {}
    };
    req.on('close', close);
    req.on('error', close);

    try {
      // follow：一份 opening snapshot + 之後無縫的 durable events +
      // cursorless assistant-stream frames（逐字）。
      const stream = ctx.sessionController.follow(
        {
          address: { kind: 'session', sessionId: String(sessionId) },
          assistantStream: true,
          maxMessages: HISTORY_LIMIT,
        },
        ac.signal
      );
      for await (const frame of stream) {
        if (!frame || !frame.type) continue;
        if (frame.type === 'snapshot') {
          const records = (frame.records || []).filter(
            (r) => r && r.type === 'event' && r.event
          );
          const messages = records
            .map((r) => toSimple(r.event))
            .filter(Boolean)
            .slice(-HISTORY_LIMIT);
          send(client, 'snapshot', {
            sessionId: String(sessionId),
            cursor: frame.cursor,
            messages,
          });
        } else if (frame.type === 'event') {
          const simple = toSimple(frame.event);
          if (simple) send(client, 'event', simple);
        } else if (frame.type === 'assistant-stream') {
          const f = frame.frame;
          if (!f) continue;
          if (f.type === 'start') {
            send(client, 'delta-start', {
              turn: f.turn,
              step: f.step,
              attemptId: String(f.attemptId),
            });
          } else if (f.type === 'chunk') {
            const chunk = f.chunk || {};
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              send(client, 'delta', { text: chunk.text });
            }
          } else if (f.type === 'end') {
            send(client, 'delta-end', {
              kind: (f.outcome && f.outcome.kind) || 'end',
            });
          }
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        send(client, 'error', { error: String((e && e.message) || e) });
      }
    } finally {
      close();
    }
  }

  async function handlePrompt(req, res) {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, { ok: false, error: 'text is required' }, 400);
    const target = body.sessionId
      ? String(body.sessionId)
      : (await currentSession()).sessionId;
    if (!target) return sendJson(res, { ok: false, error: 'no session' }, 400);
    await ctx.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId: target,
        mode: body.mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai',
      },
      timeout(20000)
    );
    return sendJson(res, { ok: true, sessionId: target, accepted: true });
  }

  async function handleCancel(req, res) {
    const body = await readJson(req).catch(() => ({}));
    const target = body.sessionId
      ? String(body.sessionId)
      : (await currentSession()).sessionId;
    if (!target) return sendJson(res, { ok: false, error: 'no session' }, 400);
    ctx.sessionController.cancel({ sessionId: target });
    return sendJson(res, { ok: true, sessionId: target });
  }

  /* ---------- 生命週期 ---------- */

  ctx.effect(() => {
    server.on('error', (e) => {
      const msg = String((e && e.message) || e);
      warn('[browser-chat] server error: ' + msg);
    });
    server.listen(port, '127.0.0.1', () => {
      info('[browser-chat] listening on 127.0.0.1:' + port);
    });
    return () => {
      for (const c of clients) {
        try {
          c.res.end();
        } catch {}
      }
      clients.clear();
      try {
        server.close();
      } catch {}
    };
  });
}
