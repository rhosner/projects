import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handValue, createThirtyOne, addThirtyOnePlayer, startThirtyOne, thirtyOneAct, thirtyOneAutoStep, thirtyOneView,
} from '../src/thirtyone.js';
import { thirtyOneNextAutomatic, thirtyOneBotDecision } from '../src/thirtyone-bot.js';

function seeded(seed) {
  let s = seed >>> 0;
  return (max) => ((s = (s * 1664525 + 1013904223) >>> 0), s % max);
}

function table(n, seed = 1, settings = {}) {
  const rng = seeded(seed);
  const g = createThirtyOne({ id: 't', maxPlayers: n, settings });
  for (let i = 0; i < n; i++) addThirtyOnePlayer(g, { id: `p${i}`, name: `P${i}`, tokenHash: `t${i}` }, rng);
  return { g, rng };
}
/** Put the game in a known position: these hands, this discard top, seat `turn` to play. */
function rig(g, hands, top, turn) {
  g.hands = hands.map((h) => [...h]);
  g.discard = [top];
  g.turn = turn;
  g.phase = 'turn';
  g.knocker = null;
  g.pending = [];
  g.drew = null;
}

test('hand values: only one suit counts; ace 11, faces 10', () => {
  assert.equal(handValue(['AS', '8S', 'KH']).value, 19, 'the example from the rules');
  assert.equal(handValue(['AS', 'KS', 'QS']).value, 31);
  assert.equal(handValue(['AH', 'AS', 'AD']).value, 11, 'no special value for three of a kind');
  assert.equal(handValue(['2C', '3D', '4H']).value, 4);
});

test('a turn: draw from either pile, then discard; you can’t throw back the card you took', () => {
  const { g } = table(3);
  rig(g, [['2C', '3D', '4H'], ['5S', '6S', '7S'], ['8H', '9H', 'TH']], 'KD', 0);
  assert.throws(() => thirtyOneAct(g, 0, { type: 'discard', card: '2C' }), /Draw a card first/);
  thirtyOneAct(g, 0, { type: 'draw', from: 'discard' });
  assert.equal(g.hands[0].length, 4);
  assert.throws(() => thirtyOneAct(g, 0, { type: 'discard', card: 'KD' }), /throw back/);
  thirtyOneAct(g, 0, { type: 'discard', card: '2C' });
  assert.equal(g.discard.at(-1), '2C');
  assert.equal(g.turn, 1, 'play passes left');
  assert.throws(() => thirtyOneAct(g, 0, { type: 'draw', from: 'stock' }), /not your turn/);
});

test('knock: everyone else gets one more turn, then the lowest hand loses a token', () => {
  const { g, rng } = table(3);
  rig(g, [['AS', 'KS', '9S'], ['2C', '3D', '4H'], ['8H', '9H', 'TH']], '5C', 0);
  thirtyOneAct(g, 0, { type: 'knock' });
  assert.equal(g.turn, 1);
  assert.throws(() => thirtyOneAct(g, 1, { type: 'knock' }), /already knocked/);
  thirtyOneAct(g, 1, { type: 'draw', from: 'discard' }); // takes 5C
  thirtyOneAct(g, 1, { type: 'discard', card: '4H' });
  thirtyOneAct(g, 2, { type: 'draw', from: 'stock' });
  thirtyOneAct(g, 2, { type: 'discard', card: g.hands[2].find((c) => c[1] !== 'H') ?? g.hands[2][0] });
  assert.equal(g.phase, 'roundover', 'the knocker does not play again');
  const lost = g.lastRound.hands.filter((h) => h.lost).map((h) => h.seat);
  assert.deepEqual(lost, [1], 'seat 1 (2C 3D 5C = 8) is lowest');
  assert.equal(g.players[1].tokens, 5);
  assert.equal(thirtyOneAutoStep(g, rng), 'next-round');
  assert.equal(g.round, 2);
});

test('a knocker with the lowest hand loses 2 tokens; ties for lowest all lose', () => {
  const { g } = table(3);
  rig(g, [['2C', '3D', '4H'], ['AS', 'KS', '9S'], ['5C', '6D', '7H']], 'QH', 0);
  thirtyOneAct(g, 0, { type: 'knock' });
  for (const s of [1, 2]) {
    thirtyOneAct(g, s, { type: 'draw', from: 'stock' });
    // Throw away the drawn card to keep hands as they are.
    thirtyOneAct(g, s, { type: 'discard', card: g.hands[s][3] });
  }
  assert.equal(g.players[0].tokens, 4, 'knocker lost 2');

  const t = table(3, 2).g;
  rig(t, [['AS', 'KS', '9S'], ['2C', '3D', '4H'], ['2D', '3C', '4S']], 'QH', 0);
  thirtyOneAct(t, 0, { type: 'knock' });
  for (const s of [1, 2]) {
    thirtyOneAct(t, s, { type: 'draw', from: 'stock' });
    thirtyOneAct(t, s, { type: 'discard', card: t.hands[s][3] });
  }
  assert.deepEqual([t.players[1].tokens, t.players[2].tokens], [5, 5], 'both tied low hands lose');
});

test('31 wins the round at once; everyone else loses a token (including a knocker, who loses just 1)', () => {
  const { g } = table(3);
  rig(g, [['5C', '6D', '7H'], ['AS', 'KS', '2D'], ['8H', '9H', 'TH']], 'QS', 0);
  thirtyOneAct(g, 0, { type: 'knock' });
  thirtyOneAct(g, 1, { type: 'draw', from: 'discard' }); // QS
  thirtyOneAct(g, 1, { type: 'discard', card: '2D' }); // AS KS QS = 31
  assert.equal(g.phase, 'roundover', 'ends at once: seat 2 never gets its last turn');
  assert.equal(g.lastRound.reason, '31');
  assert.deepEqual(g.players.map((p) => p.tokens), [5, 6, 5], 'knocker (seat 0) loses only 1');
});

test('dealt 31 wins immediately', () => {
  const rng = seeded(1);
  // Search seeds for a deal that hands someone 31, so the rule is exercised for real.
  for (let seed = 1; seed < 20000; seed++) {
    const t = table(4, seed);
    if (t.g.round === 1 && t.g.phase === 'roundover') {
      assert.equal(t.g.lastRound.reason, '31');
      assert.ok(t.g.lastRound.winners31.length >= 1);
      return;
    }
  }
  void rng;
  assert.fail('no dealt 31 found');
});

test('on their honor at 0 tokens; out on the next loss; a knocker with 1 token losing 2 goes straight out', () => {
  const { g, rng } = table(3, 1, { tokens: 1 });
  rig(g, [['AS', 'KS', '9S'], ['2C', '3D', '4H'], ['8H', '9H', 'TH']], 'QD', 0);
  thirtyOneAct(g, 0, { type: 'knock' });
  for (const s of [1, 2]) {
    thirtyOneAct(g, s, { type: 'draw', from: 'stock' });
    thirtyOneAct(g, s, { type: 'discard', card: g.hands[s][3] });
  }
  assert.equal(g.players[1].tokens, 0);
  assert.equal(thirtyOneView(g, 1).players[1].onHonor, true);
  thirtyOneAutoStep(g, rng);
  assert.equal(g.players[1].out, false, 'still playing on their honor');

  const t = table(3, 3, { tokens: 1 }).g;
  rig(t, [['2C', '3D', '4H'], ['AS', 'KS', '9S'], ['8H', '9H', 'TH']], 'QD', 0);
  thirtyOneAct(t, 0, { type: 'knock' });
  for (const s of [1, 2]) {
    thirtyOneAct(t, s, { type: 'draw', from: 'stock' });
    thirtyOneAct(t, s, { type: 'discard', card: t.hands[s][3] });
  }
  thirtyOneAutoStep(t, seeded(9));
  assert.equal(t.players[0].out, true, 'lost 2 with only 1 token');
  assert.equal(t.players[0].place, 3);
});

test('if everyone left would go out together, nobody does', () => {
  const { g, rng } = table(2, 1, { tokens: 1 });
  g.players.forEach((p) => (p.tokens = 0)); // both on their honor
  rig(g, [['2C', '3D', '4H'], ['2D', '3C', '4S']], 'QD', 0);
  thirtyOneAct(g, 0, { type: 'draw', from: 'stock' });
  thirtyOneAct(g, 0, { type: 'discard', card: g.hands[0][3] });
  thirtyOneAct(g, 1, { type: 'knock' });
  thirtyOneAct(g, 0, { type: 'draw', from: 'stock' });
  thirtyOneAct(g, 0, { type: 'discard', card: g.hands[0][3] });
  // Tied low (4 each); seat 1 knocked. Both would be out.
  assert.equal(g.lastRound.spared, true);
  thirtyOneAutoStep(g, rng);
  assert.equal(g.status, 'playing');
  assert.ok(g.players.every((p) => !p.out));
});

test('an empty stock is rebuilt from the discard pile', () => {
  const { g } = table(2);
  rig(g, [['2C', '3D', '4H'], ['5S', '6S', '7S']], 'KD', 0);
  g.stock = [];
  g.discard = ['9C', '8C', 'KD'];
  thirtyOneAct(g, 0, { type: 'draw', from: 'stock' });
  assert.equal(g.discard.length, 1, 'top card stays');
  assert.equal(g.discard[0], 'KD');
  assert.equal(g.stock.length, 1);
});

test('views hide other hands until the round is over', () => {
  const { g } = table(3, 5);
  if (g.phase === 'roundover') return; // dealt 31 on this seed; covered elsewhere
  const v = thirtyOneView(g, 0);
  assert.equal(v.hand.length, 3);
  for (const s of [1, 2]) for (const c of g.hands[s]) assert.ok(!JSON.stringify(v).includes(`"${c}"`) || g.discard.includes(c));
  assert.ok(!JSON.stringify(v).includes('"stock"'));
});

test('random games and all-bot games always finish with a single winner', () => {
  for (const n of [2, 3, 5, 8]) {
    for (let seed = 1; seed <= 15; seed++) {
      const { g, rng } = table(n, seed * 13 + n, { tokens: 2 });
      let guard = 0;
      while (g.status === 'playing') {
        assert.ok(guard++ < 20000, 'game stalled');
        if (thirtyOneAutoStep(g, rng)) continue;
        const s = g.turn;
        const r = rng(10);
        if (g.phase === 'turn') {
          if (r === 0 && g.knocker === null) thirtyOneAct(g, s, { type: 'knock' });
          else thirtyOneAct(g, s, { type: 'draw', from: r < 4 ? 'discard' : 'stock' });
        } else {
          const ok = g.hands[s].filter((c) => !(g.drew?.from === 'discard' && c === g.drew.card));
          thirtyOneAct(g, s, { type: 'discard', card: ok[rng(ok.length)] });
        }
        const cards = g.hands.flat().length + g.stock.length + g.discard.length;
        if (g.phase !== 'roundover') assert.equal(cards, 52, 'every card accounted for');
      }
      assert.equal(g.players.filter((p) => !p.out).length, 1);
      assert.deepEqual(g.players.map((p) => p.place).sort((a, b) => a - b), [...Array(n).keys()].map((i) => i + 1));
    }
  }
  // Bots, driven only through the scheduler like the server does.
  for (const n of [2, 4, 6]) {
    const rng = seeded(n);
    const g = createThirtyOne({ id: 'b', maxPlayers: n, settings: { tokens: 2 } });
    for (let i = 0; i < n; i++) addThirtyOnePlayer(g, { id: `b${i}`, name: `B${i}`, tokenHash: '', bot: true }, rng);
    let guard = 0;
    while (g.status === 'playing') {
      assert.ok(guard++ < 20000, 'bot game stalled');
      const step = thirtyOneNextAutomatic(g, { rng });
      assert.ok(step && step.apply(g), `stuck in phase ${g.phase}`);
    }
  }
});

test('bot: takes a discard that clearly helps, knocks on a strong hand, discards its worst card', () => {
  const { g } = table(2);
  rig(g, [['AS', 'KS', '2D'], ['5C', '6D', '7H']], 'QS', 0);
  assert.deepEqual(thirtyOneBotDecision(g, 0, () => 0.5), { type: 'draw', from: 'discard' });
  thirtyOneAct(g, 0, { type: 'draw', from: 'discard' });
  assert.deepEqual(thirtyOneBotDecision(g, 0, () => 0.5), { type: 'discard', card: '2D' });
  rig(g, [['AS', 'KS', '9S'], ['5C', '6D', '7H']], '2C', 0);
  assert.deepEqual(thirtyOneBotDecision(g, 0, () => 0.5), { type: 'knock' }, '30 is worth knocking on');
});

test('the host can start early with 2 or more', () => {
  const rng = seeded(4);
  const g = createThirtyOne({ id: 'x', maxPlayers: 6 });
  addThirtyOnePlayer(g, { id: 'a', name: 'A', tokenHash: '1' }, rng);
  assert.throws(() => startThirtyOne(g, rng), /at least 2/);
  addThirtyOnePlayer(g, { id: 'b', name: 'B', tokenHash: '2' }, rng);
  startThirtyOne(g, rng);
  assert.equal(g.status, 'playing');
  assert.equal(g.numPlayers, 2);
  assert.equal(g.players.every((p) => p.tokens === 6), true, 'six tokens each by default');
});
