#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the cells spreadsheet evaluator.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# cells — a spreadsheet formula evaluator for the command line\n' > README.md
printf 'build/\n*.hi\n*.o\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
