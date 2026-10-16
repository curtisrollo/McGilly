#!/bin/sh
# Retrain the network and publish the result to the branch, in one go. Meant for a fast machine (the Mac mini):
#   sh retrain.sh            default: 4 generations x 800 games, 2000-game A/B test (about an hour)
#   sh retrain.sh 6 1000 3000   (generations, games per generation, A/B games)
# When it finishes, data/nn.json and dist/pod-night.html are committed and pushed, and the A/B line is printed last.
set -e
cd "$(dirname "$0")"
GENS=${1:-4}; GAMES=${2:-800}; AB=${3:-2000}
git pull -q --ff-only
node train.mjs --fresh --gens "$GENS" --games "$GAMES" --ab "$AB" | tee train.log
node validate.mjs --json data/validation.json > /dev/null
node build.mjs
git add data/nn.json data/validation.json dist/pod-night.html
git commit -qm "Retrain network: $GENS x $GAMES games, A/B $AB games" || { echo "nothing changed"; exit 0; }
git push -q
echo; echo "Pushed. A/B result:"; grep "ALL " train.log
