// No-limit Texas Hold'em tournament engine. Pure state transitions, like the
// cribbage engine: the server owns persistence, timers and bots.
//
// Rules implemented:
// - 2-9 players, everyone starts with the same stack; last player with chips wins.
// - Button moves each hand. Heads-up, the button posts the small blind and acts
//   first before the flop and last after it.
// - Blinds double every `levelHands` hands (0 = never).
// - Minimum bet is the big blind; a raise must be at least the size of the last
//   full raise. An all-in for less doesn't reopen betting to players who have
//   already acted (they may only call or fold).
// - Side pots: each pot is split among the best hands eligible for it; an odd
//   chip goes to the first winner to the left of the button.
// - Decision timer: when it runs out the player checks if possible, else folds.
//   After two timeouts in a row they're "away" and auto-act quickly until they act.
import { newDeck, shuffle, randomInt, RuleError } from './engine.js';
import { bestHand, compareScores } from './poker-hands.js';

export const HOLDEM_DEFAULTS = { startingStack: 1500, smallBlind: 10, bigBlind: 20, levelHands: 10, actionSeconds: 60 };
const AWAY_SECONDS = 4;

const fmt = (n) => n.toLocaleString('en-US');

function log(state, text, extra = {}) {
  state.log.push({ t: Date.now(), hand: state.handNo, text, ...extra });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

export function cleanSettings(raw = {}) {
  const int = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  };
  const s = {
    startingStack: int(raw.startingStack, 100, 1_000_000, HOLDEM_DEFAULTS.startingStack),
    bigBlind: int(raw.bigBlind, 2, 100_000, HOLDEM_DEFAULTS.bigBlind),
    levelHands: int(raw.levelHands, 0, 100, HOLDEM_DEFAULTS.levelHands),
    actionSeconds: int(raw.actionSeconds, 10, 600, HOLDEM_DEFAULTS.actionSeconds),
  };
  s.smallBlind = int(raw.smallBlind, 1, s.bigBlind, Math.max(1, Math.floor(s.bigBlind / 2)));
  if (s.bigBlind * 2 > s.startingStack) throw new RuleError('The big blind must be at most half the starting stack');
  return s;
}

export function createHoldem({ id, maxPlayers = 6, settings = {} }) {
  if (!(maxPlayers >= 2 && maxPlayers <= 9)) throw new RuleError('Hold’em is for 2 to 9 players');
  const st = cleanSettings(settings);
  return {
    type: 'holdem',
    id,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    numPlayers: maxPlayers,
    status: 'lobby',
    phase: 'lobby',
    settings: st,
    players: [],
    handNo: 0,
    button: null,
    level: 1,
    sb: st.smallBlind,
    bb: st.bigBlind,
    deck: [],
    board: [],
    hand: null,
    lastHand: null,
    winner: null,
    log: [],
    nextGameId: null,
  };
}

export function addHoldemPlayer(state, { id, name, tokenHash, bot = false, playerId = null }, rng = randomInt) {
  if (state.status !== 'lobby') throw new RuleError('This game has already started');
  if (state.players.length >= state.numPlayers) throw new RuleError('This game is full');
  state.players.push({
    id, name, tokenHash, bot, playerId, joinedAt: Date.now(),
    stack: state.settings.startingStack, out: false, place: null, timeouts: 0,
  });
  log(state, `${name} sat down`);
  if (state.players.length === state.numPlayers) startHoldem(state, rng);
  return state.players.length - 1;
}

/** Start with whoever is seated (the host can start before every seat fills). */
export function startHoldem(state, rng = randomInt) {
  if (state.status !== 'lobby') throw new RuleError('This game has already started');
  if (state.players.length < 2) throw new RuleError('You need at least 2 players');
  state.numPlayers = state.players.length;
  state.status = 'playing';
  state.button = rng(state.numPlayers);
  log(state, `Shuffle up and deal. ${fmt(state.settings.startingStack)} chips each, blinds ${state.sb}/${state.bb}.`);
  startHand(state, rng, true);
}

const activeSeats = (state) => state.players.map((p, i) => i).filter((i) => !state.players[i].out);
function nextSeat(state, from, pred) {
  for (let k = 1; k <= state.numPlayers; k++) {
    const s = (from + k) % state.numPlayers;
    if (pred(s)) return s;
  }
  return null;
}
const inHand = (state, s) => !state.hand.folded[s];
const canAct = (state, s) => inHand(state, s) && !state.hand.allIn[s];

function startHand(state, rng, first = false) {
  const n = state.numPlayers;
  state.handNo += 1;
  const lh = state.settings.levelHands;
  if (lh > 0 && state.handNo > 1 && (state.handNo - 1) % lh === 0) {
    state.level += 1;
    state.sb *= 2;
    state.bb *= 2;
    log(state, `Blinds up: ${fmt(state.sb)}/${fmt(state.bb)}`, { kind: 'level', calls: [{ label: `Blinds ${fmt(state.sb)}/${fmt(state.bb)}` }] });
  }
  if (!first || state.players[state.button].out) state.button = nextSeat(state, state.button, (s) => !state.players[s].out);

  state.deck = shuffle(newDeck(), rng);
  state.board = [];
  const active = activeSeats(state);
  const hand = {
    street: 'preflop',
    hole: Array.from({ length: n }, () => []),
    bets: Array(n).fill(0),
    committed: Array(n).fill(0),
    folded: state.players.map((p) => p.out),
    allIn: Array(n).fill(false),
    acted: Array(n).fill(false),
    canRaise: Array(n).fill(true),
    startStacks: state.players.map((p) => p.stack),
    currentBet: 0,
    minRaise: state.bb,
    toAct: null,
    deadline: null,
    roundDone: false,
    sbSeat: null,
    bbSeat: null,
  };
  state.hand = hand;
  for (let r = 0; r < 2; r++) for (const s of active) hand.hole[s].push(state.deck.shift());

  if (active.length === 2) {
    hand.sbSeat = state.button;
    hand.bbSeat = nextSeat(state, state.button, (s) => !state.players[s].out);
  } else {
    hand.sbSeat = nextSeat(state, state.button, (s) => !state.players[s].out);
    hand.bbSeat = nextSeat(state, hand.sbSeat, (s) => !state.players[s].out);
  }
  put(state, hand.sbSeat, Math.min(state.sb, state.players[hand.sbSeat].stack));
  put(state, hand.bbSeat, Math.min(state.bb, state.players[hand.bbSeat].stack));
  hand.currentBet = state.bb; // even a short all-in big blind is called at the full amount
  state.phase = 'betting';
  log(state, `Hand ${state.handNo}: ${state.players[state.button].name} has the button`, { kind: 'hand' });

  const opener = active.length === 2 ? hand.sbSeat : nextSeat(state, hand.bbSeat, (s) => canAct(state, s));
  setToAct(state, opener);
  checkRoundOver(state);
}

function put(state, seat, amount) {
  const p = state.players[seat];
  const h = state.hand;
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  h.bets[seat] += a;
  h.committed[seat] += a;
  if (p.stack === 0) h.allIn[seat] = true;
}

function setToAct(state, seat) {
  const h = state.hand;
  h.toAct = seat;
  if (seat == null) {
    h.deadline = null;
    return;
  }
  const p = state.players[seat];
  h.deadline = p.bot ? null : Date.now() + (p.timeouts >= 2 ? AWAY_SECONDS : state.settings.actionSeconds) * 1000;
}

function needsToAct(state, s) {
  const h = state.hand;
  return canAct(state, s) && (!h.acted[s] || h.bets[s] < h.currentBet);
}

/** After any action: is this betting round (or the whole hand) over? */
function checkRoundOver(state) {
  const h = state.hand;
  const live = activeSeats(state).filter((s) => inHand(state, s));
  if (live.length <= 1) {
    h.roundDone = true;
    setToAct(state, null);
    return;
  }
  const actors = live.filter((s) => !h.allIn[s]);
  // Nobody left to bet against: one player (or none) can still act and has matched the bet.
  if (actors.length === 0 || (actors.length === 1 && h.bets[actors[0]] >= h.currentBet)) {
    h.roundDone = true;
    setToAct(state, null);
    return;
  }
  if (h.toAct != null && needsToAct(state, h.toAct)) return;
  const next = nextSeat(state, h.toAct ?? state.button, (s) => needsToAct(state, s));
  if (next == null) {
    h.roundDone = true;
    setToAct(state, null);
  } else setToAct(state, next);
}

// ---------------------------------------------------------------------------
// Player decisions
// ---------------------------------------------------------------------------

/** What a seat may do right now (for the UI and validation). */
export function options(state, seat) {
  const h = state.hand;
  if (state.status !== 'playing' || state.phase !== 'betting' || !h || h.roundDone || h.toAct !== seat) return null;
  const p = state.players[seat];
  const toCall = Math.min(h.currentBet - h.bets[seat], p.stack);
  const maxTo = h.bets[seat] + p.stack;
  const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
  const canRaise = h.canRaise[seat] && maxTo > h.currentBet;
  return { toCall, canCheck: toCall === 0, canRaise, minRaiseTo: minTo, maxRaiseTo: maxTo, currentBet: h.currentBet, bet: h.bets[seat] };
}

export function holdemAct(state, seat, action, { auto = false } = {}) {
  const o = options(state, seat);
  if (!o) throw new RuleError("It's not your turn");
  const h = state.hand;
  const p = state.players[seat];
  const type = action?.type;
  let text;
  let calls = [];

  if (type === 'fold') {
    h.folded[seat] = true;
    text = `${p.name} folds`;
    calls = [{ label: 'Fold' }];
  } else if (type === 'check') {
    if (!o.canCheck) throw new RuleError(`It's ${fmt(o.toCall)} to call`);
    text = `${p.name} checks`;
    calls = [{ label: 'Check' }];
  } else if (type === 'call') {
    if (o.canCheck) throw new RuleError('Nothing to call; check instead');
    put(state, seat, o.toCall);
    text = `${p.name} calls ${fmt(o.toCall)}${h.allIn[seat] ? ' and is all in' : ''}`;
    calls = [{ label: h.allIn[seat] ? `All in · call ${fmt(o.toCall)}` : `Call ${fmt(o.toCall)}` }];
  } else if (type === 'raise') {
    if (!o.canRaise) throw new RuleError('You can only call or fold here');
    const to = Math.round(Number(action.amount));
    if (!Number.isFinite(to) || to <= h.currentBet) throw new RuleError('Raise to more than the current bet');
    if (to > o.maxRaiseTo) throw new RuleError(`You only have ${fmt(o.maxRaiseTo)}`);
    const raiseSize = to - h.currentBet;
    const full = raiseSize >= h.minRaise;
    if (!full && to !== o.maxRaiseTo) throw new RuleError(`The minimum raise is to ${fmt(o.minRaiseTo)}`);
    const opening = h.currentBet === 0;
    put(state, seat, to - h.bets[seat]);
    for (let s = 0; s < state.numPlayers; s++) {
      if (s === seat || !canAct(state, s)) continue;
      if (full) {
        h.acted[s] = false;
        h.canRaise[s] = true;
      } else if (h.acted[s]) {
        // An all-in that isn't a full raise doesn't reopen betting for players who already acted.
        h.acted[s] = false;
        h.canRaise[s] = false;
      }
    }
    if (full) h.minRaise = raiseSize;
    h.currentBet = to;
    const verb = opening ? 'bets' : 'raises to';
    text = `${p.name} ${verb} ${fmt(to)}${h.allIn[seat] ? ' (all in)' : ''}`;
    calls = [{ label: h.allIn[seat] ? `All in · ${fmt(to)}` : `${opening ? 'Bet' : 'Raise to'} ${fmt(to)}` }];
  } else {
    throw new RuleError('Unknown action');
  }

  h.acted[seat] = true;
  if (!auto) p.timeouts = 0;
  if (!p.bot && !auto) {
    state.lastActor = seat;
    state.lastActorAt = Date.now();
  }
  log(state, `${text}${auto ? ' (timed out)' : ''}`, { seat, calls, kind: `poker-${type}` });
  checkRoundOver(state);
}

// ---------------------------------------------------------------------------
// Automatic steps: dealing streets, showdown, awarding pots, next hand, timeouts.
// ---------------------------------------------------------------------------

export const HOLDEM_DELAY = {
  award: 900, flop: 1100, turn: 1100, river: 1100, runout: 1700, showdown: 900,
  'next-hand': 4200, 'next-hand-quick': 2200, timeout: 0, 'bot-act': 1300,
};

/**
 * Apply the next automatic step. Returns its kind, or null if the game is
 * waiting on a decision. `now` decides whether a decision timer has run out.
 */
export function holdemAutoStep(state, rng = randomInt, now = Date.now()) {
  if (state.status !== 'playing') return null;
  const h = state.hand;

  if (state.phase === 'handover') {
    bustAndAdvance(state, rng);
    return 'next-hand';
  }
  if (state.phase !== 'betting') return null;

  if (h.roundDone) {
    const live = activeSeats(state).filter((s) => inHand(state, s));
    if (live.length === 1) {
      awardUncontested(state, live[0]);
      return 'award';
    }
    if (h.street === 'river') {
      showdown(state);
      return 'showdown';
    }
    return dealNextStreet(state);
  }

  // A decision timer ran out: check if free, otherwise fold.
  if (h.toAct != null && h.deadline != null && now >= h.deadline) {
    const p = state.players[h.toAct];
    const o = options(state, h.toAct);
    p.timeouts += 1;
    holdemAct(state, h.toAct, { type: o.canCheck ? 'check' : 'fold' }, { auto: true });
    return 'timeout';
  }
  return null;
}

function dealNextStreet(state) {
  const h = state.hand;
  const runout = activeSeats(state).filter((s) => canAct(state, s)).length < 2;
  state.deck.shift(); // burn
  if (h.street === 'preflop') {
    state.board.push(...state.deck.splice(0, 3));
    h.street = 'flop';
  } else {
    state.board.push(state.deck.shift());
    h.street = h.street === 'flop' ? 'turn' : 'river';
  }
  h.bets = h.bets.map(() => 0);
  h.acted = h.acted.map(() => false);
  h.canRaise = h.canRaise.map(() => true);
  h.currentBet = 0;
  h.minRaise = state.bb;
  h.roundDone = false;
  h.toAct = null;
  const names = { flop: 'Flop', turn: 'Turn', river: 'River' };
  log(state, `${names[h.street]}: ${state.board.join(' ')}`, { kind: 'street', street: h.street });
  if (runout) {
    h.roundDone = true;
    setToAct(state, null);
    return 'runout';
  }
  setToAct(state, nextSeat(state, state.button, (s) => canAct(state, s)));
  return h.street;
}

/** Split committed chips into a main pot and side pots by all-in levels. */
export function buildPots(committed, folded) {
  const levels = [...new Set(committed.filter((c, s) => c > 0 && !folded[s]))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of committed) amount += Math.max(0, Math.min(c, level) - prev);
    const eligible = committed.map((c, s) => s).filter((s) => !folded[s] && committed[s] >= level);
    if (amount > 0) {
      const last = pots.at(-1);
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    prev = level;
  }
  // Chips folded players put in above the highest live level go to the last pot.
  let leftover = 0;
  for (const c of committed) leftover += Math.max(0, c - prev);
  if (leftover && pots.length) pots.at(-1).amount += leftover;
  return pots;
}

function awardUncontested(state, seat) {
  const h = state.hand;
  const total = h.committed.reduce((a, b) => a + b, 0);
  state.players[seat].stack += total;
  log(state, `${state.players[seat].name} wins ${fmt(total)}`, {
    seat, kind: 'poker-win', calls: [{ label: `Wins ${fmt(total)}` }],
  });
  state.lastHand = { handNo: state.handNo, board: [...state.board], showdown: false, results: [{ seat, won: total }], pots: [{ amount: total, winners: [seat] }] };
  clearPot(h);
  state.phase = 'handover';
}

function showdown(state) {
  const h = state.hand;
  const live = activeSeats(state).filter((s) => inHand(state, s));
  const hands = new Map(live.map((s) => [s, bestHand([...h.hole[s], ...state.board])]));
  const pots = buildPots(h.committed, h.folded);
  const won = Array(state.numPlayers).fill(0);
  const potResults = [];
  for (const pot of pots) {
    let best = null;
    let winners = [];
    for (const s of pot.eligible) {
      const c = best ? compareScores(hands.get(s).score, best) : 1;
      if (c > 0) {
        best = hands.get(s).score;
        winners = [s];
      } else if (c === 0) winners.push(s);
    }
    // Odd chips go to the first winner to the left of the button.
    winners.sort((a, b) => ((a - state.button - 1 + 2 * state.numPlayers) % state.numPlayers) - ((b - state.button - 1 + 2 * state.numPlayers) % state.numPlayers));
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    for (const w of winners) {
      const amt = share + (odd > 0 ? 1 : 0);
      if (odd > 0) odd--;
      won[w] += amt;
      state.players[w].stack += amt;
    }
    potResults.push({ amount: pot.amount, winners, eligible: pot.eligible });
  }
  state.lastHand = {
    handNo: state.handNo,
    board: [...state.board],
    showdown: true,
    results: live.map((s) => ({ seat: s, cards: h.hole[s], best: hands.get(s).name, bestCards: hands.get(s).cards, won: won[s] })),
    pots: potResults,
  };
  clearPot(h);
  for (const s of live) log(state, `${state.players[s].name} shows ${h.hole[s].join(' ')}: ${hands.get(s).name}`, { seat: s, kind: 'poker-show' });
  for (const s of live.filter((x) => won[x] > 0)) {
    log(state, `${state.players[s].name} wins ${fmt(won[s])} with ${hands.get(s).name.toLowerCase()}`, {
      seat: s, kind: 'poker-win', calls: [{ label: `Wins ${fmt(won[s])}` }, { label: hands.get(s).name }],
    });
  }
  state.phase = 'handover';
}

// Once paid out, the chips are in the winners' stacks and no longer on the table.
function clearPot(h) {
  h.committed = h.committed.map(() => 0);
  h.bets = h.bets.map(() => 0);
}

function bustAndAdvance(state, rng) {
  const h = state.hand;
  const busted = activeSeats(state).filter((s) => state.players[s].stack === 0);
  const remaining = activeSeats(state).length - busted.length;
  // Players knocked out in the same hand: the one who started it with more chips places higher.
  busted.sort((a, b) => h.startStacks[b] - h.startStacks[a]);
  busted.forEach((s, k) => {
    const p = state.players[s];
    p.out = true;
    p.place = remaining + 1 + k;
    log(state, `${p.name} is out in ${ordinal(p.place)} place`, { seat: s, kind: 'poker-out', calls: [{ label: `Out in ${ordinal(p.place)}` }] });
  });
  if (remaining <= 1) {
    const w = activeSeats(state)[0];
    state.players[w].place = 1;
    state.winner = w;
    state.status = 'finished';
    state.phase = 'done';
    state.finishedAt = Date.now();
    state.hand.toAct = null;
    state.hand.deadline = null;
    log(state, `${state.players[w].name} wins the tournament!`, { seat: w, kind: 'win' });
    return;
  }
  startHand(state, rng);
}

const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

export function holdemPeek(state, now = Date.now()) {
  return holdemAutoStep(structuredClone(state), () => 0, now);
}

export function holdemIsTurn(state, seat) {
  return state.status === 'playing' && state.phase === 'betting' && !state.hand.roundDone && state.hand.toAct === seat;
}

// ---------------------------------------------------------------------------
// Per-player view
// ---------------------------------------------------------------------------
export function holdemView(state, seat) {
  const me = seat ?? null;
  const h = state.hand;
  const lh = state.lastHand;
  const revealed = new Map(state.phase === 'handover' && lh?.showdown && lh.handNo === state.handNo ? lh.results.map((r) => [r.seat, r.cards]) : []);
  return {
    id: state.id,
    type: 'holdem',
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    numPlayers: state.numPlayers,
    status: state.status,
    phase: state.phase,
    handNo: state.handNo,
    settings: state.settings,
    level: state.level,
    sb: state.sb,
    bb: state.bb,
    button: state.button,
    winner: state.winner,
    nextGameId: state.nextGameId,
    players: state.players.map((p, i) => ({
      seat: i,
      name: p.name,
      bot: !!p.bot,
      stack: p.stack,
      out: p.out,
      place: p.place,
      away: p.timeouts >= 2,
      bet: h ? h.bets[i] : 0,
      folded: h ? h.folded[i] && !p.out : false,
      allIn: h ? h.allIn[i] : false,
      hasCards: !!h && h.hole[i].length > 0 && !h.folded[i],
      cards: revealed.get(i) ?? null,
      isTurn: holdemIsTurn(state, i),
      sb: h?.sbSeat === i,
      bb: h?.bbSeat === i,
    })),
    you: me,
    hand: me !== null && h ? h.hole[me] : [],
    board: state.board,
    street: h?.street ?? null,
    pot: h ? h.committed.reduce((a, b) => a + b, 0) : 0,
    currentBet: h?.currentBet ?? 0,
    toAct: h?.toAct ?? null,
    deadline: h?.deadline ?? null,
    serverNow: Date.now(),
    yourTurn: me !== null && holdemIsTurn(state, me),
    options: me !== null ? options(state, me) : null,
    lastHand: lh,
    log: state.log.slice(-80),
  };
}
