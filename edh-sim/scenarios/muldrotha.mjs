// Scenarios for the muldrotha deck. Same shape as ../scenarios.mjs.
// Seat 0 plays the Muldrotha deck (table(11, 4)). "drill:" scenarios set up one of the deck's engines and check the AI
// actually runs it from mainPhase / combat, not only that the rules work.
// Muldrotha herself, moved from the command zone onto the battlefield
const mul = (g, p) => { const m = p.command.shift(); m.zone = 'bf'; m.ctrl = p.seat; m.sick = false; m.tapped = false; p.bf.push(m); return m; };
const lands = (g, p, n) => { for (const c of p.bf.filter((x) => x.info.isLand).slice(n)) g.removeFrom(p.bf, c); };
const setup = (table) => { const g = table(11, 4); const me = g.players[0]; mul(g, me); me.hand = []; return [g, me, g.players[1]]; };
export default [
  {
    card: 'Muldrotha, the Gravetide', title: 'drill: recasts Sakura-Tribe Elder from the graveyard',
    wrong: 'the graveyard creature was left there',
    run({ table, card }) {
      const [g, me] = setup(table); const ste = card(g, me, 'Sakura-Tribe Elder', 'gy'); lands(g, me, 4);
      g.mainPhase(me);
      return { ok: ste.zone !== 'gy' || me.gyCastTypes.has('Creature'), note: `Elder in ${ste.zone}` };
    },
  },
  {
    card: 'Muldrotha, the Gravetide', title: 'drill: casts a permanent of each type from the graveyard and plays a land from it',
    wrong: 'only some of the type slots were used',
    run({ table, card }) {
      const [g, me] = setup(table);
      for (const n of ['Eternal Witness', 'Sol Ring', 'Exploration', "Liliana, Death's Majesty", 'Forest']) card(g, me, n, 'gy');
      g.mainPhase(me);
      const out = me.bf.filter((c) => !c.token && c.info.name !== 'Test Land' && c.info.name !== 'Muldrotha, the Gravetide').map((c) => c.info.name);
      return { ok: out.length === 5, note: `on the battlefield: ${out.join(', ')}` };
    },
  },
  {
    card: 'Sakura-Tribe Elder', title: 'drill: with Muldrotha it sacrifices itself for a land and is cast again from the graveyard',
    wrong: 'the Elder just sat on the battlefield; sacrificing it was always judged a loss',
    run({ table, put }) {
      const [g, me] = setup(table); const ste = put(g, me, 'Sakura-Tribe Elder'); const l0 = me.bf.filter((c) => c.info.isLand).length;
      g.mainPhase(me);
      const l1 = me.bf.filter((c) => c.info.isLand).length;
      return { ok: ste.zone === 'bf' && me.gyCastTypes.has('Creature') && l1 === l0 + 1, note: `Elder ${ste.zone}, lands ${l0} -> ${l1}` };
    },
  },
  {
    card: 'Sakura-Tribe Elder', title: 'blocks an attacker and is sacrificed for a land before damage',
    wrong: 'it only chump-blocked when its controller was in danger, and was never sacrificed after blocking',
    run({ table, put }) {
      const [g, me, opp] = setup(table); me.bf.find((c) => c.isCommander).tapped = true; const ste = put(g, me, 'Sakura-Tribe Elder'); const l0 = me.bf.filter((c) => c.info.isLand).length;
      put(g, opp, 'Craterhoof Behemoth');
      g.chooseDefender = () => me; g._forceAttack = true; g.combat(opp); g._forceAttack = false;
      const l1 = me.bf.filter((c) => c.info.isLand).length;
      return { ok: me.life === 40 && ste.zone === 'gy' && l1 === l0 + 1, note: `life ${me.life}, Elder ${ste.zone}, lands ${l0} -> ${l1}` };
    },
  },
  {
    card: 'Kokusho, the Evening Star', title: 'drill: Muldrotha + Phyrexian Tower: sacrifice Kokusho (drain 5) and cast it again',
    wrong: 'Kokusho never went to a sacrifice outlet; only "whenever a creature dies" drains were used by the aristocrats logic',
    run({ table, put }) {
      const [g, me, opp] = setup(table); const k = put(g, me, 'Kokusho, the Evening Star'); put(g, me, 'Phyrexian Tower'); const l0 = opp.life;
      g.mainPhase(me);
      return { ok: opp.life === l0 - 5 && k.zone === 'bf' && me.gyCastTypes.has('Creature'), note: `opponent ${l0} -> ${opp.life}, Kokusho ${k.zone}` };
    },
  },
  {
    card: 'Kokusho, the Evening Star', title: 'drill: at the end of the turn Kokusho is sacrificed again (Muldrotha brings it back next turn)',
    wrong: 'with the creature slot used it stayed on the battlefield',
    run({ table, put }) {
      const [g, me, opp] = setup(table); const k = put(g, me, 'Kokusho, the Evening Star'); put(g, me, 'Altar of Dementia'); me.gyCastTypes.add('Creature'); const l0 = opp.life;
      g.mainPhase(me, true);
      return { ok: opp.life === l0 - 5 && k.zone === 'gy', note: `opponent ${l0} -> ${opp.life}, Kokusho ${k.zone}` };
    },
  },
  {
    card: 'Eternal Witness', title: 'drill: Muldrotha + Altar: Witness is sacrificed and recast to get back an instant or sorcery',
    wrong: 'Witness stayed on the battlefield, and when it did enter it took back permanents Muldrotha could cast anyway',
    run({ table, put, card }) {
      const [g, me] = setup(table); const w = put(g, me, 'Eternal Witness'); put(g, me, 'Altar of Dementia'); const dt = card(g, me, 'Demonic Tutor', 'gy'); card(g, me, 'Sol Ring', 'gy');
      lands(g, me, 4); g.mainPhase(me);
      return { ok: w.zone === 'bf' && dt.zone !== 'gy', note: `Witness ${w.zone}, Demonic Tutor ${dt.zone}` };
    },
  },
  {
    card: 'Spore Frog', title: 'drill: with Muldrotha out it fogs a 7-damage attack (it comes back next turn)',
    wrong: 'it only fogged lethal or 10+ damage, even though Muldrotha recasts it every turn',
    run({ table, put }) {
      const [g, me, opp] = setup(table); me.bf.find((c) => c.isCommander).tapped = true; const f = put(g, me, 'Spore Frog');
      put(g, opp, 'Craterhoof Behemoth'); put(g, opp, 'Vampire Nighthawk');
      g.chooseDefender = () => me; g._forceAttack = true; g.combat(opp); g._forceAttack = false;
      return { ok: me.life === 40 && f.zone === 'gy', note: `life ${me.life}, frog ${f.zone}` };
    },
  },
  {
    card: 'Spore Frog', title: 'drill: Muldrotha casts it again from the graveyard',
    wrong: 'it stayed in the graveyard',
    run({ table, card }) {
      const [g, me] = setup(table); const f = card(g, me, 'Spore Frog', 'gy');
      g.mainPhase(me);
      return { ok: f.zone === 'bf', note: `frog ${f.zone}` };
    },
  },
  {
    card: 'Jace, Wielder of Mysteries', title: 'drill: with one card left in the library the AI uses +1 and wins',
    wrong: 'Jace was not used to win',
    run({ table, put }) {
      const [g, me] = setup(table); put(g, me, 'Jace, Wielder of Mysteries'); me.library = me.library.slice(0, 1);
      g.mainPhase(me);
      return { ok: g.players.slice(1).every((q) => q.lost), note: `opponents lost: ${g.players.slice(1).map((q) => q.lost).join('/')}` };
    },
  },
  {
    card: 'Hermit Druid', title: 'drill: Hermit Druid + Jace with no basics left: mill the library, then Jace +1 wins',
    wrong: 'the Druid waited to attack, so Jace +1 was used first and nothing happened',
    run({ table, put }) {
      const [g, me] = setup(table); put(g, me, 'Hermit Druid'); put(g, me, 'Jace, Wielder of Mysteries'); me.library = me.library.filter((c) => !c.info.types.has('Basic'));
      g.mainPhase(me);
      return { ok: g.players.slice(1).every((q) => q.lost), note: `library ${me.library.length}, opponents lost: ${g.players.slice(1).map((q) => q.lost).join('/')}` };
    },
  },
  {
    card: 'Cyclonic Rift', title: 'is not spent on turn 3 to bounce a 1-mana Giver of Runes; it waits for overload',
    wrong: 'a bounce was scored like destroying the target, so Rift went on a creature its owner recast next turn for one mana',
    run({ table, card, put }) {
      const [g, me, opp] = setup(table); lands(g, me, 3); g.round = 3; const r = card(g, me, 'Cyclonic Rift', 'hand'); put(g, opp, 'Giver of Runes');
      g.mainPhase(me);
      return { ok: r.zone === 'hand', note: `Rift is in: ${r.zone}` };
    },
  },
  {
    card: 'Hermit Druid', title: 'does not attack into a blocker that would kill it (seed 96395496)',
    wrong: 'a 1/1 combo piece swung for 1 into an untapped Zulaport Cutthroat and traded; only creatures worth 6+ avoided trades',
    run({ table, put }) {
      const [g, me, opp] = setup(table); const d = put(g, me, 'Hermit Druid'); put(g, opp, 'Zulaport Cutthroat');
      g.chooseDefender = () => opp; g.combat(me);
      return { ok: d.zone === 'bf' && !d.tapped, note: d.zone !== 'bf' ? 'the Druid attacked and died' : d.tapped ? 'the Druid attacked' : 'the Druid stayed home' };
    },
  },
  {
    card: 'Hermit Druid', title: 'with no basic land left in the library (and no Jace) it is not used',
    wrong: 'with Muldrotha out it milled the whole library and decked its controller',
    run({ table, put }) {
      const [g, me] = setup(table); put(g, me, 'Hermit Druid'); me.library = me.library.filter((c) => !c.info.types.has('Basic'));
      const n0 = me.library.length; g.mainPhase(me, true);
      return { ok: me.library.length >= n0 - 2, note: `library ${n0} -> ${me.library.length}` };
    },
  },
  {
    card: 'Altar of Dementia', title: 'its ability can be activated (sacrifice for a mill)',
    wrong: 'sacrifice abilities that only milled were filtered out, so Altar never activated',
    run({ table, put }) {
      const [g, me] = setup(table); const a = put(g, me, 'Altar of Dementia'); g.addToken(me, { p: 2, t: 2, sub: 'Zombie', colors: 'black' }, 1, true);
      const prep = g.prepareAbility(me, a, a.info.activated[0], true);
      return { ok: !!prep && prep.fodder.length === 1 && g.abilityScore(me, prep) > 0, note: prep ? `fodder ${prep.fodder.map((c) => c.info.name)}, score ${g.abilityScore(me, prep)}` : 'not activatable' };
    },
  },
  {
    card: 'Torment of Hailfire', title: 'drill: with 14 mana it is cast for a big X',
    wrong: 'it was held',
    run({ table, card }) {
      const [g, me, opp] = setup(table); card(g, me, 'Torment of Hailfire', 'hand'); const l0 = opp.life;
      g.mainPhase(me);
      return { ok: opp.life <= l0 - 20, note: `opponent ${l0} -> ${opp.life}` };
    },
  },
  {
    card: 'Gilded Drake', title: "isn't cast when the only creatures are protected from creatures (Serra's Emissary)",
    wrong: 'the cast was judged without Gilded Drake as the source, so it was cast, found nothing to swap and was sacrificed',
    run({ table, put, card }) {
      const [g, me, opp] = setup(table); const d = card(g, me, 'Gilded Drake', 'hand');
      for (const q of g.players.slice(1)) q.bf = q.bf.filter((c) => !c.info.isCreature);
      const e = put(g, opp, "Serra's Emissary"); e.chosenType = 'Creature';
      const tgt = g.kws(e).has('emissary');
      g.mainPhase(me);
      return { ok: tgt && d.zone === 'hand', note: `emissary keyword ${tgt}, Drake ${d.zone}` };
    },
  },
  {
    card: 'The Gitrog Monster', title: 'discarding several lands at cleanup draws once, and cleanup repeats down to seven',
    wrong: 'each discarded land drew a card and cleanup ran once, leaving 9-10 cards in hand',
    run({ table, put, card }) {
      const [g, me] = setup(table); put(g, me, 'The Gitrog Monster'); me.bf = me.bf.filter((c) => !c.info.isLand || me.bf.indexOf(c) < 5 + me.bf.findIndex((x) => x.info.isLand));
      for (let i = 0; i < 6; i++) card(g, me, 'Forest', 'hand');
      for (let i = 0; i < 6; i++) card(g, me, 'Craterhoof Behemoth', 'hand');
      const ev = []; const em = g.emit.bind(g); g.emit = (kind, text, x) => { ev.push(text); return em(kind, text, x); };
      g.takeTurn(me);
      const draws = ev.filter((t) => /off The Gitrog Monster/.test(t)).length;
      return { ok: me.hand.length <= 7 && draws <= 4, note: `hand ${me.hand.length}, Gitrog draws ${draws}` };
    },
  },
  {
    card: 'Muldrotha, the Gravetide', title: 'drill: recasts Sol Ring from the graveyard',
    wrong: 'reported in a game: Sol Ring sat in the graveyard while Muldrotha had the mana',
    run({ table, card }) {
      const [g, me] = setup(table); const sr = card(g, me, 'Sol Ring', 'gy'); lands(g, me, 3);
      g.mainPhase(me);
      return { ok: sr.zone === 'bf', note: `Sol Ring in ${sr.zone}` };
    },
  },
  {
    card: 'Hermit Druid', title: "isn't used while an opponent's Valgavoth would exile everything it mills (and let them play it)",
    wrong: 'reported in a game: Hermit Druid milled 24 cards straight into Valgavoth\'s exile',
    run({ table, put }) {
      const [g, me, opp] = setup(table); put(g, me, 'Hermit Druid'); put(g, opp, 'Valgavoth, Terror Eater');
      const n0 = me.library.length; g.mainPhase(me); g.mainPhase(me, true);
      return { ok: me.library.length >= n0 - 1 && !me.exile.length, note: `library ${n0} -> ${me.library.length}, exiled ${me.exile.length}` };
    },
  },
  {
    card: 'Dauthi Voidwalker', title: "exiles even its controller's own cards headed to an opponent's graveyard (no Valgavoth exception)",
    wrong: "Dauthi was given Valgavoth's 'a card you didn't control' exception",
    run({ table, put }) {
      const [g, me, opp] = setup(table); put(g, me, 'Dauthi Voidwalker'); const c = put(g, opp, 'Sol Ring'); g.removeFrom(opp.bf, c); c.ctrl = me.seat; me.bf.push(c); // (a card of theirs we control)
      g.destroy(c, 'destroyed', true);
      return { ok: c.zone === 'exile', note: `Sol Ring in ${c.zone}` };
    },
  },
];
