import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestHand, score5, compareScores } from '../src/poker-hands.js';
import {
  createHoldem, addHoldemPlayer, startHoldem, holdemAct, holdemAutoStep, options, buildPots, holdemView, yourHandName,
} from '../src/holdem.js';
import { holdemBotDecision, holdemNextAutomatic, chenScore } from '../src/holdem-bot.js';

function seeded(seed) {
  let s = seed >>> 0;
  return (max) => ((s = (s * 1664525 + 1013904223) >>> 0), s % max);
}
const cmp = (a, b) => compareScores(bestHand(a).score, bestHand(b).score);

test('hand ranking: categories and kickers', () => {
  assert.equal(bestHand(['AH', 'KH', 'QH', 'JH', 'TH', '2C', '3D']).name, 'Royal flush');
  assert.equal(bestHand(['5S', '4S', '3S', '2S', 'AS']).name, 'Straight flush, Five high');
  assert.equal(bestHand(['AH', '2C', '3D', '4S', '5H', 'KD', 'KC']).name, 'Straight, Five high', 'wheel beats a pair');
  assert.equal(bestHand(['8H', '8C', '8D', 'KS', 'KH', '2C', '3D']).name, 'Full house, Eights full of Kings');
  assert.equal(bestHand(['2H', '7H', '9H', 'JH', 'KH', 'AC', 'AD']).name, 'Flush, King high');
  // Order of categories
  const order = [
    ['2H', '5C', '9D', 'JS', 'KH'], ['2H', '2C', '9D', 'JS', 'KH'], ['2H', '2C', '9D', '9S', 'KH'],
    ['2H', '2C', '2D', 'JS', 'KH'], ['5H', '6C', '7D', '8S', '9H'], ['2H', '5H', '9H', 'JH', 'KH'],
    ['2H', '2C', '2D', 'KS', 'KH'], ['2H', '2C', '2D', '2S', 'KH'], ['5H', '6H', '7H', '8H', '9H'],
  ];
  for (let i = 1; i < order.length; i++) assert.ok(compareScores(score5(order[i]), score5(order[i - 1])) > 0, `${i} beats ${i - 1}`);
  // Kickers and ties
  assert.ok(cmp(['AH', 'AC', 'KD', '7S', '3H'], ['AS', 'AD', 'QD', 'JS', 'TH']) > 0, 'pair of aces, king kicker wins');
  assert.equal(cmp(['AH', 'KC', 'QD', 'JS', '9H'], ['AS', 'KD', 'QC', 'JH', '9D']), 0, 'identical ranks split');
  assert.ok(cmp(['6H', '5C', '4D', '3S', '2H'], ['5S', '4H', '3D', '2C', 'AH']) > 0, 'six-high straight beats the wheel');
  assert.equal(cmp(['2H', '2C', 'AD', 'AS', 'KH', 'KC', 'QD'], ['AH', 'AC', 'KD', 'KS', 'QH', 'JC', '3D']), 0, 'best five only: two pair AK with Q kicker both');
});

test('side pots: main pot and side pots by all-in levels', () => {
  // A all-in 100, B all-in 300, C calls 300; nobody folded.
  assert.deepEqual(buildPots([100, 300, 300], [false, false, false]), [
    { amount: 300, eligible: [0, 1, 2] },
    { amount: 400, eligible: [1, 2] },
  ]);
  // Folded player's chips stay in the pot, but they can't win it.
  assert.deepEqual(buildPots([50, 200, 200], [true, false, false]), [{ amount: 450, eligible: [1, 2] }]);
  // Uncalled excess comes back as a pot only its owner can win.
  assert.deepEqual(buildPots([500, 120], [false, false]), [
    { amount: 240, eligible: [0, 1] },
    { amount: 380, eligible: [0] },
  ]);
  // Three all-ins at different levels plus a caller.
  const pots = buildPots([50, 120, 300, 300], [false, false, false, false]);
  assert.deepEqual(pots.map((p) => [p.amount, p.eligible.join('')]), [[200, '0123'], [210, '123'], [360, '23']]);
  assert.equal(pots.reduce((a, p) => a + p.amount, 0), 770, 'every chip accounted for');
});

function table(n, seed, settings = {}) {
  const rng = seeded(seed);
  const g = createHoldem({ id: 'h', maxPlayers: n, settings });
  for (let i = 0; i < n; i++) addHoldemPlayer(g, { id: `p${i}`, name: `P${i}`, tokenHash: `t${i}` }, rng);
  return { g, rng };
}
const chips = (g) => g.players.reduce((a, p) => a + p.stack, 0) + (g.hand ? g.hand.committed.reduce((a, b) => a + b, 0) : 0);
const settle = (g, rng) => {
  for (let i = 0; i < 50 && holdemAutoStep(g, rng, -Infinity); i++);
};

test('heads-up: button posts small blind and acts first preflop, last after the flop', () => {
  const { g, rng } = table(2, 7);
  const btn = g.button;
  const other = 1 - btn;
  assert.equal(g.hand.sbSeat, btn);
  assert.equal(g.hand.bbSeat, other);
  assert.equal(g.hand.toAct, btn, 'button acts first preflop');
  holdemAct(g, btn, { type: 'call' });
  assert.equal(g.hand.toAct, other, 'big blind gets the option');
  holdemAct(g, other, { type: 'check' });
  assert.equal(holdemAutoStep(g, rng, -Infinity), 'flop');
  assert.equal(g.board.length, 3);
  assert.equal(g.hand.toAct, other, 'big blind acts first after the flop');
});

test('minimum raises, and a short all-in does not reopen betting', () => {
  const { g } = table(3, 11, { startingStack: 1000, bigBlind: 20 });
  const h = g.hand;
  const first = h.toAct; // under the gun (left of the big blind)
  // Make the next player short-stacked before they act.
  const second = (first + 1) % 3;
  const third = (first + 2) % 3;
  holdemAct(g, first, { type: 'raise', amount: 60 }); // raise of 40
  assert.throws(() => holdemAct(g, second, { type: 'raise', amount: 80 }), /minimum raise is to 100/);
  g.players[second].stack = 70 - h.bets[second]; // can go all in to 70 total: a raise of only 10
  holdemAct(g, second, { type: 'raise', amount: 70 });
  assert.equal(h.allIn[second], true);
  holdemAct(g, third, { type: 'call' });
  // Back to the first raiser: facing an incomplete raise, they may only call or fold.
  assert.equal(h.toAct, first);
  assert.equal(options(g, first).canRaise, false);
  assert.throws(() => holdemAct(g, first, { type: 'raise', amount: 200 }), /only call or fold/);
  holdemAct(g, first, { type: 'call' });
  assert.equal(h.roundDone, true);
});

test('everyone folds to one player: they win the pot without showing', () => {
  const { g, rng } = table(3, 3);
  const before = chips(g);
  holdemAct(g, g.hand.toAct, { type: 'fold' });
  holdemAct(g, g.hand.toAct, { type: 'fold' });
  assert.equal(holdemAutoStep(g, rng, -Infinity), 'award');
  assert.equal(g.lastHand.showdown, false);
  assert.equal(chips(g), before);
  assert.equal(holdemAutoStep(g, rng, -Infinity), 'next-hand');
  assert.equal(g.handNo, 2);
});

test('the decision timer checks when free, otherwise folds; two timeouts mark a player away', () => {
  const { g, rng } = table(3, 5, { actionSeconds: 30 });
  const seat = g.hand.toAct;
  assert.ok(g.hand.deadline > Date.now() + 25_000);
  assert.equal(holdemAutoStep(g, rng, Date.now()), null, 'not before the deadline');
  assert.equal(holdemAutoStep(g, rng, g.hand.deadline), 'timeout');
  assert.equal(g.hand.folded[seat], true, 'facing the big blind, a timeout folds');
  assert.equal(g.players[seat].timeouts, 1);
});

test('views: you see your own cards only, and the right options', () => {
  const { g } = table(4, 9);
  const v = holdemView(g, 0);
  assert.equal(v.hand.length, 2);
  for (const s of [1, 2, 3]) for (const c of g.hand.hole[s]) assert.ok(!JSON.stringify(v).includes(`"${c}"`), `seat 0 can't see ${c}`);
  assert.ok(!JSON.stringify(v).includes('"deck"'));
  const turn = g.hand.toAct;
  assert.deepEqual(Object.keys(holdemView(g, turn).options).sort(), ['bet', 'canCheck', 'canRaise', 'currentBet', 'maxRaiseTo', 'minRaiseTo', 'toCall']);
});

// Fuzz: random legal decisions through whole tournaments. Chips must never be
// created or destroyed, stacks never go negative, and every game must end.
test('random tournaments conserve chips and always finish', () => {
  for (const n of [2, 3, 6, 9]) {
    for (let seed = 1; seed <= 12; seed++) {
      const { g, rng } = table(n, seed * 101 + n, { startingStack: 600, bigBlind: 20, levelHands: 5 });
      const total = chips(g);
      let guard = 0;
      while (g.status === 'playing') {
        assert.ok(guard++ < 20000, 'tournament stalled');
        if (holdemAutoStep(g, rng, -Infinity)) {
          assert.equal(chips(g), total, `chips conserved (n=${n}, seed=${seed}, hand ${g.handNo})`);
          continue;
        }
        const s = g.hand.toAct;
        const o = options(g, s);
        assert.ok(o, 'someone must be able to act');
        const r = rng(10);
        let a;
        if (r < 2) a = { type: 'fold' };
        else if (r < 6) a = o.canCheck ? { type: 'check' } : { type: 'call' };
        else if (o.canRaise) a = { type: 'raise', amount: r === 9 ? o.maxRaiseTo : o.minRaiseTo + rng(Math.max(1, o.maxRaiseTo - o.minRaiseTo)) };
        else a = { type: 'call' };
        if (a.type === 'call' && o.canCheck) a = { type: 'check' };
        holdemAct(g, s, a);
        assert.ok(g.players.every((p) => p.stack >= 0));
        assert.equal(chips(g), total);
      }
      assert.equal(g.players[g.winner].stack, total, 'winner holds every chip');
      const places = g.players.map((p) => p.place).sort((a, b) => a - b);
      assert.deepEqual(places, [...Array(n).keys()].map((i) => i + 1), 'every finishing place assigned once');
    }
  }
});

test('bots play whole tournaments through the scheduler alone', () => {
  for (const n of [2, 4, 6]) {
    const rng = seeded(n * 31);
    const g = createHoldem({ id: 'b', maxPlayers: n, settings: { startingStack: 500, bigBlind: 20, levelHands: 4 } });
    for (let i = 0; i < n; i++) addHoldemPlayer(g, { id: `b${i}`, name: `B${i}`, tokenHash: '', bot: true }, rng);
    let guard = 0;
    while (g.status === 'playing') {
      assert.ok(guard++ < 20000, 'bot tournament stalled');
      const step = holdemNextAutomatic(g, { rng });
      assert.ok(step, `nothing to do (phase ${g.phase})`);
      assert.ok(step.apply(g), `${step.kind} did nothing`);
    }
    assert.equal(g.status, 'finished');
  }
});

test('bot sanity: strong hands raise, junk folds to a raise', () => {
  assert.ok(chenScore(['AH', 'AS']) >= 20);
  assert.ok(chenScore(['7C', '2D']) <= 0);
  const { g } = table(3, 21);
  const s = g.hand.toAct;
  g.hand.hole[s] = ['AH', 'AS'];
  assert.equal(holdemBotDecision(g, s, () => 0.5).type, 'raise');
  holdemAct(g, s, { type: 'raise', amount: 200 });
  const t = g.hand.toAct;
  g.hand.hole[t] = ['7C', '2D'];
  assert.equal(holdemBotDecision(g, t, () => 0.5).type, 'fold');
});

test('host can start before every seat fills', () => {
  const rng = seeded(4);
  const g = createHoldem({ id: 'h', maxPlayers: 6 });
  addHoldemPlayer(g, { id: 'a', name: 'A', tokenHash: 'x' }, rng);
  assert.throws(() => startHoldem(g, rng), /at least 2/);
  addHoldemPlayer(g, { id: 'b', name: 'B', tokenHash: 'y' }, rng);
  addHoldemPlayer(g, { id: 'c', name: 'C', tokenHash: 'z' }, rng);
  startHoldem(g, rng);
  assert.equal(g.numPlayers, 3);
  assert.equal(g.status, 'playing');
});

test('your hand name: before the flop and after', () => {
  assert.equal(yourHandName(['KH', 'KS'], []), 'Pocket Kings');
  assert.equal(yourHandName(['6H', '6S'], []), 'Pocket Sixes');
  assert.equal(yourHandName(['KS', 'AS'], []), 'Ace-King suited');
  assert.equal(yourHandName(['9D', 'TC'], []), 'Ten-Nine');
  assert.equal(yourHandName(['KH', '4C'], ['KD', '7S', '2H']), 'Pair of Kings');
  assert.equal(yourHandName(['AH', '9H'], ['2H', '7H', 'KH', '3C']), 'Flush, Ace high');
  const { g } = table(3, 2);
  const v = holdemView(g, 0);
  assert.ok(v.yourHandName, 'shown to you');
  assert.ok(!holdemView(g, null).yourHandName, 'spectators get nothing');
});
