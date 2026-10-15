// Shows a card's rules text next to everything the engine took from it, and its script if it has one.
// Usage: node explain.mjs "Card Name" ["Another Card" ...]   or   node explain.mjs --deck myrkul
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseDeck } from './fetch-cards.mjs';
const require = createRequire(import.meta.url);
const { analyzeCard } = require('./src/engine.js');
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const src = fs.readFileSync('src/engine.js', 'utf8').split('\n');
let names = process.argv.slice(2);
if (names[0] === '--deck') { const d = parseDeck(fs.readFileSync(`decks/${names[1]}.txt`, 'utf8')); names = [d.commander, ...d.cards.map((c) => c.name)]; }
const skip = new Set(['name', 'face', 'faces', 'text', 'types', 'subtypes', 'colors', 'cost', 'unmodeled']);
const show = (v) => JSON.stringify(v, (k, x) => (x instanceof Set ? [...x] : x));
for (const n of names) {
  const d = db[n];
  if (!d) { console.log(`## ${n}: not in card data\n`); continue; }
  const a = analyzeCard(d, ['W', 'U', 'B', 'R', 'G'], n);
  console.log(`## ${n}  [${d.faces.map((f) => f.types).join(' // ')}]  cost: ${d.faces[0].cost}`);
  for (const f of d.faces) console.log('ORACLE' + (d.faces.length > 1 ? ` (${f.name})` : '') + ': ' + f.oracle.replace(/\n/g, ' | '));
  const out = [];
  for (const [k, v] of Object.entries(a)) {
    if (skip.has(k) || v == null || v === false || (Array.isArray(v) && !v.length) || (v instanceof Set && !v.size)) continue;
    if (k === 'isPermanent' || k === 'mv' || k === 'scripted') continue;
    out.push(`${k}=${show(v)}`);
  }
  console.log('ENGINE: ' + out.join('  '));
  const line = src.findIndex((l) => l.includes(`'${n.replace(/'/g, "\\'")}':`) || l.includes(`"${n}":`));
  if (line >= 0) console.log(`SCRIPT (src/engine.js:${line + 1}): ${src[line].trim()}`);
  console.log('');
}
