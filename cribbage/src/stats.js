// Win/loss records from finished games. Pure: give it game states, get a
// leaderboard. Shared by the server and the in-browser demo.
//
// Rules:
// - Only seats with a playerId (humans who've opened the app since player
//   keys existed) get a record. Bots appear only as opponents.
// - Team games: a win counts for both partners.
// - 3- and 4-player games: the winner beats everyone; losers don't record a
//   result against each other.
// - Games against people and games against bots are counted separately.
import { sideOf as cribbageSide } from './engine.js';

// Hold'em seats play alone; cribbage may have teams.
const sideOf = (g, seat) => (g.type === 'holdem' ? seat : cribbageSide(g, seat));

export function computeStats(games) {
  const players = new Map();
  const player = (id, name, at) => {
    let p = players.get(id);
    if (!p) {
      p = { id, name, lastPlayed: 0, wins: 0, losses: 0, botWins: 0, botLosses: 0, skunks: 0, opponents: new Map() };
      players.set(id, p);
    }
    if (at >= p.lastPlayed) {
      p.lastPlayed = at;
      p.name = name; // show the name they used most recently
    }
    return p;
  };

  for (const g of games) {
    if (g.status !== 'finished' || g.winner == null) continue;
    const at = g.finishedAt ?? g.updatedAt ?? 0;
    g.players.forEach((seat, i) => {
      if (seat.bot || !seat.playerId) return;
      const me = player(seat.playerId, seat.name, at);
      const mySide = sideOf(g, i);
      const won = mySide === g.winner;
      const others = g.players.map((o, j) => ({ o, j })).filter(({ j }) => sideOf(g, j) !== mySide);
      const vsPeople = others.some(({ o }) => !o.bot);

      if (vsPeople) won ? me.wins++ : me.losses++;
      else won ? me.botWins++ : me.botLosses++;

      const skunked = new Set(); // losing sides below 91, counted once per side (teams have two seats)
      for (const { o, j } of others) {
        const key = o.bot ? `bot:${o.name}` : o.playerId ?? `name:${o.name.toLowerCase()}`;
        let rec = me.opponents.get(key);
        if (!rec) {
          rec = { key, name: o.name, bot: !!o.bot, wins: 0, losses: 0, lastPlayed: 0 };
          me.opponents.set(key, rec);
        }
        if (at >= rec.lastPlayed) {
          rec.lastPlayed = at;
          rec.name = o.name;
        }
        if (won) {
          rec.wins++;
          if (g.scores && g.scores[sideOf(g, j)] < 91) skunked.add(sideOf(g, j)); // cribbage only
        } else if (sideOf(g, j) === g.winner) {
          rec.losses++;
        }
      }
      me.skunks += skunked.size;
    });
  }

  return [...players.values()]
    .map((p) => {
      const games = p.wins + p.losses;
      return {
        id: p.id,
        name: p.name,
        lastPlayed: p.lastPlayed,
        wins: p.wins,
        losses: p.losses,
        winRate: games ? p.wins / games : null,
        botWins: p.botWins,
        botLosses: p.botLosses,
        skunks: p.skunks,
        opponents: [...p.opponents.values()]
          .map(({ key, ...o }) => o)
          .sort((a, b) => b.wins + b.losses - (a.wins + a.losses) || b.wins - a.wins),
      };
    })
    .sort((a, b) => b.wins - a.wins || (b.winRate ?? -1) - (a.winRate ?? -1) || b.lastPlayed - a.lastPlayed);
}
