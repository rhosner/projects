import {
  SIDE_COLORS, esc, cardHTML, backHTML, miniCards, cardText, sortCards, timeAgo, mountBoard, updateBoard, boardRowsFor,
} from './ui.js';
import {
  pushAvailability, ensureSubscription, currentSubscription, registerServiceWorker, isStandalone,
} from './push-client.js';

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
};

// A link that carries every seat this browser holds, for moving to another device
// (or into an iPhone Home Screen app, which doesn't share storage with Safari).
function allGamesLink() {
  const d = local.read();
  const games = Object.fromEntries(Object.entries(d.games).map(([id, g]) => [id, g.token]));
  const bytes = new TextEncoder().encode(JSON.stringify({ n: d.name, g: games }));
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
  if (single && hash.get('t')) {
    local.remember(single[1], hash.get('t'));
    return 1;
  }
  if (hash.get('i')) {
    try {
      const raw = atob(hash.get('i').replace(/-/g, '+').replace(/_/g, '/'));
      const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
      const entries = Object.entries(data.g || {}).filter(([id, t]) => /^[a-z0-9]+$/.test(id) && typeof t === 'string');
      for (const [id, token] of entries) local.remember(id, token);
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
async function api(path, { method = 'GET', body, gameId } = {}) {
  const headers = { 'Content-Type': 'application/json' };
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
let teardown = () => {};
function route() {
  teardown();
  teardown = () => {};
  document.title = 'Cribbage';
  const m = location.pathname.match(/^\/g\/([a-z0-9]+)/);
  if (m) {
    // Device links carry the token in the hash so it never hits server logs.
    const t = new URLSearchParams(location.hash.slice(1)).get('t');
    if (t) {
      local.remember(m[1], t);
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
  history.pushState(null, '', path);
  registerServiceWorker();
route();
}
window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    go(a.getAttribute('href'));
  }
});

const brand = `<a href="/" data-link class="brand"><span class="brand-mark">♣</span><span>Cribbage</span></a>`;

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function renderHome() {
  const data = local.read();
  let players = 2;
  app.innerHTML = `
    <div class="home">
      <header class="topbar">${brand}</header>
      <section class="hero">
        <h1>Cribbage with your friends,<br><span class="grad">on your own time.</span></h1>
        <p>Every game saves itself. Make your play, close the tab, and come back when it's your turn again.</p>
      </section>
      <div class="home-grid">
        <form class="panel create" id="create">
          <h2>New game</h2>
          <label class="field"><span>Your name</span>
            <input name="name" maxlength="20" autocomplete="nickname" placeholder="e.g. Sam" value="${esc(data.name)}" required></label>
          <div class="field"><span>Players</span>
            <div class="seg" role="radiogroup">
              ${[2, 3, 4].map((n) => `<button type="button" role="radio" data-n="${n}" aria-checked="${n === 2}">${n}</button>`).join('')}
            </div>
            <small class="hint" id="players-hint">Classic head-to-head. 6 cards each, 2 to the crib.</small>
          </div>
          <button class="btn primary big" type="submit">Create game &amp; get invite link</button>
        </form>
        <section class="panel games">
          <h2>Your games</h2>
          <div id="game-list" class="game-list"><p class="muted">Loading…</p></div>
          <details class="transfer" ${isStandalone() && !Object.keys(data.games).length ? 'open' : ''}>
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
    4: 'Two teams of two; partners sit opposite. 5 cards each, 1 to the crib.',
  };
  for (const b of app.querySelectorAll('.seg button')) {
    b.onclick = () => {
      players = Number(b.dataset.n);
      app.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-checked', x === b));
      $('#players-hint').textContent = hints[players];
    };
  }
  $('#create').onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { id, token } = await api('/games', { method: 'POST', body: { name, numPlayers: players } });
      local.remember(id, token);
      local.write((d) => (d.name = name));
      go(`/g/${id}`);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  };
  $('#copy-all').onclick = () => copy(allGamesLink(), 'Link to all your games copied');
  $('#paste-link').onsubmit = (e) => {
    e.preventDefault();
    const n = importLink(e.target.link.value);
    if (!n) return toast("That doesn't look like a Cribbage personal link.");
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
      if (confirm('Remove this game from your list? (It stays on the server; you can rejoin with your device link.)')) {
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
  const others = v.players.filter((p) => p.seat !== v.you).map((p) => p.name);
  const title = others.length ? `vs ${others.join(', ')}` : 'Waiting for players';
  let status;
  if (v.status === 'lobby') status = `<span class="pill">Lobby · ${v.players.length}/${v.numPlayers}</span>`;
  else if (v.status === 'finished') {
    const won = v.you !== null && v.players[v.you].side === v.winner;
    status = `<span class="pill ${won ? 'win' : ''}">${won ? 'You won' : 'Finished'}</span>`;
  } else if (v.yourTurn) status = `<span class="pill turn">Your turn</span>`;
  else {
    const waiting = v.players.filter((p) => p.isTurn).map((p) => p.name);
    status = `<span class="pill">Waiting on ${esc(waiting.join(', '))}</span>`;
  }
  const scores = v.status === 'lobby' ? '' : `<span class="row-scores">${v.scores
    .map((s, i) => `<span style="--c:${SIDE_COLORS[i]}">${s}</span>`)
    .join('<i>·</i>')}</span>`;
  return `<a class="game-row ${v.yourTurn ? 'is-turn' : ''}" href="/g/${v.id}" data-link>
    <div><b>${esc(title)}</b><small>${v.numPlayers}-player · updated ${timeAgo(v.updatedAt)}</small></div>
    <div class="row-right">${scores}${status}<button class="icon-btn" data-forget="${v.id}" title="Remove from list">✕</button></div></a>`;
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
    boardSides: 0,
    alive: true,
  };

  app.innerHTML = `
    <div class="game">
      <header class="topbar" id="topbar">${brand}</header>
      <main class="layout">
        <section class="main-col">
          <div id="push-banner"></div>
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
    notifyIfTurn(v);
    render();
  }

  function notifyIfTurn(v) {
    document.title = v.yourTurn ? '● Your turn · Cribbage' : 'Cribbage';
    if (v.you !== null && !G.pushSynced) {
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
        <li>Open <b>Cribbage</b> from your Home Screen, paste the link under “Move your games”, open this game and tap <b>🔔</b>.</li>
      </ol>
      <div class="modal-actions"><button class="btn primary" id="ios-done">Got it</button></div></div></div>`;
    $('#ios-copy').onclick = () => copy(allGamesLink(), 'Copied. Now add Cribbage to your Home Screen.');
    $('#ios-done').onclick = () => {
      ov.innerHTML = '';
      ov.dataset.state = '';
    };
  }

  function renderPushBanner(v) {
    const el = $('#push-banner');
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
        ? 'On iPhone, notifications need Cribbage on your Home Screen.'
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
    renderScores(v);
    renderBoard(v);
    $('#table').innerHTML = v.status === 'lobby' ? lobbyHTML(v) : tableHTML(v);
    $('#side').innerHTML = sideHTML(v);
    bindTable(v);
    renderOverlay(v);
  }

  function renderTopbar(v) {
    const notifOn = pushOn();
    const avail = pushAvailability();
    const showBell = v.you !== null && (avail === 'ready' || avail === 'ios-install');
    const meta = v.status === 'lobby' ? 'Lobby' : `Hand ${v.handNo} · ${esc(v.players[v.dealer].name)} deals`;
    $('#topbar').innerHTML = `${brand}
      <div class="top-meta">${meta}</div>
      <div class="top-actions">
        ${showBell ? `<button class="icon-btn ${notifOn ? 'bell-on' : ''}" id="notif" title="${notifOn ? 'Notifications on (tap to turn off)' : 'Turn on notifications'}" aria-pressed="${notifOn}">${notifOn ? '🔔' : '🔕'}</button>` : ''}
        <button class="btn ghost" id="invite">Invite</button>
        ${v.you !== null ? `<button class="btn ghost" id="device" title="Open this game as you on another device">Other device</button>` : ''}
      </div>`;
    $('#invite').onclick = () => copy(`${location.origin}/g/${id}`, 'Invite link copied');
    const dev = $('#device');
    if (dev) {
      dev.onclick = () => {
        if (confirm('This link signs in as YOU on another device (e.g. your phone). Don’t share it with anyone else. Copy it?')) {
          copy(`${location.origin}/g/${id}#t=${local.token(id)}`, 'Personal link copied');
        }
      };
    }
    const n = $('#notif');
    if (n) {
      n.onclick = () => (pushOn() ? disablePush() : enablePush());
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
        <h1>You’re invited to cribbage</h1>
        <p class="muted">${esc(v.players.map((p) => p.name).join(', '))} ${v.players.length === 1 ? 'is' : 'are'} waiting · ${v.players.length}/${v.numPlayers} players</p>
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
      const team = v.numPlayers === 4 ? `<span class="team" style="--c:${SIDE_COLORS[i % 2]}">Team ${i % 2 ? 'B' : 'A'}</span>` : '';
      return p
        ? `<li class="seat-row filled"><span class="avatar" style="--c:${SIDE_COLORS[v.numPlayers === 4 ? i % 2 : i]}">${esc(p.name[0].toUpperCase())}</span><b>${esc(p.name)}${p.seat === v.you ? ' <span class="muted">(you)</span>' : ''}</b>${team}</li>`
        : `<li class="seat-row"><span class="avatar empty">?</span><span class="muted">Open seat</span>${team}</li>`;
    }).join('');
    return `
      <div class="panel lobby">
        <h2>Waiting for ${v.numPlayers - v.players.length} more player${v.numPlayers - v.players.length > 1 ? 's' : ''}</h2>
        <p class="muted">Send this link to your friends. The game starts automatically once every seat is taken.</p>
        <div class="invite-box"><input readonly value="${esc(link)}" id="invite-link"><button class="btn primary" id="copy-invite">Copy</button>
          ${navigator.share ? '<button class="btn ghost" id="share-invite">Share</button>' : ''}</div>
        <ul class="seats">${seats}</ul>
        ${v.numPlayers === 4 ? '<p class="hint">Seats 1 &amp; 3 play Team A against seats 2 &amp; 4 (Team B), in join order.</p>' : ''}
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
    if (v.phase === 'pegging') {
      if (v.yourTurn) return `Your play. The count is <b>${v.pegging.count}</b>`;
      return `Waiting for ${esc(name(v.pegging.turn))} to play`;
    }
    return '';
  }

  function seatHTML(v, p) {
    const color = SIDE_COLORS[p.side];
    const team = v.numPlayers === 4 ? `<span class="team" style="--c:${color}">${v.you !== null && p.side === v.players[v.you].side ? 'Partner' : 'Opponent'}</span>` : '';
    let note = '';
    if (v.status === 'playing') {
      if (v.phase === 'discard') note = p.discarded ? '✓ Ready' : 'Choosing…';
      else if (v.phase === 'pegging') note = p.isTurn ? 'Thinking…' : p.saidGo ? 'Go' : '';
    }
    const backs = Array.from({ length: p.cardCount }, () => backHTML('xs')).join('');
    return `<div class="seat ${p.isTurn ? 'turn' : ''}" style="--c:${color}">
      <div class="seat-head"><span class="avatar" style="--c:${color}">${esc(p.name[0].toUpperCase())}</span>
        <div class="seat-name"><b>${esc(p.name)}</b>${team}</div>
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
          .map((h) => `<span class="mini ${'HD'.includes(h.card[1]) ? 'red' : ''}" style="--c:${SIDE_COLORS[v.players[h.seat].side]}">${esc(cardText(h.card))}</span>${h.reset ? '<i class="sep"></i>' : ''}`)
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
    const canDiscard = v.phase === 'discard' && v.yourTurn;
    const canPlay = v.phase === 'pegging' && v.yourTurn;
    const hand = sortCards(v.hand);
    const cards = hand.map((c, i) => {
      const sel = G.selected.includes(c);
      const illegal = canPlay && !v.legal.includes(c);
      const interactive = (canDiscard || (canPlay && !illegal)) && !G.busy;
      return cardHTML(c, {
        cls: `hand-card ${sel ? 'selected' : ''} ${illegal ? 'illegal' : ''} ${interactive ? 'interactive' : ''}`,
        attrs: `style="--i:${i};--n:${hand.length}" ${interactive ? 'tabindex="0" role="button"' : ''}`,
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

    return `<div class="me ${v.yourTurn ? 'turn' : ''}" style="--c:${SIDE_COLORS[me.side]}">
      <div class="me-head"><span class="avatar" style="--c:${SIDE_COLORS[me.side]}">${esc(me.name[0].toUpperCase())}</span><b>${esc(me.name)}</b>
        ${v.dealer === v.you ? '<span class="dealer">D</span>' : ''}${me.saidGo && v.phase === 'pegging' ? '<span class="pill">Go</span>' : ''}</div>
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
    const si = $('#share-invite');
    if (si) si.onclick = () => navigator.share({ title: 'Join my cribbage game', url: `${location.origin}/g/${id}` }).catch(() => {});

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
      <button data-tab="last" class="${G.tab === 'last' ? 'on' : ''}" ${v.lastHand ? '' : 'disabled'}>Last hand</button></div>`;
    if (G.tab === 'last' && v.lastHand) return tabs + `<div class="side-body">${lastHandHTML(v)}</div>`;
    let hand = null;
    const items = [...v.log].reverse().map((e) => {
      const sep = e.hand !== hand ? (hand = e.hand, `<li class="log-sep">${e.hand ? `Hand ${e.hand}` : 'Setup'}</li>`) : '';
      const color = e.seat != null && v.players[e.seat] ? SIDE_COLORS[v.players[e.seat].side] : 'transparent';
      return `${sep}<li class="log-item ${e.kind ? `k-${e.kind}` : ''}" style="--c:${color}"><span>${esc(e.text)}</span>${e.points ? `<b class="log-pts">+${e.points}</b>` : ''}</li>`;
    });
    return tabs + `<ul class="side-body log">${items.join('')}</ul>`;
  }

  const KIND_LABEL = { fifteen: 'Fifteen', pair: 'Pair', run: 'Run', flush: 'Flush', nobs: 'Nobs' };
  function lastHandHTML(v) {
    const L = v.lastHand;
    return `<div class="last">
      <div class="last-head"><span>Hand ${L.handNo} · starter</span>${cardHTML(L.starter, { cls: 'xs-face' })}</div>
      ${L.shows.map((s) => {
        const p = v.players[s.seat];
        const who = s.crib ? `${s.seat === v.you ? 'Your' : `${esc(p.name)}’s`} crib` : s.seat === v.you ? 'Your hand' : esc(p.name);
        return `<div class="show" style="--c:${SIDE_COLORS[p.side]}">
          <div class="show-head"><b>${who}</b><span class="show-total">${s.total}</span></div>
          <div class="show-cards">${sortCards(s.cards).map((c) => cardHTML(c, { cls: 'xs-face' })).join('')}<span class="plus">+</span>${cardHTML(L.starter, { cls: 'xs-face dim' })}</div>
          ${s.items.length ? `<ul class="items">${s.items.map((i) => `<li><span>${KIND_LABEL[i.kind] || i.kind}${i.kind === 'run' ? ` of ${i.cards.length}` : ''}</span><span class="minis">${miniCards(sortCards(i.cards))}</span><b>${i.points}</b></li>`).join('')}</ul>` : '<p class="muted small">Nineteen. Nothing.</p>'}
        </div>`;
      }).join('')}
    </div>`;
  }

  // --- overlays --------------------------------------------------------------
  function renderOverlay(v) {
    const ov = $('#overlay');
    const seen = local.read().seenHands[id] || 0;
    if (v.status === 'finished') {
      const won = v.you !== null && v.players[v.you].side === v.winner;
      const losers = v.scores.map((s, i) => [s, i]).filter(([, i]) => i !== v.winner);
      const worst = Math.min(...losers.map(([s]) => s));
      const skunk = worst < 61 ? 'Double skunk!' : worst < 91 ? 'Skunk!' : '';
      if (ov.dataset.state === `over-${v.version}`) return;
      ov.dataset.state = `over-${v.version}`;
      ov.innerHTML = `<div class="modal-bg"><div class="modal panel over">
        <div class="trophy">${won ? '🏆' : '♣'}</div>
        <h2>${won ? 'You won!' : `${esc(sideLabel(v, v.winner))} won`}</h2>
        ${skunk ? `<p class="skunk">${skunk}</p>` : ''}
        <div class="final">${v.scores.map((s, i) => `<div style="--c:${SIDE_COLORS[i]}"><span>${esc(sideLabel(v, i))}</span><b>${s}</b></div>`).join('')}</div>
        <div class="modal-actions">
          ${v.you !== null ? `<button class="btn primary big" id="rematch">${v.nextGameId ? 'Go to rematch' : 'Rematch'}</button>` : ''}
          <button class="btn ghost" id="close-ov">View table</button></div></div></div>`;
      $('#close-ov').onclick = () => (ov.innerHTML = '');
      const r = $('#rematch');
      if (r) {
        r.onclick = async () => {
          try {
            const { id: next } = await api(`/games/${id}/rematch`, { method: 'POST', gameId: id });
            local.remember(next, local.token(id));
            go(`/g/${next}`);
          } catch (err) {
            toast(err.message);
          }
        };
      }
      return;
    }
    if (v.lastHand && v.lastHand.handNo > seen && v.status === 'playing') {
      if (ov.dataset.state === `hand-${v.lastHand.handNo}`) return;
      ov.dataset.state = `hand-${v.lastHand.handNo}`;
      ov.innerHTML = `<div class="modal-bg"><div class="modal panel">
        <h2>Hand ${v.lastHand.handNo} results</h2>
        ${lastHandHTML(v)}
        <div class="modal-actions"><button class="btn primary big" id="close-ov">On to hand ${v.handNo}</button></div></div></div>`;
      $('#close-ov').onclick = () => {
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
    es = new EventSource(`/api/games/${id}/events`);
    es.addEventListener('update', (e) => {
      const { version } = JSON.parse(e.data);
      if (!G.view || version !== G.view.version) refresh();
    });
  }
  connect();
  refresh();
  const poll = setInterval(refresh, 30_000); // safety net if the event stream drops silently
  const onVis = () => !document.hidden && refresh();
  document.addEventListener('visibilitychange', onVis);
  const onResize = () => G.view && G.view.status !== 'lobby' && G.view.you !== null && renderBoard(G.view);
  window.addEventListener('resize', onResize);

  return () => {
    G.alive = false;
    es?.close();
    clearInterval(poll);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onResize);
    $('#side')?.classList.remove('hidden');
  };
}

route();
