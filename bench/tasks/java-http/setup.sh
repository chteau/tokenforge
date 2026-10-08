#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the shorty URL-shortener service.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# shorty — a small URL shortener service\n' > README.md
printf 'build/\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
