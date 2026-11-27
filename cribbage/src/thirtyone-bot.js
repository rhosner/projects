// A simple Thirty-One bot and the step scheduler for Thirty-One games.
// It takes the discard when that clearly improves its hand, otherwise draws
// blind; always keeps the best three cards; and knocks once its hand is good
// enough (a lower bar as the round drags on, since everyone's hands improve).
import { randomInt } from './engine.js';
import { handValue, thirtyOneAct, thirtyOneAutoStep, thirtyOnePeek, THIRTYONE_DELAY } from './thirtyone.js';

/** Best 3-card value keepable from these cards, and which card to throw away. */
export function bestDiscard(cards, forbidden = null) {
  let best = null;
  for (const c of cards) {
    if (c === forbidden) continue;
    const v = handValue(cards.filter((x) => x !== c)).value;
    if (!best || v > best.value) best = { card: c, value: v };
  }
  return best;
}

export function thirtyOneBotDecision(state, seat, rng = Math.random) {
  const hand = state.hands[seat];
  if (state.phase === 'drawn') {
    const forbidden = state.drew?.from === 'discard' ? state.drew.card : null;
    return { type: 'discard', card: bestDiscard(hand, forbidden).card };
  }
  const now = handValue(hand).value;
  const turnsThisRound = state.log.filter((e) => e.hand === state.round && e.kind === 'discard').length;
  const bar = turnsThisRound > state.numPlayers * 2 ? 25 : 27;
  if (state.knocker === null && now >= bar - (rng() < 0.2 ? 1 : 0)) return { type: 'knock' };
  const top = state.discard.at(-1);
  if (top) {
    const withTop = bestDiscard([...hand, top], top);
    if (withTop.value >= now + 4 || (withTop.value >= 28 && withTop.value > now)) return { type: 'draw', from: 'discard' };
  }
  return { type: 'draw', from: 'stock' };
}

export function thirtyOneNextAutomatic(state, { pace = 1, rng = randomInt } = {}) {
  if (state.status !== 'playing') return null;
  const step = thirtyOnePeek(state);
  if (step) return { kind: step, delay: Math.round(THIRTYONE_DELAY['next-round'] * pace), apply: (g) => thirtyOneAutoStep(g, rng) };
  if (!['turn', 'drawn'].includes(state.phase) || state.turn == null || !state.players[state.turn].bot) return null;
  const seat = state.turn;
  const phase = state.phase;
  return {
    kind: 'bot-move',
    // Drawing takes a moment of thought; discarding right after is quicker.
    delay: Math.round(THIRTYONE_DELAY['bot-move'] * pace * (phase === 'drawn' ? 0.6 : 0.8 + Math.random() * 0.7)),
    apply: (g) => {
      if (g.turn !== seat || g.phase !== phase || !g.players[seat].bot) return null;
      thirtyOneAct(g, seat, thirtyOneBotDecision(g, seat));
      return 'bot-move';
    },
  };
}
