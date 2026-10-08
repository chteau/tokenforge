#!/usr/bin/env bash
# Usage: setup.sh DEST — builds the manuscript repository at DEST.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DEST"
cp -a "$HERE/fixtures/manuscript/." "$DEST/"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "Manuscript draft for internal review"
