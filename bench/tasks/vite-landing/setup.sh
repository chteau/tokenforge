#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the Orbitly landing page.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# Orbitly landing page\n' > README.md
printf 'node_modules\ndist\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
