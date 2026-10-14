// Lists every card whose rules text the engine doesn't fully model. Usage: node audit.mjs [--all]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { analyzeCard } = require('./src/engine.js');
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
let gaps = 0;
for (const [name, data] of Object.entries(db).sort()) {
  const a = analyzeCard(data, ["W","U","B","R","G"], name);
  const misc = a.statics.filter((s) => s.k === 'misc').length;
  const lines = [...new Set(a.unmodeled)].filter((l) => !/^(this spell can't be countered|cardname can be your commander)/i.test(l) && !/^\{T\}(, Pay 1 life)?: Add/.test(l) && !/^Add \{/.test(l));
  const nothing = !a.isLand && !a.mana && a.isPermanent === false && !a.spell.length && !a.redirect;
  // cast triggers must name a real card type / subtype (catches mis-parses like "nother vampire")
  for (const t of a.castTrig) { const w = t.filter.split(/\s+/)[0]; if (w && !/^(creature|noncreature|instant|artifact|enchantment|colorless|[a-z]+)$/.test(w) || /^(nother|n)$/.test(w)) lines.push(`(cast trigger filter looks wrong: "${t.filter}")`); }
  if (lines.length || misc || nothing) { gaps++; console.log(`${name}\n   ${[...lines, misc ? '(misc static)' : '', nothing ? '(spell with no effect)' : ''].filter(Boolean).join('\n   ')}`); }
}
console.log('cards with gaps:', gaps, 'of', Object.keys(db).length);
