// Scenarios for the atraxa deck. Same shape as ../scenarios.mjs.
const pw = (c, d) => c.info.loyaltyAbs.find((x) => x.delta === d);
export default [
  // ---------- rules ----------
  {
    card: 'Vorinclex, Monstrous Raider', title: 'doubles the poison counters you give a player when you proliferate',
    wrong: 'proliferate always added one poison counter, Vorinclex or not',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const v = put(g, me, 'Vorinclex, Monstrous Raider'); opp.poison = 2;
      g.resolveEffect(me, { k: 'proliferate' }, v, 0, true);
      return { ok: opp.poison === 4, note: `poison 2 -> ${opp.poison}` };
    },
  },
  {
    card: 'Walking Ballista', title: '{4}: the counter it puts on itself goes through Pir (one more)',
    wrong: 'the {4} ability used only the doubling multiplier, so Pir added nothing',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Pir, Imaginative Rascal'); const b = put(g, me, 'Walking Ballista', { p1: 1 });
      for (const q of g.players.slice(1)) q.bf = q.bf.filter((c) => c.info.isLand);
      g.pingers(me, true); // 14 lands: three activations of {4}
      return { ok: b.p1 === 7, note: `Ballista 1 -> ${b.p1} counters` };
    },
  },
  {
    card: 'Teferi, Hero of Dominaria', title: '+1 untaps two lands at the beginning of the end step, not right away',
    wrong: 'the lands untapped at once, so the main phase got two extra mana',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const t = put(g, me, 'Teferi, Hero of Dominaria');
      for (const c of me.bf) if (c.info.isLand) c.tapped = true;
      g.resolveEffects(me, pw(t, 1).fx, t, null, true);
      const now = me.bf.filter((c) => c.info.isLand && !c.tapped).length;
      g.endStepDelayed(me);
      const after = me.bf.filter((c) => c.info.isLand && !c.tapped).length;
      return { ok: now === 0 && after === 2, note: `untapped: ${now} after the +1, ${after} at end step` };
    },
  },
  {
    card: 'Tamiyo, the Moon Sage', title: 'emblem: a card put into your graveyard from anywhere comes back to your hand',
    wrong: 'the emblem only removed the maximum hand size',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; me.emblems = ['tamiyo']; put(g, opp, 'Craterhoof Behemoth');
      const rift = card(g, me, 'Cyclonic Rift', 'hand'); g.castSpell(me, rift, 'hand');
      const w = put(g, me, 'Eternal Witness'); g.destroy(w, 'destroyed', true);
      return { ok: rift.zone === 'hand' && w.zone === 'hand', note: `Rift in ${rift.zone}, Witness in ${w.zone}` };
    },
  },
  {
    card: 'Teferi, Master of Time', title: "activates a loyalty ability on an opponent's turn too",
    wrong: 'it was only used on its controller\'s turn',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const t = put(g, me, 'Teferi, Master of Time'); const l0 = t.loyalty;
      g.active = 1; g.takeTurn(opp, false);
      return { ok: t.loyalty > l0, note: `loyalty ${l0} -> ${t.loyalty} over ${opp.name}'s turn` };
    },
  },
  {
    card: 'The Wandering Emperor', title: "flashed in on an opponent's turn to exile a tapped attacker",
    wrong: 'she was only ever cast at sorcery speed, so her -2 never met an attacker',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; const e = card(g, me, 'The Wandering Emperor', 'hand');
      for (const q of g.players) q.bf = q.bf.filter((c) => c.info.isLand);
      const hoof = put(g, opp, 'Craterhoof Behemoth');
      g.active = 1; g.phase = 'combat'; g.chooseDefender = () => me; g._forceAttack = true; g.combat(opp); g._forceAttack = false;
      return { ok: e.zone === 'bf' && hoof.zone === 'exile', note: `Emperor: ${e.zone}, Craterhoof: ${hoof.zone}, life ${me.life}` };
    },
  },
  {
    card: 'Oath of Teferi', title: 'exiles a used planeswalker and returns it at the end step with fresh loyalty',
    wrong: 'it only flickered permanents with enter triggers, and at once',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; const j = put(g, me, 'Jace, the Mind Sculptor'); j.loyalty = 1; j.usedTurn = g.turn;
      const o = card(g, me, 'Oath of Teferi', 'hand'); g.castSpell(me, o, 'hand');
      const mid = j.zone; g.endStepDelayed(me);
      return { ok: mid === 'exile' && j.zone === 'bf' && j.loyalty === 3, note: `Jace ${mid} then ${j.zone} at ${j.loyalty}` };
    },
  },
  {
    card: 'Jace, the Mind Sculptor', title: 'a creature blocks to protect a planeswalker being attacked',
    wrong: 'attackers sent at planeswalkers could never be blocked',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; for (const q of g.players) q.bf = q.bf.filter((c) => c.info.isLand);
      const j = put(g, me, 'Jace, the Mind Sculptor'); j.loyalty = 3; put(g, me, 'Carth the Lion'); const w = put(g, opp, 'Eternal Witness');
      g.active = 1; g.chooseDefender = () => me; g._forceAttack = true; g.combat(opp); g._forceAttack = false;
      return { ok: j.zone === 'bf' && j.loyalty === 3 && w.zone !== 'bf', note: `Jace ${j.zone} at ${j.loyalty}, Witness ${w.zone}` };
    },
  },
  // ---------- engine drills: the AI uses the deck's engines ----------
  {
    card: 'Doubling Season', title: 'drill: Elspeth cast with Doubling Season out ultimates the same turn',
    wrong: '(drill; already passed) the AI could ramp Elspeth with +1 instead of taking the emblem it can afford',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Doubling Season'); card(g, me, "Elspeth, Sun's Champion", 'hand');
      g.mainPhase(me);
      return { ok: (me.emblems || []).includes('elspeth'), note: `emblems: ${(me.emblems || []).join(',') || 'none'}` };
    },
  },
  {
    card: 'Doubling Season', title: 'drill: Teferi, Hero of Dominaria with Doubling Season takes the emblem at once',
    wrong: '(drill; already passed) the AI could sit on the -8 it can afford on entry',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Doubling Season'); card(g, me, 'Teferi, Hero of Dominaria', 'hand');
      g.mainPhase(me);
      return { ok: (me.emblems || []).includes('teferi'), note: `emblems: ${(me.emblems || []).join(',') || 'none'}` };
    },
  },
  {
    card: 'Walking Ballista', title: 'drill: with Doubling Season, a big Ballista pings a low-life opponent out',
    wrong: '(drill; already passed) Ballista could be cast small or never fire its counters',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Doubling Season'); card(g, me, 'Walking Ballista', 'hand'); opp.life = 10;
      g.mainPhase(me);
      return { ok: opp.lost, note: `${opp.name} at ${opp.life}` };
    },
  },
  {
    card: 'Oath of Teferi', title: 'drill: with Oath of Teferi a planeswalker activates twice in a turn',
    wrong: '(drill; already passed) walkers used only one activation with Oath out',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Oath of Teferi'); const e = put(g, me, "Elspeth, Sun's Champion");
      g.mainPhase(me);
      return { ok: e.usedCount === 2, note: `activations: ${e.usedCount || 0}, loyalty ${e.loyalty}` };
    },
  },
  {
    card: "Atraxa, Praetors' Voice", title: 'drill: end-step proliferate carries a planeswalker to its ultimate next turn',
    wrong: '(drill; already passed) proliferate skipped planeswalkers or the AI sat on the ultimate',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, "Atraxa, Praetors' Voice"); const e = put(g, me, "Elspeth, Sun's Champion"); e.loyalty = 5;
      for (const q of g.players.slice(1)) q.bf = q.bf.filter((c) => c.info.isLand);
      g.takeTurn(me, false); const mid = e.loyalty; g.takeTurn(me, false);
      return { ok: mid === 7 && (me.emblems || []).includes('elspeth'), note: `loyalty after turn 1: ${mid}; emblems: ${(me.emblems || []).join(',') || 'none'}` };
    },
  },
  {
    card: 'Ugin, the Spirit Dragon', title: 'drill: -X sweeps when the opponents have the coloured board',
    wrong: '(drill; already passed) Ugin pinged with +2 while the table built a board',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const u = put(g, me, 'Ugin, the Spirit Dragon');
      for (const q of g.players.slice(1)) for (const n of ['Eternal Witness', 'Vampire Nighthawk', 'Birds of Paradise', 'Exploration']) put(g, q, n);
      g.mainPhase(me);
      const left = g.players.slice(1).reduce((s, q) => s + q.bf.filter((c) => !c.info.isLand).length, 0);
      return { ok: left === 0 && u.zone === 'bf', note: `${left} opposing nonland permanents left, Ugin at ${u.loyalty}` };
    },
  },
  {
    card: "Elspeth, Sun's Champion", title: 'drill: -3 clears big attackers when only the opponents have them',
    wrong: 'the -3 was scored as a whole creature wipe counting all our creatures, so Elspeth kept making Soldiers into three Craterhoofs',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const e = put(g, me, "Elspeth, Sun's Champion");
      for (const q of g.players.slice(1)) put(g, q, 'Craterhoof Behemoth');
      g.mainPhase(me);
      const left = g.players.slice(1).filter((q) => q.bf.some((c) => c.name === 'Craterhoof Behemoth')).length;
      return { ok: left === 0, note: `${left} Craterhoofs left, Elspeth at ${e.loyalty}` };
    },
  },
  {
    card: 'Tamiyo, the Moon Sage', title: 'drill: -2 draws a card for each tapped creature when an opponent is tapped out',
    wrong: 'the AI scored the -2 as worth nothing and always used the +1',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const t = put(g, me, 'Tamiyo, the Moon Sage');
      for (const n of ['Craterhoof Behemoth', 'Eternal Witness', 'Vampire Nighthawk', 'Birds of Paradise']) put(g, opp, n).tapped = true;
      const h0 = me.hand.length; g.walkerOnce(me, t);
      return { ok: me.hand.length - h0 >= 4, note: `drew ${me.hand.length - h0}, Tamiyo at ${t.loyalty}` };
    },
  },
  {
    card: 'Ajani Steadfast', title: 'drill: -2 when it feeds a board of creatures and other planeswalkers',
    wrong: 'the AI scored the -2 like a single counter and always used the +1',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const a = put(g, me, 'Ajani Steadfast');
      const others = [put(g, me, 'Jace, the Mind Sculptor'), put(g, me, 'Teferi, Hero of Dominaria')];
      for (const n of ['Eternal Witness', 'Vampire Nighthawk', 'Birds of Paradise']) put(g, me, n);
      const l0 = others.map((c) => c.loyalty); g.walkerOnce(me, a);
      return { ok: others.every((c, i) => c.loyalty === l0[i] + 1), note: `Ajani at ${a.loyalty}; others ${l0.join('/')} -> ${others.map((c) => c.loyalty).join('/')}` };
    },
  },
  {
    card: 'The Chain Veil', title: 'gives each planeswalker exactly one more activation',
    wrong: 'walkers could keep activating after the Veil',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'The Chain Veil'); const e = put(g, me, "Elspeth, Sun's Champion"); const j = put(g, me, 'Jace, the Mind Sculptor');
      for (const q of g.players.slice(1)) q.bf = q.bf.filter((c) => c.info.isLand);
      g.useWalkers(me, false); g.lateGameMana(me); g.lateGameMana(me);
      return { ok: e.loyalty === 6 && j.loyalty <= 7, note: `Elspeth ${e.loyalty}, Jace ${j.loyalty}` };
    },
  },
  {
    card: 'Brokers Ascendancy', title: 'end step: a +1/+1 counter on each creature and a loyalty counter on each planeswalker',
    wrong: 'planeswalkers got nothing',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const b = put(g, me, 'Brokers Ascendancy'); const j = put(g, me, 'Jace, the Mind Sculptor'); const w = put(g, me, 'Eternal Witness');
      g.resolveEffects(me, b.info.endstep[0].fx, b, null, true);
      return { ok: j.loyalty === 4 && w.p1 === 1, note: `Jace ${j.loyalty}, Witness +${w.p1}` };
    },
  },
  {
    card: 'Spark Double', title: 'a copy of a planeswalker gets its extra loyalty counter through Doubling Season',
    wrong: 'the extra loyalty skipped the counter replacement effects',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Doubling Season'); const j = put(g, me, 'Jace, the Mind Sculptor'); j.loyalty = 1;
      const sd = card(g, me, 'Spark Double', 'hand'); g.castSpell(me, sd, 'hand');
      return { ok: sd.info.isPW && sd.loyalty === 8, note: `${sd.info.name} at ${sd.loyalty}` };
    },
  },
  {
    card: 'Arena Rector', title: 'is exiled when it fetches a planeswalker ("you may exile it. If you do")',
    wrong: 'it fetched the planeswalker and stayed in the graveyard',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const r = put(g, me, 'Arena Rector'); g.destroy(r, 'destroyed', true);
      const w = me.bf.find((c) => c.info.isPW);
      return { ok: r.zone === 'exile' && !!w, note: `Rector in ${r.zone}, fetched ${w ? w.info.name : 'nothing'}` };
    },
  },
  {
    card: 'Tamiyo, Field Researcher', title: '+1: a chosen creature dealing combat damage draws a card',
    wrong: 'the +1 did nothing',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const t = put(g, me, 'Tamiyo, Field Researcher'); const a = put(g, me, 'Vampire Nighthawk');
      g.resolveEffects(me, t.info.loyaltyAbs[0].fx, t, null, true);
      const h0 = me.hand.length; g.hitPlayer(me, opp, a, 2, [], () => {});
      return { ok: me.hand.length === h0 + 1, note: `hand ${h0} -> ${me.hand.length}` };
    },
  },
  {
    card: 'Vraska the Unseen', title: "-3 doesn't aim its destroy at an indestructible permanent",
    wrong: 'it picked an indestructible Blightsteel Colossus and wasted the -3',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const v = put(g, me, 'Vraska the Unseen');
      for (const q of g.players.slice(1)) q.bf = q.bf.filter((c) => c.info.isLand);
      put(g, opp, 'Blightsteel Colossus'); const w = put(g, opp, 'Vampire Nighthawk');
      g.resolveEffects(me, pw(v, -3).fx, v, null, true);
      return { ok: w.zone !== 'bf', note: `Nighthawk ${w.zone}` };
    },
  },
  {
    card: 'Tamiyo, the Moon Sage', title: "doesn't take a second copy of an emblem that does nothing twice",
    wrong: 'with Doubling Season and her own emblem returning her, she was recast and ultimated again every turn for nothing',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; me.emblems = ['tamiyo']; const t = put(g, me, 'Tamiyo, the Moon Sage'); t.loyalty = 8;
      g.walkerOnce(me, t);
      return { ok: me.emblems.length === 1, note: `emblems: ${me.emblems.join(',')}; Tamiyo at ${t.loyalty}` };
    },
  },
  {
    card: 'Crystalline Crawler', title: 'converge counts the most colours the lands that paid for it could make',
    wrong: 'paying {4} with five-colour lands always took one colour, so it entered with one counter',
    run({ table, card }) {
      const g = table(); const me = g.players[0]; const c = card(g, me, 'Crystalline Crawler', 'hand'); g.castSpell(me, c, 'hand');
      return { ok: c.zone === 'bf' && c.p1 === 4, note: `${c.p1} counters` };
    },
  },
  {
    card: 'Tamiyo, the Moon Sage', title: "with her emblem, a tutor that keeps coming back isn't recast until the library is gone",
    wrong: 'Demonic Tutor returned to hand and was cast 37 times in one turn, thinning the library until Atraxa decked herself',
    run({ table, card }) {
      const g = table(); const me = g.players[0]; me.emblems = ['tamiyo']; for (let i = 0; i < 40; i++) addLandTo(g, me); card(g, me, 'Demonic Tutor', 'hand'); const l0 = me.library.length;
      g.mainPhase(me);
      return { ok: l0 - me.library.length <= 3, note: `library ${l0} -> ${me.library.length}` };
      function addLandTo(g2, p) { const c = g2.makeCard('City of Brass', p, false); c.zone = 'bf'; c.ctrl = p.seat; g2.setInfo(c, { mana: { opts: [{ colors: ['W', 'U', 'B', 'R', 'G'], amount: 1, dmg: 0 }], oneShot: false }, name: 'Test Land', triggers: [], text: '' }); p.bf.push(c); }
    },
  },
  {
    card: 'Ugin, the Spirit Dragon', title: "doesn't -10 (draw seven) with fewer than seven cards in the library",
    wrong: 'Ugin drew seven off a five-card library and Atraxa lost to her own ultimate',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; const u = put(g, me, 'Ugin, the Spirit Dragon'); u.loyalty = 12; me.library = me.library.slice(0, 5);
      g.walkerOnce(me, u);
      return { ok: !me.lost, note: `Ugin at ${u.loyalty}, library ${me.library.length}` };
    },
  },
];
