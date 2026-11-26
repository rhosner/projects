import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createGame, addPlayer, startGame, discard, play, viewFor, RuleError } from './engine.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const store = openStore(process.env.DB_PATH || join(ROOT, 'data', 'cribbage.db'));

const hash = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(24).toString('base64url');
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const newGameId = () => Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');

// --- live updates (Server-Sent Events) -------------------------------------
const subscribers = new Map(); // gameId -> Set<res>
function broadcast(game) {
  const subs = subscribers.get(game.id);
  if (!subs) return;
  const msg = `event: update\ndata: ${JSON.stringify({ version: game.version })}\n\n`;
  for (const res of subs) res.write(msg);
}
setInterval(() => {
  for (const subs of subscribers.values()) for (const res of subs) res.write(': ping\n\n');
}, 25_000).unref();

// --- helpers ----------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function cleanName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!n) throw new HttpError(400, 'Enter a name');
  return n;
}

function seatFor(game, req) {
  const token = req.headers['x-player-token'];
  if (!token) return null;
  const h = hash(String(token));
  const i = game.players.findIndex((p) => p.tokenHash === h);
  return i === -1 ? null : i;
}

function loadGame(id) {
  const game = store.get(id);
  if (!game) throw new HttpError(404, 'Game not found');
  return game;
}

function save(game) {
  game.version += 1;
  game.updatedAt = Date.now();
  store.put(game);
  broadcast(game);
}

function requireSeat(game, req) {
  const seat = seatFor(game, req);
  if (seat === null) throw new HttpError(403, "You're not a player in this game");
  return seat;
}

// --- API routes ---------------------------------------------------------------
const routes = [
  ['POST', /^\/api\/games$/, async (req, res) => {
    const body = await readJson(req);
    const numPlayers = Number(body.numPlayers);
    const name = cleanName(body.name);
    const game = createGame({ id: newGameId(), numPlayers });
    const token = newToken();
    addPlayer(game, { id: randomUUID(), name, tokenHash: hash(token) });
    save(game);
    send(res, 201, { id: game.id, token, seat: 0 });
  }],

  ['GET', /^\/api\/games\/([a-z0-9]+)$/, async (req, res, [id]) => {
    const game = loadGame(id);
    send(res, 200, viewFor(game, seatFor(game, req)));
  }],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/join$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const existing = seatFor(game, req);
    if (existing !== null) return send(res, 200, { seat: existing });
    const body = await readJson(req);
    const name = cleanName(body.name);
    if (game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, 'Someone at the table already has that name');
    }
    const token = newToken();
    const seat = addPlayer(game, { id: randomUUID(), name, tokenHash: hash(token) });
    save(game);
    send(res, 201, { token, seat });
  }],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/discard$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    const { cards } = await readJson(req);
    discard(game, seat, cards);
    save(game);
    send(res, 200, viewFor(game, seat));
  }],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/play$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    const { card } = await readJson(req);
    play(game, seat, String(card));
    save(game);
    send(res, 200, viewFor(game, seat));
  }],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/rematch$/, async (req, res, [id]) => {
    const game = loadGame(id);
    requireSeat(game, req);
    if (game.status !== 'finished') throw new HttpError(400, 'The game is still going');
    if (!game.nextGameId) {
      const next = createGame({ id: newGameId(), numPlayers: game.numPlayers });
      // Same people and seats; startGame picks a fresh random dealer.
      next.players = game.players.map((p) => ({ ...p, joinedAt: Date.now() }));
      next.previousGameId = game.id;
      startGame(next);
      next.version = 1;
      store.put(next);
      game.nextGameId = next.id;
      save(game);
    }
    send(res, 200, { id: game.nextGameId });
  }],

  ['GET', /^\/api\/games\/([a-z0-9]+)\/events$/, async (req, res, [id]) => {
    const game = loadGame(id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\nevent: update\ndata: ${JSON.stringify({ version: game.version })}\n\n`);
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(res);
    req.on('close', () => {
      const subs = subscribers.get(id);
      subs?.delete(res);
      if (subs && !subs.size) subscribers.delete(id);
    });
  }],

  ['GET', /^\/healthz$/, async (_req, res) => send(res, 200, { ok: true })],
];

// --- static files ---------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path === '/' || path.startsWith('/g/')) path = '/index.html';
  const file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC)) throw new HttpError(404, 'Not found');
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Cache-Control': path === '/index.html' ? 'no-cache' : 'public, max-age=300',
  });
  res.end(await readFile(file));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const { pathname } = new URL(req.url, 'http://x');
    for (const [method, re, handler] of routes) {
      const m = pathname.match(re);
      if (m && req.method === method) return await handler(req, res, m.slice(1));
    }
    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    await serveStatic(req, res);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof RuleError) return send(res, 400, { error: err.message });
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'Something went wrong' });
  }
});

server.listen(PORT, () => console.log(`Cribbage running on http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
