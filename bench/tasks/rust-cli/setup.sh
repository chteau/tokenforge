#!/usr/bin/env bash
set -euo pipefail
SRC=$(cd "$(dirname "$0")/../../fixtures/rust-ledger/base" && pwd)
mkdir -p "$1"
cp -a "$SRC/." "$1/"
rm -rf "$1/target"
cd "$1"
git init -q -b main && git add -A && git commit -q -m "tally 0.4.2"
