/* Pod Night — a heuristic four-player Commander game simulator.
 * It reads each card's real rules text and models the common effects
 * (mana, creatures and combat, removal, wipes, draw, ramp, tokens, drain,
 * counterspells, tutors, reanimation, planeswalkers). Anything it can't
 * model is still cast and sits on the battlefield, it just does nothing.
 */
(function (root) {
  'use strict';

  const COLORS = ['W', 'U', 'B', 'R', 'G'];
  const BASIC_TYPES = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
  const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, x: 'X' };
  const KEYWORDS = ['flying', 'reach', 'trample', 'deathtouch', 'lifelink', 'first strike', 'double strike', 'vigilance',
    'haste', 'menace', 'indestructible', 'hexproof', 'shroud', 'defender', 'protection'];

  function num(s) {
    if (s == null) return 1;
    s = String(s).toLowerCase();
    if (/^\d+$/.test(s)) return +s;
    return NUM[s] ?? 1;
  }

  // ---------- RNG ----------
  function rng(seed) {
    let a = seed >>> 0;
    const f = () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.int = (n) => Math.floor(f() * n);
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    f.shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
    return f;
  }

  // ---------- Card analysis ----------
  function parseCost(str) {
    const c = { generic: 0, pips: [], x: 0, mv: 0 };
    if (!str) return c;
    for (const tok of str.trim().split(/\s+/)) {
      if (/^\d+$/.test(tok)) { c.generic += +tok; c.mv += +tok; }
      else if (tok === 'X') c.x++;
      else if (tok === 'S') { c.generic++; c.mv++; }
      else if (tok === 'C') { c.pips.push({ opts: ['C'] }); c.mv++; }
      else if (COLORS.includes(tok)) { c.pips.push({ opts: [tok] }); c.mv++; }
      else if (tok.includes('/')) {
        const parts = tok.split('/');
        const cols = parts.filter((p) => COLORS.includes(p));
        const phy = parts.includes('P');
        const two = parts.includes('2');
        c.pips.push({ opts: cols, phy, two }); c.mv += two ? 2 : 1;
      }
    }
    return c;
  }

  function colorsOfCost(cost) {
    const s = new Set();
    cost.pips.forEach((p) => p.opts.forEach((o) => o !== 'C' && s.add(o)));
    return s;
  }

  const TYPE_WORDS = ['Legendary', 'Basic', 'Snow', 'World', 'Kindred', 'Tribal', 'Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Instant', 'Sorcery', 'Battle'];

  function cleanText(t, name) {
    let s = t.replace(/\([^)]*\)/g, '');
    if (name) {
      const short = name.split(',')[0];
      s = s.split(name).join('CARDNAME');
      if (short.length > 3) s = s.split(short).join('CARDNAME');
    }
    return s.replace(/\bthis (creature|artifact|enchantment|land|card|permanent|spell|token|equipment|aura)\b/gi, 'CARDNAME');
  }

  function findKeywords(text) {
    const out = new Set();
    const lower = text.toLowerCase();
    for (const k of KEYWORDS) if (new RegExp('\\b' + k + '\\b').test(lower)) out.add(k);
    return out;
  }

  // Parse effects from a fragment of rules text. Returns an array of effect objects.
  function parseEffects(raw) {
    const t = raw.replace(/\s+/g, ' ');
    const l = t.toLowerCase();
    const fx = [];
    let m;

    // counterspells
    if ((m = l.match(/counter target (noncreature |creature |instant or sorcery |enchantment, instant, or sorcery |artifact or enchantment |activated or triggered ability|)spell/)) || /counter target spell/.test(l)) {
      const f = (m && m[1].trim()) || '';
      fx.push({ k: 'counter', filter: f });
    }
    // wipes
    if (/(destroy|exile) all creatures|destroy all nonland permanents|exile all nonland permanents|all creatures get -\d+\/-\d+|each creature gets -x\/-x|destroy all artifacts, creatures, and enchantments|(destroy|exile) all (artifacts|enchantments)|choose one or more —/.test(l) && /creature|nonland/.test(l)) {
      if (/destroy all creatures with power 4 or greater/.test(l)) fx.push({ k: 'wipe', what: 'big' });
      else if (/each creature gets -x\/-x/.test(l)) fx.push({ k: 'wipe', what: 'minusX' });
      else if (/nonland permanents/.test(l)) fx.push({ k: 'wipe', what: 'nonland', exile: /exile all/.test(l) });
      else if (/choose one or more/.test(l) && /exile all/.test(l)) fx.push({ k: 'wipe', what: 'farewell', exile: true });
      else fx.push({ k: 'wipe', what: 'creatures', exile: /exile all/.test(l) });
    } else if ((m = l.match(/deals (\d+|x) damage to each creature/))) fx.push({ k: 'wipe', what: 'damage', n: num(m[1]) });
    if (/destroy all lands/.test(l)) fx.push({ k: 'wipe', what: 'lands' });
    if (/destroy all (plains|islands|swamps|mountains|forests)/.test(l)) fx.push({ k: 'wipe', what: 'lands' });
    if (/return all nonland permanents to their owners' hands|change "target" in its text to "each/.test(l)) fx.push({ k: 'massBounce' });

    // single-target removal
    if ((m = l.match(/(destroy|exile) (?:another |up to one |any number of )?target (nonland permanent|permanent|creature or planeswalker|creature or vehicle|artifact or enchantment|artifact, enchantment, or planeswalker|artifact|enchantment|planeswalker|nonblack creature|nonartifact creature|tapped creature|attacking creature|creature|nonland, nontoken permanent)/))) {
      let what = m[2];
      if (/nonland|^permanent/.test(what)) what = 'nonland';
      else if (/creature/.test(what)) what = /planeswalker/.test(what) ? 'creaturepw' : 'creature';
      else if (/artifact or enchantment|artifact, enchantment/.test(what)) what = 'artench';
      fx.push({ k: 'removal', what, exile: m[1] === 'exile' });
    } else if ((m = l.match(/return (?:up to one )?target (nonland permanent|creature|permanent)[^.]*? to (?:its|their) owner's hand/))) {
      fx.push({ k: 'removal', what: m[1] === 'creature' ? 'creature' : 'nonland', bounce: true });
    } else if (/target creature (?:an opponent controls )?gets -(\d+)\/-(\d+)/.test(l)) {
      fx.push({ k: 'removal', what: 'creature', shrink: +l.match(/gets -(\d+)\/-(\d+)/)[2] });
    } else if (/target (opponent|player) sacrifices a creature|each opponent sacrifices a creature/.test(l)) {
      fx.push({ k: 'edict' });
    } else if (/gain control of target (creature|nonland permanent|artifact)/.test(l)) {
      fx.push({ k: 'steal', what: /creature/.test(l.match(/gain control of target (\w+)/)[1]) ? 'creature' : 'nonland' });
    } else if (/enchanted creature can't attack or block/.test(l)) {
      fx.push({ k: 'pacify' });
    }

    // damage
    if ((m = l.match(/deals (\d+|x) damage to (any target|target creature or planeswalker|target creature|target player|target opponent|each opponent)/))) {
      fx.push({ k: 'damage', n: num(m[1]), to: m[2] });
    }
    if ((m = l.match(/each opponent loses (\d+|x) life/)) && !/repeat the following/.test(l)) fx.push({ k: 'drain', n: num(m[1]), gain: /you gain life equal to|gain that much life/.test(l) });
    if ((m = l.match(/target (?:player|opponent) loses (\d+) life/))) fx.push({ k: 'drainOne', n: num(m[1]) });
    if (/repeat the following process x times\. each opponent loses 3 life/.test(l)) fx.push({ k: 'hailfire' });
    if ((m = l.match(/you gain (\d+|x) life/)) && !/whenever you gain life/.test(l)) fx.push({ k: 'gain', n: num(m[1]) });

    // card advantage
    if ((m = l.match(/(?<!each player |each opponent |that player |target player |target opponent )draws? (a|an|one|two|three|four|five|seven|x|\d+) cards?/)) && !/each player draws/.test(l)) {
      fx.push({ k: 'draw', n: num(m[1]) });
    } else if (/each player (discards their hand(?:,)? then )?draws seven cards/.test(l)) fx.push({ k: 'wheel' });
    if ((m = l.match(/look at the top (\w+) cards of your library\. put (\w+) of them into your hand/))) fx.push({ k: 'draw', n: num(m[2]) });
    if ((m = l.match(/reveal the top (\w+) cards of your library\. put all (land|creature)/))) fx.push({ k: 'draw', n: Math.ceil(num(m[1]) / 3) });
    if (/exile the top card of your library\. (?:until end of turn|you may play)/.test(l)) fx.push({ k: 'draw', n: 1 });

    // tutors
    if (/search your library for an? (card|creature card|artifact or enchantment card|artifact card|enchantment card|instant or sorcery card)[^.]*?(put (?:it|that card) into your hand|put that card on top|reveal it, put it into your hand|put it on top)/.test(l)) {
      const what = (l.match(/search your library for an? (card|creature card|artifact or enchantment card|artifact card|enchantment card|instant or sorcery card)/) || [])[1] || 'card';
      fx.push({ k: 'tutor', what: what.replace(' card', '') });
    } else if (/search your library for (?:a|an) (?:green )?creature card with mana value x or less[^.]*?battlefield/.test(l) || /search your library for an? creature card[^.]*?put it onto the battlefield/.test(l)) {
      fx.push({ k: 'tutorBF' });
    }

    // ramp
    if ((m = l.match(/search your library for (up to )?(a|an|one|two|three|x|\d+) (?:basic land|land|basic|forest|plains|island|swamp|mountain|forest or plains|[a-z, ]+?land) cards?(?: and\/or [a-z ]+ cards?)?[^.]*?put (?:them|it|that card|those cards|one) onto the battlefield( tapped)?/))) {
      let bf = num(m[2]);
      let hand = 0;
      if (/put one onto the battlefield tapped and the other into your hand/.test(l)) { bf = 1; hand = 1; }
      if (bf === 'X') bf = 2;
      fx.push({ k: 'ramp', bf, hand, tapped: !!m[3] || /tapped/.test(l) });
    } else if ((m = l.match(/search your library for (up to )?(a|an|one|two|x|\d+) [^.]*?(?:land|forest|plains|island|swamp|mountain)[^.]*? cards?[^.]*?put (?:them|it|that card|those cards) onto the battlefield( tapped)?/))) {
      fx.push({ k: 'ramp', bf: num(m[2]) === 'X' ? 2 : num(m[2]), hand: 0, tapped: !!m[3] });
    } else if (/search your library for (?:a|an|up to \w+) basic land cards?[^.]*?into your hand/.test(l)) {
      fx.push({ k: 'ramp', bf: 0, hand: 1 });
    } else if ((m = l.match(/you may put (a|two|\w+) land cards? from your hand onto the battlefield/))) {
      fx.push({ k: 'ramp', bf: 1, hand: 0, fromHand: true });
    }
    if ((m = l.match(/add (\{[wubrgc]\})(\{[wubrgc]\})(\{[wubrgc]\})?/)) && !/\{t\}/.test(l)) {
      fx.push({ k: 'ritual', n: (m[3] ? 3 : 2), color: m[1][1].toUpperCase() });
    }

    // recursion
    if (/return (?:target |up to one target )?(creature card|permanent card|card) from your graveyard to your hand/.test(l)) fx.push({ k: 'regrow' });
    if ((m = l.match(/return (?:target |up to one target )?(?:[a-z]+ )?(?:creature |permanent |artifact )?card with mana value (\d+) or less from your graveyard to the battlefield/))) fx.push({ k: 'reanimate', any: false, mvMax: +m[1], perm: true });
    else if (/return (?:target |up to one target )?(creature|permanent|artifact|nonland permanent)? ?cards? from (?:your|a) graveyard to the battlefield|put target creature card from a graveyard onto the battlefield|return enchanted creature card to the battlefield|put (?:a|target) creature card from a graveyard onto the battlefield|return from your graveyard to the battlefield any number of target creature cards/.test(l)) {
      fx.push({ k: 'reanimate', any: /a graveyard|enchanted creature card/.test(l) });
    }
    if ((m = l.match(/return all (creature|permanent|land|artifact|enchantment) cards from your graveyard to (the battlefield|your hand)/))) fx.push({ k: 'massRegrow', what: m[1], bf: m[2] === 'the battlefield' });
    if (/reveal the top x cards of your library\. you may put any number of permanent cards with mana value x or less from among them onto the battlefield|reveal the top x cards of your library, where x is the greatest mana value of a commander/.test(l) || /reveal the top x cards of your library\. you may put any number of permanent cards with mana value x or less/.test(l)) fx.push({ k: 'genesis' });
    if (/sacrifices a creature/.test(l) && /that player sacrifices/.test(l)) fx.push({ k: 'edictThat' });

    // tokens
    const tokRe = /(?<!its controller |that player |target player |each opponent |opponent )creates? (a|an|one|two|three|four|five|six|x|\d+|that many|a number of) (tapped )?(?:(\d+|x)\/(\d+|x) )?([a-z ,-]*?)(creature )?tokens?(?: with ([^."]+))?/g;
    while ((m = tokRe.exec(l))) {
      const desc = m[5] || '';
      if (/treasure/.test(desc)) { fx.push({ k: 'treasure', n: num(m[1]) }); continue; }
      if (/food|clue|blood|map|gold|powerstone/.test(desc) && !m[6]) { if (/clue/.test(desc)) fx.push({ k: 'draw', n: 0 }); continue; }
      if (!m[6] && !m[3]) continue;
      if (/copy/.test(desc)) continue;
      let n = m[1] === 'that many' || m[1] === 'a number of' ? 'X' : num(m[1]);
      const p = m[3] === 'x' ? 'X' : +(m[3] ?? 1), tt = m[4] === 'x' ? 'X' : +(m[4] ?? 1);
      const words = desc.trim().split(/\s+/).filter(Boolean);
      const colors = words.filter((w) => ['white', 'blue', 'black', 'red', 'green', 'colorless', 'and'].includes(w.replace(/,/g, '')));
      const sub = words.filter((w) => !colors.includes(w) && !['artifact', 'enchantment', 'legendary'].includes(w)).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
      fx.push({ k: 'tokens', n, p, t: tt, sub: sub || 'Token', colors: colors.join(' '), kw: [...findKeywords(m[7] || '')], tapped: !!m[2] });
    }
    if (/create x 1\/1 red goblin creature tokens, where x is the number of goblins you control/.test(l)) {
      const last = fx.filter((f) => f.k === 'tokens').pop(); if (last) last.nRef = 'Goblin';
    }

    // counters, pump
    if ((m = l.match(/put (a|an|one|two|three|four|x|\d+) \+1\/\+1 counters? on (each (?:other )?(?:creature|[a-z]+) you control|target creature(?: you control)?|up to one target creature|cardname|it|each of up to)/))) {
      const on = /each/.test(m[2]) ? 'each' : /target/.test(m[2]) ? 'target' : 'self';
      const subM = m[2].match(/each (?:other )?([a-z]+) you control/);
      fx.push({ k: 'counters', n: num(m[1]), on, sub: subM && subM[1] !== 'creature' ? cap(subM[1].replace(/s$/, '')) : null });
    }
    if (/\bproliferate\b/.test(l)) fx.push({ k: 'proliferate' });
    if ((m = l.match(/creatures you control (?:gain trample and )?get \+(\d+|x)\/\+(\d+|x)(?: and gain ([a-z ,]+?))? until end of turn/))) {
      fx.push({ k: 'overrun', p: m[1] === 'x' ? 'X' : +m[1], t: m[2] === 'x' ? 'X' : +m[2], kw: /trample/.test(l) ? ['trample'] : [] });
    }
    // protection
    if (/permanents you control gain hexproof and indestructible|creatures you control gain indestructible|creatures you control gain hexproof and indestructible|you gain protection from everything|permanents you control phase out|all permanents you control phase out/.test(l)) {
      fx.push({ k: 'protect' });
    }
    if (/extra turn/.test(l) && /take an extra turn/.test(l)) fx.push({ k: 'extraTurn' });
    if (/each opponent discards|target player discards|target opponent discards/.test(l)) fx.push({ k: 'discard' });
    return fx;
  }

  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  function analyzeFace(face, deckColors) {
    const a = { name: face.name, face };
    const typeWords = face.types.split(/\s+/);
    a.types = new Set(typeWords.filter((w) => TYPE_WORDS.includes(w)));
    a.subtypes = typeWords.filter((w) => !TYPE_WORDS.includes(w));
    a.isLand = a.types.has('Land');
    a.isCreature = a.types.has('Creature');
    a.isPW = a.types.has('Planeswalker');
    a.isInstant = a.types.has('Instant');
    a.isSorcery = a.types.has('Sorcery');
    a.isPermanent = !a.isInstant && !a.isSorcery;
    a.isLegendary = a.types.has('Legendary');
    a.cost = parseCost(face.cost);
    a.mv = a.cost.mv;
    a.colors = colorsOfCost(a.cost);
    if (face.colors) face.colors.split(',').forEach((c) => { const k = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[c.trim()]; if (k) a.colors.add(k); });
    if (face.pt) { const [p, t] = face.pt.split('/'); a.power = parseInt(p) || 0; a.toughness = parseInt(t) || 0; a.ptStar = /\*/.test(face.pt); }
    a.loyalty = face.loyalty || 0;
    a.kw = new Set();
    a.equip = null; a.overload = null;
    for (const k of face.kw) {
      const [name, arg] = k.split(':');
      const low = name.toLowerCase();
      if (KEYWORDS.includes(low)) a.kw.add(low);
      if (low === 'equip') a.equip = parseCost(arg);
      if (low === 'overload') a.overload = parseCost(arg);
      if (low.startsWith('protection')) a.kw.add('protection');
    }
    const text = cleanText(face.oracle || '', face.name);
    a.text = text;
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    a.etb = []; a.dies = []; a.attack = []; a.combatDmg = []; a.upkeep = []; a.endstep = []; a.castTrig = [];
    a.deathWatch = []; a.statics = []; a.activated = []; a.loyaltyAbs = []; a.spell = []; a.triggers = [];
    a.unmodeled = [];
    for (const line of lines) {
      const low = line.toLowerCase();
      let m;
      if ((m = line.match(/^\[([+\-−]?\d+|[+\-−]?X)\]:\s*(.*)$/))) {
        const d = m[1].replace('−', '-');
        a.loyaltyAbs.push({ delta: /X/.test(d) ? -99 : parseInt(d), fx: parseEffects(m[2]), text: m[2] });
        continue;
      }
      if (a.isInstant || a.isSorcery) {
        if (/^(you may pay|if you control a commander, you may cast|you may exile a)/.test(low) && /rather than pay|without paying its mana cost/.test(low)) { a.freeAlt = true; continue; }
        if (/^overload/.test(low) || /^cycling/.test(low) || /^kicker/.test(low) || /^flashback/.test(low)) continue;
        a.spell.push(...parseEffects(line));
        continue;
      }
      if ((m = low.match(/^when(?:ever)? cardname (?:enters|enters the battlefield|is turned face up)(?: or attacks)?[^,]*,\s*(.*)$/)) || (m = low.match(/^when(?:ever)? cardname enters or [^,]*,\s*(.*)$/))) {
        a.etb.push(...parseEffects(m[1]));
        if (/or attacks/.test(low)) a.attack.push(...parseEffects(m[1]));
        if (/imprint/.test(low)) a.imprint = true;
        continue;
      }
      if ((m = low.match(/^when(?:ever)? cardname dies,\s*(.*)$/))) { a.dies.push(...parseEffects(m[1])); continue; }
      if ((m = low.match(/^whenever cardname attacks( an opponent)?,?\s*(.*)$/))) {
        if (/put an? ([a-z, ]+?) creature card from your hand onto the battlefield tapped and attacking/.test(low)) {
          const subs = low.match(/put an? ([a-z, ]+?) creature card/)[1].replace(/ or /g, ',').split(',').map((s) => cap(s.trim())).filter(Boolean);
          a.attack.push({ k: 'cheatAttack', subs });
        } else a.attack.push(...parseEffects(m[2]));
        continue;
      }
      if ((m = low.match(/^whenever (?:cardname|equipped creature|enchanted creature|a creature you control) deals combat damage to (?:a player|an opponent),?\s*(.*)$/))) {
        a.combatDmg.push(...parseEffects(m[1])); if (/^whenever equipped/.test(low)) a.equipCombat = true; continue;
      }
      if ((m = low.match(/^at the beginning of (your|each) upkeep,\s*(.*)$/))) { a.upkeep.push({ each: m[1] === 'each', fx: parseEffects(m[2]), lose: +((m[2].match(/you lose (\d+) life/) || [])[1] || 0) }); continue; }
      if ((m = low.match(/^at the beginning of (your|each) end step,\s*(.*)$/))) { a.endstep.push({ each: m[1] === 'each', fx: parseEffects(m[2]) }); continue; }
      if ((m = low.match(/^(?:eminence — )?whenever you cast (?:a|an|another) ([a-z, ]+?) spell,\s*(.*)$/))) {
        a.castTrig.push({ filter: m[1], another: /another/.test(low), fx: parseEffects(m[2]), eminence: /command zone/.test(low) }); continue;
      }
      if ((m = low.match(/^whenever (cardname or another creature|another creature|a creature|a creature you control|another creature you control|a nontoken creature you control|another nontoken creature you control|a creature an opponent controls|cardname or another creature you control|a creature you don't control) dies,\s*(.*)$/))) {
        const scope = /opponent controls|don't control/.test(m[1]) ? 'opp' : /you control/.test(m[1]) ? 'mine' : 'any';
        a.deathWatch.push({ scope, nontoken: /nontoken/.test(m[1]), fx: parseEffects(m[2]) }); continue;
      }
      if (/^whenever you gain life, (?:target|each) opponent loses that much life/.test(low)) { a.triggers.push({ k: 'bond' }); continue; }
      if (/^whenever an opponent loses life, you gain that much life/.test(low)) { a.triggers.push({ k: 'exquisite' }); continue; }
      if (/^whenever an opponent casts a spell, you may draw a card unless that player pays \{1\}/.test(low)) { a.triggers.push({ k: 'rhystic' }); continue; }
      if (/^whenever an opponent draws a card, that player may pay \{2\}/.test(low)) { a.triggers.push({ k: 'tithe' }); continue; }
      if (/^whenever an opponent casts their first noncreature spell each turn, draw a card unless/.test(low) || /^whenever an opponent casts a noncreature spell, .* draw a card/.test(low)) { a.triggers.push({ k: 'sentinel' }); continue; }
      if (/^whenever you gain life, /.test(low)) { a.triggers.push({ k: 'onGain', fx: parseEffects(low.replace(/^whenever you gain life, /, '')) }); continue; }
      if (/^(?:a|another|other|each) ?creature(?:s)? (?:you control )?(?:enters|enter)/.test(low)) continue;
      if (/creatures? you control (?:enter|enters) tapped|your opponents can't cast spells during your turn/.test(low)) {
        if (/your opponents can't cast spells during your turn/.test(low)) a.statics.push({ k: 'abolisher' });
        continue;
      }
      if (/during each of your turns, you may play a land and cast a permanent spell of each permanent type from your graveyard/.test(low)) { a.statics.push({ k: 'muldrotha' }); continue; }
      if (/^if an effect would create one or more tokens under your control, it creates twice that many/.test(low)) { a.statics.push({ k: 'tokenDouble' }); if (/counters/.test(text.toLowerCase())) a.statics.push({ k: 'counterDouble' }); continue; }
      if (/^if one or more tokens would be created under your control, (twice that many|those tokens plus)/.test(low)) { a.statics.push({ k: 'tokenDouble' }); continue; }
      if (/^if one or more \+1\/\+1 counters would be put on a creature you control, that many plus one/.test(low) || /^if an effect would put one or more counters on a permanent you control, it puts twice that many/.test(low)) { a.statics.push({ k: 'counterDouble' }); continue; }
      if (/^other permanents you control have indestructible/.test(low)) { a.statics.push({ k: 'allIndestructible' }); continue; }
      if (/^artifacts you control have indestructible/.test(low)) { a.statics.push({ k: 'artIndestructible' }); continue; }
      if (/^other permanents you control have hexproof/.test(low)) { a.statics.push({ k: 'allHexproof' }); continue; }
      if (/^you can't lose the game and your opponents can't win the game/.test(low)) { a.statics.push({ k: 'platinum' }); continue; }
      if (/isn't a creature/.test(low) && /devotion/.test(low)) { a.godDevotion = true; continue; }
      if (/^if one or more tokens would be created under your control, those tokens plus that many 1\/1 green squirrel/.test(low)) { a.statics.push({ k: 'chatterfang' }); continue; }
      if ((m = low.match(/^whenever you draw a card, you gain (\d+) life/))) { a.triggers.push({ k: 'drawGain', n: +m[1] }); continue; }
      if ((m = low.match(/^whenever an opponent draws a card, (?:they|that player) loses? (\d+) life/))) { a.triggers.push({ k: 'oppDrawLose', n: +m[1] }); continue; }
      if (/^whenever another nontoken creature you control dies, you may exile it\. if you do, create a token that's a copy of that card, except it's an enchantment/.test(low)) { a.triggers.push({ k: 'myrkul' }); continue; }
      if ((m = low.match(/^at the beginning of each opponent's upkeep,\s*(.*)$/))) { a.upkeep.push({ opp: true, fx: parseEffects(m[1]), lose: 0 }); continue; }
      if (/you have no maximum hand size/.test(low)) { a.statics.push({ k: 'noMaxHand' }); continue; }
      if (/you may play an additional land on each of your turns|you may play two additional lands/.test(low)) { a.statics.push({ k: 'extraLand', n: /two additional/.test(low) ? 2 : 1 }); continue; }
      if (/^skip your draw step/.test(low)) { a.statics.push({ k: 'necro' }); continue; }
      if (/^you may look at the top card of your library any time/.test(low)) continue;
      if ((m = low.match(/^(other )?([a-z]+?s?) (?:creatures )?you control get \+(\d+)\/\+(\d+)(?: and have ([a-z ,]+))?\.?$/))) {
        const sub = m[2] === 'creature' || m[2] === 'creatures' ? null : cap(m[2].replace(/s$/, ''));
        a.statics.push({ k: 'anthem', other: !!m[1], sub, p: +m[3], t: +m[4], kw: [...findKeywords(m[5] || '')] }); continue;
      }
      if ((m = low.match(/^creatures your opponents control get -(\d+)\/-(\d+)/))) { a.statics.push({ k: 'debuff', p: +m[1], t: +m[2] }); continue; }
      if ((m = low.match(/^(other )?creatures you control have ([a-z ,]+)\.?$/))) { a.statics.push({ k: 'anthem', other: !!m[1], p: 0, t: 0, kw: [...findKeywords(m[2])] }); continue; }
      if ((m = low.match(/^equipped creature gets ([+-]\d+)\/([+-]\d+)(?: and has ([a-z ,]+))?/)) || (m = low.match(/^equipped creature has ([a-z ,]+)/))) {
        if (m.length === 2) a.statics.push({ k: 'equipBuff', p: 0, t: 0, kw: [...findKeywords(m[1])] });
        else a.statics.push({ k: 'equipBuff', p: +m[1], t: +m[2], kw: [...findKeywords(m[3] || '')] });
        continue;
      }
      if ((m = low.match(/^enchanted creature gets ([+-]\d+)\/([+-]\d+)(?: and has ([a-z ,]+))?/))) { a.statics.push({ k: 'auraBuff', p: +m[1], t: +m[2], kw: [...findKeywords(m[3] || '')] }); continue; }
      if (/^enchanted creature can't attack or block/.test(low)) { a.statics.push({ k: 'pacify' }); continue; }
      if (/^equipped creature has protection from/.test(low)) { a.statics.push({ k: 'equipBuff', p: 0, t: 0, kw: ['protection'] }); continue; }
      if (/^as long as your life total is less than or equal to half your starting life total, cardname has indestructible/.test(low)) { a.statics.push({ k: 'myrkul' }); continue; }
      if (/can't be blocked/.test(low) && /^cardname can't be blocked/.test(low)) { a.kw.add('unblockable'); continue; }
      if (/^(?:flying|reach|trample|deathtouch|lifelink|vigilance|haste|menace|first strike|double strike|indestructible|hexproof|shroud|defender|flash)[a-z ,]*$/.test(low)) { findKeywords(low).forEach((k) => a.kw.add(k)); continue; }
      // activated abilities: "{cost}: effect"
      if ((m = line.match(/^((?:\{[^}]+\}|,|\s|Sacrifice [^:]+|Pay \d+ life|Tap [^:]+|Exile [^:]+|Discard [^:]+|Remove [^:]+)+):\s*(.*)$/))) {
        const costText = m[1];
        if (/Add \{/.test(m[2])) continue; // mana ability, handled separately
        const fx = parseEffects(m[2]);
        if (fx.length) {
          const mana = costText.match(/\{(\d+|[WUBRGCX])\}/g) || [];
          const cost = parseCost(mana.map((x) => x.slice(1, -1)).join(' ').replace(/\bX\b/g, ''));
          a.activated.push({ tap: /\{T\}/.test(costText), sac: /Sacrifice CARDNAME/i.test(costText), sacOther: /Sacrifice (a|an|another) /i.test(costText) && !/CARDNAME/.test(costText), cost, fx, life: +(costText.match(/Pay (\d+) life/) || [])[1] || 0, text: m[2], sorcery: /activate only as a sorcery/i.test(line) });
        }
        continue;
      }
      if (/^(equip|enchant|cycling|madness|convoke|ward|dash|flash|kicker|ninjutsu|cascade|storm|affinity|improvise|delve|undying|persist|partner|eminence|morph|escape|unearth|flashback|channel|buyback|mutate|encore|blitz|evoke)\b/.test(low)) {
        if (/^ward/.test(low)) a.kw.add('ward');
        if (/^undying|^persist/.test(low)) a.kw.add('undying');
        if (/^flash$/.test(low)) a.kw.add('flash');
        if (/^channel/.test(low)) continue;
        continue;
      }
      // permanent with a "spell-like" ETB written in other ways (sagas, etc.)
      const fx = parseEffects(line);
      if (/^(i|ii|iii|iv)\b/.test(low) || /^[iv, ]+ —/.test(low)) { if (!/gains "/.test(low)) a.etb.push(...fx); continue; }
      if (fx.length && a.isPermanent && /^(?:when|whenever|at the beginning)/.test(low) === false) a.statics.push({ k: 'misc' });
      else if (!fx.length) a.unmodeled.push(line);
    }
    // aura reanimation (Animate Dead / Necromancy) shows up in ETB effects
    if (/Aura/.test(face.types) && a.etb.some((f) => f.k === 'reanimate')) a.reanimAura = true;
    if (/Aura/.test(face.types)) a.isAura = true;
    if (a.godDevotion) a.isCreature = false;
    if (/Equipment/.test(face.types)) a.isEquipment = true;

    // Mana production
    a.mana = null;
    const opts = [];
    let oneShot = false;
    for (const m of face.mana) {
      const cost = (m.cost || '').trim();
      if (!/^T\b/.test(cost) && cost !== 'T') continue;
      const extraGeneric = 0;
      if (/Sac<1\/CARDNAME>/.test(cost)) oneShot = true;
      else if (cost !== 'T' && !/^T( |$)/.test(cost)) continue;
      if (/Sac<1\/(?!CARDNAME)/.test(cost)) continue;
      let colors;
      const p = m.produced;
      if (p === 'Any' || /^Combo Any/.test(p)) colors = COLORS.slice();
      else if (/ColorIdentity/.test(p)) colors = deckColors.slice();
      else if (p.startsWith('Combo')) colors = p.replace('Combo', '').trim().split(/\s+/);
      else colors = p.trim().split(/\s+/);
      const multiDistinct = !p.startsWith('Combo') && p !== 'Any' && !/ColorIdentity/.test(p) && colors.length > 1;
      let amount = m.amount || 1;
      if (multiDistinct) amount = colors.length;
      const dmg = +(((face.oracle || '').match(/deals (\d+) damage to you/) || [])[1] || 0);
      const dmgApplies = dmg && !(face.mana.length > 1 && colors.length === 1 && colors[0] === 'C');
      const payLife = +((cost.match(/PayLife<(\d+)>/) || [])[1] || 0);
      opts.push({ colors: [...new Set(colors)], amount, dmg: (dmgApplies ? dmg : 0) + payLife, extraGeneric });
    }
    const otext = (face.oracle || '');
    if (/Add \{G\} for each creature you control/.test(otext)) a.cradle = true;
    if (/Add \{B\} for each Swamp you control/.test(otext)) { a.coffers = true; opts.length = 0; opts.push({ colors: ['B'], amount: 1, dmg: 0 }); }
    if (a.name === 'Chrome Mox' || a.name === 'Mox Diamond') opts.push({ colors: deckColors.slice(), amount: 1, dmg: 0 });
    if (a.name === "Urza's Saga") opts.push({ colors: ['C'], amount: 1, dmg: 0 });
    if (a.isLand && !opts.length) {
      const basic = a.subtypes.map((s) => BASIC_TYPES[s]).filter(Boolean);
      if (basic.length) opts.push({ colors: basic, amount: 1, dmg: 0 });
    }
    if (opts.length) a.mana = { opts, oneShot, dork: a.isCreature };
    if (a.isLand) {
      const lo = otext.toLowerCase();
      a.etbTapped = /enters tapped|enters the battlefield tapped/.test(lo) && !/unless|if you don't/.test(lo);
      a.shock = /you may pay 2 life\. if you don't, it enters tapped/.test(lo) || /you may pay 3 life\. if you don't, it enters tapped/.test(lo);
      const fm = lo.match(/sacrifice cardname: search your library for an? ([a-z ]+?) card/) || lo.match(/sacrifice [a-z' ]+: search your library for an? ([a-z ]+?) card/);
      if (fm && !opts.length) {
        a.fetch = { types: fm[1].split(/ or /).map((s) => s.trim()), tapped: /onto the battlefield tapped/.test(lo) };
      }
      if (/return a land you control to its owner's hand/.test(lo)) a.bounceLand = true;
    }
    return a;
  }

  function analyzeCard(data, deckColors) {
    const faces = data.faces.map((f) => analyzeFace(f, deckColors));
    const front = faces[0];
    front.faces = faces;
    front.mdfcLand = data.alt === 'Modal' && faces[1] && faces[1].isLand && !front.isLand ? faces[1] : null;
    front.flipFace = data.alt === 'DoubleFaced' ? faces[1] : null;
    return front;
  }

  function deckColorIdentity(data) {
    const s = new Set();
    for (const f of data.faces) {
      colorsOfCost(parseCost(f.cost)).forEach((c) => s.add(c));
      for (const m of (f.oracle || '').matchAll(/\{([WUBRG])(?:\/[WUBRGP])?\}/g)) s.add(m[1]);
    }
    return COLORS.filter((c) => s.has(c));
  }

  // ---------- Game ----------
  class Game {
    constructor(decks, db, seed, opts = {}) {
      this.db = db;
      this.seed = seed;
      this.R = rng(seed);
      this.record = opts.record !== false;
      this.events = [];
      this.nextId = 1;
      this.cards = {}; // id -> card object
      this.turn = 0;
      this.round = 0;
      this.maxRounds = opts.maxRounds || 30;
      this.players = decks.map((d, i) => this.makePlayer(d, i));
      this.active = 0;
      this.winner = null;
      this.over = false;
      this.focus = [];
    }

    makePlayer(deck, seat) {
      const cmdData = this.db[deck.commander];
      const colors = deckColorIdentity(cmdData);
      const p = {
        seat, name: deck.name || deck.commander, deckId: deck.id, colors, life: 40, poison: 0,
        library: [], hand: [], gy: [], exile: [], bf: [], command: [], cmdDmg: {}, tax: 0, lost: false,
        landsPlayed: 0, cardsDrawn: 0, protectedUntil: -1, necroBank: 0, gyCastTypes: new Set(), lostReason: null,
      };
      p.commanderCard = this.makeCard(deck.commander, p, true);
      p.command.push(p.commanderCard);
      for (const c of deck.cards) {
        if (!this.db[c.name]) continue;
        for (let i = 0; i < c.qty; i++) p.library.push(this.makeCard(c.name, p, false));
      }
      return p;
    }

    makeCard(name, owner, isCommander) {
      const info = this.analysisCache(name, owner.colors);
      const c = { id: this.nextId++, name, info, owner: owner.seat, ctrl: owner.seat, isCommander, token: false, tapped: false, sick: true, p1: 0, loyalty: 0, dmg: 0, dt: false, attached: null, eot: { p: 0, t: 0, kw: [] }, zone: 'library' };
      this.cards[c.id] = c;
      return c;
    }

    analysisCache(name, colors) {
      this._ac = this._ac || {};
      const key = name + '|' + colors.join('');
      if (!this._ac[key]) this._ac[key] = analyzeCard(this.db[name], colors);
      return this._ac[key];
    }

    makeToken(owner, spec) {
      spec = { sub: 'Token', p: 1, t: 1, ...spec };
      const info = {
        name: `${spec.sub} token`, types: new Set(['Creature']), subtypes: spec.sub.split(' '), isCreature: true, isPermanent: true,
        power: spec.p, toughness: spec.t, kw: new Set(spec.kw || []), cost: parseCost(''), mv: 0, colors: new Set(),
        etb: [], dies: spec.dies || [], attack: [], combatDmg: [], upkeep: [], endstep: [], castTrig: [], deathWatch: [], statics: [], activated: [], loyaltyAbs: [], spell: [], triggers: [], unmodeled: [],
        text: spec.text || `${spec.p}/${spec.t} ${spec.colors || ''} ${spec.sub} creature token${spec.kw && spec.kw.length ? ' with ' + spec.kw.join(', ') : ''}.`,
        tokenColors: spec.colors || '',
      };
      if (spec.treasure) {
        Object.assign(info, { name: 'Treasure', types: new Set(['Artifact']), subtypes: ['Treasure'], isCreature: false, power: undefined, toughness: undefined, text: '{T}, Sacrifice this artifact: Add one mana of any color.', mana: { opts: [{ colors: COLORS.slice(), amount: 1, dmg: 0 }], oneShot: true } });
      }
      const c = { id: this.nextId++, name: info.name, info, owner: owner.seat, ctrl: owner.seat, isCommander: false, token: true, tapped: !!spec.tapped, sick: true, p1: 0, loyalty: 0, dmg: 0, dt: false, attached: null, eot: { p: 0, t: 0, kw: [] }, zone: 'bf' };
      this.cards[c.id] = c;
      return c;
    }

    // ----- helpers -----
    P(i) { return this.players[i]; }
    alive() { return this.players.filter((p) => !p.lost); }
    opps(p) { return this.players.filter((q) => q !== p && !q.lost); }
    allBf() { return this.players.flatMap((p) => p.bf); }
    statics(p, k) { return p.bf.flatMap((c) => (c.info.statics || []).filter((s) => s.k === k).map((s) => ({ s, c }))); }
    has(p, k) { return this.statics(p, k).length > 0; }

    hasKw(c, k) { return this.kws(c).has(k); }
    kws(c) {
      const s = new Set(c.info.kw);
      c.eot.kw.forEach((k) => s.add(k));
      const ctrl = this.P(c.ctrl);
      for (const { s: st, c: src } of this.statics(ctrl, 'anthem')) {
        if (st.other && src === c) continue;
        if (st.sub && !(c.info.subtypes || []).includes(st.sub)) continue;
        st.kw.forEach((k) => s.add(k));
      }
      for (const eq of ctrl.bf) if (eq.attached === c.id) for (const st of eq.info.statics) if (st.k === 'equipBuff' || st.k === 'auraBuff') st.kw.forEach((k) => s.add(k));
      if (c.indestructibleEOT) s.add('indestructible');
      if (this.statics(ctrl, 'allIndestructible').some(({ c: src }) => src !== c)) s.add('indestructible');
      if (c.info.types.has('Artifact') && this.has(ctrl, 'artIndestructible')) s.add('indestructible');
      if (this.statics(ctrl, 'allHexproof').some(({ c: src }) => src !== c)) s.add('hexproof');
      if (c.hexproofEOT) s.add('hexproof');
      if (c.info.statics.some((x) => x.k === 'myrkul') && ctrl.life <= 20) s.add('indestructible');
      return s;
    }
    power(c) { return this.pt(c)[0]; }
    toughness(c) { return this.pt(c)[1]; }
    pt(c) {
      let p = c.info.power ?? 0, t = c.info.toughness ?? 0;
      if (c.info.ptStar) { const n = this.P(c.ctrl).bf.filter((x) => x.info.isCreature).length; p = Math.max(p, Math.min(n, 8)); t = Math.max(t, Math.min(n, 8)); }
      if (c.info.name === 'Construct token' || /Construct/.test(c.info.name)) { const n = this.P(c.ctrl).bf.filter((x) => x.info.types.has('Artifact')).length; p += n; t += n; }
      p += c.p1 + c.eot.p; t += c.p1 + c.eot.t;
      const ctrl = this.P(c.ctrl);
      for (const { s, c: src } of this.statics(ctrl, 'anthem')) {
        if (s.other && src === c) continue;
        if (s.sub && !(c.info.subtypes || []).includes(s.sub)) continue;
        p += s.p; t += s.t;
      }
      for (const q of this.opps(ctrl)) for (const { s } of this.statics(q, 'debuff')) { p -= s.p; t -= s.t; }
      for (const pl of this.players) for (const eq of pl.bf) if (eq.attached === c.id) for (const st of eq.info.statics) if (st.k === 'equipBuff' || st.k === 'auraBuff') { p += st.p; t += st.t; }
      return [p, t];
    }
    pacified(c) { return this.allBf().some((a) => a.attached === c.id && a.info.statics.some((s) => s.k === 'pacify')); }

    emit(kind, text, extra = {}) {
      if (!this.record) return;
      const ev = { kind, text, seat: extra.seat ?? null, cards: extra.cards || [], turn: this.round, active: this.active, phase: this.phase || '' };
      ev.snap = this.snapshot(extra);
      this.events.push(ev);
    }

    snapshot(extra) {
      return {
        players: this.players.map((p) => ({
          life: p.life, poison: p.poison, lost: p.lost, lostReason: p.lostReason, tax: p.tax,
          hand: p.hand.map((c) => c.id), lib: p.library.length, gy: p.gy.map((c) => c.id), exile: p.exile.length,
          command: p.command.map((c) => c.id), cmdDmg: { ...p.cmdDmg },
          bf: p.bf.map((c) => {
            const [pw, tg] = c.info.isCreature ? this.pt(c) : [null, null];
            return { id: c.id, tp: c.tapped ? 1 : 0, p: pw, t: tg, l: c.info.isPW ? c.loyalty : null, ctr: c.p1, at: c.attached, sk: c.sick && c.info.isCreature ? 1 : 0, dm: c.dmg };
          }),
        })),
        attackers: extra.attackers || null,
        blockers: extra.blockers || null,
        target: extra.target ?? null,
      };
    }

    cardMeta(c) {
      const i = c.info;
      return {
        id: c.id, name: i.name, token: c.token, cmd: c.isCommander, cost: i.face ? i.face.cost : '', types: i.face ? i.face.types : [...i.types].join(' ') + ' — ' + (i.subtypes || []).join(' '),
        text: i.face ? i.face.oracle : i.text, pt: i.face ? i.face.pt : (i.power != null ? `${i.power}/${i.toughness}` : null),
        colors: i.face ? [...i.colors] : (i.tokenColors || ''), land: !!i.isLand, creature: !!i.isCreature, pw: !!i.isPW,
        art: i.types.has('Artifact'), ench: i.types.has('Enchantment'), owner: c.owner,
      };
    }

    // ----- zones -----
    draw(p, n = 1, why) {
      for (let i = 0; i < n; i++) {
        if (!p.library.length) { this.lose(p, 'tried to draw from an empty library'); return; }
        const c = p.library.shift(); c.zone = 'hand'; p.hand.push(c); p.cardsDrawn++;
        if (this.started) this.onDraw(p);
      }
      if (this._drawPain) { this._drawPain = false; this.checkState(); }
      if (why) this.emit('draw', `${p.name} draws ${n} card${n > 1 ? 's' : ''}${why ? ' (' + why + ')' : ''}.`, { seat: p.seat });
    }

    onDraw(p) {
      for (const c of p.bf) for (const t of c.info.triggers) if (t.k === 'drawGain') this.gainLife(p, t.n, c);
      for (const q of this.opps(p)) for (const c of q.bf) for (const t of c.info.triggers) if (t.k === 'oppDrawLose') { this.loseLife(p, t.n, c); this._drawPain = true; }
      if (this.inDrawStep && p.seat === this.active) return; // Smothering Tithe only matters on extra draws in practice
      for (const q of this.opps(p)) for (const c of q.bf) for (const t of c.info.triggers) if (t.k === 'tithe') {
        if (this.availableMana(p) >= 2 && this.R() < 0.5) continue;
        this.addToken(q, { treasure: true }, 1, true);
      }
    }

    moveToGraveyard(c, how = 'dies') {
      const ctrl = this.P(c.ctrl), owner = this.P(c.owner);
      this.leaveBattlefield(c);
      if (c.token) return;
      if (c.isCommander) { c.zone = 'command'; owner.command.push(c); this.emit('move', `${c.info.name} returns to the command zone.`, { seat: owner.seat, cards: [c.id] }); return; }
      c.zone = 'gy'; owner.gy.push(c);
    }

    leaveBattlefield(c) {
      const ctrl = this.P(c.ctrl);
      const i = ctrl.bf.indexOf(c); if (i >= 0) ctrl.bf.splice(i, 1);
      // drop attachments
      for (const pl of this.players) for (const a of [...pl.bf]) {
        if (a.attached === c.id) {
          if (a.info.isAura) { this.destroy(a, 'falls off'); } else a.attached = null;
        }
      }
      if (c.attached && c.info.reanimAura) {
        const tgt = this.cards[c.attached]; if (tgt && tgt.zone === 'bf') this.destroy(tgt, 'sacrificed', true);
      }
      c.attached = null; c.tapped = false; c.p1 = 0; c.dmg = 0; c.dt = false; c.eot = { p: 0, t: 0, kw: [] }; c.ctrl = c.owner; c.loyalty = 0; c.indestructibleEOT = false; c.hexproofEOT = false;
    }

    destroy(c, why = 'destroyed', force = false) {
      if (c.zone !== 'bf') return false;
      if (!force && this.hasKw(c, 'indestructible')) return false;
      const ctrl = this.P(c.ctrl);
      const wasCreature = c.info.isCreature;
      const undying = this.hasKw(c, 'undying') && c.p1 === 0 && !c.token;
      this.moveToGraveyard(c);
      if (wasCreature) this.onDeath(c, ctrl);
      if (undying && c.zone === 'gy') { this.removeFrom(this.P(c.owner).gy, c); this.enterBattlefield(c, this.P(c.owner), { quiet: true }); c.p1 = 1; }
      return true;
    }

    exileCard(c) {
      if (c.zone !== 'bf') return;
      const owner = this.P(c.owner);
      this.leaveBattlefield(c);
      if (c.token) return;
      if (c.isCommander) { c.zone = 'command'; owner.command.push(c); return; }
      c.zone = 'exile'; owner.exile.push(c);
    }

    bounce(c) {
      if (c.zone !== 'bf') return;
      const owner = this.P(c.owner);
      this.leaveBattlefield(c);
      if (c.token) return;
      if (c.isCommander) { c.zone = 'command'; owner.command.push(c); return; }
      c.zone = 'hand'; owner.hand.push(c);
    }

    removeFrom(arr, c) { const i = arr.indexOf(c); if (i >= 0) arr.splice(i, 1); }

    onDeath(c, ctrl) {
      if (!c.token && !c.isCommander && c.zone === 'gy' && ctrl.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul'))) {
        this.removeFrom(this.P(c.owner).gy, c); c.zone = 'exile'; this.P(c.owner).exile.push(c);
        const info = Object.assign(Object.create(Object.getPrototypeOf(c.info)), c.info, { isCreature: false, types: new Set(['Enchantment']), name: c.info.name, power: undefined, toughness: undefined });
        const t = { id: this.nextId++, name: c.info.name, info, owner: ctrl.seat, ctrl: ctrl.seat, isCommander: false, token: true, tapped: false, sick: false, p1: 0, loyalty: 0, dmg: 0, dt: false, attached: null, eot: { p: 0, t: 0, kw: [] }, zone: 'bf', ench: true };
        this.cards[t.id] = t; ctrl.bf.push(t);
        this.emit('trigger', `Myrkul turns ${c.info.name} into an enchantment token copy.`, { seat: ctrl.seat, cards: [t.id] });
      }
      // own dies triggers
      if (c.info.dies.length) this.resolveEffects(ctrl, c.info.dies, c, `${c.info.name} dies`);
      for (const pl of this.alive()) for (const src of [...pl.bf]) {
        for (const w of src.info.deathWatch) {
          if (w.scope === 'mine' && pl !== ctrl) continue;
          if (w.scope === 'opp' && pl === ctrl) continue;
          if (w.nontoken && c.token) continue;
          this.resolveEffects(pl, w.fx, src, null, true);
        }
        // Skullclamp-style "whenever equipped creature dies"
        if (src.attached === c.id && /whenever equipped creature dies, draw two cards/i.test(src.info.text || '')) this.draw(pl, 2);
      }
    }

    lose(p, reason) {
      if (p.lost) return;
      if (this.has(p, 'platinum') && !/empty library/.test(reason)) return;
      p.lost = true; p.lostReason = reason;
      // remove their permanents
      for (const c of [...p.bf]) { this.leaveBattlefield(c); }
      for (const pl of this.players) for (const c of [...pl.bf]) if (c.owner === p.seat) { this.leaveBattlefield(c); }
      this.emit('lose', `${p.name} is eliminated: ${reason}.`, { seat: p.seat });
      const alive = this.alive();
      if (alive.length === 1 && !this.over) { this.over = true; this.winner = alive[0].seat; this.emit('win', `${alive[0].name} wins the game!`, { seat: alive[0].seat }); }
    }

    // ----- life -----
    loseLife(p, n, source) {
      if (n <= 0 || p.lost) return 0;
      if (p.protectedUntil >= this.turn) return 0;
      p.life -= n;
      this._lossDepth = (this._lossDepth || 0) + 1;
      if (this._lossDepth < 8) for (const q of this.opps(p)) for (const c of q.bf) for (const t of c.info.triggers) if (t.k === 'exquisite') this.gainLife(q, n, c);
      this._lossDepth--;
      return n;
    }
    gainLife(p, n, source) {
      if (n <= 0 || p.lost) return;
      if (p.protectedUntil >= this.turn) return;
      p.life += n;
      const trig = p.bf.flatMap((c) => c.info.triggers.map((t) => ({ t, c })));
      const bonds = trig.filter((x) => x.t.k === 'bond');
      if (bonds.length && trig.some((x) => x.t.k === 'exquisite')) {
        // Sanguine Bond + Exquisite Blood style loop: every opponent drains out
        const names = [...new Set(trig.filter((x) => x.t.k === 'bond' || x.t.k === 'exquisite').map((x) => x.c.info.name))].join(' + ');
        this.emit('combo', `${names}: ${p.name} goes infinite and drains the table!`, { seat: p.seat, cards: trig.map((x) => x.c.id) });
        for (const q of this.opps(p)) if (q.protectedUntil < this.turn) q.life = 0;
        this.checkState();
        return;
      }
      this._gainDepth = (this._gainDepth || 0) + 1;
      if (this._gainDepth < 8) for (const { t, c } of trig) {
        if (t.k === 'bond') { const tgt = this.weakestOpp(p); if (tgt) this.loseLife(tgt, n, c); }
        if (t.k === 'onGain') this.resolveEffects(p, t.fx, c, null, true);
      }
      this._gainDepth--;
    }
    weakestOpp(p) { const o = this.opps(p); return o.sort((a, b) => a.life - b.life)[0]; }

    // ----- mana -----
    sources(p) {
      const out = [];
      for (const c of p.bf) {
        const m = c.info.mana;
        if (!m || c.tapped) continue;
        if (c.info.isCreature && c.sick && !this.hasKw(c, 'haste')) continue;
        let opts = m.opts;
        if (c.info.cradle) { const n = p.bf.filter((x) => x.info.isCreature).length; if (!n) continue; opts = [{ colors: ['G'], amount: n, dmg: 0 }]; }
        if (c.info.coffers) { const n = p.bf.filter((x) => (x.info.subtypes || []).includes('Swamp')).length + (this.has(p, 'urborg') ? 0 : 0); opts = [{ colors: ['B'], amount: Math.max(1, n - 2), dmg: 0 }]; }
        out.push({ c, opts, oneShot: m.oneShot });
      }
      return out;
    }
    availableMana(p) {
      return this.sources(p).reduce((s, x) => s + Math.max(...x.opts.map((o) => o.amount)), 0) + (p.pool || 0);
    }

    // Attempt to pay; returns plan or null. If commit, taps sources.
    pay(p, cost, xVal = 0, commit = false, extraGeneric = 0) {
      const srcs = this.sources(p).map((s) => ({ ...s, used: false }));
      const pool = {}; // floating mana from multi-amount sources
      if (p.pool) pool.ANY = p.pool;
      const take = (color) => {
        if (pool[color] > 0) { pool[color]--; return true; }
        if (pool.ANY > 0) { pool.ANY--; return true; }
        return false;
      };
      let lifePaid = 0;
      const used = [];
      const pips = cost.pips.slice().sort((a, b) => a.opts.length - b.opts.length);
      for (const pip of pips) {
        let ok = false;
        for (const col of pip.opts) if (take(col)) { ok = true; break; }
        if (ok) continue;
        // find source
        let best = null, bestScore = 1e9, bestOpt = null, bestCol = null;
        for (const s of srcs) {
          if (s.used) continue;
          for (const o of s.opts) for (const col of pip.opts) {
            if (!o.colors.includes(col)) continue;
            const score = o.colors.length * 3 + (o.amount > 1 ? 4 : 0) + (s.oneShot ? 8 : 0) + o.dmg * 2;
            if (score < bestScore) { best = s; bestScore = score; bestOpt = o; bestCol = col; }
          }
        }
        if (best) {
          best.used = true; used.push({ s: best, o: bestOpt });
          if (bestOpt.amount > 1) pool[bestCol] = (pool[bestCol] || 0) + bestOpt.amount - 1;
          continue;
        }
        if (pip.phy && p.life > 12) { lifePaid += 2; continue; }
        if (pip.two) { extraGeneric += 2; continue; }
        return null;
      }
      let generic = cost.generic + xVal * (cost.x || 0) + extraGeneric;
      const poolTotal = () => Object.values(pool).reduce((a, b) => a + b, 0);
      while (generic > 0) {
        if (poolTotal() > 0) { const k = Object.keys(pool).find((k) => pool[k] > 0); pool[k]--; generic--; continue; }
        let best = null, bestScore = 1e9, bestOpt = null;
        for (const s of srcs) {
          if (s.used) continue;
          for (const o of s.opts) {
            const waste = Math.max(0, o.amount - generic);
            const score = (o.colors.includes('C') && o.colors.length === 1 ? 0 : o.colors.length * 2) + waste * 3 + (s.oneShot ? 10 : 0) + o.dmg * 2 - (o.amount > 1 ? 1 : 0);
            if (score < bestScore) { best = s; bestScore = score; bestOpt = o; }
          }
        }
        if (!best) return null;
        best.used = true; used.push({ s: best, o: bestOpt });
        const take2 = Math.min(bestOpt.amount, generic); generic -= take2;
        if (bestOpt.amount > take2) pool.C = (pool.C || 0) + bestOpt.amount - take2;
      }
      if (commit) {
        p.pool = 0;
        for (const { s, o } of used) {
          s.c.tapped = true;
          if (o.dmg) this.loseLife(p, o.dmg);
          if (s.oneShot) { if (s.c.token) this.leaveBattlefield(s.c); else this.moveToGraveyard(s.c); }
        }
        if (lifePaid) this.loseLife(p, lifePaid);
      }
      return { used: used.length };
    }

    maxX(p, cost) {
      let lo = 0, hi = 30;
      if (!this.pay(p, cost, 0)) return -1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.pay(p, cost, mid)) lo = mid; else hi = mid - 1; }
      return lo;
    }

    commanderCost(p, c) { const cost = { ...c.info.cost, generic: c.info.cost.generic + p.tax * 2 }; return cost; }

    // ----- battlefield entry -----
    enterBattlefield(c, p, o = {}) {
      c.zone = 'bf'; c.ctrl = p.seat; c.sick = true; c.tapped = !!o.tapped; c.dmg = 0;
      if (c.info.isPW) c.loyalty = c.info.loyalty || 3;
      p.bf.push(c);
      if (c.info.isLand) {
        if (c.info.etbTapped) c.tapped = true;
        if (c.info.shock) { if (p.life > 12) this.loseLife(p, 2); else c.tapped = true; }
        if (c.info.fetch) {
          const ok = (land) => land.info.isLand && c.info.fetch.types.some((tp) => tp === 'basic land' ? land.info.types.has('Basic') : tp === 'land' ? true : land.info.subtypes.includes(cap(tp)) || (tp.includes('basic') && land.info.types.has('Basic')));
          const want = p.library.filter(ok);
          if (want.length) {
            const pick = want.sort((a, b) => this.landValue(p, b) - this.landValue(p, a))[0];
            this.removeFrom(p.library, pick); this.R.shuffle(p.library);
            this.moveToGraveyard(c);
            if (/pay 1 life/i.test(c.info.text)) this.loseLife(p, 1);
            this.enterBattlefield(pick, p, { tapped: c.info.fetch.tapped, quiet: true });
            if (!o.quiet) this.emit('land', `${p.name} cracks ${c.info.name} for ${pick.info.name}.`, { seat: p.seat, cards: [pick.id] });
          }
          return;
        }
        if (c.info.bounceLand) {
          const other = p.bf.find((x) => x !== c && x.info.isLand && !x.info.bounceLand);
          if (other) this.bounce(other);
        }
      }
      if (c.info.isEquipment || c.info.isAura) this.autoAttach(p, c);
      if (!o.noEtb && c.info.etb.length) this.resolveEffects(p, c.info.etb, c, o.quiet ? null : `${c.info.name} enters`);
      if (c.info.imprint) {
        const exiled = p.hand.find((x) => !x.info.isLand && !x.info.types.has('Artifact'));
        if (exiled) { this.removeFrom(p.hand, exiled); exiled.zone = 'exile'; p.exile.push(exiled); }
      }
    }

    autoAttach(p, eq) {
      const crs = p.bf.filter((x) => x.info.isCreature);
      if (eq.info.isAura) {
        if (eq.info.statics.some((s) => s.k === 'pacify')) {
          const t = this.bestOppTarget(p, (x) => x.info.isCreature && this.targetable(x, p));
          if (t) { eq.attached = t.id; this.emit('effect', `${eq.info.name} locks down ${t.info.name}.`, { seat: p.seat, cards: [t.id, eq.id] }); }
          return;
        }
        if (eq.info.reanimAura) return;
        const best = crs.sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
        if (best) eq.attached = best.id;
        return;
      }
    }

    // ----- effects -----
    resolveEffects(p, fxList, src, label, quiet = false, xVal = 0, target = null) {
      if (label && fxList.length) this.emit('trigger', `${label}.`, { seat: p.seat, cards: src ? [src.id] : [] });
      for (const fx of fxList) { if (p.lost || this.over) return; this.resolveEffect(p, fx, src, xVal, quiet); }
    }

    tokenMult(p) { return this.statics(p, 'tokenDouble').length ? 2 ** this.statics(p, 'tokenDouble').length : 1; }

    addToken(p, spec, n, quiet) {
      n = n * this.tokenMult(p);
      const made = [];
      const cap = Math.max(0, 80 - p.bf.filter((c) => c.token).length);
      for (let i = 0; i < Math.min(n, cap); i++) {
        const t = this.makeToken(p, spec); t.ctrl = p.seat; p.bf.push(t); made.push(t.id);
      }
      if (this.has(p, 'chatterfang') && !spec.squirrel) for (let i = 0; i < Math.min(n, cap - made.length); i++) { const t = this.makeToken(p, { p: 1, t: 1, sub: 'Squirrel', colors: 'green', squirrel: true }); p.bf.push(t); made.push(t.id); }
      if (!quiet || made.length > 1) this.emit('token', `${p.name} creates ${n} ${spec.treasure ? 'Treasure' : spec.p + '/' + spec.t + ' ' + spec.sub} token${n > 1 ? 's' : ''}.`, { seat: p.seat, cards: made });
      return made;
    }

    resolveEffect(p, fx, src, xVal = 0, quiet = false) {
      const name = src ? src.info.name : '';
      const X = (v) => (v === 'X' ? Math.max(0, xVal) : v);
      switch (fx.k) {
        case 'draw': if (fx.n) this.draw(p, X(fx.n) || 0); if (!quiet && fx.n) this.emit('draw', `${p.name} draws ${X(fx.n)} off ${name}.`, { seat: p.seat, cards: src ? [src.id] : [] }); break;
        case 'wheel': {
          for (const q of this.alive()) { q.gy.push(...q.hand.map((c) => ((c.zone = 'gy'), c))); q.hand = []; this.draw(q, 7); }
          this.emit('effect', `Everyone discards their hand and draws seven.`, { seat: p.seat });
          break;
        }
        case 'ramp': {
          const basics = p.library.filter((c) => c.info.isLand && c.info.types.has('Basic'));
          const lands = basics.length ? basics : p.library.filter((c) => c.info.isLand && !c.info.fetch);
          let got = 0;
          if (fx.fromHand) {
            const l = p.hand.find((c) => c.info.isLand); if (l) { this.removeFrom(p.hand, l); this.enterBattlefield(l, p, { quiet: true }); got++; }
          } else {
            for (let i = 0; i < fx.bf && lands.length; i++) { const l = this.bestLandFrom(p, lands); this.removeFrom(lands, l); this.removeFrom(p.library, l); this.enterBattlefield(l, p, { tapped: fx.tapped, quiet: true }); got++; }
            for (let i = 0; i < fx.hand && lands.length; i++) { const l = this.bestLandFrom(p, lands); this.removeFrom(lands, l); this.removeFrom(p.library, l); l.zone = 'hand'; p.hand.push(l); }
            this.R.shuffle(p.library);
          }
          if (!quiet) this.emit('ramp', `${p.name} ramps${got ? ` into ${got} land${got > 1 ? 's' : ''}` : ''} with ${name}.`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'ritual': p.pool = (p.pool || 0) + fx.n; break;
        case 'treasure': this.addToken(p, { treasure: true }, X(fx.n) || 1, quiet); break;
        case 'tokens': {
          let n = X(fx.n);
          if (fx.nRef) n = p.bf.filter((c) => (c.info.subtypes || []).includes(fx.nRef)).length;
          const pp = fx.p === 'X' ? Math.max(1, xVal) : fx.p, tt = fx.t === 'X' ? Math.max(1, xVal) : fx.t;
          if (n > 0) this.addToken(p, { p: pp, t: tt, sub: fx.sub, kw: fx.kw, colors: fx.colors, tapped: fx.tapped }, n, false);
          break;
        }
        case 'gain': this.gainLife(p, X(fx.n), src); if (!quiet) this.emit('life', `${p.name} gains ${X(fx.n)} life.`, { seat: p.seat }); break;
        case 'drain': {
          const n = X(fx.n); let total = 0;
          for (const q of this.opps(p)) total += this.loseLife(q, n, src);
          if (fx.gain) this.gainLife(p, total, src);
          if (!quiet || n > 1) this.emit('drain', `${name ? name + ': ' : ''}each opponent loses ${n} life.`, { seat: p.seat, cards: src ? [src.id] : [] });
          this.checkState();
          break;
        }
        case 'drainOne': {
          const q = this.weakestOpp(p); if (q) this.loseLife(q, X(fx.n), src);
          if (!quiet) this.emit('drain', `${name}: ${q ? q.name : ''} loses ${X(fx.n)}.`, { seat: p.seat, cards: src ? [src.id] : [] });
          this.checkState();
          break;
        }
        case 'hailfire': {
          const reps = Math.max(0, xVal);
          for (const q of this.opps(p)) {
            for (let i = 0; i < reps && !q.lost; i++) {
              const fodder = q.bf.filter((c) => !c.info.isLand).sort((a, b) => this.permValue(a) - this.permValue(b))[0];
              if (q.life > 12 || (!fodder && !q.hand.length)) { this.loseLife(q, 3, src); continue; }
              if (q.hand.length && (!fodder || this.R() < 0.5)) { const d = q.hand.pop(); d.zone = 'gy'; q.gy.push(d); }
              else if (fodder) this.destroy(fodder, 'sacrificed', true);
              else this.loseLife(q, 3, src);
            }
          }
          this.emit('drain', `Torment of Hailfire repeats ${reps} times.`, { seat: p.seat, cards: src ? [src.id] : [] });
          this.checkState();
          break;
        }
        case 'damage': {
          const n = X(fx.n);
          if (fx.to === 'each opponent') { for (const q of this.opps(p)) this.loseLife(q, n, src); this.emit('damage', `${name} deals ${n} to each opponent.`, { seat: p.seat }); this.checkState(); break; }
          const tgt = (fx.to === 'target player' || fx.to === 'target opponent') ? null : this.bestOppTarget(p, (c) => (c.info.isCreature && this.toughness(c) - c.dmg <= n || c.info.isPW && c.loyalty <= n) && this.targetable(c, p));
          if (tgt) {
            if (tgt.info.isPW) { tgt.loyalty -= n; } else { tgt.dmg += n; }
            this.emit('removal', `${name} deals ${n} damage to ${tgt.info.name}.`, { seat: p.seat, cards: [tgt.id], target: tgt.ctrl });
            this.checkState();
          } else if (fx.to === 'any target' || fx.to === 'target player' || fx.to === 'target opponent') {
            const q = this.weakestOpp(p); if (q) { this.loseLife(q, n, src); this.emit('damage', `${name} deals ${n} damage to ${q.name}.`, { seat: p.seat, target: q.seat }); this.checkState(); }
          }
          break;
        }
        case 'removal': {
          const pred = {
            creature: (c) => c.info.isCreature, creaturepw: (c) => c.info.isCreature || c.info.isPW, nonland: (c) => !c.info.isLand,
            artifact: (c) => c.info.types.has('Artifact'), enchantment: (c) => c.info.types.has('Enchantment'),
            artench: (c) => c.info.types.has('Artifact') || c.info.types.has('Enchantment'), planeswalker: (c) => c.info.isPW,
          }[fx.what] || ((c) => !c.info.isLand);
          const tgt = src && src._target ? src._target : this.bestOppTarget(p, (c) => pred(c) && this.targetable(c, p));
          if (!tgt || tgt.zone !== 'bf') break;
          const owner = this.P(tgt.ctrl);
          if (this.tryProtect(owner, [tgt], p)) break;
          let verb;
          if (fx.bounce) { this.bounce(tgt); verb = 'bounces'; }
          else if (fx.shrink) { tgt.eot.t -= fx.shrink; tgt.eot.p -= fx.shrink; verb = 'shrinks'; this.checkState(); }
          else if (fx.exile) { this.exileCard(tgt); verb = 'exiles'; }
          else { if (!this.destroy(tgt)) { this.emit('removal', `${tgt.info.name} survives (indestructible).`, { seat: p.seat, cards: [tgt.id] }); break; } verb = 'destroys'; }
          this.emit('removal', `${name || p.name} ${verb} ${owner.name}'s ${tgt.info.name}.`, { seat: p.seat, cards: [tgt.id], target: owner.seat });
          break;
        }
        case 'edict': {
          for (const q of this.opps(p)) {
            const c = q.bf.filter((x) => x.info.isCreature).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0];
            if (c) { this.destroy(c, 'sacrificed', true); this.emit('removal', `${q.name} sacrifices ${c.info.name}.`, { seat: p.seat, cards: [c.id], target: q.seat }); }
          }
          break;
        }
        case 'steal': {
          const tgt = this.bestOppTarget(p, (c) => (fx.what === 'creature' ? c.info.isCreature : !c.info.isLand) && this.targetable(c, p));
          if (!tgt) break;
          const from = this.P(tgt.ctrl); this.removeFrom(from.bf, tgt); tgt.ctrl = p.seat; tgt.sick = true; p.bf.push(tgt);
          this.emit('removal', `${p.name} steals ${tgt.info.name} from ${from.name}.`, { seat: p.seat, cards: [tgt.id], target: from.seat });
          break;
        }
        case 'pacify': break;
        case 'edictThat': {
          const q = this._thatPlayer; if (!q) break;
          const c = q.bf.filter((x) => x.info.isCreature).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0];
          if (c) { this.destroy(c, 'sacrificed', true); this.emit('removal', `${name}: ${q.name} sacrifices ${c.info.name}.`, { seat: p.seat, cards: [c.id], target: q.seat }); }
          break;
        }
        case 'genesis': {
          let x = xVal;
          if (!x) x = Math.max(...p.bf.concat(p.command).filter((c) => c.isCommander).map((c) => c.info.mv), 0);
          const top = p.library.splice(0, Math.max(0, x));
          const put = top.filter((c) => c.info.isPermanent && c.info.mv <= x);
          for (const c of top) if (!put.includes(c)) { c.zone = 'gy'; p.gy.push(c); }
          for (const c of put) this.enterBattlefield(c, p, { quiet: true });
          this.emit('effect', `${name} reveals ${top.length} and puts ${put.length} permanents onto the battlefield!`, { seat: p.seat, cards: put.map((c) => c.id) });
          break;
        }
        case 'wipe': this.doWipe(p, fx, src, xVal); break;
        case 'massBounce': {
          for (const q of this.opps(p)) for (const c of [...q.bf]) if (!c.info.isLand) this.bounce(c);
          this.emit('wipe', `${name} returns every nonland permanent opponents control to hand!`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'counter': break; // handled at cast time
        case 'tutor': {
          const pick = this.chooseTutor(p, fx.what);
          if (pick) { this.removeFrom(p.library, pick); pick.zone = 'hand'; p.hand.push(pick); this.R.shuffle(p.library); this.emit('tutor', `${p.name} tutors for ${pick.info.name}.`, { seat: p.seat, cards: [pick.id] }); }
          break;
        }
        case 'tutorBF': {
          const crs = p.library.filter((c) => c.info.isCreature && c.info.mv <= Math.max(xVal, 3)).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a));
          if (crs[0]) { this.removeFrom(p.library, crs[0]); this.R.shuffle(p.library); this.enterBattlefield(crs[0], p); this.emit('tutor', `${p.name} puts ${crs[0].info.name} onto the battlefield.`, { seat: p.seat, cards: [crs[0].id] }); }
          break;
        }
        case 'regrow': {
          const c = p.gy.filter((x) => !x.info.isLand).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (c) { this.removeFrom(p.gy, c); c.zone = 'hand'; p.hand.push(c); this.emit('effect', `${p.name} returns ${c.info.name} to hand.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'massRegrow': {
          if (fx.bf) {
            const want = { creature: 'Creature', artifact: 'Artifact', enchantment: 'Enchantment', land: 'Land' }[fx.what];
            const got = p.gy.filter((x) => x.info.isPermanent && (!want || x.info.types.has(want)));
            for (const c of got) { this.removeFrom(p.gy, c); this.enterBattlefield(c, p, { quiet: true }); }
            this.emit('reanimate', `${name} returns ${got.length} cards to the battlefield.`, { seat: p.seat, cards: got.map((c) => c.id) });
            break;
          }
          const lands = p.gy.filter((x) => x.info.isLand);
          for (const l of lands) { this.removeFrom(p.gy, l); l.zone = 'hand'; p.hand.push(l); }
          if (lands.length) this.emit('effect', `${p.name} returns ${lands.length} lands to hand.`, { seat: p.seat });
          break;
        }
        case 'reanimate': {
          const pools = fx.any ? this.alive().flatMap((q) => q.gy) : p.gy;
          const c = pools.filter((x) => (fx.perm ? x.info.isPermanent && !x.info.isLand && x.info.mv <= fx.mvMax : x.info.isCreature) && !x.isCommander).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (c) {
            this.removeFrom(this.P(c.owner).gy, c);
            this.enterBattlefield(c, p);
            if (src && src.info.reanimAura && src.zone === 'bf') src.attached = c.id;
            this.emit('reanimate', `${p.name} reanimates ${c.info.name}${c.owner !== p.seat ? ' from ' + this.P(c.owner).name + "'s graveyard" : ''}.`, { seat: p.seat, cards: [c.id] });
          }
          break;
        }
        case 'counters': {
          const mult = this.statics(p, 'counterDouble').length ? 2 : 1;
          const n = (X(fx.n) || 1) * mult;
          let targets = [];
          if (fx.on === 'each') targets = p.bf.filter((c) => c.info.isCreature && (!fx.sub || (c.info.subtypes || []).includes(fx.sub)));
          else if (fx.on === 'self' && src && src.zone === 'bf' && src.info.isCreature) targets = [src];
          else { const t = p.bf.filter((c) => c.info.isCreature).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0]; if (t) targets = [t]; }
          targets.forEach((c) => (c.p1 += n));
          if (targets.length && !quiet) this.emit('effect', `${targets.length > 1 ? targets.length + ' creatures get' : targets[0].info.name + ' gets'} ${n} +1/+1 counter${n > 1 ? 's' : ''}.`, { seat: p.seat, cards: targets.map((c) => c.id) });
          break;
        }
        case 'proliferate': {
          let n = 0;
          for (const c of p.bf) { if (c.p1 > 0) { c.p1++; n++; } if (c.info.isPW) { c.loyalty++; n++; } }
          for (const q of this.opps(p)) if (q.poison > 0) q.poison++;
          if (n && !quiet) this.emit('effect', `${p.name} proliferates (${n} permanents).`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'overrun': {
          const crs = p.bf.filter((c) => c.info.isCreature);
          const n = crs.length;
          for (const c of crs) { c.eot.p += fx.p === 'X' ? n : fx.p; c.eot.t += fx.t === 'X' ? n : fx.t; c.eot.kw.push(...fx.kw); }
          this.emit('effect', `${name}: creatures ${p.name} controls get +${fx.p === 'X' ? n : fx.p}/+${fx.t === 'X' ? n : fx.t}${fx.kw.length ? ' and trample' : ''}!`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'protect': break;
        case 'discard': for (const q of this.opps(p)) if (q.hand.length) { const d = q.hand.splice(this.R.int(q.hand.length), 1)[0]; d.zone = 'gy'; q.gy.push(d); } break;
        case 'extraTurn': p.extraTurn = (p.extraTurn || 0) + 1; this.emit('effect', `${p.name} will take an extra turn.`, { seat: p.seat }); break;
        case 'cheatAttack': break;
      }
    }

    doWipe(p, fx, src, xVal) {
      const name = src ? src.info.name : '';
      const victims = [];
      const prot = new Set();
      for (const q of this.alive()) if (q !== p && this.tryProtect(q, q.bf.filter((c) => c.info.isCreature || fx.what === 'nonland'), p, true)) prot.add(q.seat);
      for (const q of this.alive()) {
        if (prot.has(q.seat)) continue;
        for (const c of [...q.bf]) {
          let hit = false;
          if (fx.what === 'creatures' || fx.what === 'farewell') hit = c.info.isCreature || (fx.what === 'farewell' && (c.info.types.has('Artifact') || c.info.types.has('Enchantment')) && !c.info.isLand && q !== p);
          else if (fx.what === 'nonland') hit = !c.info.isLand && !c.info.isPW;
          else if (fx.what === 'big') hit = c.info.isCreature && this.power(c) >= 4;
          else if (fx.what === 'lands') hit = c.info.isLand;
          else if (fx.what === 'minusX') { if (c.info.isCreature) { c.eot.p -= xVal; c.eot.t -= xVal; } continue; }
          else if (fx.what === 'damage') { if (c.info.isCreature) c.dmg += fx.n; continue; }
          if (!hit) continue;
          if (fx.exile) { this.exileCard(c); victims.push(c); }
          else if (this.destroy(c)) victims.push(c);
        }
      }
      if (fx.what === 'minusX' || fx.what === 'damage') { const before = this.allBf().length; this.checkState(); const after = this.allBf().length; this.emit('wipe', `${name} sweeps the board (${before - after} permanents die).`, { seat: p.seat, cards: src ? [src.id] : [] }); return; }
      this.emit('wipe', `${name || 'A wipe'} ${fx.exile ? 'exiles' : 'destroys'} ${victims.length} permanent${victims.length === 1 ? '' : 's'}!`, { seat: p.seat, cards: src ? [src.id] : [] });
    }

    tryProtect(q, threatened, attacker, wipe = false) {
      if (q === attacker || q.lost) return false;
      const value = threatened.reduce((s, c) => s + this.permValue(c), 0);
      if (value < (wipe ? 12 : 14)) return false;
      if (this.abolished(q)) return false;
      const card = q.hand.find((c) => c.info.spell && c.info.spell.some((f) => f.k === 'protect') && this.pay(q, c.info.cost));
      if (!card) return false;
      this.pay(q, card.info.cost, 0, true);
      this.removeFrom(q.hand, card); card.zone = 'gy'; q.gy.push(card);
      if (/phase out|protection from everything/i.test(card.info.text)) q.protectedUntil = this.turn + this.alive().length - 1;
      for (const c of q.bf) { c.indestructibleEOT = true; c.hexproofEOT = true; }
      this.emit('response', `${q.name} responds with ${card.info.name}!`, { seat: q.seat, cards: [card.id] });
      return true;
    }

    abolished(q) {
      // Grand Abolisher: q cannot cast spells during the active player's turn
      const act = this.P(this.active);
      return act !== q && this.has(act, 'abolisher');
    }

    targetable(c, by) {
      if (c.ctrl === by.seat) return true;
      const k = this.kws(c);
      if (k.has('hexproof') || k.has('shroud')) return false;
      if (this.P(c.ctrl).protectedUntil >= this.turn) return false;
      return true;
    }

    // ----- valuation -----
    creatureValue(c) {
      const [p, t] = this.pt(c);
      const k = this.kws(c);
      let v = p * 1.6 + t * 0.8 + (c.info.mv || 0) * 0.6;
      if (k.has('flying')) v += p * 0.6 + 1;
      if (k.has('deathtouch')) v += 2;
      if (k.has('lifelink')) v += p * 0.4;
      if (k.has('double strike')) v += p;
      if (k.has('trample')) v += p * 0.3;
      if (c.isCommander) v += 5;
      if (c.info.statics.length || c.info.triggers.length || c.info.deathWatch.length || c.info.activated.length || c.info.upkeep.length) v += 3 + (c.info.mv || 0) * 0.5;
      if (c.info.mana) v += 2;
      return v;
    }
    permValue(c) {
      if (c.info.isCreature) return this.creatureValue(c);
      if (c.info.isPW) return 6 + c.loyalty * 1.5 + c.info.mv;
      if (c.info.isLand) return 1;
      if (c.token) return 1.5;
      let v = c.info.mv * 1.4 + (c.info.statics.length + c.info.triggers.length + c.info.upkeep.length + c.info.activated.length) * 3;
      if (c.info.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite')) v += 8;
      if (c.info.mana) v = 2 + c.info.mv * 0.5;
      return v;
    }
    playerThreat(q) {
      return q.bf.reduce((s, c) => s + (c.info.isLand ? 0.5 : this.permValue(c)), 0) + (40 - q.life) * -0.15;
    }
    bestOppTarget(p, pred) {
      let best = null, bestV = 2;
      for (const q of this.opps(p)) {
        const lead = this.playerThreat(q) * 0.05;
        for (const c of q.bf) if (pred(c)) { const v = this.permValue(c) + lead; if (v > bestV) { best = c; bestV = v; } }
      }
      return best;
    }
    landValue(p, c) {
      const m = c.info.mana; if (!m) return c.info.fetch ? 2 : 0;
      const cols = new Set(m.opts.flatMap((o) => o.colors));
      const need = p.colors.filter((x) => !this.sources(p).some((s) => s.opts.some((o) => o.colors.includes(x))) && !p.bf.some((b) => b.info.mana && b.info.mana.opts.some((o) => o.colors.includes(x))));
      let v = [...cols].filter((x) => p.colors.includes(x)).length + need.filter((x) => cols.has(x)).length * 3;
      if (c.info.etbTapped) v -= 1.5;
      return v;
    }
    bestLandFrom(p, lands) { return lands.slice().sort((a, b) => this.landValue(p, b) - this.landValue(p, a))[0]; }
    cardValue(p, c) {
      const i = c.info;
      if (i.isLand) return 1;
      let v = i.mv;
      if (i.isCreature) v += (i.power || 0) + (i.toughness || 0) * 0.5;
      if (i.spell.some((f) => f.k === 'wipe')) v += 8;
      if (i.triggers.length || i.statics.length) v += 5;
      if (i.isPW) v += 6;
      return v;
    }
    chooseTutor(p, what) {
      const pool = p.library.filter((c) => !c.info.isLand && (what === 'card' || (what === 'creature' && c.info.isCreature) || (what.includes('artifact') && c.info.types.has('Artifact')) || (what.includes('enchantment') && c.info.types.has('Enchantment')) || (what.includes('instant') && (c.info.isInstant || c.info.isSorcery))));
      if (!pool.length) return null;
      const avail = this.availableMana(p) + 1;
      // combo pieces first
      const bond = pool.find((c) => c.info.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite'));
      const haveHalf = p.bf.some((c) => c.info.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite'));
      if (bond && haveHalf) return bond;
      const opp = this.opps(p).map((q) => this.playerThreat(q)).sort((a, b) => b - a)[0] || 0;
      const mine = this.playerThreat(p);
      return pool.slice().sort((a, b) => {
        const sa = this.cardValue(p, a) - Math.max(0, a.info.mv - avail) * 3 + (opp > mine + 15 && a.info.spell.some((f) => f.k === 'wipe') ? 20 : 0);
        const sb = this.cardValue(p, b) - Math.max(0, b.info.mv - avail) * 3 + (opp > mine + 15 && b.info.spell.some((f) => f.k === 'wipe') ? 20 : 0);
        return sb - sa;
      })[0];
    }

    // ----- state-based actions -----
    checkState() {
      let changed = true, guard = 0;
      while (changed && guard++ < 20) {
        changed = false;
        for (const q of this.players) {
          if (q.lost) continue;
          if (q.life <= 0) { this.lose(q, 'life total reached 0'); changed = true; continue; }
          if (q.poison >= 10) { this.lose(q, '10 poison counters'); changed = true; continue; }
          for (const [k, v] of Object.entries(q.cmdDmg)) if (v >= 21) { this.lose(q, `21 commander damage from ${this.cards[k].info.name}`); changed = true; break; }
        }
        for (const c of this.allBf()) {
          if (c.info.isCreature) {
            const t = this.toughness(c);
            if (t <= 0) { this.destroy(c, 'dies', true); changed = true; }
            else if ((c.dmg >= t || (c.dt && c.dmg > 0)) && !this.hasKw(c, 'indestructible')) { this.destroy(c); changed = true; }
          } else if (c.info.isPW && c.loyalty <= 0) { this.moveToGraveyard(c); changed = true; }
        }
        // legend rule
        for (const q of this.alive()) {
          const seen = {};
          for (const c of [...q.bf]) if (c.info.isLegendary && !c.token) { if (seen[c.name]) { this.moveToGraveyard(c); changed = true; } else seen[c.name] = 1; }
        }
      }
    }

    // ----- casting -----
    castables(p) {
      const out = [];
      const cmd = p.command[0];
      for (const c of p.hand) if (!c.info.isLand || false) out.push({ c, from: 'hand' });
      if (cmd) out.push({ c: cmd, from: 'command' });
      if (this.has(p, 'muldrotha')) {
        for (const c of p.gy) if (c.info.isPermanent && !c.info.isLand) {
          const types = ['Creature', 'Artifact', 'Enchantment', 'Planeswalker'].filter((t) => c.info.types.has(t) && !p.gyCastTypes.has(t));
          if (types.length) out.push({ c, from: 'gy', gyType: types[0] });
        }
      }
      return out;
    }

    costFor(p, c, from) { return from === 'command' ? this.commanderCost(p, c) : c.info.cost; }

    scoreCast(p, c, from) {
      const i = c.info;
      const turnN = this.round;
      const opp = this.opps(p);
      const mine = this.playerThreat(p);
      const oppMax = Math.max(...opp.map((q) => this.playerThreat(q)), 0);
      if (i.isLand) return -1;
      // reactive cards are held
      if (i.spell.some((f) => f.k === 'counter' || f.k === 'protect') && !i.spell.some((f) => ['draw', 'removal', 'tokens'].includes(f.k))) return -1;
      if (i.isInstant && i.spell.length === 0 && /target creature you control|until end of turn/i.test(i.text)) return -1;
      let s = 5 + i.mv;
      if (i.mana && !i.isLand) s += 30 - turnN * 2;
      if (from === 'command') s += 25 + i.mv;
      if (i.isCreature) s += 8 + (i.power || 0) + (i.toughness || 0) * 0.5 + i.kw.size;
      if (i.isPW) s += 22 + i.loyalty;
      if (i.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite')) s += 15;
      const fx = i.isPermanent ? i.etb : i.spell;
      for (const f of fx) {
        if (f.k === 'ramp') s += 28 - turnN * 2;
        if (f.k === 'draw') s += 6 + (f.n === 'X' ? 3 : f.n * 3) + (p.hand.length < 3 ? 8 : 0);
        if (f.k === 'wheel') s += p.hand.length < 3 ? 25 : -20;
        if (f.k === 'tutor' || f.k === 'tutorBF') s += 14;
        if (f.k === 'tokens') s += 6 + (f.n === 'X' ? 6 : f.n * 2);
        if (f.k === 'treasure') s += 4;
        if (f.k === 'removal' || f.k === 'steal') {
          const pred = f.what === 'creature' ? (x) => x.info.isCreature : (x) => !x.info.isLand;
          const t = this.bestOppTarget(p, (x) => pred(x) && this.targetable(x, p));
          if (!t && i.isInstant || !t && i.isSorcery) return -1;
          if (t) s += Math.min(25, this.permValue(t) * 1.6);
          if (t && this.permValue(t) < 6 && !i.isPermanent) s -= 15;
        }
        if (f.k === 'edict') { if (!opp.some((q) => q.bf.some((x) => x.info.isCreature))) return -1; s += 8; }
        if (f.k === 'wipe') {
          if (f.what === 'lands') { const myLands = p.bf.filter((x) => x.info.isLand).length; const theirs = Math.max(...opp.map((q) => q.bf.filter((x) => x.info.isLand).length)); if (myLands >= theirs || mine < oppMax) return -1; s += 15; continue; }
          const myBoard = p.bf.filter((x) => x.info.isCreature).reduce((a, x) => a + this.creatureValue(x), 0);
          const theirBoard = opp.map((q) => q.bf.filter((x) => x.info.isCreature).reduce((a, x) => a + this.creatureValue(x), 0));
          const worst = Math.max(...theirBoard, 0);
          if (worst - myBoard < 14 && theirBoard.reduce((a, b) => a + b, 0) - myBoard * 2 < 25) return -1;
          s += 30;
        }
        if (f.k === 'massBounce') { if (oppMax < 25) return -1; s += 20; }
        if (f.k === 'drain' || f.k === 'hailfire') s += 10;
        if (f.k === 'reanimate') { const pools = f.any ? opp.concat([p]).flatMap((q) => q.gy) : p.gy; const best = pools.filter((x) => x.info.isCreature && !x.isCommander).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0]; if (!best) { if (!i.isPermanent || i.reanimAura) return -1; } else s += this.creatureValue(best); }
        if (f.k === 'regrow') { if (!p.gy.some((x) => !x.info.isLand)) s -= 3; else s += 6; }
        if (f.k === 'overrun') { const n = p.bf.filter((x) => x.info.isCreature && !x.sick).length; if (n < 3 && i.isInstant) return -1; s += n * 3; }
        if (f.k === 'extraTurn') s += 20;
      }
      if (!i.isPermanent && fx.length === 0) s = 1; // unmodeled spell: cast it last
      if (i.reanimAura && !this.alive().some((q) => q.gy.some((x) => x.info.isCreature && !x.isCommander))) return -1;
      if (i.isEquipment && !p.bf.some((x) => x.info.isCreature)) s -= 4;
      return s;
    }

    castSpell(p, c, from, gyType) {
      const i = c.info;
      let cost = this.costFor(p, c, from);
      let xVal = 0;
      if (cost.x) { xVal = this.maxX(p, cost); if (xVal < 0) return false; }
      const overload = i.overload && this.pay(p, i.overload);
      if (overload && this.opps(p).some((q) => this.playerThreat(q) > 20)) cost = i.overload;
      if (!this.pay(p, cost, xVal, true)) return false;
      if (from === 'hand') this.removeFrom(p.hand, c);
      else if (from === 'command') { this.removeFrom(p.command, c); p.tax++; }
      else if (from === 'gy') { this.removeFrom(p.gy, c); p.gyCastTypes.add(gyType); }
      c.zone = 'stack';
      this.emit('cast', `${p.name} casts ${i.name}${xVal ? ` (X=${xVal})` : ''}${from === 'command' ? ' from the command zone' : from === 'gy' ? ' from the graveyard' : ''}.`, { seat: p.seat, cards: [c.id] });
      this.castTriggers(p, c);
      // opponents respond
      if (this.tryCounter(p, c)) {
        if (c.isCommander) { c.zone = 'command'; p.command.push(c); }
        else { c.zone = 'gy'; p.gy.push(c); }
        return true;
      }
      if (i.isPermanent) {
        this.enterBattlefield(c, p, { xVal });
        if (i.etb.length && xVal) { /* X handled in effects */ }
      } else {
        const fx = overload ? i.spell.filter((f) => f.k !== 'removal').concat(cost === i.overload ? [{ k: 'massBounce' }] : i.spell.filter((f) => f.k === 'removal')) : i.spell;
        this.resolveEffects(p, fx, c, null, false, xVal);
        if (c.zone === 'stack') { c.zone = /exile .* protection/i.test(i.text) ? 'exile' : 'gy'; (c.zone === 'gy' ? p.gy : p.exile).push(c); }
      }
      this.checkState();
      return true;
    }

    castTriggers(p, c) {
      const i = c.info;
      // own cast triggers (Edgar eminence works from the command zone)
      const srcs = p.bf.concat(p.command);
      for (const s of srcs) for (const t of s.info.castTrig) {
        if (s === c) continue;
        if (s.zone === 'command' && !t.eminence) continue;
        const f = t.filter;
        let ok = false;
        if (/noncreature/.test(f)) ok = !i.isCreature;
        else if (/instant or sorcery/.test(f)) ok = i.isInstant || i.isSorcery;
        else if (/creature/.test(f)) ok = i.isCreature;
        else if (/artifact/.test(f)) ok = i.types.has('Artifact');
        else if (/enchantment/.test(f)) ok = i.types.has('Enchantment');
        else { const sub = cap(f.split(' ')[0]); ok = (i.subtypes || []).includes(sub); }
        if (ok) this.resolveEffects(p, t.fx, s, null, true);
      }
      // opponents' Rhystic Study / Esper Sentinel
      for (const q of this.opps(p)) for (const s of q.bf) for (const t of s.info.triggers) {
        if (t.k === 'rhystic' || (t.k === 'sentinel' && !i.isCreature)) {
          const spare = this.availableMana(p);
          if (spare >= 1 && this.R() < 0.6) { this.pay(p, parseCost('1'), 0, true); continue; }
          this.draw(q, 1);
          this.emit('draw', `${q.name} draws off ${s.info.name}.`, { seat: q.seat, cards: [s.id] });
        }
      }
    }

    tryCounter(p, c) {
      const i = c.info;
      const value = (i.mv || 0) + (c.isCommander ? 4 : 0) + (i.spell.some((f) => f.k === 'wipe' || f.k === 'massBounce') ? 10 : 0) + (i.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite') ? 6 : 0) + (i.spell.some((f) => f.k === 'tutor') ? 2 : 0);
      if (value < 5) return false;
      if (this.has(p, 'abolisher') && this.active === p.seat) return false;
      for (const q of this.opps(p)) {
        if (this.abolished(q)) continue;
        for (const cs of q.hand) {
          const f = cs.info.spell.find((x) => x.k === 'counter');
          if (!f) continue;
          const okType = !f.filter || (f.filter === 'noncreature' && !i.isCreature) || (f.filter === 'creature' && i.isCreature) || (f.filter.includes('instant') && (i.isInstant || i.isSorcery || (f.filter.includes('enchantment') && i.types.has('Enchantment'))));
          if (!okType) continue;
          let free = false;
          if (cs.info.freeAlt) {
            if (/if you control a commander/i.test(cs.info.text)) free = q.bf.some((x) => x.isCommander);
            else if (/exile a blue card/i.test(cs.info.text)) free = q.hand.some((x) => x !== cs && x.info.colors.has('U'));
            else free = true;
          }
          if (!free && !this.pay(q, cs.info.cost)) continue;
          // the more dangerous the spell, the more likely they fire
          const chance = Math.min(0.95, 0.35 + value * 0.06);
          if (this.R() > chance) continue;
          if (free) {
            if (/exile a blue card/i.test(cs.info.text)) { const b = q.hand.find((x) => x !== cs && x.info.colors.has('U')); this.removeFrom(q.hand, b); b.zone = 'exile'; q.exile.push(b); this.loseLife(q, 1); }
          } else this.pay(q, cs.info.cost, 0, true);
          this.removeFrom(q.hand, cs); cs.zone = 'gy'; q.gy.push(cs);
          this.emit('counter', `${q.name} counters ${i.name} with ${cs.info.name}!`, { seat: q.seat, cards: [cs.id, c.id], target: p.seat });
          if (/mana drain/i.test(cs.info.name)) q.pool = (q.pool || 0); // mana arrives on their turn; ignored
          if (/its controller creates a 2\/2 blue bird/i.test(cs.info.text)) this.addToken(p, { p: 2, t: 2, sub: 'Bird', kw: ['flying'], colors: 'blue' }, 1, true);
          return true;
        }
      }
      return false;
    }

    // ----- turn structure -----
    run() {
      this.emit('start', `Seats shuffled. ${this.players.map((p) => p.name).join(', ')} sit down.`);
      for (const p of this.players) { this.R.shuffle(p.library); this.openingHand(p); }
      this.active = this.R.int(4);
      this.started = true;
      this.emit('start', `${this.P(this.active).name} goes first.`, { seat: this.active });
      let first = true;
      while (!this.over) {
        const p = this.P(this.active);
        if (!p.lost) {
          if (this.active === this.startSeat) this.round++;
          this.takeTurn(p, first);
          first = false;
          if (p.extraTurn && !p.lost && !this.over) { p.extraTurn--; this.takeTurn(p, false); }
        }
        if (this.over) break;
        if (this.round > this.maxRounds) {
          const best = this.alive().sort((a, b) => b.life - a.life)[0];
          this.over = true; this.winner = null; this.timeout = true;
          this.emit('win', `Turn limit reached. Game called a draw (${best.name} has the highest life, ${best.life}).`);
          break;
        }
        do { this.active = (this.active + 1) % 4; } while (this.P(this.active).lost && !this.over);
      }
      return this;
    }

    openingHand(p) {
      this.draw(p, 7);
      const lands = () => p.hand.filter((c) => c.info.isLand || c.info.mdfcLand).length;
      let mulls = 0;
      while ((lands() < 2 || lands() > 5) && mulls < 2) {
        p.library.push(...p.hand.map((c) => ((c.zone = 'library'), c))); p.hand = [];
        this.R.shuffle(p.library); this.draw(p, 7); mulls++;
      }
      // first mulligan is free in multiplayer
      for (let i = 1; i < mulls; i++) {
        const worst = p.hand.slice().sort((a, b) => (b.info.isLand ? 0 : b.info.mv) - (a.info.isLand ? 0 : a.info.mv))[0];
        this.removeFrom(p.hand, worst); worst.zone = 'library'; p.library.push(worst);
      }
      p.cardsDrawn = 0;
      this.emit('mulligan', `${p.name} keeps ${p.hand.length}${mulls ? ` after ${mulls} mulligan${mulls > 1 ? 's' : ''}` : ''} (${lands()} lands).`, { seat: p.seat });
    }

    get startSeat() { if (this._start == null) this._start = this.active; return this._start; }

    takeTurn(p, first) {
      this.turn++;
      this.phase = 'untap';
      p.landsPlayed = 0; p.gyCastTypes = new Set(); p.pool = 0;
      if (p.protectedUntil < this.turn) p.protectedUntil = -1;
      for (const c of p.bf) { if (!/doesn't untap during your untap step/i.test(c.info.text || '')) c.tapped = false; c.sick = false; }
      this.emit('turn', `Turn ${this.round}: ${p.name}`, { seat: p.seat });
      // upkeep
      this.phase = 'upkeep';
      for (const q of this.alive()) for (const c of [...q.bf]) for (const u of c.info.upkeep) {
        if (u.opp) { if (q === p) continue; this._thatPlayer = p; this.resolveEffects(q, u.fx, c, null, true); this._thatPlayer = null; continue; }
        if (!u.each && q !== p) continue;
        if (u.lose) this.loseLife(q, u.lose);
        this.resolveEffects(q, u.fx, c, u.fx.length ? `${c.info.name} triggers` : null, true);
      }
      this.checkState(); if (p.lost || this.over) return;
      // draw
      this.phase = 'draw';
      if (!first) {
        this.inDrawStep = true;
        if (this.has(p, 'necro')) { /* skip draw */ } else this.draw(p, 1);
        this.inDrawStep = false;
        if (p.bf.some((c) => c.name === 'Sylvan Library')) { if (p.life > 16 && p.library.length) { this.draw(p, 1); this.loseLife(p, 4); } }
      }
      if (this.has(p, 'necro') && p.life > 14) { const n = Math.min(p.life - 14, 5); this.loseLife(p, n); this.draw(p, n); this.emit('draw', `${p.name} pays ${n} life to Necropotence.`, { seat: p.seat }); }
      if (p.lost || this.over) return;
      // main 1
      this.phase = 'main';
      this.mainPhase(p);
      if (p.lost || this.over) return;
      // combat
      this.phase = 'combat';
      this.combat(p);
      if (p.lost || this.over) return;
      this.phase = 'main 2';
      this.mainPhase(p, true);
      if (p.lost || this.over) return;
      // end step
      this.phase = 'end';
      for (const q of this.alive()) for (const c of [...q.bf]) for (const e of c.info.endstep) {
        if (!e.each && q !== p) continue;
        this.resolveEffects(q, e.fx, c, null, false);
      }
      // cleanup
      const max = this.has(p, 'noMaxHand') ? 99 : 7;
      while (p.hand.length > max) { const d = p.hand.slice().sort((a, b) => this.cardValue(p, a) - this.cardValue(p, b))[0]; this.removeFrom(p.hand, d); d.zone = 'gy'; p.gy.push(d); }
      for (const c of this.allBf()) { c.dmg = 0; c.dt = false; c.eot = { p: 0, t: 0, kw: [] }; c.indestructibleEOT = false; c.hexproofEOT = false; }
      this.checkState();
    }

    playLand(p) {
      const allowed = 1 + this.statics(p, 'extraLand').reduce((s, x) => s + x.s.n, 0);
      while (p.landsPlayed < allowed) {
        const lands = p.hand.filter((c) => c.info.isLand);
        const mdfc = p.hand.filter((c) => c.info.mdfcLand);
        let pick = null, face = null;
        if (lands.length) pick = lands.slice().sort((a, b) => this.landValue(p, b) - this.landValue(p, a))[0];
        else if (mdfc.length && p.bf.filter((c) => c.info.isLand).length < 6) { pick = mdfc[0]; face = pick.info.mdfcLand; }
        else if (this.has(p, 'muldrotha') && !p.gyCastTypes.has('Land')) { pick = p.gy.find((c) => c.info.isLand); if (pick) { this.removeFrom(p.gy, pick); p.gyCastTypes.add('Land'); p.hand.push(pick); } }
        if (!pick) return;
        this.removeFrom(p.hand, pick);
        if (face) { pick.info = Object.assign(Object.create(Object.getPrototypeOf(face)), face, { faces: pick.info.faces }); }
        p.landsPlayed++;
        this.enterBattlefield(pick, p, { quiet: true });
        if (pick.zone === 'bf') this.emit('land', `${p.name} plays ${pick.info.name}${pick.tapped ? ' (tapped)' : ''}.`, { seat: p.seat, cards: [pick.id] });
      }
    }

    mainPhase(p, second = false) {
      this.playLand(p);
      let guard = 0;
      while (guard++ < 40 && !p.lost && !this.over) {
        const options = this.castables(p).map((o) => ({ ...o, s: this.scoreCast(p, o.c, o.from) })).filter((o) => o.s > 0)
          .filter((o) => this.pay(p, this.costFor(p, o.c, o.from)) && (!o.c.info.cost.x || this.maxX(p, o.c.info.cost) >= this.minX(o.c)));
        if (!options.length) break;
        options.sort((a, b) => b.s - a.s);
        const o = options[0];
        if (!this.castSpell(p, o.c, o.from, o.gyType)) break;
        this.playLand(p);
      }
      if (p.lost || this.over) return;
      this.activateAbilities(p, second);
      this.useWalkers(p, second);
      this.equipStuff(p);
    }

    minX(c) {
      const fx = c.info.isPermanent ? c.info.etb : c.info.spell;
      if (fx.some((f) => f.k === 'drain' || f.k === 'hailfire')) return 3;
      if (fx.some((f) => f.k === 'wipe')) return 2;
      return 1;
    }

    activateAbilities(p, postCombat) {
      for (const c of [...p.bf]) {
        if (c.zone !== 'bf') continue;
        for (const ab of c.info.activated) {
          if (ab.tap && (c.tapped || (c.info.isCreature && c.sick && !this.hasKw(c, 'haste')))) continue;
          if (ab.tap && c.info.isCreature && !postCombat) continue; // creatures prefer to attack first
          if (ab.life && p.life - ab.life < 15) continue;
          if (ab.sac && !ab.fx.some((f) => ['draw', 'removal', 'tokens', 'ramp', 'treasure', 'tutor'].includes(f.k))) continue;
          if (ab.sacOther) continue;
          const useful = ab.fx.some((f) => {
            if (f.k === 'removal' || f.k === 'steal') return !!this.bestOppTarget(p, (x) => (f.what === 'creature' ? x.info.isCreature : !x.info.isLand) && this.targetable(x, p));
            return ['draw', 'tokens', 'treasure', 'counters', 'drain', 'drainOne', 'gain', 'damage', 'ramp', 'proliferate'].includes(f.k);
          });
          if (!useful) continue;
          if (ab.cost.mv && !this.pay(p, ab.cost)) continue;
          if (ab.cost.mv) this.pay(p, ab.cost, 0, true);
          if (ab.tap) c.tapped = true;
          if (ab.life) this.loseLife(p, ab.life);
          this.emit('ability', `${p.name} activates ${c.info.name}: ${ab.text.slice(0, 90)}`, { seat: p.seat, cards: [c.id] });
          if (ab.sac) this.moveToGraveyard(c);
          this.resolveEffects(p, ab.fx, c, null, false);
          this.checkState();
          if (c.zone !== 'bf') break;
        }
      }
    }

    useWalkers(p, postCombat) {
      if (postCombat) return;
      for (const c of [...p.bf]) {
        if (!c.info.isPW || c.zone !== 'bf' || c.usedTurn === this.turn) continue;
        const abs = c.info.loyaltyAbs;
        if (!abs.length) continue;
        let choice = null;
        const scored = abs.map((a) => {
          if (a.delta < 0 && c.loyalty + a.delta < 0) return { a, s: -99 };
          if (a.delta === -99) return { a, s: -99 };
          let s = 0;
          for (const f of a.fx) {
            if (f.k === 'removal') s += this.bestOppTarget(p, (x) => (f.what === 'creature' ? x.info.isCreature : !x.info.isLand) && this.targetable(x, p)) ? 9 : -5;
            else if (f.k === 'wipe') s += this.scoreCast(p, { info: { ...c.info, spell: [f], etb: [], isPermanent: false, isPW: false, mana: null, isCreature: false } }, 'hand') > 0 ? 14 : -10;
            else if (f.k === 'tokens') s += 5; else if (f.k === 'draw') s += 4; else if (f.k === 'drain') s += 4;
            else if (f.k === 'counters' || f.k === 'gain' || f.k === 'treasure' || f.k === 'reanimate' || f.k === 'regrow' || f.k === 'tutor') s += 3;
            else s += 1;
          }
          if (a.delta > 0) s += 3; else s += a.delta * 1.2;
          if (c.loyalty + a.delta === 0) s -= 4;
          if (Math.abs(a.delta) >= 6 && c.loyalty + a.delta >= 0) s += 12;
          return { a, s };
        }).sort((x, y) => y.s - x.s);
        choice = scored[0];
        if (!choice || choice.s < -50) continue;
        c.loyalty += choice.a.delta; c.usedTurn = this.turn;
        this.emit('ability', `${c.info.name} [${choice.a.delta > 0 ? '+' : ''}${choice.a.delta}]: ${choice.a.text.slice(0, 90)}`, { seat: p.seat, cards: [c.id] });
        this.resolveEffects(p, choice.a.fx, c, null, false);
        this.checkState();
      }
    }

    equipStuff(p) {
      for (const eq of p.bf.filter((c) => c.info.isEquipment)) {
        const best = p.bf.filter((c) => c.info.isCreature && !this.pacified(c)).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
        if (!best || eq.attached === best.id) continue;
        if (eq.attached && this.cards[eq.attached] && this.cards[eq.attached].zone === 'bf') continue;
        const cost = eq.info.equip || parseCost('2');
        if (!this.pay(p, cost)) continue;
        this.pay(p, cost, 0, true);
        eq.attached = best.id;
        this.emit('ability', `${p.name} equips ${eq.info.name} to ${best.info.name}.`, { seat: p.seat, cards: [eq.id, best.id] });
      }
    }

    // ----- combat -----
    canAttack(c) {
      if (!c.info.isCreature || c.tapped) return false;
      if (c.sick && !this.hasKw(c, 'haste')) return false;
      if (this.hasKw(c, 'defender') || this.pacified(c)) return false;
      if (this.power(c) <= 0) return false;
      return true;
    }
    canBlock(b, a) {
      if (!b.info.isCreature || b.tapped || this.pacified(b)) return false;
      const ak = this.kws(a);
      if (ak.has('unblockable')) return false;
      if (ak.has('flying') && !this.hasKw(b, 'flying') && !this.hasKw(b, 'reach')) return false;
      if (ak.has('protection') && a.info.name !== b.info.name && this.R() < 0) return false;
      return true;
    }

    chooseDefender(p, attackers) {
      const opps = this.opps(p);
      let best = null, bestS = -1e9;
      for (const q of opps) {
        if (q.protectedUntil >= this.turn) continue;
        const blockers = q.bf.filter((b) => b.info.isCreature && !b.tapped);
        let through = 0;
        for (const a of attackers) if (!blockers.some((b) => this.canBlock(b, a))) through += this.power(a);
        const total = attackers.reduce((s, a) => s + this.power(a), 0);
        let s = through * 2 + total * 0.5 - blockers.length * 1.5 + this.playerThreat(q) * 0.15 - q.life * 0.2 + this.R() * 3;
        if (through >= q.life) s += 100;
        if (s > bestS) { bestS = s; best = q; }
      }
      return best;
    }

    combat(p) {
      let cands = p.bf.filter((c) => this.canAttack(c));
      if (!cands.length) return;
      const q = this.chooseDefender(p, cands);
      if (!q) return;
      const blockers = q.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b));
      const totalPower = cands.reduce((s, a) => s + this.power(a), 0);
      const lethalish = totalPower >= q.life;
      const threatOnMe = Math.max(0, ...this.opps(p).map((o) => o.bf.filter((c) => c.info.isCreature).reduce((s, c) => s + this.power(c), 0)));
      const attackers = [];
      for (const a of cands.sort((x, y) => this.power(y) - this.power(x))) {
        const [ap, at] = this.pt(a);
        const ak = this.kws(a);
        const able = blockers.filter((b) => this.canBlock(b, a));
        const badBlock = able.some((b) => {
          const [bp, bt] = this.pt(b);
          const kills = bp >= at || this.hasKw(b, 'deathtouch');
          const survives = bt > ap && !ak.has('deathtouch') || this.hasKw(b, 'indestructible');
          return kills && survives && !ak.has('indestructible');
        });
        const trade = able.some((b) => { const [bp] = this.pt(b); return (bp >= at || this.hasKw(b, 'deathtouch')) && !ak.has('indestructible'); });
        let go = !badBlock && (!trade || this.creatureValue(a) < 6 || able.length === 0);
        if (lethalish) go = true;
        if (a.isCommander && trade && !lethalish && able.length) go = !badBlock && this.R() < 0.3;
        if (ak.has('vigilance')) go = go || !badBlock;
        // keep a blocker back if under heavy threat
        if (!ak.has('vigilance') && p.life <= threatOnMe && !lethalish && a.info.toughness >= 2 && attackers.length >= 1 && this.R() < 0.6) go = false;
        if (go) attackers.push(a);
      }
      if (!attackers.length) return;
      // assign some attackers to opposing planeswalkers
      const assign = new Map();
      const walkers = q.bf.filter((c) => c.info.isPW).sort((a, b) => b.loyalty - a.loyalty);
      const pool = attackers.slice();
      for (const w of walkers) {
        if (w.loyalty < 3 && pool.length < 3) continue;
        let need = w.loyalty;
        for (const a of pool.slice().sort((x, y) => this.power(x) - this.power(y))) {
          if (need <= 0) break;
          if (q.life <= 10) break;
          assign.set(a.id, w.id); need -= this.power(a); pool.splice(pool.indexOf(a), 1);
        }
      }
      for (const a of attackers) { if (!this.hasKw(a, 'vigilance')) a.tapped = true; a.attacking = true; }
      const atkInfo = attackers.map((a) => ({ id: a.id, to: assign.get(a.id) || null }));
      this.emit('attack', `${p.name} attacks ${q.name} with ${attackers.length} creature${attackers.length > 1 ? 's' : ''} (${attackers.reduce((s, a) => s + this.power(a), 0)} power).`, { seat: p.seat, cards: attackers.map((a) => a.id), attackers: atkInfo, target: q.seat });
      // attack triggers
      for (const a of attackers) {
        for (const f of a.info.attack) {
          if (f.k === 'cheatAttack') {
            const cheat = p.hand.filter((c) => c.info.isCreature && f.subs.some((s) => (c.info.subtypes || []).includes(s))).sort((x, y) => this.creatureValue(y) - this.creatureValue(x))[0];
            if (cheat) {
              this.removeFrom(p.hand, cheat);
              this.enterBattlefield(cheat, p, { tapped: true });
              cheat.attacking = true; attackers.push(cheat); atkInfo.push({ id: cheat.id, to: null });
              this.emit('trigger', `${a.info.name} puts ${cheat.info.name} onto the battlefield attacking!`, { seat: p.seat, cards: [cheat.id, a.id], attackers: atkInfo, target: q.seat });
            }
          } else this.resolveEffect(p, f, a, 0, false);
        }
        for (const eq of p.bf) if (eq.attached === a.id && eq.info.attack && eq.info.attack.length) this.resolveEffects(p, eq.info.attack, eq, null, true);
      }
      this.checkState();
      if (q.lost || this.over) { attackers.forEach((a) => (a.attacking = false)); return; }
      // blocks
      const blocks = this.declareBlocks(q, attackers.filter((a) => a.zone === 'bf' && !assign.get(a.id)), p);
      const blkInfo = [...blocks.entries()].flatMap(([aid, bs]) => bs.map((b) => ({ id: b.id, blocks: aid })));
      if (blkInfo.length) this.emit('block', `${q.name} blocks with ${blkInfo.length} creature${blkInfo.length > 1 ? 's' : ''}.`, { seat: q.seat, cards: blkInfo.map((b) => b.id), attackers: atkInfo, blockers: blkInfo, target: q.seat });
      // damage: first strike then regular
      let dealtToPlayer = 0;
      const lifelinkGain = [];
      const step = (firstStrike) => {
        for (const a of attackers) {
          if (a.zone !== 'bf') continue;
          const ak = this.kws(a);
          const fs = ak.has('first strike') || ak.has('double strike');
          if (firstStrike ? !fs : (fs && !ak.has('double strike'))) continue;
          let dmg = this.power(a);
          if (dmg <= 0) continue;
          const bs = (blocks.get(a.id) || []).filter((b) => b.zone === 'bf');
          if (blocks.has(a.id) && (blocks.get(a.id) || []).length) {
            for (const b of bs) {
              const need = ak.has('deathtouch') ? 1 : Math.max(0, this.toughness(b) - b.dmg);
              const d = Math.min(dmg, need || dmg);
              b.dmg += d; if (ak.has('deathtouch')) b.dt = true; dmg -= d;
              if (ak.has('lifelink')) lifelinkGain.push(d);
              if (dmg <= 0) break;
            }
            if (dmg > 0 && ak.has('trample')) this.hitPlayer(p, q, a, dmg, lifelinkGain, (n) => (dealtToPlayer += n));
            else if (dmg > 0 && bs.length) bs[0].dmg += dmg;
          } else {
            const wid = assign.get(a.id);
            const w = wid && this.cards[wid];
            if (w && w.zone === 'bf') { w.loyalty -= dmg; if (ak.has('lifelink')) lifelinkGain.push(dmg); }
            else this.hitPlayer(p, q, a, dmg, lifelinkGain, (n) => (dealtToPlayer += n));
          }
        }
        // blockers strike back
        for (const [aid, bs] of blocks) {
          const a = this.cards[aid];
          for (const b of bs) {
            if (b.zone !== 'bf' || a.zone !== 'bf') continue;
            const bk = this.kws(b);
            const fs = bk.has('first strike') || bk.has('double strike');
            if (firstStrike ? !fs : (fs && !bk.has('double strike'))) continue;
            const d = this.power(b);
            if (d > 0) { a.dmg += d; if (bk.has('deathtouch')) a.dt = true; if (bk.has('lifelink')) this.gainLife(q, d); }
          }
        }
        if (lifelinkGain.length) { this.gainLife(p, lifelinkGain.reduce((s, x) => s + x, 0)); lifelinkGain.length = 0; }
        this.checkState();
      };
      const anyFS = attackers.concat(...blocks.values()).some((c) => this.hasKw(c, 'first strike') || this.hasKw(c, 'double strike'));
      if (anyFS) step(true);
      step(false);
      const lostTxt = q.lost ? '' : ` ${q.name} is at ${q.life}.`;
      this.emit('damage', `Combat damage: ${dealtToPlayer} to ${q.name}.${lostTxt}`, { seat: p.seat, attackers: atkInfo.filter((x) => this.cards[x.id].zone === 'bf'), blockers: blkInfo.filter((x) => this.cards[x.id].zone === 'bf'), target: q.seat });
      for (const a of attackers) a.attacking = false;
    }

    hitPlayer(p, q, a, dmg, ll, tally) {
      if (q.lost) return;
      if (q.protectedUntil >= this.turn) return;
      const n = this.loseLife(q, dmg, a);
      tally(n);
      if (a.isCommander && n) q.cmdDmg[a.id] = (q.cmdDmg[a.id] || 0) + n;
      if (this.hasKw(a, 'lifelink')) ll.push(n);
      if (/infect|toxic/i.test(a.info.text || '')) q.poison += dmg;
      for (const f of a.info.combatDmg) this.resolveEffect(p, f, a, 0, false);
      for (const eq of p.bf) if (eq.attached === a.id && eq.info.combatDmg.length) this.resolveEffects(p, eq.info.combatDmg, eq, null, true);
    }

    declareBlocks(q, attackers, p) {
      const blocks = new Map();
      const avail = q.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b));
      const incoming = attackers.reduce((s, a) => s + this.power(a), 0);
      let remaining = incoming;
      const sorted = attackers.slice().sort((x, y) => this.power(y) - this.power(x));
      for (const a of sorted) {
        const [ap, at] = this.pt(a);
        const ak = this.kws(a);
        const able = avail.filter((b) => this.canBlock(b, a));
        if (!able.length) continue;
        if (ak.has('menace') && able.length < 2) continue;
        let choice = null;
        // good block: kill and survive
        choice = able.find((b) => { const [bp, bt] = this.pt(b); return (bp >= at || this.hasKw(b, 'deathtouch')) && !ak.has('indestructible') && (bt > ap || this.hasKw(b, 'indestructible')) && !ak.has('deathtouch'); });
        // safe block: survive
        if (!choice) choice = able.find((b) => { const [, bt] = this.pt(b); return (bt > ap || this.hasKw(b, 'indestructible')) && !ak.has('deathtouch') && !ak.has('trample'); });
        // trade
        if (!choice) choice = able.filter((b) => { const [bp] = this.pt(b); return (bp >= at || this.hasKw(b, 'deathtouch')) && !ak.has('indestructible') && this.creatureValue(b) <= this.creatureValue(a) + 1; }).sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0];
        // chump when in danger
        const cmdLethal = a.isCommander && (q.cmdDmg[a.id] || 0) + ap >= 21;
        if (!choice && (remaining >= q.life || cmdLethal || (remaining >= q.life * 0.6 && ap >= 6))) {
          choice = able.filter((b) => !b.isCommander).sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0];
        }
        if (choice) {
          blocks.set(a.id, [choice]);
          avail.splice(avail.indexOf(choice), 1);
          if (!ak.has('trample')) remaining -= ap;
        }
      }
      return blocks;
    }
  }

  function simulate(decks, db, seed, opts) {
    return new Game(decks, db, seed, opts).run();
  }

  const API = { Game, simulate, parseEffects, analyzeCard, parseCost, rng, deckColorIdentity };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.PodSim = API;
})(typeof window !== 'undefined' ? window : globalThis);
