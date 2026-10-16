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
- `node validate.mjs | tail -1`: must say 0 failed (647 checks as of this writing).
- `NOLOOK=1 node invariants.mjs 150`: plays games and flags illegal states; must say "No problems found".
- New bug: write the scenario first, confirm it fails on the old engine, then fix.

## Heavy jobs
- `sh retrain.sh [gens games ab]`: train, build, commit and push in one go (default 4 x 800, A/B 2000; ~1 hour).
- Win rates: play N four-player games with random pods and count winners per deck (25% is an even share).

## Where things stand
- Latest network: 6 gens x 1500 games; A/B 26.2% with vs 24.6% without (3000 games), the same as the 4 x 800 run before it,
  so more games alone no longer help. Bigger gains need the network to steer more decisions (combat, targeting).
- Win rates (400 games): Edgar 35, Beledros 33, Kaalia 28, Atraxa 28, Myrkul 22, Muldrotha 17, Osgir 11.
  The engine decks still die to fast aggro before their engines come online.
- Recent AI work: look-ahead on engine turns, attack/removal targeting by threat, wipes held for real trades or danger,
  graveyard-hate awareness (Valgavoth/Dauthi), Beledros untap, Coffers+Urborg, draw-budget guards against decking.

## Open ideas
- Parallelise training across CPU cores (worker threads) to make bigger runs cheap.
- Remaining small audit items: Staff of Domination untap creature, Goblin Welder on opponents' artifacts, Lattice colour
  changes, Yawgmoth -1/-1 setup for proliferate, Academy Rector trigger ordering with Myrkul.
