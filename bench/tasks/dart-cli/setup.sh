#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the habits streak tracker.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# habits — a command-line habit and streak tracker\n' > README.md
printf '.dart_tool/\nbuild/\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
