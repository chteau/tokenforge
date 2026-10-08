#!/usr/bin/env bash
# Build the task repository at DEST: the Quillmoor banking fixture plus the
# variant overlay for this task.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
HERE=$(cd "$(dirname "$0")" && pwd)
FIXTURE="$HERE/../../fixtures/ts-banking"
mkdir -p "$DEST"
cp -a "$FIXTURE/base/." "$DEST/"
cp -a "$FIXTURE/variants/cross-module-debug/." "$DEST/"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "Quillmoor online banking"
