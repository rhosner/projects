// In-browser stand-in for the server, used by the demo build. Same engine and
// bot as the real server; games live in this browser's localStorage.
import { RuleError } from './engine.js';
import { BOT_NAMES } from './bot.js';
import { gameFor, gameModule, rematchSettings, typeOf } from './games.js';
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
  const next = g && gameFor(g).nextAutomatic(g);
  if (!next) return;
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    const game = games[id];
    const step = game && gameFor(game).nextAutomatic(game);
    if (!step) return;
    if (step.at && step.at > Date.now() + 50) return scheduleBots(id); // timer moved; not due yet
    if (step.apply(game)) save(game);
  }, Math.min(next.delay, 2 ** 31 - 1)));
}

function reschedule(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  scheduleBots(id);
}

const view = (g, seat) => JSON.parse(JSON.stringify(gameFor(g).view(g, seat)));

function handle(path, method, body, token, playerKey) {
  let m;
  // Everything stays in this browser, so the key itself can serve as the player id.
  const playerId = playerKey || null;
  if (method === 'GET' && path.startsWith('/stats')) {
    const type = new URLSearchParams(path.split('?')[1] || '').get('game') || 'cribbage';
    return { you: playerId, game: type, players: computeStats(Object.values(games).filter((g) => typeOf(g) === type)) };
  }
  if (method === 'POST' && path === '/games') {
    const name = String(body?.name ?? '').trim().slice(0, 20);
    if (!name) fail(400, 'Enter a name');
    const mod = gameModule(body.type ?? 'cribbage');
    const g = mod.create({ id: newId(), numPlayers: Number(body.numPlayers), settings: { ...body.settings, teams: body.teams } });
    const t = crypto.randomUUID();
    mod.addPlayer(g, { id: crypto.randomUUID(), name, tokenHash: t, playerId });
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
  if ((m = path.match(/^\/games\/([a-z0-9]+)\/(bots|discard|play|act|start|rematch)$/)) && method === 'POST') {
    const g = load(m[1]);
    const seat = seatFor(g, token);
    if (seat === null) fail(403, "You're not a player in this game");
    const mod = gameFor(g);
    if (m[2] === 'bots') {
      if (g.status !== 'lobby') fail(400, 'The game has already started');
      const names = BOT_NAMES.filter((n) => !g.players.some((p) => p.name === n));
      const target = body?.count ? Math.min(g.numPlayers, g.players.length + body.count) : g.numPlayers;
      while (g.status === 'lobby' && g.players.length < target) {
        mod.addPlayer(g, { id: crypto.randomUUID(), name: names.shift() ?? `Bot ${g.players.length}`, tokenHash: '', bot: true });
      }
    } else if (m[2] === 'discard') mod.act(g, seat, { type: 'discard', cards: body.cards });
    else if (m[2] === 'play') mod.act(g, seat, { type: 'play', card: body.card });
    else if (m[2] === 'act') mod.act(g, seat, body.action);
    else if (m[2] === 'start') {
      if (seat !== 0) fail(403, 'Only the host can start the game');
      mod.start(g);
    } else {
      if (g.status !== 'finished') fail(400, 'The game is still going');
      if (!g.nextGameId) {
        const next = mod.create({ id: newId(), numPlayers: g.numPlayers, settings: rematchSettings(g) });
        for (const p of g.players) mod.addPlayer(next, { id: p.id, name: p.name, tokenHash: p.tokenHash, bot: p.bot, playerId: p.playerId });
        games[next.id] = next;
        g.nextGameId = next.id;
        save(next);
      }
      save(g);
      return { id: g.nextGameId };
    }
    save(g);
    reschedule(g.id);
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
