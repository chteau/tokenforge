#!/usr/bin/env bash
# Usage: setup.sh DEST — builds the task repository at DEST: main holds the
# base service, feature/invoice-export holds the pull request under review.
set -euo pipefail
DEST=${1:?usage: setup.sh DEST}
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../../fixtures/go-backend/base"
PR="$HERE/../../fixtures/go-backend/pr-review/invoice-export.patch"
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "Meridian billing API"
git checkout -q -b feature/invoice-export
git apply --whitespace=nowarn "$PR"
git add -A
git commit -q -m "Add asynchronous invoice CSV export

Customers and billing admins can request a CSV export of invoices for a
date range. Exports are generated in the background and downloaded via a
signed link. Gated behind the invoice_exports feature flag."
