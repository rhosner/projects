// In-browser stand-in for the server, used by the demo build. Same engine and
// bot as the real server; games live in this browser's localStorage.
import { createGame, addPlayer, startGame, discard, play, viewFor, RuleError } from './engine.js';
import { botMove, BOT_NAMES } from './bot.js';

const KEY = 'cribbage.demo.games';
const BOT_DELAY = 850;

let games = {};
try {
  games = JSON.parse(localStorage.getItem(KEY) || '{}');
} catch { /* storage blocked: games last for this visit only */ }

const subs = new Map();
const timers = new Map();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(games));
  } catch { /* fine */ }
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

function load(id) {
  const g = games[id];
  if (!g) fail(404, 'Game not found');
  return g;
}

// Tokens never leave this browser, so they're stored as-is.
const seatFor = (g, token) => {
  const i = g.players.findIndex((p) => !p.bot && token && p.tokenHash === token);
  return i === -1 ? null : i;
};

function save(g) {
  g.version += 1;
  g.updatedAt = Date.now();
  persist();
  for (const cb of subs.get(g.id) ?? []) setTimeout(cb, 0);
  scheduleBots(g.id);
}

function scheduleBots(id) {
  if (timers.has(id)) return;
  const g = games[id];
  if (!g || !botMove(g)) return;
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    const game = games[id];
    const m = game && botMove(game);
    if (!m) return;
    if (m.type === 'discard') discard(game, m.seat, m.cards);
    else play(game, m.seat, m.card);
    save(game);
  }, BOT_DELAY));
}

const view = (g, seat) => JSON.parse(JSON.stringify(viewFor(g, seat)));

function handle(path, method, body, token) {
  let m;
  if (method === 'POST' && path === '/games') {
    const name = String(body?.name ?? '').trim().slice(0, 20);
    if (!name) fail(400, 'Enter a name');
    const g = createGame({ id: newId(), numPlayers: Number(body.numPlayers) });
    const t = crypto.randomUUID();
    addPlayer(g, { id: crypto.randomUUID(), name, tokenHash: t });
    games[g.id] = g;
    save(g);
    return { id: g.id, token: t, seat: 0 };
  }
  if ((m = path.match(/^\/games\/([a-z0-9]+)$/)) && method === 'GET') {
    const g = load(m[1]);
    scheduleBots(g.id);
    return view(g, seatFor(g, token));
  }
  if ((m = path.match(/^\/games\/([a-z0-9]+)\/(bots|discard|play|rematch)$/)) && method === 'POST') {
    const g = load(m[1]);
    const seat = seatFor(g, token);
    if (seat === null) fail(403, "You're not a player in this game");
    if (m[2] === 'bots') {
      if (g.status !== 'lobby') fail(400, 'The game has already started');
      const names = BOT_NAMES.filter((n) => !g.players.some((p) => p.name === n));
      while (g.players.length < g.numPlayers) {
        addPlayer(g, { id: crypto.randomUUID(), name: names.shift() ?? `Bot ${g.players.length}`, tokenHash: '', bot: true });
      }
    } else if (m[2] === 'discard') discard(g, seat, body.cards);
    else if (m[2] === 'play') play(g, seat, String(body.card));
    else {
      if (g.status !== 'finished') fail(400, 'The game is still going');
      if (!g.nextGameId) {
        const next = createGame({ id: newId(), numPlayers: g.numPlayers });
        next.players = g.players.map((p) => ({ ...p }));
        startGame(next);
        games[next.id] = next;
        g.nextGameId = next.id;
        save(next);
      }
      save(g);
      return { id: g.nextGameId };
    }
    save(g);
    return view(g, seat);
  }
  fail(404, 'Not available in the demo');
}

export const transport = {
  async api(path, { method = 'GET', body, token } = {}) {
    try {
      return handle(path, method, body, token);
    } catch (err) {
      if (err instanceof RuleError) fail(400, err.message);
      throw err;
    }
  },
  subscribe(id, cb) {
    if (!subs.has(id)) subs.set(id, new Set());
    subs.get(id).add(cb);
    return () => subs.get(id)?.delete(cb);
  },
};
