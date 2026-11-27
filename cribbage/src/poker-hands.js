// Poker hand evaluation: best 5-card hand out of 5-7 cards.
// Cards use the same 2-char format as the rest of the app ("TH" = ten of hearts).

const RANKS = '23456789TJQKA';
export const pokerRank = (c) => RANKS.indexOf(c[0]) + 2; // 2..14

export const HAND_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
];

/**
 * Score exactly five cards. Returns an array that compares lexicographically:
 * [category, ...tiebreakers]. Higher is better.
 */
export function score5(cards) {
  const ranks = cards.map(pokerRank).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  // Groups sorted by size, then rank: e.g. full house 8-8-8-K-K -> [[3,8],[2,13]]
  const groups = [...counts.entries()].map(([r, n]) => [n, r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (unique.join() === '14,5,4,3,2') straightHigh = 5; // the wheel: A-2-3-4-5
  }

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, groups[0][1], ...groups.slice(1).map((g) => g[1])];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, groups[0][1], groups[1][1], groups[2][1]];
  if (groups[0][0] === 2) return [1, groups[0][1], ...groups.slice(1).map((g) => g[1])];
  return [0, ...ranks];
}

export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Best five-card hand from 5-7 cards: { score, cards, name }. */
export function bestHand(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = score5(five);
            if (!best || compareScores(s, best.score) > 0) best = { score: s, cards: five };
          }
  best.name = describe(best.score);
  return best;
}

const RANK_NAME = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
const HIGH_NAME = { 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };

/** Human description, e.g. "Full house, Eights full of Kings". */
export function describe(score) {
  const [cat, a, b] = score;
  switch (cat) {
    case 8: return a === 14 ? 'Royal flush' : `Straight flush, ${HIGH_NAME[a]} high`;
    case 7: return `Four of a kind, ${RANK_NAME[a]}`;
    case 6: return `Full house, ${RANK_NAME[a]} full of ${RANK_NAME[b]}`;
    case 5: return `Flush, ${HIGH_NAME[a]} high`;
    case 4: return `Straight, ${HIGH_NAME[a]} high`;
    case 3: return `Three of a kind, ${RANK_NAME[a]}`;
    case 2: return `Two pair, ${RANK_NAME[a]} and ${RANK_NAME[b]}`;
    case 1: return `Pair of ${RANK_NAME[a]}`;
    default: return `${HIGH_NAME[a] ?? a} high`;
  }
}
