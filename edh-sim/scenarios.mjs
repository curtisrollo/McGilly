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
  {
    card: 'Kaalia of the Vast', title: 'a creature she puts in attacking does not get its own attack trigger',
    wrong: 'a cheated-in Aurelia gave an extra combat (it was never declared as an attacker)',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; const k = put(g, me, 'Kaalia of the Vast'); k.isCommander = true;
      card(g, me, 'Aurelia, the Warleader', 'hand');
      const ev = []; const em = g.emit.bind(g); g.emit = (kind, text, x) => { ev.push(text); return em(kind, text, x); };
      g.combat(me);
      const extra = ev.filter((t) => /additional combat/.test(t)).length;
      return { ok: me.bf.some((c) => c.name === 'Aurelia, the Warleader') && extra === 0, note: `${extra} extra combats` };
    },
  },
  {
    card: 'Aurelia, the Warleader', title: 'gives exactly one extra combat, untapping everything',
    wrong: 'extra combats were capped at one per turn across all sources and could be overwritten by another trigger',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Aurelia, the Warleader'); put(g, me, 'Craterhoof Behemoth');
      const ev = []; const em = g.emit.bind(g); g.emit = (kind, text, x) => { ev.push(text); return em(kind, text, x); };
      g._forceAttack = true; g.combat(me); g._forceAttack = false;
      const extra = ev.filter((t) => /additional combat/.test(t)).length, atk = ev.filter((t) => / attacks /.test(t)).length;
      return { ok: extra === 1 && atk === 2, note: `${extra} extra combats, ${atk} attacks` };
    },
  },
  {
    card: 'Scourge of the Throne', title: 'the extra combat depends on attacking the player with the most life, checked when it attacks',
    wrong: 'it was checked after damage, when the player hit usually no longer had the most life',
    run({ table, put }) {
      const g = table(); const [me, a, b, c] = g.players; put(g, me, 'Scourge of the Throne');
      a.life = 50; b.life = 30; c.life = 30; me.life = 30;
      const ev = []; const em = g.emit.bind(g); g.emit = (kind, text, x) => { ev.push(text); return em(kind, text, x); };
      g.chooseDefender = () => a; g._forceAttack = true; g.combat(me); g._forceAttack = false;
      return { ok: ev.some((t) => /additional combat/.test(t)), note: ev.filter((t) => /attacks|combat/.test(t)).slice(0, 3).join(' | ') };
    },
  },
  {
    card: 'Doubling Season', title: "doesn't double the loyalty a planeswalker's + ability costs, but doubles its starting loyalty",
    wrong: 'every + ability was doubled (it only applies to counters from effects)',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Doubling Season');
      return { ok: g.counterAmount(me, 1, 'cost') === 1 && g.counterAmount(me, 4, 'loyalty') === 8, note: `+1 cost -> ${g.counterAmount(me, 1, 'cost')}, enters with 4 -> ${g.counterAmount(me, 4, 'loyalty')}` };
    },
  },
  {
    card: 'Pir, Imaginative Rascal', title: 'adds one to +1/+1 counters only (not loyalty)',
    wrong: 'it was read as a counter doubler',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Pir, Imaginative Rascal');
      return { ok: g.counterAmount(me, 2, 'p1') === 3 && g.counterAmount(me, 2, 'loyalty') === 2, note: `+1/+1: ${g.counterAmount(me, 2, 'p1')}, loyalty: ${g.counterAmount(me, 2, 'loyalty')}` };
    },
  },
  {
    card: 'Ajani Steadfast', title: '-2 also puts a loyalty counter on each other planeswalker',
    wrong: 'only the creatures got counters',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const aj = put(g, me, 'Ajani Steadfast'); const jace = put(g, me, 'Jace, the Mind Sculptor'); const l0 = jace.loyalty;
      g.resolveEffects(me, aj.info.loyaltyAbs[1].fx, aj, null, true);
      return { ok: jace.loyalty === l0 + 1, note: `Jace ${l0} -> ${jace.loyalty}` };
    },
  },
  {
    card: 'Teferi, Time Raveler', title: '-3 returns an artifact, creature or enchantment to hand, then draws',
    wrong: 'it only drew a card',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const t = put(g, me, 'Teferi, Time Raveler'); const hoof = put(g, opp, 'Craterhoof Behemoth');
      g.resolveEffects(me, t.info.loyaltyAbs.find((x) => x.delta === -3).fx, t, null, true);
      return { ok: hoof.zone === 'hand', note: hoof.zone };
    },
  },
  {
    card: 'Liliana of the Veil', title: '-2 makes one target player sacrifice, not every opponent',
    wrong: 'every opponent sacrificed a creature',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const l = put(g, me, 'Liliana of the Veil');
      for (const q of g.players.slice(1)) put(g, q, 'Birds of Paradise');
      g.resolveEffects(me, l.info.loyaltyAbs.find((x) => x.delta === -2).fx, l, null, true);
      const left = g.players.slice(1).filter((q) => q.bf.some((c) => c.name === 'Birds of Paradise')).length;
      return { ok: left === 2, note: `${3 - left} sacrificed` };
    },
  },
  {
    card: 'Jace, the Mind Sculptor', title: '0 draws three and puts two back (net one card)',
    wrong: 'it drew three and kept them all',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const j = put(g, me, 'Jace, the Mind Sculptor'); const h0 = me.hand.length;
      g.resolveEffects(me, j.info.loyaltyAbs.find((x) => x.delta === 0).fx, j, null, true);
      return { ok: me.hand.length === h0 + 1, note: `hand ${h0} -> ${me.hand.length}` };
    },
  },
  {
    card: 'Archfiend of Despair', title: "triggers at every player's end step",
    wrong: "it did nothing on opponents' end steps",
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Archfiend of Despair');
      g.loseLife(opp, 5); const l0 = opp.life; g._thatPlayer = opp;
      for (const e of me.bf.find((c) => c.name === 'Archfiend of Despair').info.endstep) g.resolveEffects(me, e.fx, null, null, true);
      return { ok: opp.life === l0 - 5, note: `${l0} -> ${opp.life}` };
    },
  },
  {
    card: 'Bloodletter of Aclazotz', title: 'doubles the life lost, not commander damage or lifelink',
    wrong: 'commander damage and lifelink were counted on the doubled life loss',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Bloodletter of Aclazotz'); const e = put(g, me, 'Edgar Markov'); e.isCommander = true;
      g.hitPlayer(me, opp, e, 4, [], () => {});
      return { ok: opp.cmdDmg[e.id] === 4 && opp.life === 32, note: `commander damage ${opp.cmdDmg[e.id]}, life ${opp.life}` };
    },
  },
  {
    card: 'Phyrexian Tower', title: 'sacrificing a creature adds {B}{B}',
    wrong: 'it added two colorless mana',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const t = put(g, me, 'Phyrexian Tower'); const b = put(g, me, 'Birds of Paradise');
      me.floating = {}; g.sacrifice(me, b, t);
      return { ok: (me.floating.B || 0) === 2, note: JSON.stringify(me.floating) };
    },
  },
  {
    card: 'Yahenni, Undying Partisan', title: 'sacrifices another creature to survive removal',
    wrong: 'its sacrifice ability did nothing',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const y = put(g, me, 'Yahenni, Undying Partisan'); put(g, me, 'Birds of Paradise');
      g.destroy(y);
      return { ok: y.zone === 'bf' && !me.bf.some((c) => c.name === 'Birds of Paradise'), note: `Yahenni ${y.zone}` };
    },
  },
  {
    card: 'Yawgmoth, Thran Physician', title: 'puts a -1/-1 counter on a creature as well as drawing',
    wrong: 'it only drew',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const y = put(g, me, 'Yawgmoth, Thran Physician'); const bird = put(g, opp, 'Birds of Paradise');
      g.resolveEffects(me, y.info.activated[0].fx, y, null, true);
      return { ok: bird.zone !== 'bf', note: bird.zone };
    },
  },
  {
    card: "Serra's Sanctum", title: 'taps for {W} for each enchantment you control',
    wrong: 'it tapped for one mana',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; me.bf = []; const s = put(g, me, "Serra's Sanctum"); put(g, me, 'Exploration'); put(g, me, 'Doubling Season'); put(g, me, 'Smothering Tithe');
      return { ok: g.availableMana(me) === 3, note: `${g.availableMana(me)} mana` };
    },
  },
  {
    card: 'Myrkul, Lord of Bones', title: 'with Doubling Season, a dying creature comes back as two enchantment copies (summoning sick)',
    wrong: 'only one copy was made, and copies could tap or attack right away',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Myrkul, Lord of Bones'); put(g, me, 'Doubling Season'); const w = put(g, me, 'Eternal Witness');
      g.destroy(w, 'destroyed', true);
      const copies = me.bf.filter((c) => c.ench && c.name === 'Eternal Witness');
      return { ok: copies.length === 2 && copies.every((c) => c.sick), note: `${copies.length} copies` };
    },
  },
  {
    card: 'Academy Rector', title: 'it has to exile itself to search; a token copy can\'t',
    wrong: 'the search happened even when the Rector could not be exiled (Myrkul copy, already exiled)',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Myrkul, Lord of Bones'); const r = put(g, me, 'Academy Rector');
      const ench0 = me.bf.filter((c) => c.info.types.has('Enchantment') && !c.ench).length;
      g.destroy(r, 'destroyed', true); // Myrkul exiles it first: the Rector's own search fails
      const ench1 = me.bf.filter((c) => c.info.types.has('Enchantment') && !c.ench).length;
      return { ok: ench1 === ench0, note: `fetched ${ench1 - ench0} enchantments` };
    },
  },
  {
    card: 'Patron of the Vein', title: "an opponent's creature that dies is exiled",
    wrong: 'it stayed in the graveyard',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Patron of the Vein'); const b = put(g, opp, 'Birds of Paradise');
      g.destroy(b);
      return { ok: b.zone === 'exile', note: b.zone };
    },
  },
  {
    card: 'Opalescence', title: 'Starfield of Nyx is animated by Opalescence (they animate each other)',
    wrong: 'each excluded the other',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Opalescence'); const st = put(g, me, 'Starfield of Nyx'); g.refreshAnimations();
      return { ok: st.info.isCreature, note: `Starfield creature: ${st.info.isCreature}` };
    },
  },
  {
    card: 'Heliod, Sun-Crowned', title: 'becomes a creature with devotion to white of five or more',
    wrong: 'it was never a creature',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const h = put(g, me, 'Heliod, Sun-Crowned'); put(g, me, 'Archon of Sun\'s Grace'); put(g, me, 'Elesh Norn, Grand Cenobite'); g.refreshAnimations();
      return { ok: h.info.isCreature, note: `creature: ${h.info.isCreature}` };
    },
  },
  {
    card: 'Chrome Mox', title: 'taps only for the colours of the card it imprinted',
    wrong: "it tapped for any of the deck's colours, even with nothing imprinted",
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const m = put(g, me, 'Chrome Mox');
      const src = g.sources(me).find((x) => x.c === m);
      return { ok: !src, note: src ? 'made mana with nothing imprinted' : '' };
    },
  },
];
