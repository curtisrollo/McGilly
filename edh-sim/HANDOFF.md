# Pod Night: handoff notes

A Commander (EDH) simulator for seven decks (Edgar, Kaalia, Beledros, Atraxa, Osgir, Myrkul, Muldrotha): a rules engine,
a heuristic AI steered by a small neural network, and a single-page web app published as a claude.ai artifact
(https://claude.ai/artifact/JhNAu2QrFhYqPindEQxJ97). Work happens on branch `claude/admiring-mendel-hvfujz`.

## Files
- `src/engine.js`: the whole engine (class `Game`). Card behaviour = regex parser + a `SCRIPTS` overrides table.
  Effects resolve in `_resolveEffect` (switch on `fx.k`). AI: `mainPhase`, `scoreCast`, `abilityScore`, `chooseDefender`,
  `combat`, `bestOppTarget`, `wipeEval`, `lookPick` (look-ahead), `threatOf` (table politics).
- `src/nn.js`, `train.mjs`: the network (win-chance Q/V + mulligan net) and self-play training.
- `src/ui.js`, `src/template.html`, `src/style.css`: the page. `build.mjs` inlines everything into `dist/pod-night.html`.
- `scenarios.mjs` + `scenarios/*.mjs`: every past bug as a test, `{ card, title, wrong, run(t) }`.
- `explain.mjs "Card"`: Oracle text next to what the engine extracted.

## Checks (run before every commit)
- `node validate.mjs | tail -1`: must say 0 failed (670 checks as of this writing).
- `NOLOOK=1 node invariants.mjs 150`: plays games and flags illegal states; must say "No problems found".
- New bug: write the scenario first, confirm it fails on the old engine, then fix.

## Heavy jobs
- `sh retrain.sh [gens games ab]`: train, build, commit and push in one go (default 4 x 800, A/B 2000). Games run on
  worker processes, one per core (`--cores`); a run gives exactly the same network on 1 core or many.
- Win rates: play N four-player games with random pods and count winners per deck (25% is an even share).

## Where things stand
- Latest network: 40 board features (_nnRich), 6 x 1500 games on 9 cores. Fair test on the same 2,250 games:
  27.6% with vs 24.1% without (+3.5); the previous network on the previous engine: 27.1% vs 24.3% (+2.8).
  The network is the main board scorer in lookValue (it predicts winners better than the hand weights at every
  stage: 46% vs 41%). Compare networks with fixed-seed games, not each run's own A/B (that one said +5.6).
- Win rates (400 games): Edgar 35, Beledros 33, Kaalia 28, Atraxa 28, Myrkul 22, Muldrotha 17, Osgir 11.
  The engine decks still die to fast aggro before their engines come online.
- Recent AI work: look-ahead on engine turns, attack/removal targeting by threat, wipes held for real trades or danger,
  graveyard-hate awareness (Valgavoth/Dauthi), Beledros untap, Coffers+Urborg, draw-budget guards against decking.

## How the AI should improve (agreed direction)
- General engine, general AI: no card-specific AI rules. A card's behaviour comes from its parsed effects; AI rules work on
  how a card makes value (static while on the battlefield, activated ability, triggers, one-shot, body).
- Judge by outcome: the look-ahead plays a choice out on a copy of the game (`cloneForLook`) and scores the board with
  `lookValue`. In the main phase it also tries abilities the rules score at 0 or below (`abilityOptions(..., loose)`) and
  "do nothing" (`lookPick`); in combat it tries the attack without each attacker that could die, and no attack.
  With it, Hermit Druid stays home and Yawgmoth + Dictate of Erebos runs with no rule for either (checked by switching
  those rules off). Rules are a shortlist; the look-ahead decides.
- Mistake-finder: `node mistakes.mjs 400 --cores 8` (about 9 minutes) plays games while a judge re-checks a sample of
  decisions (every option, played to the player's next turn, 3 playouts with shared draws, flags re-checked with 8 more)
  and writes grouped patterns to data/mistakes.json. First run (400 games): combat is the weakest area (no attack when
  all-in won, holding creatures back, attacking when staying home was better), then casting before combat when after
  was better.
- Next: fix the top patterns generically (attack look-ahead that can add attackers / go all-in; main 1 vs main 2), then
  the network as the board scorer, with training spread across cores.
- A/B harness pattern: `looseSeats: [seat]` gives one seat the new candidates; 25% is an even share.

## Speed
- pt, kws and creatureValue are cached per card (cacheKey: event tick, battlefield sizes, life totals, the card's
  own counters/pump). Checked against fresh values: 5.6M lookups, 0 mismatches. 100 games: 1:43.

## Open ideas
- Remaining small audit items: Staff of Domination untap creature, Goblin Welder on opponents' artifacts, Lattice colour
  changes, Yawgmoth -1/-1 setup for proliferate, Academy Rector trigger ordering with Myrkul.
