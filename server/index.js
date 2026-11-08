import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Arena, BOT_COUNT, PROTOCOL } from './Arena.js';

const assets = new Map([
  ['/', ['../dist/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['../dist/index.html', 'text/html; charset=utf-8']],
  ['/game.js', ['../dist/game.js', 'text/javascript; charset=utf-8']],
  ['/game.css', ['../dist/game.css', 'text/css; charset=utf-8']]
]);

export async function startServer({ port = Number(process.env.PORT || 3000), host = '0.0.0.0' } = {}) {
  const arena = new Arena();
  const files = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) =>
    [path, { body: await readFile(new URL(file, import.meta.url)), type }])));
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end(); return;
    }
    if (path === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n'); return; }
    if (path === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        room: 'Suq Al-Rimal', protocol: PROTOCOL, players: arena.players.size,
        maxPlayers: null, bots: BOT_COUNT, round: arena.round
      })); return;
    }
    const file = files.get(path);
    if (!file) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let validOrigin = true;
    if (req.headers.origin) {
      try { validOrigin = new URL(req.headers.origin).host === req.headers.host; }
      catch { validOrigin = false; }
    }
    if (req.url !== '/arena' || !validOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    let player = null;
    let messages = 0;
    let windowAt = Date.now();
    ws.alive = true;
    const send = (data) => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > 256 * 1024) { ws.close(1013, 'Connection too slow'); return; }
      ws.send(JSON.stringify(data));
    };
    const deadline = setTimeout(() => { if (!player) ws.close(1008, 'Join timeout'); }, 8000);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, binary) => {
      if (binary) { ws.close(1003, 'JSON required'); return; }
      const now = Date.now();
      if (now - windowAt >= 1000) { windowAt = now; messages = 0; }
      if (++messages > 100) { ws.close(1008, 'Too many messages'); return; }
      let m;
      try { m = JSON.parse(raw.toString()); } catch { ws.close(1007, 'Invalid JSON'); return; }
      if (!player) {
        if (m?.type !== 'join' || m.protocol !== PROTOCOL || typeof m.name !== 'string') {
          ws.close(1008, 'Reload the game to join'); return;
        }
        if (m.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim().length < 2 || m.name.length > 20) {
          ws.close(1008, 'Escribe un nombre de 2 a 20 caracteres'); return;
        }
        player = arena.join(m.name, send);
        clearTimeout(deadline);
        if (!player) ws.close(1008, 'Escribe un nombre válido');
      } else arena.receive(player, m);
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (player) arena.leave(player.id);
    });
  });
  let previous = performance.now();
  let accumulator = 0;
  let lastBroadcast = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min(0.15, (now - previous) / 1000);
    previous = now;
    while (accumulator >= 1 / 30) { arena.step(1 / 30); accumulator -= 1 / 30; }
    if (arena.players.size && now - lastBroadcast >= 50) {
      arena.broadcast({ type: 'state', state: arena.snapshot() }); lastBroadcast = now;
    }
  }, 10);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 15000);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, arena, close: async () => {
    clearInterval(tick); clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    arena.director.dispose(); arena.combat.dispose();
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await startServer();
  console.log(`Nexode Arena listening on ${app.server.address().port}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
