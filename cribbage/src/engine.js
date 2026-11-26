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

export const sideCount = (n) => (n === 4 ? 2 : n);
export const sideOf = (state, seat) => (state.numPlayers === 4 ? seat % 2 : seat);
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

export function createGame({ id, numPlayers, autoPlay = true }) {
  if (![2, 3, 4].includes(numPlayers)) throw new RuleError('Games are for 2, 3 or 4 players');
  return {
    id,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    numPlayers,
    autoPlay,
    status: 'lobby',
    phase: 'lobby',
    players: [],
    scores: Array(sideCount(numPlayers)).fill(0),
    prevScores: Array(sideCount(numPlayers)).fill(0),
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

export function addPlayer(state, { id, name, tokenHash, bot = false }, rng = randomInt) {
  if (state.status !== 'lobby') throw new RuleError('This game has already started');
  if (state.players.length >= state.numPlayers) throw new RuleError('This game is full');
  state.players.push({ id, name, tokenHash, bot, joinedAt: Date.now() });
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
  log(state, `${state.players[seat].name} sent ${need === 1 ? 'a card' : 'two cards'} to the crib`);

  if (state.discarded.every(Boolean)) cutStarter(state, rng);
}

function cutStarter(state, rng) {
  const [starter] = state.deck.splice(rng(state.deck.length), 1);
  state.starter = starter;
  log(state, `Starter cut: ${cardLabel(starter)}`, { kind: 'starter' });
  if (starter[0] === 'J') {
    addPoints(state, state.dealer, 2);
    log(state, `${state.players[state.dealer].name} scores 2 for his heels`, { seat: state.dealer, points: 2 });
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
  runPegging(state, rng);
}

export function legalPlays(state, seat) {
  const p = state.pegging;
  if (!p) return [];
  return p.remaining[seat].filter((c) => valueOf(c) + p.count <= 31);
}

export function play(state, seat, card, rng = randomInt) {
  if (state.phase !== 'pegging') throw new RuleError('Not time to play');
  if (state.pegging.turn !== seat) throw new RuleError("It's not your turn");
  if (!state.pegging.remaining[seat].includes(card)) throw new RuleError('That card is not in your hand');
  if (!legalPlays(state, seat).includes(card)) throw new RuleError('That would go over 31');
  doPlay(state, seat, card, false);
  runPegging(state, rng);
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
  });
  addPoints(state, seat, points);
  if (state.status === 'finished') return;

  if (p.count === 31) resetCount(p);
  p.turn = nextSeat(state, seat);
}

function resetCount(p) {
  p.count = 0;
  p.pile = [];
  p.saidGo = p.saidGo.map(() => false);
  if (p.history.length) p.history[p.history.length - 1].reset = true;
}

function runPegging(state, rng) {
  const p = state.pegging;
  const n = state.numPlayers;
  const canPlay = (s) => p.remaining[s].some((c) => valueOf(c) + p.count <= 31);

  for (let guard = 0; guard < 500; guard++) {
    if (state.status === 'finished') return;

    if (p.remaining.every((h) => h.length === 0)) {
      if (p.count > 0) {
        log(state, `${state.players[p.lastPlayer].name} scores 1 for last card`, { seat: p.lastPlayer, points: 1 });
        addPoints(state, p.lastPlayer, 1);
        if (state.status === 'finished') return;
      }
      return endPegging(state, rng);
    }

    if (![...Array(n).keys()].some(canPlay)) {
      log(state, `${state.players[p.lastPlayer].name} scores 1 for the go`, { seat: p.lastPlayer, points: 1 });
      addPoints(state, p.lastPlayer, 1);
      if (state.status === 'finished') return;
      resetCount(p);
      p.turn = nextSeat(state, p.lastPlayer);
      continue;
    }

    const t = p.turn;
    if (p.remaining[t].length === 0) {
      p.turn = nextSeat(state, t);
      continue;
    }
    if (!canPlay(t)) {
      if (!p.saidGo[t]) {
        p.saidGo[t] = true;
        log(state, `${state.players[t].name}: “Go”`, { seat: t });
      }
      p.turn = nextSeat(state, t);
      continue;
    }
    const legal = legalPlays(state, t);
    if (state.autoPlay && legal.length === 1) {
      doPlay(state, t, legal[0], true);
      continue;
    }
    return; // waiting on a real decision
  }
  throw new Error('Pegging loop did not settle');
}

function endPegging(state, rng) {
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
  if (state.status === 'finished') return;

  state.dealer = nextSeat(state, state.dealer);
  startHand(state, rng);
}

// ---------------------------------------------------------------------------
// Per-player view (hides other players' cards, the deck, and the crib)
// ---------------------------------------------------------------------------

export function currentHand(state, seat) {
  if (state.phase === 'discard') return state.discarded[seat] ? state.kept[seat] : state.hands[seat];
  if (state.phase === 'pegging') return state.pegging.remaining[seat];
  return [];
}

export function isTurn(state, seat) {
  if (state.status !== 'playing') return false;
  if (state.phase === 'discard') return !state.discarded[seat];
  if (state.phase === 'pegging') return state.pegging.turn === seat;
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
    legal: me !== null && state.phase === 'pegging' && p.turn === me ? legalPlays(state, me) : [],
    cribCount: state.crib.length,
    starter: state.starter,
    pegging: p
      ? { count: p.count, pile: p.pile, history: p.history, turn: p.turn, lastPlayer: p.lastPlayer }
      : null,
    lastHand: state.lastHand,
    log: state.log.slice(-80),
  };
}
