#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the rotate backup tool.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# rotate — snapshot and rotate directory backups\n' > README.md
printf '*.tmp\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
