// A simple but sensible cribbage bot. Pure functions over the engine state,
// shared by the server and the in-browser demo.
import {
  newDeck, scoreHand, scorePegging, valueOf, rankOf, legalPlays, discardCount, sideOf,
} from './engine.js';

export const BOT_NAMES = ['Botley', 'Ada', 'Pegsy', 'Muggins'];

function combos(arr, k, start = 0, acc = [], out = []) {
  if (acc.length === k) out.push([...acc]);
  else for (let i = start; i < arr.length; i++) combos(arr, k, i + 1, [...acc, arr[i]], out);
  return out;
}

/** Rough value of cards thrown into a crib, before the starter and other cards are known. */
function cribGuess(cards) {
  let v = 0;
  if (cards.length === 2) {
    const [a, b] = cards;
    if (rankOf(a) === rankOf(b)) v += 2;
    if (valueOf(a) + valueOf(b) === 15) v += 2;
    if (Math.abs(rankOf(a) - rankOf(b)) === 1) v += 1;
    if (a[1] === b[1]) v += 0.3;
  }
  for (const c of cards) {
    if (c[0] === '5') v += 1.5;
    if (c[0] === 'J') v += 0.3;
  }
  return v + 3.5; // other players' throws and the starter add something on average
}

/** Pick the cards to send to the crib: best average hand over every possible starter. */
export function chooseDiscard(state, seat) {
  const hand = state.hands[seat];
  const k = discardCount(state.numPlayers);
  const unseen = newDeck().filter((c) => !hand.includes(c));
  const myCrib = state.dealer === seat || (state.numPlayers === 4 && sideOf(state, state.dealer) === sideOf(state, seat));
  let best = null;
  for (const throwAway of combos(hand, k)) {
    const keep = hand.filter((c) => !throwAway.includes(c));
    let total = 0;
    for (const starter of unseen) total += scoreHand(keep, starter).total;
    const crib = cribGuess(throwAway) * (state.numPlayers === 2 ? 1 : 0.6);
    const value = total / unseen.length + (myCrib ? crib : -crib);
    if (!best || value > best.value) best = { value, cards: throwAway };
  }
  return best.cards;
}

/** Pick a pegging card: take points now, avoid handing them over, keep good cards for later. */
export function choosePlay(state, seat) {
  const p = state.pegging;
  const legal = legalPlays(state, seat);
  let best = null;
  for (const card of legal) {
    const count = p.count + valueOf(card);
    const pile = [...p.pile, card];
    let score = scorePegging(pile, count).reduce((t, i) => t + i.points, 0) * 10;

    if (count < 31) {
      // Danger: counts where the next player is likely to score.
      if (count === 5 || count === 21) score -= 6; // a ten-card makes 15 / 31
      if (count > 5 && count < 15) score -= 2; // something makes 15
      if (count >= 22 && count <= 30) score -= 1; // closing in on 31
      score -= 1.5; // any card can be paired
      // Leading: low cards can't be fifteened; never lead a 5.
      if (p.count === 0) {
        if (valueOf(card) <= 4) score += 3;
        if (card[0] === '5') score -= 5;
      }
    }
    // Hold on to 5s and low cards, which are more useful later; shed tens early.
    score += valueOf(card) * 0.15;
    if (card[0] === '5') score -= 1;
    if (!best || score > best.score) best = { score, card };
  }
  return best.card;
}

/** The bot's next action, or null if no bot is on the clock. */
export function botMove(state) {
  if (state.status !== 'playing') return null;
  if (state.phase === 'discard') {
    const seat = state.players.findIndex((pl, i) => pl.bot && !state.discarded[i]);
    return seat === -1 ? null : { type: 'discard', seat, cards: chooseDiscard(state, seat) };
  }
  if (state.phase === 'pegging') {
    const seat = state.pegging.turn;
    return state.players[seat]?.bot ? { type: 'play', seat, card: choosePlay(state, seat) } : null;
  }
  return null;
}
