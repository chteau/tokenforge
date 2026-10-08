#!/usr/bin/env bash
# Validate a task pack: base must score low, reference solution must score >= 90 and be "completed".
set -euo pipefail
ID=${1:?task id}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$ROOT/tasks/$ID
mkdir -p /var/tmp/cc-sandbox; W=$(mktemp -d /var/tmp/cc-sandbox/validate-$ID-XXXX)
export GIT_AUTHOR_NAME="Dev" GIT_AUTHOR_EMAIL="dev@example.com" GIT_COMMITTER_NAME="Dev" GIT_COMMITTER_EMAIL="dev@example.com"
export GIT_AUTHOR_DATE="2026-01-15T10:00:00Z" GIT_COMMITTER_DATE="2026-01-15T10:00:00Z"
bash "$T/setup.sh" "$W/repo"
BASE=$(git -C "$W/repo" rev-parse HEAD)
echo "base commit: $BASE"
for f in CLAUDE.md AGENTS.md .claude; do [ -e "$W/repo/$f" ] && { echo "FAIL: repo contains $f"; exit 1; }; done
if grep -rIil --exclude-dir=.git -e tokenforge -e benchmark -e claude "$W/repo" >/dev/null; then echo "FAIL: repo mentions forbidden words:"; grep -rIil --exclude-dir=.git -e tokenforge -e benchmark -e claude "$W/repo"; exit 1; fi
python3 "$T/evaluate.py" --workspace "$W/repo" --base "$BASE" --out "$W/base.json"
python3 - "$W/base.json" <<'PY'
import json,sys; r=json.load(open(sys.argv[1])); print("BASE:", r["status"], r["quality_score"], r["components"])
PY
git -C "$W/repo" apply --whitespace=nowarn "$T/reference/solution.patch"
python3 "$T/evaluate.py" --workspace "$W/repo" --base "$BASE" --out "$W/ref.json"
python3 - "$W/ref.json" "$W/base.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
print("REFERENCE:", r["status"], r["quality_score"], r["components"])
ok = r["quality_score"] >= 90 and r["status"] == "completed" and b["quality_score"] < 60
print("VALID" if ok else "INVALID"); sys.exit(0 if ok else 1)
PY
rm -rf "$W"
