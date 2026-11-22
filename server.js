import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req, res) => {
  // --- UI ---
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = await readFile(path.join(ROOT, 'public', 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // --- Agent run, streamed over SSE ---
  if (req.method === 'POST' && req.url === '/api/run') {
    let raw = '';
    for await (const chunk of req) raw += chunk;

    let goal = '';
    try {
      goal = String(JSON.parse(raw).goal || '').trim();
    } catch {}
    if (!goal) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('missing goal');
    }

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
      await runAgent(goal, emit);
    } catch (err) {
      emit({ type: 'error', text: err?.message || String(err) });
    }
    emit({ type: 'end' });
    return res.end();
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  LinkedIn agent  →  http://localhost:${PORT}\n`);
});
