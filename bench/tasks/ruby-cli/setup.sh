#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the logtally access-log analyzer.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# logtally — access-log statistics from the command line\n' > README.md
printf '/tmp/\n*.gem\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
