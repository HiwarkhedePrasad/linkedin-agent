import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';
import { unipile } from './tools.js';
import {
  ensureUid,
  runWithUser,
  accountFor,
  setAccount,
  validNotify,
  notifySecret,
} from './accounts.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Unipile must be able to reach this URL. Use a tunnel locally, your domain in production.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://example.com').replace(/\/$/, '');
const API_URL = process.env.UNIPILE_API_URL || 'https://api.unipile.com';

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

const readBody = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ---------------------------------------------------------------- UI
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    ensureUid(req, res);
    const html = await readFile(path.join(ROOT, 'public', 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ------------------------------------------------- Unipile callback
  // { status:"CREATION_SUCCESS", account_id:"acc_...", name:"<our uid>" }
  if (req.method === 'POST' && url.pathname === '/api/unipile/notify') {
    if (!validNotify(url.searchParams.get('token'))) return json(res, { error: 'unauthorized' }, 401);
    const body = await readBody(req);
    if (['CREATION_SUCCESS', 'RECONNECTED'].includes(body.status)) {
      setAccount(body.name, body.account_id);
    }
    return json(res, { ok: true });
  }

  // --------------------------------------------------- connection state
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const uid = ensureUid(req, res);
    const account_id = accountFor(uid);
    return json(res, { connected: Boolean(account_id), account_id, uid });
  }

  // ------------------------------------------- generate hosted auth url
  if (req.method === 'POST' && url.pathname === '/api/connect') {
    const uid = ensureUid(req, res);
    try {
      const link = await unipile.account.createHostedAuthLink({
        type: 'create',
        providers: ['LINKEDIN'],
        api_url: API_URL,
        expiresOn: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        name: uid, // returned to us in the callback
        notify_url: `${PUBLIC_URL}/api/unipile/notify?token=${encodeURIComponent(notifySecret())}`,
        success_redirect_url: `${PUBLIC_URL}/?linked=1`,
        failure_redirect_url: `${PUBLIC_URL}/?linked=0`,
        single_use: true,
      });
      return json(res, { url: link.url });
    } catch (err) {
      const detail = err?.detail || err?.title || err?.message || err?.response?.statusText || String(err);
      return json(res, { error: detail, status: err?.status || err?.response?.status }, 500);
    }
  }

  // ------------------------------------------------------ agent run, SSE
  if (req.method === 'POST' && url.pathname === '/api/run') {
    const uid = ensureUid(req, res);
    const { goal } = await readBody(req);
    if (!String(goal || '').trim()) return json(res, { error: 'missing goal' }, 400);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let open = true;
    req.on('close', () => (open = false));
    const emit = (data) => {
      if (open && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Bind every tool call in this run to this browser's linked account.
      await runWithUser(uid, () => runAgent(String(goal).trim(), emit));
    } catch (err) {
      emit({ type: 'error', text: err?.message || String(err) });
    }
    emit({ type: 'end' });
    return res.end();
  }

  return json(res, { error: 'not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`\n  LinkedIn agent  →  http://localhost:${PORT}`);
  console.log(`  Callback URL    →  ${PUBLIC_URL}/api/unipile/notify\n`);
});
