#!/usr/bin/env bash
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONSUMERS=(codex claude-code)
FAILED=0

for consumer in "${CONSUMERS[@]}"; do
  config="$ROOT/test/fixtures/$consumer/binary.config.json"
  printf '== %s ==\n' "$consumer"
  if ! CONFIG="$config" /bin/bash "$HERE/cases.sh"; then FAILED=1; fi
  if [[ "${1:-}" == "--mutations" ]]; then
    if ! CONFIG="$config" /bin/bash "$HERE/variants.sh"; then FAILED=1; fi
  fi
done

[[ "$FAILED" == 0 ]]
