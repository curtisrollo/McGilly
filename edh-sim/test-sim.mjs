// Quick headless check: node test-sim.mjs [games] [--log]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { simulate, rng } = require('./src/engine.js');
const PR = rng(42);
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const decks = fs.readdirSync('decks').filter(f => f.endsWith('.txt')).map(f => ({ id: f.replace('.txt',''), ...parseDeck(fs.readFileSync('decks/' + f, 'utf8')) }));
decks.forEach(d => d.name = d.commander.split(',')[0]);
const N = +process.argv[2] || 50;
const wins = {}, played = {}; let rounds = 0, draws = 0, errors = 0;
for (let g = 0; g < N; g++) {
  const pick = PR.shuffle([...decks]).slice(0, 4); if (process.env.ONLY && +process.env.ONLY !== g) continue;
  try { if (process.env.G) console.error("game", g);
    const game = simulate(pick, db, 1000 + g, { record: process.argv.includes('--log') });
    pick.forEach(d => played[d.name] = (played[d.name] || 0) + 1);
    if (game.winner == null) draws++; else { const w = pick[game.winner].name; wins[w] = (wins[w] || 0) + 1; }
    rounds += game.round;
    if (process.argv.includes('--log') && g === 0) { for (const e of game.events) console.log(`[${e.turn}] ${e.text}`); console.log('events', game.events.length, 'json size', JSON.stringify(game.events).length); }
  } catch (e) { errors++; if (errors < 4) console.error(e.stack); }
}
console.log({ wins, played, avgRounds: (rounds / N).toFixed(1), draws, errors });
