#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the Ward validation library.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# Ward\n' > README.md
printf 'node_modules\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
