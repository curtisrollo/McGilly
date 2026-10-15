// Scenarios for the myrkul deck. Same shape as ../scenarios.mjs.
const ench = (p) => p.bf.filter((c) => c.info.types.has('Enchantment')).length;
const myrkulTable = (table) => table(11, 5); // Myrkul's deck in seat 0
export default [
  {
    card: 'Academy Rector', title: 'dying with no Myrkul out, it exiles itself and puts an enchantment onto the battlefield',
    wrong: '(regression guard; was already right when checked) the search did not happen, or the Rector stayed in the graveyard',
    run({ table, put }) {
      const g = myrkulTable(table); const me = g.players[0]; const r = put(g, me, 'Academy Rector'); const e0 = ench(me);
      g.destroy(r, 'destroyed', true);
      return { ok: r.zone === 'exile' && ench(me) === e0 + 1, note: `Rector in ${r.zone}, enchantments ${e0} -> ${ench(me)}` };
    },
  },
  {
    card: 'Sanctum Weaver', title: 'taps for X mana where X is the number of enchantments you control',
    wrong: '(regression guard; was already right when checked) it tapped for one mana',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; me.bf = []; const w = put(g, me, 'Sanctum Weaver'); put(g, me, 'Exploration'); put(g, me, 'Doubling Season');
      const src = g.sources(me).find((x) => x.c === w);
      return { ok: !!src && src.opts[0].amount === 3, note: src ? `${src.opts[0].amount} mana` : 'no mana' };
    },
  },
  {
    card: 'Sun Titan', title: 'can return a land card (a permanent card with mana value 3 or less)',
    wrong: '(regression guard; was already right when checked) only nonland permanents came back',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; const l = card(g, me, 'Gaea\'s Cradle', 'gy');
      const t = card(g, me, 'Sun Titan', 'hand'); g.removeFrom(me.hand, t); g.enterBattlefield(t, me, {});
      return { ok: l.zone === 'bf', note: `Cradle in ${l.zone}` };
    },
  },
  {
    card: 'Archivist of Oghma', title: 'an opponent searching their library with Finale of Devastation triggers it',
    wrong: "Finale's library search never told Archivist",
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Archivist of Oghma'); const h0 = me.hand.length;
      opp.gy = [];
      const f = card(g, opp, 'Finale of Devastation', 'hand'); g.resolveEffect(opp, { k: 'finale' }, f, 3, false);
      return { ok: me.hand.length === h0 + 1, note: `drew ${me.hand.length - h0}` };
    },
  },
  {
    card: 'Palisade Giant', title: 'damage that would be dealt to another creature you control is dealt to the Giant instead',
    wrong: 'only damage to the player was redirected',
    run({ table, put }) {
      const g = table(); const [me, opp] = g.players; const giant = put(g, me, 'Palisade Giant'); const bird = put(g, me, 'Birds of Paradise');
      g.resolveEffect(opp, { k: 'damage', n: 2 }, null, 0, false); g.checkState(); // a 2-damage spell aimed at the Birds
      const d1 = giant.dmg; giant.dmg = 0;
      const blocker = put(g, me, 'Birds of Paradise'); const atk = put(g, opp, 'Craterhoof Behemoth'); // and combat damage to a blocker
      g.chooseDefender = () => me; g.declareBlocks = () => new Map([[atk.id, [blocker]]]); g.combat(opp);
      return { ok: bird.zone === 'bf' && blocker.zone === 'bf' && d1 === 2 && giant.dmg === 5, note: `Birds ${bird.zone}, blocking Birds ${blocker.zone}, Giant damage ${d1} then ${giant.dmg}` };
    },
  },
  {
    card: 'Cinderhaze Wretch', title: 'with Myrkul and Opalescence the enchantment copy is a creature, so its -1/-1 counters kill it',
    wrong: 'the animated copy looped forever as if it were not a creature',
    run({ table, put, card }) {
      const g = myrkulTable(table); const [me, ...opps] = g.players; put(g, me, 'Myrkul, Lord of Bones'); put(g, me, 'Opalescence'); const w = put(g, me, 'Cinderhaze Wretch');
      for (const q of opps) for (let i = 0; i < 6; i++) card(g, q, 'Forest', 'hand');
      const prep = g.prepareAbility(me, w, w.info.activated[0], false); if (prep) g.doActivate(me, prep);
      const copy = me.bf.find((c) => c.ench && c.info.name === 'Cinderhaze Wretch');
      const left = opps.reduce((s, q) => s + q.hand.length, 0);
      return { ok: !copy && left > 0, note: `copy on battlefield: ${!!copy}, cards left in opponents' hands: ${left}` };
    },
  },
  {
    card: 'Opalescence', title: 'an enchantment creature becomes a creature with base P/T equal to its mana value',
    wrong: '(regression guard; was already right when checked) it kept its printed power and toughness',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Opalescence'); const s = put(g, me, "Sythis, Harvest's Hand"); g.refreshAnimations();
      return { ok: g.power(s) === 2 && g.toughness(s) === 2, note: `${g.power(s)}/${g.toughness(s)}` };
    },
  },
  {
    card: 'Opalescence', title: 'an enchantment entering animated triggers "whenever a creature you control enters" (Aura Shards)',
    wrong: '(regression guard; was already right when checked) the enchantment entered as a non-creature as far as creature-enters triggers were concerned',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Opalescence'); put(g, me, 'Aura Shards'); opp.bf = opp.bf.filter((c) => c.info.isLand); const ring = put(g, opp, 'Sol Ring');
      const e = card(g, me, 'Exploration', 'hand'); g.removeFrom(me.hand, e); g.enterBattlefield(e, me, {});
      return { ok: ring.zone !== 'bf', note: `Sol Ring ${ring.zone}` };
    },
  },
  {
    card: 'Opalescence', title: 'Myrkul\'s enchantment copies are animated by Opalescence',
    wrong: 'the copies stayed non-creatures',
    run({ table, put }) {
      const g = myrkulTable(table); const me = g.players[0]; put(g, me, 'Myrkul, Lord of Bones'); put(g, me, 'Opalescence'); const w = put(g, me, 'Eternal Witness');
      g.destroy(w, 'destroyed', true);
      const copy = me.bf.find((c) => c.ench && c.name === 'Eternal Witness');
      return { ok: !!copy && copy.info.isCreature && g.power(copy) === 3, note: copy ? `creature ${copy.info.isCreature}, ${g.power(copy)}/${g.toughness(copy)}` : 'no copy' };
    },
  },
  {
    card: "Teferi's Protection", title: 'cast in response to a lethal attack: no combat damage, and life can\'t change',
    wrong: 'it was only used against wipes and targeted removal, so the player died to the attack with it in hand',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; opp.life = 10; card(g, opp, "Teferi's Protection", 'hand');
      for (let i = 0; i < 3; i++) put(g, me, 'Craterhoof Behemoth');
      for (const q of g.players.slice(2)) q.life = 100;
      g.chooseDefender = () => opp; g.combat(me);
      return { ok: !opp.lost && opp.life === 10, note: `life ${opp.life}, lost ${opp.lost}` };
    },
  },
  {
    card: "Teferi's Protection", title: 'its permanents phase out until its next turn (an exile wipe a turn later misses them)',
    wrong: 'permanents stayed on the battlefield, only indestructible until end of turn',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; card(g, opp, "Teferi's Protection", 'hand'); const big = put(g, opp, 'Craterhoof Behemoth'); put(g, opp, 'Elesh Norn, Grand Cenobite');
      const f = card(g, me, 'Damnation', 'hand'); g.resolveEffect(me, { k: 'wipe', what: 'creatures', exile: false }, f, 0, false);
      const phased = big.zone === 'phased' || (opp.phased || []).includes(big);
      return { ok: big.zone !== 'gy' && phased, note: `Craterhoof ${big.zone}` };
    },
  },
  {
    card: 'Heliod, Sun-Crowned', title: 'gaining life puts a +1/+1 counter on a creature you control',
    wrong: '(regression guard; was already right when checked) its lifegain trigger did nothing',
    run({ table, put }) {
      const g = table(); const me = g.players[0]; put(g, me, 'Heliod, Sun-Crowned'); const b = put(g, me, 'Birds of Paradise');
      g.gainLife(me, 1);
      return { ok: b.p1 === 1, note: `${b.p1} counters` };
    },
  },
  {
    card: 'Phyrexian Tower', title: 'can sacrifice a creature for {B}{B} the turn it enters (lands are not summoning sick)',
    wrong: 'a Tower that just entered was treated as summoning sick',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; me.bf = []; g.addToken(me, { p: 1, t: 1, sub: 'Pest', colors: 'black green' }, 1, true);
      const t = card(g, me, 'Phyrexian Tower', 'hand'); g.removeFrom(me.hand, t); g.enterBattlefield(t, me, {});
      const src = g.sources(me).find((x) => x.c === t && x.fodder);
      return { ok: !!src, note: src ? '' : 'no fodder mana from the new Tower' };
    },
  },
  {
    card: 'Fabled Passage', title: 'untaps the land it fetched when you control four lands counting that land',
    wrong: 'the new land was not counted, so it needed five lands',
    run({ table, put, card }) {
      const g = table(); const me = g.players[0]; me.bf = me.bf.filter((c) => c.info.isLand).slice(0, 3);
      const f = card(g, me, 'Fabled Passage', 'hand'); g.removeFrom(me.hand, f); g.enterBattlefield(f, me, {});
      const fetched = me.bf.find((c) => c.info.types.has('Basic'));
      return { ok: !!fetched && !fetched.tapped, note: fetched ? `${fetched.info.name} tapped ${fetched.tapped}` : 'no land fetched' };
    },
  },
  {
    card: 'Yawgmoth, Thran Physician', title: 'the AI sacrifices spare tokens to kill X/1s and draw',
    wrong: "the ability was never activated in the main phase",
    run({ table, put }) {
      const g = myrkulTable(table); const [me, opp] = g.players; put(g, me, 'Yawgmoth, Thran Physician');
      g.addToken(me, { p: 1, t: 1, sub: 'Pest', colors: 'black' }, 3, true); for (const c of me.bf) c.sick = false;
      const birds = [put(g, opp, 'Birds of Paradise'), put(g, opp, 'Birds of Paradise')]; const l0 = me.library.length;
      g.mainPhase(me, true);
      return { ok: birds.every((b) => b.zone !== 'bf') && me.library.length <= l0 - 2, note: `Birds left ${birds.filter((b) => b.zone === 'bf').length}, drew ${l0 - me.library.length}` };
    },
  },
  {
    card: 'Birthing Pod', title: 'its ability costs {1}{G/P} (two mana, or one and 2 life)',
    wrong: 'the {G/P} symbol was dropped from the activation cost, so it cost {1}',
    run({ table, put }) {
      const g = table(); const pod = put(g, g.players[0], 'Birthing Pod'); const ab = pod.info.activated[0];
      return { ok: ab.cost.mv === 2 && ab.cost.pips.length === 1 && ab.cost.pips[0].phy && pod.info.sacOutlet.mana === 2, note: JSON.stringify(ab.cost) };
    },
  },
  // ---------- combo drills: the AI has to find and use its engines in the main phase ----------
  {
    card: 'Devoted Druid', title: 'drill: Myrkul + Devoted Druid makes unlimited green mana and the AI spends it on a lethal Finale of Devastation',
    wrong: '(drill) the AI made the mana and then did nothing with it',
    run({ table, put, card }) {
      const g = myrkulTable(table); const [me, ...opps] = g.players; me.command = []; me.bf = me.bf.filter((c) => c.info.isLand).slice(0, 3);
      put(g, me, 'Myrkul, Lord of Bones').isCommander = true; put(g, me, 'Devoted Druid'); card(g, me, 'Finale of Devastation', 'hand');
      for (const q of opps) q.bf = q.bf.filter((c) => c.info.isLand);
      g.mainPhase(me); g.combat(me);
      return { ok: opps.some((q) => q.lost), note: `opponents at ${opps.map((q) => q.life).join(', ')}` };
    },
  },
  {
    card: 'Genesis Wave', title: 'drill: with unlimited mana, X is kept small enough that the constellation draws do not deck us',
    wrong: 'X was the whole library, and Eidolon of Blossoms / Setessan Champion drew from an empty library',
    run({ table, put, card }) {
      const g = myrkulTable(table); const [me, ...opps] = g.players; me.command = []; me.bf = me.bf.filter((c) => c.info.isLand).slice(0, 3);
      me.library = me.library.filter((c) => c.name !== 'Platinum Angel');
      put(g, me, 'Myrkul, Lord of Bones').isCommander = true; put(g, me, 'Devoted Druid'); card(g, me, 'Genesis Wave', 'hand');
      g.mainPhase(me); g.combat(me); g.mainPhase(me, true);
      return { ok: !me.lost && me.library.length >= 1 && me.bf.length > 30, note: `library ${me.library.length}, permanents ${me.bf.length}, lost ${me.lost}` };
    },
  },
  {
    card: 'Demonic Tutor', title: 'drill: with Myrkul + Devoted Druid assembled, the tutor finds the finisher (Finale of Devastation) and it gets cast',
    wrong: '(drill) the tutor picked some other good card and the unlimited mana went unused',
    run({ table, put, card }) {
      const g = myrkulTable(table); const [me, ...opps] = g.players; me.command = []; me.bf = me.bf.filter((c) => c.info.isLand).slice(0, 3);
      me.library = me.library.filter((c) => c.name !== 'Genesis Wave');
      put(g, me, 'Myrkul, Lord of Bones').isCommander = true; put(g, me, 'Devoted Druid'); card(g, me, 'Demonic Tutor', 'hand');
      for (const q of opps) q.bf = q.bf.filter((c) => c.info.isLand);
      g.mainPhase(me); g.combat(me);
      const fin = g.players[0].gy.concat(me.exile).some((c) => c.name === 'Finale of Devastation');
      return { ok: fin && opps.some((q) => q.lost), note: `Finale cast: ${fin}, opponents at ${opps.map((q) => q.life).join(', ')}` };
    },
  },
  {
    card: "Serra's Sanctum", title: 'drill: Sanctum with five enchantments pays for a seven-drop off two other lands',
    wrong: '(drill) the AI did not count the Sanctum mana and held the spell',
    run({ table, put, card }) {
      const g = myrkulTable(table); const me = g.players[0]; me.command = []; me.bf = me.bf.filter((c) => c.info.isLand).slice(0, 2);
      put(g, me, "Serra's Sanctum"); for (const n of ['Exploration', 'Sphere of Safety', 'Smothering Tithe', 'Phyrexian Arena', 'Greater Auramancy']) put(g, me, n);
      const e = card(g, me, 'Elesh Norn, Grand Cenobite', 'hand');
      g.mainPhase(me);
      return { ok: e.zone === 'bf', note: `Elesh Norn in ${e.zone}` };
    },
  },
  {
    card: 'Argothian Enchantress', title: 'drill: with Enchantress and Sythis out, the AI chains its cheap enchantments and draws off each',
    wrong: '(drill) the AI stopped after one or two spells',
    run({ table, put, card }) {
      const g = myrkulTable(table); const me = g.players[0]; me.command = []; me.bf = me.bf.filter((c) => c.info.isLand).slice(0, 7);
      put(g, me, 'Argothian Enchantress'); put(g, me, "Sythis, Harvest's Hand");
      const hand = ['Exploration', 'Sylvan Library', 'Greater Auramancy', 'Sterling Grove'].map((n) => card(g, me, n, 'hand'));
      me.library.sort((a, b) => b.info.isLand - a.info.isLand); // (it draws lands, so the drill is only about the four enchantments)
      const l0 = me.library.length; g.mainPhase(me);
      const cast = hand.filter((c) => c.zone !== 'hand').length;
      return { ok: cast === 4 && l0 - me.library.length >= 8, note: `${cast} of 4 cast, drew ${l0 - me.library.length}` };
    },
  },
  {
    card: 'Aura Shards', title: 'destroys a destructible artifact or enchantment rather than aiming at an indestructible one',
    wrong: 'it kept picking an indestructible artifact (The Soul Stone) and did nothing',
    run({ table, put, card }) {
      const g = table(); const [me, opp] = g.players; put(g, me, 'Aura Shards'); opp.bf = opp.bf.filter((c) => c.info.isLand);
      put(g, opp, 'The Soul Stone'); const ring = put(g, opp, 'Sol Ring');
      const b = card(g, me, 'Birds of Paradise', 'hand'); g.removeFrom(me.hand, b); g.enterBattlefield(b, me, {});
      return { ok: ring.zone !== 'bf', note: `Sol Ring ${ring.zone}` };
    },
  },
];
