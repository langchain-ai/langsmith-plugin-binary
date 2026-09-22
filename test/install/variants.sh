#!/usr/bin/env bash
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${CONFIG:-$PWD/binary.config.json}"
[[ -f "$CONFIG" ]] || {
  printf 'No binary config at %s. Set CONFIG to its path.\n' "$CONFIG" >&2
  exit 2
}

INSTALLER="${INSTALLER:-$(dirname "$CONFIG")/$(node "$HERE/read-config.mjs" "$CONFIG" installer.output)}"
VARIANTS="$HERE/variants.txt"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/install-variants.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

node "$HERE/generated-variants.mjs" "$INSTALLER" "$CONFIG" >"$WORK/generated.txt" || exit 1
cat "$VARIANTS" "$WORK/generated.txt" >"$WORK/variants.txt"

CAUGHT=0
MISSED=0
UNCHANGED=0

while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  name="${line%%|||*}"
  rest="${line#*|||}"
  old="${rest%%|||*}"
  new="${rest#*|||}"
  variant="$WORK/install.sh"
  OLD="$old" NEW="$new" perl -0777 -pe '
    my $o = $ENV{OLD}; $o =~ s/\\n/\n/g;
    my $n = $ENV{NEW}; $n =~ s/\\n/\n/g;
    s/\Q$o\E/$n/;
  ' "$INSTALLER" >"$variant"
  if cmp -s "$INSTALLER" "$variant"; then
    UNCHANGED=$((UNCHANGED + 1))
    printf 'UNCHANGED %s\n' "$name"
    continue
  fi
  if CONFIG="$CONFIG" INSTALLER="$variant" FAIL_FAST=1 /bin/bash "$HERE/cases.sh" >/dev/null 2>&1; then
    MISSED=$((MISSED + 1))
    printf 'MISSED %s\n' "$name"
  else
    CAUGHT=$((CAUGHT + 1))
  fi
done <"$WORK/variants.txt"

printf '%s caught, %s missed, %s unchanged\n' "$CAUGHT" "$MISSED" "$UNCHANGED"
[[ "$MISSED" == 0 && "$UNCHANGED" == 0 ]]
