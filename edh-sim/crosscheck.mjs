// Cross-checks each card's rules text against what the engine understood: if the text
// says "draw", "destroy", "create ... token" etc., some matching effect must exist.
// Usage: node crosscheck.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { analyzeCard } = require('./src/engine.js');
const db = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));

const allFx = (a) => [a.spell, a.etb, a.dies, a.attack, a.combatDmg, ...a.upkeep.map((u) => u.fx), ...a.endstep.map((u) => u.fx),
  ...a.castTrig.map((t) => t.fx), ...a.deathWatch.map((t) => t.fx), ...a.activated.map((t) => t.fx), ...a.loyaltyAbs.map((t) => t.fx),
  ...(a.landfall || []), ...(a.constellation || []), ...(a.myCreatureEtb || []), ...(a.oppCreatureEtb || []), a.anyCreatureEtb || [],
  ...a.triggers.map((t) => t.fx || []), a.enchDies || [], a.equipDies || [], a.channel ? a.channel.fx : [], a.prepared ? a.prepared.fx : [],
  a.sacOutlet ? a.sacOutlet.fx || [] : [], a.harness ? [...(a.harness.upkeep || []), ...(a.harness.end || [])] : []].flat();
const flags = (a) => Object.keys(a).filter((k) => a[k] && a[k] !== false).join(' ') + ' ' + a.statics.map((s) => s.k).join(' ') + ' ' + a.triggers.map((t) => t.k).join(' ');

// text pattern -> effect kinds / flags that satisfy it
const RULES = [
  [/\bdraws? (?:a|an|one|two|three|four|five|seven|x|\d+|that many) cards?|draw cards equal/i, /^(draw|wheel|loot|connive|dig|impulse|wildspeaker)$/, /vilis|drawGain|rhystic|sentinel|archivist|gix|landToGy|artifactEtb|welcoming|banner|bmc|necro|harness|coffin/],
  [/\bcreate[sd]? (?:a|an|one|two|three|x|\d+|that many|twice x)\b[^.]*token/i, /^(tokens|treasure|food|clue|blood|feldon|osgir)$/, /bmc|tithe|conqueror|kalitas|emblem|chatterfang|myrkul|saga|coffin/],
  [/\bdestroy (?:target|another target|up to)/i, /^(removal|removalN|landDestroy|exchange)$/, /runes|kalitas/],
  [/\bdestroy all|\bexile all|\bexile each|all creatures get -|each creature gets -|each non-/i, /^(wipe|massBounce|graveHate)$/, /farewell/],
  [/\bexile target (?:creature|nonland|permanent|artifact|enchantment|planeswalker)/i, /^(removal)$/, /(?!)/],
  [/\bcounter target (?:spell|noncreature|creature|enchantment)/i, /^(counter)$/, /(?!)/],
  [/search your library/i, /^(search|tutor|tutorBF|ramp|defenseOfHeart)$/, /fetch|saga/],
  [/\bput (?:a|one|two|three|x|\d+) \+1\/\+1 counters?/i, /^(counters|ebonLegion|pump)$/, /converge|etbCounters|dethrone/],
  [/\bproliferate\b/i, /^(proliferate)$/, /(?!)/],
  [/\byou gain (?:\d+|x) life|gain life equal|you gain that much life|gains? 1 life/i, /^(gain|drain|drainOne|sorinSac|food)$/, /exquisite|archivist|drawGain|oppCreatureEtb|anyCreatureEtb|gainToughness|tokenDies|manaGain/],
  [/\beach opponent loses|target (?:player|opponent) loses (?:\d+|x) life|loses? life equal/i, /^(drain|drainOne|hailfire|archfiend|junji|loseSelf)$/, /oppDrawLose|bond|bloodletter/],
  [/deals? (?:\d+|x) damage|deals damage equal/i, /^(damage|wipe|balefire)$/, /terror|dragonTempest|druid|alibou|manaDamage/],
  [/\breturn (?:target|up to|all|it|that card|enchanted)[^.]*(?:graveyard|battlefield)[^.]*to (?:the battlefield|your hand)|onto the battlefield under your control/i, /^(reanimate|regrow|massRegrow|regrowLands|reanimateType|massReanimate|junji|lordOfVoid|reanimateArtifact|weld|cheatCreature|genesis|putFromHand|exchange|steal|stealArtifacts)$/, /gyLandfall|diesTransform|returnsAsEnchantment|ghostform|copy|tutorBF|search|harness|reanimAura/],
  [/\bmills? |into your graveyard/i, /^(mill|millPower|dig|search|hermit)$/, /sidisi|dredge/],
  [/\bdiscards? (?:a|two|their)/i, /^(discard|discardAll|loot|wheel|junji|gixExile)$/, /addCost|connive|artifactEtb|cycling|channel|bmc/],
  [/\bsacrifices? (?:a|an|another|two|three|ten)\b/i, /^(edict|edictAll|edictThat|sacCreatureOrSelf|gitrogUpkeep|squirrelKill|defenseOfHeart)$/, /sacOutlet|sacCreature|sacArtifact|sacArtifactN|sacNonland|fodderMana|addCost|harness|mondrak|wardSac|cumulativeLife|sacOther|fetch|eldrazi|koma|sorinSac|kalitas|chatterfang|bloodletter|piles|liliana9|coffin/],
  [/\buntap (?:all|target|up to|it\b|cardname)/i, /^(untapLands|untapLandsN|extraCombat)$/, /noUntap|vault|unwinding|beledros|druid|untapWithCounter|infMana|cinderhaze/],
  [/additional combat phase/i, /^(extraCombat)$/, /(?!)/],
  [/copy of/i, /^(osgir|feldon)$/, /copy|myrkul/],
  [/extra turn/i, /^(extraTurn)$/, /nexus/],
  [/gain control/i, /^(steal|stealArtifacts|exchange)$/, /(?!)/],
  [/phases? out/i, /^(phaseOut|protect)$/, /(?!)/],
  [/can't be blocked|can't block/i, /^(pump|noBlock)$/, /cantBlock|unblockable|landwalk/],
];
// Cards whose matching text is handled by machinery outside the effect lists, with the reason.
const A = (re, why) => ({ re, why });
const ACK = {
  'Ancient Tomb': A(/damage/, 'mana ability deals 2 to you when tapped (mana option dmg)'),
  'Battlefield Forge': A(/damage/, 'painland damage on coloured mana (mana option dmg)'),
  'City of Brass': A(/damage/, 'damage whenever tapped (mana option dmg)'),
  'Talisman of Conviction': A(/damage/, 'coloured mana deals 1 to you (mana option dmg)'),
  'Talisman of Hierarchy': A(/damage/, 'coloured mana deals 1 to you (mana option dmg)'),
  'Talisman of Indulgence': A(/damage/, 'coloured mana deals 1 to you (mana option dmg)'),
  'Mana Vault': A(/damage/, 'vault flag: 1 damage in draw step while tapped'),
  'Anointed Procession': A(/token/, 'tokenDouble static'),
  'Doubling Season': A(/token/, 'tokenDouble + counterDouble statics'),
  'Old Gnawbone': A(/token/, 'gnawbone trigger: treasures equal to combat damage'),
  'Sidisi, Brood Tyrant': A(/token/, 'sidisi flag: Zombie when a creature is milled'),
  'Swan Song': A(/token/, 'Bird token for the countered spell\'s controller, in tryCounter'),
  'Hour of Promise': A(/token/, 'Desert condition never met: none of the decks run Deserts'),
  'Castle Doom': A(/sacrific/, 'activated cost sacArtifactN'),
  'Goblin Engineer': A(/sacrific/, 'activated cost sacArtifact'),
  'Kuldotha Forgemaster': A(/sacrific/, 'activated cost sacArtifact (3)'),
  'Osgir, the Reconstructor': A(/sacrific/, 'osgirPump sacrifices artifacts in combat'),
  'Oswald Fiddlebender': A(/sacrific/, 'activated cost sacArtifact'),
  'Daretti, Scrap Savant': A(/sacrific|return/, 'darettiWeld: sacrifice an artifact, return one'),
  'Sorin, Imperious Bloodlord': A(/sacrific|damage/, 'sorinSac: sacrifice a Vampire, 3 damage + 3 life'),
  'Springbloom Druid': A(/sacrific/, 'sacLand effect before the ramp'),
  'Torment of Hailfire': A(/sacrific|discard/, 'hailfire: each repeat, sacrifice, discard or lose 3'),
  'Plaguecrafter': A(/discard/, 'edictAll discardIfNone'),
  'Gamble': A(/discard/, 'discardSelf random'),
  'Yawgmoth, Thran Physician': A(/discard/, 'activated cost discard 1'),
  'Necropotence': A(/discard/, 'discarded cards would be exiled; the AI never discards to it'),
  'Finale of Devastation': A(/search/, 'finale: searches library and graveyard'),
  'Genesis Wave': A(/graveyard/, 'genesis puts the rest into the graveyard'),
  'The Gitrog Monster': A(/graveyard/, 'landToGy trigger'),
  'Jace, the Mind Sculptor': A(/exile/, 'exileLibrary ultimate'),
  'Losheel, Clockwork Scholar': A(/draw/, 'losheelDraw: artifact creature enters, once per turn'),
  'Smothering Tithe': A(/draw/, 'tithe trigger on opponents\' draws'),
  'Staff of Domination': A(/untap/, 'untap loop only matters in the Monolith + Rings combo (checkCombos)'),
  'Thousand-Year Elixir': A(/untap/, 'untapCreature activation'),
  'Reanimate': A(/loses/, 'reanimate loseMv'),
};
let problems = 0;
for (const [name, data] of Object.entries(db).sort()) {
  const front = analyzeCard(data, ['W', 'U', 'B', 'R', 'G'], name);
  for (const a of [front, ...front.faces.slice(1)]) {
    const text = (a.face && a.face.oracle || '').replace(/\([^)]*\)/g, '').replace(/"[^"]*"/g, (q) => (/when this|dies/i.test(q) ? q : ''));
    const fx = allFx(a);
    const kinds = new Set(fx.map((f) => f.k));
    // effect details and mana-ability side effects count too
    const fl = flags(a) + ' ' + [...a.kw].join(' ') + ' ' + fx.flatMap((f) => Object.keys(f).filter((k) => f[k] === true || (Array.isArray(f[k]) && f[k].length))).join(' ')
      + (a.mana ? ' mana ' + a.mana.opts.map((o) => (o.dmg ? 'manaDamage ' : '') + (o.gain ? 'manaGain ' : '')).join('') : '') + (fx.some((f) => f.k === 'tokens' && f.dies && f.dies.length) ? ' tokenDies' : '');
    const actFl = a.activated.flatMap((x) => Object.keys(x).filter((k) => x[k] && k !== 'fx' && k !== 'cost' && k !== 'text')).join(' ');
    const ack = ACK[a.name];
    for (const [re, kindRe, flagRe] of RULES) {
      if (!re.test(text)) continue;
      const ok = [...kinds].some((k) => kindRe.test(k)) || flagRe.test(fl + ' ' + actFl) || (ack && ack.re.test(re.source));
      if (!ok) { problems++; console.log(`${a.name}: text matches ${re} but no matching effect. Has: [${[...kinds].join(',')}] ${fl.slice(0, 120)}`); }
    }
  }
}
console.log(problems ? `${problems} possible mismatches` : 'No mismatches');
