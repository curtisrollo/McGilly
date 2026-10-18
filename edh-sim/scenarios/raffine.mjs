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
