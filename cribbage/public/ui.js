// Rendering helpers: cards, the peg board, small utilities.

export const SIDE_COLORS = ['#f5b041', '#3dd6d0', '#f472b6', '#a78bfa'];
const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_ORDER = 'A23456789TJQK';

// Suits drawn as shapes (not font characters, which differ by device), designed so
// clubs (three round lobes) and spades (one pointed blade) read apart even when tiny.
const SUIT_PATHS = {
  S: 'M50 4C66 22 94 40 94 63c0 15-11 24-23 24-9 0-16-4-19-11 1 9 5 16 14 22H34c9-6 13-13 14-22-3 7-10 11-19 11C17 87 6 78 6 63 6 40 34 22 50 4Z',
  H: 'M50 92C24 72 5 55 5 33 5 18 16 8 29 8c10 0 17 6 21 14 4-8 11-14 21-14 13 0 24 10 24 25 0 22-19 39-45 59Z',
  D: 'M50 3 87 50 50 97 13 50Z',
  C: 'M50 4a21 21 0 0 1 17 33.5A21 21 0 1 1 55 75c2 9 6 15 13 21H32c7-6 11-12 13-21a21 21 0 1 1-12-37.5A21 21 0 0 1 50 4Z',
};
export const suitSVG = (s) =>
  `<svg class="suit" viewBox="0 0 100 100" aria-hidden="true"><path d="${SUIT_PATHS[s]}"/></svg>`;

// Display preference: four-colour suits (clubs green, diamonds blue), on by default.
const DISPLAY_KEY = 'cribbage.display';
let display = { fourColor: true };
try {
  display = { ...display, ...JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}') };
} catch { /* defaults */ }
document.documentElement.classList.toggle('four-color', display.fourColor);
export const displayPrefs = () => ({ ...display });
export function setDisplayPref(key, on) {
  display[key] = on;
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(display));
  } catch { /* fine */ }
  document.documentElement.classList.toggle('four-color', display.fourColor);
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const rankLabel = (c) => (c[0] === 'T' ? '10' : c[0]);
export const cardText = (c) => `${rankLabel(c)}${SYM[c[1]]}`;
export const isRed = (c) => c[1] === 'H' || c[1] === 'D';
export const cardValue = (c) => Math.min(RANK_ORDER.indexOf(c[0]) + 1, 10);
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

export function cardHTML(c, { cls = '', attrs = '', inner = '' } = {}) {
  const r = rankLabel(c);
  const s = suitSVG(c[1]);
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
  return `<div class="card ${isRed(c) ? 'red' : 'black'} suit-${c[1]} ${cls}" data-card="${c}" ${attrs} aria-label="${esc(cardText(c))}">
    <span class="idx tl"><b>${r}</b><span>${s}</span></span>${center}<span class="idx br"><b>${r}</b><span>${s}</span></span>${inner}</div>`;
}

export const backHTML = (cls = '', attrs = '') => `<div class="card back ${cls}" ${attrs} aria-hidden="true"><span></span></div>`;

export const miniCard = (c, attrs = '') =>
  `<span class="mini ${isRed(c) ? 'red' : ''} suit-${c[1]}" ${attrs} aria-label="${esc(cardText(c))}">${rankLabel(c)}${suitSVG(c[1])}</span>`;

export function miniCards(cards) {
  return cards.map((c) => miniCard(c)).join('');
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
