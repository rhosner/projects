// In-browser stand-in for the server, used by the demo build. Same engine and
// bot as the real server; games live in this browser's localStorage.
import { createGame, addPlayer, startGame, discard, play, viewFor, hasTeams, RuleError } from './engine.js';
import { nextAutomatic, BOT_NAMES } from './bot.js';
import { computeStats } from './stats.js';

const KEY = 'cribbage.demo.games';

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
  const next = g && nextAutomatic(g);
  if (!next) return;
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    const game = games[id];
    const step = game && nextAutomatic(game);
    if (step && step.apply(game)) save(game);
  }, next.delay));
}

const view = (g, seat) => JSON.parse(JSON.stringify(viewFor(g, seat)));

function handle(path, method, body, token, playerKey) {
  let m;
  // Everything stays in this browser, so the key itself can serve as the player id.
  const playerId = playerKey || null;
  if (method === 'GET' && path === '/stats') {
    return { you: playerId, players: computeStats(Object.values(games)) };
  }
  if (method === 'POST' && path === '/games') {
    const name = String(body?.name ?? '').trim().slice(0, 20);
    if (!name) fail(400, 'Enter a name');
    const g = createGame({ id: newId(), numPlayers: Number(body.numPlayers), teams: body.teams !== false });
    const t = crypto.randomUUID();
    addPlayer(g, { id: crypto.randomUUID(), name, tokenHash: t, playerId });
    games[g.id] = g;
    save(g);
    return { id: g.id, token: t, seat: 0 };
  }
  if ((m = path.match(/^\/games\/([a-z0-9]+)$/)) && method === 'GET') {
    const g = load(m[1]);
    scheduleBots(g.id);
    const seat = seatFor(g, token);
    if (seat !== null && playerId && !g.players[seat].playerId) {
      g.players[seat].playerId = playerId;
      persist();
    }
    return view(g, seat);
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
        const next = createGame({ id: newId(), numPlayers: g.numPlayers, teams: hasTeams(g) });
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
  async api(path, { method = 'GET', body, token, playerKey } = {}) {
    try {
      return handle(path, method, body, token, playerKey);
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
