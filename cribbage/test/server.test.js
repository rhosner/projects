// Boots the real server on a random port with a temp DB and plays a full 4-player game over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

const musicDir = mkdtempSync(join(tmpdir(), 'crib-music-'));
const SONG = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
writeFileSync(join(musicDir, 'late-night_jazz.mp3'), SONG);
writeFileSync(join(musicDir, 'notes.txt'), 'not music');

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-'));
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 't.db'), PACE: '0.005', MUSIC_DIR: musicDir },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => proc?.kill());

async function call(path, { method = 'GET', body, token, key } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Player-Token': token } : {}),
      ...(key ? { 'X-Player-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

test('bots fill seats and play their own turns', async () => {
  const created = await call('/api/games', { method: 'POST', body: { name: 'Sol', numPlayers: 3 } });
  const { id, token } = created.data;
  assert.equal((await call(`/api/games/${id}/bots`, { method: 'POST' })).status, 403, 'needs a seat');
  const r = await call(`/api/games/${id}/bots`, { method: 'POST', token });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'playing');
  assert.deepEqual(r.data.players.map((p) => p.bot), [false, true, true]);

  const solo = await call('/api/games', { method: 'POST', body: { name: 'Kit', numPlayers: 4, teams: false } });
  const soloView = await call(`/api/games/${solo.data.id}/bots`, { method: 'POST', token: solo.data.token });
  assert.equal(soloView.data.teams, false);
  assert.equal(soloView.data.scores.length, 4, 'four separate scores');
  assert.deepEqual(soloView.data.players.map((p) => p.side), [0, 1, 2, 3]);
  // Bots discard by themselves; afterwards only the human is still holding 5 cards.
  let v;
  for (let i = 0; i < 50; i++) {
    await new Promise((res) => setTimeout(res, 50));
    v = (await call(`/api/games/${id}`, { token })).data;
    if (v.players[1].discarded && v.players[2].discarded) break;
  }
  assert.ok(v.players[1].discarded && v.players[2].discarded, 'bots discarded');
  assert.equal(v.hand.length, 5);
  assert.equal(v.yourTurn, true);
});

test('4-player game over HTTP, with auth checks and rematch', async () => {
  const created = await call('/api/games', { method: 'POST', body: { name: 'Ann', numPlayers: 4 } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const tokens = [created.data.token];
  for (const name of ['Ben', 'Cat', 'Dev']) {
    const j = await call(`/api/games/${id}/join`, { method: 'POST', body: { name } });
    assert.equal(j.status, 201, JSON.stringify(j.data));
    tokens.push(j.data.token);
  }
  const dup = await call(`/api/games/${id}/join`, { method: 'POST', body: { name: 'Eve' } });
  assert.equal(dup.status, 400, 'game is full / started');

  const spectator = await call(`/api/games/${id}`);
  assert.equal(spectator.data.you, null);
  assert.equal(spectator.data.hand.length, 0);
  assert.equal(spectator.data.scores.length, 2, 'two teams');

  const forged = await call(`/api/games/${id}/play`, { method: 'POST', body: { card: 'AS' }, token: 'nope' });
  assert.equal(forged.status, 403);

  // Push endpoints
  const key = await call('/api/push/key');
  assert.equal(Buffer.from(key.data.publicKey, 'base64url').length, 65);
  const sub = { endpoint: 'https://push.example.test/x', keys: { p256dh: 'BKey', auth: 'auth' } };
  assert.equal((await call(`/api/games/${id}/push`, { method: 'POST', body: { subscription: sub } })).status, 403, 'needs a seat');
  assert.equal((await call(`/api/games/${id}/push`, { method: 'POST', body: { subscription: sub }, token: tokens[1] })).status, 200);
  assert.equal((await call(`/api/games/${id}/push`, { method: 'POST', body: { subscription: { endpoint: 'nope' } }, token: tokens[1] })).status, 400);
  assert.equal((await call(`/api/games/${id}/push/remove`, { method: 'POST', body: { endpoint: sub.endpoint }, token: tokens[1] })).status, 200);

  let guard = 0;
  let v;
  let checkedOutOfTurn = false;
  while (guard++ < 4000) {
    const views = await Promise.all(tokens.map((token) => call(`/api/games/${id}`, { token })));
    v = views[0].data;
    if (v.status === 'finished') break;
    const mover = views.find((x) => x.data.yourTurn);
    // Between decisions the server pauses for automatic steps (forced plays, Go,
    // counting, dealing). Only act when the game is genuinely waiting on a player.
    const waiting = mover && (mover.data.phase === 'discard' || mover.data.legal.length >= 1);
    if (!waiting || views.some((x) => x.data.version !== v.version)) {
      await new Promise((r) => setTimeout(r, 5));
      continue;
    }
    const me = mover.data;
    const token = tokens[me.you];
    if (me.phase === 'discard') {
      const r = await call(`/api/games/${id}/discard`, { method: 'POST', body: { cards: me.hand.slice(0, 1) }, token });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    } else {
      if (!checkedOutOfTurn) {
        // Safe from races: the game can't move until `me` chooses a card.
        checkedOutOfTurn = true;
        const outOfTurn = views.find((x) => !x.data.yourTurn).data;
        const bad = await call(`/api/games/${id}/play`, {
          method: 'POST', body: { card: outOfTurn.hand[0] ?? 'AS' }, token: tokens[outOfTurn.you],
        });
        assert.equal(bad.status, 400, 'out-of-turn play rejected');
      }
      const r = await call(`/api/games/${id}/play`, { method: 'POST', body: { card: me.legal[0] }, token });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
  }
  assert.equal(v.status, 'finished');
  assert.equal(v.scores[v.winner], 121);
  assert.ok(checkedOutOfTurn, 'out-of-turn check ran');

  const re1 = await call(`/api/games/${id}/rematch`, { method: 'POST', token: tokens[2] });
  const re2 = await call(`/api/games/${id}/rematch`, { method: 'POST', token: tokens[1] });
  assert.equal(re1.data.id, re2.data.id, 'rematch is idempotent');
  const next = await call(`/api/games/${re1.data.id}`, { token: tokens[3] });
  assert.equal(next.data.status, 'playing');
  assert.equal(next.data.you, 3, 'same seat, same token');
});

test('leaderboard: a finished game is credited to the player who played it', async () => {
  // Created without a player key, like a game from before keys existed.
  const created = await call('/api/games', { method: 'POST', body: { name: 'Zed', numPlayers: 2 } });
  const { id, token } = created.data;
  await call(`/api/games/${id}/bots`, { method: 'POST', token });
  const key = 'zed-private-key';
  let v;
  for (let guard = 0; guard < 6000; guard++) {
    v = (await call(`/api/games/${id}`, { token, key })).data; // opening the game claims the seat
    if (v.status === 'finished') break;
    if (v.yourTurn && v.phase === 'discard') await call(`/api/games/${id}/discard`, { method: 'POST', body: { cards: v.hand.slice(0, 2) }, token });
    else if (v.yourTurn && v.legal.length >= 1) await call(`/api/games/${id}/play`, { method: 'POST', body: { card: v.legal[0] }, token });
    else await new Promise((r) => setTimeout(r, 3));
  }
  assert.equal(v.status, 'finished');
  const stats = (await call('/api/stats', { key })).data;
  const me = stats.players.find((p) => p.id === stats.you);
  assert.ok(me, 'my row exists');
  assert.equal(me.name, 'Zed');
  assert.equal(me.botWins + me.botLosses, 1, 'counted as a game against a bot');
  assert.ok(!JSON.stringify(stats).includes(key), 'the private key never appears');
  assert.equal((await call('/api/stats')).data.you, null);
});

test("Hold'em over HTTP: host starts early, plays through /act, finishes, separate leaderboard", async () => {
  const key = 'holdem-player-key';
  const created = await call('/api/games', {
    method: 'POST', key,
    body: { type: 'holdem', name: 'Hana', numPlayers: 6, settings: { startingStack: 300, bigBlind: 20, levelHands: 2 } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { id, token } = created.data;
  const join = await call(`/api/games/${id}/join`, { method: 'POST', body: { name: 'Guest' } });
  assert.equal((await call(`/api/games/${id}/start`, { method: 'POST', token: join.data.token })).status, 403, 'only the host starts');
  assert.equal((await call(`/api/games/${id}/bots`, { method: 'POST', token, body: { count: 1 } })).data.players.length, 3, 'add one bot');
  const started = await call(`/api/games/${id}/start`, { method: 'POST', token });
  assert.equal(started.data.status, 'playing');
  assert.equal(started.data.numPlayers, 3);
  assert.equal(started.data.type, 'holdem');

  // Both humans play: always call/check (the guest folds sometimes to keep things moving).
  const tokens = [token, join.data.token];
  let v;
  for (let guard = 0; guard < 8000; guard++) {
    const views = await Promise.all(tokens.map((t) => call(`/api/games/${id}`, { token: t, key: t === token ? key : undefined })));
    v = views[0].data;
    if (v.status === 'finished') break;
    const mover = views.find((x) => x.data.yourTurn);
    if (!mover) {
      await new Promise((r) => setTimeout(r, 3));
      continue;
    }
    const o = mover.data.options;
    const t = tokens[mover.data.you];
    const action = o.canCheck ? { type: 'check' } : mover.data.you === 1 && guard % 3 === 0 ? { type: 'fold' } : { type: 'call' };
    const r = await call(`/api/games/${id}/act`, { method: 'POST', token: t, body: { action } });
    assert.ok([200, 400].includes(r.status), JSON.stringify(r.data)); // 400 only if the turn moved on in between
    const total = v.players.reduce((a, p) => a + p.stack, 0) + v.pot;
    assert.equal(total, 900, 'chips conserved as seen by players');
  }
  assert.equal(v.status, 'finished', 'tournament finished');
  const winner = v.players[v.winner];
  assert.equal(winner.stack, 900);

  const stats = (await call('/api/stats?game=holdem', { key })).data;
  assert.equal(stats.game, 'holdem');
  const me = stats.players.find((p) => p.id === stats.you);
  assert.ok(me, 'host has a Hold’em record');
  assert.equal(me.wins + me.losses, 1, 'the game counts against people (a human guest was at the table)');
  const cribbageStats = (await call('/api/stats', { key })).data;
  assert.ok(!cribbageStats.players.some((p) => p.id === stats.you), 'not mixed into the cribbage leaderboard');
  assert.equal((await call('/api/stats?game=nope')).status, 400);
});

test('Thirty-One over HTTP: draw, discard, knock; game finishes; own leaderboard', async () => {
  const key = 't1-player-key';
  const created = await call('/api/games', { method: 'POST', key, body: { type: 'thirtyone', name: 'Tess', numPlayers: 4, settings: { tokens: 1 } } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { id, token } = created.data;
  await call(`/api/games/${id}/bots`, { method: 'POST', token, body: { count: 2 } });
  const v0 = (await call(`/api/games/${id}/start`, { method: 'POST', token })).data;
  assert.equal(v0.type, 'thirtyone');
  assert.equal(v0.numPlayers, 3);
  let v;
  let knocked = false;
  for (let guard = 0; guard < 6000; guard++) {
    v = (await call(`/api/games/${id}`, { token, key })).data;
    if (v.status === 'finished') break;
    if (!v.yourTurn) {
      await new Promise((r) => setTimeout(r, 3));
      continue;
    }
    let action;
    if (v.phase === 'turn') action = v.canKnock && !knocked && v.handValue.value >= 20 ? { type: 'knock' } : { type: 'draw', from: 'stock' };
    else action = { type: 'discard', card: v.hand.find((c) => !(v.drew?.from === 'discard' && c === v.drew.card)) };
    if (action.type === 'knock') knocked = true;
    const r = await call(`/api/games/${id}/act`, { method: 'POST', token, body: { action } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.hand.length <= 4);
  }
  assert.equal(v.status, 'finished');
  const stats = (await call('/api/stats?game=thirtyone', { key })).data;
  const me = stats.players.find((p) => p.id === stats.you);
  assert.ok(me, 'has a Thirty-One record');
  assert.equal(me.botWins + me.botLosses, 1, 'a game against bots');
});

test('background music: lists audio files and streams them with byte ranges (needed by iPhone Safari)', async () => {
  const list = await call('/api/music');
  assert.deepEqual(list.data.tracks, [{ url: '/music/late-night_jazz.mp3', title: 'Late night jazz' }], 'only audio files, nicely named');
  const full = await fetch(`${BASE}/music/late-night_jazz.mp3`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await full.arrayBuffer()).length, 1000);
  const part = await fetch(`${BASE}/music/late-night_jazz.mp3`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), SONG.subarray(100, 200));
  const tail = await fetch(`${BASE}/music/late-night_jazz.mp3`, { headers: { Range: 'bytes=-10' } });
  assert.equal(tail.headers.get('content-range'), 'bytes 990-999/1000');
  const bad = await fetch(`${BASE}/music/late-night_jazz.mp3`, { headers: { Range: 'bytes=5000-' } });
  assert.equal(bad.status, 416);
  assert.equal((await fetch(`${BASE}/music/..%2F..%2Fpackage.json`)).status, 404, 'no escaping the music folder');
});
