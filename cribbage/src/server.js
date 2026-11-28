import http from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createPusher, turnNotifications } from './push.js';
import { BOT_NAMES } from './bot.js';
import { computeStats } from './stats.js';
import { RuleError } from './engine.js';
import { gameFor, gameModule, rematchSettings, typeOf, GAMES } from './games.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MUSIC = process.env.MUSIC_DIR || join(PUBLIC, 'music'); // background music files
const PORT = Number(process.env.PORT || 3000);
const store = openStore(process.env.DB_PATH || join(ROOT, 'data', 'cribbage.db'));
// Push services (Apple in particular) require a real contact in the VAPID subject.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:cribbage-admin@example.com';
if (!process.env.VAPID_SUBJECT) console.warn('VAPID_SUBJECT is not set; set it to mailto:you@yourdomain for reliable push delivery.');
const pusher = createPusher({ db: store.db, subject: VAPID_SUBJECT });

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

// A browser's private player key (X-Player-Key) identifies the same person across
// games for the leaderboard. Only a one-way hash of it is stored or shown.
function playerIdFor(req) {
  const key = req.headers['x-player-key'];
  if (!key || String(key).length > 200) return null;
  return createHash('sha256').update(`player:${key}`).digest('hex').slice(0, 16);
}

/** Credit a seat to this browser's player if it isn't credited yet (also back-fills old games). */
function claimSeat(game, seat, req) {
  const pid = playerIdFor(req);
  if (seat === null || !pid || game.players[seat].playerId) return;
  game.players[seat].playerId = pid;
  store.put(game); // no version bump: nothing players can see changed
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

function save(game, before = null, actorSeat = null) {
  game.version += 1;
  game.updatedAt = Date.now();
  store.put(game);
  broadcast(game);
  if (before) pusher.notify(game, turnNotifications(before, game, actorSeat)).catch(() => {});
  scheduleBots(game.id);
}

// --- automatic steps and bots ---------------------------------------------------
// Forced plays, "Go", scoring, dealing and bot moves each happen after a short
// pause, one step per save, so everyone watching can follow along. Each tick
// reloads the game and recomputes the step, so a human move made during a pause
// is never overwritten.
const PACE = Number(process.env.PACE ?? 1); // multiplier on every pause; tests use a tiny value
const autoTimers = new Map();
const RECENT_MS = 20_000;
function scheduleBots(id) {
  if (autoTimers.has(id)) return;
  const game = store.get(id);
  const next = game && gameFor(game).nextAutomatic(game, { pace: PACE });
  if (!next) return;
  autoTimers.set(id, setTimeout(() => {
    autoTimers.delete(id);
    const g = store.get(id);
    const step = g && gameFor(g).nextAutomatic(g, { pace: PACE });
    if (!step) return;
    // A decision timer that moved (the player acted, a new turn began) isn't due yet.
    if (step.at && step.at > Date.now() + 50) return scheduleBots(id);
    const before = structuredClone(g);
    try {
      if (!step.apply(g)) return;
    } catch (err) {
      return console.error('automatic step failed', err);
    }
    // Don't ping someone about a turn that came back to them seconds after they acted.
    const actor = g.lastActor != null && Date.now() - (g.lastActorAt ?? 0) < RECENT_MS ? g.lastActor : null;
    save(g, before, actor);
  }, Math.min(next.delay, 2 ** 31 - 1)));
}

/** Drop a pending step so it's recomputed (after a human move changes what's next). */
function rescheduleBots(id) {
  clearTimeout(autoTimers.get(id));
  autoTimers.delete(id);
  scheduleBots(id);
}

const viewOf = (game, seat) => gameFor(game).view(game, seat);

/** Apply a player's move to the game and save it. */
function applyMove(game, seat, action) {
  const before = structuredClone(game);
  gameFor(game).act(game, seat, action);
  save(game, before, seat);
  rescheduleBots(game.id);
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
    const mod = gameModule(body.type ?? 'cribbage');
    const numPlayers = Number(body.numPlayers);
    const name = cleanName(body.name);
    const game = mod.create({ id: newGameId(), numPlayers, settings: { ...body.settings, teams: body.teams } });
    const token = newToken();
    mod.addPlayer(game, { id: randomUUID(), name, tokenHash: hash(token), playerId: playerIdFor(req) });
    save(game);
    send(res, 201, { id: game.id, token, seat: 0 });
  }],

  ['GET', /^\/api\/games\/([a-z0-9]+)$/, async (req, res, [id]) => {
    const game = loadGame(id);
    scheduleBots(id); // resumes paused steps after a server restart
    const seat = seatFor(game, req);
    claimSeat(game, seat, req);
    send(res, 200, viewOf(game, seat));
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
    const before = structuredClone(game);
    const seat = gameFor(game).addPlayer(game, { id: randomUUID(), name, tokenHash: hash(token), playerId: playerIdFor(req) });
    save(game, before, seat);
    send(res, 201, { token, seat });
  }],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/discard$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    const { cards } = await readJson(req);
    applyMove(game, seat, { type: 'discard', cards });
    send(res, 200, viewOf(game, seat));
  }],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/play$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    const { card } = await readJson(req);
    applyMove(game, seat, { type: 'play', card });
    send(res, 200, viewOf(game, seat));
  }],

  // Any game's move: { action: { type, ... } }
  ['POST', /^\/api\/games\/([a-z0-9]+)\/act$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    const { action } = await readJson(req);
    applyMove(game, seat, action);
    send(res, 200, viewOf(game, seat));
  }],

  // The host starts before every seat is filled (games that allow it).
  ['POST', /^\/api\/games\/([a-z0-9]+)\/start$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    if (seat !== 0) throw new HttpError(403, 'Only the host can start the game');
    if (!gameFor(game).canStartEarly) throw new HttpError(400, 'This game starts when every seat is taken');
    const before = structuredClone(game);
    gameFor(game).start(game);
    save(game, before, seat);
    send(res, 200, viewOf(game, seat));
  }],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/rematch$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    if (game.status !== 'finished') throw new HttpError(400, 'The game is still going');
    if (!game.nextGameId) {
      const mod = gameFor(game);
      const next = mod.create({ id: newGameId(), numPlayers: game.numPlayers, settings: rematchSettings(game) });
      next.previousGameId = game.id;
      const lobby = structuredClone(next);
      // Same people and seats; the game starts as the last seat fills.
      for (const p of game.players) {
        mod.addPlayer(next, { id: p.id, name: p.name, tokenHash: p.tokenHash, bot: p.bot, playerId: p.playerId });
      }
      next.version = 1;
      store.put(next);
      pusher.notify(next, turnNotifications(lobby, next, seat)).catch(() => {});
      scheduleBots(next.id);
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

  ['POST', /^\/api\/games\/([a-z0-9]+)\/bots$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    if (game.status !== 'lobby') throw new HttpError(400, 'The game has already started');
    const before = structuredClone(game);
    const { count } = await readJson(req);
    const taken = new Set(game.players.map((p) => p.name.toLowerCase()));
    const names = BOT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
    const target = count ? Math.min(game.numPlayers, game.players.length + Math.max(1, Number(count) | 0)) : game.numPlayers;
    while (game.status === 'lobby' && game.players.length < target) {
      gameFor(game).addPlayer(game, { id: randomUUID(), name: names.shift() ?? `Bot ${game.players.length}`, tokenHash: '', bot: true });
    }
    save(game, before, seat);
    send(res, 200, viewOf(game, seat));
  }],

  ['GET', /^\/api\/stats$/, async (req, res) => {
    const type = new URL(req.url, 'http://x').searchParams.get('game') || 'cribbage';
    if (!GAMES[type]) throw new HttpError(400, 'Unknown game');
    const games = store.finished().filter((g) => typeOf(g) === type);
    send(res, 200, { you: playerIdFor(req), game: type, players: computeStats(games) });
  }],

  // Background music: every audio file in public/music, so adding a track needs no code change.
  ['GET', /^\/api\/music$/, async (_req, res) => {
    let files = [];
    try {
      files = (await readdir(MUSIC)).filter((f) => AUDIO.has(extname(f).toLowerCase())).sort();
    } catch { /* no music folder yet */ }
    send(res, 200, { tracks: files.map((f) => ({ url: `/music/${encodeURIComponent(f)}`, title: trackTitle(f) })) });
  }],

  ['GET', /^\/api\/push\/key$/, async (_req, res) => send(res, 200, { publicKey: pusher.publicKey })],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/push$/, async (req, res, [id]) => {
    const game = loadGame(id);
    const seat = requireSeat(game, req);
    const { subscription } = await readJson(req);
    try {
      pusher.subscribe(id, seat, subscription);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    send(res, 200, { ok: true });
  }],

  ['POST', /^\/api\/games\/([a-z0-9]+)\/push\/remove$/, async (req, res, [id]) => {
    const game = loadGame(id);
    requireSeat(game, req);
    const { endpoint } = await readJson(req);
    pusher.unsubscribe(id, endpoint);
    send(res, 200, { ok: true });
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
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};
const AUDIO = new Set(['.mp3', '.m4a', '.ogg']);

/** "late-night_jazz.mp3" -> "Late night jazz" */
export const trackTitle = (file) => {
  const t = file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path === '/' || path === '/leaders' || path.startsWith('/g/')) path = '/index.html'; // app routes
  const music = path.startsWith('/music/');
  const base = music ? MUSIC : PUBLIC;
  const file = music ? join(MUSIC, path.slice('/music/'.length)) : join(PUBLIC, path);
  if (!file.startsWith(base)) throw new HttpError(404, 'Not found');
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    throw new HttpError(404, 'Not found');
  }
  const type = TYPES[extname(file)] || 'application/octet-stream';
  if (AUDIO.has(extname(file))) return serveRanged(req, res, file, type);
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': ['/index.html', '/sw.js', '/manifest.webmanifest'].includes(path) ? 'no-cache' : 'public, max-age=300',
  });
  res.end(await readFile(file));
}

// Audio is streamed with HTTP range support: Safari (iPhone) won't play
// <audio> from a server that can't send byte ranges.
async function serveRanged(req, res, file, type) {
  const { size } = await stat(file);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file).pipe(res);
  }
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start < 0) start = 0;
  if (start > end || start >= size) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file, { start, end }).pipe(res);
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
