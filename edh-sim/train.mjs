// Trains the neural network by self-play.
// Each generation plays a batch of four-player games. Every spell cast is recorded with what the board
// looked like and who went on to win. The network learns to predict, from the board plus a card, the
// chance that player wins: V (board only) and Q (board + the card just cast). Q − V is how much a card
// helps right then, and the AI uses it when choosing what to cast, what to tutor for and what to discard.
// A second, smaller network learns which opening hands win, for mulligans. The next generation plays
// with what the last one learned (plus a little randomness so it keeps seeing new lines).
// At the end, an A/B test plays games where one seat uses the network and the others don't.
// Games are played on worker processes, one per core (--cores, default all but one); the main process picks every
// game's pod and seed exactly as a single process would, and trains on the results in order.
// Usage: node train.mjs [--gens 4] [--games 500] [--ab 400] [--fresh] [--cores 9]
import fs from 'node:fs';
import os from 'node:os';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { Game, rng } = require('./src/engine.js');
const { MLP } = require('./src/nn.js');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? +process.argv[i + 1] : d; };
const GENS = arg('gens', 4), N = arg('games', 500), AB = arg('ab', 400), fresh = process.argv.includes('--fresh');
const CORES = Math.max(1, arg('cores', os.cpus().length - 1));
const OUT = 'data/nn.json';
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const ids = fs.readdirSync('decks').filter((f) => f.endsWith('.txt')).map((f) => f.replace('.txt', '')).sort();
const decks = ids.map((id) => ({ id, name: id, ...parseDeck(fs.readFileSync(`decks/${id}.txt`, 'utf8')) }));
const vocab = [...new Set(decks.flatMap((d) => [d.commander, ...d.cards.map((c) => c.name)]))].sort();
const vIdx = new Map(vocab.map((n, i) => [n, i]));
const nDense = Game.NN_STATE + Game.NN_CARD + 1 + ids.length;
const nHand = 11 + ids.length;

const deckOneHot = (id) => ids.map((x) => (x === id ? 1 : 0));
function toQ(s, y) {
  const d = s.st.concat(s.card, [0], deckOneHot(s.deck));
  const v = s.st.concat(new Array(Game.NN_CARD).fill(0), [1], deckOneHot(s.deck));
  const k = vIdx.get(s.name);
  return [{ d, s: k != null ? [k] : [], y }, { d: v, s: [], y, w: 0.5 }];
}
// one game, as a worker plays it: { pod: [deck ids], seed, explore, nnSeats, collect }
function playOne(spec, nn) {
  const pod = spec.pod.map((id) => decks.find((d) => d.id === id));
  const game = new Game(pod, db, spec.seed, { record: false, collect: !!spec.collect, nn, explore: spec.explore || 0, nnSeats: spec.nnSeats }).run();
  const r = { winner: game.winner, runaway: !!game.runaway };
  if (spec.collect) {
    const y = (seat) => (game.winner === seat ? 1 : game.winner == null ? 0.25 : 0);
    r.out = game.samples.flatMap((x) => toQ(x, y(x.seat)));
    r.hands = game.mullSamples.map((h) => ({ d: h.d.slice(0, 11).concat(deckOneHot(h.deck)), s: h.names.map((nm) => vIdx.get(nm)).filter((k) => k != null), y: y(h.seat) }));
  }
  return r;
}
if (process.env.TRAIN_WORKER) {
  let nnKey = null, nnObj = null;
  process.on('message', (job) => {
    if (job.nnKey !== nnKey) { nnKey = job.nnKey; nnObj = job.nn ? Game.loadNN(job.nn) : null; }
    if (job.nn === undefined && job.nnKey == null) nnObj = null;
    process.send({ id: job.id, res: job.specs.map((sp) => playOne(sp, nnObj)) });
  });
}
// the worker pool: games go out in small chunks to whichever worker is free; results come back in order
// Watchdog: a chunk that takes longer than WATCHDOG minutes means a game is stuck in a loop the engine's own limit
// doesn't see. That worker is killed and replaced, the chunk's games count as draws (logged by seed), and training
// goes on: a run can't hang again, whatever the bug.
const WATCHDOG = arg('watchdog', 10);
let workers = null;
const spawn = () => fork(new URL(import.meta.url).pathname, process.argv.slice(2), { env: { ...process.env, TRAIN_WORKER: '1' }, serialization: 'advanced' });
function runGames(specs, nn, nnKey, label) {
  if (!workers) workers = Array.from({ length: CORES }, spawn);
  const res = new Array(specs.length), CH = 10;
  let next = 0, done = 0, shown = 0;
  return new Promise((resolve) => {
    const finish = (id, list) => {
      list.forEach((r, i) => (res[id + i] = r)); done += list.length;
      while (label && done - shown >= 100) { shown += 100; process.stdout.write(`    ${shown}/${specs.length} ${label}\n`); }
      if (done >= specs.length) resolve(res);
    };
    const give = (k) => {
      if (next >= specs.length) return;
      const id = next, chunk = specs.slice(id, id + CH); next += CH;
      const w = workers[k];
      const timer = setTimeout(() => {
        w.removeAllListeners('message'); w.kill('SIGKILL');
        console.log(`    watchdog: games ${chunk[0].seed}-${chunk[chunk.length - 1].seed} took over ${WATCHDOG} min (a loop); counted as draws (${chunk.map((sp) => sp.pod.join('/')).slice(0, 1)}...)`);
        workers[k] = spawn(); // (it loads the network from its first job)
        finish(id, chunk.map(() => ({ winner: null, runaway: true, out: [], hands: [] })));
        give(k);
      }, WATCHDOG * 60000);
      w.once('message', (m) => { clearTimeout(timer); finish(m.id, m.res); give(k); });
      w.send({ id, specs: chunk, nn, nnKey });
    };
    workers.forEach((_, k) => give(k));
  });
}
async function main() {
let prev = !fresh && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
if (prev && (prev.vocab.length !== vocab.length || prev.q.nDense !== nDense)) { console.log('Card pool or features changed: starting fresh.'); prev = null; }
let q = prev ? MLP.fromJSON(prev.q) : new MLP(nDense, vocab.length, [48, 24], 7);
let m = prev && prev.m ? MLP.fromJSON(prev.m) : new MLP(nHand, vocab.length, [16], 11);
const history = prev ? prev.history || [] : [];
let gen = prev ? prev.generation : 0;
const buffer = []; // last few generations of samples
const R = rng(1234 + gen);

async function play(n, seed0, nn, explore) {
  const out = [], hands = [], wins = Object.fromEntries(ids.map((id) => [id, [0, 0]]));
  const specs = [];
  for (let g = 0; g < n; g++) specs.push({ pod: R.shuffle(decks.slice()).slice(0, 4).map((d) => d.id), seed: seed0 + g, explore, collect: true });
  const res = await runGames(specs, nn, nn ? 'gen' + seed0 : null, 'games');
  res.forEach((r, g) => {
    const sp = specs[g];
    if (r.runaway) console.log(`    game ${sp.seed} got stuck in a loop and was called a draw (${sp.pod.join(', ')})`);
    out.push(...r.out); hands.push(...r.hands);
    sp.pod.forEach((id, seat) => { wins[id][1]++; if (r.winner === seat) wins[id][0]++; });
  });
  return { out, hands, wins };
}
function fit(net, data, epochs, lr) {
  const idx = data.map((_, i) => i);
  const split = Math.floor(data.length * 0.9);
  R.shuffle(idx);
  const tr = idx.slice(0, split).map((i) => data[i]), va = idx.slice(split).map((i) => data[i]);
  for (let e = 0; e < epochs; e++) { R.shuffle(tr); for (let i = 0; i < tr.length; i += 64) net.trainBatch(tr.slice(i, i + 64), lr); }
  // validation: log loss of the net vs always guessing the average
  const mean = tr.reduce((a, x) => a + x.y, 0) / tr.length;
  let L = 0, L0 = 0, W = 0;
  for (const x of va) { const w = x.w ?? 1; const p = net.forward(x.d, x.s); L += -w * (x.y * Math.log(p + 1e-7) + (1 - x.y) * Math.log(1 - p + 1e-7)); L0 += -w * (x.y * Math.log(mean) + (1 - x.y) * Math.log(1 - mean)); W += w; }
  return { loss: L / W, base: L0 / W };
}
const pack = () => ({ q: q.toJSON(), m: m.toJSON(), vocab, decks: ids });

const t0 = Date.now();
let base = prev ? prev.base : {};
for (let k = 0; k < GENS; k++) {
  gen++;
  const nn = gen > 1 || prev ? { ...pack(), base, generation: gen - 1 } : null; // (as JSON: each worker loads it)
  console.log(`Generation ${gen}: playing ${N} games ${nn ? 'with the network' : 'with the plain heuristics'} on ${CORES} cores...`);
  const { out, hands, wins } = await play(N, 100000 * gen, nn, 6);
  buffer.push({ out, hands }); if (buffer.length > 3) buffer.shift();
  base = Object.fromEntries(ids.map((id) => [id, wins[id][1] ? wins[id][0] / wins[id][1] : 0.25]));
  const qs = fit(q, buffer.flatMap((b) => b.out), 4, 0.002);
  const ms = fit(m, buffer.flatMap((b) => b.hands), 6, 0.003);
  history.push({ gen, games: N, samples: out.length, qLoss: +qs.loss.toFixed(4), qBase: +qs.base.toFixed(4), mLoss: +ms.loss.toFixed(4), mBase: +ms.base.toFixed(4) });
  console.log(`  win-chance network: validation loss ${qs.loss.toFixed(4)} vs ${qs.base.toFixed(4)} guessing the average; hand network ${ms.loss.toFixed(4)} vs ${ms.base.toFixed(4)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// What the network learned about each card: average advantage (Q − V) over the times it was cast
const nnAll = Game.loadNN({ ...pack(), base, generation: gen });
const adv = {};
for (const b of buffer) for (let i = 0; i < b.out.length; i += 2) {
  const s = b.out[i], v = b.out[i + 1];
  if (!s.s.length) continue;
  const name = vocab[s.s[0]], deck = ids[s.d.slice(-ids.length).indexOf(1)];
  const a = nnAll.q.forward(s.d, s.s) - nnAll.q.forward(v.d, v.s);
  const k = (adv[deck] = adv[deck] || {})[name] || (adv[deck][name] = { n: 0, sum: 0 });
  k.n++; k.sum += a;
}
const insights = Object.fromEntries(Object.entries(adv).map(([deck, cards]) => {
  const list = Object.entries(cards).filter(([, k]) => k.n >= 8).map(([name, k]) => ({ name, adv: +(k.sum / k.n).toFixed(4), n: k.n })).sort((a, b) => b.adv - a.adv);
  return [deck, { best: list.slice(0, 10), worst: list.slice(-5).reverse() }];
}));

// A/B test: one random seat lets the network steer, the other three use the plain heuristics
console.log(`A/B test: ${AB} games, one seat with the network...`);
const S = Object.fromEntries(ids.map((id) => [id, { on: 0, onW: 0, off: 0, offW: 0 }]));
const abSpecs = [];
for (let g = 0; g < AB; g++) { const pod = R.shuffle(decks.slice()).slice(0, 4).map((d) => d.id); const seat = Math.floor(R() * 4); abSpecs.push({ pod, seed: 900000 + g, nnSeats: [seat] }); }
const abRes = await runGames(abSpecs, { ...pack(), base, generation: gen }, 'final', 'A/B games');
abRes.forEach((r, g) => { const { pod, nnSeats: [seat] } = abSpecs[g]; pod.forEach((id, i) => { const s = S[id]; if (i === seat) { s.on++; if (r.winner === i) s.onW++; } else { s.off++; if (r.winner === i) s.offW++; } }); });
let on = 0, onW = 0, off = 0, offW = 0;
for (const id of ids) { const s = S[id]; on += s.on; onW += s.onW; off += s.off; offW += s.offW; }
const ab = { games: AB, on: +(onW / on).toFixed(4), off: +(offW / off).toFixed(4), decks: Object.fromEntries(ids.map((id) => [id, { on: S[id].on ? +(S[id].onW / S[id].on).toFixed(3) : null, off: S[id].off ? +(S[id].offW / S[id].off).toFixed(3) : null, n: S[id].on }])) };
history[history.length - 1].ab = { on: ab.on, off: ab.off };
for (const id of ids) { const s = S[id]; console.log(`  ${id.padEnd(10)} with network ${(s.onW / Math.max(1, s.on) * 100).toFixed(1).padStart(5)}% (${s.on} games)  without ${(s.offW / Math.max(1, s.off) * 100).toFixed(1).padStart(5)}%`); }
console.log(`  ALL        with network ${(ab.on * 100).toFixed(1)}%  without ${(ab.off * 100).toFixed(1)}%  (${ab.on >= ab.off ? '+' : ''}${((ab.on - ab.off) * 100).toFixed(1)} points; 25% is an even share)`);

fs.writeFileSync(OUT, JSON.stringify({ generation: gen, games: (prev ? prev.games : 0) + GENS * N, when: new Date().toISOString(), ...pack(), base, history, insights, ab }));
console.log(`Wrote ${OUT} (generation ${gen}, ${((Date.now() - t0) / 1000).toFixed(0)}s).`);
for (const w of workers || []) w.kill();
}

if (!process.env.TRAIN_WORKER) await main();
