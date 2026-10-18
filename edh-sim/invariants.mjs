// Rules monitor: plays games and checks, after every action, that the game state is one the rules allow.
// It flags things like a card in two zones, a token in a graveyard, a creature at 0 toughness that didn't die,
// a player at 0 life still in the game, a sorcery cast on someone else's turn, a summoning-sick attacker,
// a second land drop, a spell cast for X=0, more than seven cards in hand after cleanup.
// Usage: node invariants.mjs [games=200] [--show 3]   (prints each kind of problem with a few examples)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { Game, rng } = require('./src/engine.js');

const N = +process.argv.find((a) => /^\d+$/.test(a)) || 200;
const SHOW = process.argv.includes('--show') ? +process.argv[process.argv.indexOf('--show') + 1] : 3;
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const ids = fs.readdirSync('decks').filter((f) => f.endsWith('.txt')).map((f) => f.replace('.txt', ''));
const decks = ids.map((id) => ({ id, name: id, ...parseDeck(fs.readFileSync(`decks/${id}.txt`, 'utf8')) }));

const found = new Map(); // kind -> { n, examples }
let current = null;
function flag(kind, detail) {
  const f = found.get(kind) || { n: 0, games: new Set(), examples: [] };
  f.n++; f.games.add(current.seed);
  if (f.examples.length < SHOW) f.examples.push(`seed ${current.seed}, round ${current.g.round}: ${detail}${current.last ? `  [after: ${current.last}]` : ''}`);
  found.set(kind, f);
}

const ZONES = { bf: 'bf', hand: 'hand', gy: 'gy', exile: 'exile', library: 'library', command: 'command' };
function checkZones(g) {
  const where = new Map();
  for (const p of g.players) for (const z of Object.keys(ZONES)) for (const c of p[z]) {
    if (where.has(c.id)) flag('card in two zones at once', `${c.info.name} is in ${where.get(c.id)} and ${p.name}'s ${z}`);
    where.set(c.id, `${p.name}'s ${z}`);
    const zone = c.zone === 'stack' ? null : c.zone;
    if (zone && zone !== z) flag('card zone label disagrees with where it is', `${c.info.name} says ${c.zone} but sits in ${p.name}'s ${z}`);
    if (c.token && z !== 'bf') flag('token outside the battlefield', `${c.info.name} token in ${p.name}'s ${z}`);
    if (z === 'bf' && c.ctrl !== p.seat) flag('permanent controller disagrees with battlefield', `${c.info.name} ctrl ${c.ctrl} on ${p.name}'s side`);
    if (z !== 'bf' && z !== 'exile' && !c.token && c.owner !== p.seat && !c.stolenFrom) flag("card in someone else's non-battlefield zone", `${c.info.name} (owner ${g.players[c.owner].name}) in ${p.name}'s ${z}`);
  }
}
function checkSBA(g) {
  for (const p of g.players) {
    if (!p.lost && p.life <= 0 && !g.has(p, 'platinum')) flag('player at 0 or less life still in the game', `${p.name} at ${p.life}`);
    if (!p.lost && p.poison >= 10 && !g.has(p, 'platinum')) flag('player with 10 poison still in', `${p.name}`);
    if (p.lost) continue;
    const legends = {};
    for (const c of p.bf) {
      if (c.info.isCreature && g.toughness(c) <= 0) flag('creature with 0 toughness left on the battlefield', `${c.info.name} ${g.power(c)}/${g.toughness(c)}`);
      if (c.info.isCreature && c.dmg >= g.toughness(c) && g.toughness(c) > 0 && !g.hasKw(c, 'indestructible')) flag('creature with lethal damage left on the battlefield', `${c.info.name} dmg ${c.dmg}/${g.toughness(c)}`);
      if (c.info.isPW && c.loyalty <= 0) flag('planeswalker with 0 loyalty left on the battlefield', c.info.name);
      if (c.info.isLegendary && !c.token && !g.has(p, 'noLegendRule')) { if (legends[c.info.name]) flag('two of the same legend under one player', c.info.name); legends[c.info.name] = 1; }
      if (c.info.isAura && !c.info.reanimAura && !c.attached && !c.info.isCreature) flag('aura on the battlefield attached to nothing', c.info.name);
      if (c.attached && !(g.cards[c.attached] && g.cards[c.attached].zone === 'bf')) flag('attached to something no longer on the battlefield', `${c.info.name}`);
      if (c.info.isEquipment && c.attached && g.cards[c.attached] && !g.cards[c.attached].info.isCreature) flag('equipment attached to a non-creature', `${c.info.name} on ${g.cards[c.attached].info.name}`);
    }
  }
}

const R = rng(31337);
for (let gi = 0; gi < N; gi++) {
  const pod = R.shuffle(decks.slice()).slice(0, 4);
  const seed = 70000 + gi;
  const g = new Game(pod, db, seed, { record: false });
  current = { g, seed, last: '' };
  const origEmit = g.emit.bind(g);
  let landsThisTurn = {};
  g.emit = (kind, text, extra = {}) => {
    current.last = text.slice(0, 90);
    if (g.started) {
      if (kind === 'turn') { checkSBA(g); checkZones(g); landsThisTurn = {}; const ended = current.prevActive; if (ended != null) { const p = g.players[ended]; if (!p.lost && !g.has(p, 'noMaxHand') && !(p.emblems || []).includes('tamiyo') && p.hand.length > 7) flag('more than seven cards in hand after cleanup', `${p.name} has ${p.hand.length} at the end of their turn`); } current.prevActive = g.active; }
      if (extra.seat != null && g.players[extra.seat] && g.players[extra.seat].lost && ['cast', 'attack', 'ability', 'land'].includes(kind)) flag('a player who lost keeps acting', `${g.players[extra.seat].name}: ${text.slice(0, 80)}`);
      if (kind === 'cast') {
        const c = g.cards[extra.cards && extra.cards[0]]; const p = g.players[extra.seat];
        if (c && p && p.seat !== g.active && !c.info.isInstant && !g._inMiracle && !c.info.kw.has('flash') && !/flash/i.test(c.info.text || '')) flag("sorcery-speed spell cast on another player's turn", `${p.name} casts ${c.info.name} on ${g.players[g.active].name}'s turn`);
        if (c && c.info.cost.x && /\(X=0\)/.test(text)) flag('X spell cast for X=0', text);
        if (c && c.info.cost.x && !/X=/.test(text) && !/command zone|graveyard/.test(text)) flag('X spell cast without saying X', text.slice(0, 80));
      }
      if (kind === 'land') { const s = extra.seat; landsThisTurn[s] = (landsThisTurn[s] || 0) + (/ plays /.test(text) ? 1 : 0); const p = g.players[s]; const allowed = 1 + g.statics(p, 'extraLand').reduce((a, x) => a + x.s.n, 0) + (p.extraLandsTurn === g.turn ? p.extraLandsGranted || 0 : 0); if (landsThisTurn[s] > allowed) flag('more land drops than allowed', `${p.name}: ${landsThisTurn[s]} (allowed ${allowed})`); if (s !== g.active && / plays /.test(text)) flag("land played on another player's turn", text); }
      if (kind === 'attack' && extra.attackers) for (const a of extra.attackers) { const c = g.cards[a.id]; if (c && c.sick && !g.hasKw(c, 'haste') && !c.info.attack.length && !/onto the battlefield attacking/.test(text)) flag('summoning-sick creature attacks', `${c.info.name}`); if (c && g.hasKw(c, 'defender')) flag('creature with defender attacks', c.info.name); }
    }
    return origEmit(kind, text, extra);
  };
  try { g.run(); checkZones(g); if (!g.over) checkSBA(g); }
  catch (e) { flag('engine crashed', `${e.message} ${String(e.stack).split('\n')[1].trim()}`); }
  // zone integrity during play is checked at the end of each turn too
  if ((gi + 1) % 50 === 0) process.stdout.write(`  ${gi + 1}/${N} games\n`);
}
const kinds = [...found.entries()].sort((a, b) => b[1].games.size - a[1].games.size);
console.log(`\n${N} games checked. ${kinds.length ? kinds.length + ' kinds of problem found:' : 'No problems found.'}`);
for (const [k, f] of kinds) { console.log(`\n• ${k}: ${f.n} times in ${f.games.size} games`); for (const e of f.examples) console.log('    ' + e); }
process.exitCode = kinds.length ? 1 : 0;
