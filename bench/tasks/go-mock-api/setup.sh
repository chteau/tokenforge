#!/usr/bin/env bash
# Usage: setup.sh DEST — builds the (almost empty) task repository at DEST.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST/data"
cd "$DEST"
cat > README.md <<'MD'
# Shelfwise mock API
MD
cat > .gitignore <<'GI'
/api
/server
*.test
*.out
GI
cat > go.mod <<'GM'
module example.com/mockapi

go 1.26
GM
cat > data/seed.json <<'JS'
{
  "books": [
    {"id": 1, "isbn": "9780000000011", "title": "The Silent Orchard", "author": "Mara Quill", "genre": "fiction", "year": 2011, "price_cents": 1499},
    {"id": 2, "isbn": "9780000000028", "title": "Rivers of Bronze", "author": "Tomas Ewe", "genre": "history", "year": 1998, "price_cents": 2450},
    {"id": 3, "isbn": "9780000000035", "title": "Small Lanterns", "author": "Ines Varga", "genre": "poetry", "year": 2019, "price_cents": 999},
    {"id": 4, "isbn": "9780000000042", "title": "The Clockwork Fox", "author": "Mara Quill", "genre": "fantasy", "year": 2015, "price_cents": 1799},
    {"id": 5, "isbn": "9780000000059", "title": "Orbits and Tides", "author": "Lena Okafor", "genre": "science", "year": 2007, "price_cents": 3100}
  ]
}
JS
git init -q -b main
git add -A
git commit -q -m "Initial skeleton"
