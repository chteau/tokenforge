#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the mdc Markdown converter.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# mdc — a small Markdown to HTML converter\n' > README.md
printf 'build/\n*.class\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
