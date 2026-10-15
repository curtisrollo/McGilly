// The scenario library: rules situations the engine has got wrong before, each with the wrong behaviour it
// used to show and the correct result it must produce now. validate.mjs replays every one on every run, so a
// fixed mistake can't quietly come back. Add one whenever a bug is found.
// Each scenario: { card, title, wrong, run(t) } where run returns { ok, note } and t has the table helpers
// (table, put, card, addLand, populate, Game, db, decks).
export default [
  {
    card: 'Doubling Season', title: 'counters are doubled, not quadrupled',
    wrong: 'its token sentence also added a counter doubler, so counters came in at 4x',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Doubling Season');
      return { ok: g.counterAmount(me, 3) === 6, note: `3 counters became ${g.counterAmount(me, 3)}` };
    },
  },
  {
    card: 'Chatterfang, Squirrel General', title: 'makes that many Squirrels besides, instead of doubling the tokens',
    wrong: 'it was read as a token doubler: no Squirrels, twice the Pests',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Chatterfang, Squirrel General');
      const n0 = me.bf.filter((c) => c.token).length;
      g.addToken(me, { p: 1, t: 1, sub: 'Pest', colors: 'black green' }, 2, true);
      const pests = me.bf.filter((c) => c.token && /Pest/.test(c.info.name)).length, sq = me.bf.filter((c) => c.token && /Squirrel/.test(c.info.name)).length;
      return { ok: pests === 2 && sq === 2, note: `${pests} Pests, ${sq} Squirrels (from ${n0} tokens)` };
    },
  },
  {
    card: 'Ayara, First of Locthwain', title: 'a black creature token entering triggers her',
    wrong: 'tokens had no colours, so black Pests and Zombies never counted as black',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Ayara, First of Locthwain');
      const l0 = opp.life; g.addToken(me, { p: 2, t: 2, sub: 'Zombie', colors: 'black' }, 1, true);
      return { ok: opp.life < l0, note: `opponent ${l0} -> ${opp.life}` };
    },
  },
  {
    card: 'Wurmcoil Engine', title: 'its Wurm tokens are artifact creatures',
    wrong: 'tokens were always plain creatures, so Wurms and Constructs never counted as artifacts',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const w = put(g, me, 'Wurmcoil Engine');
      g.destroy(w, 'destroyed', true);
      const wurms = me.bf.filter((c) => c.token && /Wurm/.test(c.info.name));
      return { ok: wurms.length === 2 && wurms.every((c) => c.info.types.has('Artifact')), note: `${wurms.length} Wurms, artifact: ${wurms.map((c) => c.info.types.has('Artifact')).join('/')}` };
    },
  },
  {
    card: 'Osgir, the Reconstructor', title: 'two token copies of a legendary artifact: the legend rule keeps one',
    wrong: 'the legend rule ignored tokens, so Osgir kept several copies of a legend',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Osgir, the Reconstructor'); card(g, me, 'The Mind Stone', 'gy');
      g.resolveEffect(me, { k: 'osgir' }, null, 0, false); g.checkState();
      const n = me.bf.filter((c) => c.name === 'The Mind Stone').length;
      return { ok: n === 1, note: `${n} copies left` };
    },
  },
  {
    card: 'Blood Artist', title: 'triggers when it dies itself',
    wrong: '"Blood Artist or another creature" missed its own death unless a whole board died at once',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const ba = put(g, me, 'Blood Artist');
      const l0 = g.players.slice(1).reduce((a, q) => a + q.life, 0);
      g.destroy(ba, 'sacrificed', true);
      const l1 = g.players.slice(1).reduce((a, q) => a + q.life, 0);
      return { ok: l1 === l0 - 1, note: `opponents' life ${l0} -> ${l1}` };
    },
  },
  {
    card: 'Kalitas, Traitor of Ghet', title: "an exiled opponent's creature doesn't set off dies triggers",
    wrong: 'the creature was exiled but every "whenever a creature dies" still triggered',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Kalitas, Traitor of Ghet'); put(g, me, 'Blood Artist');
      const v = put(g, opp, 'Vampire Nighthawk'); const l0 = g.players.slice(1).reduce((a, q) => a + q.life, 0);
      g.destroy(v);
      const l1 = g.players.slice(1).reduce((a, q) => a + q.life, 0);
      const z = me.bf.some((c) => c.token && /Zombie/.test(c.info.name));
      return { ok: v.zone === 'exile' && l1 === l0 && z, note: `${v.zone}, drain ${l0 - l1}, zombie ${z}` };
    },
  },
  {
    card: 'Enduring Tenacity', title: 'returns once as an enchantment, not again after that',
    wrong: 'destroying the returned enchantment brought it back again',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const c = put(g, me, 'Enduring Tenacity');
      g.destroy(c, 'destroyed', true); const back = c.zone === 'bf';
      g.destroy(c, 'destroyed', true);
      return { ok: back && c.zone === 'gy', note: `after first death ${back ? 'back' : 'gone'}, after second ${c.zone}` };
    },
  },
  {
    card: 'Swords to Plowshares', title: "the exiled creature's controller gains life equal to its power",
    wrong: 'no life was gained',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; for (const q of g.players.slice(1)) put(g, q, 'Craterhoof Behemoth');
      const s = card(g, me, 'Swords to Plowshares', 'hand'); const before = g.players.map((q) => q.life);
      g.castSpell(me, s, 'hand');
      const gained = g.players.map((q, i) => q.life - before[i]).filter((d) => d > 0);
      return { ok: gained.length === 1 && gained[0] === 5, note: `life gained: ${gained.join(',') || 'none'}` };
    },
  },
  {
    card: 'Path to Exile', title: "the exiled creature's controller gets a basic land, tapped",
    wrong: 'no land was fetched',
    run({ table, put, card }) {
      const g = table(); const [me] = g.players; for (const q of g.players.slice(1)) put(g, q, 'Craterhoof Behemoth');
      const s = card(g, me, 'Path to Exile', 'hand'); const lands0 = g.players.map((q) => q.bf.filter((c) => c.info.isLand).length);
      g.castSpell(me, s, 'hand');
      const got = g.players.map((q, i) => q.bf.filter((c) => c.info.isLand).length - lands0[i]);
      return { ok: got.filter((x) => x === 1).length === 1, note: `lands gained: ${got.join(',')}` };
    },
  },
  {
    card: 'Smothering Tithe', title: "an opponent's normal draw-step draw triggers it",
    wrong: 'it only triggered on extra draws, and paying {2} cost nothing',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Smothering Tithe');
      g.active = opp.seat; g.inDrawStep = true; const t0 = me.bf.filter((c) => c.token).length;
      g.draw(opp, 1); g.inDrawStep = false; g.active = me.seat;
      const t1 = me.bf.filter((c) => c.token).length;
      return { ok: t1 === t0 + 1, note: `${t1 - t0} Treasure` };
    },
  },
  {
    card: 'Knight of the Ebon Legion', title: 'its end-step counter happens only on its controller\'s end step',
    wrong: 'it checked on every player\'s end step',
    run({ table, put }) {
      const g = table(); const k = put(g, g.players[0], 'Knight of the Ebon Legion');
      return { ok: k.info.endstep.every((e) => !e.each), note: JSON.stringify(k.info.endstep.map((e) => e.each)) };
    },
  },
  {
    card: 'Platinum Angel', title: "drawing from an empty library doesn't lose the game either",
    wrong: 'empty-library draws still lost the game',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Platinum Angel'); me.library = [];
      g.draw(me, 1); g.checkState();
      return { ok: !me.lost, note: me.lost ? 'lost' : '' };
    },
  },
  {
    card: 'Mana Vault', title: 'tapping it for mana deals no damage (only the draw-step trigger does)',
    wrong: 'every tap dealt 1 damage on top of the draw-step damage',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const mv = put(g, me, 'Mana Vault');
      return { ok: mv.info.mana.opts.every((o) => !o.dmg), note: JSON.stringify(mv.info.mana.opts.map((o) => o.dmg)) };
    },
  },
  {
    card: 'Birthing Pod', title: 'costs {3}{G/P}: mana value 4',
    wrong: 'two-letter hybrid and Phyrexian symbols were dropped, so it cost 3',
    run({ table, put }) {
      const g = table(); const c = put(g, g.players[0], 'Birthing Pod'); const pp = put(g, g.players[0], 'Privileged Position');
      return { ok: c.info.mv === 4 && pp.info.mv === 5, note: `Pod ${c.info.mv}, Privileged Position ${pp.info.mv}` };
    },
  },
  {
    card: 'Sakura-Tribe Elder', title: 'sacrificing it as a cost is a real sacrifice (dies triggers fire)',
    wrong: 'it was moved to the graveyard without dying, so Blood Artist and Pattern of Rebirth never saw it',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const ste = put(g, me, 'Sakura-Tribe Elder'); put(g, me, 'Blood Artist');
      const l0 = g.players.slice(1).reduce((a, q) => a + q.life, 0);
      const ab = ste.info.activated[0]; const prep = g.prepareAbility(me, ste, ab, true) || { c: ste, ab, fodder: [], cost: ab.cost };
      g.doActivate(me, prep);
      const l1 = g.players.slice(1).reduce((a, q) => a + q.life, 0);
      return { ok: ste.zone === 'gy' && l1 < l0, note: `${ste.zone}, drain ${l0 - l1}` };
    },
  },
];
