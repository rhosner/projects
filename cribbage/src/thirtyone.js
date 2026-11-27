// Thirty-One engine. Pure state transitions; the server owns persistence and timing.
//
// Rules (Bicycle's, as supplied), plus the choices for cases they leave open:
// - 2-8 players, 52 cards. Ace = 11, face cards = 10, others face value.
//   A hand's value is the total of its cards in its best single suit.
// - Each player starts with 6 tokens. Lose one per lost round. At 0 tokens you're
//   "on your honor" and still playing; lose again and you're out.
// - Dealer is drawn by low card, then passes left each round. Three cards each;
//   the rest is the stock; its top card starts the discard pile.
// - On your turn: knock (in place of your turn), or draw from the stock or the
//   discard pile and then discard one card. You can't throw back the card you
//   just took from the discard pile.
// - After a knock everyone else gets one more turn, then the lowest hand loses a
//   token; a knocker with the lowest hand loses 2. Ties for lowest all lose.
// - 31 at any time (including the deal) wins the round at once; everyone else
//   loses a token.
// - Empty stock: the discard pile (except its top card) is shuffled into a new stock.
// - If every remaining player would go out in the same round, nobody goes out.
// - Last player in wins.
import { newDeck, shuffle, randomInt, RuleError } from './engine.js';

export const THIRTYONE_DEFAULTS = { tokens: 6 };
const RANKS = 'A23456789TJQK';
const SUITS = 'SHDC';
export const cardPoints = (c) => (c[0] === 'A' ? 11 : Math.min(10, RANKS.indexOf(c[0]) + 1));

/** Best single-suit total of a hand: { value, suit }. */
export function handValue(cards) {
  let best = { value: 0, suit: null };
  for (const s of SUITS) {
    const v = cards.filter((c) => c[1] === s).reduce((t, c) => t + cardPoints(c), 0);
    if (v > best.value) best = { value: v, suit: s };
  }
  return best;
}

function log(state, text, extra = {}) {
  state.log.push({ t: Date.now(), hand: state.round, text, ...extra });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

export function createThirtyOne({ id, maxPlayers = 4, settings = {} }) {
  if (!(maxPlayers >= 2 && maxPlayers <= 8)) throw new RuleError('Thirty-One is for 2 to 8 players');
  const tokens = Math.round(Number(settings.tokens));
  return {
    type: 'thirtyone',
    id,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    numPlayers: maxPlayers,
    status: 'lobby',
    phase: 'lobby',
    settings: { tokens: tokens >= 1 && tokens <= 20 ? tokens : THIRTYONE_DEFAULTS.tokens },
    players: [],
    round: 0,
    dealer: null,
    stock: [],
    discard: [],
    hands: [],
    turn: null,
    drew: null, // this turn's draw: { from, card }
    knocker: null,
    pending: [], // seats still owed their last turn after a knock
    pot: 0,
    lastRound: null,
    winner: null,
    log: [],
    nextGameId: null,
  };
}

export function addThirtyOnePlayer(state, { id, name, tokenHash, bot = false, playerId = null }, rng = randomInt) {
  if (state.status !== 'lobby') throw new RuleError('This game has already started');
  if (state.players.length >= state.numPlayers) throw new RuleError('This game is full');
  state.players.push({ id, name, tokenHash, bot, playerId, joinedAt: Date.now(), tokens: state.settings.tokens, out: false, place: null });
  log(state, `${name} sat down`);
  if (state.players.length === state.numPlayers) startThirtyOne(state, rng);
  return state.players.length - 1;
}

export function startThirtyOne(state, rng = randomInt) {
  if (state.status !== 'lobby') throw new RuleError('This game has already started');
  if (state.players.length < 2) throw new RuleError('You need at least 2 players');
  state.numPlayers = state.players.length;
  state.status = 'playing';
  // Low card deals (ties redraw among the tied players).
  let drawing = state.players.map((_, i) => i);
  for (let guard = 0; drawing.length > 1 && guard < 20; guard++) {
    const deck = shuffle(newDeck(), rng);
    const draws = drawing.map((s) => [s, deck.pop()]);
    const low = Math.min(...draws.map(([, c]) => RANKS.indexOf(c[0])));
    drawing = draws.filter(([, c]) => RANKS.indexOf(c[0]) === low).map(([s]) => s);
  }
  state.dealer = drawing[0];
  log(state, `${state.players[state.dealer].name} drew low card and deals first.`);
  deal(state, rng, true);
}

const alive = (state) => state.players.map((p, i) => i).filter((i) => !state.players[i].out);
function nextAlive(state, from) {
  for (let k = 1; k <= state.numPlayers; k++) {
    const s = (from + k) % state.numPlayers;
    if (!state.players[s].out) return s;
  }
  return null;
}

function deal(state, rng, first = false) {
  state.round += 1;
  if (!first) state.dealer = nextAlive(state, state.dealer);
  state.stock = shuffle(newDeck(), rng);
  state.hands = state.players.map(() => []);
  const seats = alive(state);
  for (let r = 0; r < 3; r++) for (const s of seats) state.hands[s].push(state.stock.pop());
  state.discard = [state.stock.pop()];
  state.knocker = null;
  state.pending = [];
  state.drew = null;
  state.turn = nextAlive(state, state.dealer);
  state.phase = 'turn';
  log(state, `Round ${state.round}: ${state.players[state.dealer].name} deals`, { kind: 'hand' });
  const dealt31 = seats.filter((s) => handValue(state.hands[s]).value === 31);
  if (dealt31.length) endRound(state, '31', dealt31);
}

// ---------------------------------------------------------------------------
// Player moves
// ---------------------------------------------------------------------------
export function thirtyOneAct(state, seat, action) {
  if (state.status !== 'playing' || !['turn', 'drawn'].includes(state.phase)) throw new RuleError('Not time to play');
  if (state.turn !== seat) throw new RuleError("It's not your turn");
  const p = state.players[seat];
  const type = action?.type;

  if (type === 'knock') {
    if (state.phase !== 'turn') throw new RuleError('Knock at the start of your turn, instead of drawing');
    if (state.knocker !== null) throw new RuleError(`${state.players[state.knocker].name} already knocked`);
    state.knocker = seat;
    state.pending = alive(state).filter((s) => s !== seat);
    log(state, `${p.name} knocks. Everyone else gets one more turn.`, { seat, kind: 'knock', calls: [{ label: 'Knock!' }] });
    noteHuman(state, seat);
    return nextTurn(state);
  }

  if (type === 'draw') {
    if (state.phase !== 'turn') throw new RuleError('You already drew; now discard a card');
    const from = action.from === 'discard' ? 'discard' : 'stock';
    let card;
    if (from === 'discard') {
      card = state.discard.pop();
    } else {
      if (!state.stock.length) reshuffle(state);
      card = state.stock.pop();
    }
    state.hands[seat].push(card);
    state.drew = { from, card };
    state.phase = 'drawn';
    log(state, from === 'discard' ? `${p.name} takes the ${label(card)}` : `${p.name} draws from the deck`, { seat, kind: `draw-${from}` });
    noteHuman(state, seat);
    return;
  }

  if (type === 'discard') {
    if (state.phase !== 'drawn') throw new RuleError('Draw a card first');
    const card = String(action.card);
    if (!state.hands[seat].includes(card)) throw new RuleError('That card is not in your hand');
    if (state.drew?.from === 'discard' && state.drew.card === card) throw new RuleError('You can’t throw back the card you just took');
    state.hands[seat] = state.hands[seat].filter((c) => c !== card);
    state.discard.push(card);
    state.phase = 'turn';
    state.drew = null;
    log(state, `${p.name} discards the ${label(card)}`, { seat, kind: 'discard', card });
    noteHuman(state, seat);
    if (handValue(state.hands[seat]).value === 31) return endRound(state, '31', [seat]);
    if (state.knocker !== null) state.pending = state.pending.filter((s) => s !== seat);
    return nextTurn(state);
  }

  throw new RuleError('Unknown move');
}

function noteHuman(state, seat) {
  if (state.players[seat].bot) return;
  state.lastActor = seat;
  state.lastActorAt = Date.now();
}

function nextTurn(state) {
  if (state.knocker !== null) {
    if (!state.pending.length) return endRound(state, 'knock');
    let s = nextAlive(state, state.turn);
    while (!state.pending.includes(s)) s = nextAlive(state, s);
    state.turn = s;
  } else {
    state.turn = nextAlive(state, state.turn);
  }
}

function reshuffle(state, rng = randomInt) {
  const top = state.discard.pop();
  state.stock = shuffle(state.discard, rng);
  state.discard = [top];
  log(state, 'The deck ran out. The discard pile is shuffled into a new deck.', { kind: 'reshuffle' });
}

const label = (c) => `${c[0] === 'T' ? '10' : c[0]}${{ S: '♠', H: '♥', D: '♦', C: '♣' }[c[1]]}`;

function endRound(state, reason, winners31 = []) {
  const seats = alive(state);
  const values = new Map(seats.map((s) => [s, handValue(state.hands[s]).value]));
  let losses = [];
  if (reason === '31') {
    losses = seats.filter((s) => !winners31.includes(s)).map((s) => [s, 1]);
    for (const w of winners31) log(state, `${state.players[w].name} has 31!`, { seat: w, kind: 'thirtyone', calls: [{ label: '31!' }] });
  } else {
    const low = Math.min(...values.values());
    losses = seats.filter((s) => values.get(s) === low).map((s) => [s, s === state.knocker ? 2 : 1]);
  }
  // If every remaining player would go out together, nobody does.
  const wouldOut = losses.filter(([s, n]) => state.players[s].tokens - n < 0).map(([s]) => s);
  const spared = wouldOut.length > 0 && wouldOut.length === seats.length;
  for (const [s, n] of losses) {
    const p = state.players[s];
    if (spared) continue;
    const before = p.tokens;
    p.tokens -= n;
    state.pot += Math.min(n, Math.max(0, before));
    log(state, `${p.name} loses ${n === 2 ? '2 tokens (knocked and had the lowest hand)' : 'a token'}${p.tokens === 0 ? ' and is on their honor' : ''}`, {
      seat: s, kind: 'lose', calls: [{ label: n === 2 ? 'Loses 2' : p.tokens === 0 ? 'On their honor' : 'Loses a token' }],
    });
  }
  if (spared) log(state, 'Everyone left would be knocked out at once, so nobody is. Replay the round.', { kind: 'spared' });

  state.lastRound = {
    round: state.round,
    reason,
    knocker: state.knocker,
    winners31,
    spared,
    hands: seats.map((s) => ({ seat: s, cards: [...state.hands[s]], value: values.get(s), suit: handValue(state.hands[s]).suit, lost: spared ? 0 : losses.find(([x]) => x === s)?.[1] ?? 0 })),
  };
  state.turn = null;
  state.phase = 'roundover';
}

// ---------------------------------------------------------------------------
// Automatic steps
// ---------------------------------------------------------------------------
export const THIRTYONE_DELAY = { 'next-round': 4200, 'bot-move': 1300 };

export function thirtyOneAutoStep(state, rng = randomInt) {
  if (state.status !== 'playing' || state.phase !== 'roundover') return null;
  // Knock out anyone below zero tokens.
  const outNow = alive(state).filter((s) => state.players[s].tokens < 0);
  const remaining = alive(state).length - outNow.length;
  outNow
    .sort((a, b) => (state.lastRound.hands.find((h) => h.seat === b)?.value ?? 0) - (state.lastRound.hands.find((h) => h.seat === a)?.value ?? 0))
    .forEach((s, k) => {
      const p = state.players[s];
      p.out = true;
      p.place = remaining + 1 + k;
      log(state, `${p.name} is out`, { seat: s, kind: 'out', calls: [{ label: 'Out!' }] });
    });
  if (remaining <= 1) {
    const w = alive(state)[0];
    state.players[w].place = 1;
    state.winner = w;
    state.status = 'finished';
    state.phase = 'done';
    state.finishedAt = Date.now();
    log(state, `${state.players[w].name} wins the game!`, { seat: w, kind: 'win' });
    return 'finish';
  }
  deal(state, rng);
  return 'next-round';
}

export const thirtyOnePeek = (state) => thirtyOneAutoStep(structuredClone(state), () => 0);

export function thirtyOneIsTurn(state, seat) {
  return state.status === 'playing' && ['turn', 'drawn'].includes(state.phase) && state.turn === seat;
}

// ---------------------------------------------------------------------------
// Per-player view
// ---------------------------------------------------------------------------
export function thirtyOneView(state, seat) {
  const me = seat ?? null;
  const reveal = state.phase === 'roundover' || state.phase === 'done';
  return {
    id: state.id,
    type: 'thirtyone',
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    numPlayers: state.numPlayers,
    status: state.status,
    phase: state.phase,
    handNo: state.round,
    settings: state.settings,
    dealer: state.dealer,
    winner: state.winner,
    nextGameId: state.nextGameId,
    players: state.players.map((p, i) => ({
      seat: i,
      name: p.name,
      bot: !!p.bot,
      tokens: Math.max(0, p.tokens),
      onHonor: p.tokens === 0 && !p.out,
      out: p.out,
      place: p.place,
      cardCount: state.hands[i]?.length ?? 0,
      knocked: state.knocker === i,
      isTurn: thirtyOneIsTurn(state, i),
      lastTurn: state.pending.includes(i),
    })),
    you: me,
    hand: me !== null && state.status !== 'lobby' ? state.hands[me] ?? [] : [],
    handValue: me !== null && state.hands[me]?.length ? handValue(state.hands[me]) : null,
    drew: me !== null && state.turn === me ? state.drew : null,
    discardTop: state.discard.at(-1) ?? null,
    discardCount: state.discard.length,
    stockCount: state.stock.length,
    turn: state.turn,
    knocker: state.knocker,
    pot: state.pot,
    yourTurn: me !== null && thirtyOneIsTurn(state, me),
    canKnock: me !== null && thirtyOneIsTurn(state, me) && state.phase === 'turn' && state.knocker === null,
    lastRound: reveal || state.phase === 'turn' || state.phase === 'drawn' ? state.lastRound : null,
    log: state.log.slice(-80),
  };
}
