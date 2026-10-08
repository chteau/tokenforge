#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/../../fixtures/rust-ledger/base" && pwd)
PATCH="$HERE/../../fixtures/history/rust-cli.patch"
mkdir -p "$1"
cp -a "$SRC/." "$1/"
rm -rf "$1/target"
cd "$1"
git init -q -b main && git add -A && git commit -q -m "tally 0.4.2"
git apply --whitespace=nowarn "$PATCH"
rm -rf target
git add -A && git commit -q -m "budget: monthly limits per category"
