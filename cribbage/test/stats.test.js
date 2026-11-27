import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../src/stats.js';

// Minimal finished-game states: only what computeStats reads.
const game = (players, scores, winner, extra = {}) => ({
  status: 'finished', numPlayers: players.length, winner, scores, finishedAt: extra.at ?? 1,
  teams: extra.teams ?? players.length === 4,
  players: players.map((p) => (typeof p === 'string' ? { name: p, playerId: p.toLowerCase() } : p)),
});
const bot = (name) => ({ name, bot: true });
const find = (stats, id) => stats.find((p) => p.id === id);

test('head-to-head: wins, losses and per-opponent records', () => {
  const s = computeStats([
    game(['Ann', 'Ben'], [121, 100], 0),
    game(['Ann', 'Ben'], [110, 121], 1),
    game(['Ann', 'Ben'], [121, 80], 0, { at: 5 }), // skunk
  ]);
  const ann = find(s, 'ann');
  assert.deepEqual([ann.wins, ann.losses, ann.skunks], [2, 1, 1]);
  assert.deepEqual(ann.opponents.map((o) => [o.name, o.wins, o.losses]), [['Ben', 2, 1]]);
  assert.equal(s[0].id, 'ann', 'most wins first');
  assert.ok(Math.abs(ann.winRate - 2 / 3) < 1e-9);
});

test('free-for-all: winner beats everyone, losers record nothing against each other', () => {
  const s = computeStats([game(['Ann', 'Ben', 'Cat'], [121, 95, 40], 0, { teams: false })]);
  assert.deepEqual(find(s, 'ann').opponents.map((o) => [o.name, o.wins]), [['Ben', 1], ['Cat', 1]]);
  const ben = find(s, 'ben');
  assert.deepEqual([ben.wins, ben.losses], [0, 1]);
  assert.deepEqual(ben.opponents.map((o) => [o.name, o.wins, o.losses]).sort(), [['Ann', 0, 1], ['Cat', 0, 0]]);
  assert.equal(find(s, 'ann').skunks, 1, 'Cat (40) was skunked; Ben (95) was not');
});

test('teams: both partners win, a skunked team counts once', () => {
  const s = computeStats([game(['Ann', 'Ben', 'Cat', 'Dev'], [121, 70], 0)]); // Ann+Cat beat Ben+Dev
  for (const id of ['ann', 'cat']) assert.deepEqual([find(s, id).wins, find(s, id).skunks], [1, 1]);
  for (const id of ['ben', 'dev']) assert.equal(find(s, id).losses, 1);
  assert.deepEqual(find(s, 'ann').opponents.map((o) => o.name).sort(), ['Ben', 'Dev'], 'partners are not opponents');
});

test('bot games count separately; bots and unclaimed seats get no row', () => {
  const s = computeStats([
    game(['Ann', bot('Botley')], [121, 60], 0),
    game([{ name: 'Old' }, 'Ann'], [121, 100], 0), // a seat from before player keys existed
  ]);
  const ann = find(s, 'ann');
  assert.deepEqual([ann.wins, ann.losses, ann.botWins, ann.botLosses], [0, 1, 1, 0]);
  assert.deepEqual(s.map((p) => p.id), ['ann']);
  assert.ok(ann.opponents.some((o) => o.bot && o.name === 'Botley'));
});

test('shows the most recent name a player used', () => {
  const s = computeStats([
    game([{ name: 'Robert', playerId: 'r' }, 'Ben'], [121, 1], 0, { at: 1 }),
    game([{ name: 'Rob', playerId: 'r' }, 'Ben'], [121, 1], 0, { at: 9 }),
  ]);
  assert.equal(find(s, 'r').name, 'Rob');
  assert.equal(find(s, 'r').wins, 2);
});
