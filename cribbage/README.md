# Cribbage

Turn-based cribbage for 2–4 friends. Every game is saved on the server, so anyone can open their link at any time, make their play if it's their turn, and leave.

- **2 players**: 6 cards each, 2 to the crib
- **3 players**: 5 cards each, 1 to the crib, plus 1 from the deck
- **4 players**: two teams of two (seats 1 & 3 vs 2 & 4), 5 cards each, 1 to the crib

Scoring is automatic: fifteens, pairs, runs, flushes (crib flushes need all 5 cards), nobs, his heels, go, last card and 31. First to 121 wins, and skunks are shown.

## How playing works

1. Create a game and copy the invite link into your group chat.
2. Friends open the link and enter a name. No accounts. The game starts once every seat is taken.
3. Each browser remembers its seat. To use the same seat on your phone, use **Other device** to copy a personal link (it signs in as you, so don't share it).
4. To keep async games moving, the app makes forced moves automatically: a "Go" when you can't play, and your card when only one is legal. You only get asked when there's a real choice.
5. If more than one person has the game open, they see each other's moves instantly (Server-Sent Events). The bell button turns on a browser alert for your turn while the tab is open.

## Run locally

Needs Node **22.5+** (it uses the built-in `node:sqlite`, so there's nothing to `npm install`).

```bash
cd cribbage
npm start            # http://localhost:3000
npm test             # rules engine + a full 4-player game over HTTP
```

`DB_PATH` (default `./data/cribbage.db`) and `PORT` (default `3000`) are configurable.

## Deploy

You need **a host with a persistent disk**. Games live in a SQLite file, so a host that wipes the filesystem on every restart or deploy will wipe your games too. Render's free tier, Vercel and Netlify all fall into that category.

**Fly.io** (config included):

```bash
cd cribbage
fly launch --no-deploy        # pick a name/region; keep the existing fly.toml
fly volumes create crib_data --size 1
fly deploy
```

**Anything that runs Docker** (a VPS, Railway with a volume, home server): build the `Dockerfile` and mount a volume at `/data`.

Back up by copying `cribbage.db`. Each game is one JSON row in the `games` table.

## Layout

```
src/engine.js   rules, scoring, turn order, per-player views (pure, tested)
src/server.js   HTTP API, SSE live updates, static files (no framework)
src/store.js    SQLite persistence
public/         vanilla JS frontend, no build step
test/           node:test suites
```

## Known limits

- **Turn alerts only reach someone who has the tab open.** Nobody is notified while the app is closed, so in practice people rely on the group chat. Web Push (service worker + VAPID keys) is the next thing to add.
- Identity is a random per-seat token in the browser. If someone clears their browser data and has no personal link saved, they lose their seat.
- Anyone with the game link can watch (cards stay hidden) and can take an open seat before the game fills.
