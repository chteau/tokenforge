#!/usr/bin/env bash
set -euo pipefail
SRC=$(cd "$(dirname "$0")/../../fixtures/smoke/base" && pwd)
mkdir -p "$1"; cp -a "$SRC/." "$1/"; cd "$1"
git init -q -b main && git add -A && git commit -q -m "textutil: initial import"
