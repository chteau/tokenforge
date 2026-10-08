#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BASE="$HERE/../../fixtures/rust-ledger/base"
VARIANT="$HERE/../../fixtures/rust-ledger/variants/refactor"
mkdir -p "$1"
cp -a "$BASE/." "$1/"
rm -rf "$1/target"
rm -f "$1/src/model/validate.rs"
cp -a "$VARIANT/." "$1/"
cd "$1"
git init -q -b main && git add -A && git commit -q -m "tally 0.4.3"
