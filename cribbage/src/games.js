// Every game the table can host, behind one interface the server, the demo
// backend, notifications and the leaderboard all use:
//
//   create({ id, numPlayers, settings })   -> new lobby state
//   addPlayer(state, seatInfo, rng)        -> seat index (may start the game)
//   start(state, rng)                      -> start early (if the game allows it)
//   act(state, seat, action)               -> apply a player's move
//   nextAutomatic(state, opts)             -> { kind, delay, at?, apply } | null
//   view(state, seat)                      -> what that seat may see
//   isTurn(state, seat)
//   sideOf(state, seat)                    -> who scores together (teams)
//
// Games saved before `type` existed are cribbage.
import {
  createGame, addPlayer, discard, play, viewFor, isTurn, sideOf, RuleError,
} from './engine.js';
import { nextAutomatic } from './bot.js';
import {
  createHoldem, addHoldemPlayer, startHoldem, holdemAct, holdemView, holdemIsTurn,
} from './holdem.js';
import { holdemNextAutomatic } from './holdem-bot.js';
import {
  createThirtyOne, addThirtyOnePlayer, startThirtyOne, thirtyOneAct, thirtyOneView, thirtyOneIsTurn,
} from './thirtyone.js';
import { thirtyOneNextAutomatic } from './thirtyone-bot.js';

export const GAMES = {
  cribbage: {
    name: 'Cribbage',
    minPlayers: 2,
    maxPlayers: 4,
    canStartEarly: false,
    create: ({ id, numPlayers, settings = {} }) => createGame({ id, numPlayers, teams: settings.teams !== false }),
    addPlayer,
    start: () => {
      throw new RuleError('Cribbage starts when every seat is taken');
    },
    act(state, seat, action) {
      if (action?.type === 'discard') return discard(state, seat, action.cards);
      if (action?.type === 'play') return play(state, seat, String(action.card));
      throw new RuleError('Unknown move');
    },
    nextAutomatic,
    view: viewFor,
    isTurn,
    sideOf,
  },
  holdem: {
    name: 'Texas Hold’em',
    minPlayers: 2,
    maxPlayers: 9,
    canStartEarly: true,
    create: ({ id, numPlayers, settings }) => createHoldem({ id, maxPlayers: numPlayers, settings }),
    addPlayer: addHoldemPlayer,
    start: startHoldem,
    act: holdemAct,
    nextAutomatic: holdemNextAutomatic,
    view: holdemView,
    isTurn: holdemIsTurn,
    sideOf: (state, seat) => seat,
  },
  thirtyone: {
    name: 'Thirty-One',
    minPlayers: 2,
    maxPlayers: 8,
    canStartEarly: true,
    create: ({ id, numPlayers, settings }) => createThirtyOne({ id, maxPlayers: numPlayers, settings }),
    addPlayer: addThirtyOnePlayer,
    start: startThirtyOne,
    act: thirtyOneAct,
    nextAutomatic: thirtyOneNextAutomatic,
    view: thirtyOneView,
    isTurn: thirtyOneIsTurn,
    sideOf: (state, seat) => seat,
  },
};

export const typeOf = (state) => state.type ?? 'cribbage';
export const gameFor = (state) => GAMES[typeOf(state)];

export function gameModule(type) {
  const g = GAMES[type ?? 'cribbage'];
  if (!g) throw new RuleError('Unknown game');
  return g;
}

/** Settings worth carrying into a rematch. */
export const rematchSettings = (state) =>
  typeOf(state) === 'cribbage' ? { teams: state.teams ?? state.numPlayers === 4 } : state.settings;
