#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the zj JSON toolkit.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# zj — a small JSON toolkit for the command line\n' > README.md
printf 'zig-out/\n.zig-cache/\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
