#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the jobq job queue.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# jobq — a small persistent job queue with a command-line front-end\n' > README.md
printf '/_build/\n/deps/\n/cover/\n/doc/\n*.ez\n/jobq\nerl_crash.dump\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
