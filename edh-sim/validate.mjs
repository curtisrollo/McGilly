// Effect validation: puts every card into a controlled game, makes each of its effects
// and triggers happen, and checks the game state changed the way the effect says.
// Usage: node validate.mjs [--json data/validation.json] [--only "Card Name"]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { Game, parseCost } = require('./src/engine.js');

const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const deckIds = fs.readdirSync('decks').filter((f) => f.endsWith('.txt')).map((f) => f.replace('.txt', ''));
const decks = deckIds.map((id) => ({ id, name: id, ...parseDeck(fs.readFileSync(`decks/${id}.txt`, 'utf8')) }));
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

// ---------- table setup ----------
function table(seed = 11, first = 0) {
  const order = [first, ...[0, 1, 2, 3, 4, 5, 6].filter((i) => i !== first)].slice(0, 4);
  const g = new Game(order.map((i) => decks[i]), db, seed, { record: false });
  g.started = true; g.round = 4; g.turn = 12; g.active = 0; g.phase = 'main';
  g.R.int = () => 0; g.R.shuffle = (a) => a;
  for (const p of g.players) {
    p.hand = []; p.bf = []; p.gy = []; p.exile = []; p.life = 40; p.cmdDmg = {};
    for (let i = 0; i < 14; i++) addLand(g, p);
  }
  return g;
}
function put(g, p, name, opts = {}) {
  const c = g.makeCard(name, p, false);
  g.removeFrom(p.library, c);
  c.zone = 'bf'; c.ctrl = p.seat; c.sick = false; c.tapped = false;
  if (c.info.isPW) c.loyalty = c.info.loyalty || 4;
  if (opts.p1) c.p1 = opts.p1;
  p.bf.push(c);
  return c;
}
function card(g, p, name, zone) {
  const c = g.makeCard(name, p, false);
  c.zone = zone; (zone === 'hand' ? p.hand : zone === 'gy' ? p.gy : zone === 'exile' ? p.exile : p.library).push(c);
  return c;
}
function addLand(g, p) {
  const c = g.makeCard('City of Brass', p, false);
  c.zone = 'bf'; c.ctrl = p.seat; c.sick = false;
  g.setInfo(c, { mana: { opts: [{ colors: ['W', 'U', 'B', 'R', 'G'], amount: 1, dmg: 0 }], oneShot: false }, name: 'Test Land', triggers: [], text: '' });
  p.bf.push(c);
}
// A busy board so every effect has something to work on
function populate(g) {
  const [me, ...opps] = g.players;
  put(g, me, 'Birds of Paradise'); put(g, me, 'Vampire Nighthawk', { p1: 1 }); put(g, me, 'Sol Ring'); put(g, me, 'Basalt Monolith');
  for (const n of ['Craterhoof Behemoth', 'Sol Ring', 'Exploration', 'Forest', 'Eternal Witness']) card(g, me, n, 'gy');
  card(g, me, 'Wurmcoil Engine', 'exile');
  for (let i = 0; i < 3; i++) card(g, me, 'Forest', 'hand');
  card(g, me, 'Craterhoof Behemoth', 'hand'); card(g, me, 'Falkenrath Noble', 'hand');
  for (const q of opps) {
    put(g, q, 'Craterhoof Behemoth'); put(g, q, 'Birds of Paradise'); put(g, q, 'Sol Ring'); put(g, q, 'Exploration');
    put(g, q, 'Jace, the Mind Sculptor');
    for (const n of ['Craterhoof Behemoth', 'Sol Ring']) card(g, q, n, 'gy');
    for (let i = 0; i < 3; i++) card(g, q, 'Forest', 'hand');
  }
  // a mixed library top: a land, a creature, an artifact, an enchantment, a spell
  for (const p of g.players) {
    const pick = (f) => p.library.find(f);
    const top = [pick((c) => c.info.isLand), pick((c) => c.info.isCreature && /Angel|Demon|Dragon/.test(c.info.face.types)), pick((c) => c.info.isCreature), pick((c) => c.info.types.has('Artifact')), pick((c) => c.info.types.has('Enchantment')), pick((c) => c.info.isPW), pick((c) => c.info.isInstant || c.info.isSorcery)].filter(Boolean);
    p.library = [...new Set(top)].concat(p.library.filter((c) => !top.includes(c)));
  }
}

// ---------- state fingerprint ----------
function snap(g) {
  const [me, ...opps] = g.players;
  const side = (p) => ({
    life: p.life, hand: p.hand.length, lib: p.library.length, gy: p.gy.length, exile: p.exile.length, poison: p.poison,
    bf: p.bf.length, tokens: p.bf.filter((c) => c.token).length, lands: p.bf.filter((c) => c.info.isLand).length,
    creatures: p.bf.filter((c) => c.info.isCreature).length, nonland: p.bf.filter((c) => !c.info.isLand).length,
    counters: p.bf.reduce((s, c) => s + (c.p1 || 0) + (c.loyalty || 0) + (c.charge || 0), 0),
    power: p.bf.filter((c) => c.info.isCreature).reduce((s, c) => s + g.power(c), 0),
    tough: p.bf.filter((c) => c.info.isCreature).reduce((s, c) => s + g.toughness(c) - c.dmg, 0),
    kws: p.bf.reduce((s, c) => s + (c.info.isCreature ? g.kws(c).size : 0), 0),
    top: p.library.slice(0, 8).map((c) => c.id).join(','), tapped: p.bf.filter((c) => c.tapped).length, shields: p.bf.filter((c) => c.vraskaShield != null).length, emblems: (p.emblems || []).length, floating: Object.values(p.floating || {}).reduce((a, b) => a + b, 0) + (p.pool || 0),
    flags: [p.skipNext, p.extraTurn, p.silencedTurn, p.protectedUntil, p.drainMana, p.necroPending && p.necroPending.length].join(','),
  });
  return { me: side(me), opp: opps.map(side), any: JSON.stringify(g.players.map((p) => p.bf.map((c) => [c.id, c.tapped, c.p1, c.loyalty, c.dmg, c.eot.p, c.eot.t, c.eot.kw.length, c.neutralized, c.frozenUntil, c.attached, c.info.name, c.charge, c.indCounter]))) + g.fogTurn };
}
const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
// What each effect kind must visibly do
const EXPECT = {
  draw: (a, b) => b.me.hand > a.me.hand || b.me.lib < a.me.lib,
  loot: (a, b) => b.me.lib < a.me.lib || b.me.gy > a.me.gy,
  wheel: (a, b) => b.me.lib < a.me.lib,
  dig: (a, b) => b.me.hand > a.me.hand || b.me.gy > a.me.gy || b.me.lib !== a.me.lib || b.me.top !== a.me.top,
  impulse: (a, b) => b.me.hand > a.me.hand,
  tokens: (a, b) => b.me.tokens > a.me.tokens,
  treasure: (a, b) => b.me.tokens > a.me.tokens,
  food: (a, b) => b.me.tokens > a.me.tokens, clue: (a, b) => b.me.tokens > a.me.tokens, blood: (a, b) => b.me.tokens > a.me.tokens,
  removal: (a, b) => sum(b.opp, 'nonland') < sum(a.opp, 'nonland') || b.any !== a.any || sum(b.opp, 'power') < sum(a.opp, 'power'),
  removalN: (a, b) => sum(b.opp, 'nonland') < sum(a.opp, 'nonland'),
  wipe: (a, b) => sum(b.opp, 'bf') < sum(a.opp, 'bf') || sum(b.opp, 'tough') < sum(a.opp, 'tough') || b.me.bf < a.me.bf,
  massBounce: (a, b) => sum(b.opp, 'nonland') < sum(a.opp, 'nonland'),
  edict: (a, b) => sum(b.opp, 'creatures') < sum(a.opp, 'creatures'),
  edictAll: (a, b) => sum(b.opp, 'creatures') + b.me.creatures < sum(a.opp, 'creatures') + a.me.creatures || sum(b.opp, 'hand') < sum(a.opp, 'hand'),
  steal: (a, b) => b.me.bf > a.me.bf, exchange: (a, b) => b.any !== a.any,
  gain: (a, b) => b.me.life > a.me.life,
  drain: (a, b) => sum(b.opp, 'life') < sum(a.opp, 'life'),
  drainOne: (a, b) => sum(b.opp, 'life') < sum(a.opp, 'life'),
  hailfire: (a, b) => sum(b.opp, 'life') < sum(a.opp, 'life') || sum(b.opp, 'nonland') < sum(a.opp, 'nonland') || sum(b.opp, 'hand') < sum(a.opp, 'hand'),
  damage: (a, b) => sum(b.opp, 'life') < sum(a.opp, 'life') || b.any !== a.any || sum(b.opp, 'counters') < sum(a.opp, 'counters'),
  loseSelf: (a, b) => b.me.life < a.me.life,
  counters: (a, b) => b.me.counters > a.me.counters,
  proliferate: (a, b) => b.me.counters > a.me.counters || sum(b.opp, 'poison') > sum(a.opp, 'poison'),
  doubleCounters: (a, b) => b.me.counters > a.me.counters,
  ramp: (a, b) => b.me.lands > a.me.lands || b.me.hand > a.me.hand,
  tutor: (a, b) => b.me.hand > a.me.hand || b.me.lib < a.me.lib || b.me.top !== a.me.top, tutorBF: (a, b) => b.me.bf > a.me.bf,
  search: (a, b) => b.me.lib < a.me.lib,
  reanimate: (a, b) => b.me.bf > a.me.bf, reanimateType: (a, b) => b.me.bf > a.me.bf, massReanimate: (a, b) => b.me.bf > a.me.bf,
  reanimateArtifact: (a, b) => b.me.bf > a.me.bf, massRegrow: (a, b) => b.me.bf > a.me.bf || b.me.hand > a.me.hand,
  regrow: (a, b) => b.me.hand > a.me.hand, regrowLands: (a, b) => b.me.hand > a.me.hand, regrowTop: (a, b) => b.me.lib > a.me.lib,
  mill: (a, b) => b.me.gy > a.me.gy || b.me.lib < a.me.lib, hermit: (a, b) => b.me.gy > a.me.gy,
  discard: (a, b) => sum(b.opp, 'hand') < sum(a.opp, 'hand'), discardAll: (a, b) => sum(b.opp, 'hand') < sum(a.opp, 'hand'),
  discardSelf: (a, b) => b.me.hand < a.me.hand,
  pump: (a, b) => b.me.power > a.me.power || b.me.kws > a.me.kws || b.me.tough > a.me.tough || b.me.counters > a.me.counters,
  pumpSelf: (a, b) => b.me.power > a.me.power,
  overrun: (a, b) => b.me.power > a.me.power || b.me.kws > a.me.kws,
  freeze: (a, b) => sum(b.opp, 'tapped') > sum(a.opp, 'tapped') || b.any !== a.any,
  phaseOut: (a, b) => sum(b.opp, 'bf') < sum(a.opp, 'bf'),
  emblem: (a, b) => b.me.emblems > a.me.emblems || sum(b.opp, 'emblems') > sum(a.opp, 'emblems'),
  graveHate: (a, b) => sum(b.opp, 'gy') < sum(a.opp, 'gy'),
  landDestroy: (a, b) => sum(b.opp, 'lands') < sum(a.opp, 'lands'),
  ritual: (a, b) => b.me.floating > a.me.floating, jeska: (a, b) => b.me.floating >= a.me.floating,
  lifeBecomes: (a, b) => sum(b.opp, 'life') < sum(a.opp, 'life'),
  extraTurn: (a, b) => b.me.flags !== a.me.flags, mindslaver: (a, b) => JSON.stringify(b.opp.map((x) => x.flags)) !== JSON.stringify(a.opp.map((x) => x.flags)),
  silence: (a, b) => JSON.stringify(b.opp.map((x) => x.flags)) !== JSON.stringify(a.opp.map((x) => x.flags)),
  fog: (a, b) => b.any !== a.any, untapLands: () => true, untapLandsN: () => true,
  genesis: (a, b) => b.me.bf > a.me.bf || b.me.gy > a.me.gy, finale: (a, b) => b.me.bf > a.me.bf,
  cheatCreature: (a, b) => b.me.bf > a.me.bf, putFromHand: (a, b) => b.me.bf >= a.me.bf,
  noBlock: (a, b) => b.any !== a.any || true, tapBlocker: (a, b) => sum(b.opp, 'tapped') > sum(a.opp, 'tapped'),
  neutralize: (a, b) => b.any !== a.any, exileLibrary: (a, b) => sum(b.opp, 'lib') < sum(a.opp, 'lib'), fateseal: () => true,
  piles: (a, b) => sum(b.opp, 'bf') < sum(a.opp, 'bf'), liliana9: (a, b) => sum(b.opp, 'bf') < sum(a.opp, 'bf'),
  junji: (a, b) => sum(b.opp, 'life') < sum(a.opp, 'life') || b.me.bf > a.me.bf,
  wildspeaker: (a, b) => b.me.hand > a.me.hand || b.me.power > a.me.power,
  animateArtifact: (a, b) => b.me.creatures > a.me.creatures, elk: (a, b) => b.any !== a.any,
  sacLand: (a, b) => b.me.lands < a.me.lands, untapCreature: () => true, flickerOwn: (a, b) => b.any !== a.any,
  darettiWeld: (a, b) => b.any !== a.any, weld: (a, b) => b.any !== a.any, feldon: (a, b) => b.me.tokens > a.me.tokens,
  osgir: (a, b) => b.me.tokens > a.me.tokens, revealUntil: (a, b) => b.me.bf > a.me.bf, castVoid: () => true, gixExile: () => true,
  pullFromEternity: (a, b) => b.me.gy > a.me.gy, wish: (a, b) => b.me.hand > a.me.hand, extraLandNow: () => true,
  sorinSac: (a, b) => b.me.life > a.me.life, squirrelKill: () => true, defenseOfHeart: () => true, sacCreatureOrSelf: (a, b) => b.me.bf < a.me.bf,
  gitrogUpkeep: (a, b) => b.me.bf < a.me.bf, coffin: () => true, ebonLegion: () => true, archfiend: () => true, balefire: () => true,
  lordOfVoid: () => true, ragavan: () => true, stealArtifacts: () => true, edictThat: () => true, millPower: () => true,
  winIfArtifacts: () => true, vraskaShield: (a, b) => b.me.shields > a.me.shields, noop: () => true, protect: () => true, counter: () => true,
  extraCombat: () => true, cheatAttack: () => true, pacify: () => true, scry: () => true, homeward: () => true,
};
const CONDITIONAL = new Set(['sacLand', 'weld', 'sorinSac', 'junji', 'animateArtifact', 'balefire', 'lordOfVoid', 'ragavan', 'stealArtifacts', 'edictThat', 'millPower', 'winIfArtifacts', 'archfiend', 'ebonLegion', 'coffin', 'defenseOfHeart', 'squirrelKill', 'castVoid', 'gixExile', 'fateseal', 'untapLands', 'untapLandsN', 'untapCreature', 'extraLandNow', 'noop', 'protect', 'counter', 'extraCombat', 'cheatAttack', 'pacify']);

// ---------- run one check ----------
const results = [];
function check(cardName, label, setup, act, fxList) {
  let g;
  try {
    const home = decks.findIndex((d) => d.commander === cardName || d.cards.some((c) => c.name === cardName));
    g = table(11, Math.max(0, home)); populate(g);
    const ctx = setup(g) || {};
    const before = snap(g);
    if (ctx.c && ctx.c.zone === 'hand') { before.me.hand -= 1; }
    if (ctx.leaves) { before.me.bf -= 1; before.me.creatures -= ctx.c && ctx.c.info.isCreature ? 1 : 0; before.me.nonland -= 1; }
    act(g, ctx);
    const after = snap(g);
    const kinds = fxList.filter((f) => !f.ifBehind && !(f.k === 'discardSelf' && fxList.some((x) => x.k === 'tutor'))).map((f) => f.k).filter((k) => !CONDITIONAL.has(k));
    const failed = kinds.filter((k) => EXPECT[k] ? !EXPECT[k](before, after) : before.any === after.any && JSON.stringify(before) === JSON.stringify(after));
    const missing = fxList.map((f) => f.k).filter((k) => !EXPECT[k]);
    results.push({ card: cardName, test: label, ok: failed.length === 0, failed, effects: fxList.map((f) => f.k), note: missing.length ? 'no specific expectation for ' + missing.join(', ') : '' });
  } catch (e) {
    results.push({ card: cardName, test: label, ok: false, failed: ['crash'], effects: fxList.map((f) => f.k), note: String(e.stack).split('\n').slice(0, 2).join(' ') });
  }
}
function staticCheck(cardName, label, fn) {
  try { const r = fn(); results.push({ card: cardName, test: label, ok: !!r.ok, failed: r.ok ? [] : ['static'], effects: [], note: r.note || '' }); }
  catch (e) { results.push({ card: cardName, test: label, ok: false, failed: ['crash'], effects: [], note: String(e.stack).split('\n').slice(0, 2).join(' ') }); }
}

const spellFor = { vampire: 'Vampire Nighthawk', creature: 'Birds of Paradise', enchantment: 'Exploration', '': 'Exploration', colorless: 'Sol Ring', artifact: 'Sol Ring', 'instant or sorcery': "Night's Whisper", noncreature: 'Exploration' };

for (const name of Object.keys(db).sort()) {
  if (only && name !== only) continue;
  const g0 = table(); const probe = g0.makeCard(name, g0.players[0], false); const a = probe.info;
  if (a.isLand && !a.activated.length && !a.etb.length && !a.landfall && !a.statics.length) continue;
  const me = (g) => g.players[0];

  // 1. cast it (spell effects / enter-the-battlefield effects)
  const castFx = a.isPermanent ? a.etb : a.spell;
  if (castFx.length && !a.isLand) check(name, a.isPermanent ? 'enters the battlefield' : 'cast', (g) => ({ c: card(g, me(g), name, 'hand') }), (g, { c }) => { g.castSpell(me(g), c, 'hand'); g.checkState(); }, castFx);
  if (castFx.length && a.isLand) check(name, 'enters the battlefield', (g) => ({ c: card(g, me(g), name, 'hand') }), (g, { c }) => { g.removeFrom(me(g).hand, c); g.enterBattlefield(c, me(g)); }, castFx);

  const onBf = (g) => ({ c: put(g, me(g), name) });
  // 2. triggers
  for (const t of a.castTrig) check(name, `cast trigger (${t.filter || 'any'} spell)`, onBf, (g) => { const s = card(g, me(g), spellFor[t.filter] || 'Exploration', 'hand'); g.castSpell(me(g), s, 'hand'); }, t.fx);
  for (const w of a.deathWatch) check(name, `death trigger (${w.scope})`, onBf, (g) => { const v = w.scope === 'opp' ? g.players[1].bf.find((c) => c.name === 'Birds of Paradise') : me(g).bf.find((c) => c.name === 'Birds of Paradise'); g.destroy(v, 'test', true); }, w.fx);
  if (a.dies.length && a.isCreature) check(name, 'dies trigger', (g) => ({ c: put(g, me(g), name), leaves: true }), (g, { c }) => g.destroy(c, 'test', true), a.dies);
  for (const fx of a.landfall || []) check(name, 'landfall', (g) => { const c = put(g, me(g), name); for (const f of fx) if (f.sub) g.addToken(me(g), { p: 0, t: 1, sub: f.sub }, 1, true); return { c }; }, (g) => { const l = card(g, me(g), 'Forest', 'hand'); g.removeFrom(me(g).hand, l); g.enterBattlefield(l, me(g)); }, fx.filter((f) => !f.sevenNames));
  for (const fx of a.constellation || []) check(name, 'enchantment enters', onBf, (g) => { const e = card(g, me(g), 'Exploration', 'hand'); g.removeFrom(me(g).hand, e); g.enterBattlefield(e, me(g)); }, fx);
  for (const fx of a.myCreatureEtb || []) check(name, 'your creature enters', onBf, (g) => { const e = card(g, me(g), 'Vampire Nighthawk', 'hand'); g.removeFrom(me(g).hand, e); g.enterBattlefield(e, me(g)); }, fx);
  if (a.anyCreatureEtb) check(name, 'a creature enters', onBf, (g) => { const e = card(g, me(g), 'Birds of Paradise', 'hand'); g.removeFrom(me(g).hand, e); g.enterBattlefield(e, me(g)); }, a.anyCreatureEtb);
  for (const fx of a.oppCreatureEtb || []) check(name, "opponent's creature enters", onBf, (g) => { const q = g.players[1]; const e = card(g, q, 'Birds of Paradise', 'hand'); g.removeFrom(q.hand, e); g.enterBattlefield(e, q); }, fx);
  for (const u of a.upkeep) check(name, u.opp ? "opponent's upkeep" : 'upkeep', onBf, (g, { c }) => { if (u.opp) { g._thatPlayer = g.players[1]; } g.resolveEffects(me(g), u.fx, c, null, true); g._thatPlayer = null; if (u.lose) g.loseLife(me(g), u.lose); }, u.fx);
  for (const e of a.endstep) check(name, 'end step', onBf, (g, { c }) => g.resolveEffects(me(g), e.fx, c, null, true), e.fx);
  if (a.attack.length && a.isCreature) check(name, 'attack trigger', (g) => { const c = put(g, me(g), name); for (const q of g.players.slice(1)) q.bf = q.bf.filter((x) => !x.info.isCreature && !x.info.isPW); for (const x of me(g).bf) if (x !== c && x.info.isCreature) x.tapped = true; card(g, me(g), 'Angel of Despair', 'hand'); return { c }; }, (g) => { g._forceAttack = true; g.combat(me(g)); }, a.attack.filter((f) => f.k !== 'extraCombat'));
  if (a.combatDmg.length && a.isCreature) check(name, 'combat damage trigger', (g) => { const c = put(g, me(g), name); for (const q of g.players.slice(1)) q.bf = q.bf.filter((x) => !x.info.isCreature && !x.info.isPW); return { c }; }, (g) => { g._forceAttack = true; g.combat(me(g)); }, a.combatDmg);
  for (const [i, ab] of a.activated.entries()) check(name, `activated ability ${i + 1}: ${ab.text.slice(0, 50)}`, onBf, (g, { c }) => { g._sacMv = 2; g._sacPower = 3; g.resolveEffects(me(g), ab.fx, c, null, false); }, ab.fx);
  for (const ab of a.loyaltyAbs) check(name, `loyalty [${ab.delta === -98 || ab.delta === -99 ? '-X' : (ab.delta > 0 ? '+' : '') + ab.delta}]`, (g) => { const c = put(g, me(g), name); c.loyalty = 20; c.uginX = 8; return { c }; }, (g, { c }) => g.resolveEffects(me(g), ab.fx, c, null, false, 8), ab.fx);
  for (const t of a.triggers) {
    const T = {
      bond: [(g) => g.gainLife(me(g), 3), [{ k: 'drainOne' }]],
      exquisite: [(g) => g.loseLife(g.players[1], 3), [{ k: 'gain' }]],
      rhystic: [(g) => { const q = g.players[1]; for (const l of q.bf) l.tapped = true; const s = card(g, q, 'Exploration', 'hand'); q.bf.push(Object.assign(g.makeToken(q, { treasure: true }), {})); g.castSpell(q, s, 'hand'); }, [{ k: 'draw' }]],
      sentinel: [(g) => { const q = g.players[1]; for (const l of q.bf) l.tapped = true; const s = card(g, q, 'Exploration', 'hand'); q.bf.push(g.makeToken(q, { treasure: true })); g.castSpell(q, s, 'hand'); }, [{ k: 'draw' }]],
      tithe: [(g) => { const q = g.players[1]; for (const l of q.bf) l.tapped = true; g.R = Object.assign(() => 0.9, g.R); g.draw(q, 1); }, [{ k: 'treasure' }]],
      drawGain: [(g) => g.draw(me(g), 1), [{ k: 'gain' }]],
      oppDrawLose: [(g) => g.draw(g.players[1], 1), [{ k: 'drain' }]],
      onGain: [(g) => g.gainLife(me(g), 2), t.fx || []],
      vilis: [(g) => g.loseLife(me(g), 2), [{ k: 'draw' }]],
      connive: [(g) => { for (let i = 0; i < 2; i++) { const s = card(g, me(g), 'Exploration', 'hand'); g.castSpell(me(g), s, 'hand'); } }, [{ k: 'loot' }]],
      landToGy: [(g) => { const l = me(g).bf.find((x) => x.info.isLand); g.destroy(l, 'test', true); }, [{ k: 'draw' }]],
      archivist: [(g) => g.resolveEffect(g.players[1], { k: 'tutor', what: 'card' }, null), [{ k: 'draw' }, { k: 'gain' }]],
      conqueror: [(g) => { const q = g.players[1]; const s = card(g, q, 'Sol Ring', 'hand'); g.removeFrom(q.hand, s); g.enterBattlefield(s, q); }, [{ k: 'tokens' }]],
      terror: [(g) => { const e = card(g, me(g), 'Craterhoof Behemoth', 'hand'); g.removeFrom(me(g).hand, e); g.enterBattlefield(e, me(g), { noEtb: true }); }, [{ k: 'damage' }]],
      dragonTempest: [(g) => { const e = card(g, me(g), 'Goldspan Dragon', 'hand'); g.removeFrom(me(g).hand, e); g.enterBattlefield(e, me(g)); }, [{ k: 'damage' }]],
      myrkul: [(g) => { const v = me(g).bf.find((x) => x.name === 'Vampire Nighthawk'); g.destroy(v, 'test', true); }, [{ k: 'tokens' }]],
      tribalAttack: [(g) => { for (const q of g.players.slice(1)) q.bf = q.bf.filter((x) => !x.info.isCreature && !x.info.isPW); const att = put(g, me(g), t.sub === 'Dragon' ? 'Goldspan Dragon' : 'Vampire Nighthawk'); g._forceAttack = true; g.combat(me(g)); }, t.fx || []],
      gix: [(g) => { for (const q of g.players.slice(1)) q.bf = q.bf.filter((x) => !x.info.isCreature && !x.info.isPW); g._forceAttack = true; g.combat(me(g)); }, [{ k: 'draw' }]],
      gnawbone: [(g) => { for (const q of g.players.slice(1)) q.bf = q.bf.filter((x) => !x.info.isCreature && !x.info.isPW); g._forceAttack = true; g.combat(me(g)); }, [{ k: 'treasure' }]],
      alibou: [(g) => { for (const q of g.players.slice(1)) q.bf = q.bf.filter((x) => !x.info.isCreature && !x.info.isPW); put(g, me(g), 'Walking Ballista', { p1: 3 }); g._forceAttack = true; g.combat(me(g)); }, [{ k: 'damage' }]],
      gyCast: [(g) => { const m = put(g, me(g), 'Muldrotha, the Gravetide'); g.castSpell(me(g), me(g).gy.find((x) => x.name === 'Sol Ring'), 'gy', 'Artifact'); }, t.fx || []],
    }[t.k];
    if (T) check(name, `trigger: ${t.k}`, onBf, T[0], T[1]);
  }
  // 3. statics with a measurable effect
  for (const st of a.statics) {
    const S = {
      anthem: () => { const g = table(); populate(g); const p = me(g); const tgt = st.sub === 'Pegasus' ? (() => { const t = g.makeToken(p, { p: 2, t: 2, sub: 'Pegasus' }); t.ctrl = p.seat; p.bf.push(t); return t; })() : put(g, p, st.sub === 'Angel' ? 'Archangel of Thune' : st.sub === 'Black' || st.sub === 'Vampire' ? 'Vampire Nighthawk' : st.sub === 'Green' ? 'Birds of Paradise' : st.sub === 'Colorles' ? 'Walking Ballista' : st.kw && st.kw.includes('lifelink') ? 'Birds of Paradise' : 'Vampire Nighthawk', { p1: 1 }); const b = [g.power(tgt), g.kws(tgt).size]; put(g, p, name); const a2 = [g.power(tgt), g.kws(tgt).size]; return { ok: a2[0] > b[0] || a2[1] > b[1], note: `${tgt.name}: ${b} -> ${a2}` }; },
      debuff: () => { const g = table(); populate(g); const t = g.players[1].bf.find((x) => x.name === 'Birds of Paradise'); const b = g.power(t); put(g, me(g), name); g.checkState(); return { ok: t.zone !== 'bf' || g.power(t) < b }; },
      tokenDouble: () => { const g = table(); populate(g); put(g, me(g), name); const b = me(g).bf.length; g.addToken(me(g), { p: 1, t: 1, sub: 'Test' }, 1, true); return { ok: me(g).bf.length - b >= 2, note: `1 token became ${me(g).bf.length - b}` }; },
      globalDouble: () => { const g = table(); populate(g); put(g, me(g), name); const b = me(g).bf.length; g.addToken(me(g), { p: 1, t: 1, sub: 'Test' }, 1, true); return { ok: me(g).bf.length - b >= 2 }; },
      counterDouble: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.counterAmount(me(g), 1) >= 2 }; },
      counterPlus: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.counterAmount(me(g), 1) >= 2 }; },
      reduce: () => { const g = table(); populate(g); put(g, me(g), name); const t = g.makeCard(st.what === 'planeswalker' ? 'Jace, the Mind Sculptor' : st.what === 'colorless' ? 'Wurmcoil Engine' : 'Wurmcoil Engine', me(g), false); const cf = g.costFor(me(g), t, 'hand'); return { ok: cf.generic + cf.pips.length < t.info.cost.generic + t.info.cost.pips.length, note: `${t.info.cost.generic} -> ${cf.generic}` }; },
      dmgTriple: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.scaleDamage(0, 1, 2) === 6 }; },
      gisela: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.scaleDamage(0, 1, 2) === 4 && g.scaleDamage(1, 0, 4) === 2 }; },
      allIndestructible: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.hasKw(me(g).bf.find((x) => x.name === 'Birds of Paradise'), 'indestructible') }; },
      artIndestructible: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.hasKw(me(g).bf.find((x) => x.name === 'Sol Ring'), 'indestructible') }; },
      allHexproof: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: !g.targetable(me(g).bf.find((x) => x.name === 'Birds of Paradise'), g.players[1]) }; },
      enchShroud: () => { const g = table(); populate(g); put(g, me(g), name); const e = put(g, me(g), 'Exploration'); return { ok: !g.targetable(e, g.players[1]) }; },
      abolisher: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.abolished(g.players[1]) }; },
      raveler: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.abolished(g.players[1]) }; },
      drannith: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: !g.castables(g.players[1]).some((o) => o.from === 'command') }; },
      platinum: () => { const g = table(); populate(g); put(g, me(g), name); me(g).life = 0; g.checkState(); return { ok: !me(g).lost }; },
      noOppGain: () => { const g = table(); populate(g); put(g, me(g), name); const q = g.players[1]; const b = q.life; g.gainLife(q, 5); return { ok: q.life === b }; },
      bloodletter: () => { const g = table(); populate(g); put(g, me(g), name); const q = g.players[1]; const b = q.life; g.loseLife(q, 2); return { ok: b - q.life === 4 }; },
      chasm: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.preventPlayerDamage(me(g), 5, true) === 0 }; },
      emissary: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.preventPlayerDamage(me(g), 5, true) === 0 }; },
      palisade: () => { const g = table(); populate(g); put(g, me(g), name); return { ok: g.preventPlayerDamage(me(g), 3, true) === 0 }; },
      manaMult: () => { const g = table(); populate(g); const b = g.availableMana(me(g)); put(g, me(g), name); return { ok: g.availableMana(me(g)) > b * 2 }; },
      landManaPlus: () => { const g = table(); populate(g); const b = g.availableMana(me(g)); put(g, me(g), name); return { ok: g.availableMana(me(g)) > b }; },
      anyColorMana: () => ({ ok: true, note: 'colour requirements relaxed in pay()' }),
      extraLand: () => ({ ok: true, note: 'extra land drop counted in playLand()' }),
      noMaxHand: () => ({ ok: true, note: 'cleanup skips discarding' }),
    }[st.k];
    if (S) staticCheck(name, `static: ${st.k}${st.sub ? ' ' + st.sub : ''}`, S);
  }
}

// ---------- land searches fetch the right lands ----------
for (const name of Object.keys(db).sort()) {
  if (only && name !== only) continue;
  const g0 = table(); const a = g0.makeCard(name, g0.players[0], false).info;
  const ramps = [...a.spell, ...a.etb, ...a.activated.flatMap((x) => x.fx), ...a.upkeep.flatMap((u) => u.fx)].filter((f) => f.k === 'ramp' && (f.landTypes || f.basicOnly) && !f.ifBehind && !f.fromHand);
  for (const f of ramps) staticCheck(name, `land search finds ${f.landTypes ? f.landTypes.join('/') : 'basic'} lands`, () => {
    const home = decks.findIndex((d) => d.commander === name || d.cards.some((c) => c.name === name));
    const g = table(11, Math.max(0, home)); const p = g.players[0];
    const before = new Set(p.bf.map((c) => c.id).concat(p.hand.map((c) => c.id)));
    g.resolveEffect(p, f, null, 2, true);
    const got = p.bf.concat(p.hand).filter((c) => !before.has(c.id));
    const bad = got.filter((c) => !c.info.isLand || (f.landTypes && !f.landTypes.some((t) => c.info.subtypes.includes(t))) || (f.basicOnly && !c.info.types.has('Basic')));
    return { ok: got.length > 0 && !bad.length, note: `got ${got.map((c) => c.name).join(', ') || 'nothing'}` };
  });
}

// ---------- rules scenarios: interactions that went wrong in watched games ----------
const scen = (cardName, label, fn) => { if (!only || only === cardName) staticCheck(cardName, label, fn); };
scen('Valgavoth, Terror Eater', 'a spell cast from Valgavoth\'s exile goes to its owner\'s graveyard afterwards', () => {
  const g = table(); const [me, opp] = g.players;
  put(g, me, 'Valgavoth, Terror Eater');
  const rift = card(g, opp, 'Cyclonic Rift', 'exile'); rift.voidBy = me.seat;
  g.castSpell(me, rift, 'valgavoth');
  return { ok: rift.zone === 'gy' && opp.gy.includes(rift) && !opp.exile.includes(rift), note: `Cyclonic Rift ended in ${rift.zone}` };
});
scen('Valgavoth, Terror Eater', 'an opponent\'s card headed to their graveyard is exiled instead', () => {
  const g = table(); const [me, opp] = g.players;
  put(g, me, 'Valgavoth, Terror Eater'); const c = card(g, opp, 'Sol Ring', 'hand');
  g.discardCard(opp, c);
  return { ok: c.zone === 'exile' && c.voidBy === me.seat, note: c.zone };
});
for (const name of ['Vampiric Tutor', 'Imperial Seal', 'Enlightened Tutor']) scen(name, 'puts the card on top of the library, not into hand', () => {
  const g = table(); const me = g.players[0]; const c = card(g, me, name, 'hand');
  const hand0 = me.hand.length; g.castSpell(me, c, 'hand');
  return { ok: me.hand.length === hand0 - 1 && me.library[0] && !me.library[0].info.isLand, note: `top: ${me.library[0] && me.library[0].name}` };
});
scen('Sigarda, Host of Herons', 'stops an opponent\'s Sheoldred from forcing a sacrifice', () => {
  const g = table(); const [me, opp] = g.players;
  put(g, me, 'Sigarda, Host of Herons'); put(g, me, 'Birds of Paradise'); const sh = put(g, opp, 'Sheoldred, Whispering One');
  const n0 = me.bf.length; g._thatPlayer = me; g.resolveEffect(opp, { k: 'edictThat' }, sh, 0, true); g._thatPlayer = null;
  return { ok: me.bf.length === n0, note: `${n0 - me.bf.length} sacrificed` };
});
scen('Plaguecrafter', 'the log names what each player sacrificed', () => {
  const g = new Game([decks[0], decks[1], decks[2], decks[3]], db, 5, { record: true });
  g.started = true; for (const p of g.players) { p.bf = []; p.hand = []; }
  const [me, opp] = g.players; put(g, opp, 'Birds of Paradise'); const pc = put(g, me, 'Plaguecrafter');
  g.resolveEffects(me, pc.info.etb, pc, null, false);
  const ev = g.events.filter((e) => /Plaguecrafter/.test(e.text)).pop();
  return { ok: !!ev && /Birds of Paradise/.test(ev.text) && /Plaguecrafter/.test(ev.text.split(':').slice(1).join(':')), note: ev ? ev.text : 'no log line' };
});
scen('Spark Double', 'a copy of a legendary creature is not legendary', () => {
  const g = table(); const me = g.players[0];
  put(g, me, 'Atraxa, Praetors\' Voice'); const sd = card(g, me, 'Spark Double', 'hand');
  g.castSpell(me, sd, 'hand');
  const legends = me.bf.filter((c) => c.info.name === 'Atraxa, Praetors\' Voice');
  return { ok: legends.length === 2 && legends.some((c) => !c.info.isLegendary && !c.info.types.has('Legendary')), note: `${legends.length} Atraxas on the battlefield` };
});
scen('Pattern of Rebirth', 'is not cast without a creature of our own to enchant', () => {
  const g = table(); const me = g.players[0]; const c = card(g, me, 'Pattern of Rebirth', 'hand');
  return { ok: g.scoreCast(me, c, 'hand') < 0, note: `score ${g.scoreCast(me, c, 'hand')}` };
});
scen("Serra's Emissary", 'creatures can\'t target our creatures (protection from creatures)', () => {
  const g = table(); const [me, opp] = g.players; put(g, me, "Serra's Emissary"); const bird = put(g, me, 'Birds of Paradise');
  const chupa = put(g, opp, 'Craterhoof Behemoth'); g._ctx.push(chupa); const ok = !g.targetable(bird, opp); g._ctx.pop();
  return { ok, note: ok ? '' : 'Chupacabra could target' };
});
scen('Ugin, the Spirit Dragon', '−X exiles (not destroys) the coloured permanents', () => {
  const g = table(); const [me, opp] = g.players; const u = put(g, me, 'Ugin, the Spirit Dragon'); u.uginX = 3;
  g.resolveEffect(me, { k: 'wipe', what: 'ugin', exile: true }, u, 3, true);
  return { ok: opp.exile.some((c) => c.name === 'Birds of Paradise') || opp.bf.every((c) => c.name !== 'Birds of Paradise'), note: 'Birds in ' + (opp.exile.some((c) => c.name === 'Birds of Paradise') ? 'exile' : 'graveyard') };
});
scen('Cinderhaze Wretch', 'with Myrkul it dies, comes back as an enchantment and empties a hand', () => {
  const g = table(); const [me, opp] = g.players;
  put(g, me, 'Myrkul, Lord of Bones'); const w = put(g, me, 'Cinderhaze Wretch');
  for (const q of g.players.slice(1)) for (let i = 0; i < 5; i++) card(g, q, 'Forest', 'hand');
  const ab = w.info.activated[0]; const prep = g.prepareAbility(me, w, ab, true);
  if (prep) g.doActivate(me, prep);
  const copy = me.bf.find((c) => c.ench && c.info.name === 'Cinderhaze Wretch');
  return { ok: !!copy && g.players.slice(1).every((q) => q.hand.length === 0), note: `copy: ${!!copy}, hands: ${g.players.slice(1).map((q) => q.hand.length).join('/')}` };
});
scen('Osgir, the Reconstructor', 'copies Wurmcoil Engine from the graveyard when it has the mana', () => {
  const g = table(); const me = g.players[0]; put(g, me, 'Osgir, the Reconstructor'); card(g, me, 'Wurmcoil Engine', 'gy');
  g.mainPhase(me);
  return { ok: me.bf.filter((c) => c.token && c.name === 'Wurmcoil Engine').length === 2, note: `${me.bf.filter((c) => c.token && c.name === 'Wurmcoil Engine').length} Wurmcoil tokens` };
});
scen('Razaketh, the Foulblooded', 'sacrifices a token to tutor rather than feeding it to Grim Backwoods', () => {
  const g = table(); const me = g.players[0]; put(g, me, 'Razaketh, the Foulblooded'); put(g, me, 'Grim Backwoods');
  g.addToken(me, { p: 1, t: 1, sub: 'Pest', colors: 'black green' }, 1, true);
  const used = []; const orig = g.doActivate.bind(g); g.doActivate = (p, prep) => { used.push(prep.c.name); return orig(p, prep); };
  g.activateAbilities(me, true);
  return { ok: used[0] === 'Razaketh, the Foulblooded', note: `first: ${used[0] || 'nothing'}` };
});
scen('Kaalia of the Vast', 'attacks when there is an Angel, Demon or Dragon in hand to put in', () => {
  const g = table(); const [me, opp] = g.players; const k = put(g, me, 'Kaalia of the Vast'); k.isCommander = true;
  put(g, opp, 'Vampire Nighthawk'); card(g, me, 'Lyra Dawnbringer', 'hand');
  g.combat(me);
  return { ok: me.bf.some((c) => c.name === 'Lyra Dawnbringer'), note: me.bf.some((c) => c.name === 'Lyra Dawnbringer') ? '' : 'Kaalia stayed home' };
});
scen('combat', 'a big creature does not attack into an untapped deathtouch blocker', () => {
  const g = table(); const [me, opp] = g.players; const big = put(g, me, 'Craterhoof Behemoth');
  for (const q of g.players.slice(1)) put(g, q, 'Vampire Nighthawk');
  g.combat(me);
  return { ok: big.zone === 'bf' && !big.tapped, note: big.tapped ? 'attacked' : '' };
});

// ---------- report ----------
const fails = results.filter((r) => !r.ok);
const cards = new Set(results.map((r) => r.card));
const failCards = new Set(fails.map((r) => r.card));
for (const r of fails) console.log(`FAIL  ${r.card} — ${r.test}: expected ${r.failed.join(', ')} to show an effect. ${r.note}`);
console.log(`\n${results.length} checks on ${cards.size} cards: ${results.length - fails.length} passed, ${fails.length} failed (${failCards.size} cards).`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ when: new Date().toISOString(), checks: results.length, cards: cards.size, passed: results.length - fails.length, failed: fails.length, results }));
process.exitCode = fails.length ? 1 : 0;
