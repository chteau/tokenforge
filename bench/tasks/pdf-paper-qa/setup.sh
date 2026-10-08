#!/usr/bin/env bash
# Usage: setup.sh DEST — builds the reading-questions repository at DEST.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DEST"
cp "$HERE/fixtures/paper.pdf" "$HERE/fixtures/QUESTIONS.md" "$DEST/"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "Add TideFormer paper and reading questions"
