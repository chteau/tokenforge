#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the Roblox inventory modules.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# Forager inventory\n\nShared inventory, stacking and crafting modules for the Forager Roblox experience.\n' > README.md
printf '*.rbxl\n*.rbxlx\nsourcemap.json\nPackages/\n' > .gitignore
cat > default.project.json <<'JSON'
{
  "name": "forager",
  "tree": {
    "$className": "DataModel",
    "ReplicatedStorage": {
      "Shared": {
        "$path": "src/shared"
      }
    }
  }
}
JSON
git init -q -b main
git add -A
git commit -q -m "Initial commit"
