import {
  SIDE_COLORS, esc, cardHTML, backHTML, miniCard, miniCards, cardText, displayPrefs, setDisplayPref, cardValue, sortCards, timeAgo, mountBoard, updateBoard, boardRowsFor,
} from './ui.js';
import {
  pushAvailability, ensureSubscription, currentSubscription, registerServiceWorker, isStandalone,
} from './push-client.js';
import { sfx, soundPrefs, setSoundPref, setMusicTracks, musicTracks } from './sound.js';
import {
  holdemTableHTML, bindHoldem, tickTimers, holdemLastHandHTML, holdemOverHTML, seatColor, chips as chipsHTML, ordinal,
} from './holdem-ui.js';
import { thirtyOneTableHTML, bindThirtyOne, thirtyOneLastHTML, thirtyOneOverHTML } from './thirtyone-ui.js';

const GAME_NAMES = { cribbage: 'Cribbage', holdem: 'Texas Hold’em', thirtyone: 'Thirty-One' };
const isCribbage = (v) => (v.type ?? 'cribbage') === 'cribbage';
const gameName = (v) => GAME_NAMES[v.type ?? 'cribbage'];

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

// ---------------------------------------------------------------------------
// Local storage: which games this browser belongs to, and the player token.
// ---------------------------------------------------------------------------
const KEY = 'cribbage.v1';
const local = {
  read() {
    try {
      return { name: '', games: {}, seenHands: {}, push: {}, pushDismissed: {}, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    } catch {
      return { name: '', games: {}, seenHands: {}, push: {}, pushDismissed: {} };
    }
  },
  write(fn) {
    const data = local.read();
    fn(data);
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch { /* private mode: the session still works, it just won't remember */ }
    return data;
  },
  token: (id) => local.read().games[id]?.token,
  remember: (id, token) => local.write((d) => (d.games[id] = { token, addedAt: d.games[id]?.addedAt || Date.now() })),
  forget: (id) => local.write((d) => delete d.games[id]),
  // A private random key that identifies this person across games, for the leaderboard.
  playerKey() {
    let k = local.read().playerKey;
    if (!k) {
      k = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
      local.write((d) => (d.playerKey = k));
    }
    return k;
  },
};

// A device that has no games yet takes on the player key from a link, so the same
// person keeps one leaderboard record across their phone and computer.
function adoptPlayerKey(k, hadGames) {
  if (typeof k === 'string' && /^[0-9a-f]{16,64}$/.test(k) && !hadGames) local.write((d) => (d.playerKey = k));
}

// A link that carries every seat this browser holds, for moving to another device
// (or into an iPhone Home Screen app, which doesn't share storage with Safari).
function allGamesLink() {
  const d = local.read();
  const games = Object.fromEntries(Object.entries(d.games).map(([id, g]) => [id, g.token]));
  const bytes = new TextEncoder().encode(JSON.stringify({ n: d.name, g: games, k: local.playerKey() }));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}/#i=${b64}`;
}

/** Accepts an all-games link (/#i=...) or a single-game personal link (/g/id#t=...). Returns games imported. */
function importLink(text) {
  let url;
  try {
    url = new URL(String(text).trim(), location.origin);
  } catch {
    return 0;
  }
  const hash = new URLSearchParams(url.hash.slice(1));
  const single = url.pathname.match(/^\/g\/([a-z0-9]+)/);
  const hadGames = Object.keys(local.read().games).length > 0;
  if (single && hash.get('t')) {
    local.remember(single[1], hash.get('t'));
    adoptPlayerKey(hash.get('k'), hadGames);
    return 1;
  }
  if (hash.get('i')) {
    try {
      const raw = atob(hash.get('i').replace(/-/g, '+').replace(/_/g, '/'));
      const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
      const entries = Object.entries(data.g || {}).filter(([id, t]) => /^[a-z0-9]+$/.test(id) && typeof t === 'string');
      for (const [id, token] of entries) local.remember(id, token);
      adoptPlayerKey(data.k, hadGames);
      if (data.n && !local.read().name) local.write((d) => (d.name = String(data.n).slice(0, 20)));
      return entries.length;
    } catch {
      return 0;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
// The demo build sets window.CRIB_TRANSPORT to an in-browser backend
// ({ api, subscribe }); the real app talks to the server.
const LOCAL = window.CRIB_TRANSPORT || null;

async function api(path, { method = 'GET', body, gameId } = {}) {
  if (LOCAL) return LOCAL.api(path, { method, body, token: gameId && local.token(gameId), playerKey: local.playerKey() });
  const headers = { 'Content-Type': 'application/json', 'X-Player-Key': local.playerKey() };
  const token = gameId && local.token(gameId);
  if (token) headers['X-Player-Token'] = token;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function toast(msg, kind = 'error') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
  } catch {
    prompt('Copy this link:', text);
  }
}

// Background music choices for the 🔊 menu.
function trackOptions() {
  const cur = soundPrefs().track;
  return musicTracks().map((t) => `<option value="${esc(t.url)}" ${cur === t.url ? 'selected' : ''}>${esc(t.title)}</option>`).join('')
    + `<option value="synth" ${cur === 'synth' || !musicTracks().length ? 'selected' : ''}>Built-in (soft chords)</option>`;
}
function refreshTrackPicker() {
  const sel = document.getElementById('music-track');
  if (sel) sel.innerHTML = trackOptions();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
let teardown = () => {};
let memPath = '/'; // the demo routes in memory: its frame doesn't support URL paths
const currentPath = () => (LOCAL ? memPath : location.pathname);
function route() {
  teardown();
  teardown = () => {};
  document.title = 'Card Night';
  if (currentPath() === '/leaders') return renderLeaders();
  if (LOCAL) {
    const m = currentPath().match(/^\/g\/([a-z0-9]+)/);
    if (m) teardown = mountGame(m[1]);
    else renderHome();
    return;
  }
  const m = location.pathname.match(/^\/g\/([a-z0-9]+)/);
  if (m) {
    // Device links carry the token in the hash so it never hits server logs.
    if (new URLSearchParams(location.hash.slice(1)).get('t')) {
      importLink(location.href);
      history.replaceState(null, '', location.pathname);
    }
    teardown = mountGame(m[1]);
  } else {
    if (location.hash.startsWith('#i=')) {
      const n = importLink(location.href);
      history.replaceState(null, '', '/');
      if (n) setTimeout(() => toast(`Added ${n} game${n === 1 ? '' : 's'} to this device`, 'ok'), 50);
    }
    renderHome();
  }
}
function go(path) {
  if (LOCAL) {
    memPath = path;
    route();
    window.scrollTo(0, 0);
    return;
  }
  history.pushState(null, '', path);
  route();
}
if (!LOCAL) window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    go(a.getAttribute('href'));
  }
});

const brand = `<a href="/" data-link class="brand"><span class="brand-mark">♣</span><span>Card Night</span></a>`;

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
const pct = (r) => (r == null ? '–' : `${Math.round(r * 100)}%`);

let leaderGame = 'cribbage';
async function renderLeaders() {
  app.innerHTML = `
    <div class="home leaders">
      <header class="topbar">${brand}<div class="top-actions"><a class="btn ghost" href="/" data-link>Your games</a></div></header>
      <section class="hero slim">
        <h1>Leaderboard</h1>
        <p>Every finished game on this ${LOCAL ? 'device' : 'server'}. Tap a player to see how they've done against each opponent.</p>
        <div class="tabs lb-tabs" role="tablist">${Object.entries(GAME_NAMES).map(([k, n]) => `<button role="tab" data-lb="${k}" class="${k === leaderGame ? 'on' : ''}" aria-selected="${k === leaderGame}">${n}</button>`).join('')}</div>
      </section>
      <div class="panel board-panel" id="leaders"><div class="loading"><div class="spinner"></div></div></div>
    </div>`;
  for (const b of app.querySelectorAll('[data-lb]')) {
    b.onclick = () => {
      leaderGame = b.dataset.lb;
      renderLeaders();
    };
  }
  let data;
  try {
    data = await api(`/stats?game=${leaderGame}`);
  } catch (err) {
    $('#leaders').innerHTML = `<p class="muted">Couldn't load the leaderboard: ${esc(err.message)}</p>`;
    return;
  }
  const el = $('#leaders');
  if (!el) return;
  const rows = data.players;
  if (!rows.length) {
    el.innerHTML = `<div class="empty"><p>No finished ${GAME_NAMES[leaderGame]} games yet. Records show up here when a game ends${leaderGame === 'holdem' ? ' (one player holds every chip)' : leaderGame === 'thirtyone' ? ' (one player is left)' : ' (someone reaches 121)'}.</p></div>`;
    return;
  }
  const me = rows.find((p) => p.id === data.you);
  el.innerHTML = `
    ${me ? (me.wins + me.losses
      ? `<div class="my-record"><span>Your record vs people</span><b>${me.wins}–${me.losses}</b>
        <span class="muted">${pct(me.winRate)} · vs bots ${me.botWins}–${me.botLosses} · ${me.skunks} skunk${me.skunks === 1 ? '' : 's'} given</span></div>`
      : `<div class="my-record"><span>Your record vs bots</span><b>${me.botWins}–${me.botLosses}</b>
        <span class="muted">No finished games against people yet · ${me.skunks} skunk${me.skunks === 1 ? '' : 's'} given</span></div>`) : ''}
    <div class="table-scroll"><table class="lb">
      <thead><tr><th>#</th><th>Player</th><th title="Wins–losses against people">vs people</th><th>Win %</th><th title="Games against bots">vs bots</th><th title="Skunks given">Skunks</th></tr></thead>
      <tbody>${rows.map((p, i) => `
        <tr class="lb-row ${p.id === data.you ? 'is-me' : ''}" data-i="${i}" tabindex="0">
          <td class="rank">${p.wins + p.losses ? i + 1 : '–'}</td>
          <td class="who"><b>${esc(p.name)}</b>${p.id === data.you ? ' <span class="pill">You</span>' : ''}<small>last played ${timeAgo(p.lastPlayed)}</small></td>
          <td class="num"><b>${p.wins}</b>–${p.losses}</td>
          <td class="num">${pct(p.winRate)}</td>
          <td class="num muted">${p.botWins}–${p.botLosses}</td>
          <td class="num">${p.skunks}</td>
        </tr>
        <tr class="h2h-row" hidden><td colspan="6"><div class="h2h">
          <h3>${esc(p.name)} vs…</h3>
          <ul>${p.opponents.map((o) => `<li><span>${esc(o.name)}${o.bot ? ' <span class="bot-tag">BOT</span>' : ''}</span>
            <span class="bar ${o.wins + o.losses ? '' : 'none'}"><i style="--w:${o.wins + o.losses ? (o.wins / (o.wins + o.losses)) * 100 : 0}%"></i></span>
            <b>${o.wins}–${o.losses}</b></li>`).join('') || '<li class="muted">No opponents yet</li>'}</ul>
        </div></td></tr>`).join('')}
      </tbody></table></div>
    <p class="hint">${leaderGame !== 'cribbage' ? 'The winner (last one standing) beats everyone at the table; everyone else records a loss to the winner.' : 'Team games count as a win for both partners. In 3- and 4-player games the winner beats everyone at the table.'} Records follow each browser's player; use “Move your games to another device” on the home page to keep one record across your phone and computer.</p>`;
  for (const row of el.querySelectorAll('.lb-row')) {
    const toggle = () => {
      const detail = row.nextElementSibling;
      detail.hidden = !detail.hidden;
      row.classList.toggle('open', !detail.hidden);
    };
    row.onclick = toggle;
    row.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle());
  }
}

function renderHome() {
  const data = local.read();
  // Cribbage formats: [key, label, players, teams]
  const MODES = [['2', '2', 2, false], ['3', '3', 3, false], ['4', '4', 4, false], ['4t', '2 v 2', 4, true]];
  let mode = MODES[0];
  let game = GAME_NAMES[data.lastGame] ? data.lastGame : 'cribbage';
  const sel = (id, opts, value) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  app.innerHTML = `
    <div class="home">
      <header class="topbar">${brand}<div class="top-actions"><a class="btn ghost" href="/leaders" data-link>🏆 Leaderboard</a></div></header>
      <section class="hero">
        <h1>Card games with your friends,<br><span class="grad">wherever they are.</span></h1>
        <p>Cribbage and Thirty-One you can play on your own time, and Texas Hold’em for game night. Every game saves itself.</p>
      </section>
      <div class="home-grid">
        <form class="panel create" id="create">
          <h2>New game</h2>
          <div class="game-pick" role="radiogroup" aria-label="Game">
            <button type="button" role="radio" data-game="cribbage" aria-checked="${game === 'cribbage'}"><span class="gp-icon">♣</span><b>Cribbage</b><small>2–4 players · play anytime</small></button>
            <button type="button" role="radio" data-game="holdem" aria-checked="${game === 'holdem'}"><span class="gp-icon">♠</span><b>Texas Hold’em</b><small>2–9 players · play live</small></button>
            <button type="button" role="radio" data-game="thirtyone" aria-checked="${game === 'thirtyone'}"><span class="gp-icon">31</span><b>Thirty-One</b><small>2–8 players · play anytime</small></button>
          </div>
          <label class="field"><span>Your name</span>
            <input name="name" maxlength="20" autocomplete="nickname" placeholder="e.g. Sam" value="${esc(data.name)}" required></label>
          <div id="opts-cribbage" class="game-opts" ${game === 'cribbage' ? '' : 'hidden'}>
            <div class="field"><span>Players</span>
              <div class="seg" role="radiogroup">
                ${MODES.map(([key, label]) => `<button type="button" role="radio" data-n="${key}" aria-checked="${key === '2'}">${label}</button>`).join('')}
              </div>
              <small class="hint" id="players-hint">Classic head-to-head. 6 cards each, 2 to the crib.</small>
            </div>
          </div>
          <div id="opts-holdem" class="game-opts" ${game === 'holdem' ? '' : 'hidden'}>
            <div class="opt-grid">
              <label class="field"><span>Seats</span>${sel('he-seats', [2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, `${n} players`]), 6)}</label>
              <label class="field"><span>Starting chips</span>${sel('he-stack', [[500, '500'], [1000, '1,000'], [1500, '1,500 (standard)'], [2500, '2,500'], [5000, '5,000'], [10000, '10,000'], ['custom', 'Custom…']], 1500)}</label>
              <label class="field" id="he-stack-custom-wrap" hidden><span>Custom starting chips</span><input id="he-stack-custom" type="number" min="100" max="1000000" step="50" value="3000" inputmode="numeric"></label>
              <label class="field"><span>Blinds</span>${sel('he-blinds', [[10, '5 / 10'], [20, '10 / 20 (standard)'], [50, '25 / 50'], [100, '50 / 100'], [200, '100 / 200'], ['custom', 'Custom…']], 20)}</label>
              <label class="field" id="he-bb-custom-wrap" hidden><span>Custom big blind</span><input id="he-bb-custom" type="number" min="2" max="100000" step="2" value="40" inputmode="numeric"></label>
              <label class="field"><span>Blinds go up</span>${sel('he-levels', [[5, 'Every 5 hands'], [10, 'Every 10 hands'], [15, 'Every 15 hands'], [20, 'Every 20 hands'], [0, 'Never']], 10)}</label>
              <label class="field"><span>Time to act</span>${sel('he-timer', [[30, '30 seconds'], [60, '60 seconds'], [120, '2 minutes']], 60)}</label>
            </div>
            <small class="hint">Tournament: everyone starts equal, blinds double on schedule, last player with chips wins. When time runs out you check, or fold if there’s a bet. The host can start before every seat fills.</small>
          </div>
          <div id="opts-thirtyone" class="game-opts" ${game === 'thirtyone' ? '' : 'hidden'}>
            <div class="opt-grid">
              <label class="field"><span>Seats</span>${sel('t1-seats', [2, 3, 4, 5, 6, 7, 8].map((n) => [n, `${n} players`]), 4)}</label>
              <label class="field"><span>Tokens each</span>${sel('t1-tokens', [[3, '3 (quick)'], [6, '6 (standard)'], [9, '9 (long)']], 6)}</label>
            </div>
            <small class="hint">Get as close to 31 in one suit as you can. Knock when you’re happy; lowest hand loses a token (a knocker who’s lowest loses 2). Hit 31 and everyone else pays. Out of tokens, you’re on your honor; lose again and you’re out.</small>
          </div>
          ${LOCAL ? '' : '<button class="btn primary big" type="submit">Create game &amp; get invite link</button>'}
          <button class="btn ${LOCAL ? 'primary' : ''} big" type="button" id="vs-bot">🤖 ${LOCAL ? 'Start a game' : 'Play bots right now'}</button>
          <small class="hint center-hint">${LOCAL ? 'Every other seat is a bot.' : 'Fills every other seat with a bot.'}</small>
        </form>
        <section class="panel games">
          <h2>Your games</h2>
          <div id="game-list" class="game-list"><p class="muted">Loading…</p></div>
          <details class="transfer ${LOCAL ? 'hidden' : ''}" ${isStandalone() && !Object.keys(data.games).length ? 'open' : ''}>
            <summary>Move your games to another device</summary>
            <p class="hint">Copy a link on the device that has your games, then paste it here on the new one. It signs in as you, so don't send it to anyone else.</p>
            <div class="invite-box">
              <button type="button" class="btn" id="copy-all" ${Object.keys(data.games).length ? '' : 'disabled'}>Copy my games link</button>
            </div>
            <form class="invite-box" id="paste-link"><input name="link" placeholder="Paste a link here" autocomplete="off"><button class="btn primary">Add</button></form>
          </details>
        </section>
      </div>
    </div>`;

  const hints = {
    2: 'Classic head-to-head. 6 cards each, 2 to the crib.',
    3: 'Everyone for themselves. 5 cards each, 1 to the crib, plus 1 from the deck.',
    4: 'Four players, everyone for themselves. 5 cards each, 1 to the crib.',
    '4t': 'Two teams of two; partners sit opposite. 5 cards each, 1 to the crib.',
  };
  for (const b of app.querySelectorAll('.seg button')) {
    b.onclick = () => {
      mode = MODES.find(([key]) => key === b.dataset.n);
      app.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-checked', x === b));
      $('#players-hint').textContent = hints[mode[0]];
    };
  }
  for (const b of app.querySelectorAll('.game-pick [data-game]')) {
    b.onclick = () => {
      game = b.dataset.game;
      app.querySelectorAll('.game-pick [data-game]').forEach((x) => x.setAttribute('aria-checked', x === b));
      $('#opts-cribbage').hidden = game !== 'cribbage';
      $('#opts-holdem').hidden = game !== 'holdem';
      $('#opts-thirtyone').hidden = game !== 'thirtyone';
    };
  }
  $('#he-stack').onchange = () => ($('#he-stack-custom-wrap').hidden = $('#he-stack').value !== 'custom');
  $('#he-blinds').onchange = () => ($('#he-bb-custom-wrap').hidden = $('#he-blinds').value !== 'custom');

  function newGameBody(name) {
    if (game === 'cribbage') return { type: 'cribbage', name, numPlayers: mode[2], teams: mode[3] };
    if (game === 'thirtyone') return { type: 'thirtyone', name, numPlayers: Number($('#t1-seats').value), settings: { tokens: Number($('#t1-tokens').value) } };
    const stack = $('#he-stack').value === 'custom' ? Number($('#he-stack-custom').value) : Number($('#he-stack').value);
    const bb = $('#he-blinds').value === 'custom' ? Number($('#he-bb-custom').value) : Number($('#he-blinds').value);
    return {
      type: 'holdem', name, numPlayers: Number($('#he-seats').value),
      settings: { startingStack: stack, bigBlind: bb, smallBlind: Math.max(1, Math.floor(bb / 2)), levelHands: Number($('#he-levels').value), actionSeconds: Number($('#he-timer').value) },
    };
  }
  async function create(withBots) {
    const form = $('#create');
    const name = form.name.value.trim();
    if (!name) return form.name.focus();
    form.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const { id, token } = await api('/games', { method: 'POST', body: newGameBody(name) });
      local.remember(id, token);
      local.write((d) => {
        d.name = name;
        d.lastGame = game;
      });
      if (withBots) await api(`/games/${id}/bots`, { method: 'POST', gameId: id });
      go(`/g/${id}`);
    } catch (err) {
      toast(err.message);
      form.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }
  $('#vs-bot').onclick = () => create(true);
  $('#create').onsubmit = (e) => {
    e.preventDefault();
    create(LOCAL);
  };
  $('#copy-all').onclick = () => copy(allGamesLink(), 'Link to all your games copied');
  $('#paste-link').onsubmit = (e) => {
    e.preventDefault();
    const n = importLink(e.target.link.value);
    if (!n) return toast("That doesn't look like a Card Night personal link.");
    toast(`Added ${n} game${n === 1 ? '' : 's'}`, 'ok');
    renderHome();
  };
  loadGameList();
}

async function loadGameList() {
  const list = $('#game-list');
  const entries = Object.entries(local.read().games).sort((a, b) => b[1].addedAt - a[1].addedAt);
  if (!entries.length) {
    list.innerHTML = `<div class="empty"><div class="empty-cards">${backHTML('sm')}${backHTML('sm')}${backHTML('sm')}</div>
      <p>No games yet. Create one and send the link to your friends.</p></div>`;
    return;
  }
  const results = await Promise.all(
    entries.map(([id]) => api(`/games/${id}`, { gameId: id }).catch((e) => ({ id, error: e })))
  );
  if (!list.isConnected) return;
  const rank = (v) => (v.error ? 4 : v.yourTurn ? 0 : v.status === 'playing' ? 1 : v.status === 'lobby' ? 2 : 3);
  results.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  list.innerHTML = results.map(gameRow).join('');
  for (const btn of list.querySelectorAll('[data-forget]')) {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (LOCAL || confirm('Remove this game from your list? (It stays on the server; you can rejoin with your device link.)')) {
        local.forget(btn.dataset.forget);
        loadGameList();
      }
    };
  }
}

function gameRow(v) {
  if (v.error) {
    return `<div class="game-row dead"><div><b>Game ${esc(v.id)}</b><small>${v.error.status === 404 ? 'No longer exists' : 'Could not load'}</small></div>
      <button class="icon-btn" data-forget="${esc(v.id)}" title="Remove">✕</button></div>`;
  }
  const holdem = v.type === 'holdem';
  const solo = !isCribbage(v); // every seat plays alone
  const others = v.players.filter((p) => p.seat !== v.you).map((p) => p.name);
  const title = others.length ? `vs ${others.join(', ')}` : 'Waiting for players';
  let status;
  if (v.status === 'lobby') status = `<span class="pill">Lobby · ${v.players.length}/${v.numPlayers}</span>`;
  else if (v.status === 'finished') {
    const won = v.you !== null && (solo ? v.winner === v.you : v.players[v.you].side === v.winner);
    status = `<span class="pill ${won ? 'win' : ''}">${won ? 'You won' : solo && v.you !== null ? `Finished ${ordinal(v.players[v.you].place)}` : 'Finished'}</span>`;
  } else if (v.yourTurn) status = `<span class="pill turn">Your turn</span>`;
  else {
    const waiting = v.players.filter((p) => p.isTurn).map((p) => p.name);
    status = `<span class="pill">Waiting on ${esc(waiting.join(', '))}</span>`;
  }
  let scores = '';
  if (v.status !== 'lobby' && holdem && v.you !== null) scores = `<span class="row-scores">${chipsHTML(v.players[v.you].stack)}</span>`;
  else if (v.status !== 'lobby' && v.type === 'thirtyone' && v.you !== null) scores = `<span class="row-scores">${v.players[v.you].onHonor ? 'On honor' : `${v.players[v.you].tokens} tokens`}</span>`;
  else if (v.status !== 'lobby' && isCribbage(v)) {
    scores = `<span class="row-scores">${v.scores.map((s, i) => `<span style="--c:${SIDE_COLORS[i]}">${s}</span>`).join('<i>·</i>')}</span>`;
  }
  const kind = holdem ? `Hold’em · ${v.numPlayers} players` : v.type === 'thirtyone' ? `Thirty-One · ${v.numPlayers} players` : `Cribbage · ${v.teams ? '2 v 2' : `${v.numPlayers}-player`}`;
  return `<a class="game-row ${v.yourTurn ? 'is-turn' : ''}" href="/g/${v.id}" data-link>
    <div><b>${esc(title)}</b><small>${kind} · updated ${timeAgo(v.updatedAt)}</small></div>
    <div class="row-right">${scores}${status}<button class="icon-btn" data-forget="${v.id}" title="Remove from list">✕</button></div></a>`;
}

// ---------------------------------------------------------------------------
// Scored-hand highlighting: light up the cards behind one scoring line.
// ---------------------------------------------------------------------------
function highlight(show, li) {
  show.querySelectorAll('.items li.active').forEach((x) => x.classList.remove('active'));
  show.querySelectorAll('.show-cards .card.lit').forEach((x) => x.classList.remove('lit'));
  show.classList.toggle('highlighting', !!li);
  if (!li) return;
  li.classList.add('active');
  const cards = li.dataset.cards.split(',');
  show.querySelectorAll('.show-cards .card').forEach((c) => c.classList.toggle('lit', cards.includes(c.dataset.card)));
}

// Hover, focus or tap a scoring line to see which cards made it.
const lineOf = (e) => e.target.closest?.('.show:not(.pending) .items li');
document.addEventListener('mouseover', (e) => {
  const li = lineOf(e);
  if (li && !li.closest('.counting-now')) highlight(li.closest('.show'), li);
});
document.addEventListener('mouseout', (e) => {
  const li = lineOf(e);
  if (li && !li.contains(e.relatedTarget) && !li.closest('.counting-now')) highlight(li.closest('.show'), null);
});
document.addEventListener('focusin', (e) => {
  const li = lineOf(e);
  if (li && !li.closest('.counting-now')) highlight(li.closest('.show'), li);
});
document.addEventListener('click', (e) => {
  const li = lineOf(e);
  if (!li || li.closest('.counting-now')) return;
  const show = li.closest('.show');
  highlight(show, li.classList.contains('active') ? null : li); // tap again to clear (touch screens)
});

/**
 * Count each hand out loud, one scoring line at a time: light its cards, add its
 * points to a running total, then move on to the next hand. Returns controls to
 * finish instantly (Skip) or stop (modal closed).
 */
function countThrough(root, onDone) {
  const STEP = 750;
  const BETWEEN = 600;
  const shows = [...root.querySelectorAll('.show')];
  const timers = [];
  let stopped = false;
  shows.forEach((sh) => sh.classList.add('pending'));

  const settleShow = (sh) => {
    highlight(sh, null);
    sh.classList.remove('pending', 'counting-now');
    sh.classList.add('counted');
    sh.querySelectorAll('.items li').forEach((li) => li.classList.add('shown'));
    sh.querySelector('.show-total').textContent = sh.dataset.total;
    sh.querySelector('.say').textContent = '';
  };
  const finish = () => {
    if (stopped) return;
    stopped = true;
    timers.forEach(clearTimeout);
    shows.forEach(settleShow);
    root.classList.remove('counting');
    onDone?.();
  };

  let t = 400;
  const at = (fn) => timers.push(setTimeout(() => !stopped && root.isConnected && fn(), t));
  for (const sh of shows) {
    const lines = [...sh.querySelectorAll('.items li')];
    at(() => {
      sh.classList.remove('pending');
      sh.classList.add('counting-now');
      sh.querySelector('.show-total').textContent = '0';
      sh.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    t += 350;
    let running = 0;
    for (const li of lines) {
      running += Number(li.dataset.points);
      const total = running;
      at(() => {
        li.classList.add('shown');
        highlight(sh, li);
        sfx.tick(lines.indexOf(li));
        sh.querySelector('.say').textContent = `${li.dataset.label} · ${total}`;
        const el = sh.querySelector('.show-total');
        el.textContent = total;
        el.classList.remove('tick');
        void el.offsetWidth; // restart the pop animation
        el.classList.add('tick');
      });
      t += STEP;
    }
    if (!lines.length) {
      at(() => (sh.querySelector('.say').textContent = 'Nineteen'));
      t += STEP;
    }
    at(() => settleShow(sh));
    t += BETWEEN;
  }
  at(finish);
  return { finish, stop: () => { stopped = true; timers.forEach(clearTimeout); } };
}

// ---------------------------------------------------------------------------
// Game screen
// ---------------------------------------------------------------------------
function mountGame(id) {
  const G = {
    id,
    view: null,
    selected: [],
    busy: false,
    tab: 'activity',
    lastAnimatedPile: [],
    dealtKey: null,
    starterSeen: null,
    pushSynced: false,
    goShown: new Set(),
    seenBoard: new Set(),
    dealtHand: null,
    raiseTo: null,
    t1Selected: null,
    lastTop: null,
    clockOffset: 0,
    soundOpen: false,
    boardSides: 0,
    alive: true,
  };

  app.innerHTML = `
    <div class="game">
      <header class="topbar" id="topbar">${brand}</header>
      <main class="layout">
        <section class="main-col">
          <div id="callouts" aria-live="polite"></div>
          <div id="push-banner"></div>
          <div id="over-bar"></div>
          <div class="scores" id="scores"></div>
          <div class="board-wrap" id="board"></div>
          <div id="table"><div class="loading"><div class="spinner"></div></div></div>
        </section>
        <aside class="side-col panel" id="side"></aside>
      </main>
      <div id="overlay"></div>
    </div>`;

  let reqSeq = 0;
  let appliedSeq = 0;
  async function refresh(force = false) {
    const seq = ++reqSeq;
    try {
      const v = await api(`/games/${id}`, { gameId: id });
      // Ignore responses that were overtaken by a newer request (e.g. one sent before we had a token).
      if (!G.alive || seq < appliedSeq) return;
      appliedSeq = seq;
      if (!force && G.view && v.version === G.view.version && v.you === G.view.you) return;
      setView(v);
    } catch (err) {
      if (!G.alive) return;
      if (err.status === 404) {
        $('#table').innerHTML = `<div class="panel notfound"><h2>Game not found</h2><p class="muted">The link may be wrong, or the game was removed.</p><a class="btn" href="/" data-link>Back home</a></div>`;
      } else toast(err.message);
    }
  }

  function setView(v) {
    const prev = G.view;
    G.view = v;
    // Drop selections that no longer make sense.
    G.selected = G.selected.filter((c) => v.hand.includes(c));
    if (!prev || prev.phase !== v.phase || prev.handNo !== v.handNo) G.selected = [];
    if (v.phase === 'pegging' && !v.yourTurn) G.selected = [];
    if (v.serverNow) G.clockOffset = v.serverNow - Date.now();
    if (!v.yourTurn || !prev?.yourTurn) G.raiseTo = null; // fresh raise slider for each decision
    notifyIfTurn(v);
    render();
    announce(prev, v);
  }

  // --- what just happened: sounds and table callouts ---------------------------
  const logKey = (e) => (e ? `${e.t}|${e.text}` : '');
  function announce(prev, v) {
    const log = v.log || [];
    if (!prev || G.logSeen === undefined) {
      G.logSeen = logKey(log.at(-1)); // first load: don't replay history
      return;
    }
    const from = log.findIndex((e) => logKey(e) === G.logSeen);
    const fresh = from === -1 ? log.slice(-3) : log.slice(from + 1);
    G.logSeen = logKey(log.at(-1));
    let delay = 0;
    for (const e of fresh) {
      const later = (fn) => setTimeout(fn, delay);
      const who = e.seat != null ? v.players[e.seat] : null;
      if (e.card) later(() => sfx.card());
      if (e.kind === 'hand') later(() => sfx.deal(v.type === 'holdem' ? Math.min(10, v.numPlayers * 2) : v.type === 'thirtyone' ? Math.min(10, v.numPlayers * 3) : v.numPlayers === 2 ? 6 : 5));
      if (e.kind === 'draw-stock' || e.kind === 'draw-discard') later(() => sfx.card());
      if (e.kind === 'street') later(() => sfx.deal(e.street === 'flop' ? 3 : 1));
      if (e.kind === 'poker-call' || e.kind === 'poker-raise') later(() => sfx.chips());
      if (e.kind === 'poker-check') later(() => sfx.tick(0));
      if (e.kind === 'poker-fold') later(() => sfx.card());
      if (e.kind === 'poker-win') later(() => sfx.score(4));
      // In Hold'em only the big moments get a callout (not every check and fold).
      const loud = v.type !== 'holdem' || ['poker-raise', 'poker-win', 'poker-out'].includes(e.kind) || e.calls?.some((c) => c.label.startsWith('All in'));
      if (e.calls?.length && who && loud) {
        const is31 = e.calls.some((c) => c.label.startsWith('31'));
        const isGo = e.kind === 'go' || e.kind === 'knock'; // a knock is a knock on the table
        later(() => {
          if (is31) sfx.thirtyOne();
          else if (isGo) sfx.go();
          else if (e.points && v.type !== 'holdem') sfx.score(e.points);
          callout(who, e.calls, is31);
        });
        delay += 250;
      }
    }
    if (v.yourTurn && !prev.yourTurn) setTimeout(() => sfx.turn(), delay + 150);
    if (v.status === 'finished' && prev.status !== 'finished') setTimeout(() => sfx.win(), delay + 300);
  }

  // Big announcements over the felt, queued so each one gets seen.
  const calloutQueue = [];
  let calloutBusy = false;
  function callout(player, calls, big) {
    const name = player.seat === G.view?.you ? 'You' : player.name;
    const text = calls.map((c) => (c.points ? `${c.label} for ${c.points}` : c.label)).join(' · ');
    calloutQueue.push({ name, text, color: G.view?.type === 'holdem' ? seatColor(player.seat) : SIDE_COLORS[player.side], big });
    if (!calloutBusy) nextCallout();
  }
  function nextCallout() {
    const c = calloutQueue.shift();
    const layer = $('#callouts');
    const felt = $('.felt');
    if (!c || !layer || !felt) {
      calloutBusy = false;
      return;
    }
    calloutBusy = true;
    const col = layer.parentElement.getBoundingClientRect();
    const r = felt.getBoundingClientRect();
    // Centered on the felt's top edge, so the pile (and the 31 on it) stays visible.
    layer.style.top = `${r.top - col.top}px`;
    const el = document.createElement('div');
    el.className = `callout ${c.big ? 'big' : ''}`;
    el.style.setProperty('--c', c.color);
    el.innerHTML = `<small>${esc(c.name)}</small><b>${esc(c.text)}</b>`;
    layer.append(el);
    // One at a time: the next waits until this one has fully left. Shorter when more are waiting.
    const hold = calloutQueue.length ? 1000 : c.big ? 1900 : 1400;
    setTimeout(() => el.classList.add('out'), hold);
    setTimeout(() => {
      el.remove();
      nextCallout();
    }, hold + 320);
  }

  function notifyIfTurn(v) {
    document.title = v.yourTurn ? '● Your turn · Card Night' : 'Card Night';
    if (v.you !== null && !G.pushSynced && !LOCAL) {
      G.pushSynced = true;
      syncPush();
    }
  }

  // --- push notifications ----------------------------------------------------
  const pushOn = () =>
    local.read().push[id] === 'on' && 'Notification' in window && Notification.permission === 'granted';

  async function registerPush() {
    const sub = await ensureSubscription();
    await api(`/games/${id}/push`, { method: 'POST', body: { subscription: sub.toJSON() }, gameId: id });
    local.write((d) => (d.push[id] = 'on'));
  }

  // Re-register on every visit: endpoints can rotate, and a device that already
  // allowed notifications for one game gets them for its other games too.
  async function syncPush() {
    if (local.read().push[id] === 'off' || pushAvailability() !== 'ready' || Notification.permission !== 'granted') return;
    try {
      await registerPush();
      if (G.alive) render();
    } catch { /* stay quiet; the bell still works */ }
  }

  async function enablePush() {
    const avail = pushAvailability();
    if (avail === 'ios-install') return showIosHelp();
    if (avail === 'insecure') return toast('Notifications need the site served over HTTPS.');
    if (avail !== 'ready') return toast('This browser doesn’t support push notifications.');
    // Safari only allows the permission prompt directly inside the tap, so ask before any other await.
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') {
      return toast(perm === 'denied'
        ? 'Notifications are blocked. Allow them for this site in your browser settings, then try again.'
        : 'Notifications weren’t turned on.');
    }
    try {
      await registerPush();
      toast('You’ll get a notification when it’s your turn, even with the app closed.', 'ok');
    } catch (err) {
      toast(`Couldn’t turn on notifications: ${err.message}`);
    }
    render();
  }

  async function disablePush() {
    const sub = await currentSubscription().catch(() => null);
    if (sub) await api(`/games/${id}/push/remove`, { method: 'POST', body: { endpoint: sub.endpoint }, gameId: id }).catch(() => {});
    local.write((d) => (d.push[id] = 'off'));
    toast('Notifications off for this game.', 'ok');
    render();
  }

  function showIosHelp() {
    const ov = $('#overlay');
    ov.dataset.state = 'ios-help';
    ov.innerHTML = `<div class="modal-bg"><div class="modal panel ios-help">
      <h2>Turn notifications on iPhone</h2>
      <p class="muted">Apple only sends web notifications to apps on your Home Screen. It takes about 30 seconds, once.</p>
      <ol class="steps">
        <li><b>Copy your games link.</b> The Home Screen app starts empty, and this link brings your seats with you.
          <button class="btn" id="ios-copy">Copy my games link</button></li>
        <li>Tap <b>Share</b> <span class="share-glyph">⬆︎</span> in Safari, then <b>Add to Home Screen</b>.</li>
        <li>Open <b>Card Night</b> from your Home Screen, paste the link under “Move your games”, open this game and tap <b>🔔</b>.</li>
      </ol>
      <div class="modal-actions"><button class="btn primary" id="ios-done">Got it</button></div></div></div>`;
    $('#ios-copy').onclick = () => copy(allGamesLink(), 'Copied. Now add Card Night to your Home Screen.');
    $('#ios-done').onclick = () => {
      ov.innerHTML = '';
      ov.dataset.state = '';
    };
  }

  function renderPushBanner(v) {
    const el = $('#push-banner');
    if (LOCAL) return;
    const d = local.read();
    const avail = pushAvailability();
    const show = v.you !== null && v.status !== 'finished' && !pushOn() && d.push[id] !== 'off' && !d.pushDismissed[id]
      && (avail === 'ready' || avail === 'ios-install')
      && !(avail === 'ready' && Notification.permission === 'denied');
    if (!show) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="push-banner">
      <span class="pb-icon">🔔</span>
      <div class="pb-text"><b>Know when it’s your turn</b><span>${avail === 'ios-install'
        ? 'On iPhone, notifications need Card Night on your Home Screen.'
        : 'Get a notification on this device, even with the app closed.'}</span></div>
      <button class="btn primary" id="pb-on">${avail === 'ios-install' ? 'Show me how' : 'Turn on'}</button>
      <button class="icon-btn" id="pb-x" title="Not now">✕</button></div>`;
    $('#pb-on').onclick = enablePush;
    $('#pb-x').onclick = () => {
      local.write((x) => (x.pushDismissed[id] = true));
      renderPushBanner(v);
    };
  }

  async function act(path, body) {
    if (G.busy) return;
    G.busy = true;
    render();
    try {
      const v = await api(`/games/${id}/${path}`, { method: 'POST', body, gameId: id });
      appliedSeq = ++reqSeq;
      G.selected = [];
      setView(v);
    } catch (err) {
      toast(err.message);
      refresh();
    } finally {
      G.busy = false;
      render();
    }
  }

  // --- render --------------------------------------------------------------
  function render() {
    const v = G.view;
    if (!v) return;
    if (v.you === null && v.status === 'lobby') return renderJoin(v);
    renderTopbar(v);
    renderPushBanner(v);
    renderOverBar(v);
    const crib = isCribbage(v);
    if (!crib) {
      $('#scores').innerHTML = '';
      $('#board').innerHTML = '';
      G.boardSides = 0;
    } else {
      renderScores(v);
      renderBoard(v);
    }
    const before = crib ? snapshotTable() : null;
    const table = v.status === 'lobby' ? lobbyHTML(v)
      : v.type === 'holdem' ? holdemTableHTML(v, G)
      : v.type === 'thirtyone' ? thirtyOneTableHTML(v, G)
      : tableHTML(v);
    $('#table').innerHTML = table;
    if (crib) animateTable(before, G.animView, v);
    G.animView = v;
    $('#side').innerHTML = sideHTML(v);
    bindTable(v);
    if (v.status !== 'lobby' && v.type === 'holdem') bindHoldem(v, G, act);
    if (v.status !== 'lobby' && v.type === 'thirtyone') bindThirtyOne(v, G, act, render);
    tickTimers(v, G.clockOffset);
    renderOverlay(v);
  }

  // --- card motion -------------------------------------------------------------
  // The table is redrawn on every update, so motion is done "FLIP" style: note
  // where cards were before the redraw, then animate the new ones from there.
  const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rectOf = (el) => (el ? el.getBoundingClientRect() : null);

  function snapshotTable() {
    const hand = new Map();
    for (const el of document.querySelectorAll('.me .hand-card')) hand.set(el.dataset.card, rectOf(el));
    const seats = new Map();
    for (const el of document.querySelectorAll('.seat[data-seat]')) seats.set(Number(el.dataset.seat), rectOf(el.querySelector('.seat-cards .card') || el.querySelector('.seat-cards')));
    const pile = [...document.querySelectorAll('.pile .pile-card')].map((el) => ({ html: el.outerHTML, rect: rectOf(el) }));
    return { hand, seats, pile };
  }

  /** Glide `el` from the rectangle `from` to where it now sits. */
  function flyFrom(el, from, { delay = 0, duration = 420, fade = 0.5 } = {}) {
    if (!from) return;
    const to = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const scale = Math.min(1.2, Math.max(0.35, from.width / to.width));
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: fade }, { transform: 'none', opacity: 1 }],
      { duration, delay, easing: 'cubic-bezier(.2, .8, .25, 1)', fill: 'backwards' },
    );
  }

  function animateTable(snap, prev, v) {
    const handEls = [...document.querySelectorAll('.me .hand-card')];
    const deal = document.querySelector('.hand.deal');
    if (deal) deal.classList.remove('deal'); // motion below replaces the CSS fallback
    if (!prev || calm() || v.status === 'lobby') return;
    const sameHand = prev.handNo === v.handNo;
    const deck = rectOf(document.querySelector('.deck .card'));

    // New hand: cards slide in from the deck, one after another.
    if (!sameHand && v.phase === 'discard') {
      handEls.forEach((el, i) => flyFrom(el, deck, { delay: 120 + i * 70, duration: 460, fade: 0 }));
      document.querySelectorAll('.seat-cards .card').forEach((el, i) => flyFrom(el, deck, { delay: i * 45, duration: 380, fade: 0 }));
      return;
    }
    if (!sameHand) return;

    // A played card glides from the hand it came from to the pile.
    const before = prev.pegging?.history.length ?? 0;
    const played = v.pegging?.history.slice(before) ?? [];
    for (const h of played) {
      const el = [...document.querySelectorAll('.pile .pile-card')].find((x) => x.querySelector(`.card[data-card="${h.card}"]`));
      if (!el) continue;
      el.classList.remove('enter');
      el.classList.add('flown');
      flyFrom(el, h.seat === v.you ? snap.hand.get(h.card) : snap.seats.get(h.seat), { fade: h.seat === v.you ? 1 : 0.3 });
    }

    // A pile cleared after a 31 or a go fades off instead of vanishing.
    if (prev.pegging?.pile.length && v.pegging && v.pegging.pile.length < prev.pegging.pile.length && snap.pile.length) {
      const layer = document.createElement('div');
      layer.className = 'sweep-layer';
      for (const { html, rect } of snap.pile) {
        const ghost = document.createElement('div');
        ghost.innerHTML = html;
        const card = ghost.firstElementChild;
        card.classList.remove('enter', 'flown');
        Object.assign(card.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, margin: 0 });
        layer.append(card);
      }
      document.body.append(layer);
      layer.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-18px) scale(.94)' }], {
        duration: 450, easing: 'ease-in', fill: 'forwards',
      }).onfinish = () => layer.remove();
    }

    // Discards slide over to the crib.
    if (v.phase !== 'lobby' && v.cribCount > prev.cribCount) {
      const origins = [];
      v.players.forEach((p, i) => {
        if (p.discarded && !prev.players[i]?.discarded) {
          if (i === v.you) for (const c of prev.hand.filter((c) => !v.hand.includes(c))) origins.push(snap.hand.get(c));
          else for (let k = 0; k < v.discardCount; k++) origins.push(snap.seats.get(i));
        }
      });
      const crib = [...document.querySelectorAll('.crib-stack .card')].slice(-origins.length);
      crib.forEach((el, k) => flyFrom(el, origins[k], { delay: k * 60, fade: 0.4 }));
    }
  }

  function soundMenuHTML() {
    const p = soundPrefs();
    return `<details class="sound-menu" id="sound-menu" ${G.soundOpen ? 'open' : ''}>
      <summary class="icon-btn" title="Sound and display">${p.sfx || p.music ? '🔊' : '🔇'}</summary>
      <div class="sound-pop">
        <label class="switch"><input type="checkbox" data-pref="sfx" ${p.sfx ? 'checked' : ''}><span>Card sounds</span></label>
        <label class="switch"><input type="checkbox" data-pref="music" ${p.music ? 'checked' : ''}><span>Background music</span></label>
        <label class="track-pick"><span>Song</span><select id="music-track">${trackOptions()}</select></label>
        <label class="switch"><input type="checkbox" data-display="fourColor" ${displayPrefs().fourColor ? 'checked' : ''}><span>Four-colour suits <small class="muted">♣ green, ♦ blue</small></span></label>
      </div></details>`;
  }

  function renderTopbar(v) {
    const notifOn = pushOn();
    const avail = pushAvailability();
    const showBell = !LOCAL && v.you !== null && (avail === 'ready' || avail === 'ios-install');
    const meta = v.status === 'lobby' ? `${gameName(v)} · Lobby`
      : v.type === 'holdem' ? `Hold’em · Hand ${v.handNo} · Blinds ${v.sb.toLocaleString()}/${v.bb.toLocaleString()}`
      : v.type === 'thirtyone' ? `Thirty-One · Round ${v.handNo} · ${esc(v.players[v.dealer].name)} deals`
      : `Hand ${v.handNo} · ${esc(v.players[v.dealer].name)} deals`;
    $('#topbar').innerHTML = `${brand}
      <div class="top-meta">${meta}</div>
      <div class="top-actions">
        ${soundMenuHTML()}
        ${showBell ? `<button class="icon-btn ${notifOn ? 'bell-on' : ''}" id="notif" title="${notifOn ? 'Notifications on (tap to turn off)' : 'Turn on notifications'}" aria-pressed="${notifOn}">${notifOn ? '🔔' : '🔕'}</button>` : ''}
        ${LOCAL ? '<span class="pill">Demo · runs in your browser</span>' : '<button class="btn ghost" id="invite">Invite</button>'}
        ${v.you !== null && !LOCAL ? `<button class="btn ghost" id="device" title="Open this game as you on another device">Other device</button>` : ''}
      </div>`;
    if ($('#invite')) $('#invite').onclick = () => copy(`${location.origin}/g/${id}`, 'Invite link copied');
    const dev = $('#device');
    if (dev) {
      dev.onclick = () => {
        if (confirm('This link signs in as YOU on another device (e.g. your phone). Don’t share it with anyone else. Copy it?')) {
          copy(`${location.origin}/g/${id}#t=${local.token(id)}&k=${local.playerKey()}`, 'Personal link copied');
        }
      };
    }
    const n = $('#notif');
    if (n) {
      n.onclick = () => (pushOn() ? disablePush() : enablePush());
    }
    const menu = $('#sound-menu');
    menu.ontoggle = () => (G.soundOpen = menu.open);
    const track = $('#music-track');
    if (track) track.onchange = () => setSoundPref('track', track.value);
    menu.addEventListener('toggle', () => menu.open && refreshTrackPicker());
    for (const box of menu.querySelectorAll('input[data-display]')) {
      box.onchange = () => setDisplayPref(box.dataset.display, box.checked);
    }
    for (const box of menu.querySelectorAll('input[data-pref]')) {
      box.onchange = () => {
        setSoundPref(box.dataset.pref, box.checked);
        if (box.dataset.pref === 'sfx' && box.checked) sfx.card();
        $('#sound-menu summary').textContent = soundPrefs().sfx || soundPrefs().music ? '🔊' : '🔇';
      };
    }
  }

  function sideLabel(v, side) {
    const names = v.players.filter((p) => p.side === side).map((p) => (p.seat === v.you ? 'You' : p.name));
    return names.join(' & ') || '—';
  }

  function renderScores(v) {
    const sides = v.scores.length;
    $('#scores').innerHTML = Array.from({ length: sides }, (_, s) => {
      const delta = v.scores[s] - v.prevScores[s];
      const mine = v.you !== null && v.players[v.you].side === s;
      return `<div class="score-chip ${mine ? 'mine' : ''} ${v.winner === s ? 'winner' : ''}" style="--c:${SIDE_COLORS[s]}">
        <span class="dot"></span><span class="sname">${esc(sideLabel(v, s))}</span>
        <span class="sval">${v.scores[s]}</span>${delta > 0 && v.status !== 'lobby' ? `<span class="sdelta">+${delta}</span>` : ''}</div>`;
    }).join('');
  }

  function renderBoard(v) {
    const el = $('#board');
    const sides = v.scores.length;
    const rows = boardRowsFor(el);
    if (G.boardSides !== sides || G.boardRows !== rows) {
      mountBoard(el, sides, rows);
      G.boardSides = sides;
      G.boardRows = rows;
      el.getBoundingClientRect(); // commit start positions before animating
    }
    updateBoard(el, v.scores, v.prevScores);
  }

  // --- join ----------------------------------------------------------------
  function renderJoin(v) {
    const full = v.players.length >= v.numPlayers;
    $('#topbar').innerHTML = brand;
    $('#scores').innerHTML = '';
    $('#board').innerHTML = '';
    G.boardSides = 0;
    $('#side').innerHTML = '';
    $('#side').classList.add('hidden');
    $('#table').innerHTML = `
      <form class="panel join" id="join">
        <div class="join-cards">${cardHTML('JH', { cls: 'tilt-l' })}${cardHTML('5S')}${cardHTML('5D', { cls: 'tilt-r' })}</div>
        <h1>You’re invited to ${isCribbage(v) ? 'cribbage' : gameName(v)}</h1>
        <p class="muted">${esc(v.players.map((p) => p.name).join(', '))} ${v.players.length === 1 ? 'is' : 'are'} waiting · ${v.players.length}/${v.numPlayers} players${v.type === 'holdem' ? ` · ${v.settings.startingStack.toLocaleString()} chips, blinds ${v.sb}/${v.bb}` : v.type === 'thirtyone' ? ` · ${v.settings.tokens} tokens each` : ''}</p>
        ${full ? '<p>This game is full.</p>' : `
        <label class="field"><span>Your name</span><input name="name" maxlength="20" required autocomplete="nickname" value="${esc(local.read().name)}" placeholder="e.g. Alex"></label>
        <button class="btn primary big" type="submit">Take a seat</button>`}
      </form>`;
    const f = $('#join');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const name = f.name.value.trim();
      try {
        const { token } = await api(`/games/${id}/join`, { method: 'POST', body: { name }, gameId: id });
        if (token) local.remember(id, token);
        local.write((d) => (d.name = name));
        $('#side').classList.remove('hidden');
        refresh(true);
      } catch (err) {
        toast(err.message);
      }
    };
  }

  // --- lobby ---------------------------------------------------------------
  function lobbyHTML(v) {
    const link = `${location.origin}/g/${id}`;
    const seats = Array.from({ length: v.numPlayers }, (_, i) => {
      const p = v.players[i];
      if (!isCribbage(v)) {
        return p
          ? `<li class="seat-row filled"><span class="avatar" style="--c:${seatColor(i)}">${esc(p.name[0].toUpperCase())}</span><b>${esc(p.name)}${p.bot ? ' 🤖' : ''}${p.seat === v.you ? ' <span class="muted">(you)</span>' : ''}</b>${i === 0 ? '<span class="team" style="--c:var(--gold)">Host</span>' : ''}</li>`
          : '<li class="seat-row"><span class="avatar empty">?</span><span class="muted">Open seat</span></li>';
      }
      const team = v.teams ? `<span class="team" style="--c:${SIDE_COLORS[i % 2]}">Team ${i % 2 ? 'B' : 'A'}</span>` : '';
      return p
        ? `<li class="seat-row filled"><span class="avatar" style="--c:${SIDE_COLORS[v.teams ? i % 2 : i]}">${esc(p.name[0].toUpperCase())}</span><b>${esc(p.name)}${p.bot ? ' 🤖' : ''}${p.seat === v.you ? ' <span class="muted">(you)</span>' : ''}</b>${team}</li>`
        : `<li class="seat-row"><span class="avatar empty">?</span><span class="muted">Open seat</span>${team}</li>`;
    }).join('');
    const holdem = !isCribbage(v); // Hold'em and Thirty-One: seat as many as you like, host starts
    const st = v.settings;
    return `
      <div class="panel lobby">
        <h2>${holdem ? `${gameName(v)} · ${v.players.length} of ${v.numPlayers} seated` : `Waiting for ${v.numPlayers - v.players.length} more player${v.numPlayers - v.players.length > 1 ? 's' : ''}`}</h2>
        <p class="muted">${v.type === 'thirtyone'
          ? `${st.tokens} tokens each. Send the link; ${v.you === 0 ? 'you can start' : 'the host can start'} once 2 or more are seated, or it starts when every seat fills.`
          : holdem
          ? `${st.startingStack.toLocaleString()} chips each · blinds ${st.smallBlind}/${st.bigBlind}${st.levelHands ? `, doubling every ${st.levelHands} hands` : ''} · ${st.actionSeconds}s to act. Send the link; ${v.you === 0 ? 'you can start' : 'the host can start'} once 2 or more are seated, or it starts when every seat fills.`
          : 'Send this link to your friends. The game starts automatically once every seat is taken.'}</p>
        <div class="invite-box"><input readonly value="${esc(link)}" id="invite-link"><button class="btn primary" id="copy-invite">Copy</button>
          ${navigator.share ? '<button class="btn ghost" id="share-invite">Share</button>' : ''}</div>
        <ul class="seats">${seats}</ul>
        <div class="lobby-actions">
          ${holdem ? '<button class="btn" id="add-bot">🤖 Add a bot</button>' : ''}
          <button class="btn" id="fill-bots">🤖 Fill empty seats with bots</button>
          ${holdem && v.you === 0 ? `<button class="btn primary" id="start-now" ${v.players.length < 2 ? 'disabled' : ''}>Start now with ${v.players.length}</button>` : ''}
        </div>
        ${v.teams ? '<p class="hint">Seats 1 &amp; 3 play Team A against seats 2 &amp; 4 (Team B), in join order.</p>' : ''}
      </div>`;
  }

  // --- table ---------------------------------------------------------------
  function statusText(v) {
    const name = (s) => (s === v.you ? 'you' : v.players[s].name);
    if (v.status === 'finished') return `${esc(sideLabel(v, v.winner))} won the game`;
    if (v.phase === 'discard') {
      const cribOwner = v.dealer === v.you ? 'your' : `${esc(v.players[v.dealer].name)}’s`;
      if (v.yourTurn) return `Choose ${v.discardCount === 1 ? 'a card' : '2 cards'} for ${cribOwner} crib`;
      const waiting = v.players.filter((p) => !p.discarded).map((p) => esc(p.name));
      return `Waiting for ${waiting.join(', ')} to discard`;
    }
    if (v.phase === 'show') return 'Counting the hands…';
    if (v.phase === 'pegging') {
      if (v.pegging.clearing) return v.pegging.count === 31 ? '<b>31!</b> Clearing the pile…' : 'Go. Clearing the pile…';
      if (v.players.every((p) => p.cardCount === 0)) return 'That’s every card. Counting the hands…';
      if (v.yourTurn) return `Your play. The count is <b>${v.pegging.count}</b>`;
      if (v.pegging.turn === v.you && !v.legal.length) return 'You can’t play. Go!';
      return `Waiting for ${esc(name(v.pegging.turn))} to play`;
    }
    return '';
  }

  // A big "GO" by a player who can't play. It pops in only the first time it appears.
  function goBadge(p) {
    const key = `${G.view.handNo}:${G.view.pegging?.history.length}:${p.seat}`;
    const fresh = !G.goShown.has(key);
    G.goShown.add(key);
    return `<span class="go-badge ${fresh ? 'pop' : ''}">GO</span>`;
  }

  function seatHTML(v, p) {
    const color = SIDE_COLORS[p.side];
    const team = v.teams ? `<span class="team" style="--c:${color}">${v.you !== null && p.side === v.players[v.you].side ? 'Partner' : 'Opponent'}</span>` : '';
    let note = '';
    if (v.status === 'playing') {
      if (v.phase === 'discard') note = p.discarded ? '✓ Ready' : 'Choosing…';
      else if (v.phase === 'pegging') note = p.isTurn ? 'Thinking…' : '';
    }
    const revealed = v.finalHands?.hands.find((h) => !h.crib && h.seat === p.seat);
    const backs = revealed
      ? sortCards(revealed.cards).map((c) => cardHTML(c, { cls: 'xs-face' })).join('')
      : Array.from({ length: p.cardCount }, () => backHTML('xs')).join('');
    return `<div class="seat ${p.isTurn ? 'turn' : ''}" data-seat="${p.seat}" style="--c:${color}">
      <div class="seat-head"><span class="avatar" style="--c:${color}">${esc(p.name[0].toUpperCase())}</span>
        <div class="seat-name"><b>${esc(p.name)}${p.bot ? ' <span class="bot-tag">BOT</span>' : ''}</b>${team}</div>
        ${p.saidGo && v.phase === 'pegging' ? goBadge(p) : ''}
        ${v.dealer === p.seat ? '<span class="dealer" title="Dealer">D</span>' : ''}</div>
      <div class="seat-cards">${backs || '<span class="muted small">No cards</span>'}</div>
      <div class="seat-note">${note}</div></div>`;
  }

  function tableHTML(v) {
    const p = v.pegging;
    const n = v.numPlayers;
    const order = v.you === null ? [...Array(n).keys()] : Array.from({ length: n - 1 }, (_, i) => (v.you + 1 + i) % n);
    const opponents = order.map((s) => seatHTML(v, v.players[s])).join('');

    // Pegging pile, plus earlier sequences of this hand (dimmed).
    let pile = '';
    let earlier = '';
    if (p) {
      const hist = p.history;
      const start = hist.length - p.pile.length;
      const prior = hist.slice(0, start);
      pile = hist.slice(start).map((h, i) => {
        const isNew = !G.lastAnimatedPile.includes(h.card);
        return `<div class="pile-card ${isNew ? 'enter' : ''}" style="--i:${i};--c:${SIDE_COLORS[v.players[h.seat].side]}">
          ${cardHTML(h.card)}${h.points ? `<span class="pts">+${h.points}</span>` : ''}</div>`;
      }).join('');
      G.lastAnimatedPile = hist.map((h) => h.card);
      if (prior.length) {
        earlier = `<div class="earlier"><span class="muted small">Earlier this hand</span><div>${prior
          .map((h) => `${miniCard(h.card, `style="--c:${SIDE_COLORS[v.players[h.seat].side]}"`)}${h.reset ? '<i class="sep"></i>' : ''}`)
          .join('')}</div></div>`;
      }
    } else {
      G.lastAnimatedPile = [];
    }

    const cribOwner = v.dealer === v.you ? 'Your crib' : `${esc(v.players[v.dealer].name)}’s crib`;
    const crib = Array.from({ length: v.cribCount }, (_, i) => backHTML('sm stackcard', `style="--i:${i}"`)).join('');

    const html = `
      <div class="opponents n${order.length}">${opponents}</div>
      <div class="felt">
        <div class="felt-row">
          <div class="slot">
            <div class="deck">${backHTML('md')}${v.starter ? cardHTML(v.starter, { cls: `md starter ${G.starterSeen !== v.starter ? 'animate' : ''}` }) : ''}</div>
            <span class="slot-label">${v.starter ? 'Starter' : 'Deck'}</span>
          </div>
          <div class="pile-zone">
            <div class="count ${p && p.count >= 25 ? 'hot' : ''}"><span>${p ? p.count : '—'}</span><small>count</small></div>
            <div class="pile">${pile || `<span class="muted small pile-empty">${v.phase === 'discard' ? 'Pegging starts once everyone has discarded' : 'Lead a card'}</span>`}</div>
          </div>
          <div class="slot">
            <div class="crib-stack">${crib || '<div class="card placeholder sm"></div>'}</div>
            <span class="slot-label">${cribOwner}</span>
          </div>
        </div>
        ${earlier}
      </div>
      <div class="status ${v.yourTurn ? 'your-turn' : ''}">${statusText(v)}</div>
      ${v.you !== null ? meHTML(v) : '<p class="muted center">You’re watching this game.</p>'}`;
    G.starterSeen = v.starter;
    G.dealtKey = `${v.handNo}`;
    return html;
  }

  function meHTML(v) {
    const me = v.players[v.you];
    if (v.finalHands) {
      const mine = v.finalHands.hands.find((h) => !h.crib && h.seat === v.you);
      if (mine) v = { ...v, hand: mine.cards };
    }
    const canDiscard = v.phase === 'discard' && v.yourTurn;
    const canPlay = v.phase === 'pegging' && v.yourTurn;
    const hand = sortCards(v.hand);
    const cards = hand.map((c, i) => {
      const sel = G.selected.includes(c);
      const illegal = canPlay && !v.legal.includes(c);
      const interactive = (canDiscard || (canPlay && !illegal)) && !G.busy;
      // During your play, hovering (or tapping) a card previews the count it would make.
      const after = canPlay ? v.pegging.count + cardValue(c) : 0;
      const peek = canPlay
        ? `<span class="peek ${illegal ? 'too-high' : ''}">${illegal ? 'Over 31' : `+${cardValue(c)} → <b>${after}</b>`}</span>`
        : '';
      return cardHTML(c, {
        cls: `hand-card ${sel ? 'selected' : ''} ${illegal ? 'illegal' : ''} ${interactive ? 'interactive' : ''}`,
        attrs: `style="--i:${i};--n:${hand.length}" ${interactive ? 'tabindex="0" role="button"' : ''}`,
        inner: peek,
      });
    }).join('');

    let action = '';
    if (canDiscard) {
      const k = v.discardCount;
      action = `<button class="btn primary big" id="do-discard" ${G.selected.length !== k || G.busy ? 'disabled' : ''}>
        ${G.selected.length === k ? `Send ${G.selected.map(cardText).join(' ')} to the crib` : `Select ${k - G.selected.length} more`}</button>`;
    } else if (canPlay) {
      action = `<button class="btn primary big" id="do-play" ${G.selected.length !== 1 || G.busy ? 'disabled' : ''}>
        ${G.selected.length === 1 ? `Play ${cardText(G.selected[0])}` : 'Tap a card to play'}</button>
        <small class="hint">Double-tap to play instantly</small>`;
    }
    const keptNote = v.phase === 'pegging' && v.kept ? `<div class="kept">Your hand for the show: ${miniCards(sortCards(v.kept))}</div>` : '';

    // Your hand's points: as you pick crib cards, then before and after the cut.
    let pts = '';
    const yp = v.yourPoints;
    if (yp?.keep && canDiscard) {
      const k = v.discardCount;
      pts = G.selected.length === k
        ? `<span class="pts-pill">Keeping these: <b>${yp.keep[[...G.selected].sort().join(',')]}</b> pts before the cut</span>`
        : `<span class="pts-pill quiet">Pick ${k === 1 ? 'a card' : `${k} cards`} to throw to see your points</span>`;
    } else if (yp && !yp.keep) {
      pts = yp.withStarter != null
        ? `<span class="pts-pill">Your hand: <b>${yp.withStarter}</b> pts</span>`
        : `<span class="pts-pill">Your hand: <b>${yp.hand}</b> pts + the cut</span>`;
    }

    return `<div class="me ${v.yourTurn ? 'turn' : ''}" style="--c:${SIDE_COLORS[me.side]}">
      <div class="me-head"><span class="avatar" style="--c:${SIDE_COLORS[me.side]}">${esc(me.name[0].toUpperCase())}</span><b>${esc(me.name)}</b>
        ${pts}${v.dealer === v.you ? '<span class="dealer">D</span>' : ''}${me.saidGo && v.phase === 'pegging' ? goBadge(me) : ''}</div>
      <div class="hand ${G.dealtKey !== `${v.handNo}` ? 'deal' : ''}">${cards || '<span class="muted">No cards in hand</span>'}</div>
      <div class="actions">${action}</div>
      ${keptNote}
    </div>`;
  }

  function bindTable(v) {
    const canDiscard = v.phase === 'discard' && v.yourTurn;
    const canPlay = v.phase === 'pegging' && v.yourTurn;
    for (const el of app.querySelectorAll('.hand-card.interactive')) {
      const c = el.dataset.card;
      const toggle = () => {
        if (canDiscard) {
          if (G.selected.includes(c)) G.selected = G.selected.filter((x) => x !== c);
          else {
            G.selected.push(c);
            if (G.selected.length > v.discardCount) G.selected.shift();
          }
        } else if (canPlay) {
          G.selected = G.selected[0] === c ? [] : [c];
        }
        render();
      };
      el.onclick = toggle;
      el.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      };
      if (canPlay) el.ondblclick = () => act('play', { card: c });
    }
    const d = $('#do-discard');
    if (d) d.onclick = () => act('discard', { cards: G.selected });
    const pl = $('#do-play');
    if (pl) pl.onclick = () => act('play', { card: G.selected[0] });
    const ci = $('#copy-invite');
    if (ci) ci.onclick = () => copy(`${location.origin}/g/${id}`, 'Invite link copied');
    const fb = $('#fill-bots');
    if (fb) fb.onclick = () => act('bots');
    const ab = $('#add-bot');
    if (ab) ab.onclick = () => act('bots', { count: 1 });
    const sn = $('#start-now');
    if (sn) sn.onclick = () => act('start');
    const si = $('#share-invite');
    if (si) si.onclick = () => navigator.share({ title: `Join my ${gameName(v)} game`, url: `${location.origin}/g/${id}` }).catch(() => {});

    for (const t of app.querySelectorAll('[data-tab]')) {
      t.onclick = () => {
        G.tab = t.dataset.tab;
        $('#side').innerHTML = sideHTML(v);
        bindTable(v);
      };
    }
  }

  // --- sidebar ---------------------------------------------------------------
  function sideHTML(v) {
    const tabs = `<div class="tabs"><button data-tab="activity" class="${G.tab === 'activity' ? 'on' : ''}">Activity</button>
      <button data-tab="last" class="${G.tab === 'last' ? 'on' : ''}" ${v.lastHand || v.lastRound ? '' : 'disabled'}>${v.type === 'thirtyone' ? 'Last round' : 'Last hand'}</button></div>`;
    if (G.tab === 'last' && (v.lastHand || v.lastRound)) {
      const body = v.type === 'holdem' ? holdemLastHandHTML(v) : v.type === 'thirtyone' ? thirtyOneLastHTML(v) : lastHandHTML(v);
      return tabs + `<div class="side-body">${body}</div>`;
    }
    let hand = null;
    const items = [...v.log].reverse().map((e) => {
      const sep = e.hand !== hand ? (hand = e.hand, `<li class="log-sep">${e.hand ? `Hand ${e.hand}` : 'Setup'}</li>`) : '';
      const color = e.seat != null && v.players[e.seat] ? SIDE_COLORS[v.players[e.seat].side] : 'transparent';
      return `${sep}<li class="log-item ${e.kind ? `k-${e.kind}` : ''}" style="--c:${color}"><span>${esc(e.text)}</span>${e.points ? `<b class="log-pts">+${e.points}</b>` : ''}</li>`;
    });
    return tabs + `<ul class="side-body log">${items.join('')}</ul>`;
  }

  const KIND_LABEL = { fifteen: 'Fifteen', pair: 'Pair', run: 'Run', flush: 'Flush', nobs: 'Nobs' };
  function itemLabel(i) {
    return `${KIND_LABEL[i.kind] || i.kind}${i.kind === 'run' ? ` of ${i.cards.length}` : ''}`;
  }

  // `counting` renders hands un-scored, ready for countThrough() to walk through them.
  function lastHandHTML(v, counting = false) {
    const L = v.lastHand;
    return `<div class="last ${counting ? 'counting' : ''}">
      <div class="last-head"><span>Hand ${L.handNo} · starter</span>${cardHTML(L.starter, { cls: 'xs-face' })}</div>
      ${L.shows.map((s, k) => {
        const p = v.players[s.seat];
        const who = s.crib ? `${s.seat === v.you ? 'Your' : `${esc(p.name)}’s`} crib` : s.seat === v.you ? 'Your hand' : esc(p.name);
        return `<div class="show" style="--c:${SIDE_COLORS[p.side]};--k:${k}" data-total="${s.total}">
          <div class="show-head"><b>${who}</b><span class="say" aria-live="polite"></span><span class="show-total">${counting ? '' : s.total}</span></div>
          <div class="show-cards">${sortCards(s.cards).map((c) => cardHTML(c, { cls: 'xs-face' })).join('')}<span class="plus">+</span>${cardHTML(L.starter, { cls: 'xs-face dim starter-card' })}</div>
          ${s.items.length
            ? `<ul class="items">${s.items.map((i) => {
              // Nobs scores because the jack matches the starter's suit, so light both.
              const lit = i.kind === 'nobs' ? [...i.cards, L.starter] : i.cards;
              return `<li tabindex="0" data-cards="${lit.join(',')}" data-points="${i.points}" data-label="${esc(itemLabel(i))}"><span>${itemLabel(i)}</span><span class="minis">${miniCards(sortCards(i.cards))}</span><b>${i.points}</b></li>`;
            }).join('')}</ul>`
            : '<p class="muted small nineteen">Nineteen. Nothing.</p>'}
        </div>`;
      }).join('')}
    </div>`;
  }

  // --- overlays --------------------------------------------------------------
  /** Everyone's cards at the end of a cribbage game, including hands the game ended before counting. */
  function finalHandsHTML(v, endedInShow) {
    const fh = v.finalHands;
    if (!fh) return '';
    const hands = fh.hands.filter((h) => !(endedInShow && h.counted)); // counted ones are in the walk-through above
    if (!hands.length) return '';
    const who = (h) => {
      const p = v.players[h.seat];
      if (h.crib) return `${h.seat === v.you ? 'Your' : `${esc(p.name)}’s`} crib`;
      return h.seat === v.you ? 'Your hand' : esc(p.name);
    };
    return `<h3 class="final-count">${endedInShow ? 'Not counted: the game ended first' : 'Everyone’s hands'}</h3>
      <div class="last final-hands">
        <div class="last-head"><span>Starter</span>${cardHTML(fh.starter, { cls: 'xs-face' })}</div>
        ${hands.map((h) => `<div class="show" style="--c:${SIDE_COLORS[v.players[h.seat].side]}">
          <div class="show-head"><b>${who(h)}</b><span class="would">would have counted <b>${h.points}</b></span></div>
          <div class="show-cards">${sortCards(h.cards).map((c) => cardHTML(c, { cls: 'xs-face' })).join('')}<span class="plus">+</span>${cardHTML(fh.starter, { cls: 'xs-face dim' })}</div>
        </div>`).join('')}
      </div>`;
  }

  async function rematch() {
    try {
      const { id: next } = await api(`/games/${id}/rematch`, { method: 'POST', gameId: id });
      local.remember(next, local.token(id));
      go(`/g/${next}`);
    } catch (err) {
      toast(err.message);
    }
  }

  // After the game-over screen is closed, this bar keeps the result and the way to a rematch on the table.
  function renderOverBar(v) {
    const el = $('#over-bar');
    if (v.status !== 'finished') {
      el.innerHTML = '';
      return;
    }
    const youWon = v.you !== null && (isCribbage(v) ? v.players[v.you].side === v.winner : v.winner === v.you);
    const who = isCribbage(v) ? `${esc(sideLabel(v, v.winner))} won` : `${esc(v.players[v.winner].name)} won`;
    el.innerHTML = `<div class="over-bar">
      <span class="ob-icon">🏆</span>
      <div class="ob-text"><b>${youWon ? 'You won!' : who}</b><span>Game over${v.nextGameId ? ' · a rematch is ready' : ''}</span></div>
      <button class="btn ghost" id="bar-results">Show results</button>
      ${v.you !== null ? `<button class="btn primary" id="bar-rematch">${v.nextGameId ? 'Go to rematch' : 'Rematch'}</button>` : ''}
    </div>`;
    $('#bar-results').onclick = () => {
      $('#overlay').dataset.state = '';
      renderOverlay(v);
    };
    if ($('#bar-rematch')) $('#bar-rematch').onclick = rematch;
  }

  function renderHoldemOverlay(v, ov) {
    if (v.status !== 'finished') {
      if (ov.dataset.state?.startsWith('over')) ov.innerHTML = '';
      if (ov.dataset.state !== 'ios-help') ov.dataset.state = '';
      return;
    }
    if (ov.dataset.state === 'over' || ov.dataset.state === 'over-closed') return;
    ov.dataset.state = 'over';
    const won = v.you === v.winner;
    ov.innerHTML = `<div class="modal-bg"><div class="modal panel over">
      <div class="trophy">${won ? '🏆' : v.type === 'thirtyone' ? '31' : '♠'}</div>
      <h2>${won ? (v.type === 'holdem' ? 'You won the tournament!' : 'You won!') : `${esc(v.players[v.winner].name)} wins`}</h2>
      <p class="muted">${v.type === 'holdem' ? `${v.handNo} hands · blinds reached ${v.sb.toLocaleString()}/${v.bb.toLocaleString()}` : `${v.handNo} rounds`}</p>
      ${v.type === 'holdem' ? holdemOverHTML(v) : thirtyOneOverHTML(v)}
      <div class="modal-actions">
        ${v.you !== null ? `<button class="btn primary big" id="rematch">${v.nextGameId ? 'Go to rematch' : 'Rematch'}</button>` : ''}
        <button class="btn ghost" id="close-ov">View table</button></div></div></div>`;
    $('#close-ov').onclick = () => {
      ov.innerHTML = '';
      ov.dataset.state = 'over-closed';
    };
    if ($('#rematch')) $('#rematch').onclick = rematch;
  }

  function renderOverlay(v) {
    const ov = $('#overlay');
    const seen = local.read().seenHands[id] || 0;
    if (!isCribbage(v)) return renderHoldemOverlay(v, ov);
    if (v.status === 'finished') {
      const won = v.you !== null && v.players[v.you].side === v.winner;
      const losers = v.scores.map((s, i) => [s, i]).filter(([, i]) => i !== v.winner);
      const worst = Math.min(...losers.map(([s]) => s));
      const skunk = worst < 61 ? 'Double skunk!' : worst < 91 ? 'Skunk!' : '';
      if (ov.dataset.state === 'over' || ov.dataset.state === 'over-closed') return;
      ov.dataset.state = 'over';
      // Pegging out while hands are being counted ends the game mid-count; show that count.
      const endedInShow = v.lastHand && v.lastHand.handNo === v.handNo;
      ov.innerHTML = `<div class="modal-bg"><div class="modal panel over">
        <div class="trophy">${won ? '🏆' : '♣'}</div>
        <h2>${won ? 'You won!' : `${esc(sideLabel(v, v.winner))} won`}</h2>
        ${skunk ? `<p class="skunk">${skunk}</p>` : ''}
        <div class="final">${v.scores.map((s, i) => `<div style="--c:${SIDE_COLORS[i]}"><span>${esc(sideLabel(v, i))}</span><b>${s}</b></div>`).join('')}</div>
        ${endedInShow ? `<h3 class="final-count">How the last hand was counted</h3>${lastHandHTML(v, true)}` : ''}
        ${finalHandsHTML(v, endedInShow)}
        <div class="modal-actions">
          ${v.you !== null ? `<button class="btn primary big" id="rematch">${v.nextGameId ? 'Go to rematch' : 'Rematch'}</button>` : ''}
          <button class="btn ghost" id="close-ov">View table</button></div></div></div>`;
      const finalCount = endedInShow ? countThrough($('.last', ov)) : null;
      $('#close-ov').onclick = () => {
        finalCount?.stop();
        ov.innerHTML = '';
        ov.dataset.state = 'over-closed';
      };
      if ($('#rematch')) $('#rematch').onclick = rematch;
      return;
    }
    if (v.lastHand && v.lastHand.handNo > seen && v.status === 'playing') {
      if (ov.dataset.state === `hand-${v.lastHand.handNo}`) return;
      ov.dataset.state = `hand-${v.lastHand.handNo}`;
      ov.innerHTML = `<div class="modal-bg"><div class="modal panel">
        <h2>Hand ${v.lastHand.handNo} results</h2>
        ${lastHandHTML(v, true)}
        <div class="modal-actions">
          <button class="btn ghost" id="skip-count">Skip counting</button>
          <button class="btn primary big" id="close-ov">On to hand ${v.lastHand.handNo + 1}</button></div></div></div>`;
      const counter = countThrough($('.last', ov), () => $('#skip-count')?.remove());
      $('#skip-count').onclick = () => counter.finish();
      $('#close-ov').onclick = () => {
        counter.stop();
        local.write((d) => (d.seenHands[id] = v.lastHand.handNo));
        ov.innerHTML = '';
      };
      return;
    }
    if (ov.dataset.state?.startsWith('hand-') || ov.dataset.state === 'ios-help') return; // keep open until dismissed
    ov.innerHTML = '';
    ov.dataset.state = '';
  }

  // --- live updates ----------------------------------------------------------
  let es;
  function connect() {
    if (LOCAL) {
      const unsub = LOCAL.subscribe(id, () => refresh());
      es = { close: unsub };
      return;
    }
    es = new EventSource(`/api/games/${id}/events`);
    es.addEventListener('update', (e) => {
      const { version } = JSON.parse(e.data);
      if (!G.view || version !== G.view.version) refresh();
    });
  }
  connect();
  refresh();
  const poll = setInterval(refresh, 30_000); // safety net if the event stream drops silently
  const timerTick = setInterval(() => tickTimers(G.view, G.clockOffset), 250);
  const onVis = () => !document.hidden && refresh();
  document.addEventListener('visibilitychange', onVis);
  const onResize = () => G.view && isCribbage(G.view) && G.view.status !== 'lobby' && G.view.you !== null && renderBoard(G.view);
  window.addEventListener('resize', onResize);

  return () => {
    G.alive = false;
    clearInterval(timerTick);
    es?.close();
    clearInterval(poll);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onResize);
    $('#side')?.classList.remove('hidden');
  };
}

if (!LOCAL) registerServiceWorker();
// Uploaded songs for background music (public/music). The demo build lists them in window.CRIB_MUSIC.
(LOCAL ? Promise.resolve({ tracks: window.CRIB_MUSIC || [] }) : api('/music'))
  .then((d) => setMusicTracks(d.tracks || []))
  .catch(() => setMusicTracks([]))
  .finally(refreshTrackPicker); // the menu may have been drawn before the list arrived
route();
