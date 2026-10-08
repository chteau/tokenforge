#!/usr/bin/env bash
# Usage: setup.sh DEST — builds the (almost empty) task repository at DEST.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
cat > README.md <<'MD'
# Bramble Library loans API
MD
cat > .gitignore <<'GI'
bin/
obj/
*.user
.vs/
TestResults/
GI
git init -q -b main
git add -A
git commit -q -m "Initial commit"
