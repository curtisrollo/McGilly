// Prints a one-line summary of what the engine understood for each card. Usage: node dump.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { analyzeCard } = require('./src/engine.js');
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const f = (l) => (l || []).map((x) => x.k + (x.n != null ? ':' + x.n : '') + (x.what ? ':' + x.what : '') + (x.dest ? '>' + x.dest : '') + (x.types ? '[' + x.types.join('/') + ']' : '')).join(',');
for (const [name, data] of Object.entries(db).sort()) {
  const a = analyzeCard(data, ['W', 'U', 'B', 'R', 'G'], name);
  if (a.isLand && !a.activated.length && !a.etb.length && !a.landfall) continue;
  const parts = [];
  const add = (k, v) => v && parts.push(k + '=' + v);
  add('spell', f(a.spell)); add('etb', f(a.etb)); add('dies', f(a.dies)); add('atk', f(a.attack)); add('cdmg', f(a.combatDmg));
  add('upk', a.upkeep.map((u) => (u.opp ? 'opp:' : u.each ? 'each:' : '') + f(u.fx)).join('|')); add('end', a.endstep.map((u) => f(u.fx)).join('|'));
  add('cast', a.castTrig.map((t) => t.filter + '>' + f(t.fx)).join('|')); add('deathW', a.deathWatch.map((w) => w.scope + '>' + f(w.fx)).join('|'));
  add('stat', a.statics.map((x) => x.k + (x.sub ? ':' + x.sub : '') + (x.p ? '+' + x.p + '/' + x.t : '') + (x.kw && x.kw.length ? '[' + x.kw + ']' : '')).join(','));
  add('trig', a.triggers.map((t) => t.k + (t.fx ? '>' + f(t.fx) : '')).join(','));
  add('act', a.activated.map((x) => f(x.fx)).join('|')); add('pw', a.loyaltyAbs.map((x) => x.delta + ':' + f(x.fx)).join('|'));
  add('myEtb', (a.myCreatureEtb || []).map(f).join('|')); add('anyEtb', f(a.anyCreatureEtb)); if (a.fodderMana) parts.push('fodderMana:' + a.fodderMana.what);
  add('land', (a.landfall || []).map(f).join('|')); add('const', (a.constellation || []).map(f).join('|'));
  const flags = Object.keys(a).filter((k) => a[k] === true && !/^is|^types$|ptStar|scripted/.test(k));
  add('flags', flags.join(','));
  if (a.mana) parts.push('mana');
  console.log(`${name}: ${parts.join('  ')}`);
}
