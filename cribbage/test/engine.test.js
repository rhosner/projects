import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreHand,
  scorePegging,
  createGame,
  addPlayer,
  discard,
  play,
  legalPlays,
  viewFor,
  discardCount,
  WIN_SCORE,
} from '../src/engine.js';

const total = (hand, starter, crib = false) => scoreHand(hand, starter, crib).total;

test('hand scoring: known hands', () => {
  assert.equal(total(['5H', '5C', '5S', 'JD'], '5D'), 29, 'perfect 29');
  assert.equal(total(['5H', '5C', '5S', 'JH'], '5D'), 28);
  assert.equal(total(['3H', '3C', '3S', '3D'], '9S'), 24, 'four 3s + 9: 12 pairs + 12 fifteens');
  assert.equal(total(['AH', '2C', '3S', '4D'], '5S'), 7, 'run of 5 + one fifteen');
  assert.equal(total(['4H', '5C', '6S', '6D'], 'KS'), 14, 'double run (6) + pair (2) + 3 fifteens (6)');
  assert.equal(total(['7H', '7C', '8S', '9D'], '8D'), 24, 'double double run (16) + 4 fifteens (8)');
  assert.equal(total(['2H', '4H', '6H', '8H'], 'KC'), 4, 'four-card flush, no fifteens');
  assert.equal(total(['2H', '4H', '6H', '8H'], 'KH'), 5, 'five-card flush');
  assert.equal(total(['2H', '4H', '6H', '8H'], 'KC', true), 0, 'crib needs five-card flush');
  assert.equal(total(['2H', '4H', '6H', '8H'], 'KH', true), 5);
  assert.equal(total(['JH', '2C', '4S', '6D'], 'QH'), 1, 'nobs only');
  assert.equal(total(['JH', '2C', '4S', '6D'], 'QS'), 0, 'jack not matching starter suit');
  assert.equal(total(['2C', '4S', '6D', '8H'], 'TC'), 0, 'nineteen hand');
});

test('pegging scoring', () => {
  const pts = (pile) => {
    const count = pile.reduce((t, c) => t + Math.min('A23456789TJQK'.indexOf(c[0]) + 1, 10), 0);
    return scorePegging(pile, count).reduce((t, i) => t + i.points, 0);
  };
  assert.equal(pts(['TH', '5S']), 2, 'fifteen');
  assert.equal(pts(['7H', '7S']), 2, 'pair');
  assert.equal(pts(['7H', '7S', '7D']), 6, 'three of a kind');
  assert.equal(pts(['2H', '2S', '2D', '2C']), 12, 'four of a kind');
  assert.equal(pts(['3H', '5S', '4D']), 3, 'run of 3 out of order');
  assert.equal(pts(['3H', '5S', '4D', '6C']), 4, 'run of 4');
  assert.equal(pts(['3H', '4S', '4D', '5C']), 0, 'pair breaks the run');
  assert.equal(pts(['3H', '5S', '4D', '3C']), 5, 'trailing 5-4-3 run + fifteen');
  assert.equal(pts(['4H', '5S', '6D']), 5, 'run of 3 + fifteen');
  assert.equal(pts(['KH', 'QS', '6D', '5C']), 2, 'thirty-one');
  assert.equal(pts(['7H', '8S', '8D']), 2, 'pair after run is not a run');
});

// Deterministic RNG for reproducible simulations.
function seeded(seed) {
  let s = seed >>> 0;
  return (max) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % max;
  };
}

function simulate(numPlayers, seed) {
  const rng = seeded(seed);
  const g = createGame({ id: 'g', numPlayers });
  for (let i = 0; i < numPlayers; i++) addPlayer(g, { id: `p${i}`, name: `P${i}`, tokenHash: 'x' }, rng);
  let steps = 0;
  let maxHands = 0;
  while (g.status === 'playing') {
    if (++steps > 5000) throw new Error('game did not finish');
    if (g.phase === 'discard') {
      for (let s = 0; s < numPlayers; s++) {
        if (!g.discarded[s] && g.status === 'playing' && g.phase === 'discard') {
          discard(g, s, g.hands[s].slice(0, discardCount(numPlayers)), rng);
        }
      }
    } else if (g.phase === 'pegging') {
      const t = g.pegging.turn;
      const legal = legalPlays(g, t);
      assert.ok(legal.length > 1 || !g.autoPlay, 'engine only waits on a real choice');
      play(g, t, legal[rng(legal.length)], rng);
    }
    maxHands = g.handNo;
    // Invariants
    const v = viewFor(g, 0);
    assert.ok(g.scores.every((x) => x >= 0 && x <= WIN_SCORE));
    if (g.phase === 'pegging') assert.ok(g.pegging.count <= 31);
    assert.ok(!JSON.stringify(v).includes('"deck"'), 'view never leaks the deck');
  }
  assert.equal(g.status, 'finished');
  assert.equal(g.scores[g.winner], WIN_SCORE);
  return maxHands;
}

test('full games play to completion for 2, 3 and 4 players', () => {
  for (const n of [2, 3, 4]) {
    for (let seed = 1; seed <= 40; seed++) {
      const hands = simulate(n, seed * 7919 + n);
      assert.ok(hands >= 3 && hands < 40, `n=${n} seed=${seed} took ${hands} hands`);
    }
  }
});

test('views hide other players cards and the crib', () => {
  const rng = seeded(42);
  const g = createGame({ id: 'g', numPlayers: 2 });
  addPlayer(g, { id: 'a', name: 'A', tokenHash: 'x' }, rng);
  addPlayer(g, { id: 'b', name: 'B', tokenHash: 'y' }, rng);
  const v0 = viewFor(g, 0);
  assert.equal(v0.hand.length, 6);
  for (const c of g.hands[1]) assert.ok(!JSON.stringify(v0).includes(`"${c}"`), `seat 0 cannot see ${c}`);
  const spectator = viewFor(g, null);
  assert.equal(spectator.hand.length, 0);
  assert.equal(JSON.stringify(spectator).includes('tokenHash'), false);
});

test('rule violations are rejected', () => {
  const rng = seeded(3);
  const g = createGame({ id: 'g', numPlayers: 2 });
  addPlayer(g, { id: 'a', name: 'A', tokenHash: 'x' }, rng);
  addPlayer(g, { id: 'b', name: 'B', tokenHash: 'y' }, rng);
  assert.throws(() => discard(g, 0, [g.hands[0][0]], rng), /Pick 2/);
  assert.throws(() => discard(g, 0, [g.hands[1][0], g.hands[1][1]], rng), /not in your hand/);
  assert.throws(() => addPlayer(g, { id: 'c', name: 'C', tokenHash: 'z' }, rng), /already started/);
  discard(g, 0, g.hands[0].slice(0, 2), rng);
  assert.throws(() => discard(g, 0, ['AS', '2S'], rng), /already discarded/);
});
