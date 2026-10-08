#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the cronx cron expression tool.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# cronx — a cron expression tool\n' > README.md
printf '.build/\n.swiftpm/\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
