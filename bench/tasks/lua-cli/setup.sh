#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the tpl template engine.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# tpl — Mustache-style templates from the command line\n' > README.md
printf '/out/\n*.tmp\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
