// A simple, sensible Hold'em bot plus the step scheduler for Hold'em games.
// Preflop it rates its two cards (Chen formula); after the flop it estimates its
// chance of winning by simulating random opponent hands and runouts, and weighs
// that against the price of calling. It's meant to be a reasonable opponent for
// filling seats, not a strong one.
import { newDeck, randomInt } from './engine.js';
import { bestHand, compareScores, pokerRank } from './poker-hands.js';
import { options, holdemAct, holdemAutoStep, holdemPeek, HOLDEM_DELAY } from './holdem.js';

/** Chen formula: a quick preflop strength score, roughly -1 (72o) to 20 (AA). */
export function chenScore([a, b]) {
  const ra = pokerRank(a);
  const rb = pokerRank(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  const base = { 14: 10, 13: 8, 12: 7, 11: 6 }[hi] ?? hi / 2;
  let s = ra === rb ? Math.max(5, base * 2) : base;
  if (a[1] === b[1]) s += 2;
  if (ra !== rb) {
    const gap = hi - lo - 1;
    s -= [0, 1, 2, 4][gap] ?? 5;
    if (gap <= 1 && hi < 12) s += 1;
  }
  return Math.ceil(s);
}

/** Estimated chance of winning at showdown against `opponents` random hands. */
export function equity(hole, board, opponents, iterations = 160, rng = Math.random) {
  const known = new Set([...hole, ...board]);
  const deck = newDeck().filter((c) => !known.has(c));
  let score = 0;
  for (let it = 0; it < iterations; it++) {
    // Partial Fisher-Yates: draw just the cards we need.
    const need = opponents * 2 + (5 - board.length);
    const d = deck.slice();
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (d.length - i));
      [d[i], d[j]] = [d[j], d[i]];
    }
    const fullBoard = [...board, ...d.slice(opponents * 2, need)];
    const mine = bestHand([...hole, ...fullBoard]).score;
    let result = 1; // 1 win, 0.5-ish split, 0 loss
    let ties = 0;
    for (let o = 0; o < opponents; o++) {
      const theirs = bestHand([d[o * 2], d[o * 2 + 1], ...fullBoard]).score;
      const c = compareScores(mine, theirs);
      if (c < 0) {
        result = 0;
        break;
      }
      if (c === 0) ties++;
    }
    score += result && ties ? 1 / (ties + 1) : result;
  }
  return score / iterations;
}

export function holdemBotDecision(state, seat, rng = Math.random) {
  const o = options(state, seat);
  if (!o) return null;
  const h = state.hand;
  const pot = h.committed.reduce((a, b) => a + b, 0);
  const opponents = state.players.filter((p, s) => s !== seat && !p.out && !h.folded[s]).length;
  const bb = state.bb;
  const stack = state.players[seat].stack;
  const raiseTo = (to) => ({ type: 'raise', amount: Math.max(o.minRaiseTo, Math.min(o.maxRaiseTo, Math.round(to))) });
  const passive = o.canCheck ? { type: 'check' } : { type: 'fold' };
  const jitter = rng();

  if (h.street === 'preflop') {
    const chen = chenScore(h.hole[seat]);
    const short = stack <= bb * 10;
    if (short && chen >= 8) return o.canRaise ? raiseTo(o.maxRaiseTo) : { type: 'call' };
    if (chen >= 11 || (chen >= 9 && jitter < 0.35)) {
      if (o.canRaise && h.currentBet <= bb * 4) return raiseTo(Math.max(h.currentBet * 3, bb * 3));
      return o.canCheck ? { type: 'check' } : { type: 'call' };
    }
    if (chen >= 7 || (chen >= 5 && o.toCall <= bb && jitter < 0.6)) {
      if (o.toCall <= Math.max(bb * 3, stack * 0.08)) return o.canCheck ? { type: 'check' } : { type: 'call' };
    }
    return passive;
  }

  const eq = equity(h.hole[seat], state.board, Math.max(1, opponents), 140, rng);
  const potOdds = o.toCall / (pot + o.toCall || 1);
  if (eq > 0.72 && o.canRaise && jitter < 0.85) return raiseTo(h.currentBet + pot * (0.5 + jitter * 0.5));
  if (eq > 0.55 && o.canCheck && o.canRaise && jitter < 0.5) return raiseTo(pot * 0.5);
  if (o.canCheck) return { type: 'check' };
  if (eq > potOdds + 0.06 || (eq > potOdds && jitter < 0.4)) return { type: 'call' };
  // An occasional bluff-catch keeps it from folding to every bet.
  if (o.toCall <= bb && jitter < 0.25) return { type: 'call' };
  return { type: 'fold' };
}

/**
 * The next thing that happens without a human in a Hold'em game.
 * Timed steps (decision timers) carry an absolute `at`; the scheduler must not
 * apply them early.
 */
export function holdemNextAutomatic(state, { pace = 1, rng = randomInt, now = Date.now() } = {}) {
  if (state.status !== 'playing') return null;
  const h = state.hand;
  const step = holdemPeek(state, Infinity); // what would happen ignoring timers
  if (step && step !== 'timeout') {
    let kind = step;
    if (step === 'next-hand' && !state.lastHand?.showdown) kind = 'next-hand-quick';
    return { kind: step, delay: Math.round(HOLDEM_DELAY[kind] * pace), apply: (g) => holdemAutoStep(g, rng, Infinity) };
  }
  if (state.phase !== 'betting' || h.roundDone || h.toAct == null) return null;
  const p = state.players[h.toAct];
  if (p.bot) {
    const seat = h.toAct;
    return {
      kind: 'bot-act',
      delay: Math.round(HOLDEM_DELAY['bot-act'] * pace * (0.6 + Math.random() * 0.9)),
      apply: (g) => {
        if (g.hand?.toAct !== seat || !g.players[seat].bot) return null;
        const d = holdemBotDecision(g, seat);
        if (!d) return null;
        holdemAct(g, seat, d);
        return 'bot-act';
      },
    };
  }
  if (h.deadline == null) return null;
  // A human's decision timer.
  return {
    kind: 'timeout',
    at: h.deadline,
    delay: Math.max(0, h.deadline - now),
    apply: (g) => holdemAutoStep(g, rng, Date.now()),
  };
}
