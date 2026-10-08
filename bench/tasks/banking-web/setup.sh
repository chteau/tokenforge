#!/usr/bin/env bash
# Build the task repository at DEST from the Quillmoor banking fixture.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/../../fixtures/ts-banking/base"
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "Quillmoor online banking"
