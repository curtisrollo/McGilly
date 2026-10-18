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
  // ---------- graveyard counts, energy, recruit, inspired, miracle, spree ----------
  {
    card: 'Cephalid Coliseum', title: 'with threshold, draws three and discards three; without, it cannot',
    wrong: 'its threshold ability was not read',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; me.gy = []; const cc = put(g, me, 'Cephalid Coliseum'); put(g, me, 'Island');
      const ab = cc.info.activated.find((x) => x.threshold); const before = !!(ab && g.prepareAbility(me, cc, ab, false));
      for (let i = 0; i < 7; i++) card(g, me, 'Swamp', 'gy'); const h0 = me.hand.length, gy0 = me.gy.length;
      const prep = ab && g.prepareAbility(me, cc, ab, false); if (prep) g.doActivate(me, prep);
      return { ok: !before && !!prep && cc.zone !== 'bf' && me.hand.length === h0 && me.gy.length === gy0 + 4, note: `usable at 0 cards ${before}; hand ${h0} -> ${me.hand.length}, graveyard ${gy0} -> ${me.gy.length}` };
    },
  },
  {
    card: 'Psychic Frog', title: 'exiles three graveyard cards to gain flying (needs three)',
    wrong: 'its "exile three cards from your graveyard" ability was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.gy = []; const f = put(g, me, 'Psychic Frog'); f.sick = false;
      g.active = me.seat; g.phase = 'main1'; for (const q of g.opps(me)) q.bf = q.bf.filter((c) => !c.info.isCreature); put(g, opp, 'Old Gnawbone'); for (const q of g.opps(me)) if (q !== opp) q.bf = q.bf.filter((c) => !c.info.isCreature);
      const ab = f.info.activated.find((x) => x.exileGy); const before = !!(ab && g.prepareAbility(me, f, ab, false));
      for (let i = 0; i < 3; i++) card(g, me, 'Swamp', 'gy'); const prep = ab && g.prepareAbility(me, f, ab, false); if (prep) g.doActivate(me, prep);
      return { ok: !before && g.hasKw(f, 'flying') && me.gy.length === 0, note: `usable with 0 cards ${before}; flying ${g.hasKw(f, 'flying')}; graveyard ${me.gy.length}` };
    },
  },
  {
    card: 'Liliana the Repentant', title: 'another creature entering mills two; exhaust returns a creature card',
    wrong: 'her triggered and exhaust abilities were not read',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; me.gy = []; const l = put(g, me, 'Liliana the Repentant'); l.sick = false;
      const gy0 = me.gy.length; g.enterBattlefield(card(g, me, 'Psychic Frog', 'hand'), me, {}); const milled = me.gy.length - gy0;
      const big = card(g, me, 'Archfiend of Ifnir', 'gy'); for (const c of me.bf) if (c.info.isLand) c.tapped = false;
      const ab = l.info.activated.find((x) => x.exhaust); const prep = ab && g.prepareAbility(me, l, ab, false); if (prep) g.doActivate(me, prep);
      const again = ab && g.prepareAbility(me, l, ab, false);
      return { ok: milled === 2 && big.zone === 'bf' && !again, note: `milled ${milled}; Archfiend in ${big.zone}; exhaust usable again ${!!again}` };
    },
  },
  {
    card: 'Guide of Souls', title: 'another creature entering gives 1 life and 1 energy',
    wrong: 'its creature-enters trigger was not read',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; put(g, me, 'Guide of Souls'); const l0 = me.life, e0 = me.energy || 0;
      g.enterBattlefield(card(g, me, 'Psychic Frog', 'hand'), me, {});
      return { ok: me.life === l0 + 1 && (me.energy || 0) === e0 + 1, note: `life ${l0} -> ${me.life}, energy ${e0} -> ${me.energy || 0}` };
    },
  },
  {
    card: 'The Queen of Dale', title: 'an opponent\'s first noncreature spell each turn makes her controller recruit',
    wrong: 'her trigger was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; put(g, me, 'The Queen of Dale'); me.hand = [];
      const dt = card(g, opp, 'Demonic Tutor', 'hand'); g.active = opp.seat; const gy0 = me.gy.length; opp.nonCreatureSpells = 0;
      g.castSpell(opp, dt, 'hand');
      return { ok: me.gy.length === gy0 + 1, note: `graveyard ${gy0} -> ${me.gy.length} (drew one, discarded one)` };
    },
  },
  {
    card: 'Disciple of Deceit', title: 'untapping, trades a weak card for a better one of the same mana value',
    wrong: 'its inspired trigger was not read',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; me.hand = []; const d = put(g, me, 'Disciple of Deceit'); d.tapped = true;
      const cand = me.library.find((y) => !y.info.isLand);
      const mv = cand ? cand.info.mv || 0 : 0; const filler = card(g, me, cand ? cand.info.name : 'Psychic Frog', 'hand'); me.hand = [filler];
      const old = g.cardValue; g.cardValue = (p, x) => (x === filler ? -10 : old.call(g, p, x));
      g.active = me.seat; g.takeTurn(me, false); g.cardValue = old;
      return { ok: filler.zone === 'gy' || filler.zone === 'exile' || !me.hand.includes(filler), note: `the weak copy (mana value ${mv}) is in ${filler.zone}` };
    },
  },
  {
    card: 'Metamorphosis Fanatic', title: 'drawn first in a turn with mana up, it is cast for its miracle cost',
    wrong: 'miracle was not read',
    run({ table, put }) {
      const g = raffine(table); const me = g.players[0]; me.hand = []; for (let i = 0; i < 4; i++) put(g, me, 'Swamp');
      for (const c of me.bf) if (c.info.isLand) c.tapped = false; const mf = me.library.find((c) => c.info.name === 'Metamorphosis Fanatic') || null;
      if (!mf) return { ok: false, note: 'not in library' };
      g.removeFrom(me.library, mf); me.library.unshift(mf); me.cardsDrawnThisTurn = 0; me.drawnThisTurn = 0; g.draw(me, 1);
      return { ok: mf.zone === 'bf', note: `Metamorphosis Fanatic in ${mf.zone}` };
    },
  },
  {
    card: 'Insatiable Avarice', title: 'spree: with enough mana it pays for both modes (tutor and draw three)',
    wrong: 'spree was not read: it had no modes or paid for none',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; me.hand = []; for (let i = 0; i < 4; i++) put(g, me, 'Swamp'); for (const c of me.bf) if (c.info.isLand) c.tapped = false;
      const ia = card(g, me, 'Insatiable Avarice', 'hand'); const cost = g.costFor(me, ia, 'hand'); const l0 = me.life;
      return { ok: cost.mv === 5 && (ia._spree || []).length === 2, note: `cost mana value ${cost.mv}, modes ${(ia._spree || []).length}; life ${l0}` };
    },
  },
  {
    card: 'Spider-Sense', title: 'web-slinging: its alternative cost returns a tapped creature',
    wrong: 'web-slinging was not read',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; me.hand = []; const ss = card(g, me, 'Spider-Sense', 'hand');
      const none = g.altCostOk(me, ss); const f = put(g, me, 'Psychic Frog'); f.tapped = true; const some = g.altCostOk(me, ss);
      return { ok: !none && some, note: `with no tapped creature ${none}, with one ${some}` };
    },
  },
  {
    card: 'Abhorrent Oculus', title: 'each opponent\'s upkeep it manifests dread (a 2/2)',
    wrong: 'manifest dread was not read',
    run({ table, put }) {
      const g = raffine(table); const [me, opp] = g.players; put(g, me, 'Abhorrent Oculus'); const n0 = me.bf.filter((c) => c.info.isCreature).length;
      g.active = opp.seat; g.takeTurn(opp, false);
      const n1 = me.bf.filter((c) => c.info.isCreature).length;
      return { ok: n1 === n0 + 1, note: `creatures ${n0} -> ${n1}` };
    },
  },
  // ---------- the last six ----------
  {
    card: 'Ainok Strike Leader', title: 'sacrificed in response to a wipe, so the creature tokens survive',
    wrong: 'its sacrifice ability was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; put(g, me, 'Ainok Strike Leader');
      const toks = []; for (let i = 0; i < 3; i++) toks.push(g.addToken(me, { p: 2, t: 2, sub: 'Soldier', colors: 'white' }, 1, true));
      const t = me.bf.filter((c) => c.token && c.info.isCreature);
      const w = card(g, opp, 'Damnation', 'hand'); g.resolveEffects(opp, w.info.spell, w, null, false);
      const left = me.bf.filter((c) => c.token && c.info.isCreature).length;
      return { ok: t.length === 3 && left === 3, note: `tokens ${t.length} -> ${left}` };
    },
  },
  {
    card: 'Bruna, the Fading Light', title: 'cast, it returns an Angel or Human from the graveyard (not another type)',
    wrong: 'its cast trigger was not read',
    run({ table, card }) {
      const g = raffine(table); const me = g.players[0]; me.gy = [];
      const gi = card(g, me, 'Gisela, the Broken Blade', 'gy'); const ar = card(g, me, 'Archfiend of Ifnir', 'gy'); const b = card(g, me, 'Bruna, the Fading Light', 'hand');
      g.castTriggers(me, b, 'hand');
      return { ok: gi.zone === 'bf' && ar.zone === 'gy', note: `Gisela ${gi.zone}, Archfiend ${ar.zone}` };
    },
  },
  {
    card: 'Gisela, the Broken Blade', title: 'with Bruna, melds into Brisela at end step; opponents then can\'t cast cheap spells; Brisela dying takes both cards to the graveyard',
    wrong: 'the meld was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; const gi = put(g, me, 'Gisela, the Broken Blade'); const br = put(g, me, 'Bruna, the Fading Light');
      g.endStepDelayed(me);
      const melded = gi.info.name === 'Brisela, Voice of Nightmares' && br.zone === 'exile' && g.power(gi) === 9;
      const dt = card(g, opp, 'Demonic Tutor', 'hand'); const locked = !g.castables(opp).some((x) => x.c === dt);
      g.destroy(gi); g.checkState();
      return { ok: melded && locked && gi.zone === 'gy' && br.zone === 'gy', note: `melded ${melded}; Demonic Tutor locked ${locked}; after it dies: Gisela ${gi.zone}, Bruna ${br.zone}` };
    },
  },
  {
    card: 'Grim Hireling', title: 'sacrifices as many Treasures as it takes to shrink the best creature to death',
    wrong: 'its {B}, sacrifice X Treasures ability was not read',
    run({ table, put }) {
      const g = raffine(table); const [me, opp] = g.players; const h = put(g, me, 'Grim Hireling'); put(g, me, 'Swamp');
      for (const c of me.bf) if (c.info.isLand) c.tapped = false;
      g.addToken(me, { treasure: true }, 4, true);
      const gn = put(g, opp, 'Vampire Nighthawk'); const tg = g.toughness(gn);
      const ab = h.info.activated.find((x) => x.fx.some((f) => f.k === 'hireling')); const prep = ab && g.prepareAbility(me, h, ab, false); if (prep) g.doActivate(me, prep);
      const tr = me.bf.filter((c) => c.token && c.info.name === 'Treasure').length;
      return { ok: gn.zone !== 'bf' && tr === 4 - tg, note: `Vampire Nighthawk (toughness ${tg}) ${gn.zone}; Treasures left ${tr}` };
    },
  },
  {
    card: 'Hydroelectric Specimen', title: 'flashed in, it takes a removal spell aimed at something better',
    wrong: 'its target-changing trigger was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.hand = []; const sp = card(g, me, 'Hydroelectric Specimen // Hydroelectric Laboratory', 'hand');
      for (const c of me.bf) if (c.info.isLand) c.tapped = false; const big = put(g, me, 'Archon of Cruelty');
      const sw = card(g, opp, 'Swords to Plowshares', 'hand'); g.active = opp.seat;
      const red = g.redirectRemoval(me, opp, big, sw);
      return { ok: red && big.zone === 'bf' && sp.zone !== 'hand' && sp.zone !== 'bf', note: `redirected ${red}; Archon ${big.zone}; Specimen ${sp.zone}` };
    },
  },
  {
    card: 'Muddle the Mixture', title: 'transmutes (discard it, find a better two-mana card) on its own turn only',
    wrong: 'transmute was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.hand = []; const m = card(g, me, 'Muddle the Mixture', 'hand');
      for (const c of me.bf) if (c.info.isLand) c.tapped = false;
      g.active = opp.seat; const theirs = g.castables(me).some((x) => x.from === 'transmute');
      g.active = me.seat; const mine = g.castables(me).some((x) => x.from === 'transmute');
      const pick = g.transmuteFind(me, m); const done = g.castSpell(me, m, 'transmute');
      return { ok: !theirs && mine && done && m.zone === 'gy' && !!pick && me.hand.includes(pick) && (pick.info.mv || 0) === 2, note: `on their turn ${theirs}, on mine ${mine}; found ${pick && pick.info.name} (mana value ${pick && pick.info.mv})` };
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
  // ---------- graveyard ----------
  {
    card: 'Living Death', title: 'graveyard creatures come back and battlefield creatures die, for every player',
    wrong: 'it had no effect',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.bf = me.bf.filter((c) => c.info.isLand); opp.bf = opp.bf.filter((c) => c.info.isLand);
      const mine = card(g, me, 'Archon of Cruelty', 'gy'); const theirs = put(g, opp, 'Old Gnawbone'); const ld = card(g, me, 'Living Death', 'hand');
      g.resolveEffects(me, ld.info.spell, ld, null, true);
      return { ok: mine.zone === 'bf' && theirs.zone !== 'bf', note: `Archon ${mine.zone}, Gnawbone ${theirs.zone}` };
    },
  },
  {
    card: 'Victimize', title: 'sacrifices the cheapest creature and returns the two best from the graveyard, tapped',
    wrong: 'it had no effect',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; me.bf = me.bf.filter((c) => c.info.isLand); me.gy = [];
      const fod = put(g, me, 'Generous Pup'); const a = card(g, me, 'Archon of Cruelty', 'gy'); const b = card(g, me, 'Elesh Norn, Grand Cenobite', 'gy'); card(g, me, 'Moonshadow', 'gy');
      const v = card(g, me, 'Victimize', 'hand'); g.resolveEffects(me, v.info.spell, v, null, true);
      return { ok: fod.zone !== 'bf' && a.zone === 'bf' && b.zone === 'bf' && a.tapped && b.tapped, note: `Pup ${fod.zone}; Archon ${a.zone}${a.tapped ? ' tapped' : ''}, Elesh Norn ${b.zone}` };
    },
  },
  {
    card: 'Treasure Cruise', title: 'delve: exiles graveyard cards to pay, so it is cast with one land',
    wrong: 'delve was not read: it needed eight mana',
    run({ table, card, addLand }) {
      const g = raffine(table); const me = g.players[0]; me.hand = []; me.bf = []; me.gy = []; addLand(g, me);
      for (const n of ['Sol Ring', 'Forest', 'Exploration', 'Swamp', 'Island', 'Plains', 'Mountain']) card(g, me, n, 'gy');
      const tc = card(g, me, 'Treasure Cruise', 'hand'); const d0 = me.cardsDrawn; g.mainPhase(me);
      return { ok: tc.zone !== 'hand' && me.exile.length >= 7 && me.cardsDrawn - d0 >= 3, note: `Cruise ${tc.zone}; exiled ${me.exile.length}; drew ${me.cardsDrawn - d0}` };
    },
  },
  {
    card: 'Wonder', title: 'in the graveyard with an Island out, our creatures fly',
    wrong: 'its graveyard ability was not read',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; const pup = put(g, me, 'Generous Pup'); put(g, me, 'Island');
      const before = g.hasKw(pup, 'flying'); card(g, me, 'Wonder', 'gy'); g.emit('effect', 'x'); const after = g.hasKw(pup, 'flying');
      return { ok: !before && after, note: `flying ${before} -> ${after}` };
    },
  },
  {
    card: 'Moonshadow', title: 'enters with six -1/-1 counters',
    wrong: '"enters with -1/-1 counters" was not read',
    run({ table, card }) {
      const g = raffine(table); const me = g.players[0]; const m = card(g, me, 'Moonshadow', 'hand'); g.removeFrom(me.hand, m); g.enterBattlefield(m, me, { quiet: true });
      return { ok: m.p1 === -6, note: `counters ${m.p1}` };
    },
  },
  // ---------- attacks ----------
  {
    card: 'Raffine, Scheming Seer', title: 'whenever you attack, an attacker connives X (X = attackers): draw X, discard X, counters for nonland discards',
    wrong: '"whenever you attack" triggers did not exist, and connive only ever drew and discarded one',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.bf = me.bf.filter((c) => c.info.isLand); opp.bf = opp.bf.filter((c) => c.info.isLand); me.hand = [];
      const r = put(g, me, 'Raffine, Scheming Seer'); const a = put(g, me, 'Generous Pup'); const b = put(g, me, 'Psychic Frog');
      for (const c of [r, a, b]) c.sick = false;
      me.library.unshift(...['Snuff Out', 'Reprieve', 'Swamp'].map((n) => { const c = g.makeCard(n, me, false); c.zone = 'library'; return c; }));
      g.chooseDefender = () => opp; g.active = me.seat; g.phase = 'combat'; g._forcedAtk = { q: opp.seat, ids: [r.id, a.id, b.id] }; g.combat(me); g._forcedAtk = null;
      const counters = [r, a, b].reduce((s2, c) => s2 + Math.max(0, c.p1), 0);
      return { ok: me.cardsDrawn >= 3 && counters >= 2 && me.gy.length >= 3, note: `drew ${me.cardsDrawn}, counters ${counters}, graveyard ${me.gy.length}` };
    },
  },
  {
    card: 'Voice of Victory', title: 'mobilize 2: two 1/1 Warriors attack too, and are sacrificed at the end step',
    wrong: 'mobilize was not read',
    run({ table, put }) {
      const g = raffine(table); const [me, opp] = g.players; me.bf = me.bf.filter((c) => c.info.isLand); opp.bf = opp.bf.filter((c) => c.info.isLand);
      const v = put(g, me, 'Voice of Victory'); v.sick = false; const l0 = opp.life;
      g.chooseDefender = () => opp; g.active = me.seat; g.phase = 'combat'; g._forcedAtk = { q: opp.seat, ids: [v.id] }; g.combat(me); g._forcedAtk = null;
      const dealt = l0 - opp.life; g.restOfTurn(me, 'end');
      return { ok: dealt >= g.power(v) + 2 && !me.bf.some((c) => c.token && /Warrior/.test(c.info.name)), note: `damage ${dealt} (Voice ${g.power(v)}); warriors left ${me.bf.filter((c) => c.token).length}` };
    },
  },
  {
    card: 'Herald of Secret Streams', title: 'creatures with +1/+1 counters can\'t be blocked',
    wrong: 'its static was not read',
    run({ table, put }) {
      const g = raffine(table); const [me, opp] = g.players; put(g, me, 'Herald of Secret Streams'); const a = put(g, me, 'Generous Pup'); a.p1 = 1; const b = put(g, opp, 'Old Gnawbone');
      return { ok: !g.canBlock(b, a), note: `Gnawbone can block it: ${g.canBlock(b, a)}` };
    },
  },
  {
    card: 'Archfiend of Ifnir', title: 'a discard puts a -1/-1 counter on each opposing creature',
    wrong: 'its trigger was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; put(g, me, 'Archfiend of Ifnir'); const t = put(g, opp, 'Vampire Nighthawk'); const d = card(g, me, 'Swamp', 'hand');
      g.discardCard(me, d);
      return { ok: t.p1 === -1, note: `Nighthawk counters ${t.p1}` };
    },
  },
  // ---------- statics and the rest ----------
  {
    card: 'Thalia, Guardian of Thraben', title: 'noncreature spells cost {1} more, for every player',
    wrong: 'the tax was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; const dt = card(g, opp, 'Demonic Tutor', 'hand'); const pup = card(g, opp, 'Generous Pup', 'hand');
      const a = g.costFor(opp, dt, 'hand').mv; put(g, me, 'Thalia, Guardian of Thraben'); g.emit('effect', 'x');
      const b = g.costFor(opp, dt, 'hand').mv, c = g.costFor(opp, pup, 'hand').mv;
      return { ok: b === a + 1 && c === (pup.info.mv || 0), note: `Demonic Tutor ${a} -> ${b}; Generous Pup ${c}` };
    },
  },
  {
    card: 'Kinscaer Sentry', title: 'attacking, puts a creature with mana value up to the number of attackers into play attacking',
    wrong: 'its attack trigger was not read',
    run({ table, put, card }) {
      const g = raffine(table); const [me, opp] = g.players; me.bf = me.bf.filter((c) => c.info.isLand); opp.bf = opp.bf.filter((c) => c.info.isLand); me.hand = [];
      const k = put(g, me, 'Kinscaer Sentry'); const pup = put(g, me, 'Generous Pup'); for (const c of [k, pup]) c.sick = false; const fr = card(g, me, 'Psychic Frog', 'hand');
      g.chooseDefender = () => opp; g.active = me.seat; g.phase = 'combat'; g._forcedAtk = { q: opp.seat, ids: [k.id, pup.id] }; g.combat(me); g._forcedAtk = null;
      return { ok: fr.zone === 'bf', note: `Psychic Frog (mana value ${fr.info.mv}) in ${fr.zone}` };
    },
  },
  {
    card: 'Dark Matter Manipulator', title: 'gets +2/+0 for every seven cards in the graveyard',
    wrong: 'its static was not read',
    run({ table, put, card }) {
      const g = raffine(table); const me = g.players[0]; me.gy = []; const d = put(g, me, 'Dark Matter Manipulator'); const p0 = g.power(d);
      for (let i = 0; i < 14; i++) card(g, me, 'Swamp', 'gy'); g.emit('effect', 'x');
      return { ok: g.power(d) === p0 + 4, note: `power ${p0} -> ${g.power(d)}` };
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
