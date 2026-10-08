#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the surveystat survey summariser.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# surveystat — survey response summaries from the command line\n' > README.md
printf '.Rhistory\n.RData\n/out/\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
