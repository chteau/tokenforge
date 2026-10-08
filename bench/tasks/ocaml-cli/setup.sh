#!/usr/bin/env bash
# Build the (almost empty) task repository at DEST for the asm stack machine toolchain.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
mkdir -p "$DEST"
cd "$DEST"
printf '# asm — assembler, disassembler and virtual machine for a small stack machine\n' > README.md
printf '_build/\n*.install\n' > .gitignore
git init -q -b main
git add -A
git commit -q -m "Initial commit"
