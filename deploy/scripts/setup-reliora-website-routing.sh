#!/usr/bin/env bash
# setup-reliora-website-routing.sh — tell Reliora's agents how a page reaches
# reliora.ai (owner, 2026-11-02; through the CIO, 2026-11-04): the Content Marketer
# writes the copy, the CMO routes the build to the CIO, and the CIO assigns engineering,
# which builds it in Reliora-Inc/reliora-website to match the existing site. Idempotent. Run with --dry-run first.
#
# It replaces or appends one marker-delimited section in each agent's AGENTS.md.
# GitHub access itself comes from setup-agent-job-function-access.sh.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key (`paperclipai token board create --name reliora-website --ttl-days 1`).
#
# Usage: deploy/scripts/setup-reliora-website-routing.sh [--company-id <id>] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
COMPANY="62d63984-df6c-49be-981c-1273f68a451c" # Reliora Inc
BEGIN='<!-- BEGIN bionic-org:reliora-website -->'
END='<!-- END bionic-org:reliora-website -->'
DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[reliora-website] $*"; }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# api METHOD PATH [json-file]  -> body on stdout; non-2xx is fatal with the body.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-reliora-website/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}

cat > "$WORK/engineer.md" <<'EOF'
## Reliora website (reliora.ai)

You build and ship pages on reliora.ai. The repository is https://github.com/Reliora-Inc/reliora-website. Page work comes to you from the CIO, with copy from the Content Marketer.

- Follow `docs/adding-a-page.md` in that repository, and read `docs/brand/BRAND-GUIDE.md` first. A page must match the existing site: use the existing classes and tokens, not new colours, fonts or layouts.
- `npm run build` must pass. Put desktop and phone screenshots of the new page and the page you modelled it on in the pull request.
- Blog posts go through Ghost, not this repository.
- A merge to `main` deploys the site: GitHub Actions on the `k3s-reliora` runners builds the image and rolls it out, and reverts a rollout that fails. You do not deploy by hand. Run `npm run build` (which runs the site's checks) before you open the pull request.
- After the merge, open the page on https://reliora.ai and check it. Report the result on the CIO's task (live, or not live after 15 minutes, with the commit); the CIO reports onward. Do not post to Slack or the board yourself. Do not call a page done until you have seen it live.
EOF
cat > "$WORK/marketer.md" <<'EOF'
## Reliora website (reliora.ai)

- You write the copy for website pages. You do not write to the repository. Follow the brand guide: `docs/brand/BRAND-GUIDE.md` in https://github.com/Reliora-Inc/reliora-website.
- Give the final copy for each page, and the page on the site it should resemble, to the CMO on the CMO's task. The CMO routes the build to the CIO, who assigns engineering. Do not create tasks for engineering yourself.
- Blog posts stay yours: they go through Ghost, not this repository.
- Do not report missing GitHub write access as a blocker. It is expected.
EOF
cat > "$WORK/cmo.md" <<'EOF'
## Reliora website (reliora.ai)

A new page goes like this: the Content Marketer writes the copy; you create a task for the CIO with that copy; the CIO assigns the Sr. Engineer, who builds and deploys it in https://github.com/Reliora-Inc/reliora-website so that it matches the existing site. You review the page when the CIO reports it live on reliora.ai. Do not assign engineering directly.
EOF
cat > "$WORK/cio.md" <<'EOF'
## Reliora website (reliora.ai)

Website pages come to you from the CMO, with copy from the Content Marketer. Create one task per page for the Sr. Engineer (the repository is https://github.com/Reliora-Inc/reliora-website). When the engineer reports the page live, or not live, report it back on the CMO's task.
EOF

# ensure_section AGENT_ID SECTION_FILE: replace or append the marker section.
ensure_section() {
  local aid="$1" file="$2" cur content next
  cur="$(api GET "/agents/$aid/instructions-bundle/file?path=AGENTS.md")"
  content="$(jq -r '.content // ""' <<<"$cur")"
  next="$(jq -rn --arg c "$content" --arg b "$BEGIN" --arg e "$END" --rawfile s "$file" '
    # Character-safe: jq index() counts bytes but slicing counts characters, which misplaced the cut in any
    # AGENTS.md with multi-byte text and corrupted the markers. split() works on characters.
    def org_markers_ok:
      ([match("org:[a-z-]+ -->"; "g")] | length) as $all
      | ([match("<!-- (BEGIN|END) bionic-org:[a-z-]+ -->"; "g")] | length) as $whole
      | ([match("<!-- BEGIN bionic-org:([a-z-]+) -->"; "g") | .captures[0].string]) as $begins
      | ([match("<!-- END bionic-org:([a-z-]+) -->"; "g") | .captures[0].string]) as $ends
      | . as $doc
      | ($all == $whole) and (contains("<!-- BEGIN bionic-<") | not)
        and (($begins | sort) == ($ends | sort)) and (($begins | unique | length) == ($begins | length))
        # each section once, with its END after its BEGIN (an END first would make the replace drop the tail)
        and all($begins[]; ("<!-- BEGIN bionic-org:" + . + " -->") as $B | ("<!-- END bionic-org:" + . + " -->") as $E
              | ($doc | split($B)) as $parts
              | ($parts | length) == 2 and ($parts[0] | contains($E) | not) and ($parts[1] | split($E) | length) == 2);
    ($b + "\n" + $s + $e) as $block
    | if ($c | org_markers_ok | not) then "CORRUPT"
      elif ($c | contains($b)) then
        ($c | split($b)) as $p | ($p[1] | split($e)) as $q
        | $p[0] + $block + ($q[1:] | join($e))
      else ($c | sub("\\s+$"; "")) + "\n\n" + $block + "\n" end')"
  if [[ "$next" == "CORRUPT" ]]; then
    echo "agent $aid: marker lines in AGENTS.md:" >&2
    grep -n 'org:\|bionic-' <<<"$content" | cut -c1-160 | sed 's/^/  /' >&2 || true
    die "agent $aid: AGENTS.md has damaged bionic-org markers; repair them in Paperclip (Agents > Instructions), then re-run"
  fi
  if [[ "$next" == "$content" ]]; then log "  ok: $aid"; return; fi
  log "  update: $aid"
  (( DRY )) && return
  jq -n --arg c "$next" --arg h "$(jq -r '.contentHash // empty' <<<"$cur")" \
    '{path: "AGENTS.md", content: $c} + (if $h == "" then {} else {baseHash: $h} end)' > "$WORK/f.json"
  api PUT "/agents/$aid/instructions-bundle/file" "$WORK/f.json" >/dev/null
  [[ "$(api GET "/agents/$aid/instructions-bundle/file?path=AGENTS.md" | jq -r '.content')" == "$next" ]] \
    || die "agent $aid: AGENTS.md read-back does not match"
}

agents="$(api GET "/companies/$COMPANY/agents" | jq '[.[] | select(.status != "terminated")]')"
one() { # one NAME ROLE-FILTER: the single agent matching, or die
  local ids
  ids="$(jq -r "[.[] | select($2) | .id] | if length == 1 then .[0] else \"\" end" <<<"$agents")"
  [[ -n "$ids" ]] || die "expected exactly one $1 agent"
  printf '%s' "$ids"
}
cmo="$(one CMO '.role == "cmo"')"
marketer="$(one "Content Marketer" '.name == "Content Marketer"')"
sr="$(one "Sr. Engineer" '.name == "Sr. Engineer"')"
cio="$(one CIO '.name == "CIO"')"
log "CMO $cmo, CIO $cio, Content Marketer $marketer, Sr. Engineer $sr"
# check all four before the first change
for a in "$cmo" "$cio" "$marketer" "$sr"; do api GET "/agents/$a/instructions-bundle/file?path=AGENTS.md" >/dev/null; done

ensure_section "$cmo" "$WORK/cmo.md"
ensure_section "$marketer" "$WORK/marketer.md"
ensure_section "$cio" "$WORK/cio.md"
ensure_section "$sr" "$WORK/engineer.md"
log "done"
