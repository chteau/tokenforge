#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the kvdb key-value store.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# kvdb — a tiny log-structured key-value store\n' > README.md
printf 'build/\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
