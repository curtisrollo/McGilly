# Pod Night

A web page that plays out simulated four-player Commander (EDH) games so you can watch them.

- `decks/` — one decklist per file (Moxfield/Archidekt export format: `1x Card Name (set) 123 [Type]`, with the commander tagged `[Commander{top}]`).
- `fetch-cards.mjs` — downloads rules data for every card in `decks/` from the open-source [Forge](https://github.com/Card-Forge/forge) card scripts into `data/cards.json`.
- `build.mjs` — bundles the engine, UI, card data and decks into a single page, `dist/pod-night.html`.
- `test-sim.mjs` — runs games headlessly and prints win counts (`node test-sim.mjs 300`).

To add or change a deck: drop the list into `decks/`, then run `node fetch-cards.mjs && node build.mjs`.

The simulator reads each card's rules text and models the common effects (mana, combat and keywords,
commander tax and damage, removal, wipes, counterspells, draw, ramp, tutors, reanimation, tokens,
anthems, life drain, planeswalkers). Each player is a simple heuristic AI, so treat results as a
rough feel for the matchups rather than a precise win rate.
