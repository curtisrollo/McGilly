// Scenarios for the Raffine deck. Same shape as ../scenarios.mjs. Raffine's deck is seat 0 with table(11, 7).
const raffine = (table) => table(11, 7);
const tapLands = (p) => { for (const c of p.bf) if (c.info.isLand) c.tapped = true; };
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
