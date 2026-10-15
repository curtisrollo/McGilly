# Pod Night

A web page that plays out simulated four-player Commander (EDH) games so you can watch them.

- `decks/` — one decklist per file (Moxfield/Archidekt export format: `1x Card Name (set) 123 [Type]`, with the commander tagged `[Commander{top}]`).
- `fetch-cards.mjs` — downloads rules data for every card in `decks/` from the open-source [Forge](https://github.com/Card-Forge/forge) card scripts into `data/cards.json`.
- `build.mjs` — bundles the engine, UI, card data and decks into a single page, `dist/pod-night.html`.
- `test-sim.mjs` — runs games headlessly and prints win counts (`node test-sim.mjs 300`).
- `validate.mjs` — effect validation: puts every card into a scripted game, makes each effect and trigger happen and
  checks the game changed the way the card says (`node validate.mjs --json data/validation.json`; results show on the page).
- `crosscheck.mjs` — checks each card's rules text against the effects the engine extracted (draw, destroy, create, search…).
- `audit.mjs` — lists any card rules text the engine does not handle (currently none); `dump.mjs` prints what the engine understood for each card.
- `train.mjs` — trains the neural network (`src/nn.js`, a small MLP in plain JavaScript) by self-play and writes
  `data/nn.json`, which the build embeds. Each generation plays games, records every spell cast with the board state and
  who won, and learns to predict a player's chance to win with and without the card just cast; the difference steers what
  the AI casts, tutors for and discards. A second network judges opening hands. It ends with an A/B test (one seat uses the
  network, three don't). `node train.mjs --gens 4 --games 600 --ab 600 [--fresh]`.

To add or change a deck: drop the list into `decks/`, then run `node fetch-cards.mjs && node build.mjs`.

The simulator reads each card's rules text and models the common effects (mana, combat and keywords,
commander tax and damage, removal, wipes, counterspells, draw, ramp, tutors, reanimation, tokens,
anthems, life drain, planeswalkers). Each player is a heuristic AI steered by the trained network, so treat results as a
rough feel for the matchups rather than a precise win rate.

Card art is generic: `src/art-map.json` maps creature types and card types to icons from
[game-icons.net](https://game-icons.net) (CC BY 3.0, by Lorc, Delapouite and contributors), vendored in
`vendor/game-icons-subset.json`.
