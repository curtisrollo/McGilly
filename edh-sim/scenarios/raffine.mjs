// Scenarios for the Raffine deck. Same shape as ../scenarios.mjs. Raffine's deck is seat 0 with table(11, 7).
const raffine = (table) => table(11, 7);
const tapLands = (p) => { for (const c of p.bf) if (c.info.isLand) c.tapped = true; };
// responses to spells are random (likelier for dangerous spells): make them always fire
const sure = (g) => { const r = g.R, f = () => 0; Object.assign(f, r); for (const k of ['shuffle', 'int', 'pick']) if (r[k]) f[k] = r[k].bind ? r[k].bind(r) : r[k]; g.R = f; return g; };
export default [
  // ---------- alternative costs ----------
  {
    card: 'Snuff Out', title: 'with no mana and a Swamp out, pays 4 life and destroys a nonblack creature (not the black one)',
    wrong: 'its "pay 4 life rather than pay" cost was not read, and "nonblack creature" was treated as any creature',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.hand = []; put(g, me, 'Swamp'); tapLands(me);
      const nh = put(g, opp, 'Vampire Nighthawk'); const gn = put(g, opp, 'Old Gnawbone'); const so = card(g, me, 'Snuff Out', 'hand');
      g.mainPhase(me);
      return { ok: so.zone !== 'hand' && gn.zone !== 'bf' && nh.zone === 'bf' && me.life === 36, note: `Snuff Out ${so.zone}; Gnawbone ${gn.zone}, Nighthawk ${nh.zone}; life ${me.life}` };
    },
  },
  {
    card: 'Flare of Denial', title: 'its alternative cost sacrifices the cheapest nontoken blue creature',
    wrong: 'the "sacrifice a nontoken blue creature rather than pay" cost was not read: it needed mana',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; tapLands(me);
      const frog = put(g, me, 'Psychic Frog'); const sphinx = put(g, me, 'Archfiend of Ifnir'); const fl = card(g, me, 'Flare of Denial', 'hand');
      const ok1 = g.altCostOk(me, fl); g.payAltCost(me, fl);
      return { ok: ok1 && frog.zone !== 'bf' && sphinx.zone === 'bf', note: `available ${ok1}; Psychic Frog ${frog.zone}` };
    },
  },
  // ---------- spells that target spells ----------
  {
    card: 'Reprieve', title: 'returns an opponent\'s spell to their hand, and draws a card',
    wrong: '"return target spell to its owner\'s hand" was not read (no effect), and a counter never resolved the rest of its text',
    run({ table, card }) {
      const g = sure(raffine(table)); const [me, opp] = g.players; me.hand = []; const rp = card(g, me, 'Reprieve', 'hand');
      const gn = card(g, opp, 'Old Gnawbone', 'hand'); const h0 = me.hand.length; g.active = opp.seat;
      g.castSpell(opp, gn, 'hand');
      return { ok: gn.zone === 'hand' && opp.hand.includes(gn) && rp.zone === 'gy' && me.hand.length === h0, note: `Gnawbone in ${gn.zone}; Reprieve in ${rp.zone}; hand ${h0} -> ${me.hand.length} (Reprieve out, a card in)` };
    },
  },
  {
    card: 'Spider-Sense', title: 'counters an instant or sorcery',
    wrong: '"counter target instant spell, sorcery spell, or triggered ability" was not read',
    run({ table, card }) {
      const g = sure(raffine(table)); const [me, opp] = g.players; me.hand = []; card(g, me, 'Spider-Sense', 'hand');
      const dt = card(g, opp, 'Demonic Tutor', 'hand'); g.active = opp.seat; g.castSpell(opp, dt, 'hand');
      return { ok: dt.zone === 'gy', note: `Demonic Tutor in ${dt.zone}` };
    },
  },
  {
    card: 'Consign to Memory', title: 'counters a colorless spell, not a colored one',
    wrong: '"counter target triggered ability or colorless spell" was not read',
    run({ table, card }) {
      const g = sure(raffine(table)); const [me, opp] = g.players; me.hand = []; card(g, me, 'Consign to Memory', 'hand');
      const dt = card(g, opp, 'Demonic Tutor', 'hand'); g.active = opp.seat; g.castSpell(opp, dt, 'hand');
      const bc = card(g, opp, 'Blightsteel Colossus', 'hand'); g.castSpell(opp, bc, 'hand');
      return { ok: dt.zone !== 'stack' && dt.zone !== 'hand' && bc.zone !== 'bf', note: `Demonic Tutor resolved (${dt.zone}); Blightsteel Colossus in ${bc.zone}` };
    },
  },
  {
    card: 'Prismatic Strands', title: 'cast from hand to prevent a lethal attack',
    wrong: 'its prevention was not read, and no fog spell was ever cast from hand in combat (only Spore Frog fogged)',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.hand = []; me.life = 7; me.bf = me.bf.filter((c) => c.info.isLand);
      card(g, me, 'Prismatic Strands', 'hand'); const gn = put(g, opp, 'Old Gnawbone'); gn.sick = false;
      g.chooseDefender = () => me; g.active = opp.seat; g.phase = 'combat'; g.combat(opp);
      return { ok: me.life === 7 && !me.lost, note: `life ${me.life}` };
    },
  },
  // ---------- graveyard ----------
  {
    card: 'Living Death', title: 'graveyard creatures come back and battlefield creatures die, for every player',
    wrong: 'it had no effect',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.bf = me.bf.filter((c) => c.info.isLand); opp.bf = opp.bf.filter((c) => c.info.isLand);
      const mine = card(g, me, 'Archon of Cruelty', 'gy'); const theirs = put(g, opp, 'Old Gnawbone'); const ld = card(g, me, 'Living Death', 'hand');
      g.resolveEffects(me, ld.info.spell, ld, null, true);
      return { ok: mine.zone === 'bf' && theirs.zone !== 'bf', note: `Archon ${mine.zone}, Gnawbone ${theirs.zone}` };
    },
  },
  {
    card: 'Victimize', title: 'sacrifices the cheapest creature and returns the two best from the graveyard, tapped',
    wrong: 'it had no effect',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; me.bf = me.bf.filter((c) => c.info.isLand); me.gy = [];
      const fod = put(g, me, 'Generous Pup'); const a = card(g, me, 'Archon of Cruelty', 'gy'); const b = card(g, me, 'Elesh Norn, Grand Cenobite', 'gy'); card(g, me, 'Moonshadow', 'gy');
      const v = card(g, me, 'Victimize', 'hand'); g.resolveEffects(me, v.info.spell, v, null, true);
      return { ok: fod.zone !== 'bf' && a.zone === 'bf' && b.zone === 'bf' && a.tapped && b.tapped, note: `Pup ${fod.zone}; Archon ${a.zone}${a.tapped ? ' tapped' : ''}, Elesh Norn ${b.zone}` };
    },
  },
  {
    card: 'Treasure Cruise', title: 'delve: exiles graveyard cards to pay, so it is cast with one land',
    wrong: 'delve was not read: it needed eight mana',
    run({ table, card, addLand }) {
      const g = raffine(table); const me = g.players[0]; me.hand = []; me.bf = []; me.gy = []; addLand(g, me);
      for (const n of ['Sol Ring', 'Forest', 'Exploration', 'Swamp', 'Island', 'Plains', 'Mountain']) card(g, me, n, 'gy');
      const tc = card(g, me, 'Treasure Cruise', 'hand'); const d0 = me.cardsDrawn; g.mainPhase(me);
      return { ok: tc.zone !== 'hand' && me.exile.length >= 7 && me.cardsDrawn - d0 >= 3, note: `Cruise ${tc.zone}; exiled ${me.exile.length}; drew ${me.cardsDrawn - d0}` };
    },
  },
  {
    card: 'Wonder', title: 'in the graveyard with an Island out, our creatures fly',
    wrong: 'its graveyard ability was not read',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; const pup = put(g, me, 'Generous Pup'); put(g, me, 'Island');
      const before = g.hasKw(pup, 'flying'); card(g, me, 'Wonder', 'gy'); g.emit('effect', 'x'); const after = g.hasKw(pup, 'flying');
      return { ok: !before && after, note: `flying ${before} -> ${after}` };
    },
  },
  {
    card: 'Moonshadow', title: 'enters with six -1/-1 counters',
    wrong: '"enters with -1/-1 counters" was not read',
    run({ table, card }) {
      const g = raffine(table); const me = g.players[0]; const m = card(g, me, 'Moonshadow', 'hand'); g.removeFrom(me.hand, m); g.enterBattlefield(m, me, { quiet: true });
      return { ok: m.p1 === -6, note: `counters ${m.p1}` };
    },
  },
  {
    card: 'Force of Negation', title: 'free (exile a blue card) only on an opponent\'s turn',
    wrong: '(regression guard for the general alternative-cost code)',
    run({ table, card }) {
      const g = raffine(table); const [me, opp] = g.players; const f = card(g, me, 'Force of Negation', 'hand'); card(g, me, 'Psychic Frog', 'hand');
      g.active = me.seat; const mine = g.altCostOk(me, f); g.active = opp.seat; const theirs = g.altCostOk(me, f);
      return { ok: !mine && theirs, note: `own turn ${mine}, opponent's turn ${theirs}` };
    },
  },
];
