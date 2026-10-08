#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the ssg static site generator.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# ssg — a small static site generator\n' > README.md
printf 'node_modules\ndist\nout\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
