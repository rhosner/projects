# Card Night

Card games for friends: **cribbage** and **Thirty-One** you can play on your own time, and **Texas Hold'em** for playing live. Pick the game when you create one; invites, notifications, sound and the leaderboard work the same for all three.

## Thirty-One

2–8 players, Bicycle rules. Get your hand as close to 31 as you can in a single suit (Ace 11, faces 10).

- **Turn:** knock (in place of your turn), or draw from the deck or the discard pile and then discard. Tap the deck or the discard to draw; while holding four cards, hovering a card shows what your hand is worth if you discard it.
- **Knock:** everyone else gets one more turn, then the lowest hand loses a token; a knocker with the lowest hand loses 2.
- **31** at any time, including the deal, wins the round at once; everyone else loses a token.
- **Tokens:** 6 each by default (3 or 9 when creating a game). At 0 you're on your honor; lose again and you're out. Last player in wins.
- **Cases the rules leave open, as implemented:** ties for lowest all lose (a tied knocker loses 2); each token lost counts as a loss (a knocker with 1 token losing 2 goes straight out); you can't throw back the card you just took from the discard pile; an empty deck is rebuilt from the discard pile; the deal passes left each round; if everyone left would go out in the same round, nobody does and play continues.
- **Bot** takes the discard when it clearly helps, keeps its best three, and knocks at 27+ (25+ once a round drags on).

**Your hand's value** shows next to your name in every game (only your own): cribbage points as you pick crib cards ("Keeping these: 8 pts before the cut") and then with the starter; Hold'em's current hand ("Pocket Kings", "Two pair, Jacks and Fours"); Thirty-One's hand value, and "Best keep" while holding four cards.

## Texas Hold'em

No-limit tournament for 2–9 players. Everyone starts with the same stack; blinds double every few hands; the last player with chips wins.

- **Defaults** (all adjustable when creating a game): 1,500 chips, blinds 10/20, blinds double every 10 hands, 60 seconds to act (30/60/120). Blinds go up by hand count, not clock time.
- **Lobby:** the host can **Start now** once 2+ players are seated (the game also starts when every seat fills). Add bots one at a time or fill every seat.
- **Timer:** when time runs out you check if you can, otherwise fold. Two timeouts in a row marks you away (auto-acts after a few seconds) until you act again.
- **Rules:** heads-up blinds (button posts the small blind, acts first preflop), minimum raise = last full raise, all-ins smaller than a full raise don't reopen betting, side pots split by all-in level, odd chips to the first winner left of the button.
- **Bots** rate preflop hands with the Chen formula and estimate post-flop equity by simulation against the price of calling. Fine for filling seats; not strong.
- **Leaderboard:** separate tab. Winning a tournament beats everyone at the table.

## Cribbage


Turn-based cribbage for 2–4 friends. Every game is saved on the server, so anyone can open their link at any time, make their play if it's their turn, and leave.

- **2 players**: 6 cards each, 2 to the crib
- **3 players**: 5 cards each, 1 to the crib, plus 1 from the deck
- **4 players**: everyone for themselves, 5 cards each, 1 to the crib
- **2 v 2**: two teams of two (seats 1 & 3 vs 2 & 4), 5 cards each, 1 to the crib

Scoring is automatic: fifteens, pairs, runs, flushes (crib flushes need all 5 cards), nobs, his heels, go, last card and 31. During pegging, every score is announced on the table ("Ada · 31 for 2", "Go for 1"), a 31 or a pile that earned a go stays on the table for a moment before it's cleared, and a player who can't play shows a big **GO**. Hover (or tap) a card on your turn to see the count it would make.

**Sound:** card snaps, a shuffle on the deal, a knock for Go, chimes for points, and a ping when it's your turn, all synthesized in the browser. **Background music** (off by default) is chosen in the 🔊 menu: any song in `public/music/` (currently "Forsaken" by Under Earth and "Press X Twice" by Lexica) or the built-in soft chords. Drop another `.mp3` into `public/music/` and it appears in the menu, named after the file; each person's choice is remembered on their device. Songs are streamed with byte-range support, which iPhone Safari requires.

After each hand the results screen counts every hand out one scoring line at a time, lighting up the cards behind each line ("Fifteen · 2, Fifteen · 4, Pair · 6"); Skip finishes it instantly. Afterwards, hover or tap any line, there or in the "Last hand" tab, to see its cards again.

**Leaderboard** (🏆 on the home page): wins and losses against people, win %, record against bots, skunks given, and each player's record against every opponent. Team wins count for both partners; in 3- and 4-player games the winner beats everyone at the table. There are no accounts: each browser gets a private player key, and "Move your games to another device" carries it to your phone so you keep one record. Anyone who can open the site can see the leaderboard.

**Suits** are drawn as shapes (not font characters) so clubs and spades read apart even when small, and a four-colour deck (clubs green, diamonds blue) is on by default; switch it off in the 🔊 menu.

First to 121 wins. The board marks the skunk line (between 90 and 91) and the double-skunk line (between 60 and 61), and skunks are called out at the end.

## Bots

Short a player? Tap **Play bots right now** on the home page, or **Fill empty seats with bots** in a lobby. Bots play their own turns on the server after a short, slightly varied pause. The bot picks its discard by averaging every possible starter card and pegs to take points and avoid giving them away. It beats random play almost every time, but it doesn't count cards or model opponents, so a decent player should beat it often.

### Demo with no server

`npm run demo` builds `demo/dist/`: the same app running entirely in the browser against bots (games saved in localStorage). Serve that folder from any static host, such as GitHub Pages, to try the game without deploying the server. There's no multiplayer or push in the demo.

## How playing works

1. Create a game and copy the invite link into your group chat.
2. Friends open the link and enter a name. No accounts. The game starts once every seat is taken.
3. Each browser remembers its seat. To use the same seat on your phone, use **Other device** to copy a personal link (it signs in as you, so don't share it).
4. "Go" is said for you when you can't play, but **cards are never played automatically**, even when only one is legal: how fast a card appeared would tell the table what you're holding. Bots take a varied amount of time on every play for the same reason. Each automatic step (Go, the go and last-card points, counting the hands, the next deal) happens on its own beat with a short pause, so you can follow what happened. When a game ends, everyone's hands and the crib are revealed, with what any uncounted hand would have scored. Set `PACE` to scale every pause (`PACE=0.5` is twice as fast).
5. If more than one person has the game open, they see each other's moves instantly (Server-Sent Events).
6. **Push notifications.** Tap **Turn on** (or the 🔔) in a game and you'll get a notification when it's your turn, when a new hand is dealt, and when the game ends, even with the app closed. You never get one for your own moves. Turning it on for one game means the device is subscribed to your other games too; you can turn it off per game.

### Notifications on iPhone

Apple only delivers web push to sites **added to the Home Screen** (iOS/iPadOS 16.4 or later). The app shows these steps when you tap the bell in Safari:

1. **Copy my games link** (a Home Screen app has its own storage, separate from Safari, so it starts with no seats).
2. Share → **Add to Home Screen**.
3. Open Cribbage from the Home Screen, paste the link under **Move your games to another device**, open the game, and tap 🔔.

Android, desktop Chrome, Edge and Firefox work straight from the browser.

## Run locally

Needs Node **22.5+** (it uses the built-in `node:sqlite`). The only dependency is `web-push`.

```bash
cd cribbage
npm install
npm start            # http://localhost:3000
npm test             # rules engine, push encryption, and a full 4-player game over HTTP
```

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DB_PATH` | `./data/cribbage.db` | Games, push subscriptions and VAPID keys all live here. |
| `VAPID_SUBJECT` | placeholder | **Set this** to `mailto:you@yourdomain`. Push services use it to contact you, and Apple may reject pushes without a real one. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto-generated | Optional. If unset, a key pair is generated on first boot and stored in the DB. Changing keys breaks every existing subscription (people just tap the bell again). |

Push needs HTTPS, except on `localhost`, where it works too: your server sends each notification to the browser vendor's push service, which delivers it to the browser.

## Deploy

You need **a host with a persistent disk**. Games live in a SQLite file, so a host that wipes the filesystem on every restart or deploy will wipe your games too. Render's free tier, Vercel and Netlify all fall into that category.

**Automatic deploys:** `.github/workflows/deploy-cribbage.yml` runs the tests and, if they pass, deploys to Fly whenever a change under `cribbage/` is merged to `master` (or when run by hand from the Actions tab). It needs a repository secret named `FLY_API_TOKEN`, created with `fly tokens create deploy -a cribbage-with-friends`.

**Fly.io, first-time setup** (config included):

```bash
cd cribbage
fly launch --no-deploy        # pick a name/region; keep the existing fly.toml
fly volumes create crib_data --size 1
# edit VAPID_SUBJECT in fly.toml to your own mailto: address
fly deploy
```

**Anything that runs Docker** (a VPS, Railway with a volume, home server): build the `Dockerfile` and mount a volume at `/data`.

Back up by copying `cribbage.db`. Each game is one JSON row in the `games` table.

## Layout

```
src/engine.js   rules, scoring, turn order, per-player views (pure, tested)
src/server.js   HTTP API, SSE live updates, static files (no framework)
src/store.js    SQLite persistence
src/bot.js      bot discard and pegging choices (shared with the demo)
src/push.js     Web Push: VAPID keys, subscriptions, who gets notified
public/sw.js    service worker that shows notifications
demo/           in-browser backend + build script for the serverless demo
public/         vanilla JS frontend, no build step
test/           node:test suites
```

## Known limits

- Real push delivery has been tested only up to the request sent to the push service (encryption and VAPID signatures are checked in `test/push.test.js`). Try it on your own phone after deploying.
- iPhone users have to do the Home Screen steps above. There's no way around that for web apps.
- Identity is a random per-seat token in the browser. If someone clears their browser data and has no personal link saved, they lose their seat.
- Anyone with the game link can watch (cards stay hidden) and can take an open seat before the game fills.
