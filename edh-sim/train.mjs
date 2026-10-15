// Learns which cards matter from simulated games.
// Plays many four-player games, credits every result to the card that caused it, and compares
// each deck's win rate when a card was cast against its win rate overall. The result,
// data/learned.json, is used by the AI to decide what to cast first, what to tutor for and
// which opening hands to keep. Run it again and the AI trains on games played with what it
// already learned.
// Usage: node train.mjs [games=1200] [--fresh]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { Game, rng } = require('./src/engine.js');

const N = +process.argv.find((a) => /^\d+$/.test(a)) || 1200;
const fresh = process.argv.includes('--fresh');
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const ids = fs.readdirSync('decks').filter((f) => f.endsWith('.txt')).map((f) => f.replace('.txt', ''));
const decks = ids.map((id) => ({ id, name: id, ...parseDeck(fs.readFileSync(`decks/${id}.txt`, 'utf8')) }));
const OUT = 'data/learned.json';
const prev = !fresh && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;

// per deck: games, wins; per deck+card: drawn (seen), cast, winsWhenCast, value totals
const D = Object.fromEntries(ids.map((id) => [id, { games: 0, wins: 0, cards: {} }]));
const R = rng(prev ? (prev.generation || 1) * 7919 : 4242);
const t0 = Date.now();
for (let g = 0; g < N; g++) {
  const pod = R.shuffle(decks.slice()).slice(0, 4);
  const game = new Game(pod, db, 100000 + (prev ? prev.generation * N : 0) + g, { record: false, learned: prev && prev.decks }).run();
  pod.forEach((d, seat) => {
    const dd = D[d.id];
    dd.games++;
    const won = game.winner === seat;
    if (won) dd.wins++;
    const seen = new Set();
    for (const c of game.casts) if (c.seat === seat && !seen.has(c.name)) {
      seen.add(c.name);
      const k = dd.cards[c.name] || (dd.cards[c.name] = { cast: 0, wins: 0, value: 0, dmg: 0, cards: 0, tokens: 0, removed: 0, mana: 0, turn: 0 });
      k.cast++; if (won) k.wins++; k.turn += c.turn;
    }
    for (const st of Object.values(game.stats)) if (st.seat === seat && !st.token && dd.cards[st.name]) {
      const k = dd.cards[st.name];
      k.value += Game.cardValue(st);
      for (const f of ['dmg', 'cards', 'tokens', 'removed', 'mana']) k[f] += st[f] || 0;
    }
  });
  if ((g + 1) % 200 === 0) process.stdout.write(`  ${g + 1}/${N} games (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
}

// Turn counts into priorities. "lift" = how much more often the deck wins when it casts the card,
// shrunk toward zero for cards seen only a few times; "impact" = average value produced per game cast.
const out = { generation: (prev ? prev.generation : 0) + 1, games: N + (prev ? prev.games : 0), when: new Date().toISOString(), decks: {} };
for (const id of ids) {
  const dd = D[id];
  const base = dd.wins / Math.max(1, dd.games);
  const K = 12; // smoothing strength
  const cards = {};
  const impacts = Object.values(dd.cards).map((k) => k.value / k.cast);
  const meanImpact = impacts.reduce((a, b) => a + b, 0) / Math.max(1, impacts.length);
  for (const [name, k] of Object.entries(dd.cards)) {
    const rate = (k.wins + K * base) / (k.cast + K);
    const lift = rate - base;
    const impact = k.value / k.cast;
    // blend with the previous generation so learning is steady rather than jumpy
    const old = prev && prev.decks[id] && prev.decks[id].cards[name];
    const n = old ? old.n + k.cast : k.cast;
    const blend = (a, b, wa, wb) => (a * wa + b * wb) / Math.max(1, wa + wb);
    const L = old ? blend(old.lift, lift, old.n, k.cast) : lift;
    const I = old ? blend(old.impact, impact, old.n, k.cast) : impact;
    const pri = Math.max(-1, Math.min(1, L * 4 + (I - meanImpact) / Math.max(4, meanImpact * 2)));
    cards[name] = { n, lift: +L.toFixed(4), impact: +I.toFixed(2), pri: +pri.toFixed(3), avgTurn: +(k.turn / k.cast).toFixed(1),
      per: { dmg: +(k.dmg / k.cast).toFixed(1), cards: +(k.cards / k.cast).toFixed(1), tokens: +(k.tokens / k.cast).toFixed(1), removed: +(k.removed / k.cast).toFixed(1), mana: +(k.mana / k.cast).toFixed(1) } };
  }
  const oldDeck = prev && prev.decks[id];
  out.decks[id] = { games: dd.games + (oldDeck ? oldDeck.games : 0), winRate: +(((dd.wins + (oldDeck ? oldDeck.winRate * oldDeck.games : 0)) / (dd.games + (oldDeck ? oldDeck.games : 0)))).toFixed(4), cards };
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`\nGeneration ${out.generation}: learned from ${N} games (${out.games} total) in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
for (const id of ids) {
  const top = Object.entries(out.decks[id].cards).filter(([, c]) => c.n >= 15).sort((a, b) => b[1].pri - a[1].pri).slice(0, 5);
  console.log(`  ${id.padEnd(10)} win ${(out.decks[id].winRate * 100).toFixed(1)}%  best: ${top.map(([n, c]) => `${n} (${c.lift >= 0 ? '+' : ''}${(c.lift * 100).toFixed(0)}%)`).join(', ')}`);
}
