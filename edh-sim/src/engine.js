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
  const KEYWORDS = ['infect', 'flying', 'reach', 'trample', 'deathtouch', 'lifelink', 'first strike', 'double strike', 'vigilance',
    'haste', 'menace', 'indestructible', 'hexproof', 'shroud', 'defender', 'protection'];

  // Known multi-card combos that appear in the decklists. Each entry lists the pieces;
  // the AI hunts for the missing piece with tutors and casts pieces eagerly once the rest are in place.
  const COMBOS = [
    { name: 'Sanguine Bond loop', pieces: [['Sanguine Bond', 'Vito, Thorn of the Dusk Rose', 'Dina, Soul Steeper', 'Enduring Tenacity', 'Marauding Blight-Priest'], ['Exquisite Blood', 'Bloodthirsty Conqueror']] },
    { name: 'Karn lock', pieces: [['Karn, the Great Creator'], ['Mycosynth Lattice']] },
    { name: 'Infinite mana', pieces: [['Basalt Monolith'], ['Rings of Brighthearth', 'Zirda, the Dawnwaker', 'Forsaken Monument']] }, // Rings copies the {3} untap; Zirda makes it {1}; Monument makes it tap for 4
    { name: 'Myrkul + Devoted Druid', pieces: [['Myrkul, Lord of Bones'], ['Devoted Druid']] },
    // the unlimited green mana wants a finisher: Finale of Devastation for X=99 (+99/+99 and haste), or Genesis Wave for most of the library
    { name: 'Myrkul + Devoted Druid + Finale', pieces: [['Myrkul, Lord of Bones'], ['Devoted Druid'], ['Finale of Devastation', 'Genesis Wave']] },
    { name: 'Myrkul + Cinderhaze Wretch', pieces: [['Myrkul, Lord of Bones'], ['Cinderhaze Wretch']] },
    { name: 'Aetherflux kill', pieces: [['Basalt Monolith'], ['Rings of Brighthearth', 'Zirda, the Dawnwaker', 'Forsaken Monument'], ['Staff of Domination'], ['Aetherflux Reservoir']] }, // infinite mana -> Staff loops for life -> 50 damage each
    { name: 'Ballista', pieces: [['Basalt Monolith'], ['Rings of Brighthearth', 'Zirda, the Dawnwaker', 'Forsaken Monument'], ['Walking Ballista']] },
    { name: 'Dragon fire', pieces: [['Terror of the Peaks', 'Dragon Tempest'], ['Fiery Emancipation', 'Gisela, Blade of Goldnight']] },
    { name: 'Aristocrats', pieces: [['Blood Artist', 'Zulaport Cutthroat', 'Cruel Celebrant', 'The Meathook Massacre'], ['Viscera Seer', "Ashnod's Altar", 'Yawgmoth, Thran Physician', 'Altar of Dementia', 'Phyrexian Tower', 'Yahenni, Undying Partisan', 'Razaketh, the Foulblooded']] },
    { name: 'Doubled walkers', pieces: [['Doubling Season', 'Vorinclex, Monstrous Raider'], ['Teferi, Hero of Dominaria', 'Elspeth, Sun\'s Champion', 'Ugin, the Spirit Dragon', 'Jace, the Mind Sculptor', 'Garruk, Apex Predator', 'Oko, Thief of Crowns', 'Liliana, Dreadhorde General', 'Sorin Markov', 'Vraska the Unseen']] },
  ];

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
      else if (tok.includes('/') || /^[WUBRG2][WUBRGP]$/.test(tok)) {
        const parts = tok.includes('/') ? tok.split('/') : tok.split('');
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
    const full = t.toLowerCase();
    // abilities granted in quotes belong to tokens/other objects, not to this effect
    const l = full.replace(/"[^"]*"/g, '""');
    const fx = [];
    let m;

    // counterspells
    if ((m = l.match(/counter target (noncreature |creature |instant or sorcery |enchantment, instant, or sorcery |artifact or enchantment |activated or triggered ability|)spell/)) || /counter target spell/.test(l)) {
      const f = (m && m[1].trim()) || '';
      fx.push({ k: 'counter', filter: f });
    } else if (/counter target instant spell, sorcery spell/.test(l)) fx.push({ k: 'counter', filter: 'instant or sorcery' }); // (Spider-Sense; triggered abilities aren't on a stack here)
    else if (/counter target triggered ability or colorless spell/.test(l)) fx.push({ k: 'counter', filter: 'colorless' }); // (Consign to Memory)
    else if ((m = l.match(/return target spell( or nonland permanent an opponent controls)? to its owner's hand/))) {
      // Reprieve, Sink into Stupor: a "counter" that sends the spell back to hand; Sink can also bounce a permanent
      fx.push({ k: 'counter', filter: '', bounce: true });
      if (m[1]) fx.push({ k: 'removal', what: 'nonland', bounce: true });
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
      else if (/^(nonblack|nonartifact|tapped|attacking) creature$/.test(what)) what = { 'nonblack creature': 'nonblackCreature', 'nonartifact creature': 'nonartifactCreature', 'tapped creature': 'tappedCreature', 'attacking creature': 'attackingCreature' }[what];
      else if (/creature/.test(what)) what = /planeswalker/.test(what) ? 'creaturepw' : 'creature';
      else if (/artifact or enchantment|artifact, enchantment/.test(what)) what = 'artench';
      fx.push({ k: 'removal', what, exile: m[1] === 'exile', gainToughness: /you gain life equal to its toughness/.test(l) });
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
    if (/each player (discards their hand(?:,)? then )?draws seven cards/.test(l)) fx.push({ k: 'wheel' });
    else if ((m = l.match(/draw (a|one|two|three) cards?, then discard (a|one|two|three) cards?/))) fx.push({ k: 'loot', n: num(m[2]), draw: num(m[1]) });
    else if ((m = l.match(/(?:you may )?discard (two|a|one) cards?\. if you do, draw (two|three|a) cards?/))) fx.push({ k: 'loot', n: num(m[1]), draw: num(m[2]), optional: true });
    else if ((m = l.match(/(?<!each player |each opponent |that player |target player |target opponent )draws? (a|an|one|two|three|four|five|seven|x|\d+) cards?/)) && !/each player draws/.test(l)) {
      fx.push({ k: 'draw', n: num(m[1]) });
    }
    if (/discard a card at random/.test(l)) fx.push({ k: 'discardSelf', n: 1, random: true });
    if ((m = l.match(/look at the top (\w+) cards of your library\. put (\w+) of them into your hand/))) fx.push({ k: 'draw', n: num(m[2]) });
    if ((m = l.match(/reveal the top (\w+) cards of your library\. put all (land|creature)/))) fx.push({ k: 'draw', n: Math.ceil(num(m[1]) / 3) });
    if (/exile the top card of your library\. (?:until end of turn|you may play)/.test(l)) fx.push({ k: 'draw', n: 1 });

    // tutors
    if (/search your library for an? (card|creature card|artifact or enchantment card|artifact card|enchantment card|instant or sorcery card)[^.]*?(put (?:it|that card) into your hand|put that card on top|reveal it, put it into your hand|put it on top)/.test(l)) {
      const what = (l.match(/search your library for an? (card|creature card|artifact or enchantment card|artifact card|enchantment card|instant or sorcery card)/) || [])[1] || 'card';
      fx.push({ k: 'tutor', what: what.replace(' card', ''), ...(/on top/.test(l) ? { top: true } : {}) });
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
    if ((m = l.match(/return all (creature|permanent|land|artifact|enchantment) cards from your graveyard to (the battlefield|your hand)/))) fx.push({ k: 'massRegrow', what: m[1], bf: m[2] === 'the battlefield', haste: /gain haste/.test(l) });
    if (/reveal the top x cards of your library\. you may put any number of permanent cards with mana value x or less from among them onto the battlefield|reveal the top x cards of your library, where x is the greatest mana value of a commander/.test(l) || /reveal the top x cards of your library\. you may put any number of permanent cards with mana value x or less/.test(l)) fx.push({ k: 'genesis' });
    if (/sacrifices a creature/.test(l) && /that player sacrifices/.test(l)) fx.push({ k: 'edictThat' });

    // tokens
    const tokRe = /(?<!its controller |that player |target player |each opponent |opponent )creates? (a|an|one|two|three|four|five|six|x|\d+|that many|a number of) (tapped )?(?:(\d+|x)\/(\d+|x) )?([a-z ,-]*?)(creature )?tokens?(?: with ([^."]+))?/g;
    while (!/tokens equal to cardname's power/.test(l) && (m = tokRe.exec(l))) { // ("equal to its power" has its own rule below)
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
      const tok = { k: 'tokens', n, p, t: tt, sub: sub || 'Token', colors: colors.join(' '), kw: [...findKeywords(m[7] || '')], tapped: !!m[2], ...(words.includes('artifact') ? { artifact: true } : {}) };
      const quoted = (full.slice(full.indexOf(m[0].slice(0, 20))).match(/with "([^"]*)"/) || [])[1];
      if (quoted && /when (?:this (?:creature|token)|cardname) dies, (.*)/.test(quoted)) tok.dies = parseEffects(quoted.match(/when (?:this (?:creature|token)|cardname) dies, (.*)/)[1]);
      fx.push(tok);
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
    if (/exchange control of cardname and (?:up to one )?target creature an opponent controls/.test(l)) fx.push({ k: 'exchange', self: true });
    else if ((m = l.match(/exchange control of target artifact or creature you control and target creature an opponent controls(?: with power (\d+) or less)?/))) fx.push({ k: 'exchange', pmax: m[1] ? +m[1] : 99 });
    if (/target artifact or creature loses all abilities and becomes a green elk creature/.test(l)) fx.push({ k: 'elk' });
    if (/gain control of all artifacts that player controls/.test(l)) fx.push({ k: 'stealArtifacts' });
    if (/reveal cards from the top of your library until you reveal a basic land card\. put that card into your hand and all other cards revealed this way into your graveyard/.test(l)) fx.push({ k: 'hermit' });
    if ((m = l.match(/creatures you control (?:gain trample and )?get \+(\d+|x)\/\+(\d+|x)(?: and gain ([a-z ,]+?))? until end of turn/))) {
      fx.push({ k: 'overrun', p: m[1] === 'x' ? 'X' : +m[1], t: m[2] === 'x' ? 'X' : +m[2], kw: /trample/.test(l) ? ['trample'] : [] });
    }
    // protection
    if (/permanents you control gain hexproof and indestructible|creatures you control gain indestructible|creatures you control gain hexproof and indestructible|you gain protection from everything|permanents you control phase out|all permanents you control phase out/.test(l)) {
      fx.push({ k: 'protect' });
    }
    if (/extra turn/.test(l) && /take an extra turn/.test(l)) fx.push({ k: 'extraTurn' });
    if (/each opponent discards|target player discards|target opponent discards/.test(l)) fx.push({ k: 'discard', n: num((l.match(/discards (a|one|two|three) cards?/) || [])[1] || 1), ...(/target (player|opponent) discards/.test(l) ? { one: true } : {}), ...(/at random/.test(l) ? { random: true } : {}) });

    // --- broader patterns ---
    // "look at the top N cards ... you may reveal a X card ... put it into your hand"
    if ((m = l.match(/(?:look at|reveal) the top (\w+) cards of your library\. (?:you may )?(?:reveal |put )?(.+?) from among them (?:and put (?:it|them|that card) )?into your hand(?:\. put the rest (into your graveyard|on the bottom))?/))) {
      const words = m[2].match(/\b(angel|demon|dragon|creature|land|planeswalker|noncreature|nonland|artifact|enchantment|instant|sorcery|legendary)\b/g) || [];
      fx.push({ k: 'dig', n: num(m[1]), types: [...new Set(words)], all: /and\/or/.test(m[2]), restGy: /graveyard/.test(m[3] || l) && /put the rest into your graveyard/.test(l) });
    }
    // typed searches that are not land ramp or plain tutors
    if (!fx.some((f) => f.k === 'ramp' || f.k === 'tutor' || f.k === 'tutorBF') && (m = l.match(/search your library for (?:up to (\w+) |an? )(?:([a-z -]+?) )?cards?(?: with mana value (\d+|x) or less| with mana value equal to 1 plus the sacrificed artifact's mana value)?[^.]*?(put (?:it|them|that card|those cards) onto the battlefield|put (?:it|that card) into your graveyard|put (?:it|that card) into your hand|reveal (?:it|that card), put it into your hand)/))) {
      const dest = /battlefield/.test(m[4]) ? 'bf' : /graveyard/.test(m[4]) ? 'gy' : 'hand';
      fx.push({ k: 'search', n: m[1] ? num(m[1]) : 1, what: (m[2] || 'card').trim(), mvMax: m[3] ? num(m[3]) : null, mvPlusOne: /plus the sacrificed/.test(l), dest });
    }
    if ((m = l.match(/(?:you |target player |each player )?mills? (a|one|two|three|four|five|x|\d+) cards?/))) fx.push({ k: 'mill', n: num(m[1]) });
    if ((m = l.match(/\bscry (\d+)/))) fx.push({ k: 'scry', n: +m[1] });
    if ((m = l.match(/each player sacrifices (a|two|three) creatures?/))) fx.push({ k: 'edictAll', n: num(m[1]) });
    if ((m = l.match(/each player sacrifices a creature or planeswalker/))) fx.push({ k: 'edictAll', n: 1, discardIfNone: true });
    if ((m = l.match(/each opponent sacrifices (two|three) creatures/))) fx.push({ k: 'edict', n: num(m[1]) });
    if (/each player discards a card/.test(l)) fx.push({ k: 'discardAll' });
    if ((m = l.match(/discard up to (\w+) cards, then draw that many/))) fx.push({ k: 'loot', n: num(m[1]) });
    if ((m = l.match(/target player draws (\w+) cards? and loses (\d+) life/))) { fx.push({ k: 'draw', n: num(m[1]) }); fx.push({ k: 'loseSelf', n: +m[2] }); }
    else if ((m = l.match(/(?:^|\. |and )you lose (\d+) life/)) && !/whenever you lose/.test(l)) fx.push({ k: 'loseSelf', n: +m[1] });
    if ((m = l.match(/target opponent's life total becomes (\d+)/))) fx.push({ k: 'lifeBecomes', n: +m[1] });
    if ((m = l.match(/tap (?:up to (\w+) )?target (?:nonland )?(?:permanent|creature)s?\. (?:it|they) (?:doesn't|don't) untap/))) fx.push({ k: 'freeze', n: m[1] ? num(m[1]) : 1 });
    if (/put target nonland permanent into its owner's library/.test(l)) fx.push({ k: 'removal', what: 'nonland', tuck: true });
    if (/target creature (?:you don't control )?phases out/.test(l) && !/each creature/.test(l)) fx.push({ k: 'phaseOut' });
    if (/exile each permanent with mana value x or less that's one or more colors/.test(l)) fx.push({ k: 'wipe', what: 'ugin', exile: true });
    if (/destroy all non-zombie creatures/.test(l)) fx.push({ k: 'wipe', what: 'creatures', spare: 'Zombie' });
    if ((m = l.match(/each non-(\w+) creature gets -x\/-x until end of turn, where x is the number of \w+ you control/))) fx.push({ k: 'wipe', what: 'tribalMinus', tribe: cap(m[1]) });
    if (/destroy each nonland permanent with mana value 2 or less/.test(l)) fx.push({ k: 'wipe', what: 'mv2' });
    if (/all creatures get -x\/-x until end of turn/.test(l)) fx.push({ k: 'wipe', what: 'minusX' });
    if (/put all creature cards from all graveyards onto the battlefield under your control/.test(l)) fx.push({ k: 'massReanimate' });
    if ((m = l.match(/return all creature cards with mana value (\d+) or less from your graveyard to the battlefield/))) fx.push({ k: 'massReanimate', own: true, mvMax: +m[1] }); // (Raise the Past)
    if ((m = l.match(/search your library for up to (one|two|three|\d+) creature cards?, put (?:them|it) into your graveyard/))) fx.push({ k: 'search', n: num(m[1]), what: 'creature', dest: 'gy' }); // (Buried Alive)
    if (/each player exiles all creature cards from their graveyard, then sacrifices all creatures they control/.test(l)) fx.push({ k: 'livingDeath' });
    if (/choose two target creature cards in your graveyard\. sacrifice a creature/.test(l)) fx.push({ k: 'victimize' });
    if ((m = l.match(/(?:up to one )?target creature(?: you control)? gets \+(\d+)\/\+(\d+)(?: and gains ([a-z ,]+?))? until end of turn/))) fx.push({ k: 'pump', p: +m[1], t: +m[2], kw: [...findKeywords(m[3] || '')] });
    else if ((m = l.match(/(?:another |up to one )?target creature(?: you control)? (?:gains|has) ([a-z ,]+?) until end of turn/))) fx.push({ k: 'pump', p: 0, t: 0, kw: [...findKeywords(m[1])] });
    if ((m = l.match(/target creature gets \+(\d+)\/\+0 and gains ([a-z ,]+?) until end of turn/))) fx.push({ k: 'pump', p: +m[1], t: 0, kw: [...findKeywords(m[2])] });
    if (/target creature can't be blocked this turn/.test(l)) fx.push({ k: 'pump', p: 0, t: 0, kw: ['unblockable'] });
    if (/target creature can't block this turn/.test(l)) fx.push({ k: 'noBlock' });
    if (/creatures you control gain (lifelink|indestructible|trample|haste)[a-z ,]* until end of turn/.test(l) && !/get \+/.test(l)) fx.push({ k: 'overrun', p: 0, t: 0, kw: [...findKeywords(l.match(/creatures you control gain ([a-z ,]+?) until end of turn/)[1])] });
    if (/untap all lands you control/.test(l)) fx.push({ k: 'untapLands' });
    if ((m = l.match(/return up to (\w+) target land cards from your graveyard to your hand/))) fx.push({ k: 'regrowLands', n: num(m[1]) });
    if ((m = l.match(/put target (enchantment|artifact|creature) card from your graveyard on top of your library/))) fx.push({ k: 'regrowTop', what: m[1] });
    if (/create a food token/.test(l)) fx.push({ k: 'food' });
    if (/create a clue token/.test(l)) fx.push({ k: 'clue' });
    if (/create a blood token/.test(l)) fx.push({ k: 'blood' });
    if (/exile all cards from target player's graveyard|exile target player's graveyard/.test(l)) fx.push({ k: 'graveHate' });
    if (/double the number of each kind of counter on any number of target permanents/.test(l)) fx.push({ k: 'doubleCounters' });
    if (/destroy target land/.test(l)) fx.push({ k: 'landDestroy' });
    if (/each player gains control of all creatures they own/.test(l)) fx.push({ k: 'homeward' });
    if (/take two extra turns after this one/.test(l)) { fx.push({ k: 'extraTurn' }); fx.push({ k: 'extraTurn' }); }
    if (/prevent all combat damage that would be dealt this turn/.test(l)) fx.push({ k: 'fog' });
    else if (/prevent all damage that sources of the color of your choice would deal this turn/.test(l)) fx.push({ k: 'fog', color: true }); // (Prismatic Strands: the attack's colour)
    if (/^target player can't cast spells this turn/.test(l)) fx.push({ k: 'silence' }); // (Orim's Chant)
    if (/target player mills cards equal to cardname's power/.test(l)) fx.push({ k: 'millOpp', n: 'POWER' }); // (Veteran Ice Climber)
    if (/^manifest dread/.test(l)) fx.push({ k: 'tokens', n: 1, p: 2, t: 2, sub: 'Manifest', colors: '' }); // (a face-down 2/2)
    if ((m = l.match(/^cardname deals (\d+) damage to target attacking or blocking creature/))) fx.push({ k: 'damage', n: +m[1], to: 'creature' }); // (Razorgrass Ambush: any creature here)
    if (/creatures you control gain flying and get \+x\/\+x until end of turn, where x is the number of creatures you control/.test(l)) fx.push({ k: 'overrun', p: 'X', t: 'X', kw: ['flying'] }); // (Moonshaker Cavalry)
    if ((m = l.match(/untap up to (one|two|three|\d+) lands/))) fx.push({ k: 'untapLandsUpTo', n: num(m[1]) }); // (Cloud of Faeries)
    if (/target artifact, creature, or planeswalker an opponent controls loses all abilities until your next turn/.test(l)) fx.push({ k: 'neutralize', short: true }); // (Azure Beastbinder)
    if ((m = l.match(/create a number of 1\/1 ([a-z]+) ([a-z]+) creature tokens equal to cardname's power/))) fx.push({ k: 'tokens', n: 'POWER', p: 1, t: 1, sub: cap(m[2]), colors: m[1] }); // (Jacked Rabbit)
    if (/^you and permanents you control gain hexproof until end of turn/.test(l)) fx.push({ k: 'protect' }); // (Dawn's Truce)
    if (/exile the top (\w+) cards of your library\. you may play them this turn/.test(l)) fx.push({ k: 'impulse', n: num(l.match(/exile the top (\w+) cards of your library\. you may play them this turn/)[1]) });
    if ((m = l.match(/add \{r\} for each card in target opponent's hand/))) fx.push({ k: 'jeska' });
    // which lands a search may find: "a Forest card", "a Plains, Island, Swamp, or Mountain card", "basic land", "land card"
    const clause = (l.match(/search your library for ([^.]*?) cards?/) || [])[1] || '';
    for (const f of fx) if (f.k === 'ramp') {
      const types = ['plains', 'island', 'swamp', 'mountain', 'forest'].filter((t) => new RegExp('\\b' + t).test(clause)).map(cap);
      if (types.length) f.landTypes = types;
      f.basicOnly = /\bbasic\b/.test(clause);
      if (/share a land type/.test(l)) f.sameType = true;
    }
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
      if (low === 'dash') a.dash = parseCost(arg);
      if (low === 'delve') a.delve = true;
      if (low === 'miracle' && arg) a.miracle = parseCost(arg);
      if (low === 'gift' || /^gift/.test(low)) a.gift = true;
      if (low === 'web-slinging' && arg) a.altCost = { kind: 'webSling', mana: arg.replace(/[{}]/g, ' ').trim().toUpperCase() };
      if (low === 'evolve') a.evolve = true;
      if (low === 'transmute' && arg) a.transmute = parseCost(arg);
      if (low === 'ward' && /^\d+$/.test(arg || '')) { a.wardMana = +arg; a.kw.add('ward'); }
      if (low === 'ravenous') { a.etbCounters = 'X'; a.ravenous = true; } // enters with X +1/+1 counters; X >= 5: draw a card
      if (low === 'mobilize') a.mobilize = +arg || 1;
      if (low === 'flashback' && /^[\dWUBRGC ]+$/.test(arg || '')) a.flashback = parseCost(arg);
      if (low === 'cycling' && /^[\dWUBRGC ]+$/.test(arg || '')) a.cycling = parseCost(arg);
      if (low.startsWith('protection')) a.kw.add('protection');
      if (low === 'etbcounter') { const parts = k.split(':'); if (parts[1] === 'P1P1') a.etbCounters = parts[2] === 'X' ? 'X' : +parts[2]; if (parts[1] === 'M1M1') a.etbMinus = +parts[2] || 1; }
      if (low === 'infect') a.kw.add('infect');
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
      const PE = (t) => { const r = parseEffects(t); if (!r.length) a.unmodeled.push(line); return r; };
      if ((m = line.match(/^\[([+\-−]?\d+|[+\-−]?X)\]:\s*(.*)$/))) {
        const d = m[1].replace('−', '-');
        a.loyaltyAbs.push({ delta: /X/.test(d) ? -99 : parseInt(d), fx: PE(m[2]), text: m[2] });
        continue;
      }
      if (a.isInstant || a.isSorcery) {
        const alt = parseAltCost(low);
        if (alt) { a.freeAlt = true; a.altCost = alt; continue; }
        if (/^(you may pay|if you control a commander, you may cast|you may exile a)/.test(low) && /rather than pay|without paying its mana cost/.test(low)) { a.freeAlt = true; continue; }
        if (/^overload/.test(low) || /^cycling/.test(low) || /^kicker/.test(low) || /^flashback/.test(low)) continue;
        a.spell.push(...PE(line));
        continue;
      }
      if ((m = low.match(/^when(?:ever)? cardname (?:enters|enters the battlefield|is turned face up)(?: or attacks)?[^,]*,\s*(.*)$/)) || (m = low.match(/^when(?:ever)? cardname enters or [^,]*,\s*(.*)$/))) {
        a.etb.push(...PE(m[1]));
        if (/or attacks/.test(low)) a.attack.push(...PE(m[1]));
        if (/imprint/.test(low)) a.imprint = true;
        continue;
      }
      if ((m = low.match(/^(?:landfall — )?whenever (?:a land|cardname or another land) (?:you control )?enters(?: the battlefield)?(?: under your control)?,\s*(.*)$/))) {
        if (/return cardname from your graveyard to the battlefield/.test(m[1])) { a.gyLandfall = true; continue; }
        a.landfall = a.landfall || []; a.landfall.push(PE(m[1]).map((f) => (/if you control seven or more lands with different names/.test(m[1]) ? { ...f, sevenNames: true } : f))); continue;
      }
      if ((m = low.match(/^(?:constellation — )?whenever (?:cardname or another enchantment|an enchantment) (?:you control )?enters(?: the battlefield)?(?: under your control)?,\s*(.*)$/))) { a.constellation = a.constellation || []; a.constellation.push(PE(m[1])); continue; }
      if (/deals damage equal to that creature's power|one or more other creatures you control with power 2 or less enter/.test(low)) { /* handled below / by script */ }
      else if ((m = low.match(/^whenever (?:a |another )?creature you control enters,\s*(.*)$/)) || (m = low.match(/^whenever a creature (?:enters|you control enters)(?: the battlefield)? under your control,\s*(.*)$/))) { a.myCreatureEtb = a.myCreatureEtb || []; a.myCreatureEtb.push(PE(m[1])); continue; }
      if ((m = low.match(/^whenever a creature an opponent controls enters,\s*(.*)$/))) { a.oppCreatureEtb = a.oppCreatureEtb || []; a.oppCreatureEtb.push(PE(m[1])); continue; }
      if (/^creatures your opponents control enter tapped/.test(low)) { a.statics.push({ k: 'oppEnterTapped' }); continue; }
      if ((m = low.match(/^whenever another creature enters,\s*(.*)$/))) { a.anyCreatureEtb = PE(m[1]); continue; }
      if ((m = low.match(/^whenever an artifact you control enters,\s*(.*)$/))) { a.artifactEtb = true; continue; }
      if (/^whenever an opponent searches their library, you gain 1 life and draw a card/.test(low)) { a.triggers.push({ k: 'archivist' }); continue; }
      if (/^whenever an artifact or creature enters untapped and under an opponent's control, they may tap that permanent/.test(low)) { a.triggers.push({ k: 'conqueror' }); continue; }
      if (/^whenever you lose life, draw that many cards/.test(low)) { a.triggers.push({ k: 'vilis' }); continue; }
      if (/^whenever a player casts their second spell each turn, cardname connives/.test(low)) { a.triggers.push({ k: 'connive' }); continue; }
      if ((m = low.match(/^whenever you cast a spell from your graveyard,\s*(.*)$/))) { a.triggers.push({ k: 'gyCast', fx: PE(m[1]) }); continue; }
      if ((m = low.match(/^whenever one or more land cards are put into your graveyard from anywhere,\s*(.*)$/))) { a.triggers.push({ k: 'landToGy', fx: PE(m[1]) }); continue; }
      if ((m = low.match(/^whenever a creature deals combat damage to one of your opponents, its controller may pay 1 life\. if they do, they draw a card/))) { a.triggers.push({ k: 'gix' }); continue; }
      if ((m = low.match(/^when enchanted creature dies,\s*(.*)$/))) { a.enchDies = PE(m[1].replace(/that creature's controller may /, '')); continue; }
      if ((m = low.match(/^when(?:ever)? enchanted (?:creature|permanent) dies or is put into exile, return that card to the battlefield under your control/))) { a.ghostform = true; continue; }
      if ((m = low.match(/^whenever equipped creature dies,\s*(.*)$/))) { a.equipDies = PE(m[1]); continue; }
      if ((m = low.match(/^when(?:ever)? cardname dies,\s*(.*)$/))) { a.dies.push(...PE(m[1])); continue; }
      if ((m = low.match(/^whenever cardname attacks(?: for the first time each turn)?( an opponent)?,?\s*(.*)$/))) {
        if (/there is an additional combat phase/.test(low)) {
          a.attack.push({ k: 'extraCombat', untapAll: /untap all creatures you control/.test(low), dethrone: /most life/.test(low) });
        } else if (/put a creature card with mana value x or less from your hand onto the battlefield tapped and attacking, where x is the number of attacking creatures/.test(low)) {
          a.attack.push({ k: 'cheatAttack', subs: null, mvAttackers: true }); // (Kinscaer Sentry)
        } else if (/put an? ([a-z, ]+?) creature card from your hand onto the battlefield tapped and attacking/.test(low)) {
          const subs = low.match(/put an? ([a-z, ]+?) creature card/)[1].replace(/ or /g, ',').split(',').map((s) => cap(s.trim())).filter(Boolean);
          a.attack.push({ k: 'cheatAttack', subs });
        } else a.attack.push(...PE(m[2]));
        continue;
      }
      if ((m = low.match(/^whenever (?:cardname|equipped creature|enchanted creature|a creature you control) deals combat damage to (?:a player|an opponent),?\s*(.*)$/))) {
        a.combatDmg.push(...PE(m[1])); if (/^whenever equipped/.test(low)) a.equipCombat = true; continue;
      }
      if ((m = low.match(/^at the beginning of (your|each) upkeep,\s*(.*)$/))) { a.upkeep.push({ each: m[1] === 'each', fx: PE(m[2]), lose: +((m[2].match(/you lose (\d+) life/) || [])[1] || 0) }); continue; }
      if ((m = low.match(/^at the beginning of (your|each) end step,\s*(.*)$/))) { a.endstep.push({ each: m[1] === 'each', fx: PE(m[2]) }); continue; }
      if ((m = low.match(/^(?:eminence — )?whenever you cast (?:another|an|a)\b ?([a-z, ]*?) ?spell,\s*(.*)$/))) {
        a.castTrig.push({ filter: m[1], another: /another/.test(low), fx: PE(m[2]), eminence: /command zone/.test(low) }); continue;
      }
      if (/^whenever another nontoken creature you control dies, you may exile it\. if you do, create a token that's a copy of that card, except it's an enchantment/.test(low)) { a.triggers.push({ k: 'myrkul' }); continue; }
      if ((m = low.match(/^whenever (cardname or another creature(?: or planeswalker)?|another creature|a creature|a creature you control|another creature you control|a nontoken creature you control|another nontoken creature you control|a creature an opponent controls|cardname or another creature(?: or planeswalker)? you control|a creature you don't control) dies,\s*(.*)$/))) {
        const scope = /opponent controls|don't control/.test(m[1]) ? 'opp' : /you control/.test(m[1]) ? 'mine' : 'any';
        a.deathWatch.push({ scope, nontoken: /nontoken/.test(m[1]), fx: PE(m[2]), orSelf: /^cardname or another/.test(m[1]) }); continue;
      }
      if (/^whenever you gain life, (?:target|each) opponent loses that much life/.test(low)) { a.triggers.push({ k: 'bond' }); continue; }
      if (/^whenever an opponent loses life, you gain that much life/.test(low)) { a.triggers.push({ k: 'exquisite' }); continue; }
      if (/^whenever an opponent casts a spell, you may draw a card unless that player pays \{1\}/.test(low)) { a.triggers.push({ k: 'rhystic' }); continue; }
      if (/^whenever an opponent draws a card, that player may pay \{2\}/.test(low)) { a.triggers.push({ k: 'tithe' }); continue; }
      if (/^whenever an opponent casts their first noncreature spell each turn, draw a card unless/.test(low) || /^whenever an opponent casts a noncreature spell, .* draw a card/.test(low)) { a.triggers.push({ k: 'sentinel' }); continue; }
      if (/^whenever you gain life, /.test(low)) { a.triggers.push({ k: 'onGain', fx: PE(low.replace(/^whenever you gain life, /, '')) }); continue; }
      if (/^(?:a|another|other|each) ?creature(?:s)? (?:you control )?(?:enters|enter)/.test(low)) continue;
      if (/creatures? you control (?:enter|enters) tapped|your opponents can't cast spells during your turn|during your turn, your opponents can't cast spells/.test(low)) {
        if (/your opponents can't cast spells during your turn|during your turn, your opponents can't cast spells/.test(low)) a.statics.push({ k: 'abolisher' });
        continue;
      }
      if (/during each of your turns, you may play a land and cast a permanent spell of each permanent type from your graveyard/.test(low)) { a.statics.push({ k: 'muldrotha' }); continue; }
      if (/^if an effect would create one or more tokens under your control, it creates twice that many/.test(low)) { a.statics.push({ k: 'tokenDouble' }); continue; } // its counter sentence is its own line (counterDouble below)
      if (/^if one or more tokens would be created under your control, twice that many/.test(low)) { a.statics.push({ k: 'tokenDouble' }); continue; }
      if (/^if one or more \+1\/\+1 counters would be put on a (?:creature|permanent) you control, that many plus one/.test(low)) { a.statics.push({ k: 'counterPlus' }); continue; }
      // Doubling Season: only counters put on by effects (a planeswalker's + loyalty cost isn't an effect)
      if (/^if an effect would put one or more counters on a permanent you control, it puts twice that many/.test(low)) { a.statics.push({ k: 'counterDouble', effectOnly: true }); continue; }
      if (/^other permanents you control have indestructible/.test(low)) { a.statics.push({ k: 'allIndestructible' }); continue; }
      if (/^artifacts you control have indestructible/.test(low)) { a.statics.push({ k: 'artIndestructible' }); continue; }
      if (/^other permanents you control have hexproof/.test(low)) { a.statics.push({ k: 'allHexproof' }); continue; }
      if (/^you can't lose the game and your opponents can't win the game/.test(low)) { a.statics.push({ k: 'platinum' }); continue; }
      if (/isn't a creature/.test(low) && /devotion/.test(low)) { a.godDevotion = true; continue; }
      if (/^if one or more tokens would be created under your control, those tokens plus that many 1\/1 green squirrel/.test(low)) { a.statics.push({ k: 'chatterfang' }); continue; }
      if ((m = low.match(/^whenever you draw a card, you gain (\d+) life/))) { a.triggers.push({ k: 'drawGain', n: +m[1] }); continue; }
      if ((m = low.match(/^whenever an opponent draws a card, (?:they|that player) loses? (\d+) life/))) { a.triggers.push({ k: 'oppDrawLose', n: +m[1] }); continue; }
      if (/^whenever another nontoken creature you control dies, you may exile it\. if you do, create a token that's a copy of that card, except it's an enchantment/.test(low)) { a.triggers.push({ k: 'myrkul' }); continue; }
      if ((m = low.match(/^at the beginning of each opponent's upkeep,\s*(.*)$/))) { a.upkeep.push({ opp: true, fx: PE(m[1]), lose: 0 }); continue; }
      if (/would put one or more counters on a permanent or player, put twice that many/.test(low)) { a.statics.push({ k: 'counterDouble' }); continue; }
      if (/^if a source you control would deal damage to a permanent or player, it deals triple that damage/.test(low)) { a.statics.push({ k: 'dmgTriple' }); continue; }
      if (/^if a source you control would deal damage to a permanent or player, it deals double that damage/.test(low)) { a.statics.push({ k: 'dmgDouble' }); continue; }
      if (/^if a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage/.test(low)) { a.statics.push({ k: 'gisela' }); continue; }
      if (/^if a source would deal damage to you or a permanent you control, prevent half that damage/.test(low)) continue;
      if (/^whenever another creature you control enters, cardname deals damage equal to that creature's power to any target/.test(low)) { a.triggers.push({ k: 'terror' }); continue; }
      if (/^whenever a dragon you control enters, it deals x damage to any target, where x is the number of dragons you control/.test(low)) { a.triggers.push({ k: 'dragonTempest' }); continue; }
      if (/^whenever a creature you control with flying enters, it gains haste/.test(low)) { a.triggers.push({ k: 'flyHaste' }); continue; }
      if ((m = low.match(/^whenever an? ([a-z]+) you control attacks, (.*)$/))) { a.triggers.push({ k: 'tribalAttack', sub: cap(m[1]), fx: PE(m[2]) }); continue; }
      // "whenever you attack": once per attack (Raffine's connive, Chocobo Knights)
      if (/^whenever you attack, target attacking creature connives x, where x is the number of attacking creatures/.test(low)) { a.triggers.push({ k: 'youAttack', fx: [{ k: 'conniveAttacker' }] }); continue; }
      if ((m = low.match(/^whenever you attack, creatures you control with counters on them gain ([a-z ]+) until end of turn/))) { a.triggers.push({ k: 'youAttack', fx: [{ k: 'countersKw', kw: m[1].trim() }] }); continue; }
      if (/^creatures you control with \+1\/\+1 counters on them can't be blocked/.test(low)) { a.statics.push({ k: 'counterUnblockable' }); continue; } // (Herald of Secret Streams)
      if ((m = low.match(/^noncreature spells cost \{(\d+)\} more to cast/))) { a.statics.push({ k: 'taxNoncreature', n: +m[1] }); continue; } // (Thalia, for everyone)
      if ((m = low.match(/^cardname gets \+(\d+)\/\+0 for every (\w+) cards in your graveyard/))) { a.gyPower = { p: +m[1], per: num(m[2]) }; continue; } // (Dark Matter Manipulator)
      if (/^as an additional cost to cast cardname, exile (\w+) cards from your graveyard/.test(low)) { a.addCost = 'exileGy:' + num(low.match(/exile (\w+) cards/)[1]); continue; } // (Abhorrent Oculus)
      if (/^whenever one or more permanent cards are put into your graveyard from anywhere while cardname has a -1\/-1 counter on it, remove a -1\/-1 counter/.test(low)) { a.gyShrinkRemove = true; continue; } // (Moonshadow)
      if (/^whenever you cycle or discard another card, put a -1\/-1 counter on each creature your opponents control/.test(low)) { a.triggers.push({ k: 'discardShrink' }); continue; } // (Archfiend of Ifnir)
      if (/^activated abilities of artifacts your opponents control can't be activated/.test(low)) { a.statics.push({ k: 'karn' }); continue; }
      if (/^all permanents are artifacts in addition to their other types/.test(low)) { a.statics.push({ k: 'lattice' }); continue; }
      if (/^whenever you activate an ability, if it isn't a mana ability, you may pay \{2\}\. if you do, copy that ability/.test(low)) { a.statics.push({ k: 'rings' }); continue; }
      if (/can only attack alone/.test(low)) { a.attackAlone = true; continue; }
      if (/attacks a player and isn't blocked, that player's life total becomes 1/.test(low)) { a.masterOfCruelties = true; continue; }
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
        const fx = parseEffects(m[2]);
        if (/Sacrifice (a|another) creature/i.test(costText) && !a.sacOutlet) a.sacOutlet = { tap: /\{T\}/.test(costText), life: +(costText.match(/Pay (\d+) life/) || [])[1] || 0, mana: (costText.match(/\{(\d+|[WUBRGC])\}/g) || []).length, fx, addsMana: /Add \{/.test(m[2]) };
        if (/Add \{/.test(m[2])) continue; // mana ability, handled separately
        if (!fx.length && !a.sacOutlet) a.unmodeled.push(line);
        if (fx.length) {
          const mana = costText.match(/\{(\d+|[WUBRGCX](?:\/[WUBRGP])?)\}/g) || []; // (hybrid / Phyrexian {G/P} too: Birthing Pod)
          const cost = parseCost(mana.map((x) => x.slice(1, -1)).join(' ').replace(/\bX\b/g, ''));
          if (/Sacrifice (a|another) creature/i.test(costText)) a.sacOutlet = { tap: /\{T\}/.test(costText), life: +(costText.match(/Pay (\d+) life/) || [])[1] || 0, mana: cost.mv, cost, fx: fx };
          const sacN = (re) => { const mm = costText.match(re); return mm ? num(mm[1]) : 0; };
          a.activated.push({ sacCreature: sacN(/Sacrifice (a|an|another|two|three) (?:[a-z]+ )?creatures?/i), sacArtifactN: sacN(/Sacrifice (an|a|two|three) artifacts?/i), discard: sacN(/Discard (a|two) cards?/i), tap: /\{T\}/.test(costText), sac: /Sacrifice CARDNAME/i.test(costText), sacOther: /Sacrifice (a|an|another) /i.test(costText) && !/CARDNAME/.test(costText), cost, fx, life: +(costText.match(/Pay (\d+) life/) || [])[1] || 0, text: m[2], sorcery: /activate only as a sorcery/i.test(line) });
        }
        continue;
      }
      if ((m = line.match(/^Channel — ((?:\{[^}]+\})+), Discard CARDNAME: (.*)$/i))) {
        a.channel = { cost: parseCost(m[1].match(/\{([^}]+)\}/g).map((x) => x.slice(1, -1)).join(' ')), fx: parseEffects(m[2]) };
        if (/destroy target artifact, enchantment, or nonbasic land/i.test(m[2])) a.channel.fx = [{ k: 'removal', what: 'artench' }];
        if (/return target artifact, creature, enchantment, or planeswalker to its owner's hand/i.test(m[2])) a.channel.fx = [{ k: 'removal', what: 'nonland', bounce: true }];
        continue;
      }
      if (/^(equip|enchant|cycling|madness|convoke|ward|dash|flash|kicker|ninjutsu|cascade|storm|affinity|improvise|delve|undying|persist|partner|eminence|morph|escape|unearth|flashback|channel|buyback|mutate|encore|blitz|evoke)\b/.test(low)) {
        if (/^ward—pay (\d+) life/.test(low)) a.wardLife = +low.match(/^ward—pay (\d+) life/)[1];
        if (/^ward—sacrifice/.test(low)) a.wardSac = true;
        if (/^ward \{(\d+)\}/.test(low)) a.wardMana = +low.match(/^ward \{(\d+)\}/)[1];
        if (/^convoke/.test(low)) a.convoke = true;
        if (/^delve/.test(low)) a.delve = true;
        if (/^ward/.test(low)) a.kw.add('ward');
        if (/^undying/.test(low)) a.kw.add('undying');
        if (/^persist/.test(low)) a.kw.add('persist');
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
      if (!/^T\b/.test(cost) && cost !== 'T' && !/^\d+ T$/.test(cost) && !/^Sac<1\/(Artifact|Creature)/.test(cost)) continue;
      const extraGeneric = 0;
      let netGeneric = 0, fm;
      if (/Sac<1\/CARDNAME>/.test(cost)) oneShot = true;
      else if ((fm = cost.match(/^(T )?Sac<1\/(Creature|Artifact)(\.Other)?>$/))) {
        const prod = m.produced.split(/\s+/).filter((x) => COLORS.includes(x) || x === 'C');
        a.fodderMana = { what: fm[2], amount: Math.max(m.amount || 1, prod.length), colors: [...new Set(prod)], tap: !!fm[1] };
        continue;
      }
      else if ((m.cost || '').match(/^(\d+) T$/)) { netGeneric = +m.cost.match(/^(\d+) T$/)[1]; }
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
      if (netGeneric) { amount -= netGeneric; if (amount <= 0) continue; }
      const dmg = +(((face.oracle || '').match(/deals (\d+) damage to you/) || [])[1] || 0);
      const dmgApplies = dmg && !(face.mana.length > 1 && colors.length === 1 && colors[0] === 'C');
      const payLife = +((cost.match(/PayLife<(\d+)>/) || [])[1] || 0);
      opts.push({ colors: [...new Set(colors)], amount, dmg: (dmgApplies ? dmg : 0) + payLife, extraGeneric });
    }
    const otext = (face.oracle || '');
    if (/Add \{G\} for each creature you control/.test(otext)) a.cradle = true;
    if (/Add \{B\} for each Swamp you control/.test(otext)) { a.coffers = true; opts.length = 0; opts.push({ colors: ['B'], amount: 1, dmg: 0 }); }
    if (a.name === 'Chrome Mox' || a.name === 'Mox Diamond') opts.push({ colors: deckColors.slice(), amount: 1, dmg: 0 });
    if (a.name === 'Fellwar Stone') opts.push({ colors: COLORS.slice(), amount: 1, dmg: 0 });
    if (a.name === "Urza's Saga") opts.push({ colors: ['C'], amount: 1, dmg: 0 });
    if (a.isLand && !opts.length) {
      const basic = a.subtypes.map((s) => BASIC_TYPES[s]).filter(Boolean);
      if (basic.length) opts.push({ colors: basic, amount: 1, dmg: 0 });
    }
    if (opts.length) a.mana = { opts, oneShot, dork: a.isCreature };
    if (a.isLand) a.unmodeled = a.unmodeled.filter((l) => !/enters tapped|you may pay [23] life|return a land you control to its owner.s hand|becomes tapped, it deals 1 damage/i.test(l));
    // lines whose keyword is implemented elsewhere (the keyword list / enterBattlefield)
    const kwDone = [[a.delve, /^delve/i], [a.mobilize, /^mobilize/i], [a.ravenous, /^ravenous/i], [a.evolve, /^evolve/i], [a.miracle, /^miracle/i], [a.spree, /^spree/i], [a.transmute, /^transmute/i], [true, /^replicate \{/i], [a.altCost && a.altCost.kind === 'webSling', /^web-slinging/i], [a.gift, /^gift a card/i], [a.etbMinus, /enters with (a|one|two|three|four|five|six|\w+) -1\/-1 counters? on it/i], [a.wardMana, /^(flying, )?ward \{\d+\}$/i]];
    a.unmodeled = a.unmodeled.filter((l) => !kwDone.some(([on, re]) => on && re.test(l)));
    if (a.isLand) {
      const lo = otext.toLowerCase();
      a.etbTapped = /enters tapped|enters the battlefield tapped/.test(lo) && !/unless|if you don't|if you control two or more other lands/.test(lo);
      let m2;
      if ((m2 = lo.match(/enters tapped unless you control an? (\w+) or an? (\w+)/))) a.etbCond = { k: 'types', types: [cap(m2[1]), cap(m2[2])] };
      else if (/enters tapped unless you control two or fewer other lands/.test(lo)) a.etbCond = { k: 'fast' };
      else if (/enters tapped unless you control two or more other lands/.test(lo)) a.etbCond = { k: 'slow' };
      else if (/if you control two or more other lands, .* enters tapped/.test(lo)) a.etbCond = { k: 'fast' };
      else if (/enters tapped unless you control two or more basic lands/.test(lo)) a.etbCond = { k: 'basics' };
      else if (/enters tapped unless you control a legendary creature/.test(lo)) a.etbCond = { k: 'legend' };
      else if (/enters tapped unless you have two or more opponents/.test(lo)) a.etbCond = { k: 'opps' };
      a.shock = /you may pay 2 life\. if you don't, it enters tapped/.test(lo) || /you may pay 3 life\. if you don't, it enters tapped/.test(lo);
      const fm = lo.match(/sacrifice cardname: search your library for an? ([a-z ]+?) card/) || lo.match(/sacrifice [a-z' ]+: search your library for an? ([a-z ]+?) card/);
      if (fm && !opts.length) {
        a.fetch = { types: fm[1].split(/ or /).map((s) => s.trim()), tapped: /onto the battlefield tapped/.test(lo) };
      }
      if (/return a land you control to its owner's hand/.test(lo)) a.bounceLand = true;
    }
    return a;
  }

  // ---------- per-card scripts ----------
  // Cards whose text needs bespoke handling. Each script sets flags/effects the engine understands,
  // and `cover` marks which rules-text lines it accounts for (the audit uses this).
  const ALL = /./;
  const SCRIPTS = {
    // spree: a base cost plus one or more modes, each with its own extra cost (see spreeModes)
    'Insatiable Avarice': (a, cover) => { a.spree = [{ cost: parseCost('2'), fx: [{ k: 'tutor', what: 'card', top: true }] }, { cost: parseCost('B B'), fx: [{ k: 'draw', n: 3 }, { k: 'loseSelf', n: 3 }] }]; a.spell = a.spree.flatMap((m) => m.fx); cover(ALL); },
    'Cephalid Coliseum': (a, cover) => { a.activated.push({ tap: true, sac: true, cost: parseCost('U'), threshold: 7, fx: [{ k: 'loot', draw: 3, n: 3 }], text: 'Threshold: draw three cards, then discard three.' }); cover(ALL); },
    'Psychic Frog': (a, cover) => { a.activated.push({ cost: parseCost(''), exileGy: 3, fx: [{ k: 'kwSelf', kw: 'flying' }], text: 'Exile three cards from your graveyard: gains flying until end of turn.' }); cover(/^Exile three cards from your graveyard/i); },
    'Liliana the Repentant': (a, cover) => { (a.myCreatureEtb = a.myCreatureEtb || []).push([{ k: 'mill', n: 2 }]); a.activated.push({ cost: parseCost('5 B'), sorcery: true, exhaust: true, exhaustCounter: true, fx: [{ k: 'reanimate', any: false }], text: 'Exhaust: return a creature card from your graveyard to the battlefield; a +1/+1 counter on Liliana.' }); cover(ALL); },
    'Ainok Strike Leader': (a, cover) => { a.tokenShield = true; cover(/^Sacrifice CARDNAME: Creature tokens you control gain indestructible/i); },
    'Bruna, the Fading Light': (a, cover) => { a.castSelf = [{ k: 'reanimate', subs: ['Angel', 'Human'] }]; cover(/^When you cast CARDNAME/i); },
    'Gisela, the Broken Blade': (a, cover) => { a.meldWith = 'Bruna, the Fading Light'; cover(/^At the beginning of your end step, if you both own and control/i); },
    'Brisela, Voice of Nightmares': (a, cover) => { a.statics.push({ k: 'brisela' }); a.mv = 11; cover(ALL); },
    'Grim Hireling': (a, cover) => { a.activated.push({ cost: parseCost('B'), sorcery: true, fx: [{ k: 'hireling' }], text: '{B}, Sacrifice X Treasures: Target creature gets -X/-X until end of turn.' }); cover(/^\{B\}, Sacrifice X Treasures/i); },
    'Hydroelectric Specimen': (a, cover) => { a.specimen = true; cover(/^When CARDNAME enters, you may change a target/i); },
    'Guide of Souls': (a, cover) => { a.myCreatureEtb = [[{ k: 'gain', n: 1 }, { k: 'energy', n: 1 }]]; a.triggers.push({ k: 'youAttack', fx: [{ k: 'guideAngel' }] }); cover(ALL); },
    'The Queen of Dale': (a, cover) => { a.triggers.push({ k: 'queenRecruit' }); cover(ALL); },
    'Disciple of Deceit': (a, cover) => { a.inspiredTutor = true; a.statics = a.statics.filter((x) => x.k !== 'misc'); cover(ALL); },
    'Archon of Cruelty': (a, cover) => { a.etb = [{ k: 'edict', one: true }, { k: 'discard', n: 1, one: true }, { k: 'drainOne', n: 3 }, { k: 'draw', n: 1 }]; a.attack = a.etb.map((f) => ({ ...f })); cover(ALL); },
    'Wonder': (a, cover) => { a.gyFlyIsland = true; cover(ALL); }, // (from the graveyard with an Island out: our creatures fly; see _kws)
    'Academy Rector': (a, cover) => { a.dies = [{ k: 'rectorExile' }, { k: 'search', n: 1, what: 'enchantment', dest: 'bf', needsRector: true }]; cover(/dies/); },
    'Sun Titan': (a, cover) => { a.etb = [{ k: 'reanimate', any: false, mvMax: 3, perm: true, lands: true }]; a.attack = [{ k: 'reanimate', any: false, mvMax: 3, perm: true, lands: true }]; cover(ALL); },
    'Vindicate': (a, cover) => { a.spell = [{ k: 'removal', what: 'permanent' }]; cover(ALL); },
    'Angel of Despair': (a, cover) => { a.etb = [{ k: 'removal', what: 'permanent' }]; cover(ALL); },
    'Patron of the Vein': (a, cover) => { a.deathWatch = a.deathWatch.map((w) => ({ ...w, fx: [{ k: 'exileDead' }, ...w.fx] })); cover(ALL); },
    'Arena Rector': (a, cover) => { a.dies = [{ k: 'rectorExile' }, { k: 'search', n: 1, what: 'planeswalker', dest: 'bf', needsRector: true }]; cover(/dies/); },
    'Ajani Steadfast': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'pump', p: 1, t: 1, kw: ['first strike', 'vigilance', 'lifelink'] }]; a.loyaltyAbs[1].fx = [{ k: 'counters', n: 1, on: 'each' }, { k: 'loyaltyEach', other: true }]; a.loyaltyAbs[2].fx = [{ k: 'emblem', e: 'damageCap1' }]; cover(ALL); },
    'Brokers Ascendancy': (a, cover) => { a.endstep = [{ each: false, fx: [{ k: 'counters', n: 1, on: 'each' }, { k: 'loyaltyEach' }] }]; cover(ALL); },
    'Alibou, Ancient Witness': (a, cover) => { a.statics.push({ k: 'artifactHaste' }); cover(/haste/); },
    "Archaeomancer's Map": (a, cover) => { a.etb = [{ k: 'ramp', bf: 0, hand: 2, landTypes: ['Plains'], basicOnly: true }]; a.triggers.push({ k: 'mapCatchUp' }); cover(ALL); },
    'Archfiend of Despair': (a, cover) => { a.statics.push({ k: 'noOppGain' }); a.endstep = [{ each: true, fx: [{ k: 'archfiend' }] }]; cover(ALL); },
    "Archon of Sun's Grace": (a, cover) => { a.statics.push({ k: 'anthem', sub: 'Pegasus', p: 0, t: 0, kw: ['lifelink'] }); a.constellation = [[{ k: 'tokens', n: 1, p: 2, t: 2, sub: 'Pegasus', colors: 'white', kw: ['flying'] }]]; a.statics = a.statics.filter((x) => x.k !== 'misc'); cover(ALL); },
    'Astral Cornucopia': (a, cover) => { a.chargeX = true; a.mana = { opts: [{ colors: COLORS.slice(), amount: 0, dmg: 0 }], oneShot: false, charge: true }; cover(ALL); },
    'Audacious Reshapers': (a, cover) => { a.activated.push({ tap: true, sacArtifact: 1, cost: parseCost(''), fx: [{ k: 'revealUntil', what: 'artifact', dest: 'bf', selfDamage: true }], text: 'Reveal until an artifact and put it onto the battlefield' }); cover(ALL); },
    'Authority of the Consuls': (a, cover) => { a.statics.push({ k: 'oppEnterTapped' }); a.oppCreatureEtb = [[{ k: 'gain', n: 1 }]]; cover(ALL); },
    'Avenger of Zendikar': (a, cover) => { a.etb = [{ k: 'tokens', n: 'LANDS', p: 0, t: 1, sub: 'Plant', colors: 'green', kw: [] }]; a.landfall = [[{ k: 'counters', n: 1, on: 'each', sub: 'Plant' }]]; cover(ALL); },
    'Balefire Dragon': (a, cover) => { a.combatDmg = [{ k: 'balefire' }]; cover(ALL); },
    'Basalt Monolith': (a, cover) => { a.noUntap = true; cover(ALL); },
    'Mana Vault': (a, cover) => { a.noUntap = true; a.vault = true; if (a.mana) a.mana.opts = a.mana.opts.map((o) => ({ ...o, dmg: 0 })); cover(ALL); },
    "Battlemage's Bracers": (a, cover) => { a.statics.push({ k: 'equipBuff', p: 0, t: 0, kw: ['haste'] }); a.bracers = true; cover(ALL); },
    'Baxter Building': (a, cover) => { a.filterLand = true; cover(ALL); },
    'Beledros Witherbloom': (a, cover) => { a.beledros = true; cover(/pay 10 life/i); },
    'Bitter Triumph': (a, cover) => { a.addCost = 'discardOrLife3'; cover(/additional cost/i); },
    'Black Market Connections': (a, cover) => { a.bmc = true; a.statics = a.statics.filter((x) => x.k !== 'misc'); cover(ALL); },
    'Blightsteel Colossus': (a, cover) => { a.shuffleBack = true; cover(ALL); },
    'Bloodghast': (a, cover) => { a.cantBlock = true; a.hasteIfOppLow = 10; a.gyLandfall = true; cover(ALL); },
    'Bloodgift Demon': (a, cover) => { a.upkeep = [{ each: false, fx: [{ k: 'bloodgift' }], lose: 0 }]; cover(ALL); },
    'Bloodletter of Aclazotz': (a, cover) => { a.statics.push({ k: 'bloodletter' }); cover(ALL); },
    'Bloodline Keeper // Lord of Lineage': (a, cover) => { a.transformAt = { tribe: 'Vampire', count: 5, cost: 'B' }; cover(ALL); },
    'Bloodthirster': (a, cover) => { a.combatDmg = [{ k: 'extraCombat', untapSelf: true, newTarget: true }]; cover(ALL); },
    'Bloom Tender': (a, cover) => { a.mana = { opts: [{ colors: COLORS.slice(), amount: 1, dmg: 0 }], oneShot: false, dork: true, bloom: true }; cover(ALL); },
    'Bojuka Bog': (a, cover) => { a.etb = [{ k: 'graveHate' }]; cover(ALL); },
    "Bolas's Citadel": (a, cover) => { a.citadel = true; a.activated = [{ tap: true, sacNonland: 10, cost: parseCost(''), fx: [{ k: 'drain', n: 10 }], text: 'Sacrifice ten nonland permanents: each opponent loses 10 life.' }]; cover(ALL); },
    'Boros Charm': (a, cover) => { a.spell = [{ k: 'damage', n: 4, to: 'target player' }]; a.modalProtect = true; a.holdUnlessLethal = true; cover(ALL); },
    'Captain Sisay': (a, cover) => { a.activated = []; a.activated.push({ tap: true, cost: parseCost(''), fx: [{ k: 'search', n: 1, what: 'legendary', dest: 'hand' }], text: 'Search for a legendary card.' }); cover(ALL); },
    'Carth the Lion': (a, cover) => { a.etb = [{ k: 'dig', n: 7, types: ['planeswalker'] }]; a.statics.push({ k: 'carth' }); a.pwDiesDig = true; cover(ALL); },
    'Cathartic Reunion': (a, cover) => { a.addCost = 'discard2'; cover(/additional cost/i); },
    'Thrill of Possibility': (a, cover) => { a.addCost = 'discard1'; cover(/additional cost/i); },
    'Village Rites': (a, cover) => { a.addCost = 'sacCreature'; cover(/additional cost/i); },
    'Crop Rotation': (a, cover) => { a.addCost = 'sacLand'; a.spell = [{ k: 'search', n: 1, what: 'land', dest: 'bf' }]; cover(ALL); },
    'Cavern of Souls': (a, cover) => { a.cavern = true; cover(ALL); },
    'Secluded Courtyard': (a, cover) => { cover(ALL); },
    'Unclaimed Territory': (a, cover) => { cover(ALL); },
    'Chatterfang, Squirrel General': (a, cover) => { a.landwalk = 'Forest'; a.activated = [{ sacSquirrels: true, cost: parseCost('B'), fx: [{ k: 'squirrelKill' }], text: 'Sacrifice squirrels to shrink a creature.' }]; cover(ALL); },
    'Chromatic Lantern': (a, cover) => { a.lantern = true; cover(ALL); },
    'Chrome Mox': (a, cover) => { cover(ALL); },
    'Cinderhaze Wretch': (a, cover) => { a.activated = [{ tap: true, cost: parseCost(''), fx: [{ k: 'discard', n: 1, one: true }], text: 'Target player discards a card.', untapWithCounter: true }]; cover(ALL); },
    'Devoted Druid': (a, cover) => { a.mana.opts = a.mana.opts.map((o) => ({ ...o, amount: 2 })); a.druid = true; cover(ALL); },
    'City of Brass': (a, cover) => { cover(ALL); },
    'Crucible of Worlds': (a, cover) => { a.statics.push({ k: 'crucible' }); cover(ALL); },
    'Crystalline Crawler': (a, cover) => { a.converge = true; a.counterMana = true; cover(ALL); },
    'Culling Ritual': (a, cover) => { a.spell = [{ k: 'wipe', what: 'mv2', addMana: true }]; cover(ALL); },
    'Cursed Mirror': (a, cover) => { a.copy = { what: 'creature', any: true, eot: true, haste: true, optional: true }; cover(ALL); },
    'Phantasmal Image': (a, cover) => { a.copy = { what: 'creature', any: true }; cover(ALL); },
    'Spark Double': (a, cover) => { a.copy = { what: 'creaturepw', own: true, plusOne: true, nonLegendary: true }; cover(ALL); },
    "Sakashima of a Thousand Faces": (a, cover) => { a.copy = { what: 'creature', own: true, keepAbilities: true }; a.statics.push({ k: 'noLegendRule' }); cover(ALL); },
    'Sculpting Steel': (a, cover) => { a.copy = { what: 'artifact', any: true }; cover(ALL); },
    'Daretti, Scrap Savant': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'loot', n: 2 }]; a.loyaltyAbs[1].fx = [{ k: 'darettiWeld' }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -10); if (ult) ult.fx = [{ k: 'emblem', e: 'artifactRecursion' }]; cover(ALL); },
    'Dauthi Voidwalker': (a, cover) => { a.kw.add('shadow'); a.statics.push({ k: 'voidExile' }); a.activated = [{ tap: true, sac: true, cost: parseCost(''), fx: [{ k: 'castVoid' }], text: 'Play an exiled card with a void counter for free.' }]; cover(ALL); },
    'Valgavoth, Terror Eater': (a, cover) => { a.statics.push({ k: 'voidExile', valgavoth: true }); cover(ALL); },
    'Deepglow Skate': (a, cover) => { a.etb = [{ k: 'doubleCounters' }]; cover(ALL); },
    'Defense of the Heart': (a, cover) => { a.upkeep = [{ each: false, fx: [{ k: 'defenseOfHeart' }], lose: 0 }]; cover(ALL); },
    'Deflecting Swat': (a, cover) => { a.spell = []; a.redirect = true; a.freeIfCommander = true; cover(ALL); },
    'Redirect Lightning': (a, cover) => { a.spell = []; a.redirect = true; cover(ALL); },
    'Den of the Bugbear': (a, cover) => { a.activated = []; a.manland = { cost: '3 R', p: 3, t: 2, sub: 'Goblin', colors: ['R'], attackToken: true }; cover(ALL); },
    'Drana, Liberator of Malakir': (a, cover) => { a.combatDmg = [{ k: 'counters', n: 1, on: 'attacking' }]; cover(ALL); },
    'Drannith Magistrate': (a, cover) => { a.statics.push({ k: 'drannith' }); cover(ALL); },
    'Dryad of the Ilysian Grove': (a, cover) => { a.allBasicTypes = true; cover(ALL); },
    'Urborg, Tomb of Yawgmoth': (a, cover) => { a.addsLandType = 'Swamp'; cover(ALL); },
    'Yavimaya, Cradle of Growth': (a, cover) => { a.addsLandType = 'Forest'; cover(ALL); },
    'Edgar, Charmed Groom // Edgar Markov\'s Coffin': (a, cover) => { a.diesTransform = true; cover(ALL); },
    "Edgar Markov's Coffin": (a, cover) => { a.coffin = true; a.upkeep = [{ each: false, fx: [{ k: 'tokens', n: 1, p: 1, t: 1, sub: 'Vampire', colors: 'white black', kw: ['lifelink'] }, { k: 'coffin' }], lose: 0 }]; },
    'Eidolon of Blossoms': (a, cover) => { a.statics = a.statics.filter((x) => x.k !== 'misc'); if (!a.constellation) a.constellation = [[{ k: 'draw', n: 1 }]]; cover(ALL); },
    'Setessan Champion': (a, cover) => { a.statics = a.statics.filter((x) => x.k !== 'misc'); a.constellation = [[{ k: 'counters', n: 1, on: 'self' }, { k: 'draw', n: 1 }]]; cover(ALL); },
    'Eldrazi Monument': (a, cover) => { a.upkeep = [{ each: false, fx: [{ k: 'sacCreatureOrSelf' }], lose: 0 }]; cover(ALL); },
    "Elspeth, Sun's Champion": (a, cover) => { const ult = a.loyaltyAbs.find((x) => x.delta <= -7); if (ult) ult.fx = [{ k: 'emblem', e: 'elspeth' }]; cover(ALL); },
    'Emeritus of Woe // Demonic Tutor': (a, cover) => { a.prepared = { cost: '1 B', fx: [{ k: 'tutor', what: 'card' }], name: 'Demonic Tutor' }; cover(ALL); },
    'Enduring Tenacity': (a, cover) => { a.returnsAsEnchantment = true; cover(/dies/); },
    'Ethersworn Canonist': (a, cover) => { a.statics.push({ k: 'canonist' }); cover(ALL); },
    'Everflowing Chalice': (a, cover) => { a.multikicker = 2; a.mana = { opts: [{ colors: ['C'], amount: 0, dmg: 0 }], oneShot: false, charge: true }; cover(ALL); },
    'Farewell': (a, cover) => { a.spell = [{ k: 'wipe', what: 'farewell', exile: true }]; cover(ALL); },
    'Feldon of the Third Path': (a, cover) => { a.activated = [{ tap: true, cost: parseCost('2 R'), fx: [{ k: 'feldon' }], text: 'Make a hasty token copy of a creature card in your graveyard.' }]; cover(ALL); },
    'Field of the Dead': (a, cover) => { cover(ALL); },
    'Force of Negation': (a, cover) => { cover(ALL); }, // (alternative cost: parseAltCost)
    'Forsaken Monument': (a, cover) => { a.monument = true; cover(ALL); },
    'Foundry Inspector': (a, cover) => { a.statics.push({ k: 'reduce', what: 'artifact', n: 1 }); cover(ALL); },
    'Ugin, the Ineffable': (a, cover) => { a.statics.push({ k: 'reduce', what: 'colorless', n: 2 }); const m3 = a.loyaltyAbs.find((x) => x.delta === -3); if (m3) m3.fx = [{ k: 'removal', what: 'colored' }]; const p1 = a.loyaltyAbs.find((x) => x.delta === 1); if (p1) p1.fx = [{ k: 'uginPlus' }]; cover(/cost/); },
    'Oath of Ajani': (a, cover) => { a.statics.push({ k: 'reduce', what: 'planeswalker', n: 1 }); cover(/cost/); },
    'The Great Henge': (a, cover) => { a.henge = true; cover(/costs \{X\} less/); },
    'Gravebreaker Lamia': (a, cover) => { a.etb = [{ k: 'search', n: 1, what: 'card', dest: 'gy' }]; a.statics.push({ k: 'reduceGy', n: 1 }); cover(ALL); },
    'Zirda, the Dawnwaker': (a, cover) => { a.statics.push({ k: 'reduceAbilities', n: 2 }); a.activated = [{ tap: true, cost: parseCost('1'), fx: [{ k: 'noBlock' }], text: 'Target creature can\'t block this turn.' }]; cover(ALL); },
    "Galadriel's Dismissal": (a, cover) => { a.spell = [{ k: 'protect', single: true }]; a.kickerProtectAll = parseCost('2 W'); cover(ALL); },
    'Garruk, Apex Predator': (a, cover) => { const ult = a.loyaltyAbs.find((x) => x.delta <= -8); if (ult) ult.fx = [{ k: 'emblem', e: 'garruk' }]; cover(ALL); },
    'Giver of Runes': (a, cover) => { a.runes = { another: true }; cover(ALL); },
    'Mother of Runes': (a, cover) => { a.runes = { another: false }; cover(ALL); },
    'Gix, Yawgmoth Praetor': (a, cover) => { a.activated = [{ cost: parseCost('4 B B B'), fx: [{ k: 'gixExile' }], text: 'Discard X cards: exile the top X of an opponent\'s library and play them free.' }]; cover(ALL); },
    'Glacial Chasm': (a, cover) => { a.statics.push({ k: 'chasm' }); a.cumulativeLife = 2; cover(ALL); },
    'Goblin Engineer': (a, cover) => { a.etb = [{ k: 'search', n: 1, what: 'artifact', dest: 'gy' }]; a.activated = [{ tap: true, sacArtifact: 1, cost: parseCost('1'), fx: [{ k: 'reanimateArtifact', mvMax: 3 }], text: 'Return an artifact with mana value 3 or less from your graveyard.' }]; cover(ALL); },
    'Goblin Welder': (a, cover) => { a.activated = [{ tap: true, cost: parseCost(''), fx: [{ k: 'weld' }], text: 'Swap an artifact for a better one in the graveyard.' }]; cover(ALL); },
    'Goldspan Dragon': (a, cover) => { a.statics.push({ k: 'goldspan' }); cover(/Treasures you control/); },
    'Grand Abolisher': (a, cover) => { cover(ALL); },
    'Greater Auramancy': (a, cover) => { a.statics.push({ k: 'enchShroud', enchantedToo: true }); cover(ALL); },
    'Sterling Grove': (a, cover) => { a.statics.push({ k: 'enchShroud' }); cover(/shroud/); },
    "Hall of Heliod's Generosity": (a, cover) => { a.activated = [{ tap: true, cost: parseCost('1 W'), fx: [{ k: 'regrowTop', what: 'enchantment' }], text: 'Put an enchantment from your graveyard on top of your library.' }]; cover(ALL); },
    'Heliod, Sun-Crowned': (a, cover) => { a.activated = [{ cost: parseCost('1 W'), fx: [{ k: 'pump', p: 0, t: 0, kw: ['lifelink'], another: true }], text: 'Another target creature gains lifelink until end of turn.', preCombat: true }]; cover(ALL); },
    'Hellkite Tyrant': (a, cover) => { a.upkeep = [{ each: false, fx: [{ k: 'winIfArtifacts', n: 20 }], lose: 0 }]; cover(ALL); },
    'Homeward Path': (a, cover) => { cover(ALL); },
    'Jace, Unraveler of Secrets': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'scry', n: 1 }, { k: 'draw', n: 1 }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -8); if (ult) ult.fx = [{ k: 'emblem', e: 'jaceCounter' }]; cover(ALL); },
    'Jace, Wielder of Mysteries': (a, cover) => { a.statics = a.statics.filter((x) => x.k !== 'misc'); a.statics.push({ k: 'labman' }); a.loyaltyAbs[0].fx = [{ k: 'mill', n: 2 }, { k: 'draw', n: 1 }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -8); if (ult) ult.fx = [{ k: 'draw', n: 7 }, { k: 'emptyLibraryWin' }]; cover(ALL); },
    'Jace, the Mind Sculptor': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'fateseal' }]; const z = a.loyaltyAbs.find((x) => x.delta === 0); if (z) z.fx = [{ k: 'brainstorm' }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -12); if (ult) ult.fx = [{ k: 'exileLibrary' }]; cover(ALL); },
    "Jeska's Will": (a, cover) => { a.spell = [{ k: 'jeska' }, { k: 'impulse', n: 3, ifCommander: true }]; cover(ALL); },
    'Junji, the Midnight Sky': (a, cover) => { a.dies = [{ k: 'junji' }]; a.statics = a.statics.filter((x) => x.k !== 'misc'); cover(ALL); },
    'Kaalia, Zenith Seeker': (a, cover) => { a.etb = [{ k: 'dig', n: 6, types: ['angel', 'demon', 'dragon'], all: true }]; cover(ALL); },
    'Kalitas, Traitor of Ghet': (a, cover) => { a.statics = a.statics.filter((x) => x.k !== 'misc'); a.statics.push({ k: 'kalitas' }); a.sacOutlet = { tribes: ['Vampire', 'Zombie'], mana: 3, fx: [{ k: 'counters', n: 2, on: 'self' }] }; cover(ALL); },
    'Karn, the Great Creator': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'animateArtifact' }]; a.loyaltyAbs[1].fx = [{ k: 'wish', what: 'artifact' }]; cover(ALL); },
    "Kaya's Ghostform": (a, cover) => { a.isAura = true; a.ghostform = true; cover(ALL); },
    'Kiora, the Crashing Wave': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'neutralize' }]; a.loyaltyAbs[1].fx = [{ k: 'draw', n: 1 }, { k: 'extraLandNow' }]; a.loyaltyAbs[2].fx = [{ k: 'emblem', e: 'kraken' }]; cover(ALL); },
    'Knight of the Ebon Legion': (a, cover) => { a.activated = [{ cost: parseCost('2 B'), fx: [{ k: 'pumpSelf', p: 3, t: 3, kw: ['deathtouch'] }], text: '+3/+3 and deathtouch until end of turn.', preCombat: true }]; a.endstep = []; a.endstep.push({ each: false, fx: [{ k: 'ebonLegion' }] }); cover(ALL); },
    'Koma, Cosmos Serpent': (a, cover) => { a.uncounterable = true; a.koma = true; cover(ALL); },
    'Kuldotha Forgemaster': (a, cover) => { a.activated = [{ tap: true, sacArtifact: 3, cost: parseCost(''), fx: [{ k: 'search', n: 1, what: 'artifact', dest: 'bf' }], text: 'Sacrifice three artifacts: search for an artifact and put it onto the battlefield.' }]; cover(ALL); },
    'Ledger Shredder': (a, cover) => { cover(ALL); },
    'Life from the Loam': (a, cover) => { a.spell = [{ k: 'regrowLands', n: 3 }]; a.dredge = 3; cover(ALL); },
    'Liliana Vess': (a, cover) => { const ult = a.loyaltyAbs.find((x) => x.delta <= -8); if (ult) ult.fx = [{ k: 'massReanimate' }]; cover(ALL); },
    'Liliana of the Veil': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'discardAll' }]; const m2 = a.loyaltyAbs.find((x) => x.delta === -2); if (m2) m2.fx = [{ k: 'edict', one: true }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -6); if (ult) ult.fx = [{ k: 'piles' }]; cover(ALL); },
    "Liliana, Death's Majesty": (a, cover) => { const m3 = a.loyaltyAbs.find((x) => x.delta === -3); if (m3) m3.fx = [{ k: 'reanimate', any: false, zombie: true }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -7); if (ult) ult.fx = [{ k: 'wipe', what: 'creatures', spare: 'Zombie' }]; cover(ALL); },
    'Liliana, Dreadhorde General': (a, cover) => { const four = a.loyaltyAbs.find((x) => x.delta === -4); if (four) four.fx = [{ k: 'edictAll', n: 2 }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -9); if (ult) ult.fx = [{ k: 'liliana9' }]; cover(ALL); },
    'Lord of the Void': (a, cover) => { a.combatDmg = [{ k: 'lordOfVoid' }]; cover(ALL); },
    'Lorehold Campus': (a, cover) => { a.activated = [{ tap: true, cost: parseCost('4'), fx: [{ k: 'scry', n: 1 }], text: 'Scry 1.', lowPriority: true }]; cover(ALL); },
    'Losheel, Clockwork Scholar': (a, cover) => { a.statics.push({ k: 'losheel' }); cover(/Prevent all combat damage/); },
    'Lotus Petal': (a, cover) => { cover(ALL); },
    'Master of Cruelties': (a, cover) => { cover(ALL); },
    'Mikaeus, the Unhallowed': (a, cover) => { a.kw.add('intimidate'); a.statics = a.statics.filter((x) => x.k !== 'anthem'); a.statics.push({ k: 'anthem', other: true, p: 1, t: 1, kw: ['undying'], notSub: 'Human' }); a.statics.push({ k: 'humanBane' }); cover(ALL); },
    'Mondrak, Glory Dominus': (a, cover) => { a.mondrak = true; cover(ALL); },
    'Mox Opal': (a, cover) => { a.metalcraft = true; cover(ALL); },
    'Mycosynth Lattice': (a, cover) => { a.statics.push({ k: 'anyColorMana' }); cover(ALL); },
    'Myriad Landscape': (a, cover) => { a.activated = [{ tap: true, sac: true, cost: parseCost('2'), fx: [{ k: 'ramp', bf: 2, hand: 0, tapped: true, basicOnly: true, sameType: true }], text: 'Search for two basic lands, put them onto the battlefield tapped.' }]; cover(ALL); },
    'Myrkul, Lord of Bones': (a, cover) => { cover(ALL); },
    'Swords to Plowshares': (a, cover) => { a.spell = [{ k: 'removal', what: 'creature', exile: true, comp: 'life' }]; cover(ALL); },
    'Path to Exile': (a, cover) => { a.spell = [{ k: 'removal', what: 'creature', exile: true, comp: 'land' }]; cover(ALL); },
    'Majestic Genesis': (a, cover) => { a.spell = [{ k: 'genesis', majestic: true }]; cover(ALL); },
    'Mystic Forge': (a, cover) => { a.statics.push({ k: 'castTop', what: 'artifact' }); a.activated = [{ tap: true, life: 1, cost: parseCost(''), fx: [{ k: 'exileTop' }], text: 'Exile the top card of your library.', lowPriority: true }]; cover(ALL); },
    'Ichor Wellspring': (a, cover) => { a.etb = [{ k: 'draw', n: 1 }]; a.gyDraw = 1; cover(ALL); },
    'Gamble': (a, cover) => { a.spell = [{ k: 'tutor', what: 'card' }, { k: 'discardSelf', n: 1, random: true }]; cover(ALL); },
    "Inventors' Fair": (a, cover) => { a.upkeep = [{ each: false, fx: [{ k: 'gain', n: 1, ifArtifacts: 3 }], lose: 0 }]; if (a.activated[0]) a.activated[0].minArtifacts = 3; cover(ALL); },
    "Mishra's Bauble": (a, cover) => { if (a.activated[0]) a.activated[0].fx = [{ k: 'draw', n: 1, delayed: true }]; cover(ALL); },
    'Rugged Prairie': (a, cover) => { if (a.mana) a.mana.opts.push({ colors: ['R', 'W'], amount: 1, dmg: 0, extraGeneric: 0, filter: true }); cover(ALL); },
    'Moonsilver Key': (a, cover) => { if (a.activated[0]) a.activated[0].fx = [{ k: 'tutor', what: 'manaArtifact' }]; cover(ALL); },
    'Aetherflux Reservoir': (a, cover) => { if (a.castTrig[0]) a.castTrig[0].fx = [{ k: 'gain', n: 'SPELLS' }]; cover(ALL); },
    'Narset, Parter of Veils': (a, cover) => { a.statics.push({ k: 'narset' }); const m2 = a.loyaltyAbs.find((x) => x.delta === -2); if (m2) m2.fx = [{ k: 'dig', n: 4, types: ['noncreature', 'nonland'] }]; cover(ALL); },
    'Necromancy': (a, cover) => { a.reanimAura = true; a.etb = [{ k: 'reanimate', any: true }]; cover(ALL); },
    'Necropotence': (a, cover) => { cover(ALL); },
    'Nyxbloom Ancient': (a, cover) => { a.statics.push({ k: 'manaMult', n: 3 }); cover(ALL); },
    'Zendikar Resurgent': (a, cover) => { a.statics.push({ k: 'landManaPlus' }); cover(/tap a land/); },
    'Oath of Nissa': (a, cover) => { a.etb = [{ k: 'dig', n: 3, types: ['creature', 'land', 'planeswalker'] }]; cover(ALL); },
    'Oath of Teferi': (a, cover) => { a.statics.push({ k: 'oathTeferi' }); a.etb = [{ k: 'oathFlicker' }]; cover(ALL); },
    'Oko, Thief of Crowns': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'food' }]; cover(ALL); },
    "Olivia's Wrath": (a, cover) => { a.spell = [{ k: 'wipe', what: 'tribalMinus', tribe: 'Vampire' }]; cover(ALL); },
    'Opalescence': (a, cover) => { a.statics.push({ k: 'opalescence' }); cover(ALL); },
    'Starfield of Nyx': (a, cover) => { a.statics.push({ k: 'starfield' }); a.upkeep = [{ each: false, fx: [{ k: 'reanimateType', what: 'Enchantment' }], lose: 0 }]; cover(ALL); },
    'Oracle of Mul Daya': (a, cover) => { a.statics.push({ k: 'landsFromTop' }); cover(ALL); },
    'Osgir, the Reconstructor': (a, cover) => { a.activated = [{ tap: true, sorcery: true, cost: parseCost(''), fx: [{ k: 'osgir' }], text: 'Exile an artifact card from your graveyard: create two token copies of it.' }]; a.osgirPump = true; cover(ALL); },
    'Oswald Fiddlebender': (a, cover) => { a.statics = a.statics.filter((x) => x.k !== 'misc'); a.activated = [{ tap: true, sorcery: true, sacArtifact: 1, cost: parseCost('W'), fx: [{ k: 'search', n: 1, what: 'artifact', dest: 'bf', mvPlusOne: true }], text: 'Sacrifice an artifact: tutor one that costs 1 more onto the battlefield.' }]; cover(ALL); },
    'Palisade Giant': (a, cover) => { a.statics.push({ k: 'palisade' }); cover(ALL); },
    'Pattern of Rebirth': (a, cover) => { a.isAura = true; a.enchDies = [{ k: 'search', n: 1, what: 'creature', dest: 'bf' }]; cover(ALL); },
    'Pir, Imaginative Rascal': (a, cover) => { a.statics.push({ k: 'counterPlus', allKinds: true }); cover(ALL); },
    'Primal Vigor': (a, cover) => { a.statics.push({ k: 'globalDouble' }); cover(ALL); },
    'Plaguecrafter': (a, cover) => { a.etb = [{ k: 'edictAll', n: 1, discardIfNone: true, pw: true }]; cover(ALL); },
    'Portal to Phyrexia': (a, cover) => { a.etb = [{ k: 'edict', n: 3 }]; cover(ALL); },
    'Pull from Eternity': (a, cover) => { a.spell = [{ k: 'pullFromEternity' }]; cover(ALL); },
    'Quicksilver Amulet': (a, cover) => { a.activated = [{ tap: true, cost: parseCost('4'), fx: [{ k: 'cheatCreature' }], text: 'Put a creature card from your hand onto the battlefield.' }]; cover(ALL); },
    'Reforge the Soul': (a, cover) => { cover(/Miracle/); },
    'Return of the Wildspeaker': (a, cover) => { a.spell = [{ k: 'wildspeaker' }]; cover(ALL); },
    "Rogue's Passage": (a, cover) => { a.activated = [{ tap: true, cost: parseCost('4'), fx: [{ k: 'pump', p: 0, t: 0, kw: ['unblockable'] }], text: 'Target creature can\'t be blocked this turn.', preCombat: true }]; cover(ALL); },
    "Slayers' Stronghold": (a, cover) => { a.activated = [{ tap: true, cost: parseCost('R W'), fx: [{ k: 'pump', p: 2, t: 0, kw: ['vigilance', 'haste'] }], text: '+2/+0, vigilance and haste.', preCombat: true }]; cover(ALL); },
    'Sunhome, Fortress of the Legion': (a, cover) => { a.activated = [{ tap: true, cost: parseCost('2 R W'), fx: [{ k: 'pump', p: 0, t: 0, kw: ['double strike'] }], text: 'Target creature gains double strike.', preCombat: true }]; cover(ALL); },
    'Rout': (a, cover) => { cover(/flash/); },
    'Satyr Wayfinder': (a, cover) => { a.etb = [{ k: 'dig', n: 4, types: ['land'], restGy: true }]; cover(ALL); },
    'Scourge of the Throne': (a, cover) => { a.dethrone = true; cover(ALL); },
    "Serra's Emissary": (a, cover) => { a.statics.push({ k: 'emissary' }); cover(ALL); },
    'Shattered Sanctum': (a, cover) => { cover(ALL); },
    'Sheoldred, Whispering One': (a, cover) => { a.landwalk = 'Swamp'; cover(/Swampwalk/); },
    'Sidisi, Brood Tyrant': (a, cover) => { a.etb = [{ k: 'mill', n: 3 }]; a.attack = [{ k: 'mill', n: 3 }]; a.sidisi = true; cover(ALL); },
    'Sigarda, Host of Herons': (a, cover) => { a.statics.push({ k: 'sigarda' }); cover(ALL); },
    'Sign in Blood': (a, cover) => { a.spell = [{ k: 'draw', n: 2 }, { k: 'loseSelf', n: 2 }]; cover(ALL); },
    'Silence': (a, cover) => { a.spell = [{ k: 'silence' }]; a.silence = true; cover(ALL); },
    'Skull Prophet': (a, cover) => { a.activated = []; a.activated.push({ tap: true, cost: parseCost(''), fx: [{ k: 'mill', n: 2 }], text: 'Mill two cards.', lowPriority: true }); cover(ALL); },
    'Sorin Markov': (a, cover) => { const ult = a.loyaltyAbs.find((x) => x.delta <= -7); if (ult) ult.fx = [{ k: 'mindslaver' }]; cover(ALL); },
    'Sorin, Imperious Bloodlord': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'pump', p: 0, t: 0, kw: ['deathtouch', 'lifelink'], counterIfTribe: 'Vampire' }]; a.loyaltyAbs[1].fx = [{ k: 'sorinSac' }]; const m3 = a.loyaltyAbs.find((x) => x.delta === -3); if (m3) m3.fx = [{ k: 'cheatCreature', tribe: 'Vampire' }]; cover(ALL); },
    'Sower of Discord': (a, cover) => { a.sower = true; cover(ALL); },
    'Sphere of Safety': (a, cover) => { a.statics.push({ k: 'sphere' }); cover(ALL); },
    'Spore Frog': (a, cover) => { a.fogSac = true; cover(ALL); },
    'Staff of Domination': (a, cover) => { a.activated = a.activated.filter((x) => x.fx.some((f) => f.k === 'draw' || f.k === 'gain')); a.activated.push({ tap: true, cost: parseCost('4'), fx: [{ k: 'tapBlocker' }], text: 'Tap target creature.', preCombat: true }); cover(ALL); },
    'Strip Mine': (a, cover) => { a.activated = [{ tap: true, sac: true, cost: parseCost(''), fx: [{ k: 'landDestroy' }], text: 'Destroy target land.' }]; cover(ALL); },
    'Supreme Verdict': (a, cover) => { a.uncounterable = true; cover(ALL); },
    'Toski, Bearer of Secrets': (a, cover) => { a.uncounterable = true; a.mustAttack = true; a.combatDmg = []; a.toski = true; cover(ALL); },
    "Green Sun's Zenith": (a, cover) => { a.shuffleBack = true; cover(ALL); },
    'Whip of Erebos': (a, cover) => { if (a.activated[0]) { a.activated[0].fx = [{ k: 'reanimate', any: false, whip: true }]; a.activated[0].sorcery = true; } cover(ALL); },
    "Agadeem's Awakening // Agadeem, the Undercrypt": (a, cover) => { a.spell = [{ k: 'agadeem' }]; cover(ALL); },
    "Assassin's Trophy": (a, cover) => { a.spell = [{ k: 'removal', what: 'nonland', comp: 'land', destroyComp: true }]; cover(ALL); },
    'Sword of Feast and Famine': (a, cover) => { a.statics = a.statics.filter((x) => x.k !== 'equipBuff'); a.statics.push({ k: 'equipBuff', p: 2, t: 2, kw: ['protection'], protect: ['B', 'G'] }); a.combatDmg = [{ k: 'discard', n: 1 }, { k: 'untapLands' }]; a.equipCombat = true; cover(ALL); },
    'Sylvan Library': (a, cover) => { a.drawsPerTurn = 1; cover(ALL); }, // (the draw step does it, by name; this tells the AI what it is worth)
    'Tamiyo, Field Researcher': (a, cover) => { const t7 = a.loyaltyAbs.find((x) => x.delta === -7); if (t7) t7.fx = [{ k: 'draw', n: 3 }, { k: 'emblem', e: 'freeSpells' }]; a.loyaltyAbs[0].fx = [{ k: 'tamiyoWatch' }]; const m2 = a.loyaltyAbs.find((x) => x.delta === -2); if (m2) m2.fx = [{ k: 'freeze', n: 2 }]; cover(ALL); },
    'Tamiyo, the Moon Sage': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'freeze', n: 1 }]; const m2 = a.loyaltyAbs.find((x) => x.delta === -2); if (m2) m2.fx = [{ k: 'drawTapped' }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -8); if (ult) ult.fx = [{ k: 'emblem', e: 'tamiyo' }]; cover(ALL); },
    'Tatyova, Benthic Druid': (a, cover) => { a.statics = a.statics.filter((x) => x.k !== 'misc'); a.landfall = [[{ k: 'gain', n: 1 }, { k: 'draw', n: 1 }]]; cover(ALL); },
    "Teferi's Protection": (a, cover) => { cover(ALL); },
    'Teferi, Hero of Dominaria': (a, cover) => { const t8 = a.loyaltyAbs.find((x) => x.delta === -8); if (t8) t8.fx = [{ k: 'emblem', e: 'teferi' }]; const m3 = a.loyaltyAbs.find((x) => x.delta === -3); if (m3) m3.fx = [{ k: 'removal', what: 'nonland', tuck: true }]; a.loyaltyAbs[0].fx = [{ k: 'draw', n: 1 }, { k: 'untapLandsN', n: 2 }]; cover(ALL); },
    'Teferi, Master of Time': (a, cover) => { a.anyTurnPW = true; const m3 = a.loyaltyAbs.find((x) => x.delta === -3); if (m3) m3.fx = [{ k: 'phaseOut' }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -10); if (ult) ult.fx = [{ k: 'extraTurn' }, { k: 'extraTurn' }]; cover(ALL); },
    'Teferi, Time Raveler': (a, cover) => { a.statics.push({ k: 'raveler' }); a.loyaltyAbs[0].fx = [{ k: 'noop' }]; const m3 = a.loyaltyAbs.find((x) => x.delta === -3); if (m3) m3.fx = [{ k: 'removal', what: 'nonlandNonPW', bounce: true }, { k: 'draw', n: 1 }]; cover(ALL); },
    'Temple of Triumph': (a, cover) => { a.etb = [{ k: 'scry', n: 1 }]; cover(ALL); },
    'Terror of the Peaks': (a, cover) => { a.wardLife = 3; cover(ALL); },
    'The Chain Veil': (a, cover) => { a.chainVeil = true; cover(ALL); },
    'The Gitrog Monster': (a, cover) => { a.upkeep = [{ each: false, fx: [{ k: 'gitrogUpkeep' }], lose: 0 }]; cover(ALL); },
    'The Mind Stone': (a, cover) => { a.harness = { cost: '5 W', end: [{ k: 'flickerOwn' }] }; cover(ALL); },
    'The Soul Stone': (a, cover) => { a.harness = { cost: '6 B', exileCreature: true, upkeep: [{ k: 'reanimate', any: false }] }; a.statics = a.statics.filter((x) => x.k !== 'misc'); cover(ALL); },
    'The Wandering Emperor': (a, cover) => { a.flashPW = true; a.loyaltyAbs[0].fx = [{ k: 'counters', n: 1, on: 'target' }, { k: 'pump', p: 0, t: 0, kw: ['first strike'] }]; const m2 = a.loyaltyAbs.find((x) => x.delta === -2); if (m2) m2.fx = [{ k: 'removal', what: 'tappedCreature', exile: true }, { k: 'gain', n: 2 }]; cover(ALL); },
    'Takenuma, Abandoned Mire': (a, cover) => { if (a.channel) a.channel.fx = [{ k: 'mill', n: 3 }, { k: 'regrowType', types: ['creature', 'planeswalker'] }]; cover(ALL); },
    'Thousand-Year Elixir': (a, cover) => { a.statics.push({ k: 'elixir' }); cover(ALL); },
    'Toxic Deluge': (a, cover) => { a.spell = [{ k: 'wipe', what: 'deluge' }]; cover(ALL); },
    "Ugin's Nexus": (a, cover) => { a.statics = a.statics.filter((x) => x.k !== 'misc'); a.statics.push({ k: 'nexus' }); cover(ALL); },
    'Ugin, the Spirit Dragon': (a, cover) => { const u10 = a.loyaltyAbs.find((x) => x.delta === -10); if (u10) u10.fx = [{ k: 'gain', n: 7 }, { k: 'draw', n: 7 }, { k: 'putFromHand', n: 7 }]; const mx = a.loyaltyAbs.find((x) => x.delta === -99); if (mx) { mx.delta = -98; mx.fx = [{ k: 'wipe', what: 'ugin', exile: true }]; } cover(ALL); },
    'Unwinding Clock': (a, cover) => { a.statics.push({ k: 'unwinding' }); cover(ALL); },
    "Vanquisher's Banner": (a, cover) => { a.banner = true; cover(ALL); },
    'Vilis, Broker of Blood': (a, cover) => { cover(ALL); },
    'Vito, Thorn of the Dusk Rose': (a, cover) => { a.activated = [{ cost: parseCost('3 B B'), fx: [{ k: 'overrun', p: 0, t: 0, kw: ['lifelink'] }], text: 'Creatures you control gain lifelink until end of turn.', preCombat: true }]; cover(ALL); },
    'Voldaren Estate': (a, cover) => { a.activated = [{ tap: true, cost: parseCost('5'), tribeDiscount: 'Vampire', fx: [{ k: 'blood' }], text: 'Create a Blood token.', lowPriority: true }]; cover(ALL); },
    'Vorinclex, Monstrous Raider': (a, cover) => { a.statics.push({ k: 'vorinclexHalf' }); cover(ALL); },
    'Vraska the Unseen': (a, cover) => { a.loyaltyAbs[0].fx = [{ k: 'vraskaShield' }]; const ult = a.loyaltyAbs.find((x) => x.delta <= -7); if (ult) ult.fx = [{ k: 'tokens', n: 3, p: 1, t: 1, sub: 'Assassin', colors: 'black', kw: [], combatDmg: [{ k: 'loseGame' }] }]; cover(ALL); },
    'Walking Ballista': (a, cover) => { a.activated = a.activated.filter((x) => !x.fx.some((f) => f.k === 'damage')); cover(ALL); }, // pinging (remove a counter) is handled by pingers()
    'Yawgmoth, Thran Physician': (a, cover) => { a.protectionFrom = 'Human'; if (a.activated[0]) a.activated[0].fx = [{ k: 'minusCounter' }, { k: 'draw', n: 1 }]; cover(ALL); },
    'Yahenni, Undying Partisan': (a, cover) => { if (a.sacOutlet) a.sacOutlet.fx = [{ k: 'selfIndestructible' }]; a.yahenni = true; cover(ALL); },
    'Zur the Enchanter': (a, cover) => { a.attack = [{ k: 'search', n: 1, what: 'enchantment', mvMax: 3, dest: 'bf' }]; cover(ALL); },
    'Glen Elendra Archmage': (a, cover) => { cover(ALL); },
    'Ledger Shredder ': null,
  };
  delete SCRIPTS['Ledger Shredder '];
  Object.assign(SCRIPTS, {
    'Alibou, Ancient Witness': (a, cover) => { a.statics = [{ k: 'artifactHaste' }]; a.triggers.push({ k: 'alibou' }); cover(ALL); },
    'Ayara, First of Locthwain': (a, cover) => { if (a.activated[0]) a.activated[0].sacColor = 'B'; a.etb = [{ k: 'drain', n: 1, gain: true }]; a.myCreatureEtb = [[{ k: 'drain', n: 1, gain: true, ifColor: 'B' }]]; cover(ALL); },
    'Losheel, Clockwork Scholar': (a, cover) => { a.statics = [{ k: 'losheel' }]; a.losheelDraw = true; cover(ALL); },
    'The Great Henge': (a, cover) => { a.henge = true; a.mana = { opts: [{ colors: ['G'], amount: 2, dmg: 0, gain: 2 }], oneShot: false }; a.myCreatureEtb = [[{ k: 'counters', n: 1, on: 'entering', nontoken: true }, { k: 'draw', n: 1, nontoken: true }]]; cover(ALL); },
    'Finale of Devastation': (a, cover) => { a.spell = [{ k: 'finale' }]; cover(ALL); },
    'Springbloom Druid': (a, cover) => { a.etb = [{ k: 'sacLand' }, { k: 'ramp', bf: 2, hand: 0, tapped: true }]; cover(ALL); },
    'Sword of Truth and Justice': (a, cover) => { a.combatDmg = [{ k: 'counters', n: 1, on: 'target' }, { k: 'proliferate' }]; cover(ALL); },
    'Thousand-Year Elixir': (a, cover) => { a.statics = [{ k: 'elixir' }]; a.activated = [{ tap: true, cost: parseCost('1'), fx: [{ k: 'untapCreature' }], text: 'Untap target creature.' }]; cover(ALL); },
    'Reanimate': (a, cover) => { a.spell = [{ k: 'reanimate', any: true, loseMv: true }]; cover(ALL); },
    'Thrilling Discovery': (a, cover) => { a.spell = [{ k: 'gain', n: 2 }, { k: 'loot', n: 2, draw: 3, optional: true }]; cover(ALL); },
    'Altar of Dementia': (a, cover) => { a.sacOutlet = { mana: 0, fx: [{ k: 'millPower' }] }; a.activated = [{ sacCreature: 1, cost: parseCost(''), fx: [{ k: 'millPower' }], text: "Target player mills cards equal to the sacrificed creature's power.", lowPriority: true }]; cover(ALL); },
    'Pest Infestation': (a, cover) => { a.spell = [{ k: 'removalN', what: 'artench', n: 'X' }, { k: 'tokens', n: 'X2', p: 1, t: 1, sub: 'Pest', colors: 'black green', kw: [], dies: [{ k: 'gain', n: 1 }] }]; cover(ALL); },
    'Champion of Dusk': (a, cover) => { a.etb = [{ k: 'draw', n: 'TRIBE', tribe: 'Vampire' }, { k: 'loseSelf', n: 'TRIBE', tribe: 'Vampire' }]; cover(ALL); },
    'Old Gnawbone': (a, cover) => { a.triggers.push({ k: 'gnawbone' }); a.combatDmg = []; cover(ALL); },
    'Ancient Copper Dragon': (a, cover) => { a.combatDmg = [{ k: 'treasure', n: 'D20' }]; cover(ALL); },
    'Ragavan, Nimble Pilferer': (a, cover) => { a.combatDmg = [{ k: 'treasure', n: 1 }, { k: 'ragavan' }]; cover(ALL); },
    'Ophiomancer': (a, cover) => { a.upkeep = [{ each: true, fx: [{ k: 'tokens', n: 1, p: 1, t: 1, sub: 'Snake', colors: 'black', kw: ['deathtouch'], unlessHave: 'Snake' }], lose: 0 }]; cover(ALL); },
    'Hour of Promise': (a, cover) => { a.spell = [{ k: 'ramp', bf: 2, hand: 0, tapped: true, anyLand: true }]; cover(ALL); },
    'Land Tax': (a, cover) => { a.upkeep = [{ each: false, fx: [{ k: 'ramp', bf: 0, hand: 3, ifBehind: true }], lose: 0 }]; cover(ALL); },
    'Wurmcoil Engine': (a, cover) => { a.dies = [{ k: 'tokens', n: 1, p: 3, t: 3, sub: 'Phyrexian Wurm', colors: 'colorless', kw: ['deathtouch'] }, { k: 'tokens', n: 1, p: 3, t: 3, sub: 'Phyrexian Wurm', colors: 'colorless', kw: ['lifelink'] }]; cover(ALL); },
    "Urza's Saga": (a, cover) => { a.etb = []; a.saga = true; cover(ALL); },
    'Welcoming Vampire': (a, cover) => { a.welcoming = true; cover(ALL); },
    'Essence Warden': (a, cover) => { a.anyCreatureEtb = [{ k: 'gain', n: 1 }]; cover(ALL); },
    'Quicksmith Genius': (a, cover) => { a.artifactEtb = true; cover(ALL); },
  });

  // Alternative costs ("rather than pay this spell's mana cost"): free with a commander out, exile a card of a colour from
// hand, sacrifice a nontoken creature of a colour, or pay life (with a land type out). null when the line isn't one.
const ALT_COLORS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
function parseAltCost(low) {
  if (/if you control a commander, you may cast .*without paying its mana cost/.test(low)) return { kind: 'commander' };
  let w;
  if ((w = low.match(/^web-slinging (\{[^}]+\}(?:\{[^}]+\})*)/))) return { kind: 'webSling', mana: w[1].replace(/[{}]/g, ' ').trim().toUpperCase() }; // (that mana + return a tapped creature)
  if (!/rather than pay/.test(low)) return null;
  const notYourTurn = /^if it's not your turn/.test(low);
  let m;
  if ((m = low.match(/you may exile an? (white|blue|black|red|green) card from your hand(?: and pay (\d+) life)? rather than pay/))) return { kind: 'exile', color: ALT_COLORS[m[1]], life: m[2] ? +m[2] : 0, notYourTurn };
  if ((m = low.match(/you may sacrifice a nontoken (white|blue|black|red|green) creature rather than pay/))) return { kind: 'sac', color: ALT_COLORS[m[1]], notYourTurn };
  if ((m = low.match(/^if you control an? (\w+), you may pay (\d+) life rather than pay/))) return { kind: 'life', n: +m[2], ifControl: m[1][0].toUpperCase() + m[1].slice(1), notYourTurn };
  if ((m = low.match(/you may pay (\d+) life rather than pay/))) return { kind: 'life', n: +m[1], notYourTurn };
  return null;
}
function analyzeCard(data, deckColors, fullName) {
    const faces = data.faces.map((f) => analyzeFace(f, deckColors));
    const front = faces[0];
    const script = SCRIPTS[fullName] || SCRIPTS[front.name];
    if (script) {
      const cover = (re) => { front.unmodeled = front.unmodeled.filter((l) => !re.test(l)); };
      script(front, cover);
      front.scripted = true;
    }
    faces.slice(1).forEach((f) => { const sc = SCRIPTS[f.name]; if (sc) sc(f, (re) => { f.unmodeled = f.unmodeled.filter((l) => !re.test(l)); }); });
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
  // Thrown when a game makes far more mana payments and permanents than any real game (a loop the AI can't get out of)
  class Runaway extends Error {}
  // a game that runs past Game.TIME_LIMIT: unlike a look-ahead's own runaway, it isn't swallowed by the look-ahead's error handling
  class TimeUp extends Runaway {}
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
      this.steps = 0;
      this.players = decks.map((d, i) => this.makePlayer(d, i));
      this.active = 0;
      this.winner = null;
      this.over = false;
      this.focus = [];
      this.stats = {};      // card id -> what that card has done this game
      this.casts = [];      // every spell cast: { seat, name, turn }
      this._ctx = [];       // stack of cards whose effects are resolving (for credit)
      this._crBuf = [];
      this.nn = opts.nn || null;                    // trained neural network (see train.mjs), loaded with Game.loadNN
      this.nnSeats = opts.nnSeats || null;          // which seats let it steer their choices (default: all)
      this.collect = !!opts.collect;                // record training samples (state, card) for train.mjs
      this.explore = opts.explore || 0;             // random noise on choices while training, so the net sees variety
      this.looseSeats = opts.looseSeats || null;   // A/B tests: only these seats let the look-ahead try abilities the rules would not use
      this.lookahead = opts.lookahead !== false && !(typeof process !== 'undefined' && process.env && process.env.NOLOOK);    // try the best few plays on a copy of the game before choosing (see lookPick)
      this.lookSeats = opts.lookSeats || null;      // which seats search (default: all)
      this.politics = opts.politics ?? (typeof process !== 'undefined' && process.env && process.env.POLITICS ? +process.env.POLITICS : 40); // weight on attacking whoever is most likely to win
      this.samples = []; this.mullSamples = []; this.searchSamples = []; // (searchSamples: what the look-ahead found, for training)
    }

    // ----- statistics: credit each result to the card that caused it -----
    creditTarget(c) { return c && c.creditTo && this.cards[c.creditTo] ? this.cards[c.creditTo] : c; }
    credit(c, stat, n) {
      if (!c || !n || !c.id) return;
      const t = this.creditTarget(c);
      const st = this.stats[t.id] || (this.stats[t.id] = { name: t.token ? t.info.name : t.name, seat: t.owner, token: !!t.token });
      st[stat] = (st[stat] || 0) + n;
      if (this.record) this._crBuf.push([t.id, stat, n]);
    }
    // ----- paying life -----
    // The life a player wants to keep: enough to survive what the opponents could swing at them before their
    // next turn (each opponent gets a turn; blockers that stay home soak the biggest attackers), plus a margin.
    lifeFloor(p) {
      const key = p.seat + ':' + this._nnTick + ':' + p.life;
      if (this._lf && this._lf.key === key) return this._lf.v;
      const home = p.bf.filter((c) => c.info.isCreature && !this.pacified(c));
      const canBlockAny = (b, a) => { const t = b.tapped; b.tapped = false; const r = this.canBlock(b, a); b.tapped = t; return r; };
      const hits = [];
      for (const o of this.opps(p)) {
        const atk = o.bf.filter((c) => c.info.isCreature && !this.pacified(c) && this.power(c) > 0).sort((a, b) => this.power(b) - this.power(a));
        const used = new Set(); let dmg = 0;
        for (const a of atk) { const b = home.find((h) => !used.has(h) && canBlockAny(h, a)); if (b) used.add(b); else dmg += this.scaleDamage(o.seat, p.seat, this.power(a)); }
        // steady drains each turn (Sheoldred, Blood Artist style engines) add a little on top
        dmg += o.bf.filter((c) => c.info.triggers.some((t) => /oppDrawLose|drain/i.test(t.k)) || c.info.upkeep.some((u) => u.fx.some((f) => f.k === 'drain'))).length * 2;
        hits.push(dmg);
      }
      hits.sort((a, b) => b - a);
      const v = Math.max(6, (hits[0] || 0) + 0.5 * hits.slice(1).reduce((a, b) => a + b, 0) + 4);
      this._lf = { key, v };
      return v;
    }
    // Is paying n life OK? Never if it kills us; otherwise only if we stay above the floor. When we are already
    // under the floor (dead on board anyway) small payments that might find an answer are still fine.
    // winNow: the payment wins the game or strips the table bare, so any life we survive with is fine
    canPayLife(p, n, winNow = false) {
      if (!n || n <= 0) return true;
      if (p.life - n < 1) return false;
      if (winNow) return true;
      if (this.has(p, 'staff') && p.life > 500) return true;
      const floor = this.lifeFloor(p);
      if (p.life > floor) return p.life - n > floor;
      return n <= 2 && p.life - n >= 3;
    }

    // ----- neural network -----
    // The network looks at the board from one player's side plus (optionally) a card they could play,
    // and predicts the chance that player goes on to win. V = chance from here; Q = chance after
    // playing that card. Q - V (the advantage) is how much the card helps right now.
    static loadNN(j) {
      // a network trained on a different set of board features can't read this engine's: treat it as off until retrained
      if (!j || !j.q || j.q.nDense !== Game.NN_STATE + Game.NN_CARD + 1 + (j.decks || []).length) return null;
      const { MLP } = typeof module !== 'undefined' && module.exports ? require('./nn.js') : root.PodNN;
      return { q: MLP.fromJSON(j.q), m: j.m ? MLP.fromJSON(j.m) : null, vocab: new Map(j.vocab.map((n, i) => [n, i])), decks: j.decks, base: j.base || {}, gen: j.generation };
    }
    nnSample(p, c, from) { return { seat: p.seat, deck: p.deckId, name: c.name, from, st: this.nnState(p), card: this.nnCard(p, c, from), turn: this.round }; }
    nnOn(p) { return !!this.nn && (!this.nnSeats || this.nnSeats.includes(p.seat)); }
    // the board summary is the same for every card scored in one decision (a tutor rates the whole library), so it is cached until the next event
    nnState(p) {
      const key = p.seat + ':' + this._nnTick;
      if (this._nnS && this._nnS.key === key) return this._nnS.v;
      const v = this._nnState(p); this._nnS = { key, v }; return v;
    }
    _nnState(p) {
      const opps = this.opps(p);
      const crs = (q) => q.bf.filter((c) => c.info.isCreature);
      const pow = (q) => crs(q).reduce((s2, c) => s2 + Math.max(0, this.power(c)), 0);
      const lives = opps.map((q) => q.life);
      const mine = this.playerThreat(p), oppMax = Math.max(0, ...opps.map((q) => this.playerThreat(q)));
      return [
        Math.min(this.round, 20) / 15, p.life / 40, (lives.length ? Math.min(...lives) : 0) / 40, (lives.length ? lives.reduce((a, b) => a + b, 0) / lives.length : 0) / 40,
        p.bf.filter((c) => c.info.isLand).length / 10, crs(p).length / 10, pow(p) / 30, Math.max(0, ...opps.map(pow)) / 30,
        p.hand.length / 10, (opps.length ? opps.reduce((s2, q) => s2 + q.hand.length, 0) / opps.length : 0) / 10, opps.length / 3,
        mine / 50, oppMax / 50, (mine - oppMax) / 50, p.bf.some((c) => c.isCommander) ? 1 : 0, p.tax / 3, p.gy.length / 30,
        this.availableMana(p) / 12, Math.max(0, ...opps.map((q) => q.poison)) / 10, p.bf.filter((c) => !c.info.isLand && !c.info.isCreature).length / 10,
        p.library.length / 100, Math.max(0, ...Object.values(p.cmdDmg)) / 21, this.active === p.seat ? 1 : 0, 1,
        ...this._nnRich(p, opps, crs),
      ];
    }
    // What decides games, beyond the totals above: evasion both ways, lethal through blockers, danger, combo progress
    // both ways, lock pieces both ways, commander damage dealt, tokens, engines, graveyard creatures, status flags.
    _nnRich(p, opps, crs) {
      const untapped = (q) => q.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b));
      const free = (from, q) => crs(from).filter((a) => this.power(a) > 0 && !untapped(q).some((b) => this.canBlock(b, a))).reduce((s2, a) => s2 + this.power(a), 0);
      const through = (q) => { // what p's creatures would deal q if q blocked the biggest ones it can
        const bl = untapped(q), used = new Set(); let d = 0;
        for (const a of crs(p).filter((x) => this.power(x) > 0).sort((x, y) => this.power(y) - this.power(x))) { const b = bl.find((x) => !used.has(x) && this.canBlock(x, a)); if (b) used.add(b); else d += this.power(a); }
        return d;
      };
      const comboClose = (q) => Math.max(0, ...this.comboWants(q).map((w) => 1 - w.missing.length / 3));
      const myCmd = p.bf.concat(p.command).filter((c) => c.isCommander).map((c) => c.id);
      const cmdDealt = Math.max(0, ...opps.flatMap((q) => myCmd.map((id) => q.cmdDmg[id] || 0)));
      const lockOn = (who, from) => Math.max(0, ...from.flatMap((q) => q.bf).map((x) => this.lockValue(who, x)));
      return [
        Math.max(0, ...opps.map((q) => free(p, q))) / 30, Math.max(0, ...opps.map((q) => free(q, p))) / 30,
        Math.min(1.5, Math.max(0, ...opps.map((q) => through(q) / Math.max(1, q.life)))) / 1.5,
        Math.min(1.5, (this.lifeFloor(p) - 4) / Math.max(1, p.life)) / 1.5,
        comboClose(p), Math.max(0, ...opps.map(comboClose)),
        Math.min(60, lockOn(p, opps)) / 60, Math.min(60, Math.max(0, ...opps.map((q) => lockOn(q, [p])))) / 60,
        cmdDealt / 21, p.bf.filter((c) => c.token).length / 20,
        p.bf.filter((c) => !c.info.isLand && (c.info.triggers.length || c.info.statics.length || c.info.deathWatch.length)).length / 10,
        p.gy.filter((c) => c.info.isCreature).length / 10,
        p.protectedUntil >= this.turn ? 1 : 0, this.has(p, 'platinum') ? 1 : 0, p.infMana === this.turn ? 1 : 0,
        Math.max(0, ...opps.map((q) => q.hand.length)) / 10,
      ];
    }
    nnCard(p, c, from) {
      const i = c.info;
      const fx = (i.isPermanent ? i.etb : i.spell).concat(i.triggers.flatMap((t) => t.fx || []), i.activated.flatMap((a) => a.fx || []), i.dies);
      const has = (...k) => (fx.some((f) => k.includes(f.k)) ? 1 : 0);
      return [
        (i.mv || 0) / 8, i.isCreature ? 1 : 0, i.isInstant ? 1 : 0, i.isSorcery ? 1 : 0, i.isPW ? 1 : 0, i.types.has('Artifact') ? 1 : 0, i.types.has('Enchantment') ? 1 : 0,
        i.mana ? 1 : 0, (i.power || 0) / 8, (i.toughness || 0) / 8, (i.kw ? i.kw.size : 0) / 5, from === 'command' ? 1 : 0, from === 'gy' ? 1 : 0, i.cost.x ? 1 : 0,
        has('ramp', 'treasure', 'ritual'), has('draw', 'loot', 'wheel', 'impulse', 'dig'), has('tutor', 'search', 'tutorBF'), has('tokens'), has('removal', 'steal', 'exchange', 'edict', 'edictAll'), has('wipe', 'massBounce'),
        has('reanimate', 'massReanimate', 'regrow'), has('drain', 'drainOne', 'hailfire', 'damage'), has('extraTurn', 'extraCombat'), has('counter', 'protect'), has('counters', 'pump', 'overrun', 'proliferate'), has('gain'), has('discard', 'discardAll'),
        this.completesCombo(p, c) ? 1 : 0, i.triggers.length ? 1 : 0, i.statics.length ? 1 : 0,
      ];
    }
    nnInput(p, c, from) {
      const st = this.nnState(p);
      const deck = this.nn.decks.map((d) => (d === p.deckId ? 1 : 0));
      const card = c ? this.nnCard(p, c, from) : new Array(Game.NN_CARD).fill(0);
      const k = c ? this.nn.vocab.get(c.name) : undefined;
      return { d: st.concat(card, [c ? 0 : 1], deck), s: k != null ? [k] : [] };
    }
    nnV(p) {
      const key = p.seat + ':' + this._nnTick;
      if (this._nnV && this._nnV.key === key) return this._nnV.v;
      const x = this.nnInput(p, null);
      const v = this.nn.q.forward(x.d, x.s);
      this._nnV = { key, v };
      return v;
    }
    nnQ(p, c, from) { const x = this.nnInput(p, c, from); return this.nn.q.forward(x.d, x.s); }
    // advantage in win probability (about -0.3..0.3); 0 when the network is off for this seat
    nnAdv(p, c, from = 'hand') { if (!this.nnOn(p)) return 0; return this.nnQ(p, c, from) - this.nnV(p); }
    // win chances for everyone still in, from the network, normalised to add up to 100%
    nnWinChances() {
      const raw = this.players.map((q) => (q.lost ? 0 : Math.max(0.001, (() => { const x = this.nnInput(q, null); return this.nn.q.forward(x.d, x.s); })())));
      const t = raw.reduce((a, b) => a + b, 0) || 1;
      return raw.map((x) => Math.round((x / t) * 1000) / 10);
    }
    // opening hand features for the mulligan network
    nnHand(p, hand, mulls) {
      const lands = hand.filter((c) => c.info.isLand || c.info.mdfcLand).length;
      const sp = hand.filter((c) => !c.info.isLand && !c.info.mdfcLand);
      const kinds = (k) => sp.filter((c) => (c.info.isPermanent ? c.info.etb : c.info.spell).some((f) => k.includes(f.k)) || (k.includes('ramp') && c.info.mana)).length;
      const d = [lands / 7, sp.length / 7, sp.reduce((a, c) => a + c.info.mv, 0) / Math.max(1, sp.length) / 8, sp.filter((c) => c.info.mv <= 2).length / 7, kinds(['ramp', 'treasure', 'ritual']) / 3, kinds(['tutor', 'search', 'tutorBF']) / 2, kinds(['draw', 'loot', 'wheel']) / 3, sp.filter((c) => this.handPlan(p).combo.has(c.name)).length / 2, mulls / 3, hand.length / 7, 1]
        .concat(this.nn ? this.nn.decks.map((x) => (x === p.deckId ? 1 : 0)) : []);
      const s = this.nn ? hand.map((c) => this.nn.vocab.get(c.name)).filter((k) => k != null) : [];
      return { d, s };
    }
    // "A", "A and B", "A, B and 3 more" — groups identical names ("3× Vampire token 1/1")
    // a card's name for the log; tokens say so unless the name already does ("Vampire token")
    cname(c) { const n = c.info.name; return c.token && !/token/i.test(n) ? n + ' token' : n; }
    listNames(names, max = 6) {
      const counts = new Map(); for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
      const parts = [...counts].map(([n, k]) => (k > 1 ? `${k}× ${n}` : n));
      const shown = parts.slice(0, max); if (parts.length > max) shown.push(`${parts.length - max} more`);
      return shown.length <= 1 ? shown.join('') : shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1];
    }
    ctxSrc() { return this._ctx[this._ctx.length - 1] || null; }
    // A rough single number for "how much did this card do": damage, cards, board, interaction, mana
    static cardValue(st) {
      return (st.dmg || 0) + (st.cards || 0) * 2.5 + (st.tokens || 0) * 1.2 + (st.removed || 0) * 4 + (st.life || 0) * 0.3 + (st.mana || 0) * 0.6 + (st.countered || 0) * 4 + (st.tutored || 0) * 3;
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
      p.command.push(p.commanderCard); p.commanderCard.zone = 'command';
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
      if (!this._ac[key]) this._ac[key] = analyzeCard(this.db[name], colors, name);
      return this._ac[key];
    }

    makeToken(owner, spec) {
      spec = { sub: 'Token', p: 1, t: 1, ...spec };
      const info = {
        // colorless creature tokens here are artifact creatures (Wurmcoil's Wurms, Urza's Saga Constructs, Doombot)
        name: `${spec.sub} token`, types: new Set(spec.artifact || (/colorless/.test(spec.colors || '') && !/Eldrazi/.test(spec.sub)) ? ['Artifact', 'Creature'] : ['Creature']), subtypes: spec.sub.split(' '), isCreature: true, isPermanent: true,
        power: spec.p, toughness: spec.t, kw: new Set(spec.kw || []), cost: parseCost(''), mv: 0,
        colors: new Set(String(spec.colors || '').split(/[\s,]+/).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[w])).filter(Boolean)),
        etb: [], dies: spec.dies || [], attack: [], combatDmg: spec.combatDmg || [], upkeep: [], endstep: [], castTrig: [], deathWatch: [], statics: [], activated: [], loyaltyAbs: [], spell: [], triggers: [], unmodeled: [],
        text: spec.text || `${spec.p}/${spec.t} ${spec.colors || ''} ${spec.sub} creature token${spec.kw && spec.kw.length ? ' with ' + spec.kw.join(', ') : ''}.`,
        tokenColors: spec.colors || '',
      };
      if (spec.artifactToken) {
        const T = { Food: ['{2}, {T}, Sacrifice this artifact: You gain 3 life.', parseCost('2'), [{ k: 'gain', n: 3 }]], Clue: ['{2}, Sacrifice this artifact: Draw a card.', parseCost('2'), [{ k: 'draw', n: 1 }]], Blood: ['{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.', parseCost('1'), [{ k: 'loot', n: 1 }]] }[spec.artifactToken];
        Object.assign(info, { name: spec.artifactToken, types: new Set(['Artifact']), subtypes: [spec.artifactToken], isCreature: false, power: undefined, toughness: undefined, text: T[0], activated: [{ tap: false, sac: true, cost: T[1], fx: T[2], text: T[0], lowPriority: true }] });
      }
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
    // called constantly (every power/toughness/keyword check), so plain loops without allocations
    statics(p, k) { const out = []; for (const c of p.bf) { const ss = c.info.statics; if (ss) for (const s of ss) if (s.k === k) out.push({ s, c }); } return out; }
    has(p, k) { for (const c of p.bf) { const ss = c.info.statics; if (ss) for (const s of ss) if (s.k === k) return true; } return false; }

    hasKw(c, k) { return this.kws(c).has(k); }
    // kws and pt scan every static on the board; cached like creatureValue (until the next event or a change on the card)
    // (each battlefield's size and life total are in the key: a permanent arriving or leaving by any route makes cached values stale)
    bfSig() { let s2 = ''; for (const q of this.players) s2 += q.bf.length + ',' + q.life + '.'; return s2; } // (life too: Bloodghast has haste while an opponent is at 10 or less)
    cacheKey(c) { return this._nnTick + ':' + this.bfSig() + c.p1 + ':' + c.dmg + ':' + c.eot.p + ':' + c.eot.t + ':' + c.eot.kw.length + ':' + c.ctrl + ':' + c.zone + ':' + (c.attached || ''); }
    kws(c) {
      const key = this.cacheKey(c);
      if (c._kw && c._kw.key === key) return c._kw.v;
      const v = this._kws(c); c._kw = { key, v }; return v;
    }
    _kws(c) {
      const s = new Set(c.info.kw);
      c.eot.kw.forEach((k) => s.add(k));
      const ctrl = this.P(c.ctrl);
      if (c.flyingCounter) s.add('flying');
      // Wonder: from the graveyard, with an Island out, our creatures fly
      if (c.info.isCreature && ctrl.gy.some((x) => x.info.gyFlyIsland) && ctrl.bf.some((l) => l.info.isLand && this.landTypes(ctrl, l).includes('Island'))) s.add('flying');
      for (const { s: st, c: src } of this.statics(ctrl, 'anthem')) {
        if (st.other && src === c) continue;
        if (st.sub && !this.isType(c, st.sub)) continue;
        if (st.notSub && (c.info.subtypes || []).includes(st.notSub)) continue;
        st.kw.forEach((k) => s.add(k));
      }
      for (const e of ctrl.emblems || []) if (e === 'elspeth') s.add('flying');
      for (const eq of ctrl.bf) if (eq.attached === c.id) for (const st of eq.info.statics) if (st.k === 'equipBuff' || st.k === 'auraBuff') st.kw.forEach((k) => s.add(k));
      if (c.indestructibleEOT) s.add('indestructible');
      if (this.statics(ctrl, 'allIndestructible').some(({ c: src }) => src !== c)) s.add('indestructible');
      if (c.info.types.has('Artifact') && this.has(ctrl, 'artIndestructible')) s.add('indestructible');
      if (this.statics(ctrl, 'allHexproof').some(({ c: src }) => src !== c)) s.add('hexproof');
      if (c.hexproofEOT) s.add('hexproof');
      if (c.info.statics.some((x) => x.k === 'myrkul') && ctrl.life <= 20) s.add('indestructible');
      if (c.info.hasteIfOppLow && this.opps(ctrl).some((q) => q.life <= c.info.hasteIfOppLow)) s.add('haste');
      if (c.hallHaste) s.add('haste'); // Hall of the Bandit Lord
      if (c.info.types.has('Artifact') && c.info.isCreature && ctrl.bf.some((x) => x !== c && x.info.statics.some((st) => st.k === 'artifactHaste'))) s.add('haste');
      if (c.info.types.has('Enchantment') && this.statics(ctrl, 'enchShroud').some(({ c: src }) => src !== c)) s.add('shroud');
      if (this.statics(ctrl, 'enchShroud').some(({ s: st }) => st.enchantedToo) && ctrl.bf.some((a) => a.attached === c.id && a.info.isAura)) s.add('shroud');
      if (c.indCounter) s.add('indestructible');
      if (c.info.isCreature && this.has(ctrl, 'emissary')) s.add('emissary');
      return s;
    }
    power(c) { return this.pt(c)[0]; }
    toughness(c) { return this.pt(c)[1]; }
    pt(c) {
      const key = this.cacheKey(c);
      if (c._pt && c._pt.key === key) return c._pt.v;
      const v = this._pt(c); c._pt = { key, v }; return v;
    }
    _pt(c) {
      let p = c.info.power ?? 0, t = c.info.toughness ?? 0;
      if (c.info.gyPower) p += c.info.gyPower.p * Math.floor(this.P(c.ctrl).gy.length / c.info.gyPower.per); // (Dark Matter Manipulator)
      if (c.info.ptStar) { const n = this.P(c.ctrl).bf.filter((x) => x.info.isCreature).length; p = Math.max(p, Math.min(n, 8)); t = Math.max(t, Math.min(n, 8)); }
      if (c.info.name === 'Construct token' || /Construct/.test(c.info.name)) { const n = this.P(c.ctrl).bf.filter((x) => x.info.types.has('Artifact')).length; p += n; t += n; }
      p += c.p1 + c.eot.p; t += c.p1 + c.eot.t;
      const ctrl = this.P(c.ctrl);
      for (const { s, c: src } of this.statics(ctrl, 'anthem')) {
        if (s.other && src === c) continue;
        if (s.sub && !this.isType(c, s.sub)) continue;
        if (s.notSub && (c.info.subtypes || []).includes(s.notSub)) continue;
        p += s.p; t += s.t;
      }
      for (const e of ctrl.emblems || []) if (e === 'elspeth') { p += 2; t += 2; }
      if (c.bannerOf && ctrl.bf.some((b) => b.id === c.bannerOf)) { /* handled below */ }
      for (const b of ctrl.bf) if (b.info.banner && b.chosenType && this.isType(c, b.chosenType)) { p += 1; t += 1; }
      for (const q of this.opps(ctrl)) for (const { s } of this.statics(q, 'debuff')) { p -= s.p; t -= s.t; }
      for (const pl of this.players) for (const eq of pl.bf) if (eq.attached === c.id) for (const st of eq.info.statics) if (st.k === 'equipBuff' || st.k === 'auraBuff') { p += st.p; t += st.t; }
      return [p, t];
    }
    isType(c, sub) {
      const col = { Black: 'B', Green: 'G', White: 'W', Blue: 'U', Red: 'R' }[sub];
      if (col) return (c.info.colors && c.info.colors.has(col)) || String(c.info.tokenColors || '').includes(sub.toLowerCase());
      if (sub === 'Colorles' || sub === 'Colorless') return (!c.info.colors || c.info.colors.size === 0) && !c.info.tokenColors?.match(/white|blue|black|red|green/);
      return this.isSubtype(c, sub);
    }
    isSubtype(c, sub) { return (c.info.subtypes || []).includes(sub) || /changeling/i.test(c.info.text || '') || (c.info.kw && c.info.kw.has('changeling')); }
    pacified(c) { return !!c.neutralized && c.neutralized >= this.turn || this.allBf().some((a) => a.attached === c.id && a.info.statics.some((s) => s.k === 'pacify')); }

    emit(kind, text, extra = {}) {
      this._nnTick = (this._nnTick || 0) + 1;
      if (!this.record) return;
      const ev = { kind, text, seat: extra.seat ?? null, cards: extra.cards || [], turn: this.round, active: this.active, phase: this.phase || '' };
      if (this.pendingMana && ['cast', 'ability', 'counter', 'response', 'combo'].includes(kind)) { ev.mana = this.pendingMana; this.pendingMana = null; }
      if (this._crBuf.length) { ev.cr = this._crBuf; this._crBuf = []; }
      ev.snap = this.snapshot(extra);
      if (this.nn && this.started) ev.wp = this.nnWinChances();
      if (extra.nnAdv != null) ev.na = Math.round(extra.nnAdv * 1000) / 10;
      this.events.push(ev);
    }

    snapshot(extra) {
      this.metaSeen = this.metaSeen || {};
      for (const p of this.players) for (const c of p.bf.concat(p.hand, p.command)) if (!this.metaSeen[c.id]) this.metaSeen[c.id] = this.cardMeta(c);
      return {
        players: this.players.map((p) => ({
          life: p.life, poison: p.poison, lost: p.lost, lostReason: p.lostReason, tax: p.tax, fl: { ...(p.floating || {}), ...(p.pool ? { ANY: (p.floating?.ANY || 0) + p.pool } : {}) }, ex: p.exile.map((c) => c.id),
          hand: p.hand.map((c) => c.id), lib: p.library.length, gy: p.gy.map((c) => c.id), exile: p.exile.length,
          command: p.command.map((c) => c.id), cmdDmg: { ...p.cmdDmg },
          bf: p.bf.map((c) => {
            const [pw, tg] = c.info.isCreature ? this.pt(c) : [null, null];
            const o = { id: c.id, tp: c.tapped ? 1 : 0, p: pw, t: tg, l: c.info.isPW ? c.loyalty : null, ctr: c.p1, at: c.attached, sk: c.sick && c.info.isCreature ? 1 : 0, dm: c.dmg };
            if (c.charge && !c.info.saga) o.ch = c.charge;
            if (c.baseInfo || c.transformed) { o.nm = c.copiedFrom ? `${c.name} (as ${c.info.name})` : c.info.name; o.cr = c.info.isCreature ? 1 : 0; o.tx = c.info.face ? c.info.face.oracle : c.info.text; o.ty = [...c.info.types].join(' ') + (c.info.subtypes && c.info.subtypes.length ? ' — ' + c.info.subtypes.join(' ') : '') + (c.copiedFrom && c.info.copy === null && !c.info.isLegendary && (this.cards[c.copiedFrom].info.isLegendary) ? ' (copy — not legendary)' : ''); }
            // a modal double-faced card played as its land face (Bala Ged Recovery → Bala Ged Sanctuary)
            if (c.info.isLand && this.metaSeen[c.id] && !this.metaSeen[c.id].land) { o.ld = 1; o.nm = c.info.name; }
            return o;
          }),
        })),
        attackers: extra.attackers || null,
        stack: extra.stack || null,
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
        if (this.started && this.opps(p).some((q) => this.has(q, 'narset')) && (p.drawsTurn === this.turn ? p.drawsThis : 0) >= 1) break;
        if (this.started && this.tryDredge(p)) continue;
        if (!p.library.length) {
          if (this.has(p, 'labman')) { this.emit('combo', `${p.name} draws from an empty library with Jace, Wielder of Mysteries and wins!`, { seat: p.seat }); for (const q of this.opps(p)) q.life = 0; this.checkState(); return; }
          this.lose(p, 'tried to draw from an empty library'); return;
        }
        const c = p.library.shift(); c.zone = 'hand'; p.hand.push(c); p.cardsDrawn++;
        { const sc = this.ctxSrc(); if (this.started && sc && sc.ctrl === p.seat) this.credit(sc, 'cards', 1); }
        if (p.drawsTurn !== this.turn) { p.drawsTurn = this.turn; p.drawsThis = 0; }
        p.drawsThis++;
        if (this.started) this.onDraw(p);
        // miracle: the first card drawn this turn may be cast right away for its miracle cost
        if (this.started && p.drawsThis === 1 && c.info.miracle && !this._inMiracle && !this.locked(p) && this.pay(p, c.info.miracle) && this.scoreCast(p, c, 'hand') > 0) {
          this._inMiracle = true; this.emit('cast', `Miracle! ${p.name} reveals ${c.info.name}.`, { seat: p.seat, cards: [c.id] });
          try { this.castSpell(p, c, 'miracle'); } finally { this._inMiracle = false; }
        }
      }
      if (this._drawPain) { this._drawPain = false; this.checkState(); }
      if (why) this.emit('draw', `${p.name} draws ${n} card${n > 1 ? 's' : ''}${why ? ' (' + why + ')' : ''}.`, { seat: p.seat });
    }

    onDraw(p) {
      for (const c of p.bf) for (const t of c.info.triggers) if (t.k === 'drawGain') this.gainLife(p, t.n, c);
      if ((p.emblems || []).includes('teferi')) { const t = this.bestOppTarget(p, (x) => !x.info.isLand && this.targetable(x, p)); if (t) { this.exileCard(t); this.emit('removal', `Teferi's emblem exiles ${t.info.name}.`, { seat: p.seat, cards: [t.id] }); } }
      for (const q of this.opps(p)) for (const c of q.bf) for (const t of c.info.triggers) if (t.k === 'oppDrawLose') { this.loseLife(p, t.n, c); this._drawPain = true; }
      // Smothering Tithe: the drawing player may pay {2}; in their own draw step they'd rather keep the mana for their turn
      for (const q of this.opps(p)) for (const c of q.bf) for (const t of c.info.triggers) if (t.k === 'tithe') {
        const ownDraw = this.inDrawStep && p.seat === this.active;
        if (!ownDraw && this.availableMana(p) >= 4 && this.pay(p, parseCost('2'))) { this.pay(p, parseCost('2'), 0, true); continue; }
        this.addToken(q, { treasure: true }, 1, true);
      }
    }

    moveToGraveyard(c, how = 'dies') {
      const ctrl = this.P(c.ctrl), owner = this.P(c.owner);
      const fromBf = c.zone === 'bf';
      const wasArtifact = c.info.types.has('Artifact');
      this.leaveBattlefield(c);
      // a token is put into the graveyard too (then ceases to exist): Ichor Wellspring's draw and Ugin's Nexus's replacement still apply
      if (c.token) { if (fromBf && c.info.statics.some((st) => st.k === 'nexus')) { ctrl.extraTurn = (ctrl.extraTurn || 0) + 1; this.emit('effect', `Ugin's Nexus is exiled instead and ${ctrl.name} takes an extra turn.`, { seat: ctrl.seat, cards: [c.id] }); } else if (fromBf && c.info.gyDraw) this.draw(ctrl, c.info.gyDraw); return; }
      if (c.isCommander) { c.zone = 'command'; owner.command.push(c); this.emit('move', `${c.info.name} returns to the command zone.`, { seat: owner.seat, cards: [c.id] }); return; }
      if (fromBf && c.info.statics.some((st) => st.k === 'nexus')) { c.zone = 'exile'; owner.exile.push(c); owner.extraTurn = (owner.extraTurn || 0) + 1; this.emit('effect', `Ugin's Nexus is exiled instead and ${owner.name} takes an extra turn.`, { seat: owner.seat, cards: [c.id] }); return; }
      if (fromBf && wasArtifact && (ctrl.emblems || []).includes('artifactRecursion')) { ctrl.delayedReturn = ctrl.delayedReturn || []; ctrl.delayedReturn.push(c); }
      if (fromBf && c.info.isPW && !c.token) for (const x of ctrl.bf) if (x.info.pwDiesDig) this.resolveEffect(ctrl, { k: 'dig', n: 7, types: ['planeswalker'] }, x, 0, false); // Carth
      if (fromBf && c.info.gyDraw) { this.toGraveyard(c, ctrl.seat); this.draw(ctrl, c.info.gyDraw); this.emit('draw', `${c.info.name} was put into the graveyard: ${ctrl.name} draws a card.`, { seat: ctrl.seat, cards: [c.id] }); return; }
      this.toGraveyard(c, ctrl.seat);
    }
    // Every card headed to a graveyard goes through here (replacement effects live here)
    // lastCtrl: who controlled the card just before (the caster of a spell, the controller of a permanent)
    toGraveyard(c, lastCtrl = c.owner) {
      const owner = this.P(c.owner);
      if (c.whipped) { c.whipped = false; c.zone = 'exile'; owner.exile.push(c); return; } // Whip of Erebos
      if (c.info.shuffleBack) { c.zone = 'library'; owner.library.push(c); this.R.shuffle(owner.library); return; }
      // Valgavoth: "If a card you didn't control would be put into an opponent's graveyard, exile it instead"
      const voider = this.alive().find((q) => q !== owner && this.statics(q, 'voidExile').some(({ s: st }) => !st.valgavoth || q.seat !== lastCtrl)); // (Dauthi takes everything; Valgavoth only cards its controller didn't control)
      if (voider) { c.zone = 'exile'; c.voidBy = voider.seat; owner.exile.push(c); return; }
      if (!c.token && (owner.emblems || []).includes('tamiyo')) { c.zone = 'hand'; owner.hand.push(c); return; } // Tamiyo, the Moon Sage's emblem: it goes back to hand
      c.zone = 'gy'; owner.gy.push(c);
      if (c.info.isPermanent) for (const x of owner.bf) if (x.info.gyShrinkRemove && x.p1 < 0) x.p1 += 1; // (Moonshadow)
      if (c.info.isLand) { if (this._landBatch) this._landBatch.add(owner.seat); else for (const x of owner.bf) for (const t of x.info.triggers) if (t.k === 'landToGy') this.resolveEffects(owner, t.fx, x, null, false); }
    }
    discardCard(p, c) {
      this.removeFrom(p.hand, c); if (this.has(p, 'necro')) { c.zone = 'exile'; p.exile.push(c); } else this.toGraveyard(c);
      // Archfiend of Ifnir: each discard puts a -1/-1 counter on every creature the opponents control
      const fiends = p.bf.filter((x) => x !== c && x.info.triggers.some((t) => t.k === 'discardShrink')).length;
      if (fiends && this.started) { for (const q of this.opps(p)) for (const x of q.bf) if (x.info.isCreature) x.p1 -= fiends; this.emit('effect', `Archfiend of Ifnir: -1/-1 counters on every opposing creature.`, { seat: p.seat }); this.checkState(); }
    }
    discardWorst(p, n = 1, keepLands = false) {
      // discarding several cards is one event: "one or more land cards" (The Gitrog Monster) triggers once
      const batch = !this._landBatch; if (batch) this._landBatch = new Set();
      for (let i = 0; i < n && p.hand.length; i++) { const pool = keepLands && p.hand.some((c) => !c.info.isLand) ? p.hand.filter((c) => !c.info.isLand) : p.hand; const d = pool.slice().sort((a, b) => this.cardValue(p, a) + this.nnAdv(p, a) * 40 - this.cardValue(p, b) - this.nnAdv(p, b) * 40)[0]; this.discardCard(p, d); }
      if (batch) { const seats = this._landBatch; this._landBatch = null; for (const s2 of seats) { const q = this.P(s2); for (const x of q.bf) for (const t of x.info.triggers) if (t.k === 'landToGy') this.resolveEffects(q, t.fx, x, null, false); } }
    }
    mill(p, n) {
      const out = [];
      // one event: "one or more land cards" (The Gitrog Monster) triggers once, not per land
      const batch = !this._landBatch; if (batch) this._landBatch = new Set();
      for (let i = 0; i < n && p.library.length; i++) { const c = p.library.shift(); this.toGraveyard(c); out.push(c); }
      if (batch) { const seats = this._landBatch; this._landBatch = null; for (const s2 of seats) { const q = this.P(s2); for (const x of q.bf) for (const t of x.info.triggers) if (t.k === 'landToGy') this.resolveEffects(q, t.fx, x, null, false); } }
      // Sidisi: whenever one or more creature cards are milled from your library, make a 2/2 Zombie
      if (out.some((c) => c.info.isCreature && c.zone === 'gy')) for (const x of p.bf) if (x.info.sidisi) { this.addToken(p, { p: 2, t: 2, sub: 'Zombie', colors: 'black' }, 1, true); this.emit('token', `Sidisi: a creature card was milled, ${p.name} makes a 2/2 Zombie.`, { seat: p.seat, cards: [x.id] }); }
      return out;
    }
    tryDredge(p) {
      const loam = p.gy.find((c) => c.info.dredge && p.library.length > c.info.dredge + 5);
      if (!loam || p.hand.filter((c) => c.info.isLand).length >= 2 || this.inDrawStep !== true) return false;
      this.removeFrom(p.gy, loam); loam.zone = 'hand'; p.hand.push(loam); this.mill(p, loam.info.dredge);
      this.emit('effect', `${p.name} dredges ${loam.info.name} instead of drawing.`, { seat: p.seat, cards: [loam.id] });
      return true;
    }

    leaveBattlefield(c) {
      this._nnTick = (this._nnTick || 0) + 1; // (the board changed: cached values are stale)
      const ctrl = this.P(c.ctrl);
      const i = ctrl.bf.indexOf(c); if (i >= 0) ctrl.bf.splice(i, 1);
      c.zone = 'leaving'; // so what it sets off on the way out (an Animate Dead falling off) can't move it a second time
      // drop attachments
      for (const pl of this.players) for (const a of [...pl.bf]) {
        if (a.attached === c.id) {
          a.attachedWas = c.id;
          if (a.info.isAura && !a.info.enchDies && !a.info.ghostform) { this.destroy(a, 'falls off', true); } else a.attached = null; // enchDies / Ghostform auras trigger first; checkState then puts them in the graveyard
        }
      }
      if (c.attached && c.info.reanimAura) {
        const tgt = this.cards[c.attached]; if (tgt && tgt.zone === 'bf') this.destroy(tgt, 'sacrificed', true);
      }
      if (c.meldPartner != null) { (this._meldFollow = this._meldFollow || []).push(c); }
      if (c.uginCard != null) { const x = this.cards[c.uginCard]; c.uginCard = null; const o = x && this.P(x.owner); if (x && x.zone === 'exile' && o.exile.includes(x)) { this.removeFrom(o.exile, x); x.zone = 'hand'; x.faceDown = false; o.hand.push(x); this.emit('draw', `The Spirit leaves: ${o.name} puts the card Ugin exiled into their hand.`, { seat: o.seat, cards: [c.id] }); } }
      c.attached = null; c.tapped = false; c.p1 = 0; c.dmg = 0; c.dt = false; c.eot = { p: 0, t: 0, kw: [] }; c.ctrl = c.owner; c.loyalty = 0; c.indestructibleEOT = false; c.hexproofEOT = false;
      c.copiedFrom = null; c.copyPlusOne = false; c.indCounter = false; c.neutralized = 0; c.frozenUntil = 0; c.charge = 0; c.harnessed = false; c.transformed = false; c.chosenType = null; c.age = 0; c.prepared = false; c.animatedBy = null; c.hallHaste = false;
      this.restoreInfo(c);
    }

    destroy(c, why = 'destroyed', force = false) {
      if (c.zone !== 'bf') return false;
      if (!force && this.hasKw(c, 'indestructible')) return false;
      const ctrl = this.P(c.ctrl);
      // about to die anyway (removal, a wipe, -X/-X, lethal damage): a creature whose own sacrifice gets something
      // (Sakura-Tribe Elder's land) is sacrificed in response, so the value isn't lost
      if (why !== 'sacrificed' && !this._sacInResponse && !ctrl.lost) {
        const ab = this.selfSacAb(c);
        if (ab && !this.locked(ctrl) && !this.abolished(ctrl, 'ability')) {
          this._sacInResponse = true;
          this.emit('response', `${ctrl.name} sacrifices ${c.info.name} in response.`, { seat: ctrl.seat, cards: [c.id] });
          try { this.doActivate(ctrl, { c, ab, fodder: [], cost: ab.cost }); } finally { this._sacInResponse = false; }
          if (c.zone !== 'bf') return true;
        }
      }
      const wasCreature = c.info.isCreature;
      const undying = this.hasKw(c, 'undying') && c.p1 === 0 && !c.token;
      const persist = this.hasKw(c, 'persist') && c.p1 >= 0 && !c.token && !undying;
      // Yahenni: sacrifice another creature to make it indestructible in response
      if (!force && c.info.yahenni) { const f = ctrl.bf.filter((x) => x !== c && x.info.isCreature && !x.isCommander).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0]; if (f && this.creatureValue(f) < this.creatureValue(c) + 4) { this.emit('response', `${ctrl.name} sacrifices ${this.cname(f)}: Yahenni gains indestructible.`, { seat: ctrl.seat, cards: [c.id, f.id] }); this.destroy(f, 'sacrificed', true); c.indestructibleEOT = true; return false; } }
      if (!force && c.info.koma) { const coil = ctrl.bf.find((x) => x !== c && x.info.isCreature && this.isType(x, 'Serpent')); if (coil) { this.destroy(coil, 'sacrificed', true); c.indestructibleEOT = true; this.emit('response', `${ctrl.name} sacrifices a Serpent: Koma gains indestructible.`, { seat: ctrl.seat, cards: [c.id] }); return false; } }
      // Kalitas: an opponent's nontoken creature is exiled instead and Kalitas's controller makes a Zombie
      const kal = wasCreature && !c.token && this.alive().find((q) => q.seat !== c.ctrl && this.has(q, 'kalitas'));
      const auras = ctrl.bf.filter((a) => a.attached === c.id);
      // Kalitas: it's exiled instead of dying, so nothing that cares about dying triggers
      if (kal) { this.emit('effect', `Kalitas exiles ${c.info.name} instead${c.isCommander ? ' (it goes to the command zone)' : ''} and ${kal.name} makes a 2/2 Zombie.`, { seat: kal.seat, cards: [c.id] }); this.exileCard(c); this.addToken(kal, { p: 2, t: 2, sub: 'Zombie', colors: 'black' }, 1, true); return true; }
      this.moveToGraveyard(c);
      if (wasCreature) this.onDeath(c, ctrl);
      for (const a of auras) {
        if (a.info.enchDies) this.resolveEffects(ctrl, a.info.enchDies, a, `${a.info.name} triggers`);
        if (a.info.ghostform && c.zone === 'gy') { this.removeFrom(this.P(c.owner).gy, c); this.enterBattlefield(c, ctrl, { quiet: true }); this.emit('reanimate', `Kaya's Ghostform returns ${c.info.name}.`, { seat: ctrl.seat, cards: [c.id] }); }
        if (a.zone === 'bf' && !a.attached) this.moveToGraveyard(a);
      }
      if (c.zone === 'gy' && wasCreature && c.info.returnsAsEnchantment) { this.removeFrom(this.P(c.owner).gy, c); this.enterBattlefield(c, ctrl, { quiet: true, noEtb: true }); this.setInfo(c, { isCreature: false, types: new Set(['Enchantment']), power: undefined, toughness: undefined }); this.emit('reanimate', `${c.info.name} returns as an enchantment.`, { seat: ctrl.seat, cards: [c.id] }); }
      if (c.zone === 'gy' && wasCreature && c.info.diesTransform && c.info.flipFace) { this.removeFrom(this.P(c.owner).gy, c); this.enterBattlefield(c, this.P(c.owner), { quiet: true, noEtb: true }); this.transform(c); }
      // undying: it returns *with* a +1/+1 counter (on it before its enters triggers), so it won't come back again
      if (undying && c.zone === 'gy') { this.removeFrom(this.P(c.owner).gy, c); this.enterBattlefield(c, this.P(c.owner), { quiet: true, p1: 1 }); this.emit('reanimate', `${c.info.name} returns with a +1/+1 counter (undying).`, { seat: c.owner, cards: [c.id] }); }
      // persist: returns with a -1/-1 counter (counters cancel, so a creature with +1/+1 counters can persist too)
      if (persist && c.zone === 'gy') { this.removeFrom(this.P(c.owner).gy, c); this.enterBattlefield(c, this.P(c.owner), { quiet: true, p1: -1 }); this.emit('reanimate', `${c.info.name} returns with a -1/-1 counter (persist).`, { seat: c.owner, cards: [c.id] }); }
      return true;
    }

    exileCard(c) {
      if (c.zone !== 'bf') return;
      const owner = this.P(c.owner), ctrl = this.P(c.ctrl);
      const auras = ctrl.bf.filter((a) => a.attached === c.id && a.info.isAura);
      this.leaveBattlefield(c);
      this.dropAuras(c, ctrl, auras, true);
      if (c.token) return;
      if (c.isCommander) { c.zone = 'command'; owner.command.push(c); return; }
      c.zone = 'exile'; owner.exile.push(c);
      for (const a of auras) if (a.info.ghostform) { this.removeFrom(owner.exile, c); this.enterBattlefield(c, ctrl, { quiet: true }); this.emit('reanimate', `Kaya's Ghostform returns ${c.info.name}.`, { seat: ctrl.seat, cards: [c.id] }); }
    }
    dropAuras(c, ctrl, auras) { for (const a of auras) if (a.zone === 'bf' && !a.attached) this.moveToGraveyard(a); }

    bounce(c) {
      if (c.zone !== 'bf') return;
      const owner = this.P(c.owner), ctrl = this.P(c.ctrl);
      const auras = ctrl.bf.filter((a) => a.attached === c.id && a.info.isAura);
      this.leaveBattlefield(c);
      this.dropAuras(c, ctrl, auras);
      if (c.token) return;
      // A commander headed to hand may go to the command zone instead; hand is better (casting it from hand
      // adds no commander tax), so it goes to hand.
      if (c.isCommander) this.emit('move', `${c.info.name} goes back to ${owner.name}'s hand (no commander tax to recast it from there).`, { seat: owner.seat, cards: [c.id] });
      c.zone = 'hand'; owner.hand.push(c);
    }

    // Give one card its own copy of its rules info, with overrides (animation, copies, transformations)
    setInfo(c, over) {
      this._nnTick = (this._nnTick || 0) + 1;
      if (!c.baseInfo) c.baseInfo = c.info;
      c.info = Object.assign(Object.create(Object.getPrototypeOf(c.info)), c.info, over);
    }
    restoreInfo(c) { if (c.baseInfo) { c.info = c.baseInfo; c.baseInfo = null; } }
    transform(c) {
      const base = c.baseInfo || c.info;
      const other = c.transformed ? base : (base.flipFace || base.faces && base.faces[1]);
      if (!other) return;
      c.transformed = !c.transformed;
      if (c.transformed) { if (!c.baseInfo) c.baseInfo = c.info; c.info = Object.assign(Object.create(Object.getPrototypeOf(other)), other, { faces: base.faces, flipFace: base.flipFace }); }
      else this.restoreInfo(c);
      this.emit('effect', `${c.name} transforms into ${c.info.name}.`, { seat: c.ctrl, cards: [c.id] });
    }

    removeFrom(arr, c) { const i = arr.indexOf(c); if (i >= 0) arr.splice(i, 1); }

    // Creatures that die at the same time (a wipe, -X/-X, combat damage) still see each other die: "whenever
    // a creature dies" abilities look back in time. Remember the watchers that were on the battlefield when
    // the batch started, so Myrkul or Blood Artist dying alongside the others still triggers for them.
    beginDeathBatch() {
      if (this._batch) return false;
      this._batch = new Map();
      for (const q of this.players) this._batch.set(q.seat, q.bf.filter((c) => c.info.deathWatch.length || c.info.triggers.some((t) => t.k === 'myrkul')));
      return true;
    }
    endDeathBatch(started) { if (started) this._batch = null; }
    watchers(pl, dead) {
      const extra = this._batch ? (this._batch.get(pl.seat) || []).filter((x) => x !== dead && x.zone !== 'bf') : [];
      return extra.length ? pl.bf.filter((x) => x !== dead).concat(extra) : pl.bf.filter((x) => x !== dead);
    }
    onDeath(c, ctrl, exiled = false) {
      this.deathsThisTurn = (this.deathsThisTurn || 0) + 1;
      for (const src of ctrl.bf) if (src.info.equipDies && src.attachedWas === c.id) this.resolveEffects(ctrl, src.info.equipDies, src, null, true);
      if (!c.token && !c.isCommander && c.zone === 'gy' && this.watchers(ctrl, c).some((m) => m.info.triggers.some((t) => t.k === 'myrkul'))) {
        this.removeFrom(this.P(c.owner).gy, c); c.zone = 'exile'; this.P(c.owner).exile.push(c);
        const info = Object.assign(Object.create(Object.getPrototypeOf(c.info)), c.info, { isCreature: false, types: new Set(['Enchantment']), name: c.info.name, power: undefined, toughness: undefined });
        const copies = this.tokenMult(ctrl);
        const made = [];
        for (let k = 0; k < copies; k++) { const t = { id: this.nextId++, name: c.info.name, info, owner: ctrl.seat, ctrl: ctrl.seat, isCommander: false, token: true, tapped: false, sick: true, p1: 0, loyalty: 0, dmg: 0, dt: false, attached: null, eot: { p: 0, t: 0, kw: [] }, zone: 'bf', ench: true }; this.cards[t.id] = t; ctrl.bf.push(t); made.push(t); }
        this.refreshAnimations(); // Opalescence makes the copies creatures as they enter
        this.emit('trigger', `Myrkul exiles ${c.info.name} and makes ${copies > 1 ? copies + ' enchantment token copies' : 'an enchantment token copy'} of it.`, { seat: ctrl.seat, cards: made.map((t) => t.id) });
        // each copy "enters the battlefield", so its own enters abilities trigger again (and creature-enters ones, if animated)
        for (const t of made) {
          if (t.zone !== 'bf') continue;
          if (t.info.isCreature) this.creatureEntered(ctrl, t);
          if (info.etb && info.etb.length) this.resolveEffects(ctrl, info.etb, t, `${info.name} (enchantment copy) enters`, false);
          for (const src of [...ctrl.bf]) for (const fx of (src.info.constellation || [])) this.resolveEffects(ctrl, fx, src, `${src.info.name} (constellation)`, true);
        }
      }
      // own dies triggers
      if (c.info.dies.length) this.resolveEffects(ctrl, c.info.dies, c, `${c.info.name} dies`);
      this._dyingCard = c;
      for (const pl of this.alive()) for (const src of this.watchers(pl, c).concat(pl === ctrl && c.info.deathWatch.some((w) => w.orSelf) ? [c] : [])) {
        for (const w of src.info.deathWatch) {
          if (src === c && !w.orSelf) continue; // "Blood Artist or another creature": it sees its own death
          if (w.scope === 'mine' && pl !== ctrl) continue;
          if (w.scope === 'opp' && pl === ctrl) continue;
          if (w.nontoken && c.token) continue;
          this.resolveEffects(pl, w.fx, src, `${src.info.name} (${this.cname(c)} died) triggers`, true);
        }
        // Skullclamp-style "whenever equipped creature dies"
        if (src.attachedWas === c.id && src.info.equipDies && pl === ctrl) { /* resolved above */ }
      }
    }

    lose(p, reason) {
      if (p.lost) return;
      if (this.has(p, 'platinum')) return;
      p.lost = true; p.lostReason = reason;
      // everything they own leaves the game; things they controlled that others own are exiled (rule 800.4a)
      for (const c of [...p.bf]) {
        if (c.zone !== 'bf') continue; // already moved by something else leaving (an Animate Dead falling off)
        this.leaveBattlefield(c);
        if (c.owner !== p.seat && !c.token) { c.zone = 'exile'; this.P(c.owner).exile.push(c); } else c.zone = 'gone';
      }
      for (const pl of this.players) for (const c of [...pl.bf]) if (c.owner === p.seat && c.zone === 'bf') { this.leaveBattlefield(c); c.zone = 'gone'; }
      this.emit('lose', `${p.name} is eliminated: ${reason}.`, { seat: p.seat });
      const alive = this.alive();
      if (alive.length === 1 && !this.over) { this.over = true; this.winner = alive[0].seat; this.emit('win', `${alive[0].name} wins the game!`, { seat: alive[0].seat }); }
    }

    // ----- life -----
    loseLife(p, n, source) {
      if (n <= 0 || p.lost) return 0;
      if (p.protectedUntil >= this.turn) return 0;
      const act = this.P(this.active);
      if (act !== p && this.has(act, 'bloodletter')) n *= 2 ** this.statics(act, 'bloodletter').length;
      p.life -= n;
      { const sc = source || this.ctxSrc(); if (sc && sc.ctrl !== p.seat) this.credit(sc, 'dmg', n); }
      if (p.lostTurn !== this.turn) { p.lostTurn = this.turn; p.lostThis = 0; }
      p.lostThis += n;
      for (const c of p.bf) for (const t of c.info.triggers) if (t.k === 'vilis' && (this._vilisDepth || 0) < 2) { this._vilisDepth = (this._vilisDepth || 0) + 1; const vn = Math.min(n, Math.max(0, p.library.length - 3)); this.draw(p, vn); if (vn) this.emit('draw', `Vilis: ${p.name} draws ${vn}.`, { seat: p.seat, cards: [c.id] }); this._vilisDepth--; }
      this._lossDepth = (this._lossDepth || 0) + 1;
      if (this._lossDepth < 8) for (const q of this.opps(p)) for (const c of q.bf) for (const t of c.info.triggers) if (t.k === 'exquisite') this.gainLife(q, n, c);
      this._lossDepth--;
      return n;
    }
    gainLife(p, n, source) {
      if (n <= 0 || p.lost) return;
      if (p.protectedUntil >= this.turn) return;
      if (this.opps(p).some((q) => this.has(q, 'noOppGain'))) return;
      { const sc = source || this.ctxSrc(); if (sc && sc.ctrl === p.seat) this.credit(sc, 'life', n); }
      p.life += n;
      const trig = p.bf.flatMap((c) => c.info.triggers.map((t) => ({ t, c })));
      const bonds = this.bondTriggers(p);
      if (bonds.length && trig.some((x) => x.t.k === 'exquisite')) {
        // Sanguine Bond + Exquisite Blood style loop: every opponent drains out
        const names = [...new Set(bonds.concat(trig.filter((x) => x.t.k === 'exquisite')).map((x) => x.c.info.name))].join(' + ');
        if (p.drainTurn !== this.turn) this.emit('combo', `${names}: ${p.name} goes infinite and drains the table!`, { seat: p.seat, cards: trig.map((x) => x.c.id) }); // (once a turn: a Platinum Angel or Teferi's Protection can leave someone standing)
        p.drainTurn = this.turn;
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
    // Damage multipliers: Fiery Emancipation triples, Gisela doubles damage to her controller's opponents and halves damage to them
    scaleDamage(srcSeat, tgtSeat, n) {
      if (n <= 0) return 0;
      const src = this.P(srcSeat);
      n *= 3 ** this.statics(src, 'dmgTriple').length * 2 ** this.statics(src, 'dmgDouble').length;
      for (const g of this.alive()) for (let i = 0; i < this.statics(g, 'gisela').length; i++) {
        if (tgtSeat === g.seat) n = Math.floor(n / 2); else n *= 2;
      }
      return n;
    }
    // Deal noncombat damage from p's source to the best target: an opponent it would kill, a valuable creature it kills, or the weakest opponent
    dealDamageAny(p, n, src, why) {
      const name = src ? src.info.name : p.name;
      const killable = this.opps(p).filter((q) => q.protectedUntil < this.turn && !this.has(q, 'chasm') && this.scaleDamage(p.seat, q.seat, n) >= q.life);
      if (killable.length) { const q = killable[0]; const d = this.preventPlayerDamage(q, this.scaleDamage(p.seat, q.seat, n), src && src.info.isCreature); this.loseLife(q, d, src); this.sowerEcho(q, d); this.emit('damage', `${name} deals ${d} damage to ${q.name}${why ? ' (' + why + ')' : ''}.`, { seat: p.seat, cards: src ? [src.id] : [], target: q.seat }); this.checkState(); return; }
      const tgt = this.bestOppTarget(p, (c) => c.info.isCreature && this.targetable(c, p) && !this.hasKw(c, 'indestructible') && this.toughness(c) - c.dmg <= this.scaleDamage(p.seat, c.ctrl, n) && this.creatureValue(c) >= 5);
      if (tgt) { const d = this.scaleDamage(p.seat, tgt.ctrl, n); this.permDmg(tgt, d); this.emit('removal', `${name} deals ${d} damage to ${tgt.info.name}${why ? ' (' + why + ')' : ''}.`, { seat: p.seat, cards: [tgt.id], target: tgt.ctrl }); this.checkState(); return; }
      const q = this.opps(p).filter((x) => x.protectedUntil < this.turn).sort((a, b) => a.life - b.life)[0];
      if (q) { const d = this.preventPlayerDamage(q, this.scaleDamage(p.seat, q.seat, n), src && src.info.isCreature); this.loseLife(q, d, src); this.sowerEcho(q, d); this.emit('damage', `${name} deals ${d} damage to ${q.name}${why ? ' (' + why + ')' : ''}.`, { seat: p.seat, cards: src ? [src.id] : [], target: q.seat }); this.checkState(); }
    }
    landTypes(p, land) {
      const t = (land.info.subtypes || []).slice();
      for (const q of this.alive()) for (const c of q.bf) {
        if (c.info.addsLandType) t.push(c.info.addsLandType);
      }
      if (p.bf.some((c) => c.info.allBasicTypes)) t.push('Plains', 'Island', 'Swamp', 'Mountain', 'Forest');
      return t;
    }
    // How many counters actually land: doublers, Hardened-Scales style +1, Vorinclex halving for its opponents
    // kind: 'p1' (+1/+1 counters), 'loyalty', 'charge', or 'cost' (loyalty put on to activate a + ability)
    counterAmount(p, n, kind = 'p1') {
      if (!n) return 0;
      n *= this.counterMult(p, kind);
      // +1 per counter-adder (Pir adds to every kind, but not to loyalty put on as an ability's cost)
      if (kind === 'p1') n += this.statics(p, 'counterPlus').length; else if (kind !== 'cost') n += this.statics(p, 'counterPlus').filter(({ s: st }) => st.allKinds).length;
      if (this.opps(p).some((q) => this.has(q, 'vorinclexHalf'))) n = Math.floor(n / 2);
      return n;
    }
    favouriteType(p) {
      const count = {};
      for (const c of p.library.concat(p.hand, p.bf, p.command)) if (c.info.isCreature) for (const t of c.info.subtypes || []) count[t] = (count[t] || 0) + 1;
      return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Human';
    }
    // Charismatic Conqueror: an opponent's artifact/creature entering untapped → they tap it or the Conqueror's controller gets a Vampire
    untappedEntry(p, c) {
      if (c.tapped) return;
      for (const q of this.opps(p)) for (const src of q.bf) for (const t of src.info.triggers) if (t.k === 'conqueror') {
        if (c.info.isCreature && !c.info.mana) { c.tapped = true; continue; }
        this.addToken(q, { p: 1, t: 1, sub: 'Vampire', colors: 'white', kw: ['lifelink'] }, 1, true);
      }
    }
    // What copying x is worth to p. A copy of a legend p already controls dies to the legend rule at once (Phantasmal
    // Image on our own Muldrotha), unless the copy isn't legendary or the legend rule is off for us (Sakashima).
    copyWorth(p, info, x, self = null) {
      const cp = info.copy;
      const clash = !cp.nonLegendary && x.info.isLegendary && !this.has(p, 'noLegendRule') && !(cp.keepAbilities && info.statics.some((st) => st.k === 'noLegendRule')) && p.bf.some((y) => y !== self && y.info.name === x.info.name);
      return clash ? 0 : this.permValue(x);
    }
    copyOnEnter(c, p) {
      const cp = c.info.copy;
      const pool = (cp.own ? p.bf : this.allBf()).filter((x) => x !== c && (cp.what === 'creature' ? x.info.isCreature : cp.what === 'artifact' ? x.info.types.has('Artifact') : (x.info.isCreature || x.info.isPW)) && !x.token);
      const worth = (x) => this.copyWorth(p, c.info, x, c);
      const best = pool.sort((a, b) => worth(b) - worth(a))[0];
      if (!best || worth(best) <= 0 || (cp.optional && worth(best) < 6)) return;
      const base = best.baseInfo || best.info;
      const keep = { copy: null, scripted: true };
      if (cp.nonLegendary) { keep.isLegendary = false; keep.types = new Set([...base.types].filter((t) => t !== 'Legendary')); }
      if (cp.eot) keep.kw = new Set([...base.kw, 'haste']);
      // "except it has [this card]'s other abilities" (Sakashima): its own statics survive the copy
      if (cp.keepAbilities) keep.statics = [...(base.statics || []), ...(c.info.statics || [])];
      this.setInfo(c, Object.assign({}, base, keep));
      c.copiedFrom = best.id;
      if (cp.plusOne) c.copyPlusOne = true;
      if (cp.eot) c.animatedEOT = true;
      this.emit('effect', `${c.name} enters as a copy of ${best.info.name}.`, { seat: p.seat, cards: [c.id, best.id] });
    }
    counterMult(p, kind = 'p1') {
      const own = this.statics(p, 'counterDouble').filter(({ s: st }) => !(kind === 'cost' && st.effectOnly)).length;
      const vigor = kind === 'p1' ? this.alive().reduce((s2, q) => s2 + this.statics(q, 'globalDouble').length, 0) : 0; // Primal Vigor: +1/+1 counters only
      return 2 ** (own + vigor);
    }

    // Life-loss loops: a "whenever you gain life, opponents lose life" effect plus a "whenever an opponent loses life, you gain that much" effect
    bondTriggers(p) { return p.bf.flatMap((c) => c.info.triggers.filter((t) => t.k === 'bond' || (t.k === 'onGain' && t.fx.some((f) => f.k === 'drain' || f.k === 'drainOne'))).map((t) => ({ t, c }))); }

    // ----- combos -----
    piecesOf(p, combo) {
      const where = (n) => p.bf.some((c) => c.name === n) ? 'bf' : p.hand.some((c) => c.name === n) ? 'hand' : p.library.some((c) => c.name === n) ? 'lib' : null;
      return combo.pieces.map((alts) => { for (const z of ['bf', 'hand', 'lib']) { const n = alts.find((a) => where(a) === z); if (n) return { name: n, zone: z }; } return null; });
    }
    // The card names that would complete (or advance) a combo for p, best first
    comboWants(p) {
      const out = [];
      for (const combo of COMBOS) {
        const ps = this.piecesOf(p, combo);
        if (ps.some((x) => !x)) continue;
        const have = ps.filter((x) => x.zone === 'bf').length;
        const missing = ps.filter((x) => x.zone !== 'bf');
        if (have >= combo.pieces.length - 2 && missing.length) out.push({ combo, missing, have });
      }
      return out.sort((a, b) => a.missing.length - b.missing.length);
    }
    completesCombo(p, card) {
      return COMBOS.some((combo) => combo.pieces.some((alts) => alts.includes(card.name)) && combo.pieces.every((alts) => alts.includes(card.name) || alts.some((n) => p.bf.some((c) => c.name === n))));
    }
    infiniteMana(p) {
      const mono = p.bf.find((c) => c.info.name === 'Basalt Monolith');
      if (!mono || this.locked(p) || !(!mono.tapped || this.availableMana(p) >= 3)) return false;
      const rings = p.bf.some((c) => c.info.statics.some((st) => st.k === 'rings'));
      const monument = p.bf.some((c) => c.info.monument); // Monolith taps for 4, untap costs 3
      const zirda = this.statics(p, 'reduceAbilities').length; // untap costs 1, makes 3
      return !!(rings || monument || zirda);
    }
    // a piece of a combo that is all on p's battlefield (never sacrifice Basalt Monolith while it makes infinite mana)
    livePiece(p, x) { return COMBOS.some((cb) => cb.pieces.some((alts) => alts.includes(x.name)) && cb.pieces.every((alts) => alts.includes(x.name) || alts.some((n) => p.bf.some((c) => c !== x && c.name === n)))); }
    locked(p) { return this.opps(p).some((q) => this.has(q, 'karn')) && this.alive().some((q) => this.has(q, 'lattice')); }
    // Karn, the Great Creator: activated abilities of artifacts your opponents control can't be activated
    karnStops(p, c) { return (c.info.types.has('Artifact') || this.alive().some((q) => this.has(q, 'lattice'))) && this.opps(p).some((q) => this.has(q, 'karn')); }

    // Check for infinite combos on p's board and cash them in
    // Myrkul + Devoted Druid: let the Druid die to its own -1/-1 counters; Myrkul brings it back as an
    // enchantment, which isn't a creature, so the counters do nothing and it untaps forever: unlimited green mana.
    myrkulDruid(p) {
      if (p.lost || this.over) return false;
      const noAnimate = () => !this.alive().some((q) => this.has(q, 'opalescence'));
      let copy = p.bf.find((x) => x.ench && x.info.druid && !x.info.isCreature);
      if (!copy) {
        const myrkul = p.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul'));
        const druid = p.bf.find((x) => x.info.druid && x.info.isCreature && !x.token && !x.isCommander);
        if (!myrkul || !druid || !noAnimate() || this.locked(p)) return false;
        this.emit('combo', `${p.name} puts -1/-1 counters on Devoted Druid until it dies, so Myrkul brings it back as an enchantment.`, { seat: p.seat, cards: [druid.id] });
        for (let i = 0; i < 6 && druid.zone === 'bf'; i++) { druid.p1 -= 1; this.addFloating(p, 'G', 1); this.checkState(); }
        this.refreshAnimations();
        copy = p.bf.find((x) => x.ench && x.info.druid && !x.info.isCreature);
        if (!copy) return false;
      }
      if (p.infMana === this.turn && (p.infColors || []).includes('G')) return false;
      p.infMana = this.turn; p.infColors = [...new Set([...(p.infColors || []), 'G'])];
      if (!p.druidLoopShown) { p.druidLoopShown = true; this.emit('combo', `The enchantment Devoted Druid taps for G, takes a -1/-1 counter that does nothing to a non-creature, untaps, and does it again: ${p.name} has unlimited green mana.`, { seat: p.seat, cards: [copy.id] }); }
      else this.emit('combo', `${p.name} loops the enchantment Devoted Druid for unlimited green mana again.`, { seat: p.seat, cards: [copy.id] });
      return true;
    }
    checkCombos(p) {
      if (p.lost || this.over) return;
      if (this.has(p, 'karn') && this.alive().some((q) => this.has(q, 'lattice')) && !p.lockAnnounced) {
        p.lockAnnounced = true;
        this.emit('combo', `Karn + Mycosynth Lattice: every permanent is an artifact, so ${p.name}'s opponents can't tap anything for mana!`, { seat: p.seat, cards: p.bf.filter((c) => c.name.startsWith('Karn') || c.name === 'Mycosynth Lattice').map((c) => c.id) });
      }
      if (this.infiniteMana(p)) {
        if (!p.infMana) { const en = p.bf.find((c) => c.info.statics.some((st) => st.k === 'rings' || st.k === 'reduceAbilities') || c.info.monument); p.infMana = this.turn; this.emit('combo', `Basalt Monolith + ${en ? en.info.name : 'Rings of Brighthearth'}: ${p.name} makes infinite colorless mana.`, { seat: p.seat, cards: p.bf.filter((c) => c.name === 'Basalt Monolith' || c === en).map((c) => c.id) }); }
        p.infMana = this.turn;
        const staff = p.bf.find((c) => c.name === 'Staff of Domination');
        if (staff && p.life < 500) { this.gainLife(p, 1000 - p.life); this.draw(p, Math.min(8, Math.max(0, p.library.length - 5))); this.emit('combo', `Staff of Domination: ${p.name} loops it for infinite life and draws a pile of cards.`, { seat: p.seat, cards: [staff.id] }); }
        const flux = p.bf.find((c) => c.name === 'Aetherflux Reservoir');
        if (flux && p.life > 50) {
          for (const q of this.opps(p)) { if (p.life <= 50) break; p.life -= 50; const d = this.scaleDamage(p.seat, q.seat, 50); this.loseLife(q, d, flux); }
          this.emit('combo', `Aetherflux Reservoir: ${p.name} pays 50 life at a time and shoots every opponent!`, { seat: p.seat, cards: [flux.id] });
          this.checkState();
        }
        const ballista = p.bf.find((c) => c.name === 'Walking Ballista');
        if (ballista) {
          for (const q of this.opps(p)) if (q.protectedUntil < this.turn) this.loseLife(q, this.scaleDamage(p.seat, q.seat, q.life), ballista);
          this.emit('combo', `Walking Ballista: ${p.name} pumps infinite counters onto it and pings the table out!`, { seat: p.seat, cards: [ballista.id] });
          this.checkState();
        }
      }
    }

    // ----- aristocrats: sacrifice outlets + death triggers -----
    sacOutlets(p) {
      return p.bf.filter((c) => c.info.sacOutlet && !(c.info.sacOutlet.tap && c.tapped) && !this.locked(p) && (!c.info.sacOutlet.life || this.canPayLife(p, c.info.sacOutlet.life)));
    }
    drainPerDeath(p, victim) {
      let n = 0;
      for (const src of p.bf) for (const w of src.info.deathWatch) {
        if (w.scope === 'opp') continue;
        for (const f of w.fx) if (f.k === 'drain') n += num(f.n) * this.opps(p).length; else if (f.k === 'drainOne') n += num(f.n);
      }
      return n;
    }
    sacrifice(p, c, outlet) {
      const so = outlet.info.sacOutlet;
      if (so.tribes && !so.tribes.some((t) => this.isType(c, t))) return false;
      const soCost = so.cost || parseCost(String(so.mana || ''));
      if (so.mana && !this.pay(p, soCost)) return false;
      if (so.mana) this.pay(p, soCost, 0, true);
      if (so.life) this.loseLife(p, so.life);
      if (so.tap) outlet.tapped = true;
      this._sacPower = this.power(c);
      this.destroy(c, 'sacrificed', true);
      for (const f of so.fx || []) if (f.k !== 'ritual') this.resolveEffect(p, f, outlet, 0, true);
      if (so.addsMana) { const fm = outlet.info.fodderMana; const r = (so.fx || []).find((f) => f.k === 'ritual'); this.addFloating(p, (r && r.color) || (fm && fm.colors && fm.colors[0]) || 'C', (r && r.n) || (fm && fm.amount) || 2); }
      return true;
    }
    fodder(p, outlet) {
      return p.bf.filter((c) => c.info.isCreature && c !== outlet && !c.isCommander && !c.info.deathWatch.length && !c.info.sacOutlet && (c.token || this.creatureValue(c) < 7))
        .sort((a, b) => this.creatureValue(a) - this.creatureValue(b));
    }
    // Sacrifice the board when the death triggers add up to lethal
    // Cards p would draw if its creature c died now: Liliana, Dreadhorde General and other "whenever a creature you control dies, draw", Skullclamp, c's own dies-draw
    deathDraws(p, c) {
      const dn = (fx) => (fx || []).reduce((a, f) => a + (f.k === 'draw' ? this.fxNum(p, f.n, 1) : 0), 0);
      let n = dn(c.info.dies);
      for (const s2 of p.bf) {
        for (const w of s2.info.deathWatch || []) if ((w.scope === 'mine' || w.scope === 'any') && (!w.nontoken || !c.token) && (s2 !== c || w.orSelf)) n += dn(w.fx);
        if (s2.attached === c.id) n += dn(s2.info.equipDies);
      }
      return n;
    }
    // How many more cards p can draw this turn without decking (leaving one for the next draw step); unlimited with Jace or Platinum Angel out
    drawRoom(p) { return this.has(p, 'labman') || this.has(p, 'platinum') ? Infinity : p.library.length - 2; }
    aristocrats(p) {
      const outlets = this.sacOutlets(p);
      if (!outlets.length) return;
      const per = this.drainPerDeath(p);
      if (!per) return;
      const outlet = outlets.find((o) => !o.info.sacOutlet.tap && !o.info.sacOutlet.mana) || outlets[0];
      const fod = this.fodder(p, outlet);
      const loops = this.bondTriggers(p).length;
      const perOpp = (per / Math.max(1, this.opps(p).length)) * (1 + loops);
      const weakest = Math.min(...this.opps(p).map((q) => q.life));
      if (fod.length * perOpp < weakest) return;
      let n = 0, drawn = 0;
      for (const c of fod) {
        if (this.over || p.lost) break;
        const o = this.sacOutlets(p).find((x) => x !== c);
        const d = o ? this.deathDraws(p, c) + (o.info.sacOutlet.fx || []).reduce((a, f) => a + (f.k === 'draw' ? this.fxNum(p, f.n, 1) : 0), 0) : 0;
        if (d && drawn + d > this.drawRoom(p) + drawn) break; // these deaths draw cards: stop before the library runs out
        drawn += d;
        if (!o || !this.sacrifice(p, c, o)) break;
        n++;
        this.checkState();
      }
      if (n) this.emit('combo', `${p.name} sacrifices ${n} creature${n > 1 ? 's' : ''} to ${outlet.info.name}; the death triggers drain the table.`, { seat: p.seat, cards: [outlet.id] });
    }
    // In response to a wipe, cash in creatures that are about to die anyway
    // Ainok Strike Leader: sacrificed in response, the creature tokens gain indestructible (worth it when they're worth more)
    tokenShield(q) {
      const ak = q.bf.find((c) => c.info.tokenShield); if (!ak || this.abolished(q, 'ability')) return;
      const toks = q.bf.filter((x) => x.token && x.info.isCreature && x !== ak && !this.hasKw(x, 'indestructible'));
      if (toks.length < 2 || toks.reduce((n, x) => n + this.permValue(x), 0) <= this.permValue(ak)) return;
      this.emit('response', `${q.name} sacrifices ${ak.info.name}: their creature tokens gain indestructible.`, { seat: q.seat, cards: [ak.id] });
      this.destroy(ak, 'sacrificed', true); for (const x of toks) x.indestructibleEOT = true;
    }
    sacBeforeWipe(q) {
      const mon = q.bf.find((c) => c.info.mondrak && !c.indCounter);
      if (mon && this.pay(q, parseCost('1 W W'))) {
        const f = q.bf.filter((x) => x !== mon && (x.info.isCreature || x.info.types.has('Artifact')) && !x.isCommander).sort((a, b) => this.permValue(a) - this.permValue(b)).slice(0, 2);
        if (f.length === 2) { this.pay(q, parseCost('1 W W'), 0, true); for (const x of f) this.destroy(x, 'sacrificed', true); mon.indCounter = true; this.emit('response', `${q.name} gives Mondrak an indestructible counter.`, { seat: q.seat, cards: [mon.id] }); }
      }
      const o = this.sacOutlets(q)[0];
      if (!o) return;
      const value = this.drainPerDeath(q) > 0 || (o.info.sacOutlet.fx || []).some((f) => f.k === 'draw' || f.k === 'tutor');
      if (!value) return;
      let n = 0;
      for (const c of q.bf.filter((x) => x.info.isCreature && x !== o && !this.hasKw(x, 'indestructible') && !x.isCommander)) {
        const out = this.sacOutlets(q).find((x) => x !== c);
        if (this.deathDraws(q, c) + (out ? (out.info.sacOutlet.fx || []).filter((f) => f.k === 'draw').length : 0) > this.drawRoom(q)) break;
        if (!out || !this.sacrifice(q, c, out)) break;
        n++;
      }
      if (n) this.emit('response', `${q.name} sacrifices ${n} creatures to ${o.info.name} in response.`, { seat: q.seat, cards: [o.id] });
    }

    // Creature-enters triggers (Terror of the Peaks, Dragon Tempest, ...); called for cards and tokens alike
    // a creature a "put it onto the battlefield attacking" trigger can bring: of its types (Kaalia), or with mana value up to
    // the number of attackers (Kinscaer Sentry)
    cheatFits(c, f, attacking) { return c.info.isCreature && (!f.subs || f.subs.some((s2) => (c.info.subtypes || []).includes(s2))) && (!f.mvAttackers || (c.info.mv || 0) <= attacking); }
    creatureEntered(p, c) {
      // evolve: a creature entering with greater power or toughness grows each evolver by a +1/+1 counter
      if (c.info.isCreature) for (const e of p.bf) if (e !== c && e.info.evolve && (this.power(c) > this.power(e) || this.toughness(c) > this.toughness(e))) e.p1 += this.counterAmount(p, 1);
      const prevEntering = this._entering; this._entering = c;
      for (const src of [...p.bf]) for (const fx of (src.info.myCreatureEtb || [])) if (src !== c) this.resolveEffects(p, fx, src, null, true);
      this._entering = prevEntering;
      for (const src of p.bf) if (src.info.losheelDraw && c.info.types.has('Artifact') && src.lhTurn !== this.turn) { src.lhTurn = this.turn; this.draw(p, 1); this.emit('draw', `Losheel: ${p.name} draws a card.`, { seat: p.seat, cards: [src.id] }); }
      for (const q of this.alive()) for (const src of q.bf) if (src.info.anyCreatureEtb && src !== c) this.resolveEffects(q, src.info.anyCreatureEtb, src, null, true);
      for (const src of p.bf) if (src.info.welcoming && src !== c && this.power(c) <= 2 && src.welcomeTurn !== this.turn) { src.welcomeTurn = this.turn; this.draw(p, 1); this.emit('draw', `Welcoming Vampire: ${c.info.name} entered, ${p.name} draws a card.`, { seat: p.seat, cards: [src.id, c.id] }); }
      this.untappedEntry(p, c);
      for (const q of this.opps(p)) for (const src of [...q.bf]) for (const fx of (src.info.oppCreatureEtb || [])) this.resolveEffects(q, fx, src, null, true);
      for (const src of [...p.bf]) for (const t of src.info.triggers) {
        if (this.over || p.lost) return;
        if (t.k === 'terror' && src !== c && src.zone === 'bf') { const n = this.power(c); if (n > 0) this.dealDamageAny(p, n, src, c.info.name + ' entered'); }
        if (t.k === 'dragonTempest' && (c.info.subtypes || []).includes('Dragon')) { const n = p.bf.filter((x) => (x.info.subtypes || []).includes('Dragon')).length; this.dealDamageAny(p, n, c, 'Dragon Tempest'); }
        if (t.k === 'flyHaste' && this.hasKw(c, 'flying')) c.eot.kw.push('haste');
      }
    }

    // Archivist of Oghma
    searched(p) {
      for (const q of this.opps(p)) for (const c of q.bf) for (const t of c.info.triggers) if (t.k === 'archivist') { this.gainLife(q, 1); this.draw(q, 1); this.emit('draw', `Archivist of Oghma: ${q.name} gains 1 and draws.`, { seat: q.seat, cards: [c.id] }); }
    }
    phaseOut(c, why) {
      const ctrl = this.P(c.ctrl);
      this.removeFrom(ctrl.bf, c); c.zone = 'phased';
      ctrl.phased = ctrl.phased || []; ctrl.phased.push(c);
      for (const a of ctrl.bf.filter((x) => x.attached === c.id)) { this.removeFrom(ctrl.bf, a); a.zone = 'phased'; ctrl.phased.push(a); }
      if (why) this.emit('effect', `${why}.`, { seat: c.ctrl, cards: [c.id] });
    }
    gyThreat(q) { return q.gy.reduce((s2, c) => s2 + (c.info.isCreature ? this.creatureValue({ ...c, p1: 0, eot: { p: 0, t: 0, kw: [] }, ctrl: q.seat, info: c.info }) : 1), 0) + (q.bf.some((c) => c.info.statics.some((x) => x.k === 'muldrotha')) ? 15 : 0); }
    freeCast(p, c, label) {
      c.ctrl = p.seat;
      if (label) this.emit('cast', `${label}.`, { seat: p.seat, cards: [c.id] });
      if (c.info.isPermanent) { this.enterBattlefield(c, p); }
      else { c.zone = 'stack'; this.resolveEffects(p, c.info.spell, c, null, false); if (c.zone === 'stack') this.toGraveyard(c, p.seat); }
      this.checkState();
    }
    weakestOpp(p) { const o = this.opps(p); const open = o.filter((q) => !(q.protectedUntil >= this.turn)); return (open.length ? open : o).sort((a, b) => a.life - b.life)[0]; }

    // ----- mana -----
    sources(p) {
      const out = [];
      if (this.locked(p)) return out;
      for (const c of p.bf) {
        const m = c.info.mana;
        if (!m || c.tapped) continue;
        if (this.karnStops(p, c)) continue;
        if (c.info.name === 'Temple of the False God' && p.bf.filter((x) => x.info.isLand).length < 5) continue;
        if (c.info.isCreature && c.sick && !this.hasKw(c, 'haste') && !this.has(p, 'elixir')) continue;
        let opts = m.opts;
        if (c.info.cradle) { const n = p.bf.filter((x) => x.info.isCreature).length; if (!n) continue; opts = [{ colors: ['G'], amount: n, dmg: 0 }]; }
        if (c.info.isLand) {
          const extra = [];
          for (const q of this.alive()) for (const x of q.bf) if (x.info.addsLandType) extra.push(BASIC_TYPES[x.info.addsLandType]);
          if (p.bf.some((x) => x.info.allBasicTypes || x.info.lantern)) extra.push(...COLORS);
          if (extra.length) opts = opts.map((o) => ({ ...o, colors: [...new Set(o.colors.filter((x) => x !== 'C' || o.colors.length === 1).concat(extra))] }));
        }
        if (c.info.name === "Serra's Sanctum") opts = [{ colors: ['W'], amount: Math.max(1, p.bf.filter((x) => x.info.types.has('Enchantment')).length), dmg: 0 }];
        if (c.info.name === 'Sanctum Weaver') { const n = p.bf.filter((x) => x.info.types.has('Enchantment')).length; if (!n) continue; opts = [{ colors: COLORS.slice(), amount: n, dmg: 0 }]; }
        if (c.info.name === 'Chrome Mox') { const cols = c.imprinted ? [...c.imprinted.info.colors] : []; if (!cols.length) continue; opts = [{ colors: cols, amount: 1, dmg: 0 }]; }
        if (c.info.coffers) { const n = p.bf.filter((x) => x.info.isLand && this.landTypes(p, x).includes('Swamp')).length; opts = [{ colors: ['B'], amount: Math.max(1, n - 2), dmg: 0 }]; }
        if (m.charge) { if (!c.charge) continue; opts = opts.map((o) => ({ ...o, amount: c.charge })); }
        if (m.bloom) { const cols = new Set(p.bf.flatMap((x) => [...(x.info.colors || [])])); if (!cols.size) continue; opts = [{ colors: [...cols], amount: cols.size, dmg: 0 }]; }
        if (opts.some((o) => o.filter) && !p.bf.some((x) => x !== c && !x.tapped && x.info.mana && x.info.mana.opts.some((o) => o.colors.includes('R') || o.colors.includes('W')))) opts = opts.filter((o) => !o.filter);
        if (c.info.metalcraft && p.bf.filter((x) => x.info.types.has('Artifact')).length < 3) continue;
        if (c.info.druid && this.toughness(c) <= 1) opts = opts.map((o) => ({ ...o, amount: 1 }));
        if (c.token && c.info.name === 'Treasure' && this.has(p, 'goldspan')) opts = [{ colors: COLORS.slice(), amount: 2, dmg: 0 }];
        // mana doublers / multipliers
        const mult = 3 ** this.statics(p, 'manaMult').length;
        const landPlus = c.info.isLand ? this.statics(p, 'landManaPlus').length : 0;
        const monument = p.bf.filter((x) => x.info.monument).length;
        if (mult > 1 || landPlus || monument) opts = opts.map((o) => ({ ...o, amount: o.amount * mult + landPlus * mult + (o.colors.length === 1 && o.colors[0] === 'C' ? monument * mult : 0) }));
        out.push({ c, opts, oneShot: m.oneShot });
      }
      // Krark-Clan Ironworks / Master of Dark Rites: sacrifice fodder for mana
      for (const c of p.bf) {
        const fm = c.info.fodderMana;
        if (!fm || (fm.tap && (c.tapped || (c.sick && c.info.isCreature && !this.has(p, 'elixir'))))) continue;
        const fod = p.bf.filter((x) => x !== c && x.info.types.has(fm.what) && !x.isCommander && !this.livePiece(p, x) && ((x.token && !x.info.mv) || this.permValue(x) < 3) && !x.info.isLand);
        for (const f of fm.tap ? fod.slice(0, 1) : fod) out.push({ c, opts: [{ colors: fm.colors, amount: fm.amount, dmg: 0 }], oneShot: false, fodder: f, tapSrc: fm.tap });
      }
      // Crystalline Crawler: remove +1/+1 counters for mana
      for (const c of p.bf) if (c.info.counterMana && c.p1 > 0) out.push({ c, opts: [{ colors: COLORS.slice(), amount: c.p1, dmg: 0 }], oneShot: false, counters: true });
      return out;
    }
    availableMana(p) {
      return this.sources(p).reduce((s, x) => s + Math.max(...x.opts.map((o) => o.amount)), 0) + (p.pool || 0) + Object.values(p.floating || {}).reduce((a, b) => a + b, 0);
    }

    // Attempt to pay; returns plan or null. If commit, taps sources.
    pay(p, cost, xVal = 0, commit = false, extraGeneric = 0) {
      this.tick(); // see run(): a game stuck in a loop is called a draw
      const srcs = this.sources(p).map((s) => ({ ...s, used: false }));
      const pool = { ...(p.floating || {}) }; // mana already floating, plus extra from multi-amount sources
      if (p.pool) pool.ANY = (pool.ANY || 0) + p.pool;
      const spent = []; // what actually paid for this, for the display
      const take = (color) => {
        if (pool[color] > 0) { pool[color]--; spent.push(color); return true; }
        if (pool.ANY > 0) { pool.ANY--; spent.push(color); return true; }
        return false;
      };
      let lifePaid = 0;
      const used = [];
      const dmgSoFar = (u) => u.reduce((a, x) => a + (x.o.dmg || 0), 0);
      const anyColor = this.alive().some((q) => this.has(q, 'anyColorMana'));
      const pips = cost.pips.slice().sort((a, b) => a.opts.length - b.opts.length).map((pp) => (anyColor && pp.opts.length && pp.opts[0] !== 'C' ? { ...pp, opts: COLORS.slice() } : pp));
      const infCols = p.infMana === this.turn ? (p.infColors || []) : [];
      for (const pip of pips) {
        let ok = false;
        for (const col of pip.opts) if (take(col)) { ok = true; break; }
        if (ok) continue;
        const free = pip.opts.find((col) => infCols.includes(col));
        if (free) { spent.push(free); continue; }
        // find source
        let best = null, bestScore = 1e9, bestOpt = null, bestCol = null;
        for (const s of srcs) {
          if (s.used) continue;
          for (const o of s.opts) for (const col of pip.opts) {
            if (!o.colors.includes(col) && !(anyColor && col !== 'C')) continue;
            if (o.dmg && !this.canPayLife(p, o.dmg + lifePaid + dmgSoFar(used))) continue;
            const score = o.colors.length * 3 + (o.amount > 1 ? 4 : 0) + (s.oneShot ? 8 : 0) + o.dmg * 2;
            if (score < bestScore) { best = s; bestScore = score; bestOpt = o; bestCol = col; }
          }
        }
        if (best) {
          best.used = true; used.push({ s: best, o: bestOpt });
          spent.push(bestCol);
          if (bestOpt.amount > 1) pool[bestCol] = (pool[bestCol] || 0) + bestOpt.amount - 1;
          continue;
        }
        if (pip.phy && this.canPayLife(p, lifePaid + 2)) { lifePaid += 2; spent.push('L'); continue; }
        if (pip.two) { extraGeneric += 2; continue; }
        return null;
      }
      let generic = cost.generic + xVal * (cost.x || 0) + extraGeneric;
      if (p.infMana === this.turn) generic = 0;
      const poolTotal = () => Object.values(pool).reduce((a, b) => a + b, 0);
      while (generic > 0) {
        if (poolTotal() > 0) { const k = ['C', 'ANY', ...COLORS].find((x) => pool[x] > 0) || Object.keys(pool).find((x) => pool[x] > 0); pool[k]--; generic--; spent.push(k === 'ANY' ? 'C' : k); continue; }
        let best = null, bestScore = 1e9, bestOpt = null;
        for (const s of srcs) {
          if (s.used) continue;
          for (const o of s.opts) {
            if (o.dmg && !this.canPayLife(p, o.dmg + lifePaid + dmgSoFar(used))) continue;
            const waste = Math.max(0, o.amount - generic);
            const score = (o.colors.includes('C') && o.colors.length === 1 ? 0 : o.colors.length * 2) + waste * 3 + (s.oneShot ? 10 : 0) + o.dmg * 2 - (o.amount > 1 ? 1 : 0);
            if (score < bestScore) { best = s; bestScore = score; bestOpt = o; }
          }
        }
        if (!best) return null;
        best.used = true; used.push({ s: best, o: bestOpt });
        const take2 = Math.min(bestOpt.amount, generic); generic -= take2;
        const g = bestOpt.colors.length === 1 ? bestOpt.colors[0] : bestOpt.colors.includes('C') ? 'C' : bestOpt.colors.find((x) => p.colors.includes(x)) || bestOpt.colors[0];
        for (let i = 0; i < take2; i++) spent.push(g);
        if (bestOpt.amount > take2) pool[g] = (pool[g] || 0) + bestOpt.amount - take2;
      }
      if (commit) {
        p.pool = 0;
        // leftover mana floats until the step ends
        p.floating = {};
        for (const [k, v] of Object.entries(pool)) if (v > 0) p.floating[k] = v;
        this.pendingMana = spent.length || Object.keys(p.floating).length ? { seat: p.seat, spent, sources: used.map(({ s }) => s.c.id) } : null;
        for (const { s, o } of used) {
          this.credit(s.c, 'mana', o.amount);
          if (s.counters) { s.c.p1 = 0; continue; }
          if (s.fodder) { if (s.fodder.zone === 'bf') this.destroy(s.fodder, 'sacrificed', true); if (s.tapSrc) s.c.tapped = true; continue; }
          s.c.tapped = true;
          if (s.c.info.druid && o.amount >= 2) { s.c.p1 -= 1; this.checkState(); }
          if (o.dmg) this.loseLife(p, o.dmg);
          if (o.gain) this.gainLife(p, o.gain);
          if (s.oneShot) { if (s.c.token) this.leaveBattlefield(s.c); else this.moveToGraveyard(s.c); }
        }
        if (lifePaid) this.loseLife(p, lifePaid);
      }
      return { used: used.length };
    }

    // Genesis Wave with lots of mana: not so big that the constellation / Great Henge draws it sets off empty the library
    genesisX(p, x) {
      const drawsOn = (c, k) => (c.info[k] || []).some((fx) => fx.some((f) => f.k === 'draw'));
      for (; x > 3; x--) {
        const top = p.library.slice(0, x).filter((c) => c.info.isPermanent && !c.info.isInstant && c.info.mv <= x);
        const all = p.bf.concat(top);
        const draws = top.filter((c) => c.info.types.has('Enchantment')).length * all.filter((c) => drawsOn(c, 'constellation')).length + top.filter((c) => c.info.isCreature).length * all.filter((c) => drawsOn(c, 'myCreatureEtb')).length;
        if (p.library.length - x > draws + 2) break;
      }
      return x;
    }
    maxX(p, cost) {
      if (p.infMana === this.turn) return this.pay(p, cost, 0) ? 99 : -1;
      let lo = 0, hi = 30;
      if (!this.pay(p, cost, 0)) return -1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.pay(p, cost, mid)) lo = mid; else hi = mid - 1; }
      return lo;
    }

    commanderCost(p, c) { const cost = { ...c.info.cost, generic: c.info.cost.generic + p.tax * 2 }; return cost; }

    // ----- battlefield entry -----
    enterBattlefield(c, p, o = {}) {
      if (c.zone === 'bf' && this.players.some((q) => q.bf.includes(c))) return; // already there: a card can't enter twice
      this._nnTick = (this._nnTick || 0) + 1;
      this.tick(); // permanents entering count toward the runaway limit too (a token loop hung training)
      // a card is only ever in one place: take it out of whatever zone still holds it
      for (const q of this.players) for (const z of ['hand', 'gy', 'exile', 'library', 'command']) if (q[z].includes(c)) this.removeFrom(q[z], c);
      c.zone = 'bf'; c.ctrl = p.seat; c.sick = true; c.tapped = !!o.tapped; c.dmg = 0;
      // copy effects choose what to copy as they enter
      if (c.info.copy && !c.copiedFrom) this.copyOnEnter(c, p);
      if (c.info.isPW) c.loyalty = this.counterAmount(p, (c.info.loyalty || 3) + (c.copyPlusOne ? 1 : 0), 'loyalty');
      if (c.info.etbCounters) c.p1 = this.counterAmount(p, c.info.etbCounters === 'X' ? (o.xVal || 0) : c.info.etbCounters);
      if (c.copyPlusOne && c.info.isCreature) c.p1 += this.counterAmount(p, 1);
      if (o.p1) c.p1 = (c.p1 || 0) + o.p1;
      if (c.info.etbMinus) c.p1 = (c.p1 || 0) - c.info.etbMinus;
      if (c.info.ravenous && (o.xVal || 0) >= 5) { this.draw(p, 1); this.emit('draw', `${c.info.name} is ravenous: ${p.name} draws a card.`, { seat: p.seat, cards: [c.id] }); } // enters with -1/-1 counters (Flitterwing Nuisance, Moonshadow)
      // charge counters it enters with count as counters being put on it (Doubling Season doubles them)
      if (c.info.chargeX) c.charge = o.xVal ? this.counterAmount(p, o.xVal, 'charge') : 0;
      if (c.info.multikicker) c.charge = o.kicks ? this.counterAmount(p, o.kicks, 'charge') : 0;
      if (c.info.converge) c.p1 = this.counterAmount(p, Math.min(o.colorsSpent || p.colors.length, 5));
      if (c.info.prepared) c.prepared = true;
      if (c.info.banner || c.info.cavern) c.chosenType = this.favouriteType(p);
      if (c.info.sower) c.sowerPair = this.opps(p).sort((a, b) => b.life - a.life).slice(0, 2).map((q) => q.seat);
      if (c.info.isCreature && this.opps(p).some((q) => this.has(q, 'oppEnterTapped'))) c.tapped = true;
      p.bf.push(c);
      this.refreshAnimations(); // Opalescence makes an enchantment a creature as it enters; devotion may wake a god
      if (o.announce) o.announce(c); // logged once it is on the battlefield, before its own enters triggers
      if (c.info.isLand) {
        if (c.info.etbTapped) c.tapped = true;
        const ec = c.info.etbCond;
        if (ec) {
          const others = p.bf.filter((x) => x !== c && x.info.isLand);
          let untapped = true;
          if (ec.k === 'types') untapped = others.some((x) => ec.types.some((t) => this.landTypes(p, x).includes(t)));
          else if (ec.k === 'fast') untapped = others.length <= 2;
          else if (ec.k === 'slow') untapped = others.length >= 2;
          else if (ec.k === 'basics') untapped = others.filter((x) => x.info.types.has('Basic')).length >= 2;
          else if (ec.k === 'legend') untapped = p.bf.some((x) => x.info.isCreature && x.info.isLegendary);
          else if (ec.k === 'opps') untapped = this.opps(p).length >= 2;
          if (!untapped) c.tapped = true;
        }
        if (/enters, sacrifice a land/i.test(c.info.text)) { const l = p.bf.filter((x) => x.info.isLand && x !== c).sort((a, b) => this.landKeep(p, a) - this.landKeep(p, b))[0]; if (l) this.destroy(l, 'sacrificed', true); }
        // landfall
        for (const src of [...p.bf]) for (const fx of (src.info.landfall || [])) this.resolveEffects(p, fx, src, null, true);
        // Archaeomancer's Map: an opponent pulls ahead on lands
        for (const q of this.opps(p)) if (q.bf.some((x) => x.info.triggers.some((t) => t.k === 'mapCatchUp')) && p.bf.filter((x) => x.info.isLand).length > q.bf.filter((x) => x.info.isLand).length) {
          const l = q.hand.filter((x) => x.info.isLand).sort((a, b) => this.landValue(q, b) - this.landValue(q, a))[0];
          if (l) { this.removeFrom(q.hand, l); this.enterBattlefield(l, q, { quiet: true }); this.emit('land', `Archaeomancer's Map: ${q.name} puts ${l.info.name} onto the battlefield.`, { seat: q.seat, cards: [l.id] }); }
        }
        for (const g of [...p.gy]) if (g.info.gyLandfall) { this.removeFrom(p.gy, g); this.enterBattlefield(g, p, { quiet: true }); this.emit('reanimate', `${g.info.name} returns from the graveyard (landfall).`, { seat: p.seat, cards: [g.id] }); }
        if (c.info.shock) { const n = /pay 3 life/i.test(c.info.text || '') ? 3 : 2; if (this.canPayLife(p, n) && this.wantUntappedLand(p, c)) this.loseLife(p, n); else c.tapped = true; }
        if (c.info.fetch) {
          const ok = (land) => land.info.isLand && c.info.fetch.types.some((tp) => tp === 'basic land' ? land.info.types.has('Basic') : tp === 'land' ? true : land.info.subtypes.includes(cap(tp)) || (tp.includes('basic') && land.info.types.has('Basic')));
          const want = p.library.filter(ok);
          const fetchLife = /pay 1 life/i.test(c.info.text) ? 1 : 0;
          if (want.length && this.canPayLife(p, fetchLife)) {
            const pick = want.sort((a, b) => this.landValue(p, b) - this.landValue(p, a))[0];
            this.removeFrom(p.library, pick); this.R.shuffle(p.library); this.searched(p); // a search (Archivist of Oghma sees it)
            this.moveToGraveyard(c);
            if (/pay 1 life/i.test(c.info.text)) this.loseLife(p, 1);
            this.enterBattlefield(pick, p, { tapped: c.info.fetch.tapped && !(/four or more lands/i.test(c.info.text || '') && p.bf.filter((x) => x.info.isLand).length + 1 >= 4), quiet: true });
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
      if (c.info.isCreature) this.creatureEntered(p, c);
      else if (c.info.types.has('Artifact')) this.untappedEntry(p, c);
      this.artifactEntered(p, c);
      if (c.info.saga) c.lore = 1;
      if (c.info.types.has('Enchantment')) for (const src of [...p.bf]) for (const fx of (src.info.constellation || [])) this.resolveEffects(p, fx, src, `${src.info.name} (constellation)`, true);
      if (!o.noEtb && c.info.etb.length) this.resolveEffects(p, c.info.etb, c, o.quiet ? null : `${c.info.name} enters`, false, o.xVal || 0);
      if (c.info.imprint) {
        const exiled = p.hand.filter((x) => !x.info.isLand && !x.info.types.has('Artifact') && x.info.colors.size).sort((a, b) => this.cardValue(p, a) - this.cardValue(p, b))[0];
        if (exiled) { this.removeFrom(p.hand, exiled); exiled.zone = 'exile'; p.exile.push(exiled); c.imprinted = exiled; this.emit('effect', `${c.info.name} imprints ${exiled.info.name}.`, { seat: p.seat, cards: [c.id] }); }
      }
    }

    // Quicksmith Genius: whenever an artifact you control enters, you may discard a card (a spare land or a weak card) to draw one
    artifactEntered(p, c) { if (c.info.types.has('Artifact')) for (const src of p.bf) if (src.info.artifactEtb && src !== c && p.hand.length) { const worst = p.hand.slice().sort((a, b) => this.cardValue(p, a) - this.cardValue(p, b))[0]; if (worst && (worst.info.isLand ? p.bf.filter((x) => x.info.isLand).length >= 5 : this.cardValue(p, worst) < 3)) { this.discardCard(p, worst); this.draw(p, 1); } } }
    autoAttach(p, eq) {
      const crs = p.bf.filter((x) => x.info.isCreature);
      if (eq.info.isAura) {
        if (eq.info.statics.some((s) => s.k === 'pacify')) {
          const t = this.bestOppTarget(p, (x) => x.info.isCreature && this.targetable(x, p));
          if (t) { eq.attached = t.id; this.emit('effect', `${eq.info.name} locks down ${t.info.name}.`, { seat: p.seat, cards: [t.id, eq.id] }); }
          return;
        }
        if (eq.info.reanimAura) return;
        // "when enchanted creature dies" auras go on the creature we are happiest to lose; others on the best one
        const best = crs.sort((a, b) => (eq.info.enchDies ? 1 : -1) * (this.creatureValue(a) - this.creatureValue(b)))[0];
        if (best) { eq.attached = best.id; this.emit('effect', `${eq.info.name} enchants ${this.cname(best)}.`, { seat: p.seat, cards: [eq.id, best.id] }); }
        else { this.emit('effect', `${eq.info.name} has nothing to enchant and goes to the graveyard.`, { seat: p.seat, cards: [eq.id] }); this.moveToGraveyard(eq); }
        return;
      }
    }

    // ----- effects -----
    // Short description of an effect for the play-by-play
    describeFx(f) {
      const n = typeof f.n === 'number' ? f.n : f.n === 'X' ? 'X' : f.n === 'TRIBE' ? 'one per ' + f.tribe : f.n;
      const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
      switch (f.k) {
        case 'draw': return `draw ${typeof n === 'number' ? pl(n, 'card') : n + ' cards'}`;
        case 'gain': return `gain ${n} life`;
        case 'loseSelf': return `lose ${n} life`;
        case 'drain': return `each opponent loses ${n} life${f.gain ? ' (and you gain it)' : ''}`;
        case 'drainOne': return `an opponent loses ${n} life`;
        case 'tokens': return `create ${n === 1 ? 'a' : n} ${f.p}/${f.t} ${f.sub}${n === 1 ? '' : 's'}`;
        case 'treasure': return `create ${n === 1 ? 'a Treasure' : n + ' Treasures'}`;
        case 'counters': return `+1/+1 counter${f.on === 'each' ? 's on each ' + (f.sub || 'creature') : ''}`;
        case 'proliferate': return 'proliferate';
        case 'mill': return `mill ${n}`;
        case 'scry': return `scry ${n}`;
        case 'damage': return `${n} damage`;
        case 'search': case 'tutor': case 'tutorBF': return `search for a${/^[aeiou]/i.test(f.what || 'card') ? 'n' : ''} ${f.what || 'card'}`;
        case 'ramp': return 'search for land';
        case 'reanimate': case 'reanimateType': return 'return a card from a graveyard to the battlefield';
        case 'regrow': return 'return a card to hand';
        case 'edict': case 'edictThat': return 'sacrifice a creature';
        case 'edictAll': return 'each player sacrifices';
        case 'discard': return 'discard';
        case 'removal': return f.bounce ? 'bounce a permanent' : f.exile ? 'exile a permanent' : 'destroy a permanent';
        case 'wipe': return 'board wipe';
        case 'pump': case 'overrun': return 'pump';
        case 'untapLands': return 'untap lands';
        case 'food': case 'clue': case 'blood': return `create a ${cap(f.k)}`;
        default: return null;
      }
    }
    // Can this ramp effect find anything? (the same filter the ramp effect uses: with no basics left, Kodama's Reach does
    // nothing; with Tamiyo's emblem returning it to hand it was cast again and again, minutes per turn)
    rampFinds(p, f) {
      if (f.fromHand) return p.hand.some((c) => c.info.isLand);
      if (f.ifBehind && !this.opps(p).some((q) => q.bf.filter((c) => c.info.isLand).length > p.bf.filter((c) => c.info.isLand).length)) return false;
      const typeOk = (c) => !f.landTypes || f.landTypes.some((t) => (c.info.subtypes || []).includes(t));
      if (f.landTypes) return p.library.some((c) => c.info.isLand && typeOk(c) && (!f.basicOnly || c.info.types.has('Basic')));
      if (f.basicOnly) return p.library.some((c) => c.info.isLand && c.info.types.has('Basic'));
      return p.library.some((c) => c.info.isLand && (f.anyLand ? !c.info.fetch : c.info.types.has('Basic') || !c.info.fetch));
    }
    // Would this effect actually do something right now? (conditions checked before announcing it)
    fxApplies(p, f) {
      if (f.sevenNames && new Set(p.bf.filter((c) => c.info.isLand).map((c) => c.name)).size < 7) return false;
      if (f.ifColor && !(this._entering && this._entering.info.colors && this._entering.info.colors.has(f.ifColor))) return false;
      if (f.nontoken && this._entering && this._entering.token) return false;
      if (f.unlessHave && p.bf.some((c) => this.isType(c, f.unlessHave))) return false;
      if (f.ifArtifacts && p.bf.filter((c) => c.info.types.has('Artifact')).length < f.ifArtifacts) return false;
      if (f.ifBehind && !this.opps(p).some((q) => q.bf.filter((c) => c.info.isLand).length > p.bf.filter((c) => c.info.isLand).length)) return false;
      return true;
    }
    resolveEffects(p, fxList, src, label, quiet = false, xVal = 0, target = null) {
      // a runaway chain of triggers (an unintended loop) stops here instead of freezing the game
      if ((this._depth || 0) > 150) { if (!this._loopWarned) { this._loopWarned = true; this.emit('effect', `The game stops an endless chain of triggers here.`, { seat: p.seat }); } return; }
      this._depth = (this._depth || 0) + 1;
      try { return this._resolveEffectsInner(p, fxList, src, label, quiet, xVal, target); } finally { this._depth--; }
    }
    _resolveEffectsInner(p, fxList, src, label, quiet = false, xVal = 0, target = null) {
      // Every trigger gets its own line in the play-by-play, in the order it resolves
      const live = fxList.filter((f) => this.fxApplies(p, f));
      if (live.length && src && (quiet || label)) {
        const what = live.map((f) => this.describeFx(f)).filter(Boolean).join(', ');
        const who = label ? label.replace(/ triggers$/, '') : src.info.name;
        if (quiet || !label) this.emit('trigger', `${who} triggers${what ? ': ' + what : ''}.`, { seat: p.seat, cards: [src.id] });
        else this.emit('trigger', `${label}.`, { seat: p.seat, cards: [src.id] });
      } else if (label && live.length) this.emit('trigger', `${label}.`, { seat: p.seat, cards: src ? [src.id] : [] });
      // quiet effects don't log themselves, so say what they did: life, cards and boards that changed
      const before = quiet && live.length && this.record ? this.players.map((q) => ({ life: q.life, hand: q.hand.length, bf: q.bf.length })) : null;
      const evCount = this.events.length;
      for (const fx of fxList) { if (p.lost || this.over) break; this.resolveEffect(p, fx, src, xVal, quiet); }
      if (before) {
        const bits = [];
        this.players.forEach((q, i) => {
          const b = before[i]; const d = q.life - b.life;
          if (d) bits.push(`${q.name} ${d > 0 ? 'gains' : 'loses'} ${Math.abs(d)} (${q.life})`);
          if (q.hand.length > b.hand) bits.push(`${q.name} draws ${q.hand.length - b.hand}`);
        });
        // only when the effects didn't already log what they did
        if (bits.length && this.events.length === evCount + 0) this.emit('effect', `→ ${bits.join(', ')}.`, { seat: p.seat, cards: src ? [src.id] : [] });
      }
    }

    tokenMult(p) { return 2 ** (this.statics(p, 'tokenDouble').length + this.alive().reduce((s2, q) => s2 + this.statics(q, 'globalDouble').length, 0)); }

    addToken(p, spec, n, quiet) {
      n = n * this.tokenMult(p);
      const made = [];
      const cap = Math.max(0, 80 - p.bf.filter((c) => c.token).length);
      for (let i = 0; i < Math.min(n, cap); i++) {
        const t = this.makeToken(p, spec); t.ctrl = p.seat; p.bf.push(t); made.push(t.id);
        const sc = this.ctxSrc(); if (sc) t.creditTo = this.creditTarget(sc).id;
      }
      if (made.length) this.credit(this.ctxSrc(), 'tokens', made.length);
      if (this.has(p, 'chatterfang') && !spec.squirrel) for (let i = 0; i < Math.min(n, cap - made.length); i++) { const t = this.makeToken(p, { p: 1, t: 1, sub: 'Squirrel', colors: 'green', squirrel: true }); p.bf.push(t); made.push(t.id); }
      if (!spec.treasure && !spec.artifactToken) for (const id of made) this.creatureEntered(p, this.cards[id]);
      for (const id of made) this.artifactEntered(p, this.cards[id]);
      if (!quiet || made.length > 1) this.emit('token', `${p.name} creates ${n} ${spec.treasure ? 'Treasure' : spec.artifactToken ? spec.artifactToken : spec.p + '/' + spec.t + ' ' + spec.sub} token${n > 1 ? 's' : ''}.`, { seat: p.seat, cards: made });
      return made;
    }

    resolveEffect(p, fx, src, xVal = 0, quiet = false) {
      if (src) this._ctx.push(src);
      try { return this._resolveEffect(p, fx, src, xVal, quiet); } finally { if (src) this._ctx.pop(); }
    }
    _resolveEffect(p, fx, src, xVal = 0, quiet = false) {
      const name = src ? src.info.name : '';
      if (fx.sevenNames && new Set(p.bf.filter((c) => c.info.isLand).map((c) => c.name)).size < 7) return;
      if (fx.ifColor && !(this._entering && this._entering.info.colors && this._entering.info.colors.has(fx.ifColor))) return;
      if (fx.nontoken && this._entering && this._entering.token) return;
      const X = (v) => (v === 'X' ? Math.max(0, xVal) : v === 'X2' ? 2 * Math.max(0, xVal) : v === 'TRIBE' ? p.bf.filter((c) => c.info.isCreature && this.isType(c, fx.tribe)).length : v === 'D20' ? 1 + this.R.int(20) : v === 'SPELLS' ? (p.spellsThisTurn || 1) : v === 'POWER' ? (src && src.zone === 'bf' ? Math.max(0, this.power(src)) : 0) : v);
      if (fx.unlessHave && p.bf.some((c) => this.isType(c, fx.unlessHave))) return;
      if (fx.ifArtifacts && p.bf.filter((c) => c.info.types.has('Artifact')).length < fx.ifArtifacts) return;
      switch (fx.k) {
        case 'draw': if (fx.delayed) { (this.delayedDraws = this.delayedDraws || []).push(p.seat); break; } if (fx.n) this.draw(p, X(fx.n) || 0); if (fx.n && (!quiet || src)) this.emit('draw', `${p.name} draws ${X(fx.n)} off ${name}.`, { seat: p.seat, cards: src ? [src.id] : [] }); break;
        case 'wheel': {
          for (const q of this.alive()) { q.gy.push(...q.hand.map((c) => ((c.zone = 'gy'), c))); q.hand = []; this.draw(q, 7); }
          this.emit('effect', `Everyone discards their hand and draws seven.`, { seat: p.seat });
          break;
        }
        case 'ramp': {
          if (fx.ifBehind && !this.opps(p).some((q) => q.bf.filter((c) => c.info.isLand).length > p.bf.filter((c) => c.info.isLand).length)) break;
          this.searched(p);
          const typeOk = (c) => !fx.landTypes || fx.landTypes.some((t) => (c.info.subtypes || []).includes(t));
          let lands;
          if (fx.landTypes) lands = p.library.filter((c) => c.info.isLand && typeOk(c) && (!fx.basicOnly || c.info.types.has('Basic')));
          else if (fx.basicOnly || !fx.anyLand) { lands = p.library.filter((c) => c.info.isLand && c.info.types.has('Basic')); if (!lands.length && !fx.basicOnly) lands = p.library.filter((c) => c.info.isLand && !c.info.fetch); }
          else lands = p.library.filter((c) => c.info.isLand && !c.info.fetch);
          if (fx.sameType && lands.length) { const by = {}; for (const c of lands) for (const t of c.info.subtypes || []) (by[t] = by[t] || []).push(c); const best = Object.values(by).sort((a, b) => b.length - a.length)[0] || []; lands = best; }
          let got = 0; const toBf = [], toHand = [];
          if (fx.fromHand) {
            const l = p.hand.find((c) => c.info.isLand); if (l) { this.removeFrom(p.hand, l); this.enterBattlefield(l, p, { quiet: true }); got++; toBf.push(l); }
          } else {
            // two picks are chosen together (the first goes to the battlefield, any second to where the spell says)
            const pair = fx.bf + fx.hand === 2 ? this.bestLandPair(p, lands) : null;
            for (let i = 0; i < fx.bf && lands.length; i++) { const l = pair && pair[i] ? pair[i] : this.bestLandFrom(p, lands); this.removeFrom(lands, l); this.removeFrom(p.library, l); this.enterBattlefield(l, p, { tapped: fx.tapped, quiet: true }); got++; toBf.push(l); }
            if (pair && fx.hand && pair[fx.bf] && lands.includes(pair[fx.bf])) { const l = pair[fx.bf]; this.removeFrom(lands, l); this.removeFrom(p.library, l); l.zone = 'hand'; p.hand.push(l); toHand.push(l); }
            for (let i = toHand.length; i < fx.hand && lands.length; i++) { const l = this.bestLandFrom(p, lands); this.removeFrom(lands, l); this.removeFrom(p.library, l); l.zone = 'hand'; p.hand.push(l); toHand.push(l); }
            this.R.shuffle(p.library);
          }
          if (!quiet) this.emit('ramp', `${name}: ${p.name} ${toBf.length ? `puts ${this.listNames(toBf.map((c) => c.info.name))} onto the battlefield${fx.tapped ? ' tapped' : ''}` : ''}${toBf.length && toHand.length ? ' and ' : ''}${toHand.length ? `puts ${this.listNames(toHand.map((c) => c.info.name))} into their hand` : ''}${!toBf.length && !toHand.length ? 'finds no land' : ''}.`, { seat: p.seat, cards: (src ? [src.id] : []).concat(toBf.map((c) => c.id)) });
          break;
        }
        case 'ritual': this.addFloating(p, fx.color || 'C', fx.n); this.emit('effect', `${name} adds ${fx.n} ${({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' })[fx.color] || 'colorless'} mana.`, { seat: p.seat }); break;
        case 'treasure': this.addToken(p, { treasure: true }, X(fx.n) || 1, quiet); break;
        case 'tokens': {
          let n = X(fx.n);
          if (fx.nRef) n = p.bf.filter((c) => (c.info.subtypes || []).includes(fx.nRef)).length;
          if (fx.n === 'LANDS') n = p.bf.filter((c) => c.info.isLand).length;
          const pp = fx.p === 'X' ? Math.max(1, xVal) : fx.p, tt = fx.t === 'X' ? Math.max(1, xVal) : fx.t;
          if (n > 0) this.addToken(p, { p: pp, t: tt, sub: fx.sub, kw: fx.kw, colors: fx.colors, tapped: fx.tapped, dies: fx.dies || [], combatDmg: fx.combatDmg, artifact: fx.artifact }, n, false);
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
          const tally = {}, life0 = {};
          for (const q of this.opps(p)) { tally[q.seat] = {}; life0[q.seat] = q.life; }
          for (const q of this.opps(p)) {
            for (let i = 0; i < reps && !q.lost; i++) {
              const fodder = q.bf.filter((c) => !c.info.isLand).sort((a, b) => this.permValue(a) - this.permValue(b))[0];
              if (q.life > 12 || (!fodder && !q.hand.length)) { this.loseLife(q, 3, src); continue; }
              if (q.hand.length && (!fodder || this.R() < 0.5)) { const before = q.hand.slice(); this.discardWorst(q, 1); const d = before.find((x) => !q.hand.includes(x)); if (d) (tally[q.seat].disc = tally[q.seat].disc || []).push(d.info.name); }
              else if (fodder) { (tally[q.seat].sac = tally[q.seat].sac || []).push(this.cname(fodder)); this.destroy(fodder, 'sacrificed', true); }
              else this.loseLife(q, 3, src);
            }
            tally[q.seat].life = life0[q.seat] - q.life;
          }
          const lines = this.players.filter((q) => tally[q.seat]).map((q) => { const t = tally[q.seat]; const bits = []; if (t.life) bits.push(`loses ${t.life} life`); if (t.sac) bits.push(`sacrifices ${this.listNames(t.sac, 4)}`); if (t.disc) bits.push(`discards ${this.listNames(t.disc, 4)}`); return `${q.name} ${bits.join(', ') || 'is unaffected'}${q.lost ? ' and is out' : ''}`; });
          this.emit('drain', `Torment of Hailfire (X=${reps}): ${lines.join('; ')}.`, { seat: p.seat, cards: src ? [src.id] : [] });
          this.checkState();
          break;
        }
        case 'damage': {
          const n = X(fx.n);
          if (fx.to === 'each opponent') { for (const q of this.opps(p)) this.loseLife(q, this.scaleDamage(p.seat, q.seat, n), src); this.emit('damage', `${name} deals ${this.scaleDamage(p.seat, (this.opps(p)[0] || p).seat, n)} to each opponent.`, { seat: p.seat }); this.checkState(); break; }
          if (fx.to === 'any target' || fx.to === 'target player' || fx.to === 'target opponent') { this.dealDamageAny(p, n, src); break; }
          const tgt = this.bestOppTarget(p, (c) => (c.info.isCreature && this.toughness(c) - c.dmg <= this.scaleDamage(p.seat, c.ctrl, n) || c.info.isPW && c.loyalty <= this.scaleDamage(p.seat, c.ctrl, n)) && this.targetable(c, p));
          if (tgt) {
            const d = this.scaleDamage(p.seat, tgt.ctrl, n);
            this.permDmg(tgt, d);
            this.emit('removal', `${name} deals ${d} damage to ${tgt.info.name}.`, { seat: p.seat, cards: [tgt.id], target: tgt.ctrl });
            this.checkState();
          }
          break;
        }
        case 'removal': {
          const pred = this.removalPred(fx.what);
          const destroys = !fx.tuck && !fx.bounce && !fx.shrink && !fx.exile; // "destroy" can't touch an indestructible one: pick another (Aura Shards kept aiming at The Soul Stone)
          const tgt = src && src._target ? src._target : this.bestOppTarget(p, (c) => pred(c) && this.targetable(c, p) && !(destroys && (this.hasKw(c, 'indestructible') || c.indestructibleEOT)));
          if (!tgt || tgt.zone !== 'bf') break;
          const owner = this.P(tgt.ctrl);
          this.announceTarget(p, tgt, src, name);
          if (this.tryProtect(owner, [tgt], p)) break;
          let verb;
          if (!this.payWard(p, tgt, src)) break;
          if (this.redirectRemoval(owner, p, tgt, src)) break;
          if (this.runesSave(owner, tgt)) break;
          // announce first, then do it, so what it sets off (dies triggers, commander moving home) is logged after
          const say = (verb) => { if (owner !== p) this.credit(src, 'removed', 1); this.emit('removal', `${name || p.name} ${verb} ${owner.name}'s ${this.cname(tgt)}.`, { seat: p.seat, cards: [tgt.id], target: owner.seat }); };
          const indestructible = !fx.tuck && !fx.bounce && !fx.shrink && !fx.exile && (this.hasKw(tgt, 'indestructible') || tgt.indestructibleEOT);
          if (indestructible) { this.emit('removal', `${name || p.name} tries to destroy ${tgt.info.name}, but it is indestructible.`, { seat: p.seat, cards: [tgt.id], target: owner.seat }); break; }
          say(fx.tuck ? 'puts third from the top of its owner\'s library:' : fx.bounce ? 'returns to hand:' : fx.shrink ? `gives -${fx.shrink}/-${fx.shrink} to` : fx.exile ? 'exiles' : 'destroys');
          if (fx.tuck) { this.leaveBattlefield(tgt); this.removeFrom(this.P(tgt.ctrl).bf, tgt); if (!tgt.token) { if (tgt.isCommander) { tgt.zone = 'command'; this.P(tgt.owner).command.push(tgt); } else { tgt.zone = 'library'; this.P(tgt.owner).library.splice(2, 0, tgt); } } verb = 'tucks'; }
          else if (fx.bounce) { this.bounce(tgt); verb = 'bounces'; }
          else if (fx.shrink) { tgt.eot.t -= fx.shrink; tgt.eot.p -= fx.shrink; verb = 'shrinks'; this.checkState(); }
          else if (fx.exile) {
            const pw = this.power(tgt);
            this.exileCard(tgt); verb = 'exiles';
            // Swords: its controller gains life equal to its power. Path: its controller may fetch a basic land, tapped.
            if (fx.comp === 'life' && pw > 0) { this.gainLife(owner, pw); this.emit('life', `${owner.name} gains ${pw} life (Swords to Plowshares).`, { seat: owner.seat }); }
            if (fx.comp === 'land') { const l = owner.library.find((x) => x.info.isLand && x.info.types.has('Basic')); if (l) { this.removeFrom(owner.library, l); this.R.shuffle(owner.library); this.enterBattlefield(l, owner, { tapped: true, quiet: true }); this.emit('ramp', `${owner.name} searches for ${l.info.name} (Path to Exile).`, { seat: owner.seat, cards: [l.id] }); } }
          }
          else if (fx.destroyComp) { if (this.destroy(tgt)) { const l = owner.library.find((x) => x.info.isLand && x.info.types.has('Basic')); if (l) { this.removeFrom(owner.library, l); this.R.shuffle(owner.library); this.enterBattlefield(l, owner, { quiet: true }); this.emit('ramp', `${owner.name} searches for ${l.info.name} (Assassin's Trophy).`, { seat: owner.seat, cards: [l.id] }); } } verb = 'destroys'; }
          else { const tough = this.toughness(tgt); if (!this.destroy(tgt)) { this.emit('removal', `${tgt.info.name} survives.`, { seat: p.seat, cards: [tgt.id] }); break; } verb = 'destroys'; if (fx.gainToughness) this.gainLife(p, tough); }
          break;
        }
        case 'edict': {
          // "target player sacrifices": the opponent whose cheapest creature is still the most valuable
          const edictTargets = fx.one ? [this.opps(p).filter((q) => q.bf.some((x) => x.info.isCreature) && !this.has(q, 'sigarda')).sort((a, b) => Math.min(...b.bf.filter((x) => x.info.isCreature).map((x) => this.creatureValue(x))) - Math.min(...a.bf.filter((x) => x.info.isCreature).map((x) => this.creatureValue(x))))[0]].filter(Boolean) : this.opps(p);
          for (const q of edictTargets) {
            if (this.has(q, 'sigarda')) continue;
            const cs = q.bf.filter((x) => x.info.isCreature).sort((a, b) => this.creatureValue(a) - this.creatureValue(b)).slice(0, fx.n || 1);
            if (cs.length) this.emit('removal', `${name ? name + ': ' : ''}${q.name} sacrifices ${cs.map((c) => this.cname(c)).join(', ')}.`, { seat: p.seat, cards: cs.map((c) => c.id), target: q.seat });
            for (const c of cs) this.destroy(c, 'sacrificed', true);
          }
          break;
        }
        case 'steal': {
          const tgt = this.bestOppTarget(p, (c) => (fx.what === 'creature' ? c.info.isCreature : !c.info.isLand) && this.targetable(c, p));
          if (!tgt) break;
          this.announceTarget(p, tgt, src, name);
          if (!this.payWard(p, tgt, src)) break;
          const from = this.P(tgt.ctrl); this.removeFrom(from.bf, tgt); tgt.ctrl = p.seat; tgt.sick = true; p.bf.push(tgt);
          this.emit('removal', `${p.name} steals ${tgt.info.name} from ${from.name}.`, { seat: p.seat, cards: [tgt.id], target: from.seat });
          break;
        }
        case 'pacify': break;
        case 'edictThat': {
          const q = this._thatPlayer; if (!q) break;
          if (q !== p && this.has(q, 'sigarda')) { this.emit('effect', `${name}: Sigarda keeps ${q.name} from sacrificing.`, { seat: q.seat }); break; }
          const c = q.bf.filter((x) => x.info.isCreature).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0];
          if (c) { this.emit('removal', `${name}: ${q.name} sacrifices ${this.cname(c)}.`, { seat: p.seat, cards: [c.id], target: q.seat }); this.destroy(c, 'sacrificed', true); }
          break;
        }
        case 'genesis': {
          let x = xVal;
          if (!x) x = Math.max(...p.bf.concat(p.command).filter((c) => c.isCommander).map((c) => c.info.mv), 0);
          const top = p.library.splice(0, Math.max(0, x));
          // Majestic Genesis: any permanent cards, the rest to the bottom. Genesis Wave: mana value X or less, the rest to the graveyard.
          const put = top.filter((c) => c.info.isPermanent && !c.info.isInstant && (fx.majestic || c.info.mv <= x));
          const rest = top.filter((c) => !put.includes(c));
          if (fx.majestic) { for (const c of rest) { c.zone = 'library'; } p.library.push(...this.R.shuffle(rest.slice())); }
          else for (const c of rest) this.toGraveyard(c, p.seat);
          for (const c of put) { c.zone = 'library'; this.enterBattlefield(c, p, { quiet: true }); }
          this.emit('effect', `${name} reveals ${top.length} cards and puts ${put.length ? this.listNames(put.map((c) => c.info.name), 8) : 'nothing'} onto the battlefield${rest.length ? `; ${rest.length} go${rest.length === 1 ? 'es' : ''} ${fx.majestic ? 'to the bottom' : 'to the graveyard'}` : ''}.`, { seat: p.seat, cards: put.map((c) => c.id) });
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
          this.searched(p); if (p.tutorTurn !== this.turn) { p.tutorTurn = this.turn; p.tutorN = 0; } p.tutorN++;
          const pick = this.chooseTutor(p, fx.what);
          if (pick && fx.top) {
            // "shuffle and put that card on top": it is drawn next, not put into hand
            this.credit(src, 'tutored', 1); this.removeFrom(p.library, pick); this.R.shuffle(p.library); p.library.unshift(pick);
            this.emit('tutor', `${p.name} searches for ${pick.info.name} and puts it on top of their library.`, { seat: p.seat, cards: [pick.id] });
          } else if (pick) { this.credit(src, 'tutored', 1); this.removeFrom(p.library, pick); pick.zone = 'hand'; p.hand.push(pick); this.R.shuffle(p.library); this.emit('tutor', `${p.name} tutors for ${pick.info.name}.`, { seat: p.seat, cards: [pick.id] }); }
          break;
        }
        case 'tutorBF': {
          const gsz = src && src.info.name === "Green Sun's Zenith";
          const crs = p.library.filter((c) => c.info.isCreature && c.info.mv <= (gsz ? xVal : Math.max(xVal, 3)) && (!gsz || c.info.colors.has('G'))).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a));
          if (crs[0]) { this.removeFrom(p.library, crs[0]); this.R.shuffle(p.library); this.enterBattlefield(crs[0], p); this.emit('tutor', `${p.name} puts ${crs[0].info.name} onto the battlefield.`, { seat: p.seat, cards: [crs[0].id] }); }
          break;
        }
        case 'regrow': {
          const fewLands = p.bf.filter((x) => x.info.isLand).length < 5;
          // with Muldrotha out, permanents can be cast from the graveyard anyway: take back an instant or sorcery
          const mul = this.has(p, 'muldrotha');
          const val = (x) => (x.info.isLand ? (fewLands || x.info.cradle || x.info.coffers ? 6 : 0) : mul && x.info.isPermanent ? this.cardValue(p, x) * 0.3 : this.cardValue(p, x) + (mul && x.info.spell.length ? 6 : 0));
          const c = p.gy.filter((x) => !x.info.isLand || val(x) > 0).sort((a, b) => val(b) - val(a))[0];
          if (c) { this.removeFrom(p.gy, c); c.zone = 'hand'; p.hand.push(c); this.emit('effect', `${p.name} returns ${c.info.name} to hand.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'massRegrow': {
          if (fx.bf) {
            const want = { creature: 'Creature', artifact: 'Artifact', enchantment: 'Enchantment', land: 'Land' }[fx.what];
            const got = p.gy.filter((x) => x.info.isPermanent && (!want || x.info.types.has(want)));
            for (const c of got) { this.removeFrom(p.gy, c); this.enterBattlefield(c, p, { quiet: true }); if (fx.haste && c.zone === 'bf') c.eot.kw.push('haste'); }
            this.emit('reanimate', `${name} returns ${got.length} cards to the battlefield.`, { seat: p.seat, cards: got.map((c) => c.id) });
            break;
          }
          const lands = p.gy.filter((x) => x.info.isLand);
          for (const l of lands) { this.removeFrom(p.gy, l); l.zone = 'hand'; p.hand.push(l); }
          if (lands.length) this.emit('effect', `${p.name} returns ${lands.length} lands to hand.`, { seat: p.seat });
          break;
        }
        case 'hireling': {
          const t = this.hirelingTarget(p); if (!t) break;
          const x = this.toughness(t); const tr = p.bf.filter((y) => y.token && this.isSubtype(y, 'Treasure')).slice(0, x);
          for (const y of tr) this.destroy(y, 'sacrificed', true);
          t.eot.p -= x; t.eot.t -= x;
          this.emit('removal', `${name}: ${p.name} sacrifices ${x} Treasure${x === 1 ? '' : 's'}; ${this.cname(t)} gets -${x}/-${x}.`, { seat: p.seat, cards: [t.id], target: t.ctrl });
          this.checkState(); break;
        }
        case 'reanimate': {
          const pools = fx.any ? this.alive().flatMap((q) => q.gy) : p.gy;
          const c = pools.filter((x) => (fx.perm ? x.info.isPermanent && x.info.mv <= fx.mvMax && (!x.info.isLand || fx.lands) : x.info.isCreature) && !x.isCommander && (!fx.subs || fx.subs.some((t) => this.isType(x, t))) && (!fx.loseMv || this.canPayLife(p, x.info.mv))).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (c) {
            this.removeFrom(this.P(c.owner).gy, c);
            if (src && src.info.reanimAura && src.zone === 'bf') src.attached = c.id;
            this.enterBattlefield(c, p, { announce: () => this.emit('reanimate', `${p.name} reanimates ${c.info.name}${c.owner !== p.seat ? ' from ' + this.P(c.owner).name + "'s graveyard" : ''}${src ? ` with ${src.info.name}` : ''}.`, { seat: p.seat, cards: [c.id] }) });
            if (fx.loseMv) this.loseLife(p, c.info.mv);
            if (fx.whip && c.zone === 'bf') { c.whipped = true; c.eot.kw.push('haste'); c.sick = false; (p.whipExile = p.whipExile || []).push(c); }
            if (fx.zombie && c.zone === 'bf' && !(c.info.subtypes || []).includes('Zombie')) this.setInfo(c, { subtypes: [...(c.info.subtypes || []), 'Zombie'] });
          }
          break;
        }
        case 'counters': {
          const n = this.counterAmount(p, X(fx.n) || 1);
          let targets = [];
          if (fx.on === 'each') targets = p.bf.filter((c) => c.info.isCreature && (!fx.sub || this.isType(c, fx.sub)));
          else if (fx.on === 'attacking') targets = p.bf.filter((c) => c.attacking);
          else if (fx.on === 'entering') targets = this._entering && this._entering.zone === 'bf' ? [this._entering] : [];
          else if (fx.on === 'self' && src && src.zone === 'bf' && src.info.isCreature) targets = [src];
          else { const t = p.bf.filter((c) => c.info.isCreature).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0]; if (t) targets = [t]; }
          targets.forEach((c) => (c.p1 += n));
          if (targets.length && !quiet) this.emit('effect', `${targets.length > 1 ? targets.length + ' creatures get' : targets[0].info.name + ' gets'} ${n} +1/+1 counter${n > 1 ? 's' : ''}.`, { seat: p.seat, cards: targets.map((c) => c.id) });
          break;
        }
        case 'proliferate': {
          // proliferate: choose any permanents and players that have counters and give each one more of a kind it has.
          // Ours: +1/+1, loyalty, charge. Theirs: -1/-1 counters on their creatures, poison on them.
          const hit = [];
          for (const c of p.bf) {
            let any = false;
            if (c.p1 > 0) { c.p1 += this.counterAmount(p, 1, 'p1'); any = true; }
            if (c.info.isPW && c.loyalty > 0) { c.loyalty += this.counterAmount(p, 1, 'loyalty'); any = true; }
            if (c.charge > 0 && !c.info.saga) { c.charge += this.counterAmount(p, 1, 'charge'); any = true; }
            if (any) hit.push(c);
          }
          for (const q of this.opps(p)) {
            for (const c of q.bf) if (c.info.isCreature && c.p1 < 0) { c.p1 -= 1; hit.push(c); }
            if (q.poison > 0) q.poison += Math.floor((this.has(p, 'vorinclexHalf') ? 2 : 1) / (this.opps(p).some((o) => this.has(o, 'vorinclexHalf')) ? 2 : 1)); // Vorinclex: twice as many from you, half from its opponents
          }
          const pois = this.opps(p).filter((q) => q.poison > 0);
          if ((hit.length || pois.length) && !quiet) this.emit('effect', `${p.name} proliferates: ${this.listNames(hit.map((c) => this.cname(c)), 8) || 'no permanents'}${pois.length ? `; poison on ${pois.map((q) => q.name).join(', ')}` : ''}.`, { seat: p.seat, cards: (src ? [src.id] : []).concat(hit.map((c) => c.id)) });
          this.checkState();
          break;
        }
        case 'overrun': {
          const crs = p.bf.filter((c) => c.info.isCreature && (!fx.notSub || !this.isType(c, fx.notSub)));
          const n = crs.length;
          for (const c of crs) { c.eot.p += fx.p === 'X' ? n : fx.p; c.eot.t += fx.t === 'X' ? n : fx.t; c.eot.kw.push(...fx.kw); }
          const bump = fx.p === 'X' || fx.p || fx.t ? `+${fx.p === 'X' ? n : fx.p}/+${fx.t === 'X' ? n : fx.t}` : '';
          this.emit('effect', `${name}: creatures ${p.name} controls get ${[bump, fx.kw.join(', ')].filter(Boolean).join(' and ')} until end of turn!`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'protect': break;
        case 'discard': {
          // "target player discards" hits one player (the opponent with the most cards); "each opponent" hits all.
          // The discarding player chooses, unless it says "at random".
          let targets = this._combatDefender && src && (src.info.combatDmg || []).includes(fx) ? [this._combatDefender] : this.opps(p);
          if (fx.one && targets.length > 1) targets = [targets.filter((q) => q.hand.length).sort((a, b) => b.hand.length - a.hand.length || this.playerThreat(b) - this.playerThreat(a))[0] || targets[0]];
          const parts = [];
          for (const q of targets) {
            const gone = [];
            for (let i = 0; i < (fx.n || 1) && q.hand.length; i++) {
              if (fx.random) { const d = q.hand[this.R.int(q.hand.length)]; this.discardCard(q, d); gone.push(d); }
              else { const before = q.hand.slice(); this.discardWorst(q, 1); gone.push(...before.filter((x) => !q.hand.includes(x))); }
            }
            parts.push(gone.length ? `${q.name} discards ${gone.map((c) => c.info.name).join(' and ')}` : `${q.name} has no cards`);
          }
          if (!quiet || fx.one) this.emit('effect', `${name}: ${parts.join('; ')}.`, { seat: p.seat, target: targets.length === 1 ? targets[0].seat : null });
          break;
        }
        case 'extraTurn': p.extraTurn = (p.extraTurn || 0) + 1; this.emit('effect', `${p.name} will take an extra turn.`, { seat: p.seat }); break;
        case 'cheatAttack': break;
        case 'noop': break;
        case 'dig': {
          const top = p.library.splice(0, fx.n);
          const want = (c) => fx.types.some((t) => ({ creature: c.info.isCreature, land: c.info.isLand, planeswalker: c.info.isPW, noncreature: !c.info.isCreature, nonland: !c.info.isLand, artifact: c.info.types.has('Artifact'), enchantment: c.info.types.has('Enchantment'), instant: c.info.isInstant, sorcery: c.info.isSorcery, legendary: c.info.isLegendary }[t] ?? this.isType(c, cap(t))));
          const match = fx.types.includes('noncreature') && fx.types.includes('nonland') ? (c) => !c.info.isCreature && !c.info.isLand : want;
          let picks = top.filter(match).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a));
          if (fx.all) { const seen = new Set(); picks = picks.filter((c) => { const t = fx.types.find((x) => this.isType(c, cap(x))); if (!t || seen.has(t)) return false; seen.add(t); return true; }); } else picks = picks.slice(0, 1);
          for (const c of picks) { this.removeFrom(top, c); c.zone = 'hand'; p.hand.push(c); }
          for (const c of top) { if (fx.restGy) this.toGraveyard(c); else { c.zone = 'library'; p.library.push(c); } }
          this.emit('draw', `${name}: ${p.name} looks at ${fx.n} and takes ${picks.length ? picks.map((c) => c.info.name).join(', ') : 'nothing'}.`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'search': {
          if (fx.needsRector && this._rectorFailed) break; // Academy Rector: "if you do" (it had to be exiled)
          this.searched(p);
          const n = X(fx.n) || 1;
          const w = fx.what;
          const pred = (c) => {
            const i = c.info;
            if (/^card$/.test(w)) return true;
            if (/basic/.test(w) && /land/.test(w)) return i.isLand && i.types.has('Basic');
            if (/land/.test(w)) return i.isLand;
            if (/legendary/.test(w)) return i.isLegendary;
            if (/creature/.test(w)) return i.isCreature;
            if (/planeswalker/.test(w)) return i.isPW;
            if (/artifact or enchantment/.test(w)) return i.types.has('Artifact') || i.types.has('Enchantment');
            if (/artifact/.test(w)) return i.types.has('Artifact');
            if (/enchantment/.test(w)) return i.types.has('Enchantment');
            if (/instant or sorcery/.test(w)) return i.isInstant || i.isSorcery;
            return this.isType(c, cap(w.split(' ').pop()));
          };
          const mvCap = fx.mvPlusOne ? (this._sacMv ?? 0) + 1 : fx.mvMax === 'X' ? xVal : fx.mvMax;
          let pool = p.library.filter((c) => pred(c) && (!fx.noX || !c.info.cost.x) && (mvCap == null || (fx.mvPlusOne ? c.info.mv === mvCap : c.info.mv <= mvCap)));
          let got = [];
          for (let i = 0; i < n && pool.length; i++) {
            let pick;
            if (fx.dest === 'gy') { const gv = (c) => this.cardValue(p, c) - (c.info.isLegendary && p.bf.concat(p.command).some((x) => x.info.activated.some((a) => a.fx.some((y) => y.k === 'osgir'))) ? 4 : 0); pick = pool.filter((c) => (c.info.isCreature || c.info.types.has('Artifact')) && !c.info.shuffleBack).sort((a, b) => gv(b) - gv(a))[0] || pool[0]; }
            else if (fx.dest === 'hand' && w === 'card') pick = this.chooseTutor(p, 'card');
            else { const wantN = new Set(this.comboWants(p).flatMap((w2) => w2.missing.map((m2) => m2.name))); const sv = (c) => this.cardValue(p, c) + (wantN.has(c.name) ? 15 : 0); pick = pool.find((c) => this.completesCombo(p, c)) || pool.slice().sort((a, b) => sv(b) - sv(a))[0]; } // a missing combo piece first
            if (!pick) break;
            this.removeFrom(pool, pick); this.removeFrom(p.library, pick); got.push(pick);
            if (fx.dest === 'bf') this.enterBattlefield(pick, p, { quiet: true });
            else if (fx.dest === 'gy') this.toGraveyard(pick);
            else { pick.zone = 'hand'; p.hand.push(pick); }
          }
          this.R.shuffle(p.library);
          if (got.length) this.emit('tutor', `${name}: ${p.name} searches out ${got.map((c) => c.info.name).join(', ')}${fx.dest === 'bf' ? ' onto the battlefield' : fx.dest === 'gy' ? ' into the graveyard' : ''}.`, { seat: p.seat, cards: got.map((c) => c.id) });
          break;
        }
        case 'mill': {
          const n = X(fx.n) || 0;
          const milled = this.mill(p, n);
          if (!quiet) this.emit('effect', `${name}: ${p.name} mills ${milled.length}.`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'exileTop': { const c = p.library.shift(); if (c) { c.zone = 'exile'; p.exile.push(c); if (!quiet) this.emit('effect', `${name}: ${p.name} exiles ${c.info.name} from the top of their library.`, { seat: p.seat, cards: [c.id] }); } break; }
        case 'millTop': { const c = p.library.shift(); if (c) { c.zone = 'hand'; c.impulseTurn = this.turn; p.hand.push(c); } break; }
        case 'scry': {
          for (let i = 0; i < fx.n && i < p.library.length; i++) {
            const c = p.library[i];
            const lands = p.bf.filter((x) => x.info.isLand).length + p.hand.filter((x) => x.info.isLand).length;
            if ((c.info.isLand && lands >= 7) || (!c.info.isLand && lands < 3 && c.info.mv > 3)) { p.library.splice(i, 1); p.library.push(c); }
          }
          break;
        }
        case 'edictAll': {
          const parts = [], hit = [];
          for (const q of this.alive()) {
            if (this.has(q, 'sigarda') && q !== p) { parts.push(`${q.name} is protected by Sigarda`); continue; }
            const pool = q.bf.filter((x) => x.info.isCreature || (fx.pw && x.info.isPW)).sort((a, b) => this.permValue(a) - this.permValue(b));
            if (!pool.length && fx.discardIfNone) { const before = q.hand.slice(); this.discardWorst(q, 1); const d = before.find((x) => !q.hand.includes(x)); parts.push(d ? `${q.name} has none and discards ${d.info.name}` : `${q.name} has nothing`); continue; }
            const victims = pool.slice(0, fx.n);
            if (!victims.length) { parts.push(`${q.name} has nothing to sacrifice`); continue; }
            parts.push(`${q.name} sacrifices ${victims.map((c) => this.cname(c)).join(' and ')}`); hit.push(...victims);
          }
          this.emit('removal', `${name}: ${parts.join('; ')}.`, { seat: p.seat, cards: (src ? [src.id] : []).concat(hit.map((c) => c.id)) });
          { const b = this.beginDeathBatch(); for (const c of hit) this.destroy(c, 'sacrificed', true); this.endDeathBatch(b); }
          break;
        }
        case 'discardAll': for (const q of this.alive()) this.discardWorst(q, 1); if (!quiet) this.emit('effect', `${name}: each player discards a card.`, { seat: p.seat }); break;
        case 'loot': {
          const draws = fx.draw ?? fx.n;
          if (fx.draw != null && !fx.optional) { this.draw(p, draws); this.discardWorst(p, Math.min(fx.n, p.hand.length)); }
          else { if (fx.optional && p.hand.length < fx.n) break; const n = Math.min(fx.n, p.hand.length); this.discardWorst(p, n); this.draw(p, fx.draw != null ? draws : n); }
          if (!quiet) this.emit('draw', `${name}: ${p.name} draws ${draws} and discards ${fx.n}.`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'discardSelf': { for (let i = 0; i < fx.n && p.hand.length; i++) this.discardCard(p, fx.random ? p.hand[this.R.int(p.hand.length)] : p.hand.slice().sort((a, b) => this.cardValue(p, a) - this.cardValue(p, b))[0]); break; }
        case 'sacLand': { const l = p.bf.filter((c) => c.info.isLand).sort((a, b) => this.landKeep(p, a) - this.landKeep(p, b))[0]; if (l) this.destroy(l, 'sacrificed', true); break; }
        case 'finale': {
          const x = Math.max(0, xVal);
          const pool = p.library.concat(p.gy).filter((c) => c.info.isCreature && c.info.mv <= x).sort((a, b) => this.creatureValue({ ...b, p1: 0, eot: { p: 0, t: 0, kw: [] }, ctrl: p.seat }) - this.creatureValue({ ...a, p1: 0, eot: { p: 0, t: 0, kw: [] }, ctrl: p.seat }));
          const c = pool[0];
          if (c) { if (c.zone !== 'gy') this.searched(p); this.removeFrom(c.zone === 'gy' ? p.gy : p.library, c); this.R.shuffle(p.library); this.enterBattlefield(c, p); this.emit('tutor', `${name} puts ${c.info.name} onto the battlefield.`, { seat: p.seat, cards: [c.id] }); }
          if (x >= 10) this.resolveEffect(p, { k: 'overrun', p: x, t: x, kw: ['haste'] }, src, 0, false);
          break;
        }
        case 'darettiWeld': {
          const fod = p.bf.filter((c) => c.info.types.has('Artifact') && !c.isCommander).sort((a, b) => this.permValue(a) + (a.info.isLand ? 3 : 0) - this.permValue(b) - (b.info.isLand ? 3 : 0))[0];
          const best = p.gy.filter((c) => c.info.types.has('Artifact') && c.info.isPermanent).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (!fod || !best) break;
          this.destroy(fod, 'sacrificed', true); this.removeFrom(p.gy, best); this.enterBattlefield(best, p);
          this.emit('reanimate', `${name}: ${p.name} sacrifices ${fod.info.name} and returns ${best.info.name}.`, { seat: p.seat, cards: [best.id] });
          break;
        }
        case 'untapCreature': {
          const c = this.untapTarget(p, this.phase === 'main 2') || p.bf.filter((x) => x.info.isCreature && x.tapped && (x.info.mana || x.info.activated.some((a) => a.tap))).sort((a, b) => this.permValue(b) - this.permValue(a))[0];
          if (c) { c.tapped = false; if (this._usedAbilities) for (const k of [...this._usedAbilities.set]) if (k.startsWith(c.id + ':')) this._usedAbilities.set.delete(k); this.emit('ability', `${name} untaps ${c.info.name}.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'loseSelf': this.loseLife(p, X(fx.n)); break;
        case 'agadeem': {
          // any number of creature cards with different mana values, each X or less
          const got = [];
          for (let mv = Math.max(0, xVal); mv >= 0; mv--) {
            const c = p.gy.filter((x) => x.info.isCreature && !x.isCommander && x.info.mv === mv).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
            if (c) { this.removeFrom(p.gy, c); this.enterBattlefield(c, p, { quiet: true }); got.push(c); }
          }
          this.emit('reanimate', `${name}: ${p.name} returns ${got.length ? this.listNames(got.map((c) => c.info.name)) : 'nothing'}.`, { seat: p.seat, cards: got.map((c) => c.id) });
          break;
        }
        case 'tamiyoWatch': { const cs = p.bf.filter((c) => c.info.isCreature).sort((a, b) => this.power(b) + (this.hasKw(b, 'flying') ? 3 : 0) - this.power(a) - (this.hasKw(a, 'flying') ? 3 : 0)).slice(0, 2); for (const c of cs) c.tamiyoBy = p.seat; break; } // Tamiyo, Field Researcher's +1 (see hitPlayer)
        case 'loseGame': { const q = this._combatDefender; if (q && !q.lost) { this.emit('combo', `${name} dealt combat damage to ${q.name}: they lose the game!`, { seat: p.seat, target: q.seat }); this.lose(q, `${name}`); this.checkState(); } break; }
        case 'drawTapped': { const n = Math.max(0, ...this.alive().map((q) => q.bf.filter((c) => c.info.isCreature && c.tapped).length)); if (n) { this.draw(p, n); this.emit('draw', `${name}: ${p.name} draws ${n} (tapped creatures).`, { seat: p.seat }); } break; }
        case 'regrowType': {
          const c = p.gy.filter((x) => fx.types.some((t) => (t === 'creature' && x.info.isCreature) || (t === 'planeswalker' && x.info.isPW))).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (c) { this.removeFrom(p.gy, c); c.zone = 'hand'; p.hand.push(c); this.emit('effect', `${name}: ${p.name} returns ${c.info.name} to hand.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'emptyLibraryWin': if (!p.library.length) { this.emit('combo', `${name}: ${p.name}'s library is empty, so they win!`, { seat: p.seat }); for (const q of this.opps(p)) this.lose(q, 'Jace, Wielder of Mysteries'); this.checkState(); } break;
        case 'selfIndestructible': if (src && src.zone === 'bf') src.indestructibleEOT = true; break;
        case 'minusCounter': {
          // Yawgmoth: a -1/-1 counter on up to one target creature: an opponent's creature it kills, the best one
          const t = this.bestOppTarget(p, (x) => x.info.isCreature && this.targetable(x, p) && this.toughness(x) - x.dmg <= 1);
          if (t) { t.p1 -= 1; this.emit('removal', `${name}: a -1/-1 counter on ${this.P(t.ctrl).name}'s ${this.cname(t)}.`, { seat: p.seat, cards: [t.id], target: t.ctrl }); this.checkState(); }
          break;
        }
        case 'exileDead': { const d = this._dyingCard; if (d && d.zone === 'gy' && !d.token) { this.removeFrom(this.P(d.owner).gy, d); d.zone = 'exile'; this.P(d.owner).exile.push(d); } break; }
        case 'rectorExile': { if (!src || src.token || src.zone !== 'gy') { this._rectorFailed = true; break; } this.removeFrom(this.P(src.owner).gy, src); src.zone = 'exile'; this.P(src.owner).exile.push(src); this._rectorFailed = false; break; }
        case 'loyaltyEach': {
          const ws = p.bf.filter((c) => c.info.isPW && (!fx.other || c !== src));
          for (const c of ws) c.loyalty += this.counterAmount(p, 1, 'loyalty');
          if (ws.length && !quiet) this.emit('effect', `${name}: a loyalty counter on ${this.listNames(ws.map((c) => c.info.name))}.`, { seat: p.seat, cards: ws.map((c) => c.id) });
          break;
        }
        case 'brainstorm': {
          // Jace's 0: draw three, then put back the two cards we want least (extra lands first when we have plenty)
          this.draw(p, 3);
          const lands = p.bf.filter((c) => c.info.isLand).length;
          const back = p.hand.slice().sort((a, b) => (a.info.isLand ? (lands >= 6 ? -5 : 5) : this.cardValue(p, a)) - (b.info.isLand ? (lands >= 6 ? -5 : 5) : this.cardValue(p, b))).slice(0, 2);
          for (const c of back.reverse()) { this.removeFrom(p.hand, c); c.zone = 'library'; p.library.unshift(c); }
          this.emit('draw', `${name}: ${p.name} draws three and puts two back on top.`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'bloodgift': {
          // "target player draws a card and loses 1 life": us when we can afford it, else the opponent closest to dying
          const q = this.canPayLife(p, 1) ? p : this.opps(p).sort((a, b) => a.life - b.life)[0];
          if (!q) break;
          this.draw(q, 1); this.loseLife(q, 1, q === p ? undefined : src);
          this.emit('draw', `Bloodgift Demon: ${q.name} draws a card and loses 1 life${q === p ? '' : ` (${p.name} can't spare the life)`}.`, { seat: p.seat, cards: src ? [src.id] : [], target: q.seat });
          this.checkState();
          break;
        }
        case 'lifeBecomes': {
          const q = this.opps(p).sort((a, b) => b.life - a.life)[0];
          if (q && q.life > fx.n) { this.loseLife(q, q.life - fx.n, src); this.emit('effect', `${name}: ${q.name}'s life total becomes ${fx.n}.`, { seat: p.seat, target: q.seat }); }
          break;
        }
        case 'freeze': {
          const tg = this.opps(p).flatMap((q) => q.bf).filter((c) => !c.info.isLand && this.targetable(c, p)).sort((a, b) => this.permValue(b) - this.permValue(a)).slice(0, fx.n);
          for (const c of tg) { c.tapped = true; c.frozenUntil = this.turn + this.alive().length + 1; }
          if (tg.length) this.emit('effect', `${name} taps down ${tg.map((c) => c.info.name).join(' and ')}.`, { seat: p.seat, cards: tg.map((c) => c.id) });
          break;
        }
        case 'phaseOut': {
          const t = this.bestOppTarget(p, (c) => c.info.isCreature && this.targetable(c, p));
          if (t) this.phaseOut(t, `${name} phases out ${t.info.name}`);
          break;
        }
        case 'massReanimate': {
          const all = (fx.own ? [p] : this.players).flatMap((q) => q.gy.filter((c) => c.info.isCreature && (fx.mvMax == null || (c.info.mv || 0) <= fx.mvMax)));
          for (const c of all) { if (c.zone !== 'gy') continue; this.removeFrom(this.P(c.owner).gy, c); this.enterBattlefield(c, p, { quiet: true }); } // (a creature returning can reanimate another first)
          this.emit('reanimate', fx.own ? `${name}: ${p.name} returns ${all.length ? this.listNames(all.map((c) => c.info.name)) : 'nothing'} to the battlefield.` : `${name}: ${all.length} creatures from every graveyard join ${p.name}!`, { seat: p.seat, cards: all.map((c) => c.id) });
          break;
        }
        case 'livingDeath': {
          // each player's graveyard creatures and battlefield creatures swap places
          const sets = this.alive().map((q) => { const cs = q.gy.filter((c) => c.info.isCreature); for (const c of cs) { this.removeFrom(q.gy, c); c.zone = 'exile'; q.exile.push(c); } return [q, cs]; });
          for (const q of this.alive()) for (const c of q.bf.filter((x) => x.info.isCreature)) this.destroy(c, 'sacrificed', true);
          for (const [q, cs] of sets) for (const c of cs) { if (q.lost || c.zone !== 'exile') continue; this.removeFrom(q.exile, c); this.enterBattlefield(c, q, { quiet: true }); }
          this.emit('wipe', `${name}: every creature on the battlefield dies, and every creature in a graveyard comes back.`, { seat: p.seat, cards: sets.flatMap(([, cs]) => cs.map((c) => c.id)) });
          break;
        }
        case 'victimize': {
          const fod = p.bf.filter((c) => c.info.isCreature && !c.isCommander).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0];
          const back = p.gy.filter((c) => c.info.isCreature).sort((a, b) => this.gyCreatureValue(b) - this.gyCreatureValue(a)).slice(0, 2);
          if (!fod || !back.length) break;
          this.destroy(fod, 'sacrificed', true);
          for (const c of back) { if (c.zone !== 'gy') continue; this.removeFrom(p.gy, c); this.enterBattlefield(c, p, { quiet: true, tapped: true }); }
          this.emit('reanimate', `${name}: ${p.name} sacrifices ${fod.info.name} and returns ${this.listNames(back.map((c) => c.info.name))} tapped.`, { seat: p.seat, cards: back.map((c) => c.id) });
          break;
        }
        case 'reanimateType': {
          const c = p.gy.filter((x) => x.info.types.has(fx.what)).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (c) { this.removeFrom(p.gy, c); this.enterBattlefield(c, p); this.emit('reanimate', `${name} returns ${c.info.name}.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'pump': {
          // keyword-only pumps go to a creature that doesn't already have the keyword
          const pool = p.bf.filter((c) => c.info.isCreature && (!fx.another || c !== src) && (fx.p || fx.t || !fx.kw.length || fx.kw.some((k) => !this.hasKw(c, k))));
          const t = pool.filter((c) => this.canAttack(c)).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0] || pool.sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
          if (!t) break;
          t.eot.p += fx.p; t.eot.t += fx.t; t.eot.kw.push(...fx.kw);
          if (fx.counterIfTribe && this.isType(t, fx.counterIfTribe)) t.p1 += this.counterAmount(p, 1);
          if (!quiet) this.emit('effect', `${name}: ${t.info.name} gets ${fx.p || fx.t ? `+${fx.p}/+${fx.t}` : ''}${fx.kw.length ? (fx.p || fx.t ? ' and ' : '') + fx.kw.join(', ') : ''} this turn.`, { seat: p.seat, cards: [t.id] });
          break;
        }
        case 'pumpSelf': if (src && src.zone === 'bf') { src.eot.p += fx.p; src.eot.t += fx.t; src.eot.kw.push(...fx.kw); } break;
        case 'noBlock': { const t = this.bestOppTarget(p, (c) => c.info.isCreature && !c.tapped && this.targetable(c, p)); if (t) { t.noBlock = true; this.emit('effect', `${name}: ${t.info.name} can't block this turn.`, { seat: p.seat, cards: [t.id] }); } break; }
        case 'tapBlocker': { const t = this.bestOppTarget(p, (c) => c.info.isCreature && !c.tapped && this.targetable(c, p)); if (t) { t.tapped = true; this.emit('effect', `${name} taps ${t.info.name}.`, { seat: p.seat, cards: [t.id] }); } break; }
        case 'untapLands': { for (const c of p.bf) if (c.info.isLand) c.tapped = false; if (!quiet) this.emit('effect', `${name}: ${p.name} untaps all lands.`, { seat: p.seat }); break; }
        case 'untapLandsN': p.endUntap = (p.endUntap || 0) + fx.n; break; // Teferi, Hero of Dominaria: at the beginning of the next end step (see endStepDelayed)
        case 'regrowLands': {
          const lands = p.gy.filter((c) => c.info.isLand).slice(0, fx.n);
          for (const c of lands) { this.removeFrom(p.gy, c); c.zone = 'hand'; p.hand.push(c); }
          if (lands.length) this.emit('effect', `${name}: ${p.name} returns ${lands.length} land${lands.length > 1 ? 's' : ''} to hand.`, { seat: p.seat });
          break;
        }
        case 'regrowTop': {
          const c = p.gy.filter((x) => x.info.types.has(cap(fx.what))).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (c) { this.removeFrom(p.gy, c); c.zone = 'library'; p.library.unshift(c); this.emit('effect', `${name} puts ${c.info.name} on top of ${p.name}'s library.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'food': this.addToken(p, { artifactToken: 'Food' }, 1, true); break;
        case 'clue': this.addToken(p, { artifactToken: 'Clue' }, 1, true); break;
        case 'blood': this.addToken(p, { artifactToken: 'Blood' }, 1, true); break;
        case 'graveHate': {
          const tgt = this.opps(p).sort((a, b) => this.gyThreat(b) - this.gyThreat(a))[0];
          if (tgt && tgt.gy.length) { const n = tgt.gy.length; for (const c of tgt.gy) { c.zone = 'exile'; tgt.exile.push(c); } tgt.gy = []; this.emit('effect', `${name} exiles ${tgt.name}'s graveyard (${n} cards).`, { seat: p.seat, target: tgt.seat }); }
          break;
        }
        case 'doubleCounters': {
          let n = 0;
          for (const c of p.bf) { if (c.p1 > 0) { c.p1 += this.counterAmount(p, c.p1, 'p1'); n++; } if (c.info.isPW && c.loyalty > 0) { c.loyalty += this.counterAmount(p, c.loyalty, 'loyalty'); n++; } if (c.charge) { c.charge += this.counterAmount(p, c.charge, 'charge'); n++; } }
          if (n) this.emit('effect', `${name} doubles the counters on ${n} of ${p.name}'s permanents.`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'landDestroy': {
          const t = this.bestOppTarget(p, (c) => c.info.isLand && !c.info.types.has('Basic')) || this.opps(p).flatMap((q) => q.bf).filter((c) => c.info.isLand).sort((a, b) => this.landValue(this.P(b.ctrl), b) - this.landValue(this.P(a.ctrl), a))[0];
          if (t) { this.destroy(t); this.emit('removal', `${name} destroys ${this.P(t.ctrl).name}'s ${t.info.name}.`, { seat: p.seat, cards: [t.id] }); }
          break;
        }
        case 'homeward': {
          for (const q of this.players) for (const c of [...q.bf]) if (c.owner !== c.ctrl && c.info.isCreature) { const o = this.P(c.owner); this.removeFrom(q.bf, c); c.ctrl = o.seat; o.bf.push(c); }
          this.emit('effect', `${name}: everyone takes back the creatures they own.`, { seat: p.seat });
          break;
        }
        case 'fog': this.fogTurn = this.turn; this.emit('response', `${name}: all combat damage this turn is prevented.`, { seat: p.seat }); break;
        case 'impulse': { if (fx.ifCommander && !p.bf.some((c) => c.isCommander)) break; const top = p.library.splice(0, fx.n); for (const c of top) { c.zone = 'hand'; c.impulseTurn = this.turn; p.hand.push(c); } this.emit('draw', `${name}: ${p.name} exiles the top ${top.length} and may play them this turn.`, { seat: p.seat }); break; }
        case 'jeska': { const n = Math.max(0, ...this.opps(p).map((q) => q.hand.length)); this.addFloating(p, 'R', n); this.emit('effect', `${name} adds ${n} red mana.`, { seat: p.seat }); break; }
        case 'emblem': {
          if (fx.e === 'garruk') { const q = this.opps(p).sort((a, b) => b.life - a.life)[0]; if (q) { q.emblems = (q.emblems || []).concat('garruk'); } }
          else p.emblems = (p.emblems || []).concat(fx.e);
          this.emit('effect', `${p.name} gets an emblem from ${name}.`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
        case 'archfiend': { for (const o of this.opps(p)) if (o.lostTurn === this.turn && o.lostThis > 0) { const n = o.lostThis; this.loseLife(o, n, src); this.emit('drain', `Archfiend of Despair: ${o.name} loses another ${n}.`, { seat: p.seat, target: o.seat }); } this.checkState(); break; }
        case 'revealUntil': {
          let n = 0, hit = null;
          const size = p.library.length; // reveal each card once: with no artifact left this used to cycle the library forever
          while (n < size) { const c = p.library.shift(); n++; if (c.info.types.has('Artifact') && !c.info.isLand) { hit = c; break; } c.zone = 'library'; p.library.push(c); }
          if (hit) { this.enterBattlefield(hit, p); this.emit('tutor', `${name} reveals ${n} cards and puts ${hit.info.name} onto the battlefield.`, { seat: p.seat, cards: [hit.id] }); }
          if (fx.selfDamage) this.loseLife(p, n);
          break;
        }
        case 'balefire': {
          const q = this._combatDefender; const n = this._combatDealt || 0;
          if (q && n) { for (const c of [...q.bf]) if (c.info.isCreature) this.permDmg(c, this.scaleDamage(p.seat, q.seat, n)); this.emit('wipe', `${name} deals ${n} damage to each creature ${q.name} controls!`, { seat: p.seat, cards: src ? [src.id] : [], target: q.seat }); this.checkState(); }
          break;
        }
        case 'squirrelKill': {
          const sq = p.bf.filter((c) => c.token && this.isType(c, 'Squirrel'));
          const t = this.bestOppTarget(p, (c) => c.info.isCreature && this.targetable(c, p) && this.toughness(c) <= sq.length && this.creatureValue(c) >= 6);
          if (!t) break;
          const need = this.toughness(t);
          for (const c of sq.slice(0, need)) this.destroy(c, 'sacrificed', true);
          t.eot.t -= need; this.checkState();
          this.emit('removal', `${p.name} sacrifices ${need} Squirrels to kill ${t.info.name}.`, { seat: p.seat, cards: [t.id] });
          break;
        }
        case 'defenseOfHeart': {
          if (!this.opps(p).some((q) => q.bf.filter((c) => c.info.isCreature).length >= 3) || !src || src.zone !== 'bf') break;
          this.destroy(src, 'sacrificed', true);
          this.resolveEffect(p, { k: 'search', n: 2, what: 'creature', dest: 'bf' }, src, 0, false);
          break;
        }
        case 'sacCreatureOrSelf': {
          const c = p.bf.filter((x) => x.info.isCreature).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0];
          if (c && (c.token || this.creatureValue(c) < 6)) this.destroy(c, 'sacrificed', true); else if (src) this.destroy(src, 'sacrificed', true);
          break;
        }
        case 'feldon': {
          const c = p.gy.filter((x) => x.info.isCreature).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
          if (!c) break;
          const t = this.makeToken(p, { p: c.info.power, t: c.info.toughness, sub: 'copy' }); t.info = Object.assign(Object.create(Object.getPrototypeOf(c.info)), c.info, { types: new Set([...c.info.types, 'Artifact']) }); t.name = c.info.name; t.ctrl = p.seat; t.eotSac = true; t.eot.kw.push('haste');
          p.bf.push(t); this.creatureEntered(p, t);
          if (t.info.etb.length) this.resolveEffects(p, t.info.etb, t, null, false);
          this.emit('token', `${name} makes a hasty token copy of ${c.info.name}.`, { seat: p.seat, cards: [t.id] });
          break;
        }
        case 'osgir': {
          const zirda = this.statics(p, 'reduceAbilities').reduce((a, x) => a + x.s.n, 0);
          const costOf = (x) => Math.max(x.info.mv ? 1 : 0, x.info.mv - zirda); // Zirda: abilities cost {2} less (not below one mana)
          const avail = p.infMana === this.turn ? 99 : this.availableMana(p);
          const val = (x) => Math.max(this.scoreCast(p, x, 'hand'), this.permValue({ ...x, p1: 0, dmg: 0, eot: { p: 0, t: 0, kw: [] }, ctrl: p.seat, zone: 'bf' }) * 2, this.cardValue(p, x)) * this.osgirKeep(p, x);
          const c = p.gy.filter((x) => x.info.types.has('Artifact') && costOf(x) <= avail && x.info.isPermanent && !x.info.cost.x).sort((a, b) => val(b) - val(a))[0];
          if (!c) break;
          if (costOf(c)) this.pay(p, parseCost(String(costOf(c))), 0, true);
          this.removeFrom(p.gy, c); c.zone = 'exile'; p.exile.push(c);
          // counted once and capped like any token effect: a copied token doubler doubled the count on every pass (hung training)
          const n = Math.min(2 * this.tokenMult(p), Math.max(0, 80 - p.bf.filter((x) => x.token).length));
          for (let i = 0; i < n; i++) {
            const t = this.makeToken(p, { sub: 'copy' }); t.info = c.info; t.name = c.info.name; t.copiedFrom = null;
            this.enterBattlefield(t, p, { quiet: true });
          }
          this.checkState();
          this.emit('token', `Osgir exiles ${c.info.name} and makes two token copies of it.`, { seat: p.seat, cards: [c.id] });
          break;
        }
        case 'reanimateArtifact': {
          const c = p.gy.filter((x) => x.info.types.has('Artifact') && x.info.mv <= fx.mvMax).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (c) { this.removeFrom(p.gy, c); this.enterBattlefield(c, p); this.emit('reanimate', `${name} returns ${c.info.name}.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'weld': {
          const best = p.gy.filter((x) => x.info.types.has('Artifact') && x.info.isPermanent).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          const worst = p.bf.filter((x) => x.info.types.has('Artifact') && x !== src).sort((a, b) => this.permValue(a) - this.permValue(b))[0];
          if (!best || !worst || this.cardValue(p, best) <= this.permValue(worst) + 1) break;
          this.destroy(worst, 'sacrificed', true); this.removeFrom(p.gy, best); this.enterBattlefield(best, p);
          this.emit('reanimate', `Goblin Welder swaps ${worst.info.name} for ${best.info.name}.`, { seat: p.seat, cards: [best.id] });
          break;
        }
        case 'winIfArtifacts': if (p.bf.filter((c) => c.info.types.has('Artifact')).length >= fx.n) { this.emit('combo', `${name}: ${p.name} controls ${fx.n}+ artifacts and wins the game!`, { seat: p.seat }); for (const q of this.opps(p)) q.life = 0; this.checkState(); } break;
        case 'fateseal': { const q = this.opps(p).sort((a, b) => this.playerThreat(b) - this.playerThreat(a))[0]; if (q && q.library.length && !q.library[0].info.isLand && this.cardValue(q, q.library[0]) > 4) { q.library.push(q.library.shift()); } break; }
        case 'exileLibrary': { const q = this.opps(p).sort((a, b) => this.playerThreat(b) - this.playerThreat(a))[0]; if (q) { for (const c of q.library) { c.zone = 'exile'; q.exile.push(c); } q.library = q.hand.map((c) => ((c.zone = 'library'), c)); q.hand = []; this.R.shuffle(q.library); this.emit('combo', `${name}: ${q.name}'s library is exiled!`, { seat: p.seat, target: q.seat }); } break; }
        case 'junji': {
          const target = this.alive().flatMap((q) => q.gy).filter((c) => c.info.isCreature && !this.isType(c, 'Dragon')).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
          if (target && this.creatureValue(target) > 8) { this.removeFrom(this.P(target.owner).gy, target); this.enterBattlefield(target, p); this.loseLife(p, 2); this.emit('reanimate', `Junji puts ${target.info.name} onto the battlefield.`, { seat: p.seat, cards: [target.id] }); }
          else { for (const q of this.opps(p)) { this.discardWorst(q, 2); this.loseLife(q, 2, src); } this.emit('drain', `Junji: each opponent discards two cards and loses 2 life.`, { seat: p.seat }); this.checkState(); }
          break;
        }
        case 'animateArtifact': {
          const piece = (x) => COMBOS.some((cb) => cb.pieces.some((alts) => alts.includes(x.info.name)));
          const c = p.bf.filter((x) => x.info.types.has('Artifact') && !x.info.isCreature && !x.info.isLand && x.info.mv >= 3 && !piece(x)).sort((a, b) => (this.hasKw(b, 'indestructible') ? 10 : 0) + (b.tapped ? -6 : 0) + b.info.mv - (this.hasKw(a, 'indestructible') ? 10 : 0) - (a.tapped ? -6 : 0) - a.info.mv)[0];
          if (c) { this.setInfo(c, { isCreature: true, power: c.info.mv, toughness: c.info.mv, types: new Set([...c.info.types, 'Creature']) }); c.animatedUntilTurnOf = p.seat; c.sick = false; this.emit('effect', `Karn animates ${c.info.name} into a ${c.info.mv}/${c.info.mv}.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'uginPlus': {
          const top = p.library.shift(); if (top) { top.zone = 'exile'; top.faceDown = true; p.exile.push(top); }
          const [id] = this.addToken(p, { p: 2, t: 2, sub: 'Spirit', colors: 'colorless' }, 1, false);
          if (top && id != null) this.cards[id].uginCard = top.id;
          break;
        }
        case 'wish': { const c = p.exile.filter((x) => x.info.types.has('Artifact') && !x.faceDown && x.owner === p.seat).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0]; if (c) { this.removeFrom(p.exile, c); c.zone = 'hand'; p.hand.push(c); this.emit('tutor', `${name} returns ${c.info.name} from exile to hand.`, { seat: p.seat, cards: [c.id] }); } break; }
        case 'conniveAttacker': { // Raffine: the attacker that gains most from counters (evasive, or unblockable through Herald)
          const atk = (this._attackersNow || []).filter((c) => c.zone === 'bf');
          if (!atk.length) break;
          const t = atk.slice().sort((x, y) => (this.hasKw(y, 'flying') || this.has(p, 'counterUnblockable') ? 3 : 0) + this.power(y) * 0.1 - ((this.hasKw(x, 'flying') || this.has(p, 'counterUnblockable') ? 3 : 0) + this.power(x) * 0.1))[0];
          this.connive(p, t, atk.length);
          break;
        }
        case 'kwSelf': if (src && src.zone === 'bf') src.eot.kw.push(fx.kw); break;
        case 'energy': p.energy = (p.energy || 0) + (X(fx.n) || 1); break;
        case 'guideAngel': { // pay three energy: two +1/+1 counters and a flying counter on an attacker
          const atk = (this._attackersNow || []).filter((c) => c.zone === 'bf' && !this.hasKw(c, 'flying'));
          if ((p.energy || 0) < 3 || !atk.length) break;
          const t = atk.sort((a, b) => this.power(b) - this.power(a))[0];
          p.energy -= 3; t.p1 += this.counterAmount(p, 2); t.flyingCounter = true;
          this.emit('effect', `${name}: ${p.name} pays three energy; ${t.info.name} gets two +1/+1 counters and a flying counter.`, { seat: p.seat, cards: [t.id] });
          break;
        }
        case 'countersKw': for (const c of p.bf) if (c.info.isCreature && c.p1 > 0) c.eot.kw.push(fx.kw); if (!quiet) this.emit('effect', `${name}: creatures with counters gain ${fx.kw}.`, { seat: p.seat }); break;
        case 'millOpp': { const q = this.opps(p).sort((a, b) => a.library.length - b.library.length)[0]; const n = X(fx.n); if (q && n > 0) { this.mill(q, n); this.emit('effect', `${name}: ${q.name} mills ${n}.`, { seat: p.seat, target: q.seat }); } break; }
        case 'untapLandsUpTo': { const ls = p.bf.filter((c) => c.info.isLand && c.tapped).sort((a, b) => this.landValue(p, b) - this.landValue(p, a)).slice(0, fx.n); for (const c of ls) c.tapped = false; if (ls.length && !quiet) this.emit('effect', `${name}: ${p.name} untaps ${ls.length} land${ls.length > 1 ? 's' : ''}.`, { seat: p.seat }); break; }
        case 'neutralize': { const t = this.bestOppTarget(p, (c) => !c.info.isLand && this.targetable(c, p)); if (t) { t.neutralized = fx.short ? this.turn + this.alive().length : this.turn + 99; t.neutralizedBy = p.seat; this.emit('effect', `${name}: ${t.info.name} can't deal or be dealt damage until ${p.name}'s next turn.`, { seat: p.seat, cards: [t.id] }); } break; }
        case 'ebonLegion': { if (src && src.zone === 'bf' && this.players.some((q) => q.lostTurn === this.turn && q.lostThis >= 4)) src.p1 += this.counterAmount(p, 1); break; }
        case 'piles': {
          const q = this.opps(p).sort((a, b) => this.playerThreat(b) - this.playerThreat(a))[0]; if (!q) break;
          const perms = q.bf.slice().sort((a, b) => this.permValue(b) - this.permValue(a));
          const pileA = [], pileB = []; let va = 0, vb = 0;
          for (const c of perms) { if (va <= vb) { pileA.push(c); va += this.permValue(c); } else { pileB.push(c); vb += this.permValue(c); } }
          const sac = va < vb ? pileA : pileB;
          this.emit('removal', `${name}: ${q.name} splits their permanents into piles and sacrifices ${this.listNames(sac.map((c) => this.cname(c)), 8)}.`, { seat: p.seat, target: q.seat, cards: sac.map((c) => c.id) });
          { const b = this.beginDeathBatch(); for (const c of sac) this.destroy(c, 'sacrificed', true); this.endDeathBatch(b); }
          break;
        }
        case 'liliana9': {
          for (const q of this.opps(p)) { const keep = new Set(); for (const t of ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker']) { const c = q.bf.filter((x) => x.info.types.has(t)).sort((a, b) => this.permValue(b) - this.permValue(a))[0]; if (c) keep.add(c); } for (const c of [...q.bf]) if (!keep.has(c)) this.destroy(c, 'sacrificed', true); }
          this.emit('wipe', `${name}: each opponent keeps one permanent of each type and sacrifices the rest!`, { seat: p.seat });
          break;
        }
        case 'lordOfVoid': {
          const q = this._combatDefender; if (!q) break;
          const top = q.library.splice(0, 7);
          const cr = top.filter((c) => c.info.isCreature).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
          for (const c of top) { if (c === cr) continue; c.zone = 'exile'; q.exile.push(c); }
          if (cr) { this.enterBattlefield(cr, p); this.emit('reanimate', `Lord of the Void steals ${cr.info.name} off the top of ${q.name}'s library.`, { seat: p.seat, cards: [cr.id] }); }
          break;
        }
        case 'pullFromEternity': { const c = p.exile.filter((x) => x.info.isCreature).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0]; if (c) { this.removeFrom(p.exile, c); this.toGraveyard(c); } break; }
        case 'cheatCreature': {
          const c = p.hand.filter((x) => x.info.isCreature && (!fx.tribe || this.isType(x, fx.tribe))).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
          if (c) { this.removeFrom(p.hand, c); this.enterBattlefield(c, p); this.emit('cast', `${name} puts ${c.info.name} onto the battlefield.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'wildspeaker': {
          const ready = p.bf.filter((c) => c.info.isCreature && !c.sick && !c.tapped).length;
          if (ready >= 3) this.resolveEffect(p, { k: 'overrun', p: 3, t: 3, kw: [], notSub: 'Human' }, src, 0, false);
          else { const n = Math.max(0, ...p.bf.filter((c) => c.info.isCreature && !this.isType(c, 'Human')).map((c) => this.power(c))); this.draw(p, n); this.emit('draw', `${name}: ${p.name} draws ${n}.`, { seat: p.seat }); }
          break;
        }
        case 'silence': for (const q of this.opps(p)) q.silencedTurn = this.turn; this.emit('effect', `${name}: opponents can't cast spells this turn.`, { seat: p.seat }); break;
        case 'mindslaver': { const q = this.opps(p).sort((a, b) => this.playerThreat(b) - this.playerThreat(a))[0]; if (q) { q.skipNext = true; this.emit('effect', `${name}: ${p.name} will control ${q.name}'s next turn.`, { seat: p.seat, target: q.seat }); } break; }
        case 'sorinSac': {
          const v = p.bf.filter((c) => c.info.isCreature && this.isType(c, 'Vampire') && (c.token || this.creatureValue(c) < 5))[0];
          if (!v) break;
          this.destroy(v, 'sacrificed', true); this.gainLife(p, 3); this.dealDamageAny(p, 3, src);
          break;
        }
        case 'gitrogUpkeep': {
          const land = p.bf.filter((c) => c.info.isLand).sort((a, b) => this.landValue(p, a) - this.landValue(p, b))[0];
          if (land && p.bf.filter((c) => c.info.isLand).length > 3) this.destroy(land, 'sacrificed', true); else if (src) this.destroy(src, 'sacrificed', true);
          break;
        }
        case 'oathFlicker': {
          // Oath of Teferi: exile another permanent you control; it returns at the next end step. A worn-down planeswalker comes back with
          // its full (doubled) loyalty; otherwise something with an enter trigger
          const gain = (x) => (x.info.isPW ? this.counterAmount(p, x.info.loyalty || 3, 'loyalty') - x.loyalty - (x.usedTurn === this.turn ? 0 : 2) : x.info.etb.length && !x.info.isLand ? this.permValue(x) / 3 : -1);
          const c = p.bf.filter((x) => x !== src && !x.token && !x.isCommander && !x.info.isLand).sort((a, b) => gain(b) - gain(a))[0];
          if (!c || gain(c) <= 0) break;
          this.exileCard(c); if (c.zone === 'exile') { (p.oathReturn = p.oathReturn || []).push(c); this.emit('effect', `${name} exiles ${c.info.name} until the end step.`, { seat: p.seat, cards: [c.id] }); }
          break;
        }
        case 'flickerOwn': {
          const c = p.bf.filter((x) => x !== src && !x.info.isLand && !x.token && x.info.etb.length).sort((a, b) => this.permValue(b) - this.permValue(a))[0];
          if (c) { this.exileCard(c); if (c.zone === 'exile') { this.removeFrom(this.P(c.owner).exile, c); this.enterBattlefield(c, this.P(c.owner)); this.emit('effect', `${name} flickers ${c.info.name}.`, { seat: p.seat, cards: [c.id] }); } }
          break;
        }
        case 'castVoid': {
          const c = this.players.flatMap((q) => q.exile).filter((x) => x.voidBy === p.seat && x.owner !== p.seat && !x.info.isLand).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0];
          if (!c) break;
          this.removeFrom(this.P(c.owner).exile, c);
          this.freeCast(p, c, `${name}: ${p.name} casts ${c.info.name} for free`);
          break;
        }
        case 'gixExile': {
          const x = Math.max(0, p.hand.length - 1);
          const q = this.opps(p).sort((a, b) => b.library.length - a.library.length)[0]; if (!q || !x) break;
          this.discardWorst(p, x);
          const top = q.library.splice(0, x);
          let n = 0;
          for (const c of top) { if (!c.info.isLand && !c.info.cost.x && (c.info.isPermanent || c.info.spell.length)) { this.freeCast(p, c, `Gix: ${p.name} casts ${c.info.name} from ${q.name}'s library for free`); n++; } else { c.zone = 'exile'; q.exile.push(c); } }
          this.emit('combo', `Gix exiles the top ${x} of ${q.name}'s library and plays ${n} of them for free.`, { seat: p.seat, target: q.seat });
          break;
        }
        case 'millPower': {
          // target player: an opponent close to decking, otherwise ourselves when the graveyard is our engine
          const n = this._sacPower || 0; if (!n) break;
          const q = this.opps(p).filter((o) => o.library.length <= n + 2).sort((a, b) => a.library.length - b.library.length)[0] || (this.gyHated(p) ? this.opps(p)[0] : p) || p;
          const m = this.mill(q, n); this.emit('effect', `${name}: ${q.name} mills ${m.length}.`, { seat: p.seat, target: q.seat });
          break;
        }
        case 'removalN': { const n = Math.min(X(fx.n) || 0, this.opps(p).reduce((a2, q) => a2 + q.bf.length, 0)); for (let i = 0; i < n; i++) this.resolveEffect(p, { k: 'removal', what: fx.what }, src, 0, quiet); break; }
        case 'extraLandNow': p.landsPlayed = Math.max(0, p.landsPlayed - 1); p.extraLandsGranted = (p.extraLandsTurn === this.turn ? p.extraLandsGranted || 0 : 0) + 1; p.extraLandsTurn = this.turn; break;
        case 'putFromHand': { const put = p.hand.filter((c) => c.info.isPermanent && !c.info.isLand).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a)).slice(0, fx.n); for (const c of put) { if (c.zone !== 'hand' || !p.hand.includes(c)) continue; this.removeFrom(p.hand, c); this.enterBattlefield(c, p, { quiet: true }); } /* (one entering can make us discard another: Quicksmith Genius) */ if (put.length) this.emit('cast', `${name}: ${p.name} puts ${put.length} permanents onto the battlefield.`, { seat: p.seat, cards: put.map((c) => c.id) }); break; }
        case 'ragavan': { const q = this._combatDefender; if (q && q.library.length) { const c = q.library.shift(); c.ctrl = p.seat; c.zone = 'hand'; c.impulseTurn = this.turn; c.stolenFrom = q.seat; p.hand.push(c); this.emit('effect', `Ragavan exiles ${c.info.name} from ${q.name}'s library; ${p.name} may cast it this turn.`, { seat: p.seat, cards: [c.id] }); } break; }
        case 'vraskaShield': if (src) src.vraskaShield = p.seat; break;
        case 'coffin': if (src && src.zone === 'bf') { src.charge = (src.charge || 0) + 1; if (src.charge >= 3) { src.charge = 0; this.transform(src); } } break;
        case 'exchange': {
          const give = fx.self ? src : p.bf.filter((c) => (c.info.isCreature || c.info.types.has('Artifact')) && !c.info.isLand && !c.isCommander).sort((a, b) => this.permValue(a) - this.permValue(b))[0];
          const tgt = this.bestOppTarget(p, (c) => c.info.isCreature && this.targetable(c, p) && (!fx.pmax || this.power(c) <= fx.pmax));
          if (!give || give.zone !== 'bf' || !tgt || (!fx.self && this.permValue(give) >= this.permValue(tgt))) {
            if (fx.self && src && src.zone === 'bf') { this.destroy(src, 'sacrificed', true); this.emit('effect', `${name} finds nothing to swap and is sacrificed.`, { seat: p.seat }); }
            break;
          }
          const q = this.P(tgt.ctrl);
          this.removeFrom(q.bf, tgt); this.removeFrom(p.bf, give);
          tgt.ctrl = p.seat; tgt.sick = true; p.bf.push(tgt);
          give.ctrl = q.seat; give.sick = true; q.bf.push(give);
          for (const pl of this.players) for (const a of pl.bf) if (a.attached === tgt.id || a.attached === give.id) if (a.info.isEquipment) a.attached = null;
          this.emit('removal', `${name}: ${p.name} swaps ${give.info.name} for ${q.name}'s ${tgt.info.name}.`, { seat: p.seat, cards: [tgt.id, give.id], target: q.seat });
          break;
        }
        case 'elk': {
          const tgt = this.bestOppTarget(p, (c) => (c.info.isCreature || c.info.types.has('Artifact')) && !c.info.isLand && this.targetable(c, p) && this.permValue(c) > 6);
          if (!tgt) break;
          const old = tgt.info.name;
          tgt.info = Object.assign(Object.create(Object.getPrototypeOf(tgt.info)), tgt.info, { name: 'Elk (' + old + ')', isCreature: true, types: new Set(['Creature']), subtypes: ['Elk'], power: 3, toughness: 3, kw: new Set(), etb: [], dies: [], attack: [], combatDmg: [], upkeep: [], endstep: [], castTrig: [], deathWatch: [], statics: [], activated: [], loyaltyAbs: [], triggers: [], mana: null, sacOutlet: null, text: 'A 3/3 green Elk with no abilities.', face: null, tokenColors: 'green', isPW: false });
          tgt.p1 = 0;
          this.emit('removal', `${name} turns ${this.P(tgt.ctrl).name}'s ${old} into a 3/3 Elk.`, { seat: p.seat, cards: [tgt.id], target: tgt.ctrl });
          break;
        }
        case 'stealArtifacts': {
          const q = this._combatDefender; if (!q) break;
          const arts = q.bf.filter((c) => c.info.types.has('Artifact'));
          for (const c of arts) { this.removeFrom(q.bf, c); c.ctrl = p.seat; c.attached = null; p.bf.push(c); }
          if (arts.length) this.emit('removal', `${name} steals ${arts.length} artifacts from ${q.name}.`, { seat: p.seat, cards: arts.map((c) => c.id), target: q.seat });
          break;
        }
        case 'extraCombat': {
          // Aurelia / Scourge: the first time it attacks each turn. Bloodthirster: each time it deals combat damage to a player.
          if (fx.dethrone) { const q = this._attackTarget; if (!q || q.life < Math.max(...this.alive().map((x) => x.life))) break; }
          if (src && !fx.newTarget) { if (src.extraCombatTurn === this.turn) break; src.extraCombatTurn = this.turn; }
          (this._extraCombats = this._extraCombats || []).push({ fx, src });
          break;
        }
        case 'hermit': {
          const milled = [];
          while (p.library.length) { const c = p.library.shift(); if (c.info.isLand && c.info.types.has('Basic')) { c.zone = 'hand'; p.hand.push(c); break; } this.toGraveyard(c); milled.push(c); }
          this.emit('effect', `${name} mills ${milled.length} cards into ${p.name}'s graveyard.`, { seat: p.seat, cards: src ? [src.id] : [] });
          break;
        }
      }
    }

    doWipe(p, fx, src, xVal) {
      const name = src ? src.info.name : '';
      if (fx.what === 'farewell') fx = { ...fx, modes: this.farewellModes(p) };
      if (fx.what === 'deluge') { xVal = this.delugeX(p); this.loseLife(p, xVal); }
      if (fx.what === 'ugin') xVal = src ? src.uginX || 4 : 4;
      const victims = [], hits = [];
      const prot = new Set();
      if (fx.what !== 'lands' && fx.what !== 'big') for (const q of this.alive()) if (!prot.has(q.seat)) this.sacBeforeWipe(q);
      if (!fx.exile && ['creatures', 'farewell', 'nonland', 'damage', 'ugin', 'mv2', 'big'].includes(fx.what)) for (const q of this.alive()) this.tokenShield(q);
      for (const q of this.alive()) if (q !== p && this.tryProtect(q, q.bf.filter((c) => c.info.isCreature || fx.what === 'nonland'), p, true)) prot.add(q.seat);
      for (const q of this.alive()) {
        if (q.protectedUntil >= this.turn) continue; // Teferi's Protection: phased out
        for (const c of [...q.bf]) {
          let hit = false;
          if (fx.what === 'creatures') hit = c.info.isCreature && !(fx.spare && this.isType(c, fx.spare));
          else if (fx.what === 'farewell') hit = (c.info.isCreature && fx.modes.creatures) || (!c.info.isLand && ((c.info.types.has('Artifact') && fx.modes.artifacts) || (c.info.types.has('Enchantment') && fx.modes.enchantments)));
          else if (fx.what === 'nonland') hit = !c.info.isLand && !c.info.isPW;
          else if (fx.what === 'big') hit = c.info.isCreature && this.power(c) >= 4;
          else if (fx.what === 'lands') hit = c.info.isLand;
          else if (fx.what === 'minusX' || fx.what === 'deluge') { if (c.info.isCreature) { c.eot.p -= xVal; c.eot.t -= xVal; } continue; }
          else if (fx.what === 'tribalMinus') { if (c.info.isCreature && !this.isType(c, fx.tribe)) { const n = p.bf.filter((x) => x.info.isCreature && this.isType(x, fx.tribe)).length; c.eot.p -= n; c.eot.t -= n; } continue; }
          else if (fx.what === 'ugin') hit = !c.info.isLand && c.info.colors && c.info.colors.size > 0 && c.info.mv <= xVal && c !== src;
          else if (fx.what === 'mv2') hit = !c.info.isLand && c.info.mv <= 2;
          else if (fx.what === 'damage') { if (c.info.isCreature) this.permDmg(c, fx.n); continue; }
          if (!hit) continue;
          hits.push(c);
        }
      }
      // announce what goes (and what survives), then remove it, so the dies triggers come after in the log
      if (hits.length) {
        const surv = fx.exile ? [] : hits.filter((c) => this.hasKw(c, 'indestructible') || c.indestructibleEOT);
        const by = this.players.map((q) => [q, hits.filter((c) => c.ctrl === q.seat && !surv.includes(c))]).filter(([, l]) => l.length);
        const desc = by.map(([q, l]) => `${q.name}'s ${this.listNames(l.map((c) => this.cname(c)), 5)}`).join('; ');
        this.emit('wipe', `${name || 'A wipe'} ${fx.exile ? 'exiles' : 'destroys'} ${hits.length - surv.length} permanent${hits.length - surv.length === 1 ? '' : 's'}: ${desc || 'nothing'}${surv.length ? ` (${this.listNames(surv.map((c) => c.info.name))} survive${surv.length === 1 ? 's' : ''})` : ''}.`, { seat: p.seat, cards: (src ? [src.id] : []).concat(hits.map((c) => c.id)) });
      }
      const batch = this.beginDeathBatch();
      for (const c of hits) {
        if (c.zone !== 'bf') continue;
        if (fx.exile) { this.exileCard(c); victims.push(c); }
        else if (this.destroy(c)) victims.push(c);
      }
      this.endDeathBatch(batch);
      if (fx.what === 'farewell' && fx.modes.graveyards) { for (const q of this.alive()) { for (const c of q.gy) { c.zone = 'exile'; q.exile.push(c); } q.gy = []; } }
      if (fx.what === 'mv2' && fx.addMana) p.pool = (p.pool || 0) + victims.length;
      if (fx.what === 'minusX' || fx.what === 'damage' || fx.what === 'deluge' || fx.what === 'tribalMinus') { const doomed = this.allBf().filter((c) => c.info.isCreature && (this.toughness(c) <= 0 || (c.dmg >= this.toughness(c) && !this.hasKw(c, 'indestructible') && !c.indestructibleEOT))); this.emit('wipe', `${name} sweeps the board${fx.what === 'damage' ? ` (${fx.n} damage to each creature)` : xVal ? ` (-${xVal}/-${xVal})` : ''}: ${doomed.length ? this.listNames(doomed.map((c) => this.cname(c)), 8) + ' die' + (doomed.length === 1 ? 's' : '') : 'nothing dies'}.`, { seat: p.seat, cards: (src ? [src.id] : []).concat(doomed.map((c) => c.id)) }); this.checkState(); return; }
      this.credit(src, 'removed', victims.filter((c) => c.owner !== p.seat).length - victims.filter((c) => c.owner === p.seat).length * 0.5);
      if (!hits.length) this.emit('wipe', `${name || 'A wipe'} finds nothing to hit.`, { seat: p.seat, cards: src ? [src.id] : [] });
    }

    // Farewell: pick the modes that hurt opponents more than us
    // What a wipe would take, without casting it: the permanents each player loses (indestructible ones survive a destroy)
    wipeHits(p, fx, xVal) {
      if (fx.what === 'farewell') fx = { ...fx, modes: this.farewellModes(p) };
      if (fx.what === 'deluge') xVal = this.delugeX(p);
      const out = [];
      for (const q of this.alive()) {
        if (q.protectedUntil >= this.turn) continue;
        const tribeN = fx.what === 'tribalMinus' ? p.bf.filter((x) => x.info.isCreature && this.isType(x, fx.tribe)).length : 0;
        for (const c of q.bf) {
          const cr = c.info.isCreature, tough = cr ? this.toughness(c) - c.dmg : 0;
          let hit = false;
          if (fx.what === 'creatures') hit = cr && !(fx.spare && this.isType(c, fx.spare));
          else if (fx.what === 'farewell') hit = (cr && fx.modes.creatures) || (!c.info.isLand && ((c.info.types.has('Artifact') && fx.modes.artifacts) || (c.info.types.has('Enchantment') && fx.modes.enchantments)));
          else if (fx.what === 'nonland') hit = !c.info.isLand && !c.info.isPW;
          else if (fx.what === 'big') hit = cr && this.power(c) >= 4;
          else if (fx.what === 'minusX' || fx.what === 'deluge') hit = cr && tough <= xVal;
          else if (fx.what === 'tribalMinus') hit = cr && !this.isType(c, fx.tribe) && tough <= tribeN;
          else if (fx.what === 'damage') hit = cr && tough <= fx.n;
          else if (fx.what === 'ugin') hit = !c.info.isLand && c.info.colors && c.info.colors.size > 0 && c.info.mv <= (xVal || 4);
          else if (fx.what === 'mv2') hit = !c.info.isLand && c.info.mv <= 2;
          const shrug = fx.what === 'minusX' || fx.what === 'deluge' || fx.what === 'tribalMinus' ? false : !fx.exile && (this.hasKw(c, 'indestructible') || c.indestructibleEOT);
          if (hit && !shrug) out.push(c);
        }
      }
      return out;
    }
    // Is this the moment for the wipe? Weigh what each side loses. Cast it for a real trade (several of their cards, a clearly
    // bigger loss for them), or when the boards are a danger to us; otherwise hold it for when it matters.
    wipeEval(p, fx, c, from) {
      const xVal = c && c.info.cost.x ? this.maxX(p, this.costFor(p, c, from)) : 0;
      const hits = this.wipeHits(p, fx, xVal);
      const val = (x) => (x.token ? Math.min(4, this.permValue(x)) : this.permValue(x)) * (x.isCommander ? 0.6 : 1); // a commander comes back (for more tax)
      let theirs = 0, mine = 0, theirCards = 0;
      for (const x of hits) { if (x.ctrl === p.seat) mine += val(x) + (x.isCommander ? 4 : 0); else { theirs += val(x); theirCards += x.token ? 0.34 : 1; } }
      const net = theirs - mine * 1.3;
      // danger: what the opponents' creatures could swing at us, or one player running away with the game
      const opps = this.opps(p), pow = (q) => q.bf.filter((x) => x.info.isCreature && !this.pacified(x)).reduce((a, x) => a + Math.max(0, this.power(x)), 0);
      const swing = opps.reduce((a, q) => a + pow(q), 0), biggest = Math.max(0, ...opps.map(pow));
      const myBlock = p.bf.filter((x) => x.info.isCreature).length;
      const danger = biggest >= p.life * 0.6 || swing >= p.life || (biggest >= p.life * 0.4 && myBlock <= 1);
      const runaway = opps.some((q) => this.playerThreat(q) > this.playerThreat(p) + 45 && hits.some((x) => x.ctrl === q.seat));
      const cast = net > 0 && ((theirCards >= 3 && net >= 22) || (danger && net >= 6) || (runaway && net >= 15));
      return { cast, net, theirs, mine, theirCards, danger, hits };
    }
    farewellModes(p) {
      const val = (pred, q) => q.bf.filter((c) => !c.info.isLand && pred(c)).reduce((s2, c) => s2 + this.permValue(c), 0);
      const modes = {};
      for (const [k, pred] of [['creatures', (c) => c.info.isCreature], ['artifacts', (c) => c.info.types.has('Artifact')], ['enchantments', (c) => c.info.types.has('Enchantment')]]) {
        const mine = val(pred, p), theirs = Math.max(0, ...this.opps(p).map((q) => val(pred, q)));
        modes[k] = theirs > mine + 4;
      }
      modes.graveyards = this.opps(p).some((q) => this.gyThreat(q) > 20) && this.gyThreat(p) < 15;
      return modes;
    }
    delugeX(p) {
      const theirs = this.opps(p).flatMap((q) => q.bf.filter((c) => c.info.isCreature)).map((c) => this.toughness(c)).sort((a, b) => b - a);
      const x = Math.min(theirs[Math.floor(theirs.length / 4)] || 3, Math.max(1, p.life - 12), Math.max(1, Math.floor(p.life - this.lifeFloor(p) * 0.6)));
      return Math.max(1, x);
    }
    // Deflecting Swat / Redirect Lightning: send a targeted removal spell at one of the caster's own permanents
    redirectRemoval(owner, caster, tgt, src) {
      if (owner === caster || this.abolished(owner) || this.permValue(tgt) < 7) return false;
      const card = owner.hand.find((c) => c.info.redirect && ((c.info.freeIfCommander && owner.bf.some((x) => x.isCommander)) || this.pay(owner, c.info.cost)));
      if (!card) {
        // Hydroelectric Specimen: flashed in, it changes a single-target instant or sorcery's target to itself
        const sp = src && (src.info.isInstant || src.info.isSorcery) && owner.hand.find((c) => c.info.specimen && !this.briselaLock(owner, c) && this.pay(owner, c.info.cost));
        if (!sp || this.permValue(tgt) < this.permValue(sp) + 4) return false;
        this.pay(owner, sp.info.cost, 0, true); this.removeFrom(owner.hand, sp);
        this.emit('response', `${owner.name} flashes in ${sp.info.name} and changes the target to it!`, { seat: owner.seat, cards: [sp.id, tgt.id] });
        this.enterBattlefield(sp, owner, {});
        const f = (src.info.spell || []).find((x) => x.k === 'removal');
        if (f && sp.zone === 'bf') { if (f.exile) this.exileCard(sp); else if (f.bounce) this.bounce(sp); else this.destroy(sp); }
        return true;
      }
      if (!(card.info.freeIfCommander && owner.bf.some((x) => x.isCommander))) this.pay(owner, card.info.cost, 0, true);
      if (/pay 5 life or pay \{2\}/i.test(card.info.text || '')) { if (this.canPayLife(owner, 5)) this.loseLife(owner, 5); }
      this.discardCard(owner, card);
      const newT = caster.bf.filter((c) => !c.info.isLand).sort((a, b) => this.permValue(b) - this.permValue(a))[0];
      this.emit('response', `${owner.name} redirects it with ${card.info.name}${newT ? ' onto ' + caster.name + "'s " + newT.info.name : ''}!`, { seat: owner.seat, cards: [card.id].concat(newT ? [newT.id] : []) });
      if (newT && src) { const f = (src.info.spell || []).concat(src.info.etb || []).find((x) => x.k === 'removal'); if (f) { if (f.exile) this.exileCard(newT); else if (f.bounce) this.bounce(newT); else this.destroy(newT); } }
      return true;
    }
    // Mother of Runes / Giver of Runes protect a creature from a targeted spell
    runesSave(owner, tgt) {
      if (!tgt.info.isCreature || this.abolished(owner, 'ability')) return false;
      const m = owner.bf.find((c) => c.info.runes && !c.tapped && !c.sick && (!c.info.runes.another || c !== tgt));
      if (!m) return false;
      m.tapped = true;
      this.emit('response', `${m.info.name} gives ${tgt.info.name} protection; the spell fizzles.`, { seat: owner.seat, cards: [m.id, tgt.id] });
      return true;
    }
    tryProtect(q, threatened, attacker, wipe = false, force = null) {
      if (q === attacker || q.lost) return false;
      const value = threatened.reduce((s, c) => s + this.permValue(c), 0);
      if (!force && value < (wipe ? 12 : 14)) return false;
      if (this.abolished(q)) return false;
      const card = force || q.hand.find((c) => ((c.info.spell && c.info.spell.some((f) => f.k === 'protect' && (!f.single || !wipe || (c.info.kickerProtectAll && this.pay(q, { ...c.info.cost, generic: c.info.cost.generic + c.info.kickerProtectAll.generic, pips: c.info.cost.pips.concat(c.info.kickerProtectAll.pips) }))))) || c.info.modalProtect) && this.pay(q, this.costFor(q, c, 'hand')));
      if (!card) return false;
      const useAlt = !!card.info.altCost && this.altChosen(q, card, 'hand');
      if (useAlt) this.payAltCost(q, card);
      // gift a card (Dawn's Truce): promised for the indestructible half; the opponent with the fewest cards draws one
      if (card.info.gift) { const o = this.opps(q).sort((a, b) => a.hand.length - b.hand.length)[0]; if (o) { this.draw(o, 1); this.emit('effect', `${q.name} promises ${o.name} a gift: they draw a card.`, { seat: q.seat, target: o.seat }); } }
      else if (card.info.kickerProtectAll && wipe) this.pay(q, { ...card.info.cost, generic: card.info.cost.generic + card.info.kickerProtectAll.generic, pips: card.info.cost.pips.concat(card.info.kickerProtectAll.pips) }, 0, true);
      else this.pay(q, this.costFor(q, card, 'hand'), 0, true);
      this.removeFrom(q.hand, card);
      if (/exile teferi's protection|exile cardname/i.test(card.info.text || '')) { card.zone = 'exile'; q.exile.push(card); } else this.toGraveyard(card, q.seat);
      if (card.info.spell.some((f) => f.single) && !wipe) { const t = threatened[0]; if (t) this.phaseOut(t, null); this.emit('response', `${q.name} phases out ${t ? t.info.name : 'a creature'} with ${card.info.name}!`, { seat: q.seat, cards: [card.id] }); return true; }
      if (card.info.spell.some((f) => f.single) && wipe) { for (const c of q.bf.filter((x) => x.info.isCreature)) this.phaseOut(c, null); this.emit('response', `${q.name} kicks ${card.info.name} and phases out their creatures!`, { seat: q.seat, cards: [card.id] }); return true; }
      if (/phase out|protection from everything/i.test(card.info.text)) q.protectedUntil = this.turn + this.alive().length - 1;
      // Teferi's Protection: all their permanents phase out until their next turn
      if (/all permanents you control phase out/i.test(card.info.text)) { for (const c of [...q.bf]) if (c.zone === 'bf') this.phaseOut(c, null); this.emit('response', `${q.name} casts ${card.info.name}: their permanents phase out and their life total can't change until their next turn!`, { seat: q.seat, cards: [card.id] }); return true; }
      // only what the card grants: Flawless Maneuver (creatures, indestructible), Boros Charm (permanents, indestructible),
      // Heroic Intervention (permanents, hexproof and indestructible), Teferi's Protection (phases everything out)
      const txt = (card.info.text || '').toLowerCase();
      const onlyCreatures = /creatures you control gain/.test(txt) && !/permanents you control/.test(txt);
      const grantsInd = /indestructible/.test(txt) || /phase out|protection from everything/.test(txt);
      const grantsHex = /hexproof/.test(txt) || /phase out|protection from everything/.test(txt);
      for (const c of q.bf) if (!onlyCreatures || c.info.isCreature) { if (grantsInd) c.indestructibleEOT = true; if (grantsHex) c.hexproofEOT = true; }
      this.emit('response', `${q.name} responds with ${card.info.name}!`, { seat: q.seat, cards: [card.id] });
      return true;
    }

    // Brisela, Voice of Nightmares: q's opponents can't cast spells with mana value 3 or less
    // Grim Hireling: the best opposing creature that the Treasures on hand can shrink to death
    hirelingTarget(p) {
      const n = p.bf.filter((x) => x.token && this.isSubtype(x, 'Treasure')).length;
      return this.opps(p).flatMap((q) => q.bf).filter((x) => x.info.isCreature && this.targetable(x, p) && this.toughness(x) <= n && this.creatureValue(x) >= 6).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0] || null;
    }
    transmuteFind(p, c) { return p.library.filter((x) => !x.info.isLand && (x.info.mv || 0) === (c.info.mv || 0)).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0] || null; }
    briselaLock(q, c) { return !c.info.isLand && (c.info.mv || 0) <= 3 && this.opps(q).some((o) => this.has(o, 'brisela')); }
    abolished(q, kind = 'spell') {
      // Grand Abolisher: q can't cast spells or activate abilities during the active player's turn
      const act = this.P(this.active);
      if (act !== q && this.has(act, 'abolisher')) return true;
      if (kind === 'ability') return false; // Silence and Teferi, Time Raveler only stop spells
      // Teferi, Time Raveler: opponents may only cast at sorcery speed; Silence: no spells this turn
      if (this.opps(q).some((o) => this.has(o, 'raveler'))) return true;
      if (q.silencedTurn === this.turn) return true;
      return false;
    }

    targetable(c, by) {
      if (c.ctrl === by.seat) return true;
      const k = this.kws(c);
      if (k.has('hexproof') || k.has('shroud')) return false;
      if (this.P(c.ctrl).protectedUntil >= this.turn) return false;
      // Serra's Emissary (creature): protection from creatures stops abilities of creatures targeting it
      const src = this.ctxSrc();
      if (k.has('emissary') && src && src.info.isCreature) return false;
      return true;
    }

    // ----- valuation -----
    // Cached until the next game event (or its own counters / pump change): it scans every static on the board, and the
    // AI asks thousands of times per decision (82% of the time on a big Myrkul board, seconds per decision)
    creatureValue(c) {
      const key = this.cacheKey(c) + ':' + c.tapped;
      if (c._cv && c._cv.key === key) return c._cv.v;
      const v = this._creatureValue(c);
      c._cv = { key, v };
      return v;
    }
    _creatureValue(c) {
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
      if (c.token && !c.info.mv) return 1.5; // (a token copy of a card, like Osgir's, is worth what the card is)
      let v = c.info.mv * 1.4 + (c.info.statics.length + c.info.triggers.length + c.info.upkeep.length + c.info.activated.length) * 3;
      if (c.info.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite')) v += 8;
      if (c.info.mana) v = 2 + c.info.mv * 0.5;
      return v;
    }
    playerThreat(q) {
      return q.bf.reduce((s, c) => s + (c.info.isLand ? 0.5 : this.permValue(c)), 0) + (40 - q.life) * -0.15;
    }
    // How close a player is to winning: their board, the network's win chance, a combo one piece away, unlimited mana, poison and commander damage dealt
    threatOf(q) {
      if (!this._thr || this._thr.tick !== this._nnTick) this._thr = { tick: this._nnTick, v: {} }; // one score per player until the next event
      if (this._thr.v[q.seat] != null) return this._thr.v[q.seat];
      let v = this.playerThreat(q) + q.hand.length * 1.5 + (q.infMana ? 50 : 0);
      if (this.nn) v += 100 * this.nnV(q);
      if (this.comboWants(q).some((w) => w.missing.length <= 1)) v += 25;
      for (const r of this.players) if (r !== q) { v += r.poison * 3; for (const c of q.bf.concat(q.command)) if (c.isCommander) v += (r.cmdDmg[c.id] || 0) * 1.2; }
      this._thr.v[q.seat] = v;
      return v;
    }
    // q's threat compared with p's other opponents (positive: q is the one to stop)
    relThreat(p, q) { const opps = this.opps(p); if (opps.length < 2) return 0; const all = opps.map((o) => this.threatOf(o)); return this.threatOf(q) - all.reduce((a, b) => a + b, 0) / all.length; }
    bestOppTarget(p, pred) {
      let best = null, bestV = 2;
      for (const q of this.opps(p)) {
        const lead = this.politics ? this.relThreat(p, q) * 0.1 * (this.politics / 40) : this.playerThreat(q) * 0.05; // removal leans toward the leader's permanents
        for (const c of q.bf) if (pred(c)) { const v = this.permValue(c) + lead - this.wardCost(p, c) + this.lockValue(p, c); if (v > bestV) { best = c; bestV = v; } }
      }
      return best;
    }
    // what a removal effect can hit ("destroy target creature", "exile target nonland permanent", ...)
    removalPred(what) {
      return {
          creature: (c) => c.info.isCreature, creaturepw: (c) => c.info.isCreature || c.info.isPW, nonland: (c) => !c.info.isLand,
          artifact: (c) => c.info.types.has('Artifact'), enchantment: (c) => c.info.types.has('Enchantment'),
          artench: (c) => c.info.types.has('Artifact') || c.info.types.has('Enchantment'), planeswalker: (c) => c.info.isPW,
          nonlandNonPW: (c) => !c.info.isLand && !c.info.isPW, permanent: () => true, tappedCreature: (c) => c.info.isCreature && c.tapped,
          nonblackCreature: (c) => c.info.isCreature && !(c.info.colors && c.info.colors.has('B')), nonartifactCreature: (c) => c.info.isCreature && !c.info.types.has('Artifact'), attackingCreature: (c) => c.info.isCreature && c.attacking, colored: (c) => !c.info.isLand && c.info.colors && c.info.colors.size > 0,
        }[what] || ((c) => !c.info.isLand);
    }
    // Lock pieces: an opponent's permanent whose static ability is what stops p's plan. Worth that much to remove.
    // Protection from creatures (Serra's Emissary) or a Glacial Chasm blanks our whole attack; "opponents can't win"
    // (Platinum Angel) stops every win; an attack tax (Sphere of Safety) chokes attacks; "can't respond" pieces hurt less.
    lockValue(p, c) {
      if (c.ctrl === p.seat || c.zone !== 'bf') return 0;
      let v = 0;
      const attack = () => Math.min(60, p.bf.filter((x) => x.info.isCreature).reduce((a, x) => a + Math.max(0, this.power(x)), 0));
      for (const st of c.info.statics) {
        if (st.k === 'emissary' || st.k === 'chasm') v += 10 + attack();
        else if (st.k === 'platinum') v += 50;
        else if (st.k === 'sphere') v += Math.min(25, p.bf.filter((x) => x.info.isCreature).length * 3);
        else if (st.k === 'abolisher' || st.k === 'raveler') v += 6;
      }
      return v;
    }
    // What targeting c costs us on top of the spell: its ward. Infinity when we can't (or shouldn't) pay it.
    wardCost(p, c, src = null) {
      if (c.ctrl === p.seat) return 0;
      const i = c.info; let v = 0;
      if (i.wardLife) { if (!this.canPayLife(p, i.wardLife)) return Infinity; v += i.wardLife * 0.5; }
      if (i.wardSac) { const f = this.wardSacFodder(p, src); if (f.length < 3) return Infinity; v += f.reduce((a, x) => a + this.permValue(x), 0); }
      if (i.wardMana) { if (this.availableMana(p) < i.wardMana) return Infinity; v += i.wardMana * 0.5; }
      return v;
    }
    // "Cyclonic Rift targets Kaalia's Valgavoth": said before ward, protection and redirects, so the log reads in order
    announceTarget(p, tgt, src, name) {
      const owner = this.P(tgt.ctrl), what = src ? src.info.name : name || p.name;
      this.emit('effect', `${what} targets ${owner === p ? 'their own' : owner.name + "'s"} ${this.cname(tgt)}.`, { seat: p.seat, cards: (src ? [src.id] : []).concat(tgt.id), target: owner.seat });
    }
    // Pay the target's ward; false when it can't be paid and the spell or ability is countered
    payWard(p, tgt, src) {
      if (tgt.ctrl === p.seat) return true;
      const i = tgt.info;
      if (i.wardLife) { if (!this.canPayLife(p, i.wardLife)) { this.emit('effect', `Ward: ${p.name} won't pay ${i.wardLife} life, so it is countered.`, { seat: p.seat, cards: [tgt.id] }); return false; } this.emit('effect', `${p.name} pays ${i.wardLife} life for ${i.name}'s ward.`, { seat: p.seat, cards: [tgt.id] }); this.loseLife(p, i.wardLife); }
      if (i.wardSac) { const f = this.wardSacFodder(p, src); if (f.length < 3) { this.emit('effect', `Ward: ${p.name} can't pay, so the spell is countered.`, { seat: p.seat }); return false; } this.emit('effect', `${p.name} sacrifices ${this.listNames(f.map((x) => x.info.name))} to pay ${i.name}'s ward.`, { seat: p.seat, cards: f.map((x) => x.id).concat(tgt.id) }); for (const x of f) this.destroy(x, 'sacrificed', true); }
      if (i.wardMana) { if (!this.pay(p, parseCost(String(i.wardMana)))) { this.emit('effect', `Ward counters the spell.`, { seat: p.seat }); return false; } this.emit('effect', `${p.name} pays {${i.wardMana}} for ${i.name}'s ward.`, { seat: p.seat, cards: [tgt.id] }); this.pay(p, parseCost(String(i.wardMana)), 0, true); }
      return !p.lost && !this.over;
    }
    wardSacFodder(p, src) { return p.bf.filter((x) => !x.info.isLand && x !== src).sort((a, b) => this.permValue(a) - this.permValue(b)).slice(0, 3); }
    landValue(p, c) {
      const m = c.info.mana; if (!m) return c.info.fetch ? 2 : 0;
      const cols = new Set(m.opts.flatMap((o) => o.colors));
      const need = p.colors.filter((x) => !this.sources(p).some((s) => s.opts.some((o) => o.colors.includes(x))) && !p.bf.some((b) => b.info.mana && b.info.mana.opts.some((o) => o.colors.includes(x))));
      let v = [...cols].filter((x) => p.colors.includes(x)).length + need.filter((x) => cols.has(x)).length * 3;
      if (c.info.etbTapped) v -= 1.5;
      return v + this.landSynergy(p, c);
    }
    // Cabal Coffers and Urborg: each is worth far more with the other (Urborg makes every land a Swamp for Coffers)
    landSynergy(p, c) {
      const lands = p.bf.filter((x) => x.info.isLand && x !== c);
      const coffersOut = lands.some((x) => x.info.coffers), urborgOut = lands.some((x) => x.info.addsLandType === 'Swamp');
      const known = (pred) => p.hand.some(pred) || p.library.some(pred);
      if (c.info.coffers) {
        const swamps = urborgOut ? lands.length + 1 : lands.filter((x) => this.landTypes(p, x).includes('Swamp')).length;
        return Math.max(0, swamps - 2) * 1.2 + (!urborgOut && known((x) => x.info.addsLandType === 'Swamp') ? 2 : 0);
      }
      if (c.info.addsLandType === 'Swamp') {
        const nonSwamps = lands.filter((x) => !this.landTypes(p, x).includes('Swamp')).length;
        return coffersOut ? 4 + nonSwamps * 1.2 : known((x) => x.info.coffers) ? 3 : 0;
      }
      return 0;
    }
    // Which land to play this turn: try each one and see what it lets us cast right now. A land that enters
    // tapped is best played on a turn when the extra mana wouldn't be used anyway; colours the hand is missing count.
    chooseLandDrop(p, lands) {
      if (lands.length === 1) return lands[0];
      const seen = new Map(); for (const c of lands) if (!seen.has(c.info.name)) seen.set(c.info.name, c);
      const uniq = [...seen.values()];
      if (uniq.length === 1) return uniq[0];
      const bestNow = () => { const o = this.castOptions(p); return o.length ? o[0].s + Math.min(20, (o.length - 1) * 2) : 0; };
      const base = bestNow();
      // colours the spells in hand need that we can't make yet
      const have = new Set(this.sources(p).flatMap((x) => x.opts.flatMap((o) => o.colors)));
      const want = new Set(p.hand.filter((x) => !x.info.isLand).flatMap((x) => ['W', 'U', 'B', 'R', 'G'].filter((k) => (x.info.cost[k] || 0) > 0)).filter((k) => !have.has(k)));
      const scored = uniq.map((c) => {
        this.removeFrom(p.hand, c); c.zone = 'bf'; c.ctrl = p.seat; c.tapped = !!c.info.etbTapped; c.sick = false; p.bf.push(c);
        const now = bestNow() - base;
        this.removeFrom(p.bf, c); c.zone = 'hand'; c.tapped = false; p.hand.push(c);
        const cols = new Set(((c.info.mana || { opts: [] }).opts || []).flatMap((o) => o.colors));
        const fixes = [...want].filter((k) => cols.has(k)).length;
        let v = now + this.landValue(p, c) + fixes * 4;
        if (c.info.etbTapped && now <= 0) v += 3; // a free turn to play the tapped land
        if (c.info.etbTapped && now > 0) v -= 2;
        return { c, v };
      }).sort((a, b) => b.v - a.v);
      return scored[0].c;
    }
    // worth paying life for an untapped land only if something castable now needs the mana
    wantUntappedLand(p, c) { if (!this.started || p.seat !== this.active) return false; c.tapped = false; const now = this.castOptions(p).length; c.tapped = true; const before = this.castOptions(p).length; c.tapped = false; return now > before; }
    bestLandFrom(p, lands) { return lands.slice().sort((a, b) => this.landValue(p, b) - this.landValue(p, a))[0]; }
    // A search for two lands picks them together: every pair, each valued with the other already out, so a pair
    // that works together (Cabal Coffers + Urborg) beats two lands that are each a little better on their own.
    bestLandPair(p, lands) {
      if (lands.length < 2) return lands.slice(0, 1);
      const with_ = (a, b) => { p.bf.push(a); const v = this.landValue(p, b); p.bf.pop(); return v; };
      const top = lands.slice().sort((a, b) => this.landValue(p, b) - this.landValue(p, a));
      // distinct names only (ten basic Swamps are one choice), plus the partners synergy can pull in from further down
      const seen = new Set(), pool = top.filter((c) => !seen.has(c.info.name) && seen.add(c.info.name)).slice(0, 25);
      let best = null, bv = -Infinity;
      for (let i = 0; i < pool.length; i++) for (let j = 0; j < pool.length; j++) if (i !== j) {
        const v = this.landValue(p, pool[i]) + with_(pool[i], pool[j]);
        if (v > bv) { bv = v; best = [pool[i], pool[j]]; }
      }
      // two of the same name (two basics): allowed when the library has two
      const dup = top.find((c, k) => top.findIndex((x) => x.info.name === c.info.name) !== k);
      if (dup) { const a = top.find((x) => x.info.name === dup.info.name), v = this.landValue(p, a) + with_(a, dup); if (v > bv) best = [a, dup]; }
      return best;
    }
    cardValue(p, c) {
      const i = c.info;
      if (i.isLand) return 1 + this.landSynergy(p, c);
      let v = i.mv;
      if (i.isCreature) v += (i.power || 0) + (i.toughness || 0) * 0.5;
      if (i.spell.some((f) => f.k === 'wipe')) v += 8;
      if (i.triggers.length || i.statics.length) v += 5;
      if (i.isPW) v += 6;
      return v;
    }
    chooseTutor(p, what) {
      const pool = p.library.filter((c) => (what === 'manaArtifact' && c.info.isLand ? c.info.types.has('Basic') && !p.library.some((x) => x.info.types.has('Artifact') && x.info.mana) : !c.info.isLand) && (what === 'card' || (what === 'manaArtifact' && ((c.info.types.has('Artifact') && c.info.mana) || c.info.isLand)) || (what === 'creature' && c.info.isCreature) || (what.includes('artifact') && c.info.types.has('Artifact')) || (what.includes('enchantment') && c.info.types.has('Enchantment')) || (what.includes('instant') && (c.info.isInstant || c.info.isSorcery))));
      if (!pool.length) return null;
      // locked out (Serra's Emissary against our board): a combo piece only beats the answer if it completes the combo
      const lockTop = Math.max(0, ...this.opps(p).flatMap((q) => q.bf).map((x) => this.lockValue(p, x)));
      for (const w of this.comboWants(p)) {
        if (lockTop >= 30 && w.missing.length > 1) continue;
        const lib = w.missing.find((m) => m.zone === 'lib' && pool.some((c) => c.name === m.name));
        if (lib) return pool.find((c) => c.name === lib.name);
      }
      const avail = this.availableMana(p) + 1;
      // combo pieces first
      const bond = pool.find((c) => c.info.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite'));
      const haveHalf = p.bf.some((c) => c.info.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite'));
      if (bond && haveHalf) return bond;
      const opp = this.opps(p).map((q) => this.playerThreat(q)).sort((a, b) => b - a)[0] || 0;
      const mine = this.playerThreat(p);
      // an answer to whatever is locking us out (Serra's Emissary against a big board) beats general value
      const locks = this.opps(p).flatMap((q) => q.bf).filter((x) => this.lockValue(p, x) > 0 && this.targetable(x, p));
      const answers = (c) => { if (!locks.length) return 0; const fx = c.info.spell.concat(c.info.etb || []).filter((f) => f.k === 'removal'); return Math.max(0, ...fx.flatMap((f) => locks.filter(this.removalPred(f.what)).map((x) => this.lockValue(p, x)))); };
      const ans = new Map(pool.map((c) => [c, answers(c)]));
      return pool.slice().sort((a, b) => {
        const la = this.nnAdv(p, a, 'hand') * Game.NN_WEIGHT, lb = this.nnAdv(p, b, 'hand') * Game.NN_WEIGHT;
        const sa = la + this.cardValue(p, a) - Math.max(0, a.info.mv - avail) * 3 + (opp > mine + 15 && a.info.spell.some((f) => f.k === 'wipe') ? 20 : 0) + ans.get(a);
        const sb = lb + this.cardValue(p, b) - Math.max(0, b.info.mv - avail) * 3 + (opp > mine + 15 && b.info.spell.some((f) => f.k === 'wipe') ? 20 : 0) + ans.get(b);
        return sb - sa;
      })[0];
    }

    // ----- state-based actions -----
    // Opalescence / Starfield of Nyx turn enchantments into creatures
    refreshAnimations() {
      // Opalescence: each OTHER non-Aura enchantment; Starfield of Nyx (5+ enchantments): each other non-Aura
      // enchantment you control. They animate each other. Base power/toughness = mana value (enchantment creatures too).
      const opals = this.alive().flatMap((x) => x.bf.filter((c) => (c.baseInfo || c.info).statics.some((st) => st.k === 'opalescence')));
      for (const q of this.alive()) {
        const stars = q.bf.filter((c) => (c.baseInfo || c.info).statics.some((st) => st.k === 'starfield'));
        const starOn = stars.length && q.bf.filter((c) => c.info.types.has('Enchantment')).length >= 5;
        for (const c of q.bf) {
          const base = c.baseInfo || c.info;
          const should = base.types.has('Enchantment') && !base.isAura && (opals.some((o) => o !== c) || (starOn && stars.some((o) => o !== c)));
          if (should && c.animatedBy !== 'ench') { this.setInfo(c, { isCreature: true, power: base.mv, toughness: base.mv, types: new Set([...base.types, 'Creature']) }); c.animatedBy = 'ench'; }
          else if (!should && c.animatedBy === 'ench') { this.restoreInfo(c); c.animatedBy = null; }
          // Theros gods (Heliod): a creature only with devotion 5+ to its colour
          if (base.godDevotion) {
            const col = [...(base.colors || [])][0] || 'W';
            const dev = q.bf.reduce((a, x) => a + ((x.info.cost && x.info.cost.pips) || []).filter((pp) => pp.opts.includes(col)).length, 0);
            if (dev >= 5 && c.animatedBy !== 'god') { const pt = ((base.face && base.face.pt) || '5/5').split('/').map(Number); this.setInfo(c, { isCreature: true, power: pt[0], toughness: pt[1], types: new Set([...base.types, 'Creature']) }); c.animatedBy = 'god'; }
            else if (dev < 5 && c.animatedBy === 'god') { this.restoreInfo(c); c.animatedBy = null; }
          }
        }
      }
    }
    checkState() {
      // a melded card left: its partner goes along to the same zone
      if (this._meldFollow && this._meldFollow.length) for (const c of this._meldFollow.splice(0)) {
        const b = this.cards[c.meldPartner]; c.meldPartner = null; const o = b && this.P(b.owner);
        if (!b || b.zone !== 'exile' || !o.exile.includes(b) || c.zone === 'exile' || c.zone === 'bf') continue;
        this.removeFrom(o.exile, b); b.zone = c.zone;
        if (c.zone === 'gy') o.gy.push(b); else if (c.zone === 'hand') o.hand.push(b); else if (c.zone === 'library') o.library.splice(Math.max(0, o.library.indexOf(c)) + 1, 0, b); else { b.zone = 'exile'; o.exile.push(b); }
      }
      this.refreshAnimations();
      let changed = true, guard = 0;
      while (changed && guard++ < 20) {
        changed = false;
        for (const q of this.players) {
          if (q.lost) continue;
          if (q.life <= 0) { this.lose(q, 'life total reached 0'); changed = true; continue; }
          if (q.poison >= 10) { this.lose(q, '10 poison counters'); changed = true; continue; }
          for (const [k, v] of Object.entries(q.cmdDmg)) if (v >= 21) { this.lose(q, `21 commander damage from ${this.cards[k].info.name}`); changed = true; break; }
        }
        const batch = this.beginDeathBatch();
        // decide who dies first, then remove them all: they die at the same time
        const dying = [];
        for (const c of this.allBf()) {
          if (!c.info.isCreature) continue;
          const t = this.toughness(c);
          if (t <= 0) dying.push([c, true]);
          else if ((c.dmg >= t || (c.dt && c.dmg > 0)) && !this.hasKw(c, 'indestructible')) dying.push([c, false]);
        }
        for (const [c, force] of dying) if (c.zone === 'bf') { if (force) this.destroy(c, 'dies', true); else this.destroy(c); changed = true; }
        this.endDeathBatch(batch);
        for (const c of this.allBf()) {
          if (c.info.isCreature) {
            const t = this.toughness(c);
            if (t <= 0) { this.destroy(c, 'dies', true); changed = true; }
            else if ((c.dmg >= t || (c.dt && c.dmg > 0)) && !this.hasKw(c, 'indestructible')) { this.destroy(c); changed = true; }
          } else if (c.info.isPW && c.loyalty <= 0) {
            const ctrl = this.P(c.ctrl);
            this.moveToGraveyard(c); changed = true;
          }
        }
        // equipment attached to something that is no longer a creature becomes unattached
        for (const c of this.allBf()) if (c.info.isEquipment && c.attached) { const t = this.cards[c.attached]; if (!t || t.zone !== 'bf' || !t.info.isCreature) { c.attached = null; } }
        // an Aura attached to nothing goes to the graveyard (Kaya's Ghostform and Pattern of Rebirth used to stay after their creature left)
        for (const c of this.allBf()) if (c.info.isAura && !c.info.reanimAura && !c.info.isCreature && (!c.attached || this.cards[c.attached]?.zone !== 'bf')) { c.attached = null; this.moveToGraveyard(c); changed = true; }
        // legend rule
        for (const q of this.alive()) {
          const seen = {};
          if (this.has(q, 'noLegendRule')) continue;
          const groups = {};
          for (const c of q.bf) if (c.info.isLegendary) (groups[c.info.name] = groups[c.info.name] || []).push(c);
          for (const g of Object.values(groups)) if (g.length > 1) {
            // the controller chooses which one to keep: their commander, else the most valuable
            const keepC = g.slice().sort((a, b) => (b.isCommander ? 1 : 0) - (a.isCommander ? 1 : 0) || this.permValue(b) - this.permValue(a))[0];
            for (const c of g) if (c !== keepC) { this.emit('effect', `Legend rule: ${q.name} keeps one ${c.info.name} and puts the other into the graveyard.`, { seat: q.seat, cards: [c.id] }); this.moveToGraveyard(c); changed = true; }
          }
        }
      }
    }

    // ----- casting -----
    castables(p) {
      const out = [];
      if (p.silencedTurn === this.turn) return out;
      const drannith = this.opps(p).some((q) => this.has(q, 'drannith'));
      // Ethersworn Canonist: one nonartifact spell per turn
      const canonist = this.alive().some((q) => this.has(q, 'canonist')) && p.nonArtifactSpells >= 1;
      const ok = (c) => (!canonist || c.info.types.has('Artifact')) && !this.briselaLock(p, c);
      const cmd = p.command[0];
      for (const c of p.hand) if (!c.info.isLand && ok(c)) out.push({ c, from: 'hand' });
      for (const c of p.hand) if (c.info.channel && ok(c)) out.push({ c, from: 'channel' });
      if (this.active === p.seat) for (const c of p.hand) if (c.info.transmute) out.push({ c, from: 'transmute' });
      for (const c of p.hand) if (c.info.dash && ok(c)) out.push({ c, from: 'dash' });
      if (!drannith) for (const c of p.gy) if (c.info.flashback && ok(c)) out.push({ c, from: 'flashback' });
      for (const c of p.bf) if (c.info.prepared && c.prepared && !drannith) out.push({ c, from: 'prepared' });
      if (drannith) return out;
      if (cmd && ok(cmd)) out.push({ c: cmd, from: 'command' });
      const top = p.library[0];
      if (top && !top.info.isLand && ok(top)) {
        if (p.bf.some((x) => x.info.citadel) && !top.info.cost.x && this.canPayLife(p, top.info.mv)) out.push({ c: top, from: 'citadel' });
        else if (this.statics(p, 'castTop').length && (top.info.types.has('Artifact') || top.info.colors.size === 0)) out.push({ c: top, from: 'top' });
      }
      for (const c of this.players.flatMap((q) => q.exile)) if (c.voidBy === p.seat && c.owner !== p.seat && this.statics(p, 'voidExile').some(({ s: st }) => st.valgavoth) && !c.info.isLand && !c.info.cost.x && this.canPayLife(p, c.info.mv)) out.push({ c, from: 'valgavoth' });
      if (this.has(p, 'muldrotha')) {
        for (const c of p.gy) if (c.info.isPermanent && !c.info.isLand) {
          const types = ['Creature', 'Artifact', 'Enchantment', 'Planeswalker'].filter((t) => c.info.types.has(t) && !p.gyCastTypes.has(t));
          if (types.length) { const want = (t) => p.gy.filter((x) => x !== c && x.info.isPermanent && !x.info.isLand && x.info.types.has(t)).length; out.push({ c, from: 'gy', gyType: types.slice().sort((a, b) => want(a) - want(b))[0] }); }
        }
      }
      return out;
    }

    gyCreatureValue(c) { const i = c.info; return (i.power || 0) * 1.6 + (i.toughness || 0) * 0.8 + (i.mv || 0) * 0.6 + (i.etb && i.etb.length ? 3 : 0) + (i.statics && i.statics.length ? 2 : 0) + (i.triggers && i.triggers.length ? 2 : 0); }
    // Can p pay this card's alternative cost right now?
    altCostOk(p, c) {
      const a = c.info.altCost;
      if (!a || (a.notYourTurn && this.active === p.seat) || this.locked(p)) return false;
      if (a.kind === 'commander') return p.bf.some((x) => x.isCommander);
      if (a.kind === 'exile') return p.hand.some((x) => x !== c && x.info.colors && x.info.colors.has(a.color)) && (!a.life || this.canPayLife(p, a.life));
      if (a.kind === 'sac') return !!this.altSacPick(p, c);
      if (a.kind === 'webSling') return p.bf.some((x) => x.info.isCreature && x.tapped && !x.isCommander) && this.pay(p, parseCost(a.mana));
      if (a.kind === 'life') return (!a.ifControl || p.bf.some((x) => (x.info.isLand ? this.landTypes(p, x) : x.info.subtypes || []).includes(a.ifControl))) && this.canPayLife(p, a.n);
      return false;
    }
    altSacPick(p, c) { const col = c.info.altCost.color; return p.bf.filter((x) => x.info.isCreature && !x.token && !x.isCommander && x.info.colors && x.info.colors.has(col) && !this.livePiece(p, x)).sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0]; }
    // Use the alternative cost? Always when it's free (commander out); otherwise only when the mana isn't there.
    altChosen(p, c, from) {
      if (from !== 'hand' || !this.altCostOk(p, c)) return false;
      return c.info.altCost.kind === 'commander' || !this.pay(p, this.costFor(p, c, from, true));
    }
    payAltCost(p, c) {
      const a = c.info.altCost;
      if (a.kind === 'exile') { const x = p.hand.filter((y) => y !== c && y.info.colors && y.info.colors.has(a.color)).sort((y, z) => this.cardValue(p, y) - this.cardValue(p, z))[0]; this.removeFrom(p.hand, x); x.zone = 'exile'; p.exile.push(x); if (a.life) this.loseLife(p, a.life); this.emit('effect', `${p.name} exiles ${x.info.name} from hand to cast ${c.info.name} for free.`, { seat: p.seat, cards: [c.id, x.id] }); }
      else if (a.kind === 'sac') { const x = this.altSacPick(p, c); this.emit('effect', `${p.name} sacrifices ${x.info.name} to cast ${c.info.name} for free.`, { seat: p.seat, cards: [c.id, x.id] }); this.destroy(x, 'sacrificed', true); }
      else if (a.kind === 'life') { this.emit('effect', `${p.name} pays ${a.n} life to cast ${c.info.name}.`, { seat: p.seat, cards: [c.id] }); this.loseLife(p, a.n); }
      else if (a.kind === 'webSling') { // the mana, plus a tapped creature back to hand (one with an enters ability, to replay)
        this.pay(p, parseCost(a.mana), 0, true);
        const x = p.bf.filter((y) => y.info.isCreature && y.tapped && !y.isCommander).sort((y, z) => (z.info.etb.length ? 5 : 0) - this.creatureValue(z) * 0.1 - ((y.info.etb.length ? 5 : 0) - this.creatureValue(y) * 0.1))[0];
        this.emit('effect', `${p.name} web-slings ${c.info.name}, returning ${x.info.name} to hand.`, { seat: p.seat, cards: [c.id, x.id] }); this.bounce(x);
      }
    }
    // Spree: every mode we can afford on top of the base cost (life loss only if safe), most valuable first
    spreeModes(p, c, base = c.info.cost) {
      const add = (cost, m) => ({ ...cost, generic: cost.generic + m.cost.generic, pips: cost.pips.concat(m.cost.pips), mv: (cost.mv || 0) + (m.cost.mv || 0) });
      const ok = (m) => !m.fx.some((f) => f.k === 'loseSelf' && !this.canPayLife(p, +f.n || 0));
      const modes = c.info.spree.filter(ok).slice().reverse(); let cost = base; const out = [];
      for (const m of modes) { const t = add(cost, m); if (this.pay(p, t)) { cost = t; out.push(m); } }
      return out;
    }
    costFor(p, c, from, normal = false) {
      if (from === 'citadel' || from === 'valgavoth') return parseCost('');
      if (from === 'miracle') return c.info.miracle;
      if (from === 'transmute') return c.info.transmute;
      if (from === 'prepared') return parseCost(c.info.prepared.cost);
      if (from === 'channel') { const leg = p.bf.filter((x) => x.info.isCreature && x.info.isLegendary).length; const cc = c.info.channel.cost; return { ...cc, generic: Math.max(0, cc.generic - leg), mv: Math.max(cc.mv - cc.generic, cc.mv - leg) }; }
      if (!normal && c.info.altCost && this.altChosen(p, c, from)) return parseCost(''); // (paid in castSpell / tryProtect / counter responses)
      if (from === 'hand' && (p.emblems || []).includes('freeSpells')) return parseCost('');
      let cost = from === 'command' ? this.commanderCost(p, c) : from === 'dash' ? c.info.dash : from === 'flashback' ? c.info.flashback : c.info.cost;
      let red = 0;
      for (const { s: st } of this.statics(p, 'reduce')) if ((st.what === 'artifact' && c.info.types.has('Artifact')) || (st.what === 'planeswalker' && c.info.isPW) || (st.what === 'colorless' && (c.info.colors.size === 0 || this.alive().some((q) => this.has(q, 'lattice'))))) red += st.n;
      if (from === 'gy') red += this.statics(p, 'reduceGy').reduce((s2, x) => s2 + x.s.n, 0);
      if (c.info.henge) red += Math.max(0, ...p.bf.filter((x) => x.info.isCreature).map((x) => this.power(x)));
      if (red) cost = { ...cost, generic: Math.max(0, cost.generic - red) };
      // Thalia: noncreature spells cost more, for every player
      if (!c.info.isCreature && !c.info.isLand) { const tax = this.alive().reduce((a2, q) => a2 + this.statics(q, 'taxNoncreature').reduce((b, x) => b + x.s.n, 0), 0); if (tax) cost = { ...cost, generic: cost.generic + tax, mv: (cost.mv || 0) + tax }; }
      if (c.info.convoke) { const helpers = p.bf.filter((x) => x.info.isCreature && !x.tapped && !this.canAttack(x)).length; cost = { ...cost, generic: Math.max(0, cost.generic - helpers) }; }
      if (c.info.spree && !normal) { const ms = this.spreeModes(p, c, cost); c._spree = ms; if (!ms.length) return { ...cost, generic: cost.generic + 99, mv: (cost.mv || 0) + 99 }; for (const m of ms) cost = { ...cost, generic: cost.generic + m.cost.generic, pips: cost.pips.concat(m.cost.pips), mv: (cost.mv || 0) + (m.cost.mv || 0) }; }
      // delve: each card exiled from the graveyard pays for one generic mana (exiled in castSpell)
      if (c.info.delve) { const n = Math.min(cost.generic, p.gy.filter((x) => x !== c).length); c._delveN = n; if (n) cost = { ...cost, generic: cost.generic - n }; }
      return cost;
    }

    // an effect's count for scoring: counts can be words (X, LANDS for "one per land you control", TRIBE, X2), and a word times a number is NaN, which silently hid the card from the AI
    fxNum(p, n, xGuess = 2) {
      if (typeof n === 'number') return n;
      if (n == null) return 1;
      if (n === 'LANDS') return p.bf.filter((c) => c.info.isLand).length;
      if (n === 'TRIBE') return Math.max(1, p.bf.filter((c) => c.info.isCreature).length - 1);
      if (n === 'X2') return xGuess * 2;
      return /^\d+$/.test(n) ? +n : xGuess;
    }
    // how many cards casting c makes us draw (cast triggers, constellation, The Great Henge, its own draw)
    castDraws(p, c, othersOnly = false) {
      const i = c.info, dn = (fx) => fx.reduce((a, f) => a + (f.k === 'draw' ? (+f.n || 1) : 0), 0);
      let n = othersOnly ? 0 : dn(i.isPermanent ? i.etb : i.spell);
      for (const s of p.bf) {
        for (const t of s.info.castTrig) if (!t.filter.trim() || (/enchantment/.test(t.filter) && i.types.has('Enchantment')) || (/creature/.test(t.filter) && !/noncreature/.test(t.filter) && i.isCreature) || (/noncreature/.test(t.filter) && !i.isCreature)) n += dn(t.fx);
        if (i.types.has('Enchantment')) for (const fx of (s.info.constellation || [])) n += dn(fx);
        if (i.isCreature) for (const fx of (s.info.myCreatureEtb || [])) n += dn(fx);
      }
      if (i.types.has('Enchantment')) for (const fx of (i.constellation || [])) n += dn(fx);
      return n;
    }
    scoreCast(p, c, from) {
      const i = c.info;
      const turnN = this.round;
      const opp = this.opps(p);
      const mine = this.playerThreat(p);
      const oppMax = Math.max(...opp.map((q) => this.playerThreat(q)), 0);
      if (i.isLand) return -1;
      // don't draw ourselves out: enchantress / constellation / Great Henge draws off a spell when the library is nearly empty
      if (p.library.length < 12 && !this.has(p, 'platinum') && !this.has(p, 'labman') && p.library.length - this.castDraws(p, c) < 3) return -1;
      // reactive cards are held
      if (i.spell.some((f) => f.k === 'counter' || f.k === 'protect') && !i.spell.some((f) => ['draw', 'removal', 'tokens'].includes(f.k))) return -1;
      if (i.isInstant && i.spell.length === 0 && /target creature you control|until end of turn/i.test(i.text)) return -1;
      // a spell that only ramps, with nothing left to find, does nothing
      if (!i.isPermanent && i.spell.length && i.spell.every((f) => f.k === 'ramp' && !this.rampFinds(p, f))) return -1;
      let s = 5 + i.mv;
      if (i.mana && !i.isLand) s += 30 - turnN * 2;
      if (from === 'command') s += 25 + i.mv;
      if (i.isCreature) s += 8 + (i.power || 0) + (i.toughness || 0) * 0.5 + i.kw.size;
      if (i.isPW) s += 22 + i.loyalty;
      if (i.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite')) s += 15;
      const fx = i.isPermanent ? i.etb : i.spell;
      // targets as this card would see them (Serra's Emissary's protection from creatures stops Gilded Drake)
      const tgtOk = (x) => { this._ctx.push(c); try { return this.targetable(x, p); } finally { this._ctx.pop(); } };
      for (const f of fx) {
        if (f.k === 'ramp') s += this.rampFinds(p, f) ? 28 - turnN * 2 : -6;
        if (f.k === 'draw') s += 6 + this.fxNum(p, f.n, 1) * 3 + (p.hand.length < 3 ? 8 : 0);
        if (f.k === 'wheel') s += p.hand.length < 3 ? 25 : -20;
        if (f.k === 'tutor' && p.tutorTurn === this.turn && p.tutorN >= 2) return -1; // (a tutor coming back to hand, Tamiyo's emblem: two a turn is plenty)
        if (f.k === 'tutor' || f.k === 'tutorBF') { if (f.top && p.library[0] && this.chooseTutor(p, f.what || 'card') === p.library[0]) return -1; s += 14; } // (not to put the card that's already on top back on top)
        if (f.k === 'tokens') s += 6 + this.fxNum(p, f.n, 3) * 2;
        if (f.k === 'treasure') s += 4;
        if (f.k === 'removal' || f.k === 'steal') {
          const pred = f.k === 'removal' ? this.removalPred(f.what) : f.what === 'creature' ? (x) => x.info.isCreature : (x) => !x.info.isLand;
          const t = this.bestOppTarget(p, (x) => pred(x) && tgtOk(x));
          if (!t && i.isInstant || !t && i.isSorcery) return -1;
          // a bounce only costs the owner the mana to cast it again, unless it can't come back (a token, or a permanent
          // that returns to its owner instead of the player using it); a card spent on that is a card down
          const sticks = t && (!f.bounce || t.token || t.owner !== t.ctrl);
          if (t) s += sticks ? Math.min(25, this.permValue(t) * 1.6) : Math.min(14, (t.info.mv || 0) * 1.2) - 6;
          if (t && this.permValue(t) < 6 && !i.isPermanent) s -= 15;
          // a stronger mode (overload) that is out of reach for now: keep the card for it unless the target is a real threat
          if (t && i.overload && !this.pay(p, i.overload) && this.permValue(t) < 15) s -= 25;
        }
        if (f.k === 'exchange') { const t = this.bestOppTarget(p, (x) => x.info.isCreature && tgtOk(x) && (!f.pmax || this.power(x) <= f.pmax)); if (!t) return -1; s += this.creatureValue(t) * 1.5; }
        if (f.k === 'edict') { if (!opp.some((q) => q.bf.some((x) => x.info.isCreature))) return -1; s += 8; }
        if (f.k === 'livingDeath') { // the swap is worth what each player gains: their graveyard creatures minus their board's
          const gain = (q) => q.gy.filter((x) => x.info.isCreature).reduce((a, x) => a + this.gyCreatureValue(x), 0) - q.bf.filter((x) => x.info.isCreature).reduce((a, x) => a + this.creatureValue(x), 0);
          const d = gain(p) - Math.max(0, ...opp.map(gain));
          if (d < 6) return -1; s += Math.min(40, d);
        }
        if (f.k === 'victimize') {
          const back = p.gy.filter((x) => x.info.isCreature).map((x) => this.gyCreatureValue(x)).sort((a, b) => b - a).slice(0, 2);
          const fod = p.bf.filter((x) => x.info.isCreature && !x.isCommander).map((x) => this.creatureValue(x)).sort((a, b) => a - b)[0];
          if (fod == null || !back.length) return -1; s += back.reduce((a, b) => a + b, 0) - fod;
        }
        if (f.k === 'massReanimate' && f.own) { const v = p.gy.filter((x) => x.info.isCreature && (f.mvMax == null || (x.info.mv || 0) <= f.mvMax)).reduce((a, x) => a + this.gyCreatureValue(x), 0); if (v < 4) return -1; s += Math.min(35, v); }
        if (f.k === 'wipe') {
          if (f.what === 'lands') { const myLands = p.bf.filter((x) => x.info.isLand).length; const theirs = Math.max(...opp.map((q) => q.bf.filter((x) => x.info.isLand).length)); if (myLands >= theirs || mine < oppMax) return -1; s += 15; continue; }
          const w = this.wipeEval(p, f, c, from);
          if (!w.cast) return -1;
          s += 30 + Math.min(40, w.net * 0.5);
        }
        if (f.k === 'massBounce') { if (oppMax < 25) return -1; s += 20; }
        if (f.k === 'drain') s += 10;
        if (f.k === 'hailfire') {
          // Each repeat costs every opponent 3 life, or a card / permanent once they get low. Small X is a weak
          // card; a big X ends games. Hold it while X is small unless it kills someone.
          const X = this.maxX(p, this.costFor(p, c, from));
          let lifeLoss = 0, kills = 0;
          for (const q of opp) { const res = q.hand.length + q.bf.filter((x) => !x.info.isLand).length; const lifeReps = Math.max(0, Math.ceil((q.life - 12) / 3)); const loss = X <= lifeReps ? 3 * X : 3 * lifeReps + Math.max(0, X - lifeReps - res) * 3; lifeLoss += Math.min(q.life, loss); if (loss >= q.life) kills++; }
          s += lifeLoss * 0.35 + kills * 35;
          if (!kills && X < 8 && turnN < 14) return -1;
        }
        if (f.k === 'finale') { const x = this.maxX(p, this.costFor(p, c, from)); if (x < 3) return -1; s += x >= 10 ? 60 + Math.min(40, p.bf.filter((y) => this.canAttack(y) || y.info.isCreature).length * 4) : x * 3; }
        if (f.k === 'genesis') { const x = f.majestic ? Math.max(0, ...p.bf.concat(p.command).filter((y) => y.isCommander).map((y) => y.info.mv)) : this.maxX(p, this.costFor(p, c, from)); s += x * 3; if (!f.majestic && x < 4) return -1; }
        if (f.k === 'reanimate') { const pools = f.any ? opp.concat([p]).flatMap((q) => q.gy) : p.gy; const best = pools.filter((x) => x.info.isCreature && !x.isCommander).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0]; if (!best) { if (!i.isPermanent || i.reanimAura) return -1; } else s += this.creatureValue(best); }
        if (f.k === 'regrow') { if (!p.gy.some((x) => !x.info.isLand)) s -= 3; else s += 6; }
        if (f.k === 'overrun') { const n = p.bf.filter((x) => x.info.isCreature && !x.sick).length; if (n < 3 && i.isInstant) return -1; s += n * 3; }
        if (f.k === 'extraTurn') s += 20;
        if (f.k === 'dig') s += 6 + this.fxNum(p, f.n, 3) * 0.5;
        if (f.k === 'search') s += f.dest === 'bf' ? 16 : f.dest === 'hand' ? 10 : (p.hand.concat(p.bf).some((x) => x.info.spell.concat(x.info.etb).some((y) => y.k === 'reanimate')) || this.has(p, 'muldrotha') ? 10 : 2);
        if (f.k === 'mill') s += this.has(p, 'muldrotha') || p.bf.some((x) => x.info.sidisi) ? 4 : 0;
        if (f.k === 'edictAll') { const theirs = opp.reduce((a, q) => a + q.bf.filter((x) => x.info.isCreature).length, 0); const mine2 = p.bf.filter((x) => x.info.isCreature && this.creatureValue(x) > 5).length; s += theirs > mine2 * 2 ? 10 : -10; }
        if (f.k === 'massReanimate') s += 20;
        if (f.k === 'massRegrow' && f.bf) { const want = { creature: 'Creature', artifact: 'Artifact', enchantment: 'Enchantment', land: 'Land' }[f.what]; const v = p.gy.filter((x) => x.info.isPermanent && (!want || x.info.types.has(want))).reduce((a, x) => a + this.cardValue(p, x), 0); if (v < 6) return -1; s += Math.min(45, v); }
        if (f.k === 'graveHate') s += Math.max(0, ...opp.map((q) => this.gyThreat(q))) > 12 ? 10 : -6;
        if (f.k === 'landDestroy') s += 4;
        if (f.k === 'regrowLands') s += p.gy.filter((x) => x.info.isLand).length >= 2 ? 8 : -6;
        if (f.k === 'pump' && !i.isPermanent) { if (!p.bf.some((x) => this.canAttack(x))) return -1; s += 2; }
        if (f.k === 'impulse') s += 8;
        if (f.k === 'jeska') s += Math.max(0, ...opp.map((q) => q.hand.length)) >= 3 ? 10 : 0;
        if (f.k === 'wildspeaker') s += 10;
        if (f.k === 'silence') { if (!(opp.some((q) => q.hand.some((x) => x.info.spell.some((y) => y.k === 'counter' || y.k === 'protect'))) && p.hand.some((x) => x !== c && (x.info.mv >= 5 || this.completesCombo(p, x) || x.info.spell.some((y) => y.k === 'wipe'))))) return -1; s += 80; }
        if (f.k === 'phaseOut' || f.k === 'freeze') { if (!this.bestOppTarget(p, (x) => x.info.isCreature && this.targetable(x, p))) return -1; s += 6; }
        if (f.k === 'pullFromEternity') { if (!p.exile.some((x) => x.info.isCreature)) return -1; }
        if (f.k === 'food' || f.k === 'clue' || f.k === 'blood') s += 2;
        if (f.k === 'doubleCounters') s += p.bf.reduce((a, x) => a + (x.p1 || 0) + (x.loyalty || 0), 0);
        if (f.k === 'copy') s += 0;
      }
      // card-draw engines (Phyrexian Arena, Sylvan Library): a card every turn for the rest of the game, worth most early
      { const per = (i.drawsPerTurn || 0) + i.upkeep.reduce((a, u) => a + (u.each ? 0 : u.fx.reduce((b, f) => b + (f.k === 'draw' ? +f.n || 1 : 0), 0)), 0); if (per && p.library.length > 15) s += per * Math.max(5, 16 - this.round); }
      // enchantress engines (Argothian Enchantress, Sythis, Eidolon of Blossoms, The Great Henge): the spell draws cards too
      { const extra = this.castDraws(p, c, true); if (extra) s += Math.min(extra, 4) * 4; }
      if (i.copy) { const pool = (i.copy.own ? p.bf : this.allBf()).filter((x) => (i.copy.what === 'artifact' ? x.info.types.has('Artifact') : x.info.isCreature || (i.copy.what === 'creaturepw' && x.info.isPW))); const best = Math.max(0, ...pool.map((x) => this.copyWorth(p, i, x))); if (best < 6 && !i.mana) return -1; s += best; }
      // being conscious of life: don't cast a spell whose life loss we can't afford
      {
        let pay = 0;
        for (const f of fx) {
          if (f.k === 'loseSelf') pay += f.n === 'TRIBE' ? p.bf.filter((x) => x.info.isCreature && this.isType(x, f.tribe)).length + 1 : (+f.n || 0);
          if (f.k === 'reanimate' && f.loseMv) { const pools = f.any ? opp.concat([p]).flatMap((q) => q.gy) : p.gy; const best = pools.filter((x) => x.info.isCreature && !x.isCommander && this.canPayLife(p, x.info.mv)).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0]; if (best) pay += best.info.mv; else return -1; }
          if (f.k === 'wipe' && f.what === 'deluge') pay += this.delugeX(p);
        }
        if (pay && !this.canPayLife(p, pay)) return -1;
        // permanents that cost life every upkeep (Phyrexian Arena, Bitterblossom): need room for a few turns of it
        const bleed = i.upkeep.reduce((a, u) => a + (u.each ? 0 : u.fx.filter((f) => f.k === 'loseSelf').reduce((b, f) => b + (+f.n || 0), 0)), 0);
        if (bleed && !this.canPayLife(p, bleed * 4)) return -1;
        if (pay) s -= Math.max(0, pay - (p.life - this.lifeFloor(p)) / 3);
      }
      if (i.holdUnlessLethal) { const lethal = opp.some((q) => q.life <= this.scaleDamage(p.seat, q.seat, 4)); if (!lethal) return -1; s += 30; }
      if (i.redirect) return -1;
      if (from === 'citadel' || from === 'valgavoth') s += 4;
      if (from === 'dash') { if (!opp.length) return -1; s += 1; }
      if (from === 'channel' && i.channel.fx.some((f) => f.k === 'regrowType')) { const best = Math.max(0, ...p.gy.filter((x) => x.info.isCreature || x.info.isPW).map((x) => this.cardValue(p, x))); if (best < 8 || p.hand.filter((x) => x.info.isLand).length + p.bf.filter((x) => x.info.isLand).length < 6) return -1; s = 8 + best; }
      else if (from === 'channel') { const f = i.channel.fx[0]; if (!f) return -1; const t = this.bestOppTarget(p, (x) => (f.what === 'artench' ? (x.info.types.has('Artifact') || x.info.types.has('Enchantment')) : !x.info.isLand) && this.targetable(x, p)); if (!t || this.permValue(t) < 8 || p.hand.filter((x) => x.info.isLand).length + p.bf.filter((x) => x.info.isLand).length < 5) return -1; s = 10 + this.permValue(t); }
      if (from === 'prepared') s = 30;
      if (from === 'transmute') { const t = this.transmuteFind(p, c); if (!t) return -1; const gain = this.cardValue(p, t) - this.cardValue(p, c); if (gain < 3) return -1; s = 4 + gain; }
      if (!this.payAdditional(p, c, false)) return -1;
      if (!i.isPermanent && fx.length === 0) s = 1; // unmodeled spell: cast it last
      // the neural network's opinion: how much casting this now moves our chance to win
      // (with unlimited mana a spell costs nothing, so the network's view of spending on it doesn't apply)
      if (this.nnOn(p) && p.infMana !== this.turn) { const adv = this.nnAdv(p, c, from); s += adv * Game.NN_WEIGHT; if (this.record) c._nnAdv = adv; }
      if (this.completesCombo(p, c)) s += 60;
      else if (this.comboWants(p).some((w) => w.missing.some((m) => m.name === c.name))) s += 15;
      // an Aura needs something to enchant (Pattern of Rebirth with no creature of ours is not castable)
      if (i.ghostform && !p.bf.some((x) => (x.info.isCreature || x.info.isPW) && this.permValue(x) >= 6)) return -1;
      if (i.isAura && !i.reanimAura && !i.ghostform) {
        if (i.statics.some((x) => x.k === 'pacify')) { if (!this.bestOppTarget(p, (x) => x.info.isCreature && this.targetable(x, p))) return -1; }
        else if (!p.bf.some((x) => x.info.isCreature)) return -1;
      }
      if (i.reanimAura && !this.alive().some((q) => q.gy.some((x) => x.info.isCreature && !x.isCommander))) return -1;
      if (i.isEquipment && !p.bf.some((x) => x.info.isCreature)) s -= 4;
      return s;
    }

    castSpell(p, c, from, gyType) {
      const i = c.info;
      if (from !== 'channel' && from !== 'transmute' && this.briselaLock(p, c)) return false;
      const sample = this.collect ? this.nnSample(p, c, from) : null;
      let cost = this.costFor(p, c, from);
      const delveN = i.delve ? c._delveN || 0 : 0;
      let xVal = 0;
      if (p.lost || this.over) return false; // a player who has lost takes no more actions
      if (cost.x) { xVal = this.maxX(p, cost); if (i.spell.some((f) => f.k === 'genesis' && !f.majestic)) xVal = this.genesisX(p, xVal); if (xVal < this.minX(c)) return false; }
      if (from === 'prepared') {
        if (!this.pay(p, cost, 0, true)) return false;
        c.prepared = false;
        this.emit('cast', `${p.name} casts ${i.prepared.name} from the prepared ${i.name}.`, { seat: p.seat, cards: [c.id] });
        this.resolveEffects(p, i.prepared.fx, c, null, false);
        return true;
      }
      if (from === 'transmute') {
        // transmute: discard it and search for a card with the same mana value (sorcery speed)
        const pick = this.transmuteFind(p, c); if (!pick || !this.pay(p, cost, 0, true)) return false;
        this.discardCard(p, c); this.searched(p); this.removeFrom(p.library, pick); pick.zone = 'hand'; p.hand.push(pick); this.R.shuffle(p.library);
        this.emit('tutor', `${p.name} transmutes ${i.name} for ${pick.info.name}.`, { seat: p.seat, cards: [c.id, pick.id] });
        return true;
      }
      if (from === 'channel') {
        if (!this.pay(p, cost, 0, true)) return false;
        this.discardCard(p, c);
        this.emit('cast', `${p.name} channels ${i.name}.`, { seat: p.seat, cards: [c.id] });
        this.resolveEffects(p, i.channel.fx, c, null, false);
        return true;
      }
      if (!this.payAdditional(p, c, true)) return false;
      const overload = i.overload && this.pay(p, i.overload);
      if (overload && this.opps(p).some((q) => this.playerThreat(q) > 20)) cost = i.overload;
      const useAlt = !!i.altCost && this.altChosen(p, c, from); // (decided before the mana is spent)
      if (!this.pay(p, cost, xVal, true)) return false;
      if (useAlt) { this.payAltCost(p, c); if (p.lost || this.over) return true; }
      if (delveN) { // the least useful cards go: not creatures (reanimation targets), not lands we might replay
        const ex = p.gy.filter((x) => x !== c).sort((a, b) => (a.info.isCreature ? 10 : 0) + (a.info.isLand ? 3 : 0) + (a.info.mv || 0) * 0.3 - ((b.info.isCreature ? 10 : 0) + (b.info.isLand ? 3 : 0) + (b.info.mv || 0) * 0.3)).slice(0, delveN);
        for (const x of ex) { this.removeFrom(p.gy, x); x.zone = 'exile'; p.exile.push(x); }
        this.emit('effect', `${p.name} delves ${ex.length} card${ex.length > 1 ? 's' : ''} from the graveyard to cast ${i.name}.`, { seat: p.seat, cards: [c.id] });
      }
      let colorsSpent = Math.min(i.mv || 0, new Set(((this.pendingMana && this.pendingMana.spent) || []).filter((x) => COLORS.includes(x))).size);
      if (i.converge && this.pendingMana) { // converge: the payer picks the colours, so count the most different colours the sources used could have made
        const opts = (this.pendingMana.sources || []).map((id) => this.cards[id]).filter((x) => x && x.info.mana).map((x) => x.info.mana.opts.flatMap((o) => o.colors).filter((k) => COLORS.includes(k)));
        let best = 0; const go = (k, used) => { best = Math.max(best, used.size); if (k >= opts.length || best >= 5) return; for (const col of opts[k]) if (!used.has(col)) { used.add(col); go(k + 1, used); used.delete(col); } go(k + 1, used); };
        go(0, new Set()); colorsSpent = Math.min(i.mv || 0, Math.max(colorsSpent, best));
      }
      if (i.isCreature && this.pendingMana && this.pendingMana.sources.some((id) => this.cards[id] && this.cards[id].info.name === 'Hall of the Bandit Lord')) c.hallHaste = true;
      // paying can set things off (Mana Confluence's life loss into an Exquisite Blood loop) that end the game
      if (p.lost || this.over) return true;
      let kicks = 0;
      if (i.multikicker) while (kicks < 4 && this.pay(p, parseCost(String(i.multikicker)))) { this.pay(p, parseCost(String(i.multikicker)), 0, true); kicks++; }
      if (from === 'hand') this.removeFrom(p.hand, c);
      else if (from === 'command') { this.removeFrom(p.command, c); p.tax++; }
      else if (from === 'gy') { this.removeFrom(p.gy, c); p.gyCastTypes.add(gyType); }
      else if (from === 'citadel' || from === 'top') { this.removeFrom(p.library, c); if (from === 'citadel') this.loseLife(p, i.mv); }
      else if (from === 'valgavoth') { this.removeFrom(this.P(c.owner).exile, c); c.voidBy = null; this.loseLife(p, i.mv); }
      else if (from === 'dash' || from === 'miracle') { this.removeFrom(p.hand, c); }
      else if (from === 'flashback') { this.removeFrom(p.gy, c); c.flashedBack = true; }
      if (p.lost || this.over) { c.zone = 'exile'; this.P(c.owner).exile.push(c); return true; } // paying life (Citadel, Valgavoth) set off something that ended them
      c.zone = 'stack';
      this.casts.push({ seat: p.seat, name: c.name, turn: this.round, id: c.id });
      if (sample) this.samples.push(sample);
      { const st = this.stats[c.id] || (this.stats[c.id] = { name: c.name, seat: c.owner }); if (st.cast == null) st.cast = this.round; }
      p.spellsThisTurn = (p.spellsThisTurn || 0) + 1;
      if (!i.isCreature) p.nonCreatureSpells = (p.nonCreatureSpells || 0) + 1;
      if (!i.isCreature && p.nonCreatureSpells === 1) for (const q of this.opps(p)) for (const s2 of q.bf) if (s2.info.triggers.some((t) => t.k === 'queenRecruit')) this.recruit(q, s2);
      if (!i.types.has('Artifact')) p.nonArtifactSpells = (p.nonArtifactSpells || 0) + 1;
      const fromTxt = { flashback: ' with flashback', command: ' from the command zone', gy: ' from the graveyard', citadel: ' off the top with Bolas\'s Citadel', top: ' off the top with Mystic Forge', valgavoth: ' from Valgavoth\'s exile', dash: ' for its dash cost' }[from] || '';
      this.emit('cast', `${p.name} casts ${i.name}${xVal ? ` (X=${xVal})` : ''}${kicks ? ` kicked ${kicks}×` : ''}${fromTxt}.`, { seat: p.seat, cards: [c.id], stack: [c.id], nnAdv: c._nnAdv });
      c._nnAdv = undefined;
      this.castTriggers(p, c, from);
      // Jace emblem: counter each opponent's first spell each turn
      const jace = this.opps(p).find((q) => (q.emblems || []).includes('jaceCounter'));
      let countered = jace && p.spellsThisTurn === 1 && !i.uncounterable;
      if (countered) this.emit('counter', `${jace.name}'s Jace emblem counters ${i.name}.`, { seat: jace.seat, cards: [c.id] });
      // opponents respond
      const cavern = i.isCreature && p.bf.some((x) => x.info.cavern && x.chosenType && this.isType(c, x.chosenType));
      if (countered || (!i.uncounterable && !cavern && this.tryCounter(p, c))) {
        if (c.isCommander) { c.zone = 'command'; p.command.push(c); }
        else if (this._counterExile) { c.zone = 'exile'; this.P(c.owner).exile.push(c); }
        else if (this._counterBounce) { c.zone = 'hand'; this.P(c.owner).hand.push(c); }
        else this.toGraveyard(c, p.seat);
        this._counterExile = false; this._counterBounce = false;
        return true;
      }
      if (i.isPermanent) {
        this.enterBattlefield(c, p, { xVal, kicks, colorsSpent });
        if (from === 'dash') { c.dashed = true; c.eot.kw.push('haste'); }
        if (i.etb.length && xVal) { /* X handled in effects */ }
      } else {
        const fx = overload ? i.spell.filter((f) => f.k !== 'removal').concat(cost === i.overload ? [{ k: 'massBounce' }] : i.spell.filter((f) => f.k === 'removal')) : i.spree ? (c._spree || []).flatMap((m) => m.fx) : i.spell; // (spree: the modes chosen when the cost was set)
        this.resolveEffects(p, fx, c, null, false, xVal);
        if (c.zone === 'stack') { if (c.flashedBack || /exile .* protection/i.test(i.text)) { c.zone = 'exile'; this.P(c.owner).exile.push(c); c.flashedBack = false; } else this.toGraveyard(c, p.seat); }
      }
      this.checkState();
      this.checkCombos(p);
      return true;
    }

    // Additional costs (discard, sacrifice, life). check=true only tests whether they can be paid.
    payAdditional(p, c, commit) {
      const k = c.info.addCost;
      if (!k) return true;
      const others = p.hand.filter((x) => x !== c);
      if (k === 'discard1' || k === 'discard2') { const n = k === 'discard2' ? 2 : 1; if (others.length < n) return false; if (commit) for (let i = 0; i < n; i++) { const d = others.filter((x) => p.hand.includes(x)).sort((a, b) => this.cardValue(p, a) - this.cardValue(p, b))[0]; this.discardCard(p, d); } return true; }
      if (k === 'discardOrLife3') { if (this.canPayLife(p, 3)) { if (commit) this.loseLife(p, 3); return true; } if (!others.length) return false; if (commit) { const d = others.slice().sort((a, b) => this.cardValue(p, a) - this.cardValue(p, b))[0]; this.discardCard(p, d); } return true; }
      if (k === 'sacCreature') { const f = p.bf.filter((x) => x.info.isCreature && !x.isCommander).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0]; if (!f || this.creatureValue(f) > 6) return false; if (commit) this.destroy(f, 'sacrificed', true); return true; }
      if (k.startsWith('exileGy:')) { const n = +k.split(':')[1]; if (p.gy.length < n) return false; if (commit) { const ex = p.gy.slice().sort((a, b) => (a.info.isCreature ? 10 : 0) + (a.info.mv || 0) * 0.3 - ((b.info.isCreature ? 10 : 0) + (b.info.mv || 0) * 0.3)).slice(0, n); for (const x of ex) { this.removeFrom(p.gy, x); x.zone = 'exile'; p.exile.push(x); } } return true; } // (Abhorrent Oculus)
      if (k === 'sacLand') { const f = p.bf.filter((x) => x.info.isLand).sort((a, b) => this.landKeep(p, a) - this.landKeep(p, b))[0]; if (!f) return false; if (commit) this.destroy(f, 'sacrificed', true); return true; }
      return true;
    }

    castTriggers(p, c, from) {
      const i = c.info;
      if (i.castSelf) this.resolveEffects(p, i.castSelf, c, null, true); // "when you cast this spell" (Bruna)
      if (from === 'gy') for (const s of p.bf) for (const t of s.info.triggers) if (t.k === 'gyCast') this.resolveEffects(p, t.fx, s, null, true);
      if (i.isCreature) for (const b of p.bf) if (b.info.banner && b.chosenType && this.isType(c, b.chosenType)) { this.draw(p, 1); this.emit('draw', `Vanquisher's Banner: ${p.name} draws a card.`, { seat: p.seat, cards: [b.id] }); }
      // Ledger Shredder: whenever a player casts their second spell each turn
      if (p.spellsThisTurn === 2) for (const q of this.alive()) for (const s of q.bf) for (const t of s.info.triggers) if (t.k === 'connive') this.connive(q, s);
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
        else if (/colorless/.test(f)) ok = i.colors.size === 0;
        else if (!f.trim()) ok = true;
        else { const sub = cap(f.split(' ')[0]); ok = (i.subtypes || []).includes(sub); }
        if (ok) { if (t.fx.some((f) => f.k === 'tokens')) this.emit('trigger', `${s.info.name} triggers off ${i.name}${s.zone === 'command' ? ' (from the command zone)' : ''}.`, { seat: p.seat, cards: [s.id] }); this.resolveEffects(p, t.fx, s, null, false); }
      }
      // opponents' Rhystic Study / Esper Sentinel
      for (const q of this.opps(p)) for (const s of q.bf) for (const t of s.info.triggers) {
        const firstNonCreature = t.k === 'sentinel' && !i.isCreature && (p.nonCreatureSpells || 0) === 1;
        if (t.k === 'rhystic' || firstNonCreature) {
          const tax = t.k === 'sentinel' ? Math.max(0, this.power(s)) : 1;
          if (tax === 0 || (this.availableMana(p) >= tax && this.R() < 0.6 && this.pay(p, parseCost(String(tax))))) { if (tax) this.pay(p, parseCost(String(tax)), 0, true); continue; }
          this.draw(q, 1);
          this.emit('draw', `${q.name} draws off ${s.info.name}.`, { seat: q.seat, cards: [s.id] });
        }
      }
    }

    // recruit: draw a card, discard a card; a nonland discard makes a 1/1 Human Soldier
    recruit(q, s) {
      this.draw(q, 1);
      const d = q.hand.slice().sort((a, b) => this.cardValue(q, a) - this.cardValue(q, b))[0];
      if (!d) return;
      this.discardCard(q, d);
      if (!d.info.isLand) this.addToken(q, { p: 1, t: 1, sub: 'Human Soldier', colors: 'white' }, 1, true);
      this.emit('draw', `${s.info.name}: ${q.name} recruits${d.info.isLand ? '' : ' and makes a Human Soldier'}.`, { seat: q.seat, cards: [s.id] });
    }
    // connive n: draw n, discard n (the worst), a +1/+1 counter for each nonland card discarded
    connive(q, s, n = 1) {
      this.emit('draw', `${s.info.name} connives${n > 1 ? ' ' + n : ''}.`, { seat: q.seat, cards: [s.id] });
      this.draw(q, n);
      const ds = q.hand.slice().sort((a, b) => this.cardValue(q, a) - this.cardValue(q, b)).slice(0, n);
      let nonland = 0;
      for (const d of ds) { this.discardCard(q, d); if (!d.info.isLand) nonland++; }
      if (nonland && s.zone === 'bf') s.p1 += this.counterAmount(q, nonland);
    }

    tryCounter(p, c) {
      const i = c.info;
      const value = (i.mv || 0) + (c.isCommander ? 4 : 0) + (i.spell.some((f) => f.k === 'wipe' || f.k === 'massBounce') ? 10 : 0) + (i.triggers.some((t) => t.k === 'bond' || t.k === 'exquisite') ? 6 : 0) + (i.spell.some((f) => f.k === 'tutor') ? 2 : 0);
      const combo = this.completesCombo(p, c) ? 14 : 0;
      if (value + combo < 5) return false;
      if (this.has(p, 'abolisher') && this.active === p.seat) return false;
      for (const q of this.opps(p)) {
        if (this.abolished(q)) continue;
        for (const perm of q.bf) {
          const ab = perm.info.activated.find((a) => a.fx.some((x) => x.k === 'counter'));
          if (!ab || (ab.tap && perm.tapped)) continue;
          const f = ab.fx.find((x) => x.k === 'counter');
          if (f.filter === 'noncreature' && i.isCreature) continue;
          if (ab.cost.mv && !this.pay(q, ab.cost)) continue;
          if (this.R() > Math.min(0.95, 0.35 + (value + combo) * 0.06)) continue;
          if (ab.cost.mv) this.pay(q, ab.cost, 0, true);
          if (ab.sac) this.destroy(perm, 'sacrificed', true);
          this.credit(perm, 'countered', 1);
          this.emit('counter', `${q.name} counters ${i.name} with ${perm.info.name}!`, { seat: q.seat, cards: [perm.id, c.id], target: p.seat });
          return true;
        }
        for (const cs of q.hand) {
          const f = cs.info.spell.find((x) => x.k === 'counter');
          if (!f || this.briselaLock(q, cs)) continue;
          const okType = !f.filter || (f.filter === 'colorless' && !(i.colors && i.colors.size)) || (f.filter === 'noncreature' && !i.isCreature) || (f.filter === 'creature' && i.isCreature) || (f.filter.includes('instant') && (i.isInstant || i.isSorcery || (f.filter.includes('enchantment') && i.types.has('Enchantment'))));
          if (!okType) continue;
          // the mana, or the alternative cost (free with a commander out; otherwise only when the mana isn't there)
          const canMana = this.pay(q, cs.info.cost);
          const free = cs.info.altCost ? this.altCostOk(q, cs) && (cs.info.altCost.kind === 'commander' || !canMana) : false;
          if (!free && !canMana) continue;
          // the more dangerous the spell, the more likely they fire
          const chance = Math.min(0.95, 0.35 + (value + combo) * 0.06);
          if (this.R() > chance) continue;
          if (free) this.payAltCost(q, cs);
          else this.pay(q, cs.info.cost, 0, true);
          this.removeFrom(q.hand, cs); this.toGraveyard(cs, q.seat);
          this._counterExile = /exile it instead/i.test(cs.info.text);
          this._counterBounce = !!f.bounce;
          this.credit(cs, 'countered', 1);
          this.emit('counter', f.bounce ? `${q.name} returns ${i.name} to ${this.P(c.owner).name}'s hand with ${cs.info.name}!` : `${q.name} counters ${i.name} with ${cs.info.name}!`, { seat: q.seat, cards: [cs.id, c.id], target: p.seat });
          // the rest of the counterspell's text (Reprieve: draw a card); a bounce of a permanent is for casting it on its own
          const rest = cs.info.spell.filter((x) => x.k !== 'counter' && !(x.k === 'removal' && x.bounce));
          if (rest.length) this.resolveEffects(q, rest, cs, null, true);
          if (/mana drain/i.test(cs.info.name)) q.drainMana = (q.drainMana || 0) + (i.mv || 0);
          if (/its controller creates a 2\/2 blue bird/i.test(cs.info.text)) this.addToken(p, { p: 2, t: 2, sub: 'Bird', kw: ['flying'], colors: 'blue' }, 1, true);
          return true;
        }
      }
      return false;
    }

    // ----- turn structure -----
    // one step toward the runaway limits: STEP_LIMIT payments/permanents/walker uses, and TIME_LIMIT ms of wall clock
    tick() {
      if (++this.steps > Game.STEP_LIMIT) throw new Runaway();
      if ((this.steps & 255) === 0) this.checkTime();
    }
    checkTime() { if (this.deadline && Date.now() > this.deadline) throw new TimeUp(); }
    run() {
      if (Game.TIME_LIMIT) this.deadline = Date.now() + Game.TIME_LIMIT;
      this.emit('start', `Seats shuffled. ${this.players.map((p) => p.name).join(', ')} sit down.`);
      for (const p of this.players) { this.R.shuffle(p.library); this.openingHand(p); }
      this.active = this.R.int(4);
      this.started = true;
      this.emit('start', `${this.P(this.active).name} goes first.`, { seat: this.active });
      try { this.loop(); } catch (e) {
        if (!(e instanceof Runaway)) throw e;
        this.over = true; this.winner = null; this.timeout = true; this.runaway = true;
        this.emit('win', e instanceof TimeUp ? `Game stopped: it ran over ${Game.TIME_LIMIT / 1000}s (the AI was stuck thinking in a loop). Called a draw.` : `Game stopped: the AI got stuck repeating an action (${Game.STEP_LIMIT.toLocaleString()} payments and permanents). Called a draw.`);
      }
      return this;
    }
    loop() {
      let first = true;
      let lastSeat = -1;
      const order = (seat) => (seat - this.startSeat + 4) % 4;
      while (!this.over) {
        this.checkTime();
        const p = this.P(this.active);
        if (!p.lost) {
          if (lastSeat < 0 || order(this.active) <= order(lastSeat)) this.round++;
          lastSeat = this.active;
          if (p.skipNext) { p.skipNext = false; this.emit('turn', `${p.name}'s turn is skipped (Sorin Markov controls it).`, { seat: p.seat }); }
          else this.takeTurn(p, first);
          first = false;
          while (p.extraTurn && !p.lost && !this.over) {
            p.extraTurn--;
            const nexus = this.alive().find((q) => this.has(q, 'nexus'));
            if (nexus) { this.emit('effect', `Ugin's Nexus: ${p.name} skips the extra turn.`, { seat: nexus.seat }); continue; }
            this.takeTurn(p, false);
          }
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

    // ----- mulligans -----
    // What this deck wants in an opening hand: lands in its colours, acceleration, early plays,
    // a way to its commander, and the pieces of its game plan (combos, tutors, engines, tribe).
    handPlan(p) {
      if (p.plan) return p.plan;
      const all = p.library.concat(p.hand, p.command);
      const cmd = p.commanderCard.info;
      const subCount = {};
      for (const c of all) if (c.info.isCreature) for (const t of c.info.subtypes || []) subCount[t] = (subCount[t] || 0) + 1;
      const tribe = Object.entries(subCount).filter(([t]) => (cmd.subtypes || []).includes(t) || /Vampire|Angel|Demon|Dragon/.test(t)).sort((a, b) => b[1] - a[1])[0];
      const comboNames = new Set(COMBOS.filter((cb) => cb.pieces.every((alts) => alts.some((n) => all.some((c) => c.name === n)))).flatMap((cb) => cb.pieces.flat()));
      p.plan = { tribe: tribe && tribe[1] >= 8 ? tribe[0] : null, combo: comboNames, cmdMv: cmd.mv, colors: p.colors };
      return p.plan;
    }
    scoreHand(p, hand) {
      const plan = this.handPlan(p);
      const lands = hand.filter((c) => c.info.isLand || c.info.mdfcLand);
      const spells = hand.filter((c) => !c.info.isLand && !c.info.mdfcLand);
      const ramp = spells.filter((c) => c.info.mana || (c.info.isPermanent ? c.info.etb : c.info.spell).some((f) => f.k === 'ramp' || f.k === 'ritual' || f.k === 'treasure'));
      const cheap = spells.filter((c) => c.info.mv <= 2);
      const tutors = spells.filter((c) => (c.info.isPermanent ? c.info.etb : c.info.spell).some((f) => f.k === 'tutor' || f.k === 'search' || f.k === 'tutorBF'));
      const draw = spells.filter((c) => c.info.triggers.some((t) => /rhystic|tithe|drawGain/.test(t.k)) || c.info.upkeep.some((u) => u.fx.some((f) => f.k === 'draw')) || c.info.castTrig.some((t) => t.fx.some((f) => f.k === 'draw')));
      const combo = spells.filter((c) => plan.combo.has(c.name));
      const tribal = plan.tribe ? spells.filter((c) => this.isSubtype({ info: c.info }, plan.tribe)).length : 0;
      const colors = new Set();
      for (const c of lands.concat(ramp)) for (const o of ((c.info.mdfcLand || c.info).mana || { opts: [] }).opts) o.colors.forEach((x) => colors.add(x));
      for (const c of lands) if (c.info.fetch) plan.colors.forEach((x) => colors.add(x));
      const covered = plan.colors.filter((x) => colors.has(x)).length / Math.max(1, plan.colors.length);
      const L = lands.length, R = Math.min(ramp.length, 3);
      let score = 0; const why = [];
      if (L <= 1) { score -= 25; why.push(`${L} land`); }
      else if (L === 2) { score += R ? 6 : -4; why.push(R ? '2 lands + ramp' : 'only 2 lands'); }
      else if (L <= 4) { score += 10; why.push(`${L} lands`); }
      else if (L === 5) { score += 3; why.push('5 lands'); }
      else { score -= 12; why.push(`${L} lands`); }
      score += R * 4; if (R) why.push(`${ramp.length} ramp`);
      score += Math.min(cheap.length, 3) * 1.5;
      score += covered * 6; if (covered < 0.6) why.push('missing colours');
      score += Math.min(tutors.length, 2) * 3; if (tutors.length) why.push(`${tutors.length} tutor${tutors.length > 1 ? 's' : ''}`);
      score += Math.min(draw.length, 2) * 2.5; if (draw.length) why.push('card draw');
      score += Math.min(combo.length, 2) * 3; if (combo.length) why.push('combo piece');
      score += Math.min(tribal, 3) * 1.5; if (tribal >= 2) why.push(`${tribal} ${plan.tribe}s`);
      if (L + R >= Math.min(plan.cmdMv, 5) - 1) { score += 3; }
      // the mulligan network: predicted win chance with this hand compared with the deck's average
      if (this.nnOn(p) && this.nn.m) {
        const x = this.nnHand(p, hand, p._mulls || 0); const pw = this.nn.m.forward(x.d, x.s); const base = this.nn.base[p.deckId] || 0.25;
        score += Math.max(-10, Math.min(10, (pw - base) * 60));
        p._handNN = pw;
        if (pw - base > 0.04) why.push(`network likes it (${Math.round(pw * 100)}%)`); else if (pw - base < -0.04) why.push(`network doubts it (${Math.round(pw * 100)}%)`);
      }
      if (spells.every((c) => c.info.mv >= 5) && spells.length) { score -= 6; why.push('all expensive'); }
      return { score, why };
    }
    // Choose which cards go to the bottom after a mulligan (London rules)
    bottomCards(p, n) {
      for (let i = 0; i < n; i++) {
        const lands = p.hand.filter((c) => c.info.isLand).length;
        const pool = p.hand.slice().sort((a, b) => {
          const v = (c) => (c.info.isLand ? (lands > 4 ? 0 : 20) : 10 + this.nnAdv(p, c) * 50 + this.cardValue(p, c) - Math.max(0, c.info.mv - 4) * 2 + (this.handPlan(p).combo.has(c.name) ? 8 : 0));
          return v(a) - v(b);
        });
        const worst = pool[0];
        this.removeFrom(p.hand, worst); worst.zone = 'library'; p.library.push(worst);
      }
    }
    openingHand(p) {
      this.draw(p, 7);
      let mulls = 0;
      const lands = () => p.hand.filter((c) => c.info.isLand || c.info.mdfcLand).length;
      for (;;) {
        p._mulls = mulls;
        const { score, why } = this.scoreHand(p, p.hand);
        const need = [16, 13, 9, 0][Math.min(mulls, 3)];
        if (score >= need || mulls >= 3) { p.keepWhy = why; p.keepScore = Math.round(score); break; }
        this.emit('mulligan', `${p.name} mulligans (${why.join(', ')}).`, { seat: p.seat });
        p.library.push(...p.hand.map((c) => ((c.zone = 'library'), c))); p.hand = [];
        this.R.shuffle(p.library); this.draw(p, 7); mulls++;
      }
      // first mulligan is free in multiplayer; after that, one card per mulligan goes to the bottom
      if (mulls > 1) this.bottomCards(p, mulls - 1);
      p.cardsDrawn = 0;
      if (this.collect) this.mullSamples.push({ seat: p.seat, deck: p.deckId, ...this.nnHand(p, p.hand, mulls), names: p.hand.map((c) => c.name) });
      this.emit('mulligan', `${p.name} keeps ${p.hand.length}${mulls ? ` after ${mulls} mulligan${mulls > 1 ? 's' : ''}` : ''}: ${p.keepWhy.join(', ')}.`, { seat: p.seat });
    }

    get startSeat() { if (this._start == null) this._start = this.active; return this._start; }

    // Mana empties from every pool when a step or phase ends
    addFloating(p, color, n) { if (n > 0) { p.floating = p.floating || {}; p.floating[color] = (p.floating[color] || 0) + n; } }
    emptyPools() { for (const q of this.players) { q.floating = {}; q.pool = 0; } this.pendingMana = null; }
    takeTurn(p, first) {
      this.emptyPools();
      this.turn++;
      this.phase = 'untap';
      for (const q of this.players) { q.nonCreatureSpells = 0; q.spellsThisTurn = 0; } // "each turn" counts restart for everyone
      p.landsPlayed = 0; p.gyCastTypes = new Set(); p.pool = 0; p.spellsThisTurn = 0; p.nonArtifactSpells = 0; p.walkerUses = 0; p.silencedBy = null;
      this.deathsThisTurn = 0;
      if (p.protectedUntil < this.turn) p.protectedUntil = -1;
      // phased-out permanents return
      if (p.phased && p.phased.length) { this._phasedIn = true; for (const c of p.phased) { c.zone = 'bf'; this.P(c.ctrl).bf.push(c); } this.emit('effect', `${p.phased.length} permanent${p.phased.length > 1 ? 's' : ''} phase back in for ${p.name}.`, { seat: p.seat }); p.phased = []; }
      for (const q of this.players) for (const c of q.bf) if (c.phasedOwnerTurn === p.seat) { c.phasedOwnerTurn = null; }
      if (this._phasedIn) { this._phasedIn = false; this.checkState(); } // what phased back in is checked at once (a 0/0 token dies)
      const inspired = p.bf.filter((c) => c.info.inspiredTutor && c.tapped);
      for (const c of p.bf) {
        if (!c.info.noUntap && !(c.frozenUntil && c.frozenUntil > this.turn)) c.tapped = false;
        c.sick = false;
        if (c.neutralized && c.neutralizedBy === p.seat) c.neutralized = 0;
        if (c.animatedUntilTurnOf === p.seat) { this.restoreInfo(c); c.animatedUntilTurnOf = null; for (const e of this.allBf()) if (e.info.isEquipment && e.attached === c.id && !c.info.isCreature) e.attached = null; } // (equipment falls off a creature that stops being one)
      }
      // Disciple of Deceit (inspired): untapping, trade the weakest nonland card for the best card of the same mana value
      for (const d of inspired) {
        const pick = p.hand.filter((x) => !x.info.isLand).map((x) => ({ x, best: p.library.filter((y) => (y.info.mv || 0) === (x.info.mv || 0) && !y.info.isLand).sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a))[0] }))
          .filter((o) => o.best && this.cardValue(p, o.best) > this.cardValue(p, o.x) + 3).sort((a, b) => this.cardValue(p, a.x) - this.cardValue(p, b.x))[0];
        if (!pick) continue;
        this.discardCard(p, pick.x); this.removeFrom(p.library, pick.best); pick.best.zone = 'hand'; p.hand.push(pick.best); this.R.shuffle(p.library);
        this.emit('tutor', `${d.info.name}: ${p.name} discards ${pick.x.info.name} and finds ${pick.best.info.name}.`, { seat: p.seat, cards: [d.id] });
      }
      // Unwinding Clock: untap artifacts during each other player's untap step
      for (const q of this.opps(p)) if (this.has(q, 'unwinding')) for (const c of q.bf) if (c.info.types.has('Artifact')) c.tapped = false;
      for (const q of this.players) if (q.emblemShield && q.emblemShield === p.seat) q.emblemShield = null;
      for (const q of this.players) for (const c of q.bf) { if (c.vraskaShield === p.seat) c.vraskaShield = null; if (c.tamiyoBy === p.seat) c.tamiyoBy = null; }
      this.emit('turn', `Turn ${this.round}: ${p.name}`, { seat: p.seat });
      // upkeep
      this.phase = 'upkeep';
      if (this.delayedDraws && this.delayedDraws.length) { const d = this.delayedDraws; this.delayedDraws = []; for (const s of d) if (!this.P(s).lost) { this.draw(this.P(s), 1); this.emit('draw', `${this.P(s).name} draws a card (Mishra's Bauble).`, { seat: s }); } }
      for (const c of [...p.bf]) {
        if (c.info.vault && c.tapped && this.pay(p, parseCost('4')) && this.availableMana(p) >= 8) { this.pay(p, parseCost('4'), 0, true); c.tapped = false; }
        if (c.info.cumulativeLife) {
          c.age = (c.age || 0) + 1;
          const cost = c.age * c.info.cumulativeLife;
          if (this.canPayLife(p, cost) && this.worthKeeping(p, c, cost)) { this.loseLife(p, cost); this.emit('effect', `${p.name} pays ${cost} life to keep ${c.info.name}.`, { seat: p.seat, cards: [c.id] }); }
          else { this.destroy(c, 'sacrificed', true); this.emit('effect', `${p.name} lets ${c.info.name} go.`, { seat: p.seat, cards: [c.id] }); }
        }
        if (c.harnessed && c.info.harness.upkeep) this.resolveEffects(p, c.info.harness.upkeep, c, `${c.info.name} (harnessed)`);
      }
      for (const q of this.alive()) for (const c of [...q.bf]) for (const u of c.info.upkeep) {
        if (u.opp) { if (q === p) continue; this._thatPlayer = p; this.resolveEffects(q, u.fx, c, null, true); this._thatPlayer = null; continue; }
        if (!u.each && q !== p) continue;
        if (u.lose && !u.fx.some((f) => f.k === 'loseSelf')) this.loseLife(q, u.lose); // (not twice when the effect list already has it)
        this.resolveEffects(q, u.fx, c, u.fx.length ? `${c.info.name} triggers` : null, true);
      }
      this.checkState(); if (p.lost || this.over) return;
      // draw
      this.phase = 'draw';
      for (const c of p.bf) if (c.info.vault && c.tapped) this.loseLife(p, 1);
      if (!first) {
        this.inDrawStep = true;
        if (this.has(p, 'necro')) { /* skip draw */ } else this.draw(p, 1);
        this.inDrawStep = false;
        if (p.bf.some((c) => c.name === 'Sylvan Library') && p.library.length >= 2) {
          const before = new Set(p.hand);
          this.draw(p, 2);
          const drawn = p.hand.filter((c) => !before.has(c));
          // of all the cards drawn this turn, keep the best; for each of the two extra we keep, pay 4 life
          const thisTurn = drawn.concat(p.hand.filter((c) => before.has(c)).slice(-1));
          const ranked = thisTurn.slice().sort((a, b) => this.cardValue(p, b) - this.cardValue(p, a));
          let paid = 0;
          const back = ranked.slice(1).filter((c) => { if (this.cardValue(p, c) >= 8 && this.canPayLife(p, 4 * (paid + 1))) { paid++; return false; } return true; }).slice(0, 2);
          for (const c of back.reverse()) { this.removeFrom(p.hand, c); c.zone = 'library'; p.library.unshift(c); }
          if (paid) this.loseLife(p, 4 * paid);
          this.emit('draw', `Sylvan Library: ${p.name} draws two extra and ${paid ? `pays ${4 * paid} life to keep ${paid}` : 'puts two back'}.`, { seat: p.seat });
        }
      }
      if (this.has(p, 'necro') && this.canPayLife(p, 1)) { const n = Math.min(6, Math.max(0, Math.floor(p.life - this.lifeFloor(p) - 1)));
        if (n > 0) { this.loseLife(p, n); const got = p.library.splice(0, n); for (const c of got) { c.zone = 'exile'; } p.necroPending = (p.necroPending || []).concat(got); this.emit('draw', `${p.name} pays ${n} life to Necropotence (cards arrive at end of turn).`, { seat: p.seat }); } }
      for (const c of [...p.bf]) if (c.info.saga) {
        c.lore = (c.lore || 0) + 1;
        if (c.lore === 2) c.sagaConstructs = true;
        if (c.lore >= 3) { this.resolveEffect(p, { k: 'search', n: 1, what: 'artifact', mvMax: 1, dest: 'bf', noX: true }, c, 0, false); this.destroy(c, 'sacrificed', true); }
      }
      if (p.lost || this.over) return;
      // main 1
      this.phase = 'main';
      for (const c of [...p.bf]) if (c.info.bmc) this.blackMarket(p, c);
      this.checkState(); if (p.lost || this.over) return;
      this.restOfTurn(p, 'main');
    }
    // Cumulative upkeep: keep paying only if the turn goes better with the card than without it. Played out both ways
    // on copies to the start of our next turn (Glacial Chasm stops our own attacks: with a winning board, let it go).
    worthKeeping(p, c, cost) {
      if (!this.lookahead || this._inLook) return true;
      const val = (keep) => {
        let t = 0;
        for (let k = 0; k < 2; k++) {
          try {
            this._lookN = (this._lookN || 0) + 1;
            const g = this.cloneForLook(), pp = g.players[p.seat], cc = g.cards[c.id];
            if (keep) g.loseLife(pp, cost); else if (cc && cc.zone === 'bf') g.destroy(cc, 'sacrificed', true);
            if (!g.over && !pp.lost) { g.checkState(); g.restOfTurn(pp, 'main'); }
            if (!g.over && !pp.lost) g.playToTurnOf(p.seat);
            t += g.lookValue(g, p.seat);
          } catch (e) { if (e instanceof TimeUp) throw e; t += keep ? 0 : -1e6; }
        }
        return t / 2;
      };
      return val(true) >= val(false) - 2;
    }
    // Play a copy on to the start of `seat`'s next turn, or the end of the game (for look-aheads past this turn)
    playToTurnOf(seat) {
      for (let guard = 0; guard < 8 && !this.over; guard++) {
        do { this.active = (this.active + 1) % this.players.length; } while (this.P(this.active).lost && !this.over);
        if (this.over || this.active === seat) break;
        this.takeTurn(this.P(this.active), false);
      }
    }
    // The turn from a given phase on (main, combat, main 2, end). The mistake-finder's judge picks up a copied game
    // mid-turn with it, so a copy finishes the turn exactly the way a real turn goes.
    restOfTurn(p, from = 'main') {
      const order = ['main', 'combat', 'main 2', 'end'], at = (ph) => order.indexOf(ph) >= order.indexOf(from);
      if (at('main')) { this.phase = 'main'; this.mainPhase(p); if (p.lost || this.over) return; }
      if (at('combat')) { this.emptyPools(); this.phase = 'combat'; this.combat(p); if (p.lost || this.over) return; }
      if (at('main 2')) { this.emptyPools(); this.phase = 'main 2'; this.mainPhase(p, true); if (p.lost || this.over) return; }
      // end step
      this.emptyPools();
      this.phase = 'end';
      for (const q of this.alive()) for (const c of [...q.bf]) for (const e of c.info.endstep) {
        if (!e.each && q !== p) continue;
        this._thatPlayer = p;
        this.resolveEffects(q, e.fx, c, null, false);
        this._thatPlayer = null;
      }
      for (const e of p.emblems || []) if (e === 'kraken') this.addToken(p, { p: 9, t: 9, sub: 'Kraken', colors: 'blue' }, 1, false);
      this.endStepDelayed(p);
      this.eotSelfSacs(p);
      // Teferi, Master of Time: its controller also uses it on other players' turns (here, at instant speed in their end step)
      for (const q of this.opps(p)) for (const c of [...q.bf]) if (c.info.anyTurnPW && c.zone === 'bf' && c.usedTurn !== this.turn && this.walkerOnce(q, c)) { c.usedTurn = this.turn; c.usedCount = 1; }
      for (const c of [...p.bf]) {
        if (c.harnessed && c.info.harness.end) this.resolveEffects(p, c.info.harness.end, c, null, false);
        if (c.info.chainVeil && !p.walkerUses && p.bf.some((x) => x.info.isPW)) this.loseLife(p, 2);
        else if (c.info.chainVeil && !p.walkerUses) this.loseLife(p, 2);
        if (c.info.prepared && !c.prepared && (this.deathsThisTurn || 0) >= 2) c.prepared = true;
        if (c.info.isCreature && c.eotSac) this.destroy(c, 'sacrificed', true);
        if (c.dashed) { c.dashed = false; this.bounce(c); }
      }
      if (p.delayedReturn && p.delayedReturn.length) { for (const c of p.delayedReturn) if (c.zone === 'gy') { this.removeFrom(this.P(c.owner).gy, c); this.enterBattlefield(c, p, { quiet: true }); } p.delayedReturn = []; }
      // Whip of Erebos: the returned creature is exiled at the beginning of the next end step
      if (p.whipExile && p.whipExile.length) { for (const c of p.whipExile) if (c.zone === 'bf') { this.emit('effect', `Whip of Erebos exiles ${c.info.name}.`, { seat: p.seat, cards: [c.id] }); this.exileCard(c); } p.whipExile = []; }
      // cards exiled "until end of turn you may play" that weren't played go away
      for (const c of [...p.hand]) if (c.impulseTurn === this.turn) { this.removeFrom(p.hand, c); c.zone = 'exile'; p.exile.push(c); c.impulseTurn = null; }
      if (p.necroPending && p.necroPending.length) { for (const c of p.necroPending) { c.zone = 'hand'; p.hand.push(c); } p.necroPending = []; }
      this.checkState(); // (what dies in the end step, and draws off it, happens before cleanup)
      // cleanup
      const max = this.has(p, 'noMaxHand') || (p.emblems || []).includes('tamiyo') ? 99 : 7;
      // a discarded land can draw a card (The Gitrog Monster) and cleanup repeats: after the first pass, discard spells so it ends at seven
      const landDraws = p.bf.some((x) => x.info.triggers.some((t) => t.k === 'landToGy'));
      for (let i = 0; i < 8 && p.hand.length > max; i++) this.discardWorst(p, p.hand.length - max, landDraws && i > 0);
      for (const c of this.allBf()) {
        c.dmg = 0; c.dt = false; c.eot = { p: 0, t: 0, kw: [] }; c.indestructibleEOT = false; c.hexproofEOT = false; c.noBlock = false;
        if (c.animatedEOT) { c.animatedEOT = false; this.restoreInfo(c); }
      }
      this.checkState();
      // something happened during cleanup (a creature died as "until end of turn" ended and drew a card): another cleanup step
      for (let i = 0; i < 8 && p.hand.length > max && !p.lost; i++) this.discardWorst(p, p.hand.length - max, landDraws && i > 0);
    }

    // The Wandering Emperor (flash): the defending player flashes her in mid-combat and exiles the best tapped attacker with her -2
    flashEmperor(q, attackers) {
      const e = q.hand.find((c) => c.info.flashPW);
      const tgt = e && attackers.filter((a) => a.zone === 'bf' && a.tapped && a.info.isCreature && this.targetable(a, q)).sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
      if (!tgt || q.lost || this.abolished(q) || !this.pay(q, this.costFor(q, e, 'hand')) || !this.castSpell(q, e, 'hand') || e.zone !== 'bf' || tgt.zone !== 'bf') return;
      const ab = e.info.loyaltyAbs.find((x) => x.delta === -2), d = -2 + (this.has(q, 'carth') ? 1 : 0);
      if (!ab || e.loyalty + d < 0) return;
      e.loyalty += d; e.usedTurn = this.turn; e.usedCount = 1; e._target = tgt;
      this.emit('ability', `${e.info.name} [-2]: ${ab.text.slice(0, 90)}`, { seat: q.seat, cards: [e.id, tgt.id] });
      this.resolveEffects(q, ab.fx, e, null, false); e._target = null; this.checkState();
    }

    // "At the beginning of the next end step": Teferi, Hero of Dominaria's +1 untaps lands, Oath of Teferi returns what it exiled
    endStepDelayed(p) {
      // meld (Gisela + Bruna -> Brisela): both owned and controlled; the partner waits in exile and follows Brisela when it leaves
      for (const gi of p.bf.filter((c) => c.info.meldWith && c.owner === p.seat && !c.transformed)) {
        const br = p.bf.find((x) => x.info.name === gi.info.meldWith && x.owner === p.seat); if (!br) continue;
        this.leaveBattlefield(br); this.removeFrom(p.bf, br); br.zone = 'exile'; p.exile.push(br);
        gi.dmg = 0; gi.tapped = false; this.transform(gi); gi.meldPartner = br.id;
        this.emit('effect', `${p.name} melds ${gi.baseInfo ? gi.baseInfo.name : 'Gisela'} and ${br.info.name} into ${gi.info.name}!`, { seat: p.seat, cards: [gi.id, br.id] });
      }
      if (p.endUntap) { let n = p.endUntap; p.endUntap = 0; for (const c of p.bf) if (n > 0 && c.info.isLand && c.tapped) { c.tapped = false; n--; } }
      if (p.oathReturn && p.oathReturn.length) { for (const c of p.oathReturn) if (c.zone === 'exile') { this.removeFrom(this.P(c.owner).exile, c); this.enterBattlefield(c, this.P(c.owner)); this.emit('effect', `${c.info.name} returns to the battlefield (Oath of Teferi).`, { seat: c.owner, cards: [c.id] }); } p.oathReturn = []; }
    }

    blackMarket(p, c) {
      const modes = [];
      // each mode costs life (1, 2, 3): only the ones we can afford without walking into lethal
      let cost = 0;
      for (const [m, n] of [['treasure', 1], ['draw', 2], ['merc', 3]]) if (this.canPayLife(p, cost + n)) { modes.push(m); cost += n; }
      for (const m of modes) {
        if (m === 'treasure') { this.addToken(p, { treasure: true }, 1, true); this.loseLife(p, 1); }
        if (m === 'draw') { this.draw(p, 1); this.loseLife(p, 2); }
        if (m === 'merc') { this.addToken(p, { p: 3, t: 2, sub: 'Shapeshifter', colors: 'colorless', kw: ['changeling'] }, 1, true); this.loseLife(p, 3); }
      }
      if (modes.length) this.emit('effect', `Black Market Connections: ${p.name} chooses ${modes.join(', ')} (loses ${modes.reduce((s2, m) => s2 + ({ treasure: 1, draw: 2, merc: 3 })[m], 0)} life).`, { seat: p.seat, cards: [c.id] });
    }

    // A land that stops our own attacks (Glacial Chasm) is played when the game goes better with it: played out both
    // ways on copies to our next turn (stopping a big attack, buying time while we build, a turn we weren't attacking
    // anyway). Without the look-ahead: only when the table can hit us for about our life.
    lockLand(c) { return c.info.statics.some((st) => st.k === 'chasm'); }
    // which land to give up first: the one making the least mana, but never one whose static ability matters
    landKeep(p, c) { return this.landValue(p, c) + (c.info.statics.length ? 8 : 0); }
    needLock(p) {
      const c = p.hand.concat(this.has(p, 'muldrotha') && !p.gyCastTypes.has('Land') ? p.gy : []).find((x) => x.info.isLand && this.lockLand(x));
      if (!c) return false;
      if (!this.lookahead || this._inLook) return p.life <= this.lifeFloor(p);
      if (p._lockCheck && p._lockCheck.turn === this.turn) return p._lockCheck.v; // once per turn
      const val = (play) => {
        let t = 0;
        for (let k = 0; k < 2; k++) {
          try {
            this._lookN = (this._lookN || 0) + 1;
            const g = this.cloneForLook(), pp = g.players[p.seat], cc = g.cards[c.id];
            if (play) { const fromGy = cc.zone === 'gy'; g.removeFrom(fromGy ? pp.gy : pp.hand, cc); if (fromGy) pp.gyCastTypes.add('Land'); pp.landsPlayed++; g.enterBattlefield(cc, pp, { quiet: true }); }
            else cc._noLock = true;
            if (!g.over && !pp.lost) g.restOfTurn(pp, g.phase === 'main 2' ? 'main 2' : 'main');
            if (!g.over && !pp.lost) g.playToTurnOf(p.seat);
            t += g.lookValue(g, p.seat);
          } catch (e) { if (e instanceof TimeUp) throw e; t += play ? -1e6 : 0; }
        }
        return t / 2;
      };
      const v = val(true) > val(false) + 2;
      p._lockCheck = { turn: this.turn, v };
      return v;
    }
    playLand(p) {
      if (p.lost || this.over) return;
      const allowed = 1 + this.statics(p, 'extraLand').reduce((s, x) => s + x.s.n, 0);
      while (p.landsPlayed < allowed) {
        const lands = p.hand.filter((c) => c.info.isLand && (!this.lockLand(c) || (!c._noLock && this.needLock(p))));
        const mdfc = p.hand.filter((c) => c.info.mdfcLand);
        let pick = null, face = null;
        if ((this.has(p, 'landsFromTop') || p.bf.some((x) => x.info.citadel)) && p.library[0] && p.library[0].info.isLand) { pick = p.library.shift(); p.hand.push(pick); }
        else if (lands.length && this.has(p, 'muldrotha') && !p.gyCastTypes.has('Land') && p.gy.some((c) => c.info.isLand && !c.info.statics.some((st) => st.k === 'chasm') && this.landValue(p, c) >= Math.max(...lands.map((l) => this.landValue(p, l))))) {
          pick = p.gy.filter((c) => c.info.isLand && !c.info.statics.some((st) => st.k === 'chasm')).sort((a, b) => this.landValue(p, b) - this.landValue(p, a))[0];
          this.removeFrom(p.gy, pick); p.gyCastTypes.add('Land'); p.hand.push(pick);
        }
        else if (lands.length) pick = lands.find((c) => this.lockLand(c)) || this.chooseLandDrop(p, lands); // (only there when needLock said play it)
        else if (mdfc.length && p.bf.filter((c) => c.info.isLand).length < 6) { pick = mdfc[0]; face = pick.info.mdfcLand; }
        else if (this.has(p, 'landsFromTop') && p.library[0] && p.library[0].info.isLand) { pick = p.library.shift(); p.hand.push(pick); }
        else if (this.has(p, 'crucible') && p.gy.some((c) => c.info.isLand)) { pick = p.gy.filter((c) => c.info.isLand).sort((a, b) => this.landValue(p, b) - this.landValue(p, a))[0]; this.removeFrom(p.gy, pick); p.hand.push(pick); }
        else if (this.has(p, 'muldrotha') && !p.gyCastTypes.has('Land')) { pick = p.gy.filter((c) => c.info.isLand && (!this.lockLand(c) || (!c._noLock && this.needLock(p)))).sort((a, b) => this.landValue(p, b) - this.landValue(p, a))[0]; if (pick) { this.removeFrom(p.gy, pick); p.gyCastTypes.add('Land'); p.hand.push(pick); } }
        if (!pick) return;
        this.removeFrom(p.hand, pick);
        if (face) { pick.info = Object.assign(Object.create(Object.getPrototypeOf(face)), face, { faces: pick.info.faces }); }
        p.landsPlayed++;
        this.enterBattlefield(pick, p, { quiet: true });
        if (pick.zone === 'bf') this.emit('land', `${p.name} plays ${pick.info.name}${pick.tapped ? ' (tapped)' : ''}.`, { seat: p.seat, cards: [pick.id] });
      }
    }

    // ----- look-ahead -----
    // A copy of the game to try a line on. Card data (info) is shared, everything that changes is copied. Hidden
    // information stays hidden: every library is reshuffled in the copy, so the search can't peek at draws.
    cloneForLook() {
      this.checkTime();
      const seen = new Map(), skip = new Set(['info', 'baseInfo', 'db', '_ac', 'nn', 'R', 'events', 'samples', 'mullSamples', 'emit', 'stats', '_crBuf']);
      const cp = (v, key) => {
        if (v === null || typeof v !== 'object' || skip.has(key)) return v;
        if (seen.has(v)) return seen.get(v);
        let o;
        if (Array.isArray(v)) { o = []; seen.set(v, o); for (const x of v) o.push(cp(x)); return o; }
        if (v instanceof Set) { o = new Set(); seen.set(v, o); for (const x of v) o.add(cp(x)); return o; }
        if (v instanceof Map) { o = new Map(); seen.set(v, o); for (const [k, x] of v) o.set(k, cp(x)); return o; }
        o = {}; seen.set(v, o); for (const k of Object.keys(v)) o[k] = cp(v[k], k); return o;
      };
      const g = Object.create(Object.getPrototypeOf(this));
      for (const k of Object.keys(this)) if (typeof this[k] !== 'function') g[k] = skip.has(k) ? this[k] : cp(this[k], k); // (a method wrapped around the real game, by a monitor, the UI or the mistake-finder, must not see the copy's moves)
      this._lookN = (this._lookN || 0) + 1;
      g.R = rng((this.seed * 7919 + this._lookN * 104729) >>> 0); g.events = []; g.stats = {}; g._crBuf = []; g.samples = []; g.mullSamples = []; g.record = false; g.collect = false; g.explore = 0; g._inLook = true;
      for (const q of g.players) g.R.shuffle(q.library);
      return g;
    }
    // How good the position is for p at the end of the line: winning, knocking players out, life taken, board, cards
    lookValue(g, seat) {
      const p = g.players[seat];
      if (g.winner === seat) return 1000;
      if (p.lost || (g.over && g.winner !== seat)) return -1000;
      const opps = g.opps(p);
      let v = (g.players.length - 1 - opps.length) * 60 + opps.reduce((a, q) => a + Math.min(40, 40 - q.life) * 0.5 + q.poison * 3 - g.playerThreat(q) * 0.35, 0); // their boards count too: an edict on every opponent is worth a lot
      v += g.playerThreat(p) * 0.6 + p.hand.length * 1.5 + (p.infMana ? 25 : 0) + (opps.length && g.locked(opps[0]) ? 60 : 0) - (g.locked(p) ? 60 : 0) + Math.min(p.life, 40) * (!g.looseSeats || g.looseSeats.includes(seat) ? 0.4 : 0.2); // (life was 0.2 a point: 10 life = one 3/3; the A/B seat gets 0.4)
      // mana to come: ramp pays off after the look-ahead's horizon, so the mana we'll have counts (most early on)
      v += g.sources(p).reduce((a, x) => a + Math.max(...x.opts.map((o) => o.amount)), 0) * Math.max(0.3, 2.5 - g.round * 0.15);
      // The network judges positions better than these hand weights at every stage of the game (it picked the
      // eventual winner 46% of the time vs 41%, and 34% vs 26% in the first four rounds), so when it is on it carries
      // the score: its win chance, plus a quarter of the hand weights as a tie-breaker. (A/B seats only, for now.)
      if (g.nnOn(p)) {
        const knock = (g.players.length - 1 - opps.length) * 60;
        if (!g.looseSeats || g.looseSeats.includes(seat)) return knock + 300 * g.nnV(p) + 0.25 * (v - knock);
        v += 80 * g.nnV(p);
      }
      return v;
    }
    // Try each candidate play on a copy, finish the main phase greedily, and compare. Returns the better pick, or null to keep the greedy one.
    // greedy null means the rules would end the main phase here ({ pass: true }). loose: abilities the rules score at 0 or
    // below; they are tried too, so a line the rules undervalue (sacrifices with Dictate of Erebos) is judged by what it does.
    lookPick(p, second, options, abs, greedy, loose = []) {
      const g0 = greedy || { pass: true }, cands = [g0];
      const gs = greedy ? (greedy.o || greedy.ab).s : 0, close = (x) => x.s >= gs * 0.35;
      if (greedy) {
        for (const o of options.slice(0, 3)) if ((!greedy.o || o.c.id !== greedy.o.c.id) && close(o)) cands.push({ o });
        for (const a of abs.slice(0, 2)) if ((!greedy.ab || a.key !== greedy.ab.key) && close(a)) cands.push({ ab: a });
      }
      // only on engine turns, where order matters: an activated ability competes with the spells, or a combo is within reach
      if (!loose.length && (cands.length < 2 || (!cands.some((c) => c.ab) && !this.comboWants(p).length))) return null;
      for (const a of loose.slice(0, 3)) cands.push({ ab: a, loose: true });
      if (cands.length < 2) return null;
      const learn = this.collect && this.nnOn(p) ? { seat: p.seat, deck: p.deckId, st: this.nnState(p), turn: this.round } : null, learnT = [];
      const res = cands.map((pk) => {
        try {
          const g = this.cloneForLook(), pp = g.players[p.seat];
          const used = g._usedAbilities && g._usedAbilities.turn === g.turn ? g._usedAbilities.set : new Set(); g._usedAbilities = { turn: g.turn, set: used };
          if (pk.ab) { const a = g.abilityOptions(pp, second, used, !!pk.loose).find((x) => x.key === pk.ab.key); if (!a) return -Infinity; used.add(a.key); g.doActivate(pp, a); }
          else if (pk.pass) { /* end the main phase's spells here: mainPhase below finds nothing worth doing and moves on */ }
          else { const c = g.cards[pk.o.c.id]; if (!c || !g.castSpell(pp, c, pk.o.from, pk.o.gyType)) return -Infinity; g.playLand(pp); }
          if (!g.over && !pp.lost) g.mainPhase(pp, second);
          // from the first main phase, play the rest of the turn too: a creature cast now attacks, mana held up isn't wasted
          if (!second && !g.over && !pp.lost && g.active === p.seat) { g.emptyPools(); g.phase = 'combat'; g.combat(pp); if (!g.over && !pp.lost) { g.emptyPools(); g.phase = 'main 2'; g.mainPhase(pp, true); } }
          if (learn) learnT[cands.indexOf(pk)] = g.winner === p.seat ? 1 : pp.lost || g.over ? 0 : g.nnV(pp); // the line's result, for training
          return g.lookValue(g, p.seat);
        } catch (e) { if (e instanceof TimeUp) throw e; return -Infinity; }
      });
      // Learning from the search (training games only): each cast option's result is an example of what casting that card
      // here leads to, cast or not; the best line's result is an example of what this position is worth
      if (learn) {
        cands.forEach((pk, i) => { if (pk.o && learnT[i] != null && isFinite(res[i])) this.searchSamples.push({ ...learn, name: pk.o.c.name, from: pk.o.from, card: this.nnCard(p, pk.o.c, pk.o.from), y: learnT[i] }); });
        const best = Math.max(...learnT.filter((t, i) => t != null && isFinite(res[i])));
        if (isFinite(best)) this.searchSamples.push({ ...learn, name: null, y: best });
      }
      let bi = 0; for (let i = 1; i < res.length; i++) if (res[i] > res[bi]) bi = i;
      // only leave the greedy play for a clearly better line
      return bi > 0 && res[bi] > res[0] + 4 ? cands[bi] : null;
    }

    mainPhase(p, second = false) {
      if (!second && p.drainMana) { this.addFloating(p, 'C', p.drainMana); this.emit('effect', `Mana Drain gives ${p.name} ${p.drainMana} extra mana.`, { seat: p.seat }); p.drainMana = 0; }
      this.playLand(p);
      this.myrkulDruid(p);
      this.gravetide(p, false);
      let guard = 0;
      while (guard++ < 40 && !p.lost && !this.over) {
        // a combo that just came together (Druid cast with Myrkul out) makes the mana before the next spell
        if (this.myrkulDruid(p)) continue;
        const options = this.castOptions(p);
        // a strong activated ability (Osgir copying Wurmcoil, Razaketh tutoring) can beat casting a spell
        const used = this._usedAbilities && this._usedAbilities.turn === this.turn ? this._usedAbilities.set : new Set();
        this._usedAbilities = { turn: this.turn, set: used };
        const abs = this.abilityOptions(p, second, used), ab = abs[0];
        // look ahead: when there is a real choice, try the best few plays on a copy of the game and keep the one whose turn ends best
        let pick = ab && (!options.length || ab.s > options[0].s) ? { ab } : options.length ? { o: this.bestSequence(p, options) } : null;
        if (this.lookahead && !this._inLook && p.infMana !== this.turn && (!this.lookSeats || this.lookSeats.includes(p.seat))) {
          // abilities the rules would not use: the look-ahead plays each out and keeps it only if the turn ends clearly better
          const loose = this.looseLook === false || (this.looseSeats && !this.looseSeats.includes(p.seat)) ? [] : this.abilityOptions(p, second, used, true).filter((a) => !abs.some((b) => b.key === a.key));
          if (pick || loose.length) pick = this.lookPick(p, second, options, abs, pick, loose) || pick;
          if (pick && pick.pass) pick = null;
        }
        if (!pick) { if (this.beledrosUntap(p)) continue; break; }
        if (pick.ab) { used.add(pick.ab.key); this.doActivate(p, pick.ab); continue; }
        const o = pick.o;
        if (o.c.info.cost.x && this.beledrosXWorth(p, o)) this.beledrosForX(p);
        if (!this.castSpell(p, o.c, o.from, o.gyType)) break;
        this.playLand(p);
      }
      if (p.lost || this.over) return;
      this.checkCombos(p);
      if (p.lost || this.over) return;
      this.aristocrats(p);
      if (p.lost || this.over) return;
      for (const c of p.bf) {
        const ta = c.info.transformAt;
        if (ta && !c.transformed && p.bf.filter((x) => x.info.isCreature && this.isType(x, ta.tribe)).length >= ta.count && this.pay(p, parseCost(ta.cost))) { this.pay(p, parseCost(ta.cost), 0, true); this.transform(c); }
      }
      if (!second) this.animateManlands(p);
      this.activateAbilities(p, second);
      this.pingers(p, second);
      this.useWalkers(p, second);
      this.equipStuff(p);
      if (second) this.gravetide(p, true);
    }

    // Muldrotha loops: a creature whose death or entering does something (Kokusho, Sakura-Tribe Elder, Eternal Witness)
    // is sacrificed and cast again from the graveyard with the turn's creature slot. At the end of the turn a death
    // trigger is cashed in once more, since Muldrotha brings the creature back next turn.
    // An opponent's Valgavoth or Dauthi Voidwalker exiles whatever would go to p's graveyard (and lets them play it): no filling the graveyard then
    gyHated(p) { return this.opps(p).some((q) => this.has(q, 'voidExile')); }
    gravetide(p, endOfTurn) {
      if (!this.has(p, 'muldrotha') || p.lost || this.over || this.locked(p) || this.gyHated(p) || this.active !== p.seat || (!endOfTurn && p.gyCastTypes.has('Creature'))) return;
      const n = this.opps(p).length;
      const diesV = (c) => c.info.dies.reduce((a, f) => a + (f.k === 'drain' ? num(f.n) * n * 1.5 : f.k === 'junji' ? 8 : 0), 0);
      const etbV = (c) => c.info.etb.reduce((a, f) => a + (f.k === 'ramp' || f.k === 'draw' ? 6 : f.k === 'search' ? 5 : f.k === 'regrow' ? (p.gy.some((x) => !x.info.isLand && !x.info.isPermanent && x.info.spell.length) ? 8 : 0) : 0), 0);
      const selfSac = (c) => this.selfSacAb(c);
      const outlet = (c, cost) => this.sacOutlets(p).filter((o) => o !== c && !o.info.sacOutlet.tribes && !(o.info.sacOutlet.fx || []).some((f) => f.mvPlusOne) && !o.info.sacOutlet.mana)
        .sort((a, b) => (b.info.sacOutlet.addsMana ? 1 : 0) - (a.info.sacOutlet.addsMana ? 1 : 0))[0];
      const gyBest = Math.max(0, ...p.gy.filter((x) => x.info.isCreature && !x.info.isLand && ['Artifact', 'Enchantment'].every((t) => !x.info.types.has(t) || p.gyCastTypes.has(t))).map((x) => this.scoreCast(p, x, 'gy')));
      const cands = p.bf.filter((c) => c.info.isCreature && !c.token && !c.isCommander && c.owner === p.seat && !c.info.copy && !c.p1 && !c.info.kw.has('persist') && !c.info.kw.has('undying'))
        .map((c) => ({ c, ss: selfSac(c), v: diesV(c) + (endOfTurn ? 0 : etbV(c) + (selfSac(c) ? 6 : 0) - (this.canAttack(c) ? this.power(c) * 0.5 : 0)) }))
        .filter((x) => (endOfTurn ? x.v >= 10 : x.v >= 5 && this.scoreCast(p, x.c, 'gy') >= gyBest && this.availableMana(p) + (x.ss ? 0 : 2) >= this.costFor(p, x.c, 'gy').mv) && (x.ss || outlet(x.c)))
        .sort((a, b) => b.v - a.v);
      for (const { c, ss } of endOfTurn ? cands : cands.slice(0, 1)) {
        if (c.zone !== 'bf' || p.lost || this.over) continue;
        if (ss) this.doActivate(p, { c, ab: ss, fodder: [], cost: ss.cost });
        else { const o = outlet(c); if (!o || !this.sacrifice(p, c, o)) continue; this.emit('combo', `${p.name} sacrifices ${c.info.name} to ${o.info.name}${endOfTurn ? '; Muldrotha brings it back next turn' : ' to cast it again with Muldrotha'}.`, { seat: p.seat, cards: [c.id, o.id] }); }
        this.checkState();
        if (!endOfTurn && c.zone === 'gy' && this.pay(p, this.costFor(p, c, 'gy'))) this.castSpell(p, c, 'gy', 'Creature');
      }
    }

    // Sakura-Tribe Elder style: sacrifice itself for free for something (blocks, then goes away before damage)
    // At the end of the turn before ours, at the latest: cash in creatures whose own sacrifice is a one-shot gain
    // (Sakura-Tribe Elder's land untaps on our turn, so it ramps just as early, and Muldrotha can cast it again).
    // Until then it can still block and be sacrificed mid-combat (see combat), but it is never held back for that.
    eotSelfSacs(active) {
      let n = active.seat; do { n = (n + 1) % this.players.length; } while (this.P(n).lost && n !== active.seat);
      const q = this.P(n);
      if (q === active || q.lost || this.over || this.abolished(q, 'ability') || this.locked(q)) return;
      for (const c of q.bf.slice()) {
        const ab = this.selfSacAb(c);
        if (!ab || c.zone !== 'bf' || c.isCommander) continue;
        if (ab.fx.some((f) => f.k === 'draw') && q.library.length < 10) continue;
        this.emit('ability', `At the end of ${active.name}'s turn, ${q.name} sacrifices ${c.info.name}.`, { seat: q.seat, cards: [c.id] });
        this.doActivate(q, { c, ab, fodder: [], cost: ab.cost });
        if (this.over) return;
      }
    }
    selfSacAb(c) { return c.info.isCreature && c.info.activated.find((ab) => ab.sac && !ab.tap && !ab.cost.mv && !ab.life && ab.fx.some((f) => f.k === 'ramp' || f.k === 'draw')); }

    animateManlands(p) {
      for (const c of p.bf) {
        const ml = c.info.manland;
        if (!ml || c.tapped || c.info.isCreature) continue;
        const cost = parseCost(ml.cost);
        if (this.availableMana(p) < cost.mv + 1 || !this.opps(p).some((q) => !q.bf.some((b) => b.info.isCreature && !b.tapped && this.power(b) >= ml.t))) continue;
        if (!this.pay(p, cost)) continue;
        this.pay(p, cost, 0, true);
        this.setInfo(c, { isCreature: true, power: ml.p, toughness: ml.t, subtypes: [...c.info.subtypes, ml.sub], types: new Set([...c.info.types, 'Creature']), colors: new Set(ml.colors), attack: ml.attackToken ? [{ k: 'tokens', n: 1, p: 1, t: 1, sub: 'Goblin', colors: 'red', kw: [], tapped: true }] : [] });
        c.animatedEOT = true; c.sick = false;
        this.emit('ability', `${p.name} animates ${c.name}.`, { seat: p.seat, cards: [c.id] });
      }
    }

    // Walking Ballista style: remove +1/+1 counters to ping
    pingers(p, second) {
      for (const c of p.bf.filter((x) => /Remove a \+1\/\+1 counter from CARDNAME: It deals 1 damage to any target/i.test(x.info.text || ''))) {
        // Stop once the counters could kill the whole table: with unlimited mana (Myrkul + Devoted Druid) this never ran out
        const enough = this.opps(p).reduce((s, o) => s + Math.max(o.life, 0), 0) + 20;
        if (second && this.availableMana(p) >= 4 && /\{4\}: Put a \+1\/\+1 counter/i.test(c.info.text)) { let n = 0; while (c.p1 < enough && n++ < 200 && this.pay(p, parseCost('4'))) { this.pay(p, parseCost('4'), 0, true); c.p1 += this.counterAmount(p, 1); } }
        // Ping out every opponent the counters can kill (a huge Ballista off unlimited mana wins the game), least life first
        let killed = false;
        for (const q of this.opps(p).filter((o) => o.protectedUntil < this.turn).sort((a, b) => a.life - b.life)) {
          if (q.lost || this.over) continue;
          let n = 0; while (n < c.p1 && this.scaleDamage(p.seat, q.seat, n) < q.life) n++;
          if (this.scaleDamage(p.seat, q.seat, n) < q.life) break;
          c.p1 -= n; killed = true;
          this.loseLife(q, this.scaleDamage(p.seat, q.seat, n), c); this.emit('damage', `${c.info.name} removes ${n} counters and pings ${q.name} to death.`, { seat: p.seat, cards: [c.id], target: q.seat }); this.checkState();
        }
        if (killed) continue;
        const t = this.bestOppTarget(p, (x) => x.info.isCreature && this.targetable(x, p) && this.toughness(x) - x.dmg <= Math.min(c.p1 - 1, 3) && this.creatureValue(x) >= 5);
        if (t && c.p1 > 1) { const need = this.toughness(t) - t.dmg; c.p1 -= need; t.dmg += this.scaleDamage(p.seat, t.ctrl, need); this.emit('removal', `${c.info.name} pings ${t.info.name}.`, { seat: p.seat, cards: [c.id, t.id], target: t.ctrl }); this.checkState(); }
      }
    }

    // Spells the AI wants to cast right now and can pay for, best first
    castOptions(p) {
      this._nnTick = (this._nnTick || 0) + 1;
      return this.castables(p).map((o) => ({ ...o, s: this.scoreCast(p, o.c, o.from) })).map((o) => (this.explore && o.s > 0 ? { ...o, s: o.s + this.R() * this.explore } : o)).filter((o) => o.s > 0)
        .filter((o) => { const cf = this.costFor(p, o.c, o.from); return this.pay(p, cf) && (!o.c.info.cost.x || (cf.x && this.maxX(p, cf) >= this.minX(o.c))); })
        .sort((a, b) => b.s - a.s);
    }

    // Play order: pick the spell that leads to the best turn, counting what the leftover mana can still cast.
    // Two good cheap spells can beat one expensive one; a mana rock first can pay for the rest.
    bestSequence(p, options) {
      if (options.length === 1) return options[0];
      const avail = this.availableMana(p);
      const mvOf = (o) => (o.c.info.cost.x ? avail : this.costFor(p, o.c, o.from).mv || 0);
      const manaBack = (o) => { const m = o.c.info.mana; if (!m || o.c.info.isLand || o.c.info.etbTapped || (o.c.info.isCreature && !this.hasKw(o.c, 'haste'))) return 0; return Math.max(...m.opts.map((x) => x.amount || 1)); };
      const top = options.slice(0, 8);
      let best = top[0], bestV = -Infinity;
      for (const o of top) {
        let rem = avail - mvOf(o) + manaBack(o);
        let follow = 0, n = 0;
        for (const x of top) {
          if (x === o || n >= 3) continue;
          const m = mvOf(x);
          if (m <= rem) { follow += x.s; rem -= m; n++; }
        }
        const v = o.s + follow * 0.8;
        if (v > bestV + 1e-9) { bestV = v; best = o; }
      }
      return best;
    }
    minX(c) {
      const fx = c.info.isPermanent ? c.info.etb : c.info.spell;
      if (fx.some((f) => f.k === 'drain' || f.k === 'hailfire')) return 3;
      if (fx.some((f) => f.k === 'wipe')) return 2;
      if (c.info.chargeX) return 2; // Astral Cornucopia for X=1 is 3 mana for 1
      return 1;
    }

    // Is it worth activating an ability with these effects right now?
    abilityUseful(p, ab, c, postCombat) {
      const ks = ab.fx.find((f) => f.k === 'kwSelf');
      if (ks) return !postCombat && this.active === p.seat && this.canAttack(c) && !this.hasKw(c, ks.kw) && this.opps(p).some((q) => q.bf.some((b) => b.info.isCreature && !b.tapped && this.canBlock(b, c))) && this.opps(p).some((q) => !q.bf.some((b) => b.info.isCreature && !b.tapped && (this.hasKw(b, 'flying') || this.hasKw(b, 'reach'))));
      if (ab.preCombat) return !postCombat && p.bf.some((x) => this.canAttack(x)) && this.opps(p).length > 0;
      if (ab.lowPriority && !postCombat) return false;
      return ab.fx.some((f) => {
        switch (f.k) {
          case 'removal': case 'steal': return !!this.bestOppTarget(p, (x) => (f.k === 'removal' ? this.removalPred(f.what)(x) : f.what === 'creature' ? x.info.isCreature : !x.info.isLand) && this.targetable(x, p));
          case 'ramp': return this.rampFinds(p, f);
          case 'draw': case 'tokens': case 'treasure': case 'counters': case 'drain': case 'drainOne': case 'damage': case 'proliferate': case 'tutor': case 'loot': return true;
          case 'gain': return p.life < 40 || p.bf.some((x) => x.info.triggers.some((t) => t.k === 'bond' || t.k === 'onGain'));
          case 'search': return f.dest !== 'gy' || p.gy.length < 20;
          case 'mill': return !this.gyHated(p) && (this.has(p, 'muldrotha') || p.bf.some((x) => x.info.sidisi) || p.hand.some((x) => x.info.spell.some((y) => y.k === 'reanimate')) || f.n <= 2);
          case 'scry': return true;
          case 'discard': return this.opps(p).some((q) => q.hand.length > 0);
          case 'counter': return false;
          case 'landDestroy': return this.opps(p).some((q) => q.bf.some((x) => x.info.isLand && !x.info.types.has('Basic') && (x.info.cradle || x.info.coffers || this.landValue(q, x) > 3)));
          case 'squirrelKill': { const sq = p.bf.filter((x) => x.token && this.isType(x, 'Squirrel')).length; return !!this.bestOppTarget(p, (x) => x.info.isCreature && this.targetable(x, p) && this.toughness(x) <= sq && this.creatureValue(x) >= 6); }
          case 'feldon': return p.gy.some((x) => x.info.isCreature && this.creatureValue({ ...x, p1: 0, eot: { p: 0, t: 0, kw: [] }, ctrl: p.seat, info: x.info }) > 6);
          case 'osgir': return p.gy.some((x) => x.info.types.has('Artifact') && x.info.isPermanent && x.info.mv <= this.availableMana(p));
          case 'reanimateArtifact': return p.gy.some((x) => x.info.types.has('Artifact'));
          case 'reanimate': return p.gy.some((x) => x.info.isCreature && this.cardValue(p, x) > 4); // (Liliana the Repentant's exhaust)
          case 'hireling': return !!this.hirelingTarget(p);
          case 'weld': { const best = Math.max(-1, ...p.gy.filter((x) => x.info.types.has('Artifact') && x.info.isPermanent).map((x) => this.cardValue(p, x))); const worst = Math.min(99, ...p.bf.filter((x) => x.info.types.has('Artifact') && x !== c).map((x) => this.permValue(x))); return best > worst + 1; }
          case 'regrowTop': return p.gy.some((x) => x.info.types.has(cap(f.what)));
          case 'cheatCreature': return p.hand.some((x) => x.info.isCreature && x.info.mv >= 5);
          case 'castVoid': return this.players.some((q) => q.exile.some((x) => x.voidBy === p.seat && !x.info.isLand && x.info.mv >= 3));
          case 'gixExile': return p.hand.length >= 3;
          case 'hermit': return this.has(p, 'labman') || !this.gyHated(p) && p.library.length > 15 && p.library.filter((x) => x.info.isLand && x.info.types.has('Basic')).length >= 2 && (this.has(p, 'muldrotha') || this.has(p, 'labman') || p.hand.some((x) => x.info.spell.some((y) => y.k === 'reanimate' || y.k === 'massReanimate')) || p.bf.some((x) => x.info.sidisi));
          case 'millPower': return postCombat && (!this.gyHated(p) && this.has(p, 'muldrotha') || p.bf.some((x) => x.info.sidisi) || this.opps(p).some((q) => q.library.length <= 12));
          case 'revealUntil': return p.library.some((x) => x.info.types.has('Artifact') && x.info.mv >= 4);
          case 'noBlock': case 'tapBlocker': return !postCombat;
          case 'millTop': return postCombat && p.library[0] && !(p.library[0].info.types.has('Artifact') || p.library[0].info.colors.size === 0);
          case 'exileTop': { const t = p.library[0]; return postCombat && !!t && !(t.info.types.has('Artifact') || t.info.colors.size === 0) && !COMBOS.some((cb) => cb.pieces.some((alts) => alts.includes(t.info.name))) && (t.info.isLand ? p.bf.filter((x) => x.info.isLand).length >= 6 : this.cardValue(p, t) < 6); }
          case 'untapCreature': return !!this.untapTarget(p, postCombat);
          default: return false;
        }
      });
    }

    // Osgir's two copies of a legend: the legend rule keeps one (none if we already have it)
    osgirKeep(p, x) { return x.info.isLegendary && !this.has(p, 'noLegendRule') ? (p.bf.some((y) => y.info.name === x.info.name) ? 0 : 0.5) : 1; }
    // A tapped creature whose tap ability would be worth activating again right now (for Thousand-Year Elixir / Staff untaps)
    untapTarget(p, postCombat) {
      if (this._untapProbe) return null;
      this._untapProbe = true;
      try {
        let best = null, bestS = 4;
        for (const x of p.bf) if (x.info.isCreature && x.tapped && !x.untapProbe) for (const ab of x.info.activated) {
          if (!ab.tap || ab.fx.some((f) => f.k === 'untapCreature')) continue;
          x.tapped = false; const prep = this.prepareAbility(p, x, ab, postCombat); const sc = prep ? this.abilityScore(p, prep) : 0; x.tapped = true;
          if (sc > bestS) { bestS = sc; best = x; }
        }
        return best;
      } finally { this._untapProbe = false; }
    }
    // Can this ability be activated now, and what would it cost (mana, fodder)? null when not.
    // loose: for the look-ahead's candidates, skip the judgement calls (life floor) and keep only what is impossible
    prepareAbility(p, c, ab, postCombat, loose = false) {
      const elixir = this.has(p, 'elixir');
      if (c.zone !== 'bf') return null;
      if (this.karnStops(p, c)) return null;
      if (c.info.name === 'Minas Tirith' && !(p.attackersTurn === this.turn && p.attackersCount >= 2)) return null;
      if (c.info.name === 'Baxter Building' && !p.bf.some((x) => x.info.isCreature && this.toughness(x) >= 4)) return null;
      const myrkulOut = p.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul'));
      // Cinderhaze Wretch with Myrkul: the discard loop is the point, so it goes before combat instead of attacking
      const loopNow = ab.untapWithCounter && (myrkulOut || !c.info.isCreature) && this.opps(p).some((q) => q.hand.length);
      // a tapped Wretch can pay a -1/-1 counter to untap and start
      const untapByCounter = ab.untapWithCounter && c.tapped && (!c.info.isCreature || myrkulOut || this.toughness(c) > 1);
      if (ab.tap && ((c.tapped && !untapByCounter) || (c.info.isCreature && c.sick && !this.hasKw(c, 'haste') && !elixir))) return null;
      const bigAb = ab.fx.some((f) => ['osgir', 'weld', 'reanimateArtifact', 'feldon', 'revealUntil', 'hermit'].includes(f.k) || (f.k === 'search' && f.dest === 'bf')); // (Forgemaster for Blightsteel beats attacking for 3)
      if (ab.tap && c.info.isCreature && !postCombat && !ab.preCombat && !loopNow && !this.hasKw(c, 'vigilance') && this.canAttack(c) && !bigAb) return null; // creatures prefer to attack first
      if (ab.sorcery && postCombat === undefined) return null;
      if (ab.minArtifacts && p.bf.filter((x) => x.info.types.has('Artifact')).length < ab.minArtifacts) return null;
      if (ab.life && !(loose ? p.life - ab.life >= 1 : this.canPayLife(p, ab.life, this.abilityWinsNow(p, ab, c)))) return null; // keeps us above what the table can hit us for, unless this wins
      if (ab.sacOther && !ab.sacArtifact && !ab.sacCreature && !ab.sacArtifactN) return null;
      if (ab.discard && p.hand.length < ab.discard + 1) return null;
      if ((ab.threshold && p.gy.length < ab.threshold) || (ab.exileGy && p.gy.length < ab.exileGy) || (ab.exhaust && c.exhausted)) return null; // threshold, exile-from-graveyard cost, exhaust (once)
      if ((ab.sacCreature || ab.discard) && !ab.fx.some((f) => ['draw', 'tutor', 'damage', 'removal', 'search', 'drain', 'tokens', 'proliferate', 'millPower'].includes(f.k))) return null;
      if (!this.abilityUseful(p, ab, c, postCombat)) return null;
      let fodder = [];
      if (ab.sacArtifact) {
        const plusOne = ab.fx.some((f) => f.mvPlusOne);
        fodder = p.bf.filter((x) => x !== c && x.info.types.has('Artifact') && !x.isCommander && !this.livePiece(p, x) && (!plusOne || p.library.some((l) => l.info.types.has('Artifact') && l.info.mv === x.info.mv + 1))).sort((a, b) => this.permValue(a) + (a.info.isLand ? 3 : 0) - this.permValue(b) - (b.info.isLand ? 3 : 0)).slice(0, ab.sacArtifact);
        if (fodder.length < ab.sacArtifact || fodder.some((x) => this.permValue(x) > 8)) return null;
      }
      if (ab.sacCreature) {
        // before combat on our turn, creatures that could attack aren't sacrificed yet: they swing first, and go after combat
        const preCombat = postCombat === false && this.active === p.seat && !ab.preCombat;
        fodder = this.sacFodder(p, c).filter((x) => (!ab.sacColor || x.info.colors.has(ab.sacColor)) && !(preCombat && this.canAttack(x) && this.power(x) > 0)).slice(0, ab.sacCreature);
        if (fodder.length < ab.sacCreature) return null;
      }
      if (ab.sacArtifactN && !ab.sacArtifact) {
        fodder = p.bf.filter((x) => x !== c && x.info.types.has('Artifact') && !x.isCommander && !this.livePiece(p, x) && ((x.token && !x.info.mv) || this.permValue(x) < 4)).sort((a, b) => this.permValue(a) - this.permValue(b)).slice(0, ab.sacArtifactN);
        if (fodder.length < ab.sacArtifactN) return null;
      }
      if (ab.sacNonland) {
        fodder = p.bf.filter((x) => x !== c && !x.info.isLand && !x.isCommander).sort((a, b) => this.permValue(a) - this.permValue(b)).slice(0, ab.sacNonland);
        if (fodder.length < ab.sacNonland || !this.opps(p).some((q) => q.life <= 10)) return null;
      }
      let cost = ab.cost;
      if (ab.tribeDiscount) cost = { ...cost, generic: Math.max(0, cost.generic - p.bf.filter((x) => x.info.isCreature && this.isType(x, ab.tribeDiscount)).length) };
      const zirda = this.statics(p, 'reduceAbilities').reduce((s2, x) => s2 + x.s.n, 0);
      if (zirda && cost.mv) cost = { ...cost, generic: Math.max(cost.mv - cost.generic >= 1 ? 0 : 1, cost.generic - zirda) };
      if (cost.mv && !this.pay(p, cost)) return null;
      // near the bottom of the library: no drawing (Myrkul's copies of sacrificed creatures set off constellation draws too)
      if (p.library.length < 12 && !this.has(p, 'platinum') && !this.has(p, 'labman')) {
        const dn = (fx) => fx.reduce((a, f) => a + (f.k === 'draw' ? (+f.n || 1) : 0), 0);
        const myrkul = fodder.some((x) => !x.token && !x.isCommander) && p.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul'));
        const draws = dn(ab.fx) + (myrkul ? fodder.length * this.tokenMult(p) * p.bf.reduce((a, x) => a + (x.info.constellation || []).reduce((b, fx) => b + dn(fx), 0), 0) : 0);
        if (draws && p.library.length - draws < 3) return null;
      }
      return { c, ab, fodder, cost };
    }
    // Creatures we are happy to sacrifice, cheapest first. With Myrkul out, nontoken creatures with
    // enters/static abilities come back as enchantment copies, so they are good fodder too.
    // Paying life is fine down to 1 when the ability wins: its drain or damage kills an opponent, or (Dictate of Erebos)
    // our sacrifices are enough to take every creature the opponents have, so nothing is left to hit us back
    abilityWinsNow(p, ab, c) {
      const hit = ab.fx.reduce((a, f) => a + (f.k === 'drain' || f.k === 'damage' ? this.fxNum(p, f.n, 1) : 0), 0);
      if (hit && this.opps(p).some((q) => q.life <= hit)) return true;
      if (!ab.sacCreature) return false;
      const edicts = p.bf.reduce((a, x) => a + (x.info.deathWatch || []).filter((w) => w.scope === 'mine' && w.fx.some((f) => f.k === 'edict')).length, 0);
      const fodder = this.sacFodder(p, c).length;
      return edicts > 0 && this.opps(p).every((q) => q.bf.filter((x) => x.info.isCreature).length <= fodder * edicts);
    }
    // How many opponents lose a creature each time one of our creatures dies (Dictate of Erebos, Grave Pact)
    edictsPerDeath(p) {
      const n = p.bf.reduce((a, x) => a + (x.info.deathWatch || []).filter((w) => w.scope === 'mine' && w.fx.some((f) => f.k === 'edict')).length, 0);
      return n ? n * this.opps(p).filter((q) => q.bf.some((x) => x.info.isCreature)).length : 0;
    }
    sacFodder(p, outlet) {
      const myrkul = p.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul'));
      return p.bf.filter((x) => x !== outlet && x.info.isCreature && !x.isCommander && (x.token || this.creatureValue(x) < 5 || (myrkul && this.myrkulGain(x) > 0)))
        .sort((a, b) => (this.creatureValue(a) - (myrkul ? this.myrkulGain(a) * 2 : 0)) - (this.creatureValue(b) - (myrkul ? this.myrkulGain(b) * 2 : 0)));
    }
    // What a creature is worth as a Myrkul enchantment copy: its enters trigger again plus the abilities it keeps
    myrkulGain(c) {
      if (c.token || c.isCommander) return 0;
      const i = c.info;
      if (i.dies.some((f) => f.k === 'rectorExile')) return -5; // Myrkul exiles it first, so the Rector's own search fails
      let g = 0;
      if (i.etb.length) g += 4 + i.etb.length * 2;
      if (i.statics.length) g += 3;
      if (i.triggers.length || i.deathWatch.length || i.upkeep.length || i.endstep.length || i.castTrig.length) g += 3;
      if (i.activated.length) g += 2;
      if (i.dies.length) g += 3; // it also dies, so dies triggers happen
      return g - Math.max(0, (this.power(c) - 3)) * 0.5;
    }
    // How good is activating this ability right now (for ordering abilities and comparing with spells)
    abilityScore(p, prep) {
      const { c, ab, fodder, cost } = prep;
      let s = 0;
      for (const f of ab.fx) {
        if (f.k === 'tutor') { const pick = this.chooseTutor(p, f.what || 'card'); s += pick ? 12 + Math.min(25, this.cardValue(p, pick)) + (this.completesCombo(p, pick) ? 40 : 0) : -20; }
        else if (f.k === 'osgir') {
          // two copies are worth twice what casting that artifact would be (two Hedron Archives = +4 mana a turn)
          const avail = this.availableMana(p) + (ab.tap ? 0 : 0);
          const val = (x) => Math.max(this.scoreCast(p, x, 'hand'), this.permValue({ ...x, p1: 0, dmg: 0, eot: { p: 0, t: 0, kw: [] }, ctrl: p.seat, zone: 'bf' }) * 2, 6) * this.osgirKeep(p, x);
          const best = p.gy.filter((x) => x.info.types.has('Artifact') && x.info.isPermanent && x.info.mv <= avail && !x.info.cost.x).sort((a, b) => val(b) - val(a))[0];
          s += best && val(best) > 0 ? 8 + val(best) * 2 : -20;
        }
        else if (f.k === 'draw') s += 5 + this.fxNum(p, f.n, 1) * 3;
        else if (f.k === 'ramp') s += this.selfSacAb(c) === ab ? 3 : Math.max(4, 26 - this.round * 2) * Math.max(1, (f.bf || 0) + (f.hand || 0) * 0.5); // ramp early, like ramp spells (a free self-sacrifice like Sakura-Tribe Elder waits for the end of the turn before ours: same land, and it can still block)
        else if (f.k === 'search' && f.dest !== 'gy') {
          const cap2 = f.mvPlusOne ? Math.max(0, ...fodder.map((x) => x.info.mv)) + 1 : typeof f.mvMax === 'number' ? f.mvMax : null;
          const ok = (x) => (/artifact/.test(f.what || '') ? x.info.types.has('Artifact') : /creature/.test(f.what || '') ? x.info.isCreature : !x.info.isLand) && (cap2 == null || (f.mvPlusOne ? x.info.mv === cap2 : x.info.mv <= cap2));
          const best = Math.max(0, ...p.library.filter(ok).map((x) => this.cardValue(p, x) + (this.completesCombo(p, x) ? 30 : 0)));
          s += best ? 6 + Math.min(40, best) * (f.dest === 'bf' ? 1.2 : 0.8) : -20;
        }
        else if (f.k === 'removal' || f.k === 'steal') s += 12;
        else if (f.k === 'tokens') s += 5 + this.fxNum(p, f.n, 3) * 2;
        else if (f.k === 'damage' || f.k === 'drain' || f.k === 'drainOne') {
          // scored by what it does: knocking a player out is a step toward winning (Aetherflux Reservoir for 50)
          const amt = this.fxNum(p, f.n, 1), kills = this.opps(p).some((q) => q.protectedUntil < this.turn && this.scaleDamage(p.seat, q.seat, amt) >= q.life);
          s += kills ? 80 : 5 + Math.min(amt, 10) * 0.5;
        }
        else if (f.k === 'discard') {
          s += 4;
          // the Myrkul loop empties every opponent's hand
          if (ab.untapWithCounter && (!c.info.isCreature || p.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul')))) s += 30 + this.opps(p).reduce((a, q) => a + q.hand.length, 0) * 2;
        }
        else if (f.k === 'cheatCreature') s += 20;
        // Yawgmoth: a -1/-1 counter that kills something; proliferate that kills creatures with -1/-1 counters (or grows ours)
        else if (f.k === 'minusCounter') s += this.bestOppTarget(p, (x) => x.info.isCreature && this.targetable(x, p) && this.toughness(x) - x.dmg <= 1) ? 6 : -3;
        else if (f.k === 'proliferate') { const kills = this.opps(p).reduce((a, q) => a + q.bf.filter((x) => x.info.isCreature && x.p1 < 0 && this.toughness(x) - x.dmg <= 1 && !this.hasKw(x, 'indestructible')).length, 0); s += 8 * kills + 2 * p.bf.filter((x) => x.p1 > 0 || (x.info.isPW && x.loyalty > 0) || (x.charge > 0 && !x.info.saga)).length + 4 * this.opps(p).filter((q) => q.poison > 0).length - 2; }
        else if (f.k === 'feldon' || f.k === 'reanimateArtifact' || f.k === 'weld') s += 14;
        else s += 3;
      }
      const myrkul = p.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul'));
      for (const x of fodder) s -= x.token ? 1 : Math.max(0, this.creatureValue(x) * 0.6 - (myrkul ? this.myrkulGain(x) : 0));
      // Dictate of Erebos / Grave Pact: every creature of ours that dies takes one from each opponent who has one
      s += fodder.filter((x) => x.info.isCreature).length * this.edictsPerDeath(p) * 7;
      s -= (ab.life || 0) * 0.4 * Math.min(1, 40 / Math.max(40, p.life)) + (cost.mv || 0) * 0.5 + (ab.discard || 0) * 3; // (50 life matters at 60 life, not at 900)
      // sacrificing the card itself costs what it's worth on the battlefield (a mana rock early on is worth a lot)
      if (ab.sac) s -= Math.max(3, this.permValue(c)) + (c.info.mana ? Math.max(0, 14 - this.round) : 0);
      // never into an empty library: the ability's draws plus what the sacrificed creatures draw on the way out
      const draws = ab.fx.reduce((a, f) => a + (f.k === 'draw' ? this.fxNum(p, f.n, 1) : 0), 0) + fodder.reduce((a, x) => a + (x.info.isCreature ? this.deathDraws(p, x) : 0), 0) + (ab.sac && c.info.isCreature ? this.deathDraws(p, c) : 0);
      if (draws && draws > this.drawRoom(p)) return -1;
      return s;
    }
    doActivate(p, prep) {
      const { c, ab, fodder, cost } = prep;
      if (p.lost || this.over) return;
      if (ab.untapWithCounter && ab.tap && c.tapped) { if (c.info.isCreature) c.p1 -= 1; c.tapped = false; this.emit('ability', `${this.cname(c)} gets a -1/-1 counter and untaps.`, { seat: p.seat, cards: [c.id] }); this.checkState(); if (c.zone !== 'bf') return; }
      if (cost.mv) this.pay(p, cost, 0, true);
      if (ab.tap) c.tapped = true;
      if (ab.life) this.loseLife(p, ab.life);
      if (ab.exileGy) { const ex = p.gy.slice().sort((a, b) => (a.info.isCreature ? 10 : 0) + (a.info.mv || 0) * 0.3 - ((b.info.isCreature ? 10 : 0) + (b.info.mv || 0) * 0.3)).slice(0, ab.exileGy); for (const x of ex) { this.removeFrom(p.gy, x); x.zone = 'exile'; p.exile.push(x); } }
      if (ab.exhaust) { c.exhausted = true; if (ab.exhaustCounter) c.p1 += this.counterAmount(p, 1); }
      if (p.lost || this.over) return; // paying (painland damage, life) can end the game first
      this._sacMv = fodder.length ? Math.max(...fodder.map((x) => x.info.mv)) : null;
      this._sacPower = fodder.length ? Math.max(...fodder.filter((x) => x.info.isCreature).map((x) => this.power(x)), 0) : 0;
      const costTxt = [ab.life ? `pays ${ab.life} life` : '', fodder.length ? `sacrifices ${fodder.map((x) => this.cname(x)).join(' and ')}` : ''].filter(Boolean).join(', ');
      this.emit('ability', `${p.name} activates ${c.info.name}${costTxt ? ` (${costTxt})` : ''}: ${ab.text.slice(0, 90)}`, { seat: p.seat, cards: [c.id].concat(fodder.map((x) => x.id)) });
      for (const f of fodder) this.destroy(f, 'sacrificed', true);
      if (ab.discard) this.discardWorst(p, ab.discard);
      if (ab.sac) { if (c.token) this.leaveBattlefield(c); else this.destroy(c, 'sacrificed', true); }
      this.resolveEffects(p, ab.fx, c, null, false);
      // Rings of Brighthearth: pay {2} to copy an activated (non-mana) ability when it's worth it
      if (!ab.untapWithCounter && p.bf.some((r) => r.info.statics.some((st) => st.k === 'rings')) && this.abilityScore(p, { c, ab, fodder: [], cost: ab.cost }) >= 6 && this.pay(p, parseCost('2'))) {
        this.pay(p, parseCost('2'), 0, true);
        this.emit('ability', `Rings of Brighthearth: ${p.name} pays {2} to copy ${c.info.name}'s ability.`, { seat: p.seat, cards: [c.id] });
        this.resolveEffects(p, ab.fx, c, null, false);
      }
      // Battlemage's Bracers copy
      if (c.info.isCreature && p.bf.some((e) => e.attached === c.id && e.info.bracers) && this.pay(p, parseCost('1'))) { this.pay(p, parseCost('1'), 0, true); this.resolveEffects(p, ab.fx, c, null, true); }
      // Cinderhaze Wretch: put a -1/-1 counter on it to untap and go again. Normally it stops before dying;
      // with Myrkul out it keeps going until it dies and comes back as an enchantment, which can untap for free forever.
      if (ab.untapWithCounter) {
        const myrkul = () => p.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul'));
        for (let n = 0; n < 40 && c.zone === 'bf' && this.opps(p).some((q) => q.hand.length); n++) {
          if (c.info.isCreature) {
            if (this.toughness(c) <= 1 && !myrkul()) break;
            c.p1 -= 1; c.tapped = false;
            this.emit('ability', `${c.info.name} gets a -1/-1 counter and untaps${this.toughness(c) <= 0 ? ' — and dies' : ''}.`, { seat: p.seat, cards: [c.id] });
            this.checkState();
            if (c.zone !== 'bf') {
              // Myrkul made an enchantment copy: it is no creature, so the -1/-1 counters cost nothing
              const copy = p.bf.find((x) => x.ench && x.info.name === c.info.name && !x.tapped);
              if (!copy) break;
              this.emit('combo', `${copy.info.name} is an enchantment now: it untaps for free, so it can make players discard their whole hand.`, { seat: p.seat, cards: [copy.id] });
              // (if Opalescence makes the copy a creature again, each untap's -1/-1 counter counts and it dies)
              for (let k = 0; k < 40 && copy.zone === 'bf' && this.opps(p).some((q) => q.hand.length); k++) { this.resolveEffects(p, ab.fx, copy, null, false); if (copy.info.isCreature) { copy.p1 -= 1; this.checkState(); } }
              copy.tapped = true;
              break;
            }
          } else c.tapped = false;
          this.resolveEffects(p, ab.fx, c, null, false); c.tapped = true;
        }
      }
      this._sacMv = null;
      this.checkState();
    }
    // Activated abilities that are worth doing now, best first
    abilityOptions(p, postCombat, used, loose = false) {
      const out = [];
      for (const c of p.bf) {
        if (c.zone !== 'bf') continue;
        c.info.activated.forEach((ab, i) => {
          // an untapped-cost ability (Yawgmoth's) can go again while it is still worth it
          const again = used && used.has(c.id + ':' + i);
          if (again && (ab.tap || ab.sac || !(ab.sacCreature || ab.discard))) return;
          const prep = this.prepareAbility(p, c, ab, postCombat, loose);
          if (prep) { prep.key = c.id + ':' + i; const sc = this.abilityScore(p, prep); prep.s = sc - (again ? 8 : 0); if (prep.s > 0 || (loose && sc !== -1)) out.push(prep); }
        });
      }
      return out.sort((a, b) => b.s - a.s);
    }
    activateAbilities(p, postCombat) {
      if (this.over || p.lost) return;
      const used = this._usedAbilities && this._usedAbilities.turn === this.turn ? this._usedAbilities.set : new Set();
      this._usedAbilities = { turn: this.turn, set: used };
      for (let guard = 0; guard < 30 && !this.over && !p.lost; guard++) {
        const best = this.abilityOptions(p, postCombat, used)[0];
        if (!best) break;
        used.add(best.key);
        this.doActivate(p, best);
      }
      if (this.myrkulSacs(p)) this.activateAbilities(p, postCombat);
      if (postCombat && !p.lost && !this.over) this.lateGameMana(p);
    }
    // Myrkul: sacrifice creatures that are better as enchantment copies (enters triggers again, keeps its abilities)
    myrkulSacs(p) {
      if (!p.bf.some((m) => m.info.triggers.some((t) => t.k === 'myrkul')) || p.library.length < 10) return false; // (copies set off constellation draws)
      let n = 0;
      for (let guard = 0; guard < 6; guard++) {
        const outlet = this.sacOutlets(p).filter((o) => !o.info.sacOutlet.mana || this.pay(p, parseCost(String(o.info.sacOutlet.mana))))[0];
        if (!outlet) break;
        const c = p.bf.filter((x) => x !== outlet && x.info.isCreature && !x.token && !x.isCommander && !x.info.sacOutlet && this.myrkulGain(x) >= 6 && this.creatureValue(x) < 12).sort((a, b) => this.myrkulGain(b) - this.myrkulGain(a))[0];
        if (!c) break;
        this.emit('ability', `${p.name} sacrifices ${c.info.name} to ${outlet.info.name} so Myrkul brings it back as an enchantment.`, { seat: p.seat, cards: [outlet.id, c.id] });
        if (!this.sacrifice(p, c, outlet)) break;
        n++; this.checkState(); if (this.over || p.lost) break;
      }
      return n > 0;
    }

    // Beledros: pay 10 life to untap every land, when that unlocks a big play the AI wants (and the life is safe to pay)
    beledrosUntap(p) {
      const bel = p.bf.find((c) => c.info.beledros);
      if (!bel || bel.usedTurn === this.turn || !this.canPayLife(p, 10)) return false;
      const tappedLands = p.bf.filter((c) => c.info.isLand && c.tapped);
      if (tappedLands.length < 3) return false;
      const before = new Set(this.castOptions(p).map((o) => o.c.id));
      for (const c of tappedLands) c.tapped = false;
      // 10 life is a lot: only for a 4+ mana spell that scores well, never for a cheap creature
      const unlocked = this.castOptions(p).filter((o) => !before.has(o.c.id) && o.s >= 15 && (o.c.info.cost.x ? this.availableMana(p) : this.costFor(p, o.c, o.from).mv || 0) >= 4);
      for (const c of tappedLands) c.tapped = true;
      if (!unlocked.length) return false;
      bel.usedTurn = this.turn;
      this.emit('ability', `${p.name} pays 10 life: Beledros untaps ${tappedLands.length} lands to cast ${unlocked[0].c.info.name}.`, { seat: p.seat, cards: [bel.id] });
      this.loseLife(p, 10); this.checkState();
      if (this.over || p.lost) return false;
      for (const c of tappedLands) c.tapped = false;
      return true;
    }
    // Is the Beledros mana trick worth it for this X spell, or is the untap better saved (a combo piece to cast later
    // this turn)? Played out both ways to the end of the turn.
    beledrosXWorth(p, o) {
      const bel = p.bf.find((c) => c.info.beledros);
      if (!bel || bel.usedTurn === this.turn || !this.canPayLife(p, 10)) return false;
      if (!this.lookahead || this._inLook) return true;
      const val = (trick) => {
        try {
          this._lookN = (this._lookN || 0) + 1;
          const g = this.cloneForLook(), pp = g.players[p.seat], c = g.cards[o.c.id];
          if (trick) g.beledrosForX(pp);
          if (g.over || pp.lost || !g.castSpell(pp, c, o.from, o.gyType)) return -Infinity;
          g.restOfTurn(pp, this.phase === 'main 2' ? 'main 2' : 'main');
          return g.lookValue(g, p.seat);
        } catch (e) { if (e instanceof TimeUp) throw e; return -Infinity; }
      };
      return val(true) > val(false) + 2;
    }
    // Beledros with an X spell: tap every land for mana, pay 10 life to untap them all, and cast with the lands again
    // (about twice the X: a Finale of Devastation for 20 instead of 10)
    beledrosForX(p) {
      const bel = p.bf.find((c) => c.info.beledros);
      if (!bel || bel.usedTurn === this.turn || !this.canPayLife(p, 10) || this.locked(p)) return false;
      const lands = this.sources(p).filter((s2) => s2.c.info.isLand && !s2.c.tapped && !s2.fodder && !s2.counters);
      if (lands.length < 4) return false;
      let n = 0;
      for (const s2 of lands) { const o = s2.opts.reduce((a, b) => (b.amount > a.amount ? b : a)); this.addFloating(p, o.colors.length === 1 ? o.colors[0] : (o.colors.find((c2) => c2 !== 'C') || 'C'), o.amount); n += o.amount; }
      bel.usedTurn = this.turn;
      this.emit('ability', `${p.name} taps ${lands.length} lands for ${n} mana, pays 10 life and Beledros untaps them: more mana for the X spell.`, { seat: p.seat, cards: [bel.id] });
      this.loseLife(p, 10); this.checkState();
      return !this.over && !p.lost;
    }
    // Post-combat uses of leftover resources
    lateGameMana(p) {
      if (this.over || p.lost) return;
      // Beledros: pay 10 life to untap lands when there is something big to cast
      if (this.beledrosUntap(p)) this.mainPhase(p, 'again');
      // Infinity stones: harness when there's mana to spare
      for (const c of p.bf) if (c.info.harness && !c.harnessed && !p.lost && !this.over) {
        const cost = parseCost(c.info.harness.cost);
        const fod = c.info.harness.exileCreature ? p.bf.filter((x) => x.info.isCreature && !x.isCommander).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0] : null;
        if (c.info.harness.exileCreature && !fod) continue;
        if (c.tapped || !this.pay(p, cost)) continue;
        this.pay(p, cost, 0, true);
        if (p.lost || this.over) return; // paying can sacrifice creatures (Ashnod's Altar), and their death draws can end the game
        c.tapped = true; c.harnessed = true;
        this.emit('ability', `${p.name} harnesses ${c.info.name}.`, { seat: p.seat, cards: [c.id] });
        if (fod) this.exileCard(fod);
      }
      // The Chain Veil: reuse loyalty abilities
      const veil = p.bf.find((c) => c.info.chainVeil && !c.tapped);
      if (veil && p.bf.some((c) => c.info.isPW) && this.pay(p, parseCost('4'))) {
        this.pay(p, parseCost('4'), 0, true); veil.tapped = true;
        for (const c of p.bf) if (c.info.isPW) c.usedTurn = null;
        this.emit('ability', `${p.name} activates The Chain Veil.`, { seat: p.seat, cards: [veil.id] });
        this.useWalkers(p, false, true);
      }
      for (const c of p.bf) if (c.info.saga && c.sagaConstructs && !c.tapped && this.pay(p, parseCost('2'))) { this.pay(p, parseCost('2'), 0, true); c.tapped = true; this.addToken(p, { p: 0, t: 0, sub: 'Construct', colors: 'colorless' }, 1, false); }
      // Cycling extra lands
      for (const c of [...p.hand]) if (!p.lost && !this.over && c.info.cycling && p.hand.filter((x) => x.info.isLand).length > 2 && this.pay(p, c.info.cycling)) {
        this.pay(p, c.info.cycling, 0, true); this.discardCard(p, c);
        this.emit('ability', `${p.name} cycles ${c.info.name}.`, { seat: p.seat, cards: [c.id] });
        this.draw(p, 1); // (after the log line: drawing from an empty library can end the player)
      }
      // Food / Clue / Blood tokens
      for (const c of [...p.bf]) if (c.token && c.info.activated && c.info.activated.length && /Food|Clue|Blood/.test(c.info.name)) {
        const ab = c.info.activated[0];
        if (c.info.name === 'Food' && p.life > 25) continue;
        if (c.info.name === 'Blood' && !p.hand.length) continue;
        if (!this.pay(p, ab.cost)) continue;
        this.pay(p, ab.cost, 0, true); this.leaveBattlefield(c);
        this.resolveEffects(p, ab.fx, c, null, true);
      }
    }

    useWalkers(p, postCombat, again = false) {
      // The Chain Veil (again): exactly one more activation per planeswalker; Oath of Teferi: two a turn
      const uses = again ? 1 : this.has(p, 'oathTeferi') ? 2 : 1;
      for (const c of [...p.bf]) {
        if (!c.info.isPW || c.zone !== 'bf') continue;
        if (postCombat && c.usedTurn === this.turn) continue; // after combat: only walkers that haven't acted yet (cast in main 2)
        for (let u = 0; u < uses; u++) {
          if (c.zone !== 'bf') break;
          if (c.usedTurn === this.turn && (c.usedCount || 0) >= uses) break;
          if (c.usedTurn !== this.turn) c.usedCount = 0;
          if (!this.walkerOnce(p, c)) break;
          c.usedTurn = this.turn; c.usedCount = (c.usedCount || 0) + 1; p.walkerUses = (p.walkerUses || 0) + 1;
        }
      }
    }

    walkerOnce(p, c) {
      if (p.lost || this.over) return false;
      this.tick(); // walker activations count toward the runaway limit too
      const abs = c.info.loyaltyAbs;
      if (!abs.length) return false;
      const carth = this.has(p, 'carth') ? 1 : 0;
      const scored = abs.map((a) => {
        let delta = a.delta;
        if (delta === -98) {
          // Ugin -X: pick the X that exiles the most opposing value
          let best = 0, bestX = 0;
          // no point going above the highest mana value out there (loyalty can be astronomical: this hung training)
          const top = Math.max(0, ...this.allBf().map((y) => y.info.mv || 0));
          for (let x = 1; x <= Math.min(c.loyalty, top); x++) {
            const hit = (q) => q.bf.filter((y) => !y.info.isLand && y.info.colors && y.info.colors.size && y.info.mv <= x).reduce((s2, y) => s2 + this.permValue(y), 0);
            const v = Math.max(0, ...this.opps(p).map(hit)) - hit(p);
            if (v > best) { best = v; bestX = x; }
          }
          if (best < 12) return { a, s: -99 };
          c.uginX = bestX; return { a, s: 20 + best / 2, delta: -bestX };
        }
        if (delta < 0 && c.loyalty + delta + carth < 0) return { a, s: -99 };
        if (delta === -99) return { a, s: -99 };
        let s = 0;
        for (const f of a.fx) {
          if (f.k === 'removal' || f.k === 'phaseOut' || f.k === 'freeze' || f.k === 'neutralize') s += this.bestOppTarget(p, (x) => (f.k === 'removal' ? this.removalPred(f.what)(x) : f.what === 'creature' || f.k === 'phaseOut' ? x.info.isCreature : !x.info.isLand) && this.targetable(x, p)) ? 9 : -5;
          else if (f.k === 'wipe' && f.what === 'big') { const big = (q) => q.bf.filter((x) => x.info.isCreature && this.power(x) >= 4).reduce((s2, x) => s2 + this.creatureValue(x) / (x.isCommander ? 2 : 1), 0); const v = this.opps(p).reduce((s2, q) => s2 + big(q), 0) - 1.5 * big(p); s += v >= 12 ? 10 + v / 3 : -10; } // Elspeth's -3
          else if (f.k === 'wipe') s += this.scoreCast(p, { info: { ...c.info, spell: [f], etb: [], isPermanent: false, isPW: false, mana: null, isCreature: false } }, 'hand') > 0 ? 14 : -10;
          else if (f.k === 'darettiWeld') { const fod = p.bf.some((x) => x.info.types.has('Artifact') && !x.isCommander && this.permValue(x) < 5); const best = Math.max(0, ...p.gy.filter((x) => x.info.types.has('Artifact') && x.info.isPermanent).map((x) => this.cardValue(p, x))); s += fod && best >= 6 ? 6 + best : -10; }
          else if (f.k === 'draw' && (f.n || 1) >= p.library.length && !this.has(p, 'labman') && !this.has(p, 'platinum')) s -= 60; // drawing out the library loses the game (unless Jace or Platinum Angel turns it around)
          else if (f.k === 'tokens') s += 5; else if (f.k === 'draw') s += 4; else if (f.k === 'drain') s += 4;
          else if (f.k === 'drawTapped') { const n = Math.max(0, ...this.alive().map((q) => q.bf.filter((x) => x.info.isCreature && x.tapped).length)); s += n >= p.library.length && !this.has(p, 'labman') && !this.has(p, 'platinum') ? -60 : 4.5 * n; } // Tamiyo, the Moon Sage's -2 (not into an empty library)
          else if (f.k === 'counters' && f.on === 'each') s += 1.5 * p.bf.filter((x) => x.info.isCreature).length; // Ajani Steadfast's -2, with loyaltyEach below
          else if (f.k === 'tamiyoWatch') s += 1 + 2 * Math.min(2, p.bf.filter((x) => x.info.isCreature && (this.hasKw(x, 'flying') || this.power(x) >= 3)).length);
          else if (f.k === 'loyaltyEach') s += 3 * p.bf.filter((x) => x.info.isPW && (!f.other || x !== c)).length;
          else if (f.k === 'emblem' && ['tamiyo', 'damageCap1', 'freeSpells', 'jaceCounter'].includes(f.e) && (p.emblems || []).includes(f.e)) s -= 20; // a second copy of these does nothing
          else if (f.k === 'emblem' || f.k === 'massReanimate' || f.k === 'exileLibrary' || f.k === 'mindslaver' || f.k === 'liliana9' || f.k === 'piles' || f.k === 'extraTurn') s += 15;
          else if (f.k === 'lifeBecomes') s += this.opps(p).some((q) => q.life > 25) ? 10 : -5;
          else if (f.k === 'edictAll') s += this.opps(p).reduce((s2, q) => s2 + q.bf.filter((x) => x.info.isCreature).length, 0) > p.bf.filter((x) => x.info.isCreature).length * 2 ? 8 : -6;
          else if (f.k === 'cheatCreature') s += p.hand.some((x) => x.info.isCreature && (!f.tribe || this.isType(x, f.tribe))) ? 8 : -8;
          else if (f.k === 'wish') { const best = Math.max(0, ...p.exile.filter((x) => x.info.types.has('Artifact') && !x.faceDown && x.owner === p.seat).map((x) => this.cardValue(p, x))); s += best ? 3 + Math.min(14, best * 0.6) : -8; }
          else if (f.k === 'counters' || f.k === 'gain' || f.k === 'treasure' || f.k === 'reanimate' || f.k === 'regrow' || f.k === 'tutor' || f.k === 'dig' || f.k === 'loot' || f.k === 'pump' || f.k === 'food') s += 3;
          else s += 1;
        }
        if (delta > 0) s += 3; else s += delta * 1.2;
        if (c.loyalty + delta === 0) s -= 4;
        if (Math.abs(delta) >= 6 && c.loyalty + delta >= 0) s += 12;
        return { a, s, delta };
      }).sort((x, y) => y.s - x.s);
      const choice = scored[0];
      if (!choice || choice.s < -50) return false;
      const d = choice.delta ?? choice.a.delta;
      c.loyalty += d + carth > 0 ? this.counterAmount(p, d + carth, 'cost') : d + carth;
      this.emit('ability', `${c.info.name} [${d > 0 ? '+' : ''}${d}]: ${choice.a.text.slice(0, 90)}`, { seat: p.seat, cards: [c.id] });
      this.resolveEffects(p, choice.a.fx, c, null, false);
      this.checkState();
      return true;
    }

    equipStuff(p) {
      // Skullclamp-style equipment goes round again after the creature it killed is gone (draw 2 each time)
      const list = p.bf.filter((c) => c.info.isEquipment);
      for (const e of list.slice()) if (e.info.statics.some((x) => x.k === 'equipBuff' && (x.t || 0) < 0)) for (let k = 0; k < 4; k++) list.push(e);
      for (const eq of list) {
        if (eq.zone !== 'bf' || this.over || p.lost) continue;
        // Skullclamp-style (-toughness): on a creature it kills, the cheaper the better (it draws when that creature dies)
        const shrink = Math.min(0, ...eq.info.statics.filter((x) => x.k === 'equipBuff').map((x) => x.t || 0));
        const crs = p.bf.filter((c) => c.info.isCreature && !this.pacified(c));
        const best = shrink < 0
          ? (crs.filter((c) => this.toughness(c) <= -shrink && !c.isCommander).sort((a, b) => this.creatureValue(a) - this.creatureValue(b))[0] || null)
          : crs.sort((a, b) => this.creatureValue(b) - this.creatureValue(a))[0];
        if (!best || eq.attached === best.id) continue;
        if (shrink < 0 && (eq.info.equipDies || []).length && this.toughness(best) <= -shrink && this.deathDraws(p, best) + 2 > this.drawRoom(p)) continue; // Skullclamp draws 2: not into an empty library
        if (eq.attached && this.cards[eq.attached] && this.cards[eq.attached].zone === 'bf') continue;
        const cost = eq.info.equip || parseCost('2');
        if (!this.pay(p, cost)) continue;
        this.pay(p, cost, 0, true);
        eq.attached = best.id;
        this.emit('ability', `${p.name} equips ${eq.info.name} to ${this.cname(best)}.`, { seat: p.seat, cards: [eq.id, best.id] });
        this.checkState();
      }
    }

    // ----- combat -----
    canAttack(c) {
      if (!c.info.isCreature || c.tapped) return false;
      if (c.sick && !this.hasKw(c, 'haste')) return false;
      if (this.hasKw(c, 'defender') || this.pacified(c)) return false;
      if (this.has(this.P(c.ctrl), 'chasm')) return false;
      if (this.power(c) <= 0 && !c.info.masterOfCruelties) return false;
      return true;
    }
    canBlock(b, a) {
      if (!b.info.isCreature || b.tapped || this.pacified(b) || b.noBlock || b.info.cantBlock) return false;
      const ak = this.kws(a);
      if (ak.has('unblockable') || ak.has('emissary')) return false;
      if (a.p1 > 0 && this.has(this.P(a.ctrl), 'counterUnblockable')) return false; // Herald of Secret Streams
      if (ak.has('flying') && !this.hasKw(b, 'flying') && !this.hasKw(b, 'reach')) return false;
      if (ak.has('shadow') !== this.hasKw(b, 'shadow')) return false;
      if (ak.has('intimidate') && !b.info.types.has('Artifact') && ![...(b.info.colors || [])].some((x) => (a.info.colors || new Set()).has(x))) return false;
      if (a.info.landwalk && this.P(b.ctrl).bf.some((x) => x.info.isLand && this.landTypes(this.P(b.ctrl), x).includes(a.info.landwalk))) return false;
      if (a.info.protectionFrom && this.isType(b, a.info.protectionFrom)) return false;
      if (ak.has('protection') && a.info.protectionFromColors && [...(b.info.colors || [])].some((x) => a.info.protectionFromColors.includes(x))) return false;
      // equipment protection (Sword of Feast and Famine: from black and green)
      for (const eq of this.P(a.ctrl).bf) if (eq.attached === a.id) for (const st of eq.info.statics) if (st.k === 'equipBuff' && st.protect && [...(b.info.colors || [])].some((x) => st.protect.includes(x))) return false;
      return true;
    }

    chooseDefender(p, attackers) {
      const opps = this.opps(p);
      let best = null, bestS = -1e9;
      for (const q of opps) {
        if (q.protectedUntil >= this.turn) continue;
        if (this.has(q, 'chasm') || this.has(q, 'emissary')) continue;
        if (p.attackedThisTurn && p.attackedThisTurn.includes(q.seat) && this._newTargetOnly) continue;
        const blockers = q.bf.filter((b) => b.info.isCreature && !b.tapped);
        let through = 0;
        for (const a of attackers) if (!blockers.some((b) => this.canBlock(b, a))) through += this.power(a);
        const total = attackers.reduce((s, a) => s + this.power(a), 0);
        // damage that gets through matters, but table politics matters more: hit the main threat, not just the open board
        let s = Math.min(through, q.life) * 1.2 + total * 0.3 - blockers.length * 1.0 - q.life * 0.2 + this.R() * 2;
        if (this.politics) s += (this.politics / 40) * 0.6 * this.relThreat(p, q);
        if (through >= q.life) s += 100;
        if (s > bestS) { bestS = s; best = q; }
      }
      return best;
    }

    // Split attacks: the attackers a second player can't block at all, sent at that player when they are enough to
    // knock them out and the main target isn't dying to the full attack anyway. (The look-ahead tries wider splits.)
    // Kill-split: going round the other players from the lowest life, each gets just enough attackers to die through
    // their possible blocks (they block the biggest attackers they can); the rest stay on the main target, which keeps
    // enough to die too when it was dying to the whole attack.
    splitAttack(p, q, attackers, lethalish) {
      if (attackers.length < 2) return null;
      const left = attackers.slice(), sides = [];
      const through = (r, set) => {
        const bl = r.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b));
        const used = new Set(); let dmg = 0;
        for (const a of set.slice().sort((x, y) => this.power(y) - this.power(x))) {
          const b = bl.find((x) => !used.has(x) && this.canBlock(x, a) && !(this.hasKw(a, 'menace')));
          if (b) { used.add(b); if (this.hasKw(a, 'trample')) dmg += Math.max(0, this.power(a) - this.toughness(b)); }
          else dmg += this.scaleDamage(p.seat, r.seat, this.power(a));
        }
        return dmg;
      };
      const qNeeds = lethalish ? q.life : 0;
      for (const r of this.splitTargets(p, q).sort((a, b) => a.life - b.life)) {
        const pick = [];
        for (const a of left.slice().sort((x, y) => this.power(x) - this.power(y))) { if (through(r, pick) >= r.life) break; pick.push(a); }
        if (through(r, pick) < r.life) { // smallest-first wasn't enough: try biggest-first
          pick.length = 0;
          for (const a of left.slice().sort((x, y) => this.power(y) - this.power(x))) { if (through(r, pick) >= r.life) break; pick.push(a); }
        }
        const rest = left.filter((a) => !pick.includes(a));
        if (through(r, pick) >= r.life && rest.length && (!qNeeds || through(q, rest) >= qNeeds)) { sides.push({ q: r, list: pick }); left.splice(0, left.length, ...rest); }
      }
      return sides.length ? sides : null;
    }
    splitTargets(p, q) { return this.opps(p).filter((r) => r !== q && r.protectedUntil < this.turn && !this.has(r, 'chasm') && !this.has(r, 'emissary') && !this.has(r, 'sphere')); }
    // attackers r has no untapped creature to block (flying over ground blockers, menace into one blocker, unblockable)
    freeAgainst(r, attackers) {
      const bl = r.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b));
      return attackers.filter((a) => { if (a.info.attack.some((f) => f.k === 'cheatAttack')) return false; const can = bl.filter((b) => this.canBlock(b, a)).length; return can === 0 || (this.hasKw(a, 'menace') && can < 2); });
    }
    combat(p) {
      if (p.lost || this.over) return;
      let cands = p.bf.filter((c) => this.canAttack(c));
      if (!cands.length) return;
      // a copy from before the attack, for the defenders' block decisions (see chooseBlocks)
      this._preCombat = null;
      if (this.lookahead && !this._inLook && !this._forcedAtk) { const n0 = this._lookN; this._preCombat = { g: this.cloneForLook(), p: p.seat }; this._lookN = n0; }
      const q = this._forcedAtk ? this.P(this._forcedAtk.q) : this.chooseDefender(p, cands);
      if (!q) return;
      const blockers = q.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b));
      const totalPower = cands.reduce((s, a) => s + this.power(a), 0);
      const lethalish = totalPower >= q.life;
      const attackers = [];
      const fsOf = (c) => this.hasKw(c, 'first strike') || this.hasKw(c, 'double strike');
      for (const a of cands.sort((x, y) => this.power(y) - this.power(x))) {
        const [ap, at] = this.pt(a);
        const ak = this.kws(a);
        const able = blockers.filter((b) => this.canBlock(b, a));
        const aVal = this.creatureValue(a);
        // How each possible block goes: does the blocker kill the attacker, and does it survive?
        // First strike matters: an attacker that kills its blocker first takes no damage back.
        const outcomes = able.map((b) => {
          const [bp, bt] = this.pt(b);
          const aKillsB = (ap >= bt || ak.has('deathtouch')) && !this.hasKw(b, 'indestructible');
          const aFirst = fsOf(a) && !fsOf(b);
          const bKillsA = !(aFirst && aKillsB) && (bp >= at || (this.hasKw(b, 'deathtouch') && bp > 0)) && !ak.has('indestructible');
          return { b, aKillsB, bKillsA, bVal: this.creatureValue(b) };
        });
        const badBlock = outcomes.some((o) => o.bKillsA && !o.aKillsB);
        // a trade is only fine if what we lose is worth no more than what they lose (a 1/1 deathtouch for our bomb is not)
        const worstTrade = outcomes.filter((o) => o.bKillsA && o.aKillsB).sort((x, y) => x.bVal - y.bVal)[0];
        const badTrade = worstTrade && aVal > worstTrade.bVal + 2 && aVal >= 6;
        let go = !badBlock && !badTrade;
        // Kaalia and friends: the attack trigger is the point, so swing whenever there is something to put in
        const cheat = a.info.attack.some((f) => f.k === 'cheatAttack' && p.hand.some((c) => this.cheatFits(c, f, cands.length)));
        const valueTrig = cheat || a.info.attack.some((f) => f.k === 'extraCombat' || f.k === 'tokens' || f.k === 'draw' || f.k === 'drain');
        if (cheat) go = true;
        else if (valueTrig && !badBlock) go = true;
        if (lethalish) go = true;
        if (a.isCommander && !cheat && (badBlock || worstTrade) && !lethalish) go = false;
        // creatures that are worth more at home don't swing into risk: walls, damage sponges, engines, mana dorks
        const defensive = a.info.statics.some((x) => x.k === 'palisade') || (at >= ap * 2 && ap <= 3) || a.info.mana || a.info.sacOutlet || a.info.statics.some((x) => ['anthem', 'debuff', 'tokenDouble', 'counterDouble', 'gisela', 'dmgTriple', 'allIndestructible', 'abolisher'].includes(x.k)) || a.info.triggers.length || a.info.deathWatch.length
          || (a.info.activated || []).some((x) => x.tap); // tap-ability creatures (Hermit Druid) are worth more untapped and alive than a point of damage
        if (defensive && !lethalish && !ak.has('vigilance') && !valueTrig && (able.length || ap <= 2)) go = false;
        if (ap <= 0 && !valueTrig) go = false;
        if (a.info.mustAttack || this._forceAttack) go = true;
        if (go) attackers.push(a);
      }
      // Hold back enough blockers to survive the crack-back: estimate what the opponents can swing at us
      // next turn and keep the creatures that would block best (vigilance attackers still block).
      if (!this._forceAttack) {
        const canBlockAny = (b, a) => { const t = b.tapped; b.tapped = false; const r = this.canBlock(b, a); b.tapped = t; return r; };
        // When we can kill q, send only what it takes (their blockers stop our biggest attackers they can block)
        const needed = new Set();
        if (lethalish) {
          const qBlockers = q.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b));
          const lethalWith = (set) => {
            const used = new Set(); let dmg = 0;
            for (const a of set.slice().sort((x, y) => this.power(y) - this.power(x))) {
              const b = qBlockers.find((x) => !used.has(x) && this.canBlock(x, a));
              if (b) { used.add(b); if (this.hasKw(a, 'trample')) dmg += Math.max(0, this.power(a) - this.toughness(b)); }
              else dmg += this.scaleDamage(p.seat, q.seat, this.power(a));
            }
            return dmg >= q.life;
          };
          const pick = [];
          for (const a of attackers.slice().sort((x, y) => this.power(y) - this.power(x))) { pick.push(a); if (lethalWith(pick)) break; }
          if (lethalWith(pick)) for (const a of pick) needed.add(a);
          else for (const a of attackers) needed.add(a); // can't prove it's lethal: keep everything in
        }
        // What the other opponents can swing at us before our next turn: each attacks on their own turn, and
        // the creatures we keep home can block each time (blocking doesn't tap them)
        const incoming = (home) => {
          let total = 0;
          for (const o of this.opps(p)) {
            if (lethalish && o === q) continue; // q is about to die
            const atk = o.bf.filter((c) => c.info.isCreature && !this.pacified(c) && this.power(c) > 0).sort((x, y) => this.power(y) - this.power(x));
            const used = new Set(); let dmg = 0;
            for (const a of atk) {
              const b = home.find((h) => !used.has(h) && canBlockAny(h, a));
              if (b) used.add(b); else dmg += this.scaleDamage(o.seat, p.seat, this.power(a));
            }
            total += dmg;
          }
          return total;
        };
        const homeOf = () => p.bf.filter((c) => c.info.isCreature && !this.pacified(c) && (!attackers.includes(c) || this.hasKw(c, 'vigilance')));
        // drop the least valuable non-vigilance attacker that would be a useful blocker until we are safe
        // (never one we need for the kill)
        for (let guard = 0; guard < 10 && attackers.length && incoming(homeOf()) >= p.life; guard++) {
          const keep = attackers.filter((a) => !needed.has(a) && !this.hasKw(a, 'vigilance') && !a.info.mustAttack && this.toughness(a) >= 2 && !a.info.attack.some((f) => f.k === 'cheatAttack'))
            .sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0];
          if (!keep) break;
          attackers.splice(attackers.indexOf(keep), 1);
        }
        // a sure kill: creatures beyond what's needed add nothing (that player is dead anyway), so they stay home
        // unless attacking costs nothing (vigilance) or they have an attack trigger worth having
        if (lethalish && needed.size < attackers.length) {
          for (const a of attackers.slice()) if (!needed.has(a) && !this.hasKw(a, 'vigilance') && !a.info.mustAttack && !a.info.attack.length) attackers.splice(attackers.indexOf(a), 1);
        }
      }
      // Look-ahead on the attack: when a creature could die to a block, play the combat out on copies of the game (the
      // defender blocks with its own logic) with and without each risky attacker, and with no attack, and keep the best.
      if (this._forcedAtk) attackers.splice(0, attackers.length, ...this._forcedAtk.ids.concat(this._forcedAtk.side ? [].concat(this._forcedAtk.side).flatMap((sd) => sd.ids) : []).map((id) => this.cards[id]).filter((c) => c && c.zone === 'bf' && this.canAttack(c)));
      else if (this.lookahead && !this._inLook && !this._forceAttack && attackers.length && this.looseLook !== false && (!this.looseSeats || this.looseSeats.includes(p.seat)) && (!this.lookSeats || this.lookSeats.includes(p.seat))) {
        const killedBy = (a) => blockers.some((b) => this.canBlock(b, a) && ((this.power(b) >= this.toughness(a) - a.dmg) || (this.hasKw(b, 'deathtouch') && this.power(b) > 0)) && !this.hasKw(a, 'indestructible'));
        const risky = attackers.filter(killedBy).sort((x, y) => this.creatureValue(y) - this.creatureValue(x)).slice(0, 3);
        const held = p.bf.filter((c) => !attackers.includes(c) && this.canAttack(c) && this.power(c) > 0).sort((x, y) => this.power(y) - this.power(x));
        const others = this.splitTargets(p, q);
        const freeSomewhere = others.some((r) => this.freeAgainst(r, attackers).length);
        if (risky.length || held.length || freeSomewhere) {
          // a plan: who attacks q, and optionally who goes at a second player
          const P = (main, side = null) => Object.assign(main, { side });
          const plans = [P(attackers.slice()), ...risky.map((r) => P(attackers.filter((a) => a !== r))), P([])];
          if (held.length) { plans.push(P(attackers.concat(held))); for (const h of held.slice(0, 2)) plans.push(P(attackers.concat(h))); }
          // splits: the kill-split with what attacks now, and with every creature that can attack
          for (const pool of held.length ? [attackers, attackers.concat(held)] : [attackers]) {
            const sp = this.splitAttack(p, q, pool, false);
            if (sp) { const used = new Set(sp.flatMap((sd) => sd.list)); plans.push(P(pool.filter((a) => !used.has(a)), sp.map((sd) => ({ q: sd.q.seat, ids: sd.list.map((a) => a.id) })))); }
          }
          for (const r of others.slice(0, 2)) { const f = this.freeAgainst(r, attackers.concat(held)); if (f.length) plans.push(P(attackers.concat(held).filter((a) => !f.includes(a)), { q: r.seat, ids: f.map((a) => a.id) })); }
          const res = plans.map((plan) => {
            try {
              const g = this.cloneForLook(), pp = g.players[p.seat];
              g._forcedAtk = { q: q.seat, ids: plan.map((a) => a.id), side: plan.side }; g.combat(pp); g._forcedAtk = null;
              if (!g.over && !pp.lost) { g.emptyPools(); g.phase = 'main 2'; g.mainPhase(pp, true); }
              return g.lookValue(g, p.seat);
            } catch (e) { if (e instanceof TimeUp) throw e; return -Infinity; }
          });
          let bi = 0; for (let i = 1; i < res.length; i++) if (res[i] > res[bi]) bi = i;
          if (!(bi > 0 && res[bi] > res[0] + 4)) bi = 0;
          // whatever plan wins is what happens (the kept plan included: no split it wasn't judged with)
          const pl = plans[bi], sideIds = new Set(pl.side ? [].concat(pl.side).flatMap((sd) => sd.ids) : []);
          attackers.splice(0, attackers.length, ...pl, ...p.bf.filter((c) => sideIds.has(c.id) && !pl.includes(c))); this._planAtk = { side: pl.side };
          if (!attackers.length) return;
        }
      }
      // Sphere of Safety: pay X per attacker
      const sphereX = this.has(q, 'sphere') ? q.bf.filter((c) => c.info.types.has('Enchantment')).length : 0;
      if (sphereX) {
        const afford = Math.floor(this.availableMana(p) / sphereX);
        attackers.splice(afford);
        if (attackers.length) this.pay(p, parseCost(String(sphereX * attackers.length)), 0, true);
      }
      p.attackedThisTurn = (p.attackedThisTurn && p.attackedTurn === this.turn ? p.attackedThisTurn : []).concat(q.seat); p.attackedTurn = this.turn;
      for (const a of attackers) {
        if (a.info.dethrone && q.life >= Math.max(...this.alive().map((x) => x.life))) a.p1 += this.counterAmount(p, 1);
        if ((q.emblems || []).includes('garruk')) { a.eot.p += 5; a.eot.t += 5; a.eot.kw.push('trample'); }
      }
      const alone = attackers.find((a) => a.info.attackAlone);
      if (alone) {
        const canBeBlocked = blockers.some((b) => this.canBlock(b, alone));
        const others = attackers.filter((a) => a !== alone).reduce((s2, a) => s2 + this.power(a), 0);
        if (alone.info.masterOfCruelties && !canBeBlocked && q.life > 4 && others < q.life) attackers.splice(0, attackers.length, alone);
        else attackers.splice(attackers.indexOf(alone), 1);
      }
      if (!attackers.length) return;
      // assign some attackers to opposing planeswalkers
      const assign = new Map();
      const walkers = q.bf.filter((c) => c.info.isPW).sort((a, b) => b.loyalty - a.loyalty);
      const pool = attackers.filter((a) => !a.info.attack.some((f) => f.k === 'cheatAttack'));
      for (const w of walkers) {
        if (w.loyalty < 3 && pool.length < 3) continue;
        let need = w.loyalty;
        for (const a of pool.slice().sort((x, y) => this.power(x) - this.power(y))) {
          if (need <= 0) break;
          if (q.life <= 10) break;
          assign.set(a.id, w.id); need -= this.power(a); pool.splice(pool.indexOf(a), 1);
        }
      }
      // split attacks: some attackers go at a second player (the look-ahead's plan, or splitAttack's pick)
      let sides = [];
      const plan = this._forcedAtk || this._planAtk; this._planAtk = null;
      if (plan && plan.side) for (const sd of [].concat(plan.side)) { const r = this.P(sd.q), ids = new Set(sd.ids), list = attackers.filter((a) => ids.has(a.id)); if (!r.lost && r !== q && list.length) sides.push({ q: r, list }); }
      else if (!plan && !this._newTargetOnly) sides = this.splitAttack(p, q, attackers, lethalish) || [];
      const sideSet = new Set(sides.flatMap((sd) => sd.list));
      for (const a of sideSet) assign.delete(a.id);
      for (const a of attackers) { if (!this.hasKw(a, 'vigilance')) a.tapped = true; a.attacking = true; }
      p.attackersTurn = this.turn; p.attackersCount = (p.attackersTurn === this.turn ? p.attackersCount || 0 : 0) + attackers.length;
      const announce = (qq, list, info) => {
        const names = list.map((a) => { const w = assign.get(a.id); return `${this.cname(a)} ${this.power(a)}/${this.toughness(a)}${w ? ` → ${this.cards[w].info.name}` : ''}`; });
        this.emit('attack', `${p.name} attacks ${qq.name} with ${this.listNames(names)} (${list.reduce((s, a) => s + this.power(a), 0)} power).`, { seat: p.seat, cards: list.map((a) => a.id), attackers: info, target: qq.seat });
      };
      const mainA = attackers.filter((a) => !sideSet.has(a));
      const atkInfo = mainA.map((a) => ({ id: a.id, to: assign.get(a.id) || null }));
      for (const sd of sides) sd.info = sd.list.map((a) => ({ id: a.id, to: null }));
      if (mainA.length) announce(q, mainA, atkInfo);
      if (this._preCombat) this._preCombat.plan = { q: q.seat, ids: mainA.map((a) => a.id), side: sides.map((sd) => ({ q: sd.q.seat, ids: sd.list.map((a) => a.id) })) };
      for (const sd of sides) { announce(sd.q, sd.list, sd.info); p.attackedThisTurn.push(sd.q.seat); }
      // Alibou: artifact creatures attacking
      if (attackers.some((a) => a.info.types.has('Artifact'))) for (const src of p.bf) if (src.info.triggers.some((t) => t.k === 'alibou')) {
        const x = p.bf.filter((c) => c.info.types.has('Artifact') && c.tapped).length;
        if (x) { this.dealDamageAny(p, x, src, 'Alibou'); this.resolveEffect(p, { k: 'scry', n: x }, src, 0, true); }
      }
      // attack triggers: only the declared attackers (a creature put onto the battlefield attacking never "attacked")
      this._attackTarget = q;
      for (const a of attackers.slice()) {
        for (const f of a.info.attack) {
          if (f.k === 'cheatAttack') {
            const cheat = p.hand.filter((c) => this.cheatFits(c, f, attackers.length)).sort((x, y) => this.creatureValue(y) - this.creatureValue(x))[0];
            if (cheat) {
              this.removeFrom(p.hand, cheat);
              this.enterBattlefield(cheat, p, { tapped: true });
              cheat.attacking = true; cheat.enteredAttacking = this.turn; attackers.push(cheat); atkInfo.push({ id: cheat.id, to: null });
              this.emit('trigger', `${a.info.name} puts ${cheat.info.name} onto the battlefield attacking!`, { seat: p.seat, cards: [cheat.id, a.id], attackers: atkInfo, target: q.seat });
            }
          } else this.resolveEffects(p, [f], a, null, true);
        }
        for (const eq of p.bf) if (eq.attached === a.id && eq.info.attack && eq.info.attack.length) this.resolveEffects(p, eq.info.attack, eq, null, true);
        // mobilize N: N 1/1 Warriors enter tapped and attacking, sacrificed at the end step
        if (a.info.mobilize) {
          const made = [];
          for (let k = 0; k < a.info.mobilize * this.tokenMult(p); k++) { const t = this.makeToken(p, { p: 1, t: 1, sub: 'Warrior', colors: 'red' }); t.ctrl = p.seat; p.bf.push(t); t.tapped = true; t.attacking = true; t.enteredAttacking = this.turn; t.eotSac = true; attackers.push(t); atkInfo.push({ id: t.id, to: null }); made.push(t); }
          this.emit('token', `${a.info.name} mobilizes: ${made.length} Warrior tokens join the attack.`, { seat: p.seat, cards: made.map((t) => t.id), attackers: atkInfo, target: q.seat });
        }
        for (const src of [...p.bf]) for (const t of src.info.triggers) if (t.k === 'tribalAttack' && (a.info.subtypes || []).includes(t.sub)) this.resolveEffects(p, t.fx, src, null, false);
      }
      // "whenever you attack": once per attack (Raffine's connive, Chocobo Knights)
      this._attackersNow = attackers;
      for (const src of [...p.bf]) for (const t of src.info.triggers) if (t.k === 'youAttack' && src.zone === 'bf') this.resolveEffects(p, t.fx, src, `${src.info.name} triggers`, false);
      this._attackersNow = null;
      this.checkState();
      if (this.over) { attackers.forEach((a) => (a.attacking = false)); return; }
      // each defender blocks and takes damage from the creatures sent at them
      const all = attackers;
      const fight = (q, attackers, atkInfo) => {
        if (q.lost || this.over || !attackers.length) return;
        this.flashEmperor(q, attackers);
        // blocks
        const blocks = this.chooseBlocks(q, attackers.filter((a) => a.zone === 'bf' && !assign.get(a.id)), p);
        // creatures left over step in front of attackers sent at a planeswalker: a block that survives, or a chump when the walker would die
        for (const a of attackers.filter((x) => x.zone === 'bf' && assign.get(x.id) && !this.hasKw(x, 'menace')).sort((x, y) => this.power(y) - this.power(x))) {
          const w = this.cards[assign.get(a.id)], [ap, at] = this.pt(a), ak = this.kws(a), busy = new Set([...blocks.values()].flat());
          const able = q.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b) && !busy.has(b) && this.canBlock(b, a));
          const lives = (b) => (this.pt(b)[1] > ap || this.hasKw(b, 'indestructible')) && !ak.has('deathtouch'), kills = (b) => (this.pt(b)[0] >= at || this.hasKw(b, 'deathtouch')) && !ak.has('indestructible');
          const b = able.find((x) => kills(x) && lives(x)) || able.find(lives) || (ap >= w.loyalty && !ak.has('trample') ? able.filter((x) => !x.isCommander && this.creatureValue(x) < this.permValue(w)).sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0] : null);
          if (b) blocks.set(a.id, [b]);
        }
        const blkInfo = [...blocks.entries()].flatMap(([aid, bs]) => bs.map((b) => ({ id: b.id, blocks: aid })));
        if (blkInfo.length) this.emit('block', `${q.name} blocks: ${[...blocks.entries()].map(([aid, bs]) => `${bs.map((b) => this.cname(b)).join(' + ')} blocks ${this.cards[aid].info.name}`).join('; ')}.`, { seat: q.seat, cards: blkInfo.map((b) => b.id), attackers: atkInfo, blockers: blkInfo, target: q.seat });
        // Spore Frog style fogs when the hit would be big
        const incoming = attackers.filter((a) => a.zone === 'bf' && !blocks.has(a.id)).reduce((s2, a) => s2 + this.power(a), 0);
        const frog = q.bf.find((c) => c.info.fogSac);
        // Teferi's Protection against a lethal attack (life or commander damage)
        const lethal = incoming >= q.life || attackers.some((a) => a.zone === 'bf' && !blocks.has(a.id) && a.isCommander && (q.cmdDmg[a.id] || 0) + this.power(a) >= 21);
        const tp = lethal && q.protectedUntil < this.turn && this.fogTurn !== this.turn && !this.abolished(q) && q.hand.find((c) => c.info.spell && c.info.spell.some((f) => f.k === 'protect' && !f.single) && /protection from everything/i.test(c.info.text || '') && this.pay(q, this.costFor(q, c, 'hand')));
        if (tp && this.tryProtect(q, q.bf.slice(), p, true, tp)) { for (const a of attackers) a.attacking = false; this.emit('damage', `No combat damage is dealt to ${q.name}.`, { seat: p.seat, target: q.seat }); return; }
        // a blocking Sakura-Tribe Elder that would die anyway is sacrificed for its value before damage
        if (!this.abolished(q, 'ability')) for (const [aid, bs] of blocks) for (const b of bs) { const ab = this.selfSacAb(b); if (ab && b.zone === 'bf' && this.power(this.cards[aid]) >= this.toughness(b)) this.doActivate(q, { c: b, ab, fodder: [], cost: ab.cost }); }
        if (frog && !this.abolished(q, 'ability') && (incoming >= q.life || incoming >= (this.has(q, 'muldrotha') ? 4 : 10))) { this.destroy(frog, 'sacrificed', true); this.fogTurn = this.turn; this.emit('response', `${q.name} sacrifices ${frog.info.name}: all combat damage this turn is prevented.`, { seat: q.seat, cards: [frog.id] }); }
        // a fog from hand (Prismatic Strands) against a lethal or very big hit; cast like any spell (it can be countered)
        if (this.fogTurn !== this.turn && !this.abolished(q) && (incoming >= q.life || incoming >= Math.max(12, q.life * 0.4))) {
          const fogC = q.hand.find((c) => (c.info.isInstant || c.info.flash) && c.info.spell.some((f) => f.k === 'fog') && this.pay(q, this.costFor(q, c, 'hand')));
          if (fogC) { this.emit('response', `${q.name} answers the attack with ${fogC.info.name}.`, { seat: q.seat, cards: [fogC.id] }); this.castSpell(q, fogC, 'hand'); }
        }
        // Osgir: sacrifice artifacts for +2/+0 on an unblocked attacker when it gets there
        const osg = p.bf.find((c) => c.info.osgirPump);
        if (osg) {
          const unb = attackers.filter((a) => a.zone === 'bf' && !blocks.has(a.id) && !assign.get(a.id));
          const fod = p.bf.filter((c) => c.info.types.has('Artifact') && !c.info.isCreature && ((c.token && !c.info.mv) || this.permValue(c) < 3));
          const gap = q.life - unb.reduce((s2, a) => s2 + this.power(a), 0);
          if (unb.length && gap > 0 && gap <= fod.length * 2 && this.availableMana(p) >= Math.ceil(gap / 2)) {
            for (let i = 0; i < Math.ceil(gap / 2); i++) { if (!this.pay(p, parseCost('1'))) break; this.pay(p, parseCost('1'), 0, true); this.destroy(fod[i], 'sacrificed', true); unb[0].eot.p += 2; }
            this.emit('ability', `${p.name} feeds artifacts to Osgir: ${unb[0].info.name} gets bigger.`, { seat: p.seat, cards: [osg.id, unb[0].id] });
          }
        }
        if (this.fogTurn === this.turn) { for (const a of attackers) a.attacking = false; this.emit('damage', `No combat damage is dealt.`, { seat: p.seat, target: q.seat }); return; }
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
            if (dmg <= 0 || (a.neutralized && a.neutralized >= this.turn)) continue;
            const bs = (blocks.get(a.id) || []).filter((b) => b.zone === 'bf');
            if (blocks.has(a.id) && (blocks.get(a.id) || []).length) {
              for (const b of bs) {
                const need = ak.has('deathtouch') ? 1 : Math.max(0, this.toughness(b) - b.dmg);
                const d = Math.min(dmg, need || dmg);
                const preventB = (b.neutralized && b.neutralized >= this.turn) || this.hasKw(b, 'emissary');
                const dd = preventB ? 0 : this.scaleDamage(p.seat, q.seat, d);
                if (!preventB) { const hit = this.permDmg(b, dd); if (ak.has('deathtouch')) hit.dt = true; }
                dmg -= d;
                if (ak.has('lifelink')) lifelinkGain.push(dd);
                if (dmg <= 0) break;
              }
              const tw = assign.get(a.id) && this.cards[assign.get(a.id)];
              if (dmg > 0 && ak.has('trample') && tw && tw.zone === 'bf') { const dd = this.scaleDamage(p.seat, q.seat, dmg); tw.loyalty -= dd; if (ak.has('lifelink')) lifelinkGain.push(dd); } // trample over a blocker goes on to the planeswalker
              else if (dmg > 0 && ak.has('trample')) this.hitPlayer(p, q, a, dmg, lifelinkGain, (n) => (dealtToPlayer += n));
              else if (dmg > 0 && bs.length) { const dd = this.scaleDamage(p.seat, q.seat, dmg); this.permDmg(bs[0], dd); if (ak.has('lifelink')) lifelinkGain.push(dd); }
            } else {
              if (a.info.masterOfCruelties && a.enteredAttacking !== this.turn) { if (q.life > 1 && q.protectedUntil < this.turn) { this.loseLife(q, q.life - 1, a); this.emit('combo', `Master of Cruelties goes unblocked: ${q.name}'s life total becomes 1!`, { seat: p.seat, cards: [a.id], target: q.seat }); } continue; }
              const wid = assign.get(a.id);
              const w = wid && this.cards[wid];
              if (w && w.zone === 'bf') { const dd = this.scaleDamage(p.seat, q.seat, dmg); this.permDmg(w, dd); if (ak.has('lifelink')) lifelinkGain.push(dd); if (w.vraskaShield != null) { this.destroy(a); this.emit('removal', `Vraska destroys ${a.info.name}.`, { seat: q.seat, cards: [a.id] }); } }
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
              let d = this.scaleDamage(q.seat, p.seat, this.power(b));
              if ((b.neutralized && b.neutralized >= this.turn) || (a.neutralized && a.neutralized >= this.turn) || this.hasKw(a, 'emissary')) d = 0;
              if (a.info.types.has('Artifact') && this.has(p, 'losheel')) d = 0;
              if (d > 0) { const hit = this.permDmg(a, d); if (bk.has('deathtouch')) hit.dt = true; if (bk.has('lifelink')) this.gainLife(q, d); }
            }
          }
          if (lifelinkGain.length) { for (const n of lifelinkGain) if (n > 0) this.gainLife(p, n); lifelinkGain.length = 0; }
          this.checkState();
        };
        const anyFS = attackers.concat(...blocks.values()).some((c) => this.hasKw(c, 'first strike') || this.hasKw(c, 'double strike'));
        if (anyFS) step(true);
        step(false);
        const lostTxt = q.lost ? '' : ` ${q.name} is at ${q.life}.`;
        this.emit('damage', `Combat damage: ${dealtToPlayer} to ${q.name}.${lostTxt}`, { seat: p.seat, attackers: atkInfo.filter((x) => this.cards[x.id].zone === 'bf'), blockers: blkInfo.filter((x) => this.cards[x.id].zone === 'bf'), target: q.seat });
      };
      fight(q, all.filter((a) => !sideSet.has(a)), atkInfo);
      for (const sd of sides) fight(sd.q, sd.list.filter((a) => a.zone === 'bf'), sd.info);
      for (const a of all) a.attacking = false;
      // additional combat phases, one per trigger that granted one (capped so a loop can't run forever)
      const queued = this._extraCombats || []; this._extraCombats = [];
      if (p.extraCombatsTurn !== this.turn) { p.extraCombatsTurn = this.turn; p.extraCombats = 0; }
      for (const { fx: extra, src } of queued) {
        if (this.over || p.lost || p.extraCombats >= 4) break;
        p.extraCombats++;
        // Aurelia untaps all your creatures; Bloodthirster untaps only itself; others untap the attackers
        for (const c of p.bf) if (c.info.isCreature && (extra.untapAll || (extra.untapSelf ? c === src : attackers.includes(c)))) c.tapped = false;
        this.emit('combo', `${src ? src.info.name + ': ' : ''}${p.name} ${extra.untapAll ? 'untaps all creatures and ' : extra.untapSelf ? `untaps ${src ? src.info.name : 'it'} and ` : ''}gets an additional combat phase!`, { seat: p.seat, cards: src ? [src.id] : [] });
        this._newTargetOnly = !!extra.newTarget;
        this.combat(p);
        this._newTargetOnly = false;
      }
    }

    // Damage to a player: prevention, redirection and caps
    // damage to a permanent; Palisade Giant takes what would be dealt to its controller's other permanents. Returns who took it.
    permDmg(c, d) {
      const giant = d > 0 && c.zone === 'bf' && this.P(c.ctrl).bf.find((x) => x !== c && x.info.isCreature && x.info.statics.some((st) => st.k === 'palisade'));
      if (giant) { giant.dmg += d; return giant; }
      if (c.info.isPW && !c.info.isCreature) c.loyalty -= d; else c.dmg += d;
      return c;
    }
    preventPlayerDamage(q, dmg, fromCreature) {
      if (this.has(q, 'chasm')) return 0;
      if (fromCreature && this.has(q, 'emissary')) return 0;
      if ((q.emblems || []).includes('damageCap1')) dmg = Math.min(dmg, 1);
      const giant = q.bf.find((c) => c.info.statics.some((x) => x.k === 'palisade'));
      if (giant && dmg > 0) { giant.dmg += dmg; this._redirected = dmg; this.checkState(); return 0; } // still dealt (to the Giant): lifelink counts it
      return dmg;
    }
    sowerEcho(q, n) {
      for (const pl of this.alive()) for (const c of pl.bf) if (c.info.sower && c.sowerPair && c.sowerPair.includes(q.seat)) { const other = this.P(c.sowerPair.find((x) => x !== q.seat)); if (other && !other.lost) this.loseLife(other, n, c); }
    }
    hitPlayer(p, q, a, dmg, ll, tally) {
      if (q.lost) return;
      if (q.protectedUntil >= this.turn) return;
      this._redirected = 0;
      dmg = this.preventPlayerDamage(q, this.scaleDamage(p.seat, q.seat, dmg), true);
      if (!dmg) { if (this._redirected && this.hasKw(a, 'lifelink')) ll.push(this._redirected); return; }
      this._combatDealt = dmg;
      if (this.isType(a, 'Human') && this.has(q, 'humanBane')) { this.destroy(a); }
      this.sowerEcho(q, dmg);
      if (p !== q) for (const x of p.bf) for (const t of x.info.triggers) if (t.k === 'gix' && this.canPayLife(p, 1)) { this.loseLife(p, 1); this.draw(p, 1); this.emit('draw', `Gix: ${p.name} pays 1 life and draws.`, { seat: p.seat, cards: [x.id] }); }
      let n;
      if (this.hasKw(a, 'infect')) { q.poison += dmg; n = dmg; } else n = this.loseLife(q, dmg, a);
      tally(n);
      if (a.tamiyoBy != null && !this.P(a.tamiyoBy).lost) { this.draw(this.P(a.tamiyoBy), 1); this.emit('draw', `Tamiyo, Field Researcher: ${this.P(a.tamiyoBy).name} draws (${a.info.name} hit).`, { seat: a.tamiyoBy, cards: [a.id] }); }
      const dealt = this.hasKw(a, 'infect') ? dmg : (n ? dmg : 0); // damage dealt; Bloodletter only doubles the life lost
      if (a.isCommander && dealt) q.cmdDmg[a.id] = (q.cmdDmg[a.id] || 0) + dealt;
      if (this.hasKw(a, 'lifelink')) ll.push(dealt);
      this._combatDefender = q;
      for (const g of p.bf) if (g.info.triggers.some((t) => t.k === 'gnawbone')) this.addToken(p, { treasure: true }, n, false);
      if (dealt) for (const t of p.bf) if (t.info.toski) { this.draw(p, 1); this.emit('draw', `Toski: ${this.cname(a)} hit ${q.name}, ${p.name} draws a card.`, { seat: p.seat, cards: [t.id] }); }
      if (a.info.combatDmg.length) this.resolveEffects(p, a.info.combatDmg, a, null, true);
      for (const eq of p.bf) if (eq.attached === a.id && eq.info.combatDmg.length) this.resolveEffects(p, eq.info.combatDmg, eq, null, true);
    }

    // Decision fork: try each option on a copy of the game, play on to `seat`'s next turn, and score the board from
    // `seat`'s view (lookValue, the network's win chance included). Returns the best option's index, or 0 (the
    // rules' own choice) unless another is clearly better. setup(g, option) applies the option to the copy and plays it.
    // Every option's copy gets the same shuffles (same luck), so options are compared fairly. toNextTurn: play on to
    // seat's next turn; otherwise stop when setup returns (the end of the current turn, for blocks: less noise).
    decide(seat, base, options, setup, margin = 4, toNextTurn = false) {
      const n0 = base._lookN || 0;
      const res = options.map((o) => {
        try {
          base._lookN = n0; const g = base.cloneForLook();
          setup(g, o);
          if (toNextTurn && !g.over && !g.players[seat].lost) g.playToTurnOf(seat);
          return g.lookValue(g, seat);
        } catch (e) { if (e instanceof TimeUp) throw e; return -Infinity; }
      });
      let bi = 0; for (let i = 1; i < res.length; i++) if (res[i] > res[bi]) bi = i;
      return bi > 0 && res[bi] > res[0] + margin ? bi : 0;
    }
    // Blocks: the rules' plan, no blocks, the plan without each of its blocks, and the plan plus a block on each
    // unblocked attacker, each played out from before the attack (same attack, these blocks) and judged by decide().
    chooseBlocks(q, attackers, p) {
      const base = this.declareBlocks(q, attackers, p);
      const pre = this._preCombat;
      if (!pre || !pre.plan || pre.p !== p.seat || this._inLook || this.looseLook === false || (this.looseSeats && !this.looseSeats.includes(q.seat))) return base;
      const avail = q.bf.filter((b) => b.info.isCreature && !b.tapped && !this.pacified(b));
      if (!avail.length || !attackers.some((a) => avail.some((b) => this.canBlock(b, a)))) return base;
      const plans = [base, new Map()];
      for (const [aid] of [...base].slice(0, 3)) { const m = new Map(base); m.delete(aid); plans.push(m); }
      const used = new Set([...base.values()].flat());
      for (const a of attackers.filter((x) => !base.has(x.id)).sort((x, y) => this.power(y) - this.power(x)).slice(0, 3)) {
        const b = avail.filter((x) => !used.has(x) && this.canBlock(x, a) && !x.isCommander).sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0];
        if (b && !(this.hasKw(a, 'menace'))) { const m = new Map(base); m.set(a.id, [b]); plans.push(m); }
      }
      // double blocks: two cheap blockers that together kill one of the biggest attackers
      for (const a of attackers.slice().sort((x, y) => this.creatureValue(y) - this.creatureValue(x)).slice(0, 2)) {
        if (this.hasKw(a, 'indestructible')) continue;
        const free = avail.filter((x) => this.canBlock(x, a) && !x.isCommander && ![...base].some(([aid, bs]) => aid !== a.id && bs.includes(x))).sort((x, y) => this.creatureValue(x) - this.creatureValue(y));
        for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
          if (this.power(free[i]) + this.power(free[j]) >= this.toughness(a) - a.dmg || this.hasKw(free[i], 'deathtouch') || this.hasKw(free[j], 'deathtouch')) { const m = new Map(base); m.set(a.id, [free[i], free[j]]); plans.push(m); i = j = free.length; }
        }
      }
      const key = (m) => [...m].map(([a, bs]) => a + ':' + bs.map((b) => b.id).join('+')).sort().join(',');
      const uniq = plans.filter((m, i) => plans.findIndex((x) => key(x) === key(m)) === i);
      if (uniq.length < 2) return base;
      const bi = this.decide(q.seat, pre.g, uniq, (g, m) => {
        const pp = g.players[p.seat];
        g._forcedAtk = pre.plan; g._forcedBlocks = { q: q.seat, ids: [...m].map(([a, bs]) => [a, bs.map((b) => b.id)]) };
        g.phase = 'combat'; g.combat(pp); g._forcedAtk = null; g._forcedBlocks = null;
        if (!g.over && !pp.lost && g.active === p.seat) { g.emptyPools(); g.restOfTurn(pp, 'main 2'); }
      }, 2); // (end-of-turn play-outs with the same shuffles are steady: a small margin is enough)
      return uniq[bi];
    }
    declareBlocks(q, attackers, p) {
      const blocks = new Map();
      // a copy playing out a block plan the defender's decision fork chose
      if (this._forcedBlocks && this._forcedBlocks.q === q.seat) {
        for (const [aid, bids] of this._forcedBlocks.ids) { const a = attackers.find((x) => x.id === aid); const bs = bids.map((id) => this.cards[id]).filter((b) => b && b.zone === 'bf' && !b.tapped && a && this.canBlock(b, a)); if (a && bs.length) blocks.set(aid, bs); }
        return blocks;
      }
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
        const aFS = ak.has('first strike') || ak.has('double strike');
        const strikesBack = (b) => !aFS || this.hasKw(b, 'first strike') || this.hasKw(b, 'double strike') || this.pt(b)[1] > ap || this.hasKw(b, 'indestructible');
        choice = able.find((b) => { const [bp, bt] = this.pt(b); return (bp >= at || this.hasKw(b, 'deathtouch')) && strikesBack(b) && !ak.has('indestructible') && (bt > ap || this.hasKw(b, 'indestructible')) && !ak.has('deathtouch'); });
        // safe block: survive
        if (!choice) choice = able.find((b) => { const [, bt] = this.pt(b); return (bt > ap || this.hasKw(b, 'indestructible')) && !ak.has('deathtouch') && !ak.has('trample'); });
        // trade
        if (!choice) choice = able.filter((b) => { const [bp] = this.pt(b); return (bp >= at || this.hasKw(b, 'deathtouch')) && strikesBack(b) && !ak.has('indestructible') && this.creatureValue(b) <= this.creatureValue(a) + 1; }).sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0];
        // a creature that sacrifices itself for value (Sakura-Tribe Elder) blocks for free
        if (!choice && !ak.has('trample')) choice = able.find((b) => !b.isCommander && this.selfSacAb(b) && this.pt(b)[1] <= ap);
        // chump when in danger
        const cmdLethal = a.isCommander && (q.cmdDmg[a.id] || 0) + ap >= 21;
        if (!choice && (remaining >= q.life || cmdLethal || (remaining >= q.life * 0.6 && ap >= 6))) {
          choice = able.filter((b) => !b.isCommander).sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0];
        }
        if (choice && ak.has('menace')) {
          // menace: a second blocker is required; add the cheapest other one, or don't block
          const second = able.filter((b) => b !== choice && !b.isCommander).sort((x, y) => this.creatureValue(x) - this.creatureValue(y))[0];
          if (!second) choice = null;
          else { blocks.set(a.id, [choice, second]); avail.splice(avail.indexOf(choice), 1); avail.splice(avail.indexOf(second), 1); if (!ak.has('trample')) remaining -= ap; continue; }
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

  Game.TIME_LIMIT = 120000; // ms of wall clock per game (normal games take a few seconds even with the look-ahead)
  Game.STEP_LIMIT = 200000; // mana payments per game; real games use under 3,000
  Game.NN_CARD = 30;      // card features (see nnCard)
  Game.NN_STATE = 40;     // board features (see nnState and _nnRich)
  Game.NN_WEIGHT = 150;   // how much a 0.1 swing in win chance is worth when scoring a play

  function simulate(decks, db, seed, opts) {
    return new Game(decks, db, seed, opts).run();
  }

  const API = { COMBOS, Game, simulate, parseEffects, analyzeCard, parseCost, rng, deckColorIdentity };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.PodSim = API;
})(typeof window !== 'undefined' ? window : globalThis);
