// Scenarios for the Beledros deck. Same shape as ../scenarios.mjs.
export default [
  {
    card: 'Razaketh, the Foulblooded', title: 'before combat, Pests that can attack are not sacrificed yet (seed 555599590)',
    wrong: 'pumped 11/11 Pests were sacrificed to tutor before combat instead of attacking first and going after combat',
    run({ table, put }) {
      const g = table(11, 1); const me = g.players[0]; me.hand = []; put(g, me, 'Razaketh, the Foulblooded');
      g.addToken(me, { p: 1, t: 1, sub: 'Pest', colors: 'black green' }, 2, true); for (const c of me.bf) c.sick = false;
      g.active = me.seat; g.mainPhase(me, false);
      const pests = me.bf.filter((c) => c.token && /Pest/.test(c.info.name)).length;
      return { ok: pests === 2, note: `${pests} of 2 Pests left before combat` };
    },
  },
  {
    card: 'Hour of Promise', title: 'fetches Cabal Coffers together with Urborg, not Coffers alone',
    wrong: 'the two lands were picked one at a time, so Coffers could come without the Urborg that makes it work',
    run({ table, card }) {
      const g = table(11, 1); const me = g.players[0]; const h = card(g, me, 'Hour of Promise', 'hand');
      const before = new Set(me.bf.map((c) => c.id));
      g.resolveEffects(me, h.info.spell, h, null, true);
      const got = me.bf.filter((c) => !before.has(c.id)).map((c) => c.info.name);
      const pair = got.includes('Cabal Coffers') && got.includes('Urborg, Tomb of Yawgmoth');
      return { ok: pair || !got.includes('Cabal Coffers'), note: `fetched: ${got.join(', ')}` };
    },
  },
  {
    card: 'Beledros Witherbloom', title: 'tapped out with a big spell in hand at 40 life: pays 10 life, untaps the lands and casts it',
    wrong: 'he only considered it after combat with a strict score bar, so he sat on 9 tapped lands with Avenger of Zendikar in hand',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; me.command = []; put(g, me, 'Beledros Witherbloom');
      const lands = me.bf.filter((c) => c.info.isLand); for (const c of lands.slice(9)) g.removeFrom(me.bf, c); for (const c of lands.slice(0, 9)) c.tapped = true;
      card(g, me, 'Avenger of Zendikar', 'hand');
      g.mainPhase(me);
      const cast = me.bf.some((c) => c.name === 'Avenger of Zendikar');
      return { ok: cast && me.life === 30, note: `Avenger cast: ${cast}, life ${me.life}` };
    },
  },
  {
    card: 'Beledros Witherbloom', title: "doesn't pay 10 life to untap for a 2-mana creature",
    wrong: '',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; me.command = []; put(g, me, 'Beledros Witherbloom');
      const lands = me.bf.filter((c) => c.info.isLand); for (const c of lands.slice(9)) g.removeFrom(me.bf, c); for (const c of lands.slice(0, 9)) c.tapped = true;
      card(g, me, 'Essence Warden', 'hand');
      g.mainPhase(me);
      return { ok: me.life === 40, note: `life ${me.life}` };
    },
  },
  {
    card: 'Cabal Coffers', title: 'a land search that can find anything takes Cabal Coffers when Urborg is out',
    wrong: 'all lands were worth about the same to a search, so Hour of Promise or Crop Rotation took whatever made a colour',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Urborg, Tomb of Yawgmoth');
      for (const n of ['Bayou', 'Overgrown Tomb', 'Cabal Coffers', 'Woodland Cemetery', 'Gaea\'s Cradle']) card(g, me, n, 'library');
      g.resolveEffect(me, { k: 'ramp', bf: 1, hand: 0, tapped: true, anyLand: true }, null, 0, true);
      const got = me.bf.filter((c) => c.info.isLand).map((c) => c.name);
      return { ok: got.includes('Cabal Coffers'), note: `fetched: ${got.filter((n) => n !== 'Test Land').join(', ')}` };
    },
  },
  {
    card: 'Urborg, Tomb of Yawgmoth', title: 'with Cabal Coffers out, a search for any land takes Urborg',
    wrong: 'Urborg was valued as a land that makes no new colour',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Cabal Coffers');
      for (const n of ['Bayou', 'Overgrown Tomb', 'Urborg, Tomb of Yawgmoth', 'Woodland Cemetery']) card(g, me, n, 'library');
      g.resolveEffect(me, { k: 'search', n: 1, what: 'land', dest: 'bf' }, null, 0, true);
      const got = me.bf.filter((c) => c.info.isLand).map((c) => c.name);
      return { ok: got.includes('Urborg, Tomb of Yawgmoth'), note: `fetched: ${got.filter((n) => n !== 'Test Land' && n !== 'Cabal Coffers').join(', ')}` };
    },
  },
];
