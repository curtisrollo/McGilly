// Scenarios for the osgir deck. Same shape as ../scenarios.mjs.
const OSG = 6; // decks/ index of osgir.txt: table(11, OSG) seats the Osgir deck first
const libClear = (p) => { for (const c of p.library) c.zone = 'exile'; p.library = []; };
export default [
  {
    card: 'Aetherflux Reservoir', title: 'at 898 life, pays 50 to shoot a player on 23 (mistake-finder, seed 100072)',
    wrong: 'damage abilities scored a flat +5 and 50 life cost -20 whatever the life total, so it was never used',
    run({ table, put }) {
      const g = table(11, 6); g.lookahead = false; const [me, opp] = g.players; me.life = 898; opp.life = 23; me.hand = []; put(g, me, 'Aetherflux Reservoir'); // the rules alone (the look-ahead was off for a player who had gone infinite)
      g.mainPhase(me, true);
      return { ok: opp.lost, note: `opponent at ${opp.life}${opp.lost ? ' (out)' : ''}, our life ${me.life}` };
    },
  },
  {
    card: 'Quicksmith Genius', title: 'each Osgir token copy entering is an artifact entering, so it loots twice',
    wrong: 'Osgir\'s copies were made without entering the battlefield, so nothing that watches artifacts entering saw them',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Osgir, the Reconstructor'); put(g, me, 'Quicksmith Genius'); card(g, me, 'Sol Ring', 'gy');
      card(g, me, 'Mountain', 'hand'); card(g, me, 'Plains', 'hand');
      g.resolveEffect(me, { k: 'osgir' }, null, 0, false);
      const lands = me.hand.filter((c) => c.info.isLand).length;
      return { ok: lands === 0 && me.gy.filter((c) => c.info.isLand).length === 2, note: `lands left in hand ${lands}` };
    },
  },
  {
    card: 'Quicksmith Genius', title: 'a Treasure token entering is an artifact entering: it loots',
    wrong: 'tokens made by addToken (Treasure, Clue, Food) never told artifact-enters watchers',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Quicksmith Genius'); card(g, me, 'Mountain', 'hand');
      g.addToken(me, { treasure: true }, 1, true);
      return { ok: !me.hand.some((c) => c.name === 'Mountain') && me.hand.length === 1, note: `hand: ${me.hand.map((c) => c.name).join(', ')}` };
    },
  },
  {
    card: 'Solemn Simulacrum', title: 'two Osgir copies each fetch a basic land as they enter',
    wrong: 'the copies skipped enters-the-battlefield triggers',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Osgir, the Reconstructor'); card(g, me, 'Solemn Simulacrum', 'gy');
      card(g, me, 'Plains', 'library'); card(g, me, 'Mountain', 'library'); me.library.unshift(...me.library.splice(-2));
      const n0 = me.bf.filter((c) => c.info.isLand).length;
      g.resolveEffect(me, { k: 'osgir' }, null, 0, false);
      return { ok: me.bf.filter((c) => c.info.isLand).length === n0 + 2, note: `${me.bf.filter((c) => c.info.isLand).length - n0} lands fetched` };
    },
  },
  {
    card: 'Ichor Wellspring', title: 'draws when it goes to the graveyard from the battlefield, token copies too',
    wrong: 'a token copy (Osgir) leaving the battlefield skipped the "put into a graveyard" draw',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0];
      const real = put(g, me, 'Ichor Wellspring'); const h0 = me.hand.length; g.destroy(real, 'sacrificed', true);
      const h1 = me.hand.length;
      const t = g.makeToken(me, { sub: 'copy' }); t.info = real.info; t.name = real.name; me.bf.push(t);
      g.destroy(t, 'sacrificed', true);
      return { ok: h1 === h0 + 1 && me.hand.length === h1 + 1, note: `card: +${h1 - h0}, token: +${me.hand.length - h1}` };
    },
  },
  {
    card: "Ugin's Nexus", title: 'if it would die it is exiled instead and its controller takes an extra turn (token copies too)',
    wrong: 'the replacement only looked at nontoken cards',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0];
      const n = put(g, me, "Ugin's Nexus"); g.destroy(n, 'destroyed');
      const real = n.zone === 'exile' && me.extraTurn === 1;
      const t = g.makeToken(me, { sub: 'copy' }); t.info = n.info; t.name = n.name; me.bf.push(t); g.destroy(t, 'destroyed');
      return { ok: real && me.extraTurn === 2, note: `card exiled: ${n.zone}, extra turns ${me.extraTurn}` };
    },
  },
  {
    card: 'Mystic Forge', title: 'casts an artifact from the top of the library',
    wrong: 'cards on top of the library were never offered',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Mystic Forge');
      const sr = card(g, me, 'Wurmcoil Engine', 'library'); me.library.unshift(me.library.pop());
      g.mainPhase(me);
      return { ok: sr.zone === 'bf', note: `Wurmcoil is in ${sr.zone}` };
    },
  },
  {
    card: 'Moonsilver Key', title: 'can find a basic land when no artifact with a mana ability is left',
    wrong: 'its search only looked at artifacts with mana abilities, never basic lands',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; libClear(me); card(g, me, 'Plains', 'library'); card(g, me, 'Wurmcoil Engine', 'library');
      const c = g.chooseTutor(me, 'manaArtifact');
      return { ok: !!c && c.name === 'Plains', note: `found ${c ? c.name : 'nothing'}` };
    },
  },
  {
    card: 'Osgir, the Reconstructor', title: 'a token copy of Darksteel Forge is not thrown away as Castle Doom fodder',
    wrong: 'every noncreature token was valued like a Treasure (1.5), so Osgir copies of big artifacts were sacrificed for small effects',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; card(g, me, 'Darksteel Forge', 'gy');
      put(g, me, 'Osgir, the Reconstructor'); g.resolveEffect(me, { k: 'osgir' }, null, 0, false); put(g, me, 'Castle Doom'); for (const c of me.bf) c.tapped = false;
      const toks = me.bf.filter((c) => c.token && c.name === 'Darksteel Forge');
      g.activateAbilities(me, false);
      return { ok: toks.length === 2 && toks.every((c) => c.zone === 'bf'), note: `Forge tokens left: ${toks.filter((c) => c.zone === 'bf').length}/${toks.length}` };
    },
  },
  {
    card: 'Lightning Greaves', title: 'falls off a Karn-animated artifact the moment the animation ends',
    wrong: 'Karn\'s animation ended in the untap step but the Equipment stayed attached to a non-creature until later (rules monitor: Greaves on Darksteel Forge)',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0]; const f = put(g, me, 'Darksteel Forge'); const gr = put(g, me, 'Lightning Greaves');
      g.resolveEffect(me, { k: 'animateArtifact' }, f, 0, true); gr.attached = f.id;
      let at = 'not seen'; const em = g.emit.bind(g); g.emit = (k, t, x) => { if (k === 'turn' && at === 'not seen') at = gr.attached === f.id ? 'still on Forge' : 'unattached'; return em(k, t, x); };
      g.takeTurn(me, false);
      return { ok: at === 'unattached', note: `at the start of the turn: ${at}` };
    },
  },
  {
    card: 'Wake the Past', title: 'the returned artifacts have haste',
    wrong: 'they came back summoning sick',
    run({ table, card }) {
      const g = table(11, OSG); const me = g.players[0]; const w = card(g, me, 'Wurmcoil Engine', 'gy'); const s = card(g, me, 'Wake the Past', 'hand');
      g.castSpell(me, s, 'hand');
      return { ok: w.zone === 'bf' && g.canAttack(w), note: `Wurmcoil ${w.zone}, can attack: ${g.canAttack(w)}` };
    },
  },
  {
    card: 'Wake the Past', title: 'is not cast with no artifacts in the graveyard',
    wrong: 'the AI cast it to return 0 cards',
    run({ table, card }) {
      const g = table(11, OSG); const me = g.players[0]; const s = card(g, me, 'Wake the Past', 'hand');
      return { ok: g.scoreCast(me, s, 'hand') <= 0, note: `score ${g.scoreCast(me, s, 'hand')}` };
    },
  },
  {
    card: "Inventors' Fair", title: 'gains life and can search only with three or more artifacts',
    wrong: 'the condition was ignored: it gained life every upkeep and searched with no artifacts',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0]; const f = put(g, me, "Inventors' Fair");
      const l0 = me.life; for (const u of f.info.upkeep) g.resolveEffects(me, u.fx, f, null, true);
      const noArt = me.life === l0 && !g.prepareAbility(me, f, f.info.activated[0], false);
      for (const n of ['Sol Ring', 'Mana Vault', 'Mox Opal']) put(g, me, n);
      const l1 = me.life; for (const u of f.info.upkeep) g.resolveEffects(me, u.fx, f, null, true);
      const withArt = me.life === l1 + 1 && !!g.prepareAbility(me, f, f.info.activated[0], false);
      return { ok: noArt && withArt, note: `no artifacts ok: ${noArt}, three artifacts ok: ${withArt}` };
    },
  },
  {
    card: "Mishra's Bauble", title: 'the card is drawn at the beginning of the next upkeep, not right away',
    wrong: 'it drew immediately',
    run({ table, put }) {
      const g = table(11, OSG); const [me, opp] = g.players; const b = put(g, me, "Mishra's Bauble");
      const h0 = me.hand.length; g.doActivate(me, g.prepareAbility(me, b, b.info.activated[0], false));
      const now = me.hand.length - h0;
      g.active = 1; g.takeTurn(opp, false);
      return { ok: now === 0 && me.hand.length === h0 + 1, note: `drew ${now} now, ${me.hand.length - h0} by the next upkeep` };
    },
  },
  {
    card: 'Ugin, the Ineffable', title: '+1 exiles the top card and the Spirit brings it to hand when it leaves',
    wrong: '+1 only made a 2/2 Spirit',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0]; const u = put(g, me, 'Ugin, the Ineffable');
      const top = me.library[0]; g.resolveEffects(me, u.info.loyaltyAbs.find((a) => a.delta === 1).fx, u, null, false);
      const sp = me.bf.find((c) => c.token && /Spirit/.test(c.name)); const inEx = top.zone === 'exile';
      if (sp) g.destroy(sp, 'destroyed', true);
      return { ok: inEx && !!sp && top.zone === 'hand', note: `top card exiled: ${inEx}, Spirit: ${!!sp}, card now in ${top.zone}` };
    },
  },
  {
    card: 'Ugin, the Ineffable', title: 'with Mycosynth Lattice every spell is colorless and costs {2} less',
    wrong: 'Lattice did not make cards colorless',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Ugin, the Ineffable'); put(g, me, 'Mycosynth Lattice');
      const s = card(g, me, 'Sun Titan', 'hand'); const cf = g.costFor(me, s, 'hand');
      return { ok: cf.generic === 2, note: `Sun Titan generic ${s.info.cost.generic} -> ${cf.generic}` };
    },
  },
  {
    card: 'Thousand-Year Elixir', title: 'a summoning-sick Goblin Welder can weld',
    wrong: 'tap abilities of new creatures waited a turn',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Thousand-Year Elixir'); const w = put(g, me, 'Goblin Welder'); w.sick = true;
      put(g, me, "Mishra's Bauble"); const wc = card(g, me, 'Wurmcoil Engine', 'gy');
      g.activateAbilities(me, false);
      return { ok: wc.zone === 'bf', note: `Wurmcoil in ${wc.zone}` };
    },
  },
  {
    card: 'Thousand-Year Elixir', title: 'untaps Osgir so it copies a second artifact this turn',
    wrong: 'the Elixir untapped Osgir but the AI never used Osgir again that turn',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Thousand-Year Elixir'); put(g, me, 'Osgir, the Reconstructor');
      card(g, me, 'Hedron Archive', 'gy'); card(g, me, 'Sol Ring', 'gy');
      g.mainPhase(me);
      const toks = me.bf.filter((c) => c.token).map((c) => c.name);
      return { ok: toks.filter((n) => n === 'Hedron Archive').length === 2 && toks.filter((n) => n === 'Sol Ring').length === 2, note: `tokens: ${toks.join(', ')}` };
    },
  },
  {
    card: 'Aetherflux Reservoir', title: 'the third spell in a turn gains 3 life',
    wrong: 'it gained a fixed amount',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Aetherflux Reservoir');
      const l0 = me.life; for (let i = 0; i < 3; i++) g.castSpell(me, card(g, me, "Mishra's Bauble", 'hand'), 'hand');
      return { ok: me.life === l0 + 6, note: `gained ${me.life - l0} (1+2+3 = 6)` };
    },
  },
  {
    card: 'Karn, the Great Creator', title: "with Mycosynth Lattice out, opponents' creatures' abilities can't be activated either",
    wrong: 'only cards printed as artifacts were stopped',
    run({ table, put, card }) {
      const g = table(11, OSG); const [me, opp] = g.players; put(g, me, 'Karn, the Great Creator');
      const w = put(g, opp, 'Goblin Welder'); put(g, opp, "Mishra's Bauble"); card(g, opp, 'Wurmcoil Engine', 'gy');
      const before = !!g.prepareAbility(opp, w, w.info.activated[0], true); put(g, me, 'Mycosynth Lattice');
      const after = !!g.prepareAbility(opp, w, w.info.activated[0], true);
      return { ok: before && !after, note: `Welder usable without Lattice: ${before}, with Lattice: ${after}` };
    },
  },
  {
    card: 'Karn, the Great Creator', title: '+1 animates a spare Hedron Archive, not the Mycosynth Lattice holding the lock',
    wrong: 'it animated the biggest artifact, turning the lock piece into an attacker that could die',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Karn, the Great Creator'); const l = put(g, me, 'Mycosynth Lattice'); const f = put(g, me, 'Hedron Archive');
      g.resolveEffect(me, { k: 'animateArtifact' }, null, 0, true);
      return { ok: f.info.isCreature && !l.info.isCreature, note: `Archive creature: ${f.info.isCreature}, Lattice creature: ${l.info.isCreature}` };
    },
  },
  {
    card: 'Karn, the Great Creator', title: '-2 gets back a Wurmcoil Engine that Osgir exiled',
    wrong: 'the -2 was valued below the +1 so it was never used',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; const k = put(g, me, 'Karn, the Great Creator'); const w = card(g, me, 'Wurmcoil Engine', 'exile');
      g.walkerOnce(me, k);
      return { ok: w.zone === 'hand', note: `Wurmcoil in ${w.zone}` };
    },
  },
  {
    card: 'Mystic Forge', title: 'does not exile a combo piece off the top',
    wrong: 'it exiled any card that was not castable, including Zirda and Sun Titan',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; const f = put(g, me, 'Mystic Forge'); put(g, me, 'Basalt Monolith');
      card(g, me, 'Zirda, the Dawnwaker', 'library'); me.library.unshift(me.library.pop());
      return { ok: !g.prepareAbility(me, f, f.info.activated[0], true), note: 'Forge would exile Zirda' };
    },
  },
  {
    card: 'Goblin Welder', title: 'does not tap to weld when nothing in the graveyard beats what it would sacrifice',
    wrong: 'the ability was offered whenever any artifact was in the graveyard, then did nothing',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; const w = put(g, me, 'Goblin Welder'); put(g, me, 'Wurmcoil Engine'); card(g, me, "Mishra's Bauble", 'gy');
      return { ok: !g.prepareAbility(me, w, w.info.activated[0], true), note: 'Welder would tap for nothing' };
    },
  },
  {
    card: 'Daretti, Scrap Savant', title: '-2 sacrifices a spare artifact rather than an artifact land',
    wrong: 'the cheapest artifact was an artifact land, so Daretti sacrificed a land',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; const d = put(g, me, 'Daretti, Scrap Savant'); const l = put(g, me, 'Great Furnace'); const b = put(g, me, "Mishra's Bauble");
      card(g, me, 'Wurmcoil Engine', 'gy');
      g.resolveEffect(me, { k: 'darettiWeld' }, d, 0, false);
      return { ok: l.zone === 'bf' && b.zone !== 'bf', note: `Great Furnace ${l.zone}, Bauble ${b.zone}` };
    },
  },
  {
    card: 'Unwinding Clock', title: "untaps Basalt Monolith during another player's untap step",
    wrong: "artifacts that don't untap in your own untap step stayed tapped",
    run({ table, put }) {
      const g = table(11, OSG); const [me, opp] = g.players; put(g, me, 'Unwinding Clock'); const b = put(g, me, 'Basalt Monolith'); b.tapped = true;
      g.active = 1; g.takeTurn(opp, false);
      return { ok: !b.tapped, note: `Monolith tapped: ${b.tapped}` };
    },
  },
  {
    card: 'Rugged Prairie', title: 'filters another red or white mana into white',
    wrong: 'it only tapped for {C}',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0]; me.bf = []; put(g, me, 'Rugged Prairie'); put(g, me, 'Mountain');
      return { ok: !!g.pay(me, { generic: 0, pips: [{ opts: ['W'] }], x: 0, mv: 1 }), note: 'could not make W' };
    },
  },
  {
    card: 'Gamble', title: 'searches first, then discards at random (it can be the card it found)',
    wrong: 'the discard was not random',
    run({ table, card }) {
      const g = table(11, OSG); const me = g.players[0]; card(g, me, 'Plains', 'hand'); card(g, me, 'Mountain', 'hand');
      g.R.int = (n) => n - 1; const s = card(g, me, 'Gamble', 'hand'); g.castSpell(me, s, 'hand');
      return { ok: me.hand.length === 2 && me.hand.every((c) => c.info.isLand), note: `hand: ${me.hand.map((c) => c.name).join(', ')}` };
    },
  },
  {
    card: "Jeska's Will", title: 'without a commander on the battlefield only the mana mode happens',
    wrong: 'both modes always happened',
    run({ table, card }) {
      const g = table(11, OSG); const me = g.players[0]; const s = card(g, me, "Jeska's Will", 'hand'); const h0 = me.hand.length;
      g.castSpell(me, s, 'hand');
      return { ok: me.hand.length === h0 - 1, note: `hand ${h0} -> ${me.hand.length}` };
    },
  },
  {
    card: 'Osgir, the Reconstructor', title: 'copies Hedron Archive rather than a legend it already controls (the legend rule would bin both copies)',
    wrong: 'legendary artifacts were valued as two copies, so Osgir copied Ugin\'s Nexus or Alibou and lost them to the legend rule',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Osgir, the Reconstructor'); put(g, me, 'Alibou, Ancient Witness');
      card(g, me, 'Alibou, Ancient Witness', 'gy'); card(g, me, 'Hedron Archive', 'gy');
      g.resolveEffect(me, { k: 'osgir' }, null, 0, false);
      const toks = me.bf.filter((c) => c.token).map((c) => c.name);
      return { ok: toks.length === 2 && toks.every((n) => n === 'Hedron Archive'), note: `tokens: ${toks.join(', ') || 'none'}` };
    },
  },
  {
    card: 'Kuldotha Forgemaster', title: 'does not sacrifice Basalt Monolith or Rings of Brighthearth while they make infinite mana',
    wrong: 'the cheapest artifacts were sacrificed, combo pieces included',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0]; const k = put(g, me, 'Kuldotha Forgemaster');
      for (const n of ['Basalt Monolith', 'Rings of Brighthearth', "Mishra's Bauble", 'Ichor Wellspring', 'Moonsilver Key']) put(g, me, n);
      const prep = g.prepareAbility(me, k, k.info.activated[0], false);
      const f = prep ? prep.fodder.map((x) => x.name) : [];
      return { ok: !!prep && !f.includes('Basalt Monolith') && !f.includes('Rings of Brighthearth'), note: `fodder: ${f.join(', ') || 'none'}` };
    },
  },
  // ---- combo drills: the pieces are in place, the AI has to see the line in its main phase ----
  {
    card: 'Zirda, the Dawnwaker', title: 'drill: Zirda + Basalt Monolith + Staff of Domination + Aetherflux Reservoir on the battlefield wins in the main phase',
    wrong: 'the AI did not go infinite (or did not cash it in)',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0]; for (const n of ['Zirda, the Dawnwaker', 'Basalt Monolith', 'Staff of Domination', 'Aetherflux Reservoir']) put(g, me, n);
      g.mainPhase(me);
      return { ok: g.opps(me).length === 0, note: `opponents left: ${g.opps(me).map((q) => q.life).join('/')}` };
    },
  },
  {
    card: 'Basalt Monolith', title: 'drill: with Zirda, Staff and Aetherflux out, casts Basalt Monolith from hand and wins',
    wrong: 'Basalt Monolith was not seen as the missing combo piece',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; for (const n of ['Zirda, the Dawnwaker', 'Staff of Domination', 'Aetherflux Reservoir']) put(g, me, n); card(g, me, 'Basalt Monolith', 'hand'); card(g, me, 'Sun Titan', 'hand');
      g.mainPhase(me);
      return { ok: g.opps(me).length === 0, note: `opponents left: ${g.opps(me).length}` };
    },
  },
  {
    card: 'Forsaken Monument', title: 'drill: Forsaken Monument + Basalt Monolith (taps for 4, untaps for 3) + Staff + Aetherflux wins',
    wrong: 'Monument was not counted as an infinite-mana enabler for the kill',
    run({ table, put }) {
      const g = table(11, OSG); const me = g.players[0]; for (const n of ['Forsaken Monument', 'Basalt Monolith', 'Staff of Domination', 'Aetherflux Reservoir']) put(g, me, n);
      g.mainPhase(me);
      return { ok: g.opps(me).length === 0, note: `opponents left: ${g.opps(me).length}` };
    },
  },
  {
    card: 'Staff of Domination', title: 'drill: with Zirda + Basalt + Aetherflux out, casts Staff from hand and wins',
    wrong: 'Staff was not seen as the missing piece',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; for (const n of ['Zirda, the Dawnwaker', 'Basalt Monolith', 'Aetherflux Reservoir']) put(g, me, n); card(g, me, 'Staff of Domination', 'hand'); card(g, me, 'Wurmcoil Engine', 'hand');
      g.mainPhase(me);
      return { ok: g.opps(me).length === 0, note: `opponents left: ${g.opps(me).length}` };
    },
  },
  {
    card: 'Kuldotha Forgemaster', title: 'drill: sacrifices three spare artifacts to put Blightsteel Colossus onto the battlefield instead of attacking for 3',
    wrong: 'a search to the battlefield scored like a minor ability and the Forgemaster preferred to attack',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Kuldotha Forgemaster'); for (const n of ["Mishra's Bauble", 'Ichor Wellspring', 'Moonsilver Key']) put(g, me, n);
      g.mainPhase(me);
      const b = me.bf.some((c) => c.name === 'Blightsteel Colossus');
      return { ok: b, note: `Blightsteel on the battlefield: ${b}` };
    },
  },
  {
    card: 'Goblin Welder', title: 'drill: Goblin Engineer puts Wurmcoil Engine in the graveyard and Goblin Welder swaps it in for a Bauble',
    wrong: 'the AI did not line up Engineer and Welder',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Goblin Welder'); put(g, me, "Mishra's Bauble"); card(g, me, 'Goblin Engineer', 'hand');
      g.mainPhase(me);
      const w = me.bf.some((c) => c.name === 'Wurmcoil Engine');
      return { ok: w, note: `Wurmcoil on the battlefield: ${w}` };
    },
  },
  {
    card: 'Mycosynth Lattice', title: 'drill: with Karn out it casts Mycosynth Lattice and locks the table out of mana',
    wrong: 'the lock piece was not prioritised',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Karn, the Great Creator'); card(g, me, 'Mycosynth Lattice', 'hand'); card(g, me, 'Sun Titan', 'hand');
      for (const c of me.bf.filter((x) => x.info.isLand).slice(7)) g.removeFrom(me.bf, c);
      g.mainPhase(me);
      return { ok: g.opps(me).every((q) => g.availableMana(q) === 0), note: `opponents' mana: ${g.opps(me).map((q) => g.availableMana(q)).join('/')}` };
    },
  },
  {
    card: 'Karn, the Great Creator', title: 'drill: with Mycosynth Lattice out it casts Karn and locks the table',
    wrong: 'Karn was not prioritised as the missing lock piece',
    run({ table, put, card }) {
      const g = table(11, OSG); const me = g.players[0]; put(g, me, 'Mycosynth Lattice'); card(g, me, 'Karn, the Great Creator', 'hand'); card(g, me, 'Hellkite Tyrant', 'hand');
      for (const c of me.bf.filter((x) => x.info.isLand).slice(6)) g.removeFrom(me.bf, c);
      g.mainPhase(me);
      return { ok: g.opps(me).every((q) => g.availableMana(q) === 0), note: `opponents' mana: ${g.opps(me).map((q) => g.availableMana(q)).join('/')}` };
    },
  },
];
