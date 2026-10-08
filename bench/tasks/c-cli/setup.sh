#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the csvq CSV query tool.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# csvq — query CSV files from the command line\n' > README.md
printf '*.o\n/csvq\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
