#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the tally expense splitter.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# tally — split shared expenses between friends\n' > README.md
printf 'bin/\nobj/\nout/\n*.user\n.vs/\n.ionide/\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
