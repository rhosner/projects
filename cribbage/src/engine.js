// Cribbage rules engine. Pure state transitions; the server owns persistence.
// Cards are 2-char strings: rank (A23456789TJQK) + suit (SHDC), e.g. "TH" = 10 of hearts.

// Unbiased random integer in [0, max) from Web Crypto (available in Node 22+ and browsers),
// so this file runs unchanged on the server and in the in-browser demo.
export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const WIN_SCORE = 121;

export const rankOf = (c) => RANKS.indexOf(c[0]) + 1;
export const suitOf = (c) => c[1];
export const valueOf = (c) => Math.min(rankOf(c), 10);

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const cardLabel = (c) => `${c[0] === 'T' ? '10' : c[0]}${SUIT_SYMBOL[c[1]]}`;

export function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

export function shuffle(arr, rng = randomInt) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function subsets(cards) {
  const out = [];
  for (let mask = 1; mask < 1 << cards.length; mask++) {
    const s = [];
    for (let i = 0; i < cards.length; i++) if (mask & (1 << i)) s.push(cards[i]);
    out.push(s);
  }
  return out;
}

function isRun(cards) {
  const r = cards.map(rankOf).sort((a, b) => a - b);
  for (let i = 1; i < r.length; i++) if (r[i] !== r[i - 1] + 1) return false;
  return true;
}

/** Score a 4-card hand (or crib) with the starter. Returns { total, items }. */
export function scoreHand(hand, starter, isCrib = false) {
  const all = [...hand, starter];
  const subs = subsets(all);
  const items = [];

  for (const s of subs) {
    if (s.reduce((t, c) => t + valueOf(c), 0) === 15) items.push({ kind: 'fifteen', cards: s, points: 2 });
  }
  for (const s of subs) {
    if (s.length === 2 && rankOf(s[0]) === rankOf(s[1])) items.push({ kind: 'pair', cards: s, points: 2 });
  }
  // Runs: only the longest length counts; every distinct combination of that length scores.
  for (let len = all.length; len >= 3; len--) {
    const runs = subs.filter((s) => s.length === len && isRun(s));
    if (runs.length) {
      for (const s of runs) items.push({ kind: 'run', cards: s, points: len });
      break;
    }
  }
  const suit = suitOf(hand[0]);
  if (hand.every((c) => suitOf(c) === suit)) {
    if (suitOf(starter) === suit) items.push({ kind: 'flush', cards: all, points: 5 });
    else if (!isCrib) items.push({ kind: 'flush', cards: [...hand], points: 4 });
  }
  const nob = hand.find((c) => c[0] === 'J' && suitOf(c) === suitOf(starter));
  if (nob) items.push({ kind: 'nobs', cards: [nob], points: 1 });

  return { total: items.reduce((t, i) => t + i.points, 0), items };
}

/** Points for the card just added to the current pegging pile. */
export function scorePegging(pile, count) {
  const items = [];
  if (count === 15) items.push({ kind: 'fifteen', points: 2 });
  if (count === 31) items.push({ kind: 'thirty-one', points: 2 });

  const last = rankOf(pile[pile.length - 1]);
  let same = 1;
  for (let i = pile.length - 2; i >= 0 && rankOf(pile[i]) === last; i--) same++;
  if (same >= 2) {
    const names = { 2: 'pair', 3: 'three of a kind', 4: 'four of a kind' };
    items.push({ kind: names[same], points: { 2: 2, 3: 6, 4: 12 }[same] });
  }

  for (let len = pile.length; len >= 3; len--) {
    const tail = pile.slice(-len);
    if (new Set(tail.map(rankOf)).size === len && isRun(tail)) {
      items.push({ kind: `run of ${len}`, points: len });
      break;
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

// Only 4-player games can be played in teams (partners sit opposite: seats 0 & 2 vs 1 & 3).
// Games saved before `teams` existed were 4-player = teams.
export const hasTeams = (state) => state.teams ?? state.numPlayers === 4;
export const sideCount = (n, teams = n === 4) => (n === 4 && teams ? 2 : n);
export const sideOf = (state, seat) => (hasTeams(state) ? seat % 2 : seat);
export const discardCount = (n) => (n === 2 ? 2 : 1);

export class RuleError extends Error {}

function log(state, text, extra = {}) {
  state.log.push({ t: Date.now(), hand: state.handNo, text, ...extra });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

function addPoints(state, seat, points, reason) {
  if (!points || state.status === 'finished') return;
  const side = sideOf(state, seat);
  state.prevScores[side] = state.scores[side];
  state.scores[side] = Math.min(WIN_SCORE, state.scores[side] + points);
  if (state.scores[side] >= WIN_SCORE) {
    state.status = 'finished';
    state.phase = 'done';
    state.winner = side;
    state.finishedAt = Date.now();
    log(state, `${sideName(state, side)} reached ${WIN_SCORE} and won the game`, { kind: 'win' });
  }
  return reason;
}

export function sideName(state, side) {
  const names = state.players.filter((_, i) => sideOf(state, i) === side).map((p) => p.name);
  return names.join(' & ');
}

export function createGame({ id, numPlayers, autoPlay = true, teams = true }) {
  if (![2, 3, 4].includes(numPlayers)) throw new RuleError('Games are for 2, 3 or 4 players');
  teams = numPlayers === 4 && teams !== false;
  return {
    id,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    numPlayers,
    teams,
    autoPlay,
    status: 'lobby',
    phase: 'lobby',
    players: [],
    scores: Array(sideCount(numPlayers, teams)).fill(0),
    prevScores: Array(sideCount(numPlayers, teams)).fill(0),
    winner: null,
    dealer: null,
    handNo: 0,
    deck: [],
    hands: [],
    kept: [],
    discarded: [],
    crib: [],
    starter: null,
    pegging: null,
    lastHand: null,
    log: [],
    nextGameId: null,
  };
}

export function addPlayer(state, { id, name, tokenHash, bot = false, playerId = null }, rng = randomInt) {
  if (state.status !== 'lobby') throw new RuleError('This game has already started');
  if (state.players.length >= state.numPlayers) throw new RuleError('This game is full');
  state.players.push({ id, name, tokenHash, bot, playerId, joinedAt: Date.now() });
  log(state, `${name} joined`);
  if (state.players.length === state.numPlayers) startGame(state, rng);
  return state.players.length - 1;
}

export function startGame(state, rng = randomInt) {
  state.status = 'playing';
  state.dealer = rng(state.numPlayers);
  log(state, `Game on. ${state.players[state.dealer].name} deals first.`);
  startHand(state, rng);
}

function startHand(state, rng) {
  const n = state.numPlayers;
  state.handNo += 1;
  state.deck = shuffle(newDeck(), rng);
  const per = n === 2 ? 6 : 5;
  state.hands = Array.from({ length: n }, () => state.deck.splice(0, per));
  state.kept = Array(n).fill(null);
  state.discarded = Array(n).fill(false);
  state.crib = n === 3 ? [state.deck.shift()] : [];
  state.starter = null;
  state.pegging = null;
  state.phase = 'discard';
  log(state, `Hand ${state.handNo}: ${state.players[state.dealer].name} deals`, { kind: 'hand' });
}

// Remembered so notifications can skip someone who just acted and is still looking.
function noteHumanAction(state, seat) {
  if (state.players[seat]?.bot) return;
  state.lastActor = seat;
  state.lastActorAt = Date.now();
}

const nextSeat = (state, seat) => (seat + 1) % state.numPlayers;

export function discard(state, seat, cards, rng = randomInt) {
  if (state.phase !== 'discard') throw new RuleError('Not time to discard');
  if (state.discarded[seat]) throw new RuleError('You already discarded');
  const need = discardCount(state.numPlayers);
  if (!Array.isArray(cards) || cards.length !== need || new Set(cards).size !== need) {
    throw new RuleError(`Pick ${need} card${need > 1 ? 's' : ''} for the crib`);
  }
  const hand = state.hands[seat];
  if (!cards.every((c) => hand.includes(c))) throw new RuleError('That card is not in your hand');

  state.kept[seat] = hand.filter((c) => !cards.includes(c));
  state.hands[seat] = [];
  state.crib.push(...cards);
  state.discarded[seat] = true;
  noteHumanAction(state, seat);
  log(state, `${state.players[seat].name} sent ${need === 1 ? 'a card' : 'two cards'} to the crib`);

  if (state.discarded.every(Boolean)) cutStarter(state, rng);
}

function cutStarter(state, rng) {
  const [starter] = state.deck.splice(rng(state.deck.length), 1);
  state.starter = starter;
  log(state, `Starter cut: ${cardLabel(starter)}`, { kind: 'starter' });
  if (starter[0] === 'J') {
    addPoints(state, state.dealer, 2);
    log(state, `${state.players[state.dealer].name} scores 2 for his heels`, {
      seat: state.dealer, points: 2, calls: [{ label: 'His heels', points: 2 }],
    });
    if (state.status === 'finished') return;
  }
  state.pegging = {
    count: 0,
    pile: [],
    history: [], // every card played this hand: { card, seat, count, points, reset }
    remaining: state.kept.map((h) => [...h]),
    turn: nextSeat(state, state.dealer),
    lastPlayer: null,
    saidGo: Array(state.numPlayers).fill(false),
  };
  state.phase = 'pegging';
}

/**
 * Whose move it really is in pegging. Players with no cards, or who already said
 * "Go" and still can't play, are passed over; that pass is instant and invisible,
 * so everything (turn checks, bots, the view) must look past them the same way.
 */
export function effectiveTurn(state) {
  const p = state.pegging;
  if (!p) return null;
  let t = p.turn;
  for (let i = 0; i < state.numPlayers; i++) {
    const canPlay = p.remaining[t].some((c) => valueOf(c) + p.count <= 31);
    if (p.remaining[t].length && (canPlay || !p.saidGo[t])) return t;
    t = nextSeat(state, t);
  }
  return p.turn;
}

export function legalPlays(state, seat) {
  const p = state.pegging;
  if (!p) return [];
  return p.remaining[seat].filter((c) => valueOf(c) + p.count <= 31);
}

export function play(state, seat, card, rng = randomInt) {
  if (state.phase !== 'pegging') throw new RuleError('Not time to play');
  if (state.pegging.needsReset) throw new RuleError('Hang on, the pile is being cleared');
  if (effectiveTurn(state) !== seat) throw new RuleError("It's not your turn");
  state.pegging.turn = seat; // apply any pass-overs that were pending
  if (!state.pegging.remaining[seat].includes(card)) throw new RuleError('That card is not in your hand');
  if (!legalPlays(state, seat).includes(card)) throw new RuleError('That would go over 31');
  noteHumanAction(state, seat);
  doPlay(state, seat, card, false);
}

function doPlay(state, seat, card, auto) {
  const p = state.pegging;
  p.remaining[seat] = p.remaining[seat].filter((c) => c !== card);
  p.count += valueOf(card);
  p.pile.push(card);
  p.lastPlayer = seat;
  const items = scorePegging(p.pile, p.count);
  const points = items.reduce((t, i) => t + i.points, 0);
  p.history.push({ card, seat, count: p.count, points, items });

  const name = state.players[seat].name;
  const what = items.map((i) => `${i.kind} for ${i.points}`).join(', ');
  log(state, `${name} played ${cardLabel(card)} (${p.count})${what ? ` — ${what}` : ''}${auto ? ' · auto' : ''}`, {
    seat,
    points,
    card,
    // What the table should announce, e.g. "31 for 2" or "Fifteen for 2 · Pair for 2".
    calls: items.map((i) => ({ label: callLabel(i.kind), points: i.points })),
  });
  addPoints(state, seat, points);
  if (state.status === 'finished') return;

  // Leave a 31 on the table for a moment; the pile is cleared by a separate step.
  if (p.count === 31) p.needsReset = true;
  p.turn = nextSeat(state, seat);
}

function callLabel(kind) {
  if (kind === 'thirty-one') return '31';
  return kind[0].toUpperCase() + kind.slice(1);
}

function resetCount(p) {
  p.count = 0;
  p.pile = [];
  p.saidGo = p.saidGo.map(() => false);
  if (p.history.length) p.history[p.history.length - 1].reset = true;
}

// ---------------------------------------------------------------------------
// Automatic steps. Everything that happens without a decision (forced plays,
// "Go", go and last-card points, counting hands, dealing) is applied one
// visible step at a time, so the server can pause between them and players
// can follow along instead of seeing it all land at once.
// ---------------------------------------------------------------------------

/** Base pause before each kind of step, in ms. Callers scale and jitter these. */
export const STEP_DELAY = {
  forced: 900,
  go: 800,
  'go-point': 1200,
  reset: 1900, // how long a 31, or the pile that just earned a go, stays on the table
  'last-card': 1100,
  'end-pegging': 1600,
  deal: 2600,
  'bot-discard': 1500,
  'bot-play': 1100,
};

/**
 * Apply the next automatic step, if any. Returns its kind, or null when the
 * game is waiting on a real decision (a human or a bot choosing a card).
 */
export function autoStep(state, rng = randomInt) {
  if (state.status !== 'playing') return null;
  if (state.phase === 'show') {
    state.dealer = nextSeat(state, state.dealer);
    startHand(state, rng);
    return 'deal';
  }
  if (state.phase !== 'pegging') return null;

  const p = state.pegging;
  const n = state.numPlayers;
  const canPlay = (s) => p.remaining[s].some((c) => valueOf(c) + p.count <= 31);

  // Clear a pile that ended on 31 or earned a go, after it has been seen.
  if (p.needsReset && p.remaining.some((h) => h.length)) {
    p.needsReset = false;
    resetCount(p);
    return 'reset';
  }

  if (p.remaining.every((h) => h.length === 0)) {
    // The last card scores 1, unless it made 31 (which already scored 2).
    if (p.count > 0 && p.count < 31 && !p.lastCardDone) {
      p.lastCardDone = true;
      log(state, `${state.players[p.lastPlayer].name} scores 1 for last card`, {
        seat: p.lastPlayer, points: 1, calls: [{ label: 'Last card', points: 1 }],
      });
      addPoints(state, p.lastPlayer, 1);
      return 'last-card';
    }
    endPegging(state);
    return 'end-pegging';
  }

  if (![...Array(n).keys()].some(canPlay)) {
    // Like at a real table: whoever is up says "Go" before the point is pegged.
    const t = p.turn;
    if (t !== p.lastPlayer && p.remaining[t].length && !p.saidGo[t]) {
      p.saidGo[t] = true;
      log(state, `${state.players[t].name}: “Go”`, { seat: t, kind: 'go', calls: [{ label: 'Go' }] });
      p.turn = nextSeat(state, t);
      return 'go';
    }
    log(state, `${state.players[p.lastPlayer].name} scores 1 for the go`, {
      seat: p.lastPlayer, points: 1, calls: [{ label: 'Go', points: 1 }],
    });
    addPoints(state, p.lastPlayer, 1);
    if (state.status === 'finished') return 'go-point';
    p.needsReset = true;
    p.turn = nextSeat(state, p.lastPlayer);
    return 'go-point';
  }

  // Players who are out of cards, or already said Go, pass silently.
  for (let i = 0; i < n; i++) {
    const t = p.turn;
    if (p.remaining[t].length === 0 || (!canPlay(t) && p.saidGo[t])) {
      p.turn = nextSeat(state, t);
      continue;
    }
    if (!canPlay(t)) {
      p.saidGo[t] = true;
      log(state, `${state.players[t].name}: “Go”`, { seat: t, kind: 'go', calls: [{ label: 'Go' }] });
      p.turn = nextSeat(state, t);
      return 'go';
    }
    const legal = legalPlays(state, t);
    if (state.autoPlay && legal.length === 1) {
      doPlay(state, t, legal[0], true);
      return 'forced';
    }
    return null; // waiting on a real decision
  }
  return null;
}

/** What autoStep would do next, without changing the game. */
export function peekStep(state) {
  return autoStep(structuredClone(state), () => 0);
}

/** Run every automatic step immediately (tests and simulations). */
export function settle(state, rng = randomInt) {
  for (let guard = 0; guard < 500; guard++) if (!autoStep(state, rng)) return;
  throw new Error('Game did not settle');
}

function endPegging(state) {
  const n = state.numPlayers;
  const lastHand = {
    handNo: state.handNo,
    dealer: state.dealer,
    starter: state.starter,
    pegging: state.pegging.history,
    shows: [],
  };
  state.lastHand = lastHand;
  state.phase = 'show';

  for (let i = 1; i <= n; i++) {
    const seat = (state.dealer + i) % n;
    const res = scoreHand(state.kept[seat], state.starter, false);
    lastHand.shows.push({ seat, crib: false, cards: state.kept[seat], ...res });
    log(state, `${state.players[seat].name}'s hand: ${res.total}`, { seat, points: res.total, kind: 'show' });
    addPoints(state, seat, res.total);
    if (state.status === 'finished') return;
  }
  const crib = scoreHand(state.crib, state.starter, true);
  lastHand.shows.push({ seat: state.dealer, crib: true, cards: [...state.crib], ...crib });
  log(state, `${state.players[state.dealer].name}'s crib: ${crib.total}`, {
    seat: state.dealer,
    points: crib.total,
    kind: 'show',
  });
  addPoints(state, state.dealer, crib.total);
}

// ---------------------------------------------------------------------------
// Per-player view (hides other players' cards, the deck, and the crib)
// ---------------------------------------------------------------------------

export function currentHand(state, seat) {
  if (state.phase === 'discard') return state.discarded[seat] ? state.kept[seat] : state.hands[seat];
  if (state.phase === 'pegging') return state.pegging.remaining[seat];
  if (state.phase === 'show') return state.kept[seat] ?? [];
  return [];
}

export function isTurn(state, seat) {
  if (state.status !== 'playing') return false;
  if (state.phase === 'discard') return !state.discarded[seat];
  if (state.phase === 'pegging') {
    // "Your turn" means the game is waiting on your decision. A forced card or a
    // "Go" is played for you after a pause, so it doesn't count.
    if (state.pegging.needsReset || effectiveTurn(state) !== seat) return false;
    return legalPlays(state, seat).length > (state.autoPlay ? 1 : 0);
  }
  return false;
}

export function viewFor(state, seat) {
  const me = seat ?? null;
  const p = state.pegging;
  return {
    id: state.id,
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    numPlayers: state.numPlayers,
    teams: hasTeams(state),
    status: state.status,
    phase: state.phase,
    handNo: state.handNo,
    dealer: state.dealer,
    scores: state.scores,
    prevScores: state.prevScores,
    winner: state.winner,
    nextGameId: state.nextGameId,
    discardCount: discardCount(state.numPlayers),
    players: state.players.map((pl, i) => ({
      seat: i,
      name: pl.name,
      bot: !!pl.bot,
      side: sideOf(state, i),
      cardCount: state.status === 'lobby' ? 0 : currentHand(state, i)?.length ?? 0,
      discarded: !!state.discarded[i],
      isTurn: isTurn(state, i),
      saidGo: !!p?.saidGo[i],
    })),
    you: me,
    hand: me === null || state.status === 'lobby' ? [] : currentHand(state, me) ?? [],
    kept: me === null ? null : state.kept[me] ?? null,
    yourTurn: me !== null && isTurn(state, me),
    legal: me !== null && state.phase === 'pegging' && effectiveTurn(state) === me ? legalPlays(state, me) : [],
    cribCount: state.crib.length,
    starter: state.starter,
    pegging: p
      ? { count: p.count, pile: p.pile, history: p.history, turn: effectiveTurn(state), clearing: !!p.needsReset, lastPlayer: p.lastPlayer }
      : null,
    lastHand: state.lastHand,
    log: state.log.slice(-80),
  };
}
