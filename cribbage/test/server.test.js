// Boots the real server on a random port with a temp DB and plays a full 4-player game over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-'));
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 't.db'), PACE: '0.005' },
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

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Player-Token': token } : {}) },
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
    const waiting = mover && (mover.data.phase === 'discard' || mover.data.legal.length > 1);
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
