#!/usr/bin/env bash
# Speak one line through several candidate voices; report duration + transcript.
#
# Pick a voice by measurement, not vibes. Clean voices differ ~12% in pace on identical
# text, and pace is what decides whether a script fits its target runtime. Duration here
# is also the input to your words-per-scene budget -- narration drives scene length, so
# measure before writing the full script.
#
# A clean transcript means the clone handles your phrasing; a mangled one rules it out
# before you spend a full best-of-N run on it.
#
# Usage:
#   ./voice_probe.sh "Your test line here" "Jessica" "Lily" "Bella"
#   KEY=... ./voice_probe.sh "line" Jessica Lily
set -uo pipefail

LINE="${1:?usage: voice_probe.sh \"line\" voice [voice...]}"; shift
[[ $# -gt 0 ]] || { echo "give at least one voice name" >&2; exit 1; }

KEY="${KEY:-${MCP_API_KEY:-}}"
if [[ -z "$KEY" ]]; then KEY=$("$(dirname "$0")/get_key.sh") || exit 1; fi

BASE=https://mcp.baisoln.com
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

printf "%-14s %-6s %-8s %s\n" VOICE HTTP DUR TRANSCRIPT
for V in "$@"; do
  F="$TMP/${V// /_}.wav"
  CODE=$(curl -s -m 120 -o "$F" -w "%{http_code}" -X POST "$BASE/gpu-ai/v1/audio/speech" \
    -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"voice":sys.argv[1],"input":sys.argv[2],"response_format":"wav"}))' "$V" "$LINE")")
  if [[ "$CODE" != "200" ]]; then printf "%-14s %-6s %-8s %s\n" "$V" "$CODE" "-" "FAILED"; continue; fi
  D=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$F")
  T=$(curl -s -m 90 -X POST "$BASE/gpu-ai/v1/audio/transcriptions" -H "X-API-Key: $KEY" \
        -F "model=faster-whisper" -F "file=@$F" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("text","")[:70])' 2>/dev/null)
  printf "%-14s %-6s %-8.2f %s\n" "$V" "$CODE" "$D" "$T"
done

echo
echo "Shortest duration = punchiest delivery. Verify the transcript is verbatim before choosing."
