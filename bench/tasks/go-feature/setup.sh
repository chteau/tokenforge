#!/usr/bin/env bash
# Usage: setup.sh DEST — builds the task repository at DEST.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
SRC="$(cd "$(dirname "$0")/../../fixtures/go-backend/base" && pwd)"
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "Meridian billing API"
