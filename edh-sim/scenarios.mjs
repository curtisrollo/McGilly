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
  {
    card: 'Hermit Druid', title: 'the AI uses it with Muldrotha out',
    wrong: 'its ability was never judged worth using, so it never activated',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Muldrotha, the Gravetide'); const h = put(g, me, 'Hermit Druid');
      return { ok: !!g.prepareAbility(me, h, h.info.activated[0], true), note: '' };
    },
  },
  {
    card: 'Sword of Feast and Famine', title: 'gives +2/+2 once and protection from black and green',
    wrong: 'the bonus was applied twice (+4/+4) and the protection never stopped blockers',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const c = put(g, me, 'Craterhoof Behemoth'); const sw = put(g, me, 'Sword of Feast and Famine'); sw.attached = c.id;
      const blocker = put(g, opp, 'Birds of Paradise');
      return { ok: g.power(c) === 7 && !g.canBlock(blocker, c), note: `power ${g.power(c)}, green Birds can block: ${g.canBlock(blocker, c)}` };
    },
  },
  {
    card: 'Sidisi, Brood Tyrant', title: 'any mill of a creature card from your library makes a Zombie, not only its own',
    wrong: 'only Sidisi\'s own mill counted',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Sidisi, Brood Tyrant');
      const cr = me.library.find((c) => c.info.isCreature); g.removeFrom(me.library, cr); me.library.unshift(cr);
      const z0 = me.bf.filter((c) => c.token).length; g.mill(me, 2);
      return { ok: me.bf.filter((c) => c.token).length === z0 + 1, note: `${me.bf.filter((c) => c.token).length - z0} Zombies` };
    },
  },
  {
    card: 'The Gitrog Monster', title: 'milling several lands at once draws one card',
    wrong: 'it drew a card for each land',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'The Gitrog Monster');
      const lands = me.library.filter((c) => c.info.isLand).slice(0, 3); for (const l of lands) { g.removeFrom(me.library, l); me.library.unshift(l); }
      const h0 = me.hand.length; g.mill(me, 3);
      return { ok: me.hand.length === h0 + 1, note: `drew ${me.hand.length - h0}` };
    },
  },
  {
    card: 'Glacial Chasm', title: 'sacrifices a land when it enters',
    wrong: 'it entered for free',
    run({ table, card }) {
      const g = table(); const me = g.players[0]; const n0 = me.bf.filter((c) => c.info.isLand).length; const gc = card(g, me, 'Glacial Chasm', 'hand');
      g.removeFrom(me.hand, gc); g.enterBattlefield(gc, me, {});
      return { ok: me.bf.filter((c) => c.info.isLand).length === n0, note: `lands ${n0} -> ${me.bf.filter((c) => c.info.isLand).length}` };
    },
  },
  {
    card: 'Force of Negation', title: 'the spell it counters is exiled, and it costs no life',
    wrong: 'the spell went to the graveyard and Force of Negation cost 1 life like Force of Will',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; card(g, opp, 'Force of Negation', 'hand'); card(g, opp, 'Cyclonic Rift', 'hand');
      const wipe = card(g, me, 'Damnation', 'hand'); for (const q of g.players.slice(1)) put(g, q, 'Craterhoof Behemoth');
      const l0 = opp.life; g.R = Object.assign(() => 0, g.R); g.castSpell(me, wipe, 'hand');
      return { ok: wipe.zone === 'exile' && opp.life === l0, note: `Damnation ${wipe.zone}, life ${l0} -> ${opp.life}` };
    },
  },
  {
    card: 'Jace, Wielder of Mysteries', title: '+1 mills first, then draws (so it can win off an empty library)',
    wrong: 'it drew first and then milled',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const j = put(g, me, 'Jace, Wielder of Mysteries'); me.library = me.library.slice(0, 2);
      g.resolveEffects(me, j.info.loyaltyAbs[0].fx, j, null, true);
      return { ok: g.players.slice(1).every((q) => q.lost), note: g.players.slice(1).map((q) => q.lost).join('/') };
    },
  },
  {
    card: "Liliana, Death's Majesty", title: '-3 returns the creature as a Zombie in addition to its types',
    wrong: 'it stayed a non-Zombie and died to her own -7',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; const l = put(g, me, "Liliana, Death's Majesty"); me.gy = []; const c = card(g, me, 'Craterhoof Behemoth', 'gy');
      g.resolveEffects(me, l.info.loyaltyAbs.find((x) => x.delta === -3).fx, l, null, true);
      return { ok: c.zone === 'bf' && g.isType(c, 'Zombie'), note: `${c.zone}, zombie ${g.isType(c, 'Zombie')}` };
    },
  },
  {
    card: 'Basalt Monolith', title: 'with Forsaken Monument (or Zirda) it makes infinite colorless mana',
    wrong: 'only the Rings of Brighthearth pairing was known',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Basalt Monolith'); put(g, me, 'Forsaken Monument');
      return { ok: g.infiniteMana(me), note: '' };
    },
  },
  {
    card: 'Karn, the Great Creator', title: "opponents' artifacts can't activate abilities, mana included",
    wrong: 'it only mattered alongside Mycosynth Lattice',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Karn, the Great Creator'); const sr = put(g, opp, 'Sol Ring');
      return { ok: !g.sources(opp).some((x) => x.c === sr), note: '' };
    },
  },
  {
    card: 'Ichor Wellspring', title: 'draws a card when it goes to the graveyard from the battlefield',
    wrong: 'only the enters draw existed',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const iw = put(g, me, 'Ichor Wellspring'); const h0 = me.hand.length;
      g.destroy(iw, 'sacrificed', true);
      return { ok: me.hand.length === h0 + 1, note: `drew ${me.hand.length - h0}` };
    },
  },
  {
    card: "Ugin's Nexus", title: 'goes to exile instead of the graveyard and gives an extra turn',
    wrong: 'it just went to the graveyard',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const n = put(g, me, "Ugin's Nexus");
      g.destroy(n, 'destroyed', true);
      return { ok: n.zone === 'exile' && me.extraTurn >= 1, note: `${n.zone}, extra turns ${me.extraTurn || 0}` };
    },
  },
  {
    card: 'Gamble', title: 'searches first, then discards at random (the found card can be lost)',
    wrong: 'it discarded before searching, so the tutored card was always safe',
    run({ table, put }) {
      const g = table(); const c = put(g, g.players[0], 'Gamble');
      return { ok: c.info.spell[0].k === 'tutor' && c.info.spell[1].k === 'discardSelf', note: c.info.spell.map((f) => f.k).join(',') };
    },
  },
  {
    card: 'Mystic Forge', title: 'its {T}, pay 1 life ability only exiles the top card',
    wrong: 'the exiled card went to hand to be played',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const mf = put(g, me, 'Mystic Forge'); const top = me.library[0]; const h0 = me.hand.length;
      g.resolveEffects(me, mf.info.activated[0].fx, mf, null, true);
      return { ok: top.zone === 'exile' && me.hand.length === h0, note: top.zone };
    },
  },
  {
    card: "Jeska's Will", title: 'the exile-and-play mode needs you to control your commander',
    wrong: 'both modes always happened',
    run({ table, card }) {
      const g = table(); const me = g.players[0]; const jw = card(g, me, "Jeska's Will", 'hand'); const ex0 = me.hand.length;
      g.castSpell(me, jw, 'hand');
      return { ok: me.hand.length === ex0 - 1, note: `hand ${ex0} -> ${me.hand.length}` };
    },
  },
  {
    card: 'Moonsilver Key', title: 'finds only an artifact with a mana ability (or a basic land)',
    wrong: 'it could fetch any artifact, Blightsteel included',
    run({ table }) {
      const g = table(); const me = g.players[0]; const pick = g.chooseTutor(me, 'manaArtifact');
      return { ok: !pick || !!pick.info.mana, note: pick ? pick.name : 'none' };
    },
  },
  {
    card: 'Aetherflux Reservoir', title: 'gains 1 life for each spell cast before it this turn',
    wrong: 'it always gained 1',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const af = put(g, me, 'Aetherflux Reservoir'); me.spellsThisTurn = 4; const l0 = me.life;
      g.resolveEffects(me, af.info.castTrig[0].fx, af, null, true);
      return { ok: me.life === l0 + 4, note: `gained ${me.life - l0}` };
    },
  },
  {
    card: 'Alibou, Ancient Witness', title: 'gives OTHER artifact creatures haste, not itself',
    wrong: 'it gave itself haste too',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const a = put(g, me, 'Alibou, Ancient Witness'); const w = put(g, me, 'Wurmcoil Engine');
      return { ok: !g.hasKw(a, 'haste') && g.hasKw(w, 'haste'), note: `Alibou ${g.hasKw(a, 'haste')}, Wurmcoil ${g.hasKw(w, 'haste')}` };
    },
  },
  {
    card: 'Whip of Erebos', title: 'the returned creature has haste and is exiled at the end step (exiled if it would leave)',
    wrong: 'the creature stayed forever and later died to the graveyard',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; const w = put(g, me, 'Whip of Erebos'); me.gy = []; const c = card(g, me, 'Craterhoof Behemoth', 'gy');
      g.resolveEffects(me, w.info.activated[0].fx, w, null, true); const haste = g.hasKw(c, 'haste');
      g.destroy(c, 'destroyed', true);
      return { ok: haste && c.zone === 'exile', note: `haste ${haste}, then ${c.zone}` };
    },
  },
  {
    card: "Agadeem's Awakening // Agadeem, the Undercrypt", title: 'returns creatures with different mana values, each X or less',
    wrong: 'it returned one creature of any mana value',
    run({ table, card }) {
      const g = table(); const me = g.players[0]; me.gy = []; for (const n of ['Birds of Paradise', 'Eternal Witness', 'Craterhoof Behemoth']) card(g, me, n, 'gy');
      g.resolveEffect(me, { k: 'agadeem' }, null, 3, true);
      const back = me.bf.filter((c) => ['Birds of Paradise', 'Eternal Witness', 'Craterhoof Behemoth'].includes(c.name)).map((c) => c.name);
      return { ok: back.length === 2 && !back.includes('Craterhoof Behemoth'), note: back.join(', ') };
    },
  },
  {
    card: 'Toski, Bearer of Secrets', title: 'draws when any creature you control deals combat damage to a player',
    wrong: 'only Toski itself drew',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Toski, Bearer of Secrets'); const c = put(g, me, 'Craterhoof Behemoth'); const h0 = me.hand.length;
      g.hitPlayer(me, opp, c, 5, [], () => {});
      return { ok: me.hand.length === h0 + 1, note: `drew ${me.hand.length - h0}` };
    },
  },
  {
    card: 'Ayara, First of Locthwain', title: 'her draw ability sacrifices only a black creature',
    wrong: 'any creature could be sacrificed',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const a = put(g, me, 'Ayara, First of Locthwain'); put(g, me, 'Birds of Paradise');
      const prep = g.prepareAbility(me, a, a.info.activated[0], true);
      return { ok: !prep || prep.fodder.every((x) => x.info.colors.has('B')), note: prep ? prep.fodder.map((x) => x.name).join(',') : 'not activated (no black fodder)' };
    },
  },
  {
    card: "Green Sun's Zenith", title: 'finds a green creature with mana value X or less and shuffles itself back',
    wrong: 'X=0 still found a 3-drop, any colour, and it went to the graveyard',
    run({ table, card }) {
      const g = table(); const me = g.players[0]; const gz = card(g, me, "Green Sun's Zenith", 'hand'); const lib0 = me.library.length;
      g.resolveEffect(me, { k: 'tutorBF' }, gz, 0, true);
      const got = me.bf.filter((c) => c.info.isCreature && !c.token && c.info.mv > 0);
      g.toGraveyard(gz);
      return { ok: got.length === 0 && gz.zone === 'library', note: `${got.map((c) => c.name).join(',') || 'nothing'} fetched; GSZ in ${gz.zone}` };
    },
  },
  {
    card: 'Temple of the False God', title: 'taps for mana only with five or more lands',
    wrong: 'it always tapped for {C}{C}',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; me.bf = []; const t = put(g, me, 'Temple of the False God');
      return { ok: !g.sources(me).some((x) => x.c === t), note: '' };
    },
  },
  {
    card: 'Return of the Wildspeaker', title: '+3/+3 goes to non-Human creatures only',
    wrong: 'Humans got it too',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const h = put(g, me, 'Hermit Druid'); const e = put(g, me, 'Craterhoof Behemoth'); const p0 = g.power(h), e0 = g.power(e);
      g.resolveEffect(me, { k: 'overrun', p: 3, t: 3, kw: [], notSub: 'Human' }, null, 0, true);
      return { ok: g.power(h) === p0 && g.power(e) === e0 + 3, note: `Human +${g.power(h) - p0}, non-Human +${g.power(e) - e0}` };
    },
  },
  {
    card: 'Grim Backwoods', title: 'as a sacrifice outlet it costs {2}{B}{G}, not three generic',
    wrong: 'the cost was read as a count of symbols',
    run({ table, put }) {
      const g = table(); const gb = put(g, g.players[0], 'Grim Backwoods');
      const c = gb.info.sacOutlet && gb.info.sacOutlet.cost;
      return { ok: !!c && c.mv === 4 && c.pips.length === 2, note: JSON.stringify(c) };
    },
  },
  {
    card: 'Esper Sentinel', title: "triggers only on an opponent's first noncreature spell each turn",
    wrong: 'it triggered on every noncreature spell and always asked for {1}',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; put(g, opp, 'Esper Sentinel'); g.R = Object.assign(() => 0.99, g.R);
      const h0 = opp.hand.length;
      for (const n of ['Sol Ring', 'Arcane Signet']) { const c = card(g, me, n, 'hand'); g.castSpell(me, c, 'hand'); }
      return { ok: opp.hand.length === h0 + 1, note: `opponent drew ${opp.hand.length - h0}` };
    },
  },
  {
    card: 'Flawless Maneuver', title: 'saves creatures only, and against an exile wipe it does nothing',
    wrong: 'it made every permanent indestructible and hexproof, and a protected player was skipped by any wipe (even exile)',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; put(g, opp, 'Edgar Markov').isCommander = true; for (let i = 0; i < 3; i++) put(g, opp, 'Craterhoof Behemoth');
      card(g, opp, 'Flawless Maneuver', 'hand'); const tithe = put(g, opp, 'Smothering Tithe');
      g.doWipe(me, { k: 'wipe', what: 'farewell', exile: true }, null, 0);
      return { ok: !opp.bf.some((c) => c.name === 'Craterhoof Behemoth'), note: `${opp.bf.filter((c) => c.name === 'Craterhoof Behemoth').length} Craterhoofs survived an exile wipe` };
    },
  },
  {
    card: 'Silence', title: "stops spells but not activated abilities (Mother of Runes still works)",
    wrong: 'Silence also switched off abilities',
    run({ table }) {
      const g = table(); const [me, opp] = g.players; opp.silencedTurn = g.turn;
      return { ok: g.abolished(opp, 'spell') && !g.abolished(opp, 'ability'), note: '' };
    },
  },
  {
    card: 'Minas Tirith', title: 'draws only if you attacked with two or more creatures this turn',
    wrong: 'it drew whenever it had mana',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const m = put(g, me, 'Minas Tirith');
      const before = !!g.prepareAbility(me, m, m.info.activated[0], true);
      me.attackersTurn = g.turn; me.attackersCount = 2;
      const after = !!g.prepareAbility(me, m, m.info.activated[0], true);
      return { ok: !before && after, note: `without attacking ${before}, after attacking with 2 ${after}` };
    },
  },
  {
    card: 'Vindicate', title: 'can destroy a land (any permanent)',
    wrong: 'it could only hit nonland permanents',
    run({ table, put }) {
      const g = table(); const v = put(g, g.players[0], 'Vindicate');
      return { ok: v.info.spell[0].what === 'permanent', note: v.info.spell[0].what };
    },
  },
  {
    card: 'Necropotence', title: 'cards you discard are exiled',
    wrong: 'discards went to the graveyard',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Necropotence'); const c = card(g, me, 'Sol Ring', 'hand');
      g.discardCard(me, c);
      return { ok: c.zone === 'exile', note: c.zone };
    },
  },
  {
    card: 'Fiery Emancipation', title: 'lifelink gains the tripled damage, even when Palisade Giant takes it instead of the player',
    wrong: 'lifelink counted unmultiplied damage, and damage redirected to Palisade Giant gained nothing',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Fiery Emancipation'); const v = put(g, me, 'Vampire Nighthawk');
      for (const q of g.players.slice(1)) put(g, q, 'Palisade Giant');
      const l0 = me.life; g._forceAttack = true; g.combat(me); g._forceAttack = false;
      return { ok: me.life - l0 >= 6, note: `gained ${me.life - l0}` };
    },
  },
  {
    card: 'Carth the Lion', title: 'digs for a planeswalker whenever one of yours is destroyed (not only at 0 loyalty)',
    wrong: 'it only triggered when loyalty ran out',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Carth the Lion'); const j = put(g, me, 'Jace, the Mind Sculptor');
      const pw = me.library.find((c) => c.info.isPW); if (pw) { g.removeFrom(me.library, pw); me.library.unshift(pw); }
      const h0 = me.hand.length; g.destroy(j, 'destroyed', true);
      return { ok: !pw || me.hand.includes(pw), note: `hand ${h0} -> ${me.hand.length}` };
    },
  },
  {
    card: 'Vraska the Unseen', title: "-7's Assassins make the player they hit lose the game",
    wrong: 'they were plain 1/1s',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const v = put(g, me, 'Vraska the Unseen');
      g.resolveEffects(me, v.info.loyaltyAbs.find((x) => x.delta <= -7).fx, v, null, true);
      const a = me.bf.find((c) => c.token && /Assassin/.test(c.info.name)); for (const c of me.bf) if (c.token) c.sick = false;
      g.hitPlayer(me, opp, a, 1, [], () => {});
      return { ok: opp.lost, note: opp.lost ? '' : 'still in' };
    },
  },
  {
    card: 'The Wandering Emperor', title: '-2 exiles only a tapped creature',
    wrong: 'it exiled any creature',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const e = put(g, me, 'The Wandering Emperor'); const hoof = put(g, opp, 'Craterhoof Behemoth');
      g.resolveEffects(me, e.info.loyaltyAbs.find((x) => x.delta === -2).fx, e, null, true);
      return { ok: hoof.zone === 'bf', note: `untapped Craterhoof: ${hoof.zone}` };
    },
  },
  {
    card: "Urza's Saga", title: "chapter III can't fetch an X-cost artifact (it would enter with X=0)",
    wrong: 'Walking Ballista or Astral Cornucopia could be fetched as a dead card',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; me.library = me.library.filter((c) => !(c.info.types.has('Artifact') && c.info.mv <= 1 && !c.info.cost.x));
      const s0 = me.bf.length; g.resolveEffect(me, { k: 'search', n: 1, what: 'artifact', mvMax: 1, dest: 'bf', noX: true }, null, 0, true);
      return { ok: !me.bf.slice(s0).some((c) => c.info.cost.x), note: me.bf.slice(s0).map((c) => c.name).join(',') || 'nothing' };
    },
  },
  {
    card: 'Baxter Building', title: 'its draw needs a creature with toughness 4 or greater',
    wrong: 'it drew freely',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const b = put(g, me, 'Baxter Building');
      return { ok: !g.prepareAbility(me, b, b.info.activated[0], true), note: '' };
    },
  },
  {
    card: 'Takenuma, Abandoned Mire', title: 'channel mills three and returns a creature or planeswalker to hand',
    wrong: 'it only milled',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; const t = put(g, me, 'Takenuma, Abandoned Mire'); me.gy = []; card(g, me, 'Craterhoof Behemoth', 'gy');
      g.resolveEffects(me, t.info.channel.fx, t, null, true);
      return { ok: me.hand.some((c) => c.name === 'Craterhoof Behemoth'), note: '' };
    },
  },
  {
    card: "Kaya's Ghostform", title: "isn't cast with nothing worth enchanting",
    wrong: 'it was cast onto nothing and went straight to the graveyard',
    run({ table, card }) {
      const g = table(); const me = g.players[0]; const k = card(g, me, "Kaya's Ghostform", 'hand');
      return { ok: g.scoreCast(me, k, 'hand') < 0, note: '' };
    },
  },
  {
    card: 'Marauding Blight-Priest', title: 'two lifelinkers in one combat trigger it twice',
    wrong: 'all lifelink in a combat step was one life gain, so it triggered once',
    run({ table, put }) {
      const g = table(); const [me] = g.players; put(g, me, 'Marauding Blight-Priest'); put(g, me, 'Vampire Nighthawk'); put(g, me, 'Vampire Nighthawk');
      const opps0 = g.players.slice(1).map((q) => q.life);
      g.chooseDefender = () => g.players[1]; g._forceAttack = true; g.combat(me); g._forceAttack = false;
      const lost = g.players.slice(1).map((q, i) => opps0[i] - q.life);
      return { ok: lost[1] >= 2 && lost[2] >= 2, note: `opponents not attacked lost ${lost.slice(1).join(', ')}` };
    },
  },
  {
    card: 'Ugin, the Ineffable', title: '-3 destroys only a permanent that has a colour',
    wrong: 'it could destroy colorless artifacts',
    run({ table, put }) {
      const g = table(); const u = put(g, g.players[0], 'Ugin, the Ineffable');
      return { ok: u.info.loyaltyAbs.find((x) => x.delta === -3).fx[0].what === 'colored', note: '' };
    },
  },
  {
    card: 'Archivist of Oghma', title: 'an opponent cracking a fetchland counts as searching',
    wrong: 'fetchlands never triggered it',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Archivist of Oghma'); const h0 = me.hand.length;
      const f = card(g, opp, 'Marsh Flats', 'hand'); g.removeFrom(opp.hand, f); g.enterBattlefield(f, opp, {});
      return { ok: me.hand.length === h0 + 1, note: `drew ${me.hand.length - h0}` };
    },
  },
  {
    card: 'combat', title: 'going for a kill sends only what it takes and keeps blockers home against the other opponents',
    wrong: 'everything attacked the player it could kill, leaving no blockers for the next opponent',
    run({ table, put }) {
      const g = table(); const [me, a, b, c] = g.players; a.life = 6; me.life = 12;
      for (let i = 0; i < 4; i++) put(g, me, 'Craterhoof Behemoth');
      put(g, b, 'Craterhoof Behemoth'); put(g, b, 'Craterhoof Behemoth'); put(g, c, 'Craterhoof Behemoth');
      g.chooseDefender = () => a; g.combat(me);
      const home = me.bf.filter((x) => x.name === 'Craterhoof Behemoth' && !x.tapped).length;
      return { ok: a.lost && home >= 2, note: `killed: ${a.lost}, kept home: ${home}` };
    },
  },
  {
    card: 'Osgir, the Reconstructor', title: 'copies two Hedron Archives (+4 mana) rather than leaving them in the graveyard',
    wrong: 'the copies were valued below an ordinary spell, so the ability often went unused',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Osgir, the Reconstructor'); card(g, me, 'Hedron Archive', 'gy'); card(g, me, 'Birds of Paradise', 'hand');
      for (const c of me.bf.filter((x) => x.info.isLand).slice(5)) g.removeFrom(me.bf, c);
      g.mainPhase(me);
      const copies = me.bf.filter((c) => c.token && c.name === 'Hedron Archive').length;
      return { ok: copies === 2 && me.bf.some((c) => c.name === 'Birds of Paradise'), note: `${copies} copies, Birds cast: ${me.bf.some((c) => c.name === 'Birds of Paradise')}` };
    },
  },
];
