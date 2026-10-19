// Fair network comparison: the same fixed-seed games, one seat (random) steered by the network, the rest without.
// Run it for each network (and "none") and compare the win rates: same pods, seats and seeds every time.
//   node compare-nets.mjs data/nn.json [games=2000] [--cores 9]      node compare-nets.mjs none
import fs from 'node:fs';
import os from 'node:os';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { Game, rng } = require('./src/engine.js');

const args = process.argv.slice(2);
const nnPath = args[0] || 'data/nn.json', total = +args.find((a, i) => i > 0 && /^\d+$/.test(a)) || 2000;
const cores = args.includes('--cores') ? +args[args.indexOf('--cores') + 1] : Math.max(1, os.cpus().length - 1);
const ids = fs.readdirSync('decks').filter((f) => f.endsWith('.txt')).map((f) => f.replace('.txt', '')).sort();

if (process.env.COMPARE_SLICE) {
  const [slice, slices] = process.env.COMPARE_SLICE.split(',').map(Number);
  const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
  const decks = ids.map((id) => ({ id, name: id, ...parseDeck(fs.readFileSync(`decks/${id}.txt`, 'utf8')) }));
  const nn = nnPath === 'none' ? null : Game.loadNN(JSON.parse(fs.readFileSync(nnPath, 'utf8')));
  if (nnPath !== 'none' && !nn) { process.send({ error: 'network did not load (trained on different board features)' }); process.exit(1); }
  const R = rng(777); let w = 0, n = 0;
  for (let g = 0; g < total; g++) {
    const pod = R.shuffle(decks.slice()).slice(0, 4); const seat = Math.floor(R() * 4);
    if (g % slices !== slice) continue;
    const game = new Game(pod, db, 900000 + g, { record: false, nn, nnSeats: [seat] }).run();
    n++; if (game.winner === seat) w++;
  }
  process.send({ w, n });
} else {
  let w = 0, n = 0;
  await Promise.all(Array.from({ length: cores }, (_, k) => new Promise((res) => {
    const ch = fork(new URL(import.meta.url).pathname, args, { env: { ...process.env, COMPARE_SLICE: `${k},${cores}` } });
    ch.on('message', (m) => { if (m.error) console.log(m.error); else { w += m.w; n += m.n; } });
    ch.on('exit', res);
  })));
  console.log(`${nnPath}: the network's seat won ${w}/${n} = ${(100 * w / n).toFixed(1)}% (decks: ${ids.join(', ')}; 25% is an even share)`);
}
