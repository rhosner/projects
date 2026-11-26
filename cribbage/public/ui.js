// Rendering helpers: cards, the peg board, small utilities.

export const SIDE_COLORS = ['#f5b041', '#3dd6d0', '#f472b6', '#a78bfa'];
const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_ORDER = 'A23456789TJQK';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const rankLabel = (c) => (c[0] === 'T' ? '10' : c[0]);
export const cardText = (c) => `${rankLabel(c)}${SYM[c[1]]}`;
export const isRed = (c) => c[1] === 'H' || c[1] === 'D';
export const sortCards = (cards) =>
  [...cards].sort((a, b) => RANK_ORDER.indexOf(a[0]) - RANK_ORDER.indexOf(b[0]) || 'SHDC'.indexOf(a[1]) - 'SHDC'.indexOf(b[1]));

// Pip positions on a 3-column x 7-row grid: [col, row]
const PIPS = {
  2: [[2, 1], [2, 7]],
  3: [[2, 1], [2, 4], [2, 7]],
  4: [[1, 1], [3, 1], [1, 7], [3, 7]],
  5: [[1, 1], [3, 1], [2, 4], [1, 7], [3, 7]],
  6: [[1, 1], [3, 1], [1, 4], [3, 4], [1, 7], [3, 7]],
  7: [[1, 1], [3, 1], [2, 2.5], [1, 4], [3, 4], [1, 7], [3, 7]],
  8: [[1, 1], [3, 1], [2, 2.5], [1, 4], [3, 4], [2, 5.5], [1, 7], [3, 7]],
  9: [[1, 1], [3, 1], [1, 3], [3, 3], [2, 4], [1, 5], [3, 5], [1, 7], [3, 7]],
  10: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3], [1, 5], [3, 5], [2, 6], [1, 7], [3, 7]],
};

export function cardHTML(c, { cls = '', attrs = '' } = {}) {
  const r = rankLabel(c);
  const s = SYM[c[1]];
  const n = RANK_ORDER.indexOf(c[0]) + 1;
  let center;
  if (n === 1) center = `<span class="ace">${s}</span>`;
  else if (n > 10) center = `<span class="face"><span class="face-r">${r}</span><span class="face-s">${s}</span></span>`;
  else {
    center = `<span class="pips">${PIPS[n]
      .map(([col, row]) => {
        const left = [22, 50, 78][col - 1];
        const top = 12 + ((row - 1) / 6) * 76;
        return `<i style="left:${left}%;top:${top}%"${row > 4 ? ' class="flip"' : ''}>${s}</i>`;
      })
      .join('')}</span>`;
  }
  return `<div class="card ${isRed(c) ? 'red' : 'black'} ${cls}" data-card="${c}" ${attrs} aria-label="${esc(cardText(c))}">
    <span class="idx tl"><b>${r}</b><span>${s}</span></span>${center}<span class="idx br"><b>${r}</b><span>${s}</span></span></div>`;
}

export const backHTML = (cls = '', attrs = '') => `<div class="card back ${cls}" ${attrs} aria-hidden="true"><span></span></div>`;

export function miniCards(cards) {
  return cards
    .map((c) => `<span class="mini ${isRed(c) ? 'red' : ''}">${esc(cardText(c))}</span>`)
    .join('');
}

export function timeAgo(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}


// ---------------------------------------------------------------------------
// Peg board: one lane per side. Holes run in serpentine rows (2 rows of 60 on
// wide screens, 4 rows of 30 on phones) and finish next to where they started,
// like a real board. The SVG persists across renders so pegs glide.
// ---------------------------------------------------------------------------
const PAD_L = 50;
const ROW_GAP = 17;
const LANE_PAD = 24;
const TOP = 16;

function geometry(rows) {
  const perRow = 120 / rows;
  const dx = rows === 2 ? 14.6 : 15;
  const gap = rows === 2 ? 9 : 8;
  const laneH = (rows - 1) * ROW_GAP + LANE_PAD;
  const width = PAD_L + (perRow - 1) * dx + (perRow / 5 - 1) * gap + 22;
  const holeXY = (score, lane) => {
    const y0 = TOP + lane * (laneH + 8) + 6;
    if (score <= 0) return [PAD_L - 24, y0];
    if (score >= 121) return [PAD_L - 24, y0 + (rows - 1) * ROW_GAP];
    const row = Math.floor((score - 1) / perRow);
    const pos = (score - 1) % perRow;
    const idx = row % 2 === 0 ? pos : perRow - 1 - pos;
    return [PAD_L + idx * dx + Math.floor(idx / 5) * gap, y0 + row * ROW_GAP];
  };
  return { rows, perRow, laneH, width, holeXY };
}

export function boardRowsFor(el) {
  return el.clientWidth && el.clientWidth < 640 ? 4 : 2;
}

export function mountBoard(el, sides, rows = 2) {
  const g = geometry(rows);
  const h = TOP + sides * (g.laneH + 8) + 4;
  let svg = '';
  for (let lane = 0; lane < sides; lane++) {
    const [, y] = g.holeXY(1, lane);
    svg += `<rect class="lane" x="${PAD_L - 38}" y="${y - 11}" width="${g.width - PAD_L + 30}" height="${(rows - 1) * ROW_GAP + 22}" rx="12" style="--c:${SIDE_COLORS[lane]}"/>`;
    for (let s = 1; s <= 120; s++) {
      const [x, yy] = g.holeXY(s, lane);
      svg += `<circle class="hole${s % 5 === 0 ? ' fifth' : ''}" cx="${x}" cy="${yy}" r="2.4"/>`;
    }
    const [sx, sy] = g.holeXY(0, lane);
    const [fx, fy] = g.holeXY(121, lane);
    svg += `<circle class="hole start" cx="${sx}" cy="${sy}" r="2.6"/><circle class="hole finish" cx="${fx}" cy="${fy}" r="3.6" style="--c:${SIDE_COLORS[lane]}"/>`;
  }
  // Skunk lines: a loser who hasn't passed 90 is skunked, one who hasn't passed 60 is
  // double-skunked. Each line sits between the two holes it separates; where that
  // falls on a turn at the end of a row, it becomes a short bar across the bend.
  for (let lane = 0; lane < sides; lane++) {
    for (const [a, cls] of [[90, 'skunk'], [60, 'skunk dbl']]) {
      const [x1, y1] = g.holeXY(a, lane);
      const [x2, y2] = g.holeXY(a + 1, lane);
      const line = y1 === y2
        ? { x1: (x1 + x2) / 2, x2: (x1 + x2) / 2, y1: y1 - 7, y2: y1 + 7 }
        : { x1: x1 - 7, x2: x1 + 7, y1: (y1 + y2) / 2, y2: (y1 + y2) / 2 };
      svg += `<line class="${cls}" x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}"><title>${a === 90 ? 'Skunk line (91)' : 'Double skunk line (61)'}</title></line>`;
    }
  }
  // Mile markers along the top edge of the first lane's rows.
  for (let m = 15; m <= 120; m += 15) {
    const row = Math.floor((m - 1) / g.perRow);
    if (row !== 0) continue;
    svg += `<text class="mark" x="${g.holeXY(m, 0)[0]}" y="${TOP - 5}">${m}</text>`;
  }
  for (let lane = 0; lane < sides; lane++) {
    svg += `<g class="peg back" data-lane="${lane}" data-p="back" style="--c:${SIDE_COLORS[lane]}"><circle r="4.6"/></g>`;
    svg += `<g class="peg front" data-lane="${lane}" data-p="front" style="--c:${SIDE_COLORS[lane]}"><circle class="glow" r="9"/><circle r="5.2"/></g>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${g.width} ${h}" class="board-svg" role="img" aria-label="Cribbage board">${svg}</svg>
    <div class="board-legend"><span><i class="sk"></i>Skunk line: finish below 91</span><span><i class="sk dbl"></i>Double skunk: below 61</span></div>`;
  el._holeXY = g.holeXY;
}

export function updateBoard(el, scores, prevScores) {
  const holeXY = el._holeXY;
  for (const peg of el.querySelectorAll('.peg')) {
    const lane = Number(peg.dataset.lane);
    const front = peg.dataset.p === 'front';
    const score = front ? scores[lane] : prevScores[lane] === scores[lane] ? 0 : prevScores[lane];
    let [x, y] = holeXY(score, lane);
    if (score === 0 && !front) x -= 11; // both pegs wait side by side at the start
    peg.style.transform = `translate(${x}px, ${y}px)`;
  }
  const labels = el.querySelectorAll('.peg.front');
  labels.forEach((p) => p.setAttribute('aria-label', `Score ${scores[Number(p.dataset.lane)]}`));
}
