// Thirty-One table: rendering and controls, used by app.js when type is 'thirtyone'.
import { esc, cardHTML, backHTML, cardText, sortCards, suitSVG } from './ui.js';
import { seatColor, ordinal } from './holdem-ui.js';

const POINTS = (c) => (c[0] === 'A' ? 11 : Math.min(10, 'A23456789TJQK'.indexOf(c[0]) + 1));
export function handValue(cards) {
  let best = { value: 0, suit: null };
  for (const s of 'SHDC') {
    const v = cards.filter((c) => c[1] === s).reduce((t, c) => t + POINTS(c), 0);
    if (v > best.value) best = { value: v, suit: s };
  }
  return best;
}
const valueBadge = (hv) => (hv?.suit ? `<span class="t1-value">${hv.value}<span class="suit-chip suit-${hv.suit}">${suitSVG(hv.suit)}</span></span>` : '');

/** Holding four cards after a draw: the most you can keep by discarding one. */
function bestKeepBadge(hand, forbidden) {
  let best = null;
  for (const c of hand) {
    if (c === forbidden) continue;
    const hv = handValue(hand.filter((x) => x !== c));
    if (!best || hv.value > best.value) best = hv;
  }
  return best ? `<span class="pts-pill">Best keep: <b>${best.value}</b></span>` : '';
}

function tokensHTML(p, total) {
  if (p.out) return `<span class="t1-tokens out">Out · ${ordinal(p.place)}</span>`;
  if (p.onHonor) return '<span class="t1-tokens honor">On their honor</span>';
  const coins = Array.from({ length: total }, (_, i) => `<i class="coin ${i < p.tokens ? '' : 'spent'}"></i>`).join('');
  return `<span class="t1-tokens" title="${p.tokens} token${p.tokens === 1 ? '' : 's'} left">${coins}</span>`;
}

export function thirtyOneStatus(v) {
  if (v.status === 'finished') return `${esc(v.players[v.winner].name)} wins the game`;
  const lr = v.lastRound;
  if (v.phase === 'roundover' && lr) {
    const name = (s) => (s === v.you ? 'You' : esc(v.players[s].name));
    if (lr.spared) return 'Everyone left would be out at once, so nobody is. Next round…';
    const you = (h) => h.seat === v.you;
    const lost = lr.hands.filter((h) => h.lost).map((h) => `${name(h.seat)} ${you(h) ? 'lose' : 'loses'} ${h.lost === 2 ? '2 tokens' : 'a token'}`);
    const head = lr.reason === '31' ? `<b>${lr.winners31.map(name).join(' & ')} hit 31!</b>` : `${name(lr.knocker)} knocked.`;
    return `${head} ${lost.join(' · ')}`;
  }
  if (v.yourTurn) {
    if (v.phase === 'drawn') return 'Tap a card to discard';
    return v.knocker !== null ? `<b>${esc(v.players[v.knocker].name)} knocked.</b> Your last turn: draw a card.` : 'Your turn: draw from the deck or take the discard, or knock.';
  }
  const t = v.players[v.turn];
  return t ? `Waiting for ${esc(t.name)}${v.knocker !== null ? ` (${esc(v.players[v.knocker].name)} knocked)` : ''}` : '';
}

function seatHTML(v, p) {
  const c = seatColor(p.seat);
  const lr = v.phase === 'roundover' || v.status === 'finished' ? v.lastRound : null;
  const shown = lr?.hands.find((h) => h.seat === p.seat);
  const cards = shown
    ? sortCards(shown.cards).map((card) => cardHTML(card, { cls: 'sm' })).join('')
    : Array.from({ length: p.cardCount }, () => backHTML('xs')).join('');
  const tags = [];
  if (v.dealer === p.seat) tags.push('<span class="dealer" title="Dealer">D</span>');
  if (p.knocked) tags.push('<span class="knock-badge">KNOCKED</span>');
  else if (p.lastTurn && v.phase !== 'roundover') tags.push('<span class="blind-tag">Last turn</span>');
  return `<div class="seat t1-seat ${p.isTurn ? 'turn' : ''} ${p.out ? 'dim' : ''} ${shown?.lost ? 'loser' : ''}" data-seat="${p.seat}" style="--c:${c}">
    <div class="seat-head"><span class="avatar" style="--c:${c}">${esc(p.name[0].toUpperCase())}</span>
      <div class="seat-name"><b>${esc(p.name)}${p.bot ? ' <span class="bot-tag">BOT</span>' : ''}</b>${tokensHTML(p, v.settings.tokens)}</div>
      <div class="pk-tags">${tags.join('')}</div></div>
    <div class="pk-cards">${cards}</div>
    ${shown ? `<div class="pk-best">${shown.value} ${shown.lost ? `<b class="lost">−${shown.lost}</b>` : ''}${lr.winners31.includes(p.seat) ? ' <b>31!</b>' : ''}</div>` : ''}
  </div>`;
}

export function thirtyOneTableHTML(v, G) {
  const others = v.players.filter((p) => p.seat !== v.you);
  const canDraw = v.yourTurn && v.phase === 'turn';
  const top = v.discardTop;
  return `
    <div class="opponents pk-opponents">${others.map((p) => seatHTML(v, p)).join('')}</div>
    <div class="felt t1-felt">
      <div class="t1-piles">
        <button class="t1-pile ${canDraw ? 'can' : ''}" data-t1="stock" ${canDraw ? '' : 'disabled'} aria-label="Draw from the deck">
          <div class="deck">${backHTML('md')}</div><span class="slot-label">Deck · ${v.stockCount}</span></button>
        <button class="t1-pile ${canDraw && top ? 'can' : ''}" data-t1="discard" ${canDraw && top ? '' : 'disabled'} aria-label="Take the discard">
          <div class="t1-discard">${top ? cardHTML(top, { cls: `md ${G.lastTop !== top ? 'flip-in' : ''}` }) : '<div class="card placeholder md"></div>'}</div>
          <span class="slot-label">${top ? `Take ${cardText(top)}` : 'Discard'}</span></button>
      </div>
      <div class="t1-pot"><span>Pot</span><b>${v.pot}</b><small>tokens</small></div>
    </div>
    <div class="status ${v.yourTurn ? 'your-turn' : ''}">${thirtyOneStatus(v)}</div>
    ${v.you !== null ? meHTML(v, G) : '<p class="muted center">You’re watching this game.</p>'}`;
}

function meHTML(v, G) {
  G.lastTop = v.discardTop;
  const me = v.players[v.you];
  const c = seatColor(v.you);
  const drawn = v.yourTurn && v.phase === 'drawn';
  const forbidden = v.drew?.from === 'discard' ? v.drew.card : null;
  if (!drawn) G.t1Selected = null;
  const hand = sortCards(v.hand);
  const cards = hand.map((card, i) => {
    const locked = drawn && card === forbidden;
    const interactive = drawn && !locked && !G.busy;
    const after = drawn ? handValue(hand.filter((x) => x !== card)) : null;
    const isNew = v.drew?.card === card;
    return cardHTML(card, {
      cls: `hand-card ${interactive ? 'interactive' : ''} ${G.t1Selected === card ? 'selected' : ''} ${locked ? 'illegal' : ''} ${isNew ? 'just-drawn' : ''}`,
      attrs: `style="--i:${i};--n:${hand.length}" ${interactive ? 'tabindex="0" role="button"' : ''}`,
      inner: drawn ? `<span class="peek ${locked ? 'too-high' : ''}">${locked ? 'Just taken' : `Keep → <b>${after.value}</b>`}</span>` : '',
    });
  }).join('');
  let actions = '';
  if (v.yourTurn && v.phase === 'turn') {
    actions = `<div class="pk-actions">
      ${v.canKnock ? '<button class="btn danger-ghost big" data-t1="knock">✊ Knock</button>' : ''}
      <button class="btn big" data-t1="stock">Draw from deck</button>
      ${v.discardTop ? `<button class="btn primary big" data-t1="discard">Take ${cardText(v.discardTop)}</button>` : ''}
    </div>`;
  } else if (drawn) {
    actions = `<div class="actions"><button class="btn primary big" id="t1-discard" ${G.t1Selected ? '' : 'disabled'}>${G.t1Selected ? `Discard ${cardText(G.t1Selected)}` : 'Select a card to discard'}</button><small class="hint">Double-tap to discard instantly</small></div>`;
  }
  return `<div class="me t1-me ${v.yourTurn ? 'turn' : ''}" style="--c:${c}">
    <div class="me-head"><span class="avatar" style="--c:${c}">${esc(me.name[0].toUpperCase())}</span><b>${esc(me.name)}</b>${tokensHTML(me, v.settings.tokens)}
      <div class="pk-tags">${v.dealer === v.you ? '<span class="dealer">D</span>' : ''}${me.knocked ? '<span class="knock-badge">KNOCKED</span>' : ''}${drawn ? bestKeepBadge(hand, forbidden) : valueBadge(v.handValue)}</div></div>
    <div class="hand">${cards || `<span class="muted">${me.out ? `You finished ${ordinal(me.place)}` : 'Waiting for the deal'}</span>`}</div>
    ${actions}
  </div>`;
}

export function bindThirtyOne(v, G, act, rerender) {
  for (const b of document.querySelectorAll('[data-t1]')) {
    b.onclick = () => {
      const k = b.dataset.t1;
      act('act', { action: k === 'knock' ? { type: 'knock' } : { type: 'draw', from: k } });
    };
  }
  const drawn = v.yourTurn && v.phase === 'drawn';
  if (!drawn) return;
  for (const el of document.querySelectorAll('.t1-me .hand-card.interactive')) {
    const card = el.dataset.card;
    el.onclick = () => {
      G.t1Selected = G.t1Selected === card ? null : card;
      rerender();
    };
    el.ondblclick = () => act('act', { action: { type: 'discard', card } });
    el.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.onclick();
      }
    };
  }
  const d = document.getElementById('t1-discard');
  if (d) d.onclick = () => G.t1Selected && act('act', { action: { type: 'discard', card: G.t1Selected } });
}

export function thirtyOneLastHTML(v) {
  const lr = v.lastRound;
  if (!lr) return '<p class="muted">No rounds finished yet.</p>';
  const name = (s) => (s === v.you ? 'You' : esc(v.players[s].name));
  return `<div class="last t1-last">
    <div class="last-head"><span>Round ${lr.round} · ${lr.reason === '31' ? `${lr.winners31.map(name).join(' & ')} hit 31` : `${name(lr.knocker)} knocked`}</span></div>
    ${[...lr.hands].sort((a, b) => b.value - a.value).map((h) => `<div class="show" style="--c:${seatColor(h.seat)}">
      <div class="show-head"><b>${name(h.seat)}</b><span class="show-total">${h.value}</span></div>
      <div class="show-cards">${sortCards(h.cards).map((c) => cardHTML(c, { cls: 'xs-face' })).join('')}${h.lost ? `<span class="muted small" style="margin-left:8px">lost ${h.lost} token${h.lost > 1 ? 's' : ''}</span>` : ''}</div>
    </div>`).join('')}
  </div>`;
}

export function thirtyOneOverHTML(v) {
  const order = [...v.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  return `<div class="final">${order.map((p) => `<div style="--c:${seatColor(p.seat)}"><span>${ordinal(p.place)} · ${esc(p.seat === v.you ? 'You' : p.name)}</span><b>${p.place === 1 ? `${p.tokens} left` : ''}</b></div>`).join('')}</div>`;
}
