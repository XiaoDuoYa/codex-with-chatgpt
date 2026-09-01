#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
workspace_json=$($SCRIPT_DIR/scripts/omp-c2c.sh workspace -w "$SCRIPT_DIR" --json)
printf '%s' "$workspace_json" | python3 -c '
import json
import sys

data = json.load(sys.stdin)
if not isinstance(data.get("workspaceId"), str) or len(data["workspaceId"]) < 8:
    raise SystemExit("workspace identity is missing")
if data.get("root") != "'"$SCRIPT_DIR"'":
    raise SystemExit("workspace root mismatch")
'
$SCRIPT_DIR/scripts/omp-c2c.sh --version >/dev/null
printf '%s\n' 'codex-with-chatgpt OMP smoke: OK'
