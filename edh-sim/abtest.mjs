// Does learning help? In each game one random seat uses the learned priorities (data/learned.json)
// and the other three don't. Compares each deck's win rate with and without learning.
// Usage: node abtest.mjs [games=800]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { Game, rng } = require('./src/engine.js');
const N = +process.argv.find((a) => /^\d+$/.test(a)) || 800;
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const learned = JSON.parse(fs.readFileSync('data/learned.json', 'utf8'));
const ids = fs.readdirSync('decks').filter((f) => f.endsWith('.txt')).map((f) => f.replace('.txt', ''));
const decks = ids.map((id) => ({ id, name: id, ...parseDeck(fs.readFileSync(`decks/${id}.txt`, 'utf8')) }));
const R = rng(777);
const S = Object.fromEntries(ids.map((id) => [id, { on: 0, onWins: 0, off: 0, offWins: 0 }]));
for (let g = 0; g < N; g++) {
  const pod = R.shuffle(decks.slice()).slice(0, 4);
  const seat = R.int(4);
  const game = new Game(pod, db, 500000 + g, { record: false, learned: learned.decks, learnSeats: [seat] }).run();
  pod.forEach((d, i) => { const s = S[d.id]; if (i === seat) { s.on++; if (game.winner === i) s.onWins++; } else { s.off++; if (game.winner === i) s.offWins++; } });
}
let on = 0, onW = 0, off = 0, offW = 0;
console.log(`Generation ${learned.generation}, ${N} games. Win rate with learning vs without:`);
for (const id of ids) {
  const s = S[id]; on += s.on; onW += s.onWins; off += s.off; offW += s.offWins;
  const a = s.onWins / Math.max(1, s.on), b = s.offWins / Math.max(1, s.off);
  console.log(`  ${id.padEnd(10)} ${(a * 100).toFixed(1).padStart(5)}% (${s.on} games)  vs  ${(b * 100).toFixed(1).padStart(5)}%   ${a >= b ? '+' : ''}${((a - b) * 100).toFixed(1)}`);
}
const a = onW / on, b = offW / off;
console.log(`  ALL        ${(a * 100).toFixed(1)}%  vs  ${(b * 100).toFixed(1)}%   ${a >= b ? '+' : ''}${((a - b) * 100).toFixed(1)} points`);
fs.writeFileSync('data/abtest.json', JSON.stringify({ generation: learned.generation, games: N, on: a, off: b, decks: S }));
