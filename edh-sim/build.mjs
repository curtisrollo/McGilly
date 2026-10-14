// Bundles the simulator, card data and decklists into one HTML page: dist/pod-night.html
// Usage: node fetch-cards.mjs && node build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { parseDeck } from './fetch-cards.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const db = JSON.parse(read('data/cards.json'));
const NAMES = { edgar: 'Edgar', kaalia: 'Kaalia', beledros: 'Beledros', atraxa: 'Atraxa', osgir: 'Osgir', myrkul: 'Myrkul', muldrotha: 'Muldrotha' };
const order = ['edgar', 'kaalia', 'beledros', 'atraxa', 'osgir', 'myrkul', 'muldrotha'];
const files = fs.readdirSync(path.join(ROOT, 'decks')).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''))
  .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
const decks = files.map((id) => {
  const d = parseDeck(read(`decks/${id}.txt`));
  const missing = d.cards.filter((c) => !db[c.name]).map((c) => c.name);
  if (missing.length) console.warn(`${id}: missing card data for ${missing.join(', ')}`);
  return { id, name: NAMES[id] || d.commander.split(',')[0], commander: d.commander, cards: d.cards };
});
const used = new Set(decks.flatMap((d) => [d.commander, ...d.cards.map((c) => c.name)]));
const slim = Object.fromEntries(Object.entries(db).filter(([k]) => used.has(k)));
const art = { map: JSON.parse(read('src/art-map.json')), icons: JSON.parse(read('vendor/game-icons-subset.json')).icons };
const data = JSON.stringify({ decks, db: slim, art }).replace(/</g, '\\u003c');
const html = read('src/template.html')
  .replace('/*STYLE*/', () => read('src/style.css'))
  .replace('/*DATA*/', () => data)
  .replace('/*ENGINE*/', () => read('src/engine.js'))
  .replace('/*UI*/', () => read('src/ui.js'))
  .replace('/*DECKCOUNT*/', () => decks.map((d) => `${d.name} (${d.cards.reduce((s, c) => s + c.qty, 0) + 1} cards)`).join(', '));
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist', 'pod-night.html'), html);
console.log(`dist/pod-night.html written (${(html.length / 1024).toFixed(0)} KB, ${decks.length} decks)`);
