#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"; cd "$1"
printf '# ledgerstat\n' > README.md
printf '__pycache__/\n.venv/\n' > .gitignore
git init -q -b main && git add -A && git commit -q -m "Initial commit"
