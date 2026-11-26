import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createECDH, randomBytes, createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import webpush from 'web-push';
import { createPusher, turnNotifications } from '../src/push.js';
import { createGame, addPlayer, discard, play, legalPlays } from '../src/engine.js';

const require = createRequire(import.meta.url);
const ece = require('http_ece'); // the decryption a browser does, from an independent implementation

function seeded(seed) {
  let s = seed >>> 0;
  return (max) => ((s = (s * 1664525 + 1013904223) >>> 0), s % max);
}

/** A fake browser: its own P-256 key pair and auth secret, like PushManager.subscribe() makes. */
function fakeDevice(n) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: `https://push.example.test/send/device-${n}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
  };
}

function setup({ fail = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  const sent = [];
  const send = async (sub, payload, options) => {
    // Build the exact HTTP request web-push would send, then assert on it.
    const req = webpush.generateRequestDetails(sub, payload, options);
    sent.push({ sub, req, options });
    const code = fail[sub.endpoint];
    if (code) throw Object.assign(new Error('push service said no'), { statusCode: code });
    return { statusCode: 201 };
  };
  const pusher = createPusher({ db, subject: 'mailto:test@example.com', send, log: { warn() {} } });
  return { db, pusher, sent };
}

test('VAPID keys are generated once and reused', () => {
  const db = new DatabaseSync(':memory:');
  const a = createPusher({ db, subject: 'mailto:x@example.com' });
  const b = createPusher({ db, subject: 'mailto:x@example.com' });
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(Buffer.from(a.publicKey, 'base64url').length, 65, 'uncompressed P-256 point');
});

test('payload decrypts on the device and VAPID JWT verifies', async () => {
  const { pusher, sent } = setup();
  const dev = fakeDevice(1);
  const game = { id: 'abc123' };
  pusher.subscribe('abc123', 1, dev.subscription);
  await pusher.notify(game, [{ seat: 1, title: 'Your turn in cribbage', body: 'Count is 21.' }]);

  assert.equal(sent.length, 1);
  const { req } = sent[0];
  assert.equal(req.endpoint, dev.subscription.endpoint);
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(req.headers.Topic, 'abc123', 'newer notifications for a game replace older ones');
  assert.ok(Number(req.headers.TTL) > 0);

  const plain = ece.decrypt(req.body, { version: 'aes128gcm', privateKey: dev.ecdh, authSecret: dev.auth });
  assert.deepEqual(JSON.parse(plain.toString()), {
    title: 'Your turn in cribbage',
    body: 'Count is 21.',
    url: '/g/abc123',
    tag: 'crib-abc123',
  });

  // Authorization: vapid t=<jwt>, k=<public key>
  const m = req.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, req.headers.Authorization);
  assert.equal(m[2], pusher.publicKey);
  const [h, p, sig] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.aud, 'https://push.example.test');
  assert.equal(claims.sub, 'mailto:test@example.com');
  const pub = Buffer.from(pusher.publicKey, 'base64url');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('only the targeted seat is notified; dead endpoints are removed', async () => {
  const gone = fakeDevice(2);
  const { db, pusher, sent } = setup({ fail: { [gone.subscription.endpoint]: 410 } });
  const a = fakeDevice(1);
  pusher.subscribe('g1', 0, a.subscription);
  pusher.subscribe('g1', 1, gone.subscription);
  pusher.subscribe('g2', 1, gone.subscription); // same phone, another game

  await pusher.notify({ id: 'g1' }, [{ seat: 1, title: 't', body: 'b' }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sub.endpoint, gone.subscription.endpoint);
  const left = db.prepare('SELECT game_id, seat FROM push_subscriptions ORDER BY game_id').all();
  assert.deepEqual(left.map((r) => [r.game_id, r.seat]), [['g1', 0]], '410 removes that endpoint everywhere');

  pusher.unsubscribe('g1', a.subscription.endpoint);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('rejects junk subscriptions', () => {
  const { pusher } = setup();
  assert.throws(() => pusher.subscribe('g', 0, { endpoint: 'http://insecure', keys: { p256dh: 'x', auth: 'y' } }));
  assert.throws(() => pusher.subscribe('g', 0, { endpoint: 'https://ok.test/x', keys: {} }));
  assert.throws(() => pusher.subscribe('g', 0, null));
});

test('turnNotifications: who gets pinged, and when', () => {
  const rng = seeded(11);
  const g = createGame({ id: 'g', numPlayers: 2 });
  addPlayer(g, { id: 'a', name: 'Ann', tokenHash: 'x' }, rng);
  let before = structuredClone(g);
  addPlayer(g, { id: 'b', name: 'Ben', tokenHash: 'y' }, rng);

  // Game starts when Ben joins: Ann is pinged, Ben (the actor) is not.
  let notes = turnNotifications(before, g, 1);
  assert.deepEqual(notes.map((n) => n.seat), [0]);
  assert.match(notes[0].body, /Game on vs Ben/);

  // Ann discards first: nobody newly on the clock (Ben already was).
  before = structuredClone(g);
  discard(g, 0, g.hands[0].slice(0, 2), rng);
  assert.deepEqual(turnNotifications(before, g, 0), []);

  // Ben discards: pegging starts; whoever leads (if not Ben) gets pinged.
  before = structuredClone(g);
  discard(g, 1, g.hands[1].slice(0, 2), rng);
  notes = turnNotifications(before, g, 1);
  if (g.phase === 'pegging' && g.pegging.turn === 0) assert.deepEqual(notes.map((n) => n.seat), [0]);
  else assert.deepEqual(notes, []);

  // Play the game out; every note must target someone who is now on the clock, never the actor.
  let guard = 0;
  while (g.status === 'playing' && guard++ < 2000) {
    const seat = g.phase === 'discard' ? g.discarded.indexOf(false) : g.pegging.turn;
    before = structuredClone(g);
    if (g.phase === 'discard') discard(g, seat, g.hands[seat].slice(0, 2), rng);
    else play(g, seat, legalPlays(g, seat)[0], rng);
    for (const n of turnNotifications(before, g, seat)) {
      assert.notEqual(n.seat, seat, 'actor is never notified');
      if (g.status === 'playing') assert.ok(g.phase === 'discard' ? !g.discarded[n.seat] : g.pegging.turn === n.seat);
    }
    if (g.status === 'finished') {
      const last = turnNotifications(before, g, seat);
      assert.equal(last.length, 1, 'the other player hears the game ended');
      assert.match(last[0].title, /won|over/);
    }
  }
  assert.equal(g.status, 'finished');
});
