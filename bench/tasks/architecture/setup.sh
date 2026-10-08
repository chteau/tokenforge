#!/usr/bin/env bash
# Builds the canonical repository for the architecture task at DEST.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$HERE/../../fixtures/ts-logistics/base
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "Kestrel Freight 4.12.0"
