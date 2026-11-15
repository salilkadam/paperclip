#!/usr/bin/env bash
# check-sre-harness-render.sh — render deploy/helm/sre-harness and parse every
# shell script it puts into a ConfigMap (`*.sh: |` keys) with `sh -n`.
#
# Why: on 2026-11-15 a comment containing an apostrophe ("a sweep's report")
# landed inside a shell single-quoted `node -e '...'` block in _helpers.tpl.
# The chart rendered fine and every text-level check passed, but /config/run.sh
# no longer parsed, so every monitor run died 3 s after start until rolled
# back. Only parsing the rendered script catches that class of mistake.
#
# Requires helm and a POSIX sh (dash preferred: the pods run /bin/sh). A
# missing tool is a failure, never a skip. Run from the repo root.
set -euo pipefail
CHART="${1:-deploy/helm/sre-harness}"
for b in helm awk; do command -v "$b" >/dev/null || { echo "check-sre-harness-render: $b is required" >&2; exit 1; }; done
SH="$(command -v dash || command -v sh)" || { echo "check-sre-harness-render: no POSIX sh" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
helm template sre-harness "$CHART" -n bionicorg > "$WORK/all.yaml"
# split out each `<name>.sh: |` block of a ConfigMap, de-indented
awk -v dir="$WORK" '
  /^---/ { cm=0; name=""; inblk=0; next }
  /^kind: ConfigMap/ { cm=1 }
  cm && /^  name: / && name=="" { name=$2 }
  inblk {
    if ($0 ~ /^    / || $0 ~ /^$/) { line=$0; sub(/^    /, "", line); print line > out; next }
    inblk=0; close(out)
  }
  cm && /^  [A-Za-z0-9_.-]+\.sh: \|/ {
    key=$1; sub(/:$/, "", key); out=dir "/" name "__" key; n++; inblk=1; printf "" > out; next
  }
  END { print n+0 > (dir "/count") }
' "$WORK/all.yaml"
count="$(cat "$WORK/count")"
[[ "$count" -gt 0 ]] || { echo "check-sre-harness-render: no *.sh found in the rendered chart (extraction broken?)" >&2; exit 1; }
fail=0
for f in "$WORK"/*__*.sh; do
  if out="$("$SH" -n "$f" 2>&1)"; then echo "ok    $(basename "$f")"; else echo "FAIL  $(basename "$f"): $out"; fail=1; fi
done
[[ "$fail" -eq 0 ]] || { echo "check-sre-harness-render: a rendered script does not parse" >&2; exit 1; }
echo "check-sre-harness-render: $count script(s) parse with $SH"
