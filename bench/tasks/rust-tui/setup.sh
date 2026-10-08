#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
cd "$1"
printf '# kanban\n' > README.md
printf 'target/\n' > .gitignore
git init -q -b main && git add -A && git commit -q -m "initial commit"
