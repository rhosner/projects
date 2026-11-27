// Web Push: VAPID keys, subscription storage, and "it's your turn" notifications.
import webpush from 'web-push';
import { isTurn, sideOf } from './engine.js';
import { holdemIsTurn, options as holdemOptions } from './holdem.js';
import { thirtyOneIsTurn } from './thirtyone.js';

/**
 * Decide who should hear about a state change.
 * before/after are game states; actorSeat is whoever made the request (they're
 * looking at the screen, so they never get pinged).
 */
export function turnNotifications(before, after, actorSeat) {
  if (after.type === 'holdem') return holdemNotifications(before, after, actorSeat);
  if (after.type === 'thirtyone') return thirtyOneNotifications(before, after, actorSeat);
  const out = [];
  const names = after.players.map((p) => p.name);
  const others = (seat) => names.filter((_, i) => i !== seat).join(', ');

  if (after.status === 'finished' && before.status !== 'finished') {
    const winners = after.players.filter((_, i) => sideOf(after, i) === after.winner);
    for (let seat = 0; seat < after.players.length; seat++) {
      if (seat === actorSeat) continue;
      const won = winners.some((p) => p === after.players[seat]);
      out.push({
        seat,
        title: won ? 'You won at cribbage! 🏆' : 'Cribbage game over',
        body: `${winners.map((p) => p.name).join(' & ')} reached 121.`,
      });
    }
    return out;
  }

  for (let seat = 0; seat < after.players.length; seat++) {
    if (seat === actorSeat) continue;
    const was = before.status === 'playing' && isTurn(before, seat);
    const now = isTurn(after, seat);
    if (!now || was) continue;
    let body;
    if (after.phase === 'discard') {
      body = after.handNo === 1
        ? `Everyone's here. Game on vs ${others(seat)}. Pick your crib cards.`
        : `Hand ${after.handNo} is dealt. Pick your crib cards.`;
    } else {
      const last = after.pegging.history.at(-1);
      const lead = after.pegging.count === 0 ? 'Your lead.' : `Count is ${after.pegging.count}.`;
      body = last && after.pegging.count !== 0 ? `${names[last.seat]} played. ${lead}` : lead;
    }
    out.push({ seat, title: 'Your turn in cribbage', body });
  }
  return out;
}

const cardName = (c) => `${c[0] === 'T' ? '10' : c[0]}${{ S: '♠', H: '♥', D: '♦', C: '♣' }[c[1]]}`;

function thirtyOneNotifications(before, after, actorSeat) {
  const out = [];
  if (after.status === 'finished' && before.status !== 'finished') {
    const w = after.players[after.winner];
    after.players.forEach((p, seat) => {
      if (seat === actorSeat || p.bot) return;
      out.push({ seat, title: seat === after.winner ? 'You won at Thirty-One! 🏆' : 'Thirty-One game over', body: `${w.name} is the last one standing.` });
    });
    return out;
  }
  after.players.forEach((p, seat) => {
    if (seat === actorSeat || p.bot) return;
    const was = before.status === 'playing' && thirtyOneIsTurn(before, seat);
    if (!thirtyOneIsTurn(after, seat) || was) return;
    const top = after.discard.at(-1);
    const body = after.knocker !== null
      ? `${after.players[after.knocker].name} knocked. This is your last turn.`
      : `Top of the discard pile: ${top ? cardName(top) : 'empty'}.`;
    out.push({ seat, title: 'Your turn in Thirty-One', body });
  });
  return out;
}

function holdemNotifications(before, after, actorSeat) {
  const out = [];
  if (after.status === 'finished' && before.status !== 'finished') {
    const w = after.players[after.winner];
    after.players.forEach((p, seat) => {
      if (seat === actorSeat || p.bot) return;
      out.push({
        seat,
        title: seat === after.winner ? 'You won the Hold’em tournament! 🏆' : 'Hold’em tournament over',
        body: `${w.name} took every chip.`,
      });
    });
    return out;
  }
  if (before.status === 'lobby' && after.status === 'playing') {
    after.players.forEach((p, seat) => {
      if (seat !== actorSeat && !p.bot && !holdemIsTurn(after, seat)) {
        out.push({ seat, title: 'Hold’em is starting', body: `${after.players.length} players, blinds ${after.sb}/${after.bb}.` });
      }
    });
  }
  after.players.forEach((p, seat) => {
    if (seat === actorSeat || p.bot) return;
    const was = before.status === 'playing' && holdemIsTurn(before, seat);
    if (!holdemIsTurn(after, seat) || was) return;
    const o = holdemOptions(after, seat);
    const secs = after.settings.actionSeconds;
    out.push({
      seat,
      title: 'Your turn in Hold’em',
      body: `${o.canCheck ? 'Check or bet.' : `${o.toCall.toLocaleString('en-US')} to call.`} You have ${secs} seconds.`,
    });
  });
  return out;
}

export function createPusher({ db, subject, send = webpush.sendNotification.bind(webpush), log = console }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT NOT NULL,
      game_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (endpoint, game_id)
    );
    CREATE INDEX IF NOT EXISTS push_by_game ON push_subscriptions (game_id, seat);
  `);

  // VAPID keys: env vars win; otherwise generate once and keep them in the DB.
  // Changing keys invalidates every existing subscription, so they must be stable.
  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'vapid'").get();
    if (row) ({ publicKey, privateKey } = JSON.parse(row.value));
    else {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      db.prepare("INSERT INTO meta (key, value) VALUES ('vapid', ?)").run(JSON.stringify({ publicKey, privateKey }));
    }
  }
  const vapidDetails = { subject, publicKey, privateKey };

  const upsert = db.prepare(`INSERT INTO push_subscriptions (endpoint, game_id, seat, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint, game_id) DO UPDATE SET seat = excluded.seat, p256dh = excluded.p256dh, auth = excluded.auth`);
  const remove = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND game_id = ?');
  const removeEndpoint = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const forSeat = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE game_id = ? AND seat = ?');
  const countFor = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE game_id = ? AND seat = ?');

  return {
    publicKey,

    subscribe(gameId, seat, sub) {
      const endpoint = String(sub?.endpoint ?? '');
      const { p256dh, auth } = sub?.keys ?? {};
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) throw new Error('Invalid push endpoint');
      if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
        throw new Error('Invalid push keys');
      }
      // Cap per seat so one game can't accumulate unbounded rows.
      if (countFor.get(gameId, seat).n >= 10) throw new Error('Too many devices for this seat');
      upsert.run(endpoint, gameId, seat, p256dh, auth, Date.now());
    },

    unsubscribe(gameId, endpoint) {
      remove.run(String(endpoint), gameId);
    },

    /** Fire-and-forget; failures never affect the game request. */
    async notify(game, notes) {
      const jobs = [];
      for (const note of notes) {
        const payload = JSON.stringify({
          title: note.title,
          body: note.body,
          url: `/g/${game.id}`,
          tag: `crib-${game.id}`,
        });
        for (const row of forSeat.all(game.id, note.seat)) {
          const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
          jobs.push(
            send(sub, payload, { vapidDetails, TTL: 60 * 60 * 24 * 3, urgency: 'normal', topic: game.id }).catch((err) => {
              if (err?.statusCode === 404 || err?.statusCode === 410) removeEndpoint.run(row.endpoint);
              else log.warn?.(`push failed (${err?.statusCode ?? err?.message})`);
            })
          );
        }
      }
      await Promise.all(jobs);
    },
  };
}
