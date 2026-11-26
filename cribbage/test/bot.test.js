import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addPlayer, discard, play, legalPlays, discardCount, settle } from '../src/engine.js';
import { botMove, chooseDiscard, nextAutomatic } from '../src/bot.js';

function seeded(seed) {
  let s = seed >>> 0;
  return (max) => ((s = (s * 1664525 + 1013904223) >>> 0), s % max);
}

// Seat 0 is the bot; seat 1 plays randomly (or is also a bot).
function match(seed, { bothBots = false, n = 2, teams = true } = {}) {
  const rng = seeded(seed);
  const g = createGame({ id: 'g', numPlayers: n, teams });
  for (let i = 0; i < n; i++) addPlayer(g, { id: `p${i}`, name: `P${i}`, tokenHash: 'x', bot: i % 2 === 0 || bothBots }, rng);
  let guard = 0;
  while (g.status === 'playing' && guard++ < 3000) {
    settle(g, rng);
    if (g.status !== 'playing') break;
    const m = botMove(g);
    if (m) {
      if (m.type === 'discard') discard(g, m.seat, m.cards, rng);
      else play(g, m.seat, m.card, rng);
      continue;
    }
    if (g.phase === 'discard') {
      const s = g.discarded.findIndex((d, i) => !d && !g.players[i].bot);
      const hand = g.hands[s];
      const pick = [...hand].sort(() => rng(3) - 1).slice(0, discardCount(n));
      discard(g, s, pick, rng);
    } else {
      const s = g.pegging.turn;
      const legal = legalPlays(g, s);
      play(g, s, legal[rng(legal.length)], rng);
    }
  }
  assert.equal(g.status, 'finished');
  return g;
}

test('bot keeps the obvious best hand', () => {
  const g = createGame({ id: 'g', numPlayers: 2 });
  g.hands = [['5H', '5S', 'JD', 'TC', '2C', '9D'], []];
  g.dealer = 1;
  // Keeping 5-5-J-10 is worth far more than anything with 2 or 9.
  assert.deepEqual(chooseDiscard(g, 0).sort(), ['2C', '9D']);
});

test('bot finishes games in every format and beats a random player', () => {
  let wins = 0;
  const N = 60;
  for (let seed = 1; seed <= N; seed++) if (match(seed * 31).winner === 0) wins++;
  // A random opponent should lose clearly; this guards against the bot being broken, not tuned.
  assert.ok(wins >= N * 0.75, `bot won ${wins}/${N}`);
  for (let seed = 1; seed <= 10; seed++) {
    match(seed, { bothBots: true });
    match(seed, { n: 3 });
    match(seed, { n: 4 });
    match(seed, { n: 4, teams: false });
  }
});

// Regression: the server only ever applies one nextAutomatic() step at a time and
// never calls settle(). A player passed over after saying "Go" once left the bot
// looking at a turn it couldn't play (crash). Drive all-bot games that way.
test('all-bot games run to the end through nextAutomatic alone', () => {
  for (const [n, teams] of [[2, false], [3, false], [4, true], [4, false]]) {
    for (let seed = 1; seed <= 15; seed++) {
      const rng = seeded(seed * 977 + n);
      const g = createGame({ id: 'g', numPlayers: n, teams });
      for (let i = 0; i < n; i++) addPlayer(g, { id: `b${i}`, name: `B${i}`, tokenHash: '', bot: true }, rng);
      let guard = 0;
      while (g.status === 'playing') {
        assert.ok(guard++ < 5000, 'game stalled');
        const step = nextAutomatic(g, { rng });
        assert.ok(step, `nothing to do in phase ${g.phase}`);
        assert.ok(step.apply(g), `${step.kind} did nothing`);
      }
    }
  }
});
