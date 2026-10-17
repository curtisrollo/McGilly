// Mistake-finder: plays games with the normal AI while a slower judge re-checks a sample of its decisions.
// At a main-phase or attack decision the judge copies the game, lets the AI play on, then tries every option on the
// copy several times (different draws each time), plays to the start of the player's next turn and scores the board
// (lookValue). When the best option beats what the AI did by a clear margin, the decision is logged with seed and turn.
// The real game is not changed, so every logged seed replays the same on the page.
//   node mistakes.mjs [games] [--cores 8] [--sample 0.15] [--playouts 3] [--seed 1]   -> data/mistakes.json + summary
import fs from 'node:fs';
import os from 'node:os';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { Game, rng } = require('./src/engine.js');

const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? +args[args.indexOf(name) + 1] : d);
const N = +args.find((a) => /^\d+$/.test(a)) || 100;
const CORES = opt('--cores', Math.max(1, os.cpus().length - 2));
const SAMPLE = opt('--sample', 0.15), K = opt('--playouts', 3), SEED = opt('--seed', 1);
const MARGIN = 15; // lookValue points: about a card and a creature, or a quarter of knocking a player out

const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const order = ['edgar', 'kaalia', 'beledros', 'atraxa', 'osgir', 'myrkul', 'muldrotha'];
const decks = order.filter((id) => fs.existsSync(`decks/${id}.txt`)).map((id) => { const d = parseDeck(fs.readFileSync(`decks/${id}.txt`, 'utf8')); return { id, name: d.commander.split(',')[0].split(' ')[0], ...d }; });
const NN = fs.existsSync('data/nn.json') ? Game.loadNN(JSON.parse(fs.readFileSync('data/nn.json', 'utf8'))) : null;

// how a card makes its value (the roles mistakes are grouped by)
function roles(c) {
  if (!c) return '';
  const i = c.info, r = [];
  if (i.mana) r.push('mana');
  if (i.statics && i.statics.length) r.push('static');
  if (i.activated && i.activated.length) r.push('activated');
  if ((i.triggers && i.triggers.length) || (i.deathWatch && i.deathWatch.length) || (i.attack && i.attack.length)) r.push('trigger');
  if (i.etb && i.etb.length) r.push('etb');
  if (i.isCreature && !r.length) r.push('body');
  if (!i.isPermanent) r.push('spell');
  return r.join('+');
}

// play a copy on to the start of `seat`'s next turn (or the end of the game)
function untilTurnOf(g, seat) {
  for (let guard = 0; guard < 8 && !g.over; guard++) {
    do { g.active = (g.active + 1) % g.players.length; } while (g.P(g.active).lost && !g.over);
    if (g.over || g.active === seat) break;
    g.takeTurn(g.P(g.active), false);
  }
}
// k playouts; playout i of every option uses the same shuffled libraries (same luck), so options are compared fairly
function score(base, seat, play, k0 = 0, n = K) {
  let t = 0;
  for (let k = k0; k < k0 + n; k++) {
    try {
      base._lookN = 1000 + k; const g = base.cloneForLook(), pp = g.players[seat];
      if (play(g, pp) === false) return -Infinity;
      if (!g.over && !pp.lost) untilTurnOf(g, seat);
      const v = g.lookValue(g, seat); t += Math.abs(v) >= 1000 ? v : Math.max(-900, Math.min(900, v)); // a win or loss always outweighs a huge board
    } catch (e) { return -Infinity; }
  }
  return t / n;
}
const describe = (g, c) => (c ? g.cname ? g.cname(c) : c.info.name : '?');

function judgeMain(base, seat, second, ai) {
  const p = base.players[seat];
  const used = base._usedAbilities && base._usedAbilities.turn === base.turn ? base._usedAbilities.set : new Set();
  const next = second ? 'end' : 'combat', cont = second ? 'main 2' : 'main';
  const cands = [{ kind: 'pass', act: 'pass', label: second ? 'end the turn' : 'go to combat' }];
  for (const o of base.castOptions(p).slice(0, 5)) cands.push({ kind: 'cast', act: 'cast', id: o.c.id, from: o.from, gyType: o.gyType, label: `cast ${o.c.info.name}`, card: o.c });
  for (const a of base.abilityOptions(p, second, used, true).slice(0, 5)) cands.push({ kind: 'ability', act: 'use ability', key: a.key, label: `use ${a.c.info.name}`, card: a.c });
  if (ai.kind === 'cast' && !cands.some((c) => c.kind === 'cast' && c.id === ai.id)) cands.push({ ...ai, act: 'cast', card: base.cards[ai.id], label: `cast ${base.cards[ai.id].info.name}` });
  if (ai.kind === 'ability' && !cands.some((c) => c.key === ai.key)) return null; // something the candidate list can't express (a combo routine)
  const run = (cd, k0, n) => score(base, seat, (g, pp) => {
    const u = new Set(used); g._usedAbilities = { turn: g.turn, set: u };
    if (cd.kind === 'cast') { const c = g.cards[cd.id]; if (!c || !g.castSpell(pp, c, cd.from, cd.gyType)) return false; g.playLand(pp); }
    else if (cd.kind === 'ability') { const a = g.abilityOptions(pp, second, u, true).find((x) => x.key === cd.key); if (!a) return false; u.add(a.key); g.doActivate(pp, a); }
    if (g.over || pp.lost) return;
    g.restOfTurn(pp, cd.kind === 'pass' ? next : cont);
  }, k0, n);
  for (const cd of cands) { cd.v = run(cd); cd.run = run; }
  const mine = cands.find((cd) => cd.kind === ai.kind && (cd.kind === 'pass' || cd.id === ai.id || cd.key === ai.key));
  return mine ? { cands, mine } : null;
}

function judgeAttack(base, seat, ai) {
  const p = base.players[seat];
  const q = ai.target != null ? ai.target : (base.chooseDefender(p, p.bf.filter((c) => base.canAttack(c))) || {}).seat;
  if (q == null) return null;
  const able = p.bf.filter((c) => base.canAttack(c)).map((c) => c.id);
  const plans = [{ ids: ai.ids, act: ai.ids.length ? 'attack' : 'no attack', label: ai.ids.length ? `attack with ${ai.ids.map((id) => base.cards[id].info.name).join(', ')}` : 'no attack' }, { ids: [], act: 'no attack', label: 'no attack' }, { ids: able, act: 'attack with everything', label: 'attack with everything' }];
  for (const id of ai.ids) plans.push({ ids: ai.ids.filter((x) => x !== id), act: 'hold back', label: `keep ${base.cards[id].info.name} home`, card: base.cards[id] });
  for (const id of able) if (!ai.ids.includes(id)) plans.push({ ids: ai.ids.concat(id), act: 'also attack', label: `also attack with ${base.cards[id].info.name}`, card: base.cards[id] });
  const seen = new Set(), cands = [];
  for (const pl of plans) { const k = pl.ids.slice().sort().join(','); if (seen.has(k)) continue; seen.add(k); cands.push({ kind: 'attack', ...pl }); }
  if (cands.length < 2) return null;
  const run = (cd, k0, n) => score(base, seat, (g, pp) => { g._forcedAtk = { q, ids: cd.ids }; g.phase = 'combat'; g.combat(pp); g._forcedAtk = null; if (!g.over && !pp.lost) g.restOfTurn(pp, 'main 2'); }, k0, n);
  for (const cd of cands) { cd.v = run(cd); cd.run = run; }
  return { cands, mine: cands[0] };
}

function playGame(gi) {
  const PR = rng(SEED * 1000003 + gi);
  const pod = PR.shuffle(decks.slice()).slice(0, 4), seed = SEED * 100000 + gi;
  const g = new Game(pod, db, seed, { nn: NN });
  const out = [], JR = rng(seed ^ 0x5bd1e995);
  const keepLook = () => g._lookN;
  const record = (kind, seat, res) => {
    if (!res) return;
    const best = res.cands.reduce((a, b) => (b.v > a.v ? b : a));
    if (!(best.v - res.mine.v >= MARGIN) || !isFinite(best.v - res.mine.v)) return;
    // re-check: 8 more playouts of both on new draws; keep it only if the gap holds up over all of them
    const n2 = 8, vb = (best.v * K + best.run(best, K, n2) * n2) / (K + n2), vm = (res.mine.v * K + res.mine.run(res.mine, K, n2) * n2) / (K + n2);
    const regret = vb - vm;
    if (!(regret >= MARGIN) || !isFinite(regret)) return;
    out.push({ seed, pod: pod.map((d) => d.id), deck: pod[seat].id, round: g.round, turn: g.turn, phase: g.phase, kind, regret: Math.round(regret),
      ai: res.mine.label, aiAct: res.mine.act, aiRoles: roles(res.mine.card), best: best.label, bestAct: best.act, bestRoles: roles(best.card), life: g.players[seat].life,
      options: res.cands.map((c) => `${c.label}: ${isFinite(c.v) ? c.v.toFixed(1) : 'n/a'}`) });
  };
  // main phase: snapshot, let the AI act, note its first action, judge on the snapshot
  const origMain = g.mainPhase.bind(g);
  g.mainPhase = function (p, second = false) {
    if (this._judging || second === 'again' || p.seat !== this.active || JR() > SAMPLE) return origMain(p, second);
    const n0 = keepLook(); this._judging = true; const base = this.cloneForLook(); this._lookN = n0;
    let ai = null; const oc = this.castSpell, oa = this.doActivate;
    this.castSpell = (pp, c, from, gyType) => { if (!ai && pp === p) ai = { kind: 'cast', id: c.id, from, gyType }; return oc.call(this, pp, c, from, gyType); };
    this.doActivate = (pp, prep) => { if (!ai && pp === p) ai = { kind: 'ability', key: prep.key }; return oa.call(this, pp, prep); };
    try { origMain(p, second); } finally { this.castSpell = oc; this.doActivate = oa; this._judging = false; }
    record(second ? 'main 2' : 'main', p.seat, judgeMain(base, p.seat, !!second, ai || { kind: 'pass' }));
  };
  const origCombat = g.combat.bind(g);
  g.combat = function (p) {
    if (this._judging || this._forcedAtk || JR() > SAMPLE) return origCombat(p);
    const n0 = keepLook(); this._judging = true; const base = this.cloneForLook(); this._lookN = n0;
    let ai = { ids: [], target: null }; const oe = this.emit;
    this.emit = (kind, text, extra = {}) => { if (kind === 'attack' && extra.seat === p.seat && !ai.ids.length) ai = { ids: extra.cards.slice(), target: extra.target }; return oe.call(this, kind, text, extra); };
    try { origCombat(p); } finally { this.emit = oe; this._judging = false; }
    record('attack', p.seat, judgeAttack(base, p.seat, ai));
  };
  g.run();
  // cheap red flags, every game
  for (const p of g.players) if (p.lostReason === 'tried to draw from an empty library' && g.round < 25) out.push({ seed, pod: pod.map((d) => d.id), deck: pod[p.seat].id, round: g.round, kind: 'flag', regret: 50, ai: 'drew itself out', best: '-', options: [] });
  return out;
}

// ----- runner: shards across cores, then a grouped report -----
if (process.env.MISTAKES_SHARD) {
  const [from, to] = process.env.MISTAKES_SHARD.split(',').map(Number);
  const all = [];
  for (let gi = from; gi < to; gi++) { all.push(...playGame(gi)); process.send({ done: 1 }); }
  process.send({ result: all });
} else {
  const t0 = Date.now(), per = Math.ceil(N / CORES); let done = 0; const results = [];
  console.log(`Judging ${N} games on ${CORES} cores (sample ${SAMPLE}, ${K} playouts per option)...`);
  await Promise.all(Array.from({ length: CORES }, (_, k) => new Promise((res) => {
    const from = k * per, to = Math.min(N, from + per); if (from >= to) return res();
    const ch = fork(new URL(import.meta.url).pathname, args, { env: { ...process.env, MISTAKES_SHARD: `${from},${to}` } });
    ch.on('message', (m) => { if (m.done && ++done % 20 === 0) console.log(`  ${done}/${N} games`); if (m.result) results.push(...m.result); });
    ch.on('exit', res);
  })));
  // group by what kind of decision went wrong and the roles of the cards involved
  const groups = new Map();
  for (const m of results) {
    const key = m.kind === 'flag' ? `flag: ${m.ai}` : `${m.kind}: AI ${m.aiAct}${m.aiRoles ? ` (${m.aiRoles})` : ''} -> better ${m.bestAct}${m.bestRoles ? ` (${m.bestRoles})` : ''}`;
    const gr = groups.get(key) || { key, n: 0, regret: 0, examples: [] };
    gr.n++; gr.regret += m.regret; if (gr.examples.length < 5) gr.examples.push(m); groups.set(key, gr);
  }
  const ranked = [...groups.values()].sort((a, b) => b.regret - a.regret);
  fs.writeFileSync('data/mistakes.json', JSON.stringify({ when: new Date().toISOString(), games: N, sample: SAMPLE, playouts: K, margin: MARGIN, found: results.length, groups: ranked }, null, 1));
  console.log(`\n${results.length} likely mistakes in ${N} games (${((Date.now() - t0) / 60000).toFixed(1)} min). Worst patterns (count, total regret):`);
  for (const gr of ranked.slice(0, 15)) {
    console.log(`\n  ${gr.n}x  ${gr.regret}  ${gr.key}`);
    for (const e of gr.examples.slice(0, 2)) console.log(`      seed ${e.seed} (${e.pod.join(', ')}) round ${e.round} ${e.deck}: ${e.ai} -> better: ${e.best} (+${e.regret})`);
  }
}
