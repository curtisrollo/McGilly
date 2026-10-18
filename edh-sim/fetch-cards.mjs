// Reads every decklist in decks/, downloads each card's rules data from the
// Forge project's card scripts on GitHub, and writes data/cards.json.
// Usage: node fetch-cards.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const BASE = 'https://raw.githubusercontent.com/Card-Forge/forge/master/forge-gui/res/cardsfolder';
const OUT = path.join(ROOT, 'data', 'cards.json');

export function parseDeck(text) {
  const cards = [];
  let commander = null;
  let section = 'deck';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    if (/^commanders?:?$/i.test(line)) { section = 'commander'; continue; }
    if (/^(deck|mainboard|main):?$/i.test(line)) { section = 'deck'; continue; }
    // "1x Name (set) 123 *F* [Type]" or "1 Name"
    const m = line.match(/^(\d+)x?\s+(.+?)(?:\s+\([^)]*\)\s*\S*)?(?:\s+\*F\*)?(?:\s+\[([^\]]*)\])?$/);
    if (!m) continue;
    const qty = +m[1];
    const name = m[2].trim();
    const tag = m[3] || '';
    if (/commander/i.test(tag) || section === 'commander') {
      if (!commander) commander = name; else cards.push({ qty, name });
    } else cards.push({ qty, name });
  }
  return { commander, cards };
}

// meld halves Forge files under the melded pair's name
const MELD = { 'Gisela, the Broken Blade': 'gisela_the_broken_blade_brisela_voice_of_nightmares' };
function slugs(name) {
  if (MELD[name]) return [MELD[name]];
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/æ/gi, 'ae').toLowerCase();
  const out = new Set();
  for (const n of [base, base.split(' // ')[0]]) {
    const a = n.replace(/\/\//g, ' ').replace(/[^a-z0-9 \-]/g, '').trim();
    out.add(a.replace(/[\s-]+/g, '_'));
    out.add(a.replace(/-/g, '').replace(/\s+/g, '_'));
    out.add(a.replace(/\s+/g, '_'));
  }
  return [...out];
}

function parseFace(block) {
  const f = { name: '', cost: '', types: '', pt: null, loyalty: null, kw: [], oracle: '', mana: [], colors: null };
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1);
    if (k === 'Name') f.name = v;
    else if (k === 'ManaCost') f.cost = v === 'no cost' ? '' : v;
    else if (k === 'Types') f.types = v;
    else if (k === 'PT') f.pt = v;
    else if (k === 'Loyalty') f.loyalty = +v || 0;
    else if (k === 'K') f.kw.push(v);
    else if (k === 'Colors') f.colors = v;
    else if (k === 'Oracle') f.oracle = v.replace(/\\n/g, '\n');
    else if (k === 'A' && /^AB\$ Mana\b/.test(v)) {
      const cost = (v.match(/Cost\$ ([^|]+)/) || [])[1]?.trim();
      const prod = (v.match(/Produced\$ ([^|]+)/) || [])[1]?.trim();
      const amt = (v.match(/Amount\$ ([^|]+)/) || [])[1]?.trim();
      if (prod) f.mana.push({ cost, produced: prod, amount: /^\d+$/.test(amt || '') ? +amt : 1 });
    }
  }
  return f;
}

async function fetchCard(name) {
  for (const s of slugs(name)) {
    const url = `${BASE}/${s[0]}/${s}.txt`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url);
        if (r.status === 404) break;
        if (!r.ok) throw new Error(r.status);
        const text = await r.text();
        const faces = text.split(/\n\s*ALTERNATE\s*\n/).map(parseFace);
        const alt = (text.match(/AlternateMode:(\w+)/) || [])[1] || null;
        return { faces, alt };
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  return null;
}

async function main() {
  const decksDir = path.join(ROOT, 'decks');
  const names = new Set();
  for (const f of fs.readdirSync(decksDir).filter((f) => f.endsWith('.txt'))) {
    const d = parseDeck(fs.readFileSync(path.join(decksDir, f), 'utf8'));
    if (d.commander) names.add(d.commander);
    d.cards.forEach((c) => names.add(c.name));
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const db = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const todo = [...names].filter((n) => !db[n]);
  console.log(`${names.size} unique cards, ${todo.length} to fetch`);
  const missing = [];
  let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < todo.length) {
      const n = todo[i++];
      const c = await fetchCard(n);
      if (c) db[n] = c; else missing.push(n);
    }
  }));
  fs.writeFileSync(OUT, JSON.stringify(db));
  console.log(missing.length ? `Not found: ${missing.join(', ')}` : 'All cards found');
}

if (process.argv[1] && process.argv[1].endsWith('fetch-cards.mjs')) main();
