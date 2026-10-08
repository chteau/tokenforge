#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the boxoffice ticketing API.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# boxoffice — an event-ticketing JSON API\n' > README.md
printf 'var/\n*.sqlite\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
