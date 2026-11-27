// Texas Hold'em table: rendering and controls. The shared game screen in app.js
// calls these when a game's type is 'holdem'.
import { SIDE_COLORS, esc, cardHTML, backHTML, cardText } from './ui.js';

const PALETTE = ['#f5b041', '#3dd6d0', '#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fb923c', '#e879f9', '#a3e635'];
export const seatColor = (seat) => PALETTE[seat % PALETTE.length];
const money = (n) => Number(n || 0).toLocaleString('en-US');

// Standard casino chip colours by denomination.
const CHIPS = [[5000, '#f97316'], [1000, '#facc15'], [500, '#a855f7'], [100, '#1f2937'], [25, '#16a34a'], [5, '#dc2626'], [1, '#f3f4f6']];
export function chipHTML(amount, cls = '') {
  const color = (CHIPS.find(([d]) => amount >= d) ?? CHIPS.at(-1))[1];
  return `<span class="chip ${cls}" style="--chip:${color}" aria-hidden="true"></span>`;
}
export const chips = (amount) => `<span class="chips">${chipHTML(amount)}${money(amount)}</span>`;

export function holdemStatus(v) {
  if (v.status === 'finished') return `${esc(v.players[v.winner].name)} wins the tournament`;
  if (v.phase === 'handover') {
    const lh = v.lastHand;
    const winners = lh?.results.filter((r) => r.won > 0) ?? [];
    return winners.map((r) => `${esc(r.seat === v.you ? 'You' : v.players[r.seat].name)} won ${money(r.won)}${r.best ? ` · ${esc(r.best)}` : ''}`).join(' · ') || 'Next hand…';
  }
  if (v.toAct == null) return v.street === 'river' ? 'Showdown…' : 'Dealing…';
  if (v.yourTurn) return v.options.canCheck ? 'Your turn. Check or bet.' : `Your turn. <b>${money(v.options.toCall)}</b> to call.`;
  return `Waiting for ${esc(v.players[v.toAct].name)}`;
}

function seatHTML(v, p) {
  const c = seatColor(p.seat);
  const tags = [];
  if (v.button === p.seat) tags.push('<span class="dealer" title="Dealer button">D</span>');
  if (p.sb) tags.push('<span class="blind-tag">SB</span>');
  if (p.bb) tags.push('<span class="blind-tag">BB</span>');
  let status = '';
  if (p.out) status = `<span class="pk-status">Out · ${ordinal(p.place)}</span>`;
  else if (p.folded) status = '<span class="pk-status">Folded</span>';
  else if (p.allIn) status = '<span class="pk-status hot">All in</span>';
  else if (p.away) status = '<span class="pk-status">Away</span>';
  const shown = p.cards ? p.cards.map((card) => cardHTML(card, { cls: 'sm' })).join('') : '';
  const backs = !shown && p.hasCards ? backHTML('xs') + backHTML('xs') : '';
  const result = v.phase === 'handover' && v.lastHand?.results.find((r) => r.seat === p.seat);
  return `<div class="seat pk-seat ${p.isTurn ? 'turn' : ''} ${p.folded || p.out ? 'dim' : ''} ${result?.won ? 'winner' : ''}" data-seat="${p.seat}" style="--c:${c}">
    <div class="seat-head"><span class="avatar" style="--c:${c}">${esc(p.name[0].toUpperCase())}</span>
      <div class="seat-name"><b>${esc(p.name)}${p.bot ? ' <span class="bot-tag">BOT</span>' : ''}</b>${chips(p.stack)}</div>
      <div class="pk-tags">${tags.join('')}</div></div>
    <div class="pk-cards">${shown || backs || ''}${status}</div>
    ${result?.best ? `<div class="pk-best">${esc(result.best)}${result.won ? ` · <b>+${money(result.won)}</b>` : ''}</div>` : ''}
    ${p.bet ? `<div class="pk-bet">${chipHTML(p.bet)}${money(p.bet)}</div>` : ''}
    ${p.isTurn && v.deadline ? '<div class="timer"><i class="timer-bar"></i></div>' : ''}
  </div>`;
}

export function holdemTableHTML(v, G) {
  const others = v.players.filter((p) => p.seat !== v.you);
  const board = Array.from({ length: 5 }, (_, i) => {
    const c = v.board[i];
    if (!c) return '<div class="card placeholder md"></div>';
    const fresh = !G.seenBoard.has(`${v.handNo}:${c}`);
    G.seenBoard.add(`${v.handNo}:${c}`);
    return cardHTML(c, { cls: `md ${fresh ? 'flip-in' : ''}` });
  }).join('');
  const lh = v.phase === 'handover' ? v.lastHand : null;
  const potText = lh ? lh.pots.reduce((a, p) => a + p.amount, 0) : v.pot;
  return `
    <div class="opponents pk-opponents">${others.map((p) => seatHTML(v, p)).join('')}</div>
    <div class="felt pk-felt">
      <div class="pk-center">
        <div class="pk-board">${board}</div>
        <div class="pk-pot"><span>${lh ? 'Pot' : 'Pot'}</span><b>${chipHTML(potText, 'lg')}${money(potText)}</b>
          <small>Blinds ${money(v.sb)}/${money(v.bb)} · hand ${v.handNo}${v.settings.levelHands ? ` · up every ${v.settings.levelHands}` : ''}</small></div>
      </div>
    </div>
    <div class="status ${v.yourTurn ? 'your-turn' : ''}">${holdemStatus(v)}</div>
    ${v.you !== null ? meHTML(v, G) : '<p class="muted center">You’re watching this game.</p>'}`;
}

function meHTML(v, G) {
  const me = v.players[v.you];
  const c = seatColor(v.you);
  const o = v.options;
  const holeFresh = G.dealtHand !== v.handNo;
  G.dealtHand = v.handNo;
  const hole = v.hand.length
    ? v.hand.map((card, i) => cardHTML(card, { cls: `hand-card pk-hole ${holeFresh ? 'deal-in' : ''}`, attrs: `style="--i:${i};--n:2"` })).join('')
    : `<span class="muted">${me.out ? `You finished ${ordinal(me.place)}` : 'Waiting for the next hand'}</span>`;
  let actions = '';
  if (o) {
    const pot = v.pot;
    const raiseTo = clamp(G.raiseTo ?? o.minRaiseTo, o.minRaiseTo, o.maxRaiseTo);
    G.raiseTo = raiseTo;
    const verb = o.currentBet === 0 ? 'Bet' : 'Raise to';
    const presets = [
      ['Min', o.minRaiseTo],
      ['½ pot', o.currentBet + Math.round((pot + o.toCall) / 2)],
      ['Pot', o.currentBet + pot + o.toCall],
      ['All in', o.maxRaiseTo],
    ].map(([label, amt]) => [label, clamp(amt, o.minRaiseTo, o.maxRaiseTo)]);
    actions = `
      <div class="pk-actions">
        <button class="btn danger-ghost big" data-pk="fold">Fold</button>
        ${o.canCheck
          ? '<button class="btn big" data-pk="check">Check</button>'
          : `<button class="btn big" data-pk="call">${o.toCall >= me.stack ? 'All in' : 'Call'} ${money(o.toCall)}</button>`}
        ${o.canRaise ? `<button class="btn primary big" data-pk="raise" id="pk-raise-btn">${raiseTo >= o.maxRaiseTo ? 'All in' : verb} ${money(raiseTo)}</button>` : ''}
      </div>
      ${o.canRaise && o.maxRaiseTo > o.minRaiseTo ? `
      <div class="pk-raise">
        <div class="pk-presets">${presets.map(([l, a]) => `<button class="pill-btn" data-amt="${a}">${l}</button>`).join('')}</div>
        <input type="range" id="pk-slider" min="${o.minRaiseTo}" max="${o.maxRaiseTo}" step="${Math.max(1, Math.floor(v.bb / 2))}" value="${raiseTo}" aria-label="Raise amount">
        <input type="number" id="pk-amount" min="${o.minRaiseTo}" max="${o.maxRaiseTo}" value="${raiseTo}" inputmode="numeric" aria-label="Raise to">
      </div>` : ''}
      ${v.deadline ? '<div class="timer mine"><i class="timer-bar"></i></div>' : ''}`;
  }
  return `<div class="me pk-me ${v.yourTurn ? 'turn' : ''}" style="--c:${c}">
    <div class="me-head"><span class="avatar" style="--c:${c}">${esc(me.name[0].toUpperCase())}</span><b>${esc(me.name)}</b>${chips(me.stack)}
      <div class="pk-tags">${v.button === v.you ? '<span class="dealer">D</span>' : ''}${me.sb ? '<span class="blind-tag">SB</span>' : ''}${me.bb ? '<span class="blind-tag">BB</span>' : ''}
      ${me.bet ? `<span class="pk-bet inline">${chipHTML(me.bet)}${money(me.bet)}</span>` : ''}${me.allIn ? '<span class="pk-status hot">All in</span>' : ''}${me.folded ? '<span class="pk-status">Folded</span>' : ''}</div></div>
    <div class="hand pk-hand">${hole}</div>
    ${actions}
  </div>`;
}

export function bindHoldem(v, G, act) {
  const o = v.options;
  if (!o) return;
  for (const b of document.querySelectorAll('[data-pk]')) {
    b.onclick = () => {
      const type = b.dataset.pk;
      act('act', { action: type === 'raise' ? { type, amount: G.raiseTo } : { type } });
      G.raiseTo = null;
    };
  }
  const slider = document.getElementById('pk-slider');
  const num = document.getElementById('pk-amount');
  const btn = document.getElementById('pk-raise-btn');
  const set = (val) => {
    G.raiseTo = clamp(Math.round(Number(val) || o.minRaiseTo), o.minRaiseTo, o.maxRaiseTo);
    if (slider) slider.value = G.raiseTo;
    if (num && document.activeElement !== num) num.value = G.raiseTo;
    if (btn) btn.textContent = `${G.raiseTo >= o.maxRaiseTo ? 'All in' : o.currentBet === 0 ? 'Bet' : 'Raise to'} ${money(G.raiseTo)}`;
  };
  if (slider) slider.oninput = () => set(slider.value);
  if (num) {
    num.oninput = () => set(num.value);
    num.onblur = () => (num.value = G.raiseTo);
  }
  for (const p of document.querySelectorAll('[data-amt]')) p.onclick = () => set(p.dataset.amt);
}

/** Keep each visible decision timer bar in sync with the server's deadline. */
export function tickTimers(v, clockOffset) {
  if (!v?.deadline) return;
  const total = (v.settings.actionSeconds || 60) * 1000;
  const left = Math.max(0, v.deadline - (Date.now() + clockOffset));
  for (const bar of document.querySelectorAll('.timer-bar')) {
    bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
    bar.parentElement.classList.toggle('low', left < 10_000);
  }
}

export function holdemLastHandHTML(v) {
  const L = v.lastHand;
  if (!L) return '<p class="muted">No hands finished yet.</p>';
  return `<div class="last pk-last">
    <div class="last-head"><span>Hand ${L.handNo}</span><div class="pk-mini-board">${L.board.map((c) => cardHTML(c, { cls: 'xs-face' })).join('') || '<span class="muted small">No flop</span>'}</div></div>
    ${L.results.map((r) => {
      const p = v.players[r.seat];
      return `<div class="show" style="--c:${seatColor(r.seat)}">
        <div class="show-head"><b>${r.seat === v.you ? 'You' : esc(p.name)}</b><span class="show-total">${r.won ? `+${money(r.won)}` : ''}</span></div>
        ${r.cards ? `<div class="show-cards">${r.cards.map((c) => cardHTML(c, { cls: 'xs-face' })).join('')}<span class="muted small">${esc(r.best)}</span></div>` : '<p class="muted small">Won without a showdown</p>'}
      </div>`;
    }).join('')}
    ${L.pots.length > 1 ? `<p class="muted small">${L.pots.map((p, i) => `${i ? `Side pot ${i}` : 'Main pot'}: ${money(p.amount)}`).join(' · ')}</p>` : ''}
  </div>`;
}

export function holdemOverHTML(v) {
  const order = [...v.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  return `<div class="final">${order.map((p) => `<div style="--c:${seatColor(p.seat)}"><span>${ordinal(p.place)} · ${esc(p.seat === v.you ? 'You' : p.name)}</span><b>${p.place === 1 ? money(p.stack) : ''}</b></div>`).join('')}</div>`;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const ordinal = (n) => (n == null ? '–' : `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`);
export { cardText, SIDE_COLORS };
