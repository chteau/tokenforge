#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the cfgmerge config tool.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# cfgmerge — lint, merge and explain layered INI/.env configuration\n' > README.md
printf '*.swp\n/blib/\n/_build/\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
