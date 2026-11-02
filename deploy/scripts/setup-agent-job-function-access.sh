#!/usr/bin/env bash
# setup-agent-job-function-access.sh — make the owner's job-function rule
# (2026-11-02, doc/plans/2026-11-02-agent-job-function-access.md) a gateway and
# install rule for EVERY active company, idempotently. Run with --dry-run first:
# it prints what C-level agents would lose and which routines they own.
#
# The rule: C-level agents delegate, review and strategize. They read everything
# and write only to Google Drive. Repo writes belong to the engineering agents.
#
# Per company it:
#   1. ensures two company policies, by exact name, over the C-level agents:
#      allow gw_create_file/gw_create_folder on the Google Workspace connection,
#      then block every non-read tool on every connection. The allow has the
#      lower priority number, so it is evaluated first. A write tool added later
#      is blocked by default. BOARD_REPORT_TOOLS (space-separated exact tool
#      names) adds an allow for the tools C-level agents report to the board with.
#      The catalog classifies any unrecognized verb as "read" (gw_modify_message,
#      gw_register_tenant), so tools whose NAME looks mutating are blocked by name
#      too. A mutating tool with an innocent name is still open: --dry-run lists
#      every read-classified tool for a person to check;
#   2. splits GitHub by connection, because `git` and `gh` receive a real token
#      and tool policies do NOT reach them. Only the install target does:
#        managed (connectorProfile github.code) -> engineering agents only;
#        any other GitHub connection            -> everyone else, MCP read-only.
#      It narrows nothing until BOTH exist. Otherwise C-level agents would lose
#      GitHub reads, or the two grants would collide in the credential resolver.
#      It also narrows nothing while a grant on the read connection could export
#      a token (it has both oauth.access_token and GitHub metadata). The run then
#      reports pending and exits 3;
#   3. writes a marker-delimited delegation section into each C-level AGENTS.md;
#   4. proves it (not in --dry-run). A write the board approves first ("ask
#      first", carded to the board channel in Slack) is the owner's accepted
#      exception (2026-11-02); the proof fails only on a write made without the
#      board. Checks: access summaries for every C-level agent on
#      every connection, a real gateway call that must be refused, and engineer
#      write access on the managed connection. Any mismatch is fatal.
#
# Cluster access is NOT handled here: agents have no per-agent cluster identity.
#
# Exit: 0 done; 1 error or failed proof; 3 applied, but owner steps are pending.
#
# Requires: curl jq; PAPERCLIP_BOARD_KEY_FILE — a 0600 file holding a board API
# key of an instance admin (`paperclipai token board create --name job-function
# --ttl-days 1`). The key never appears on a command line.
#
# Usage: deploy/scripts/setup-agent-job-function-access.sh [--company-id <id>] [--dry-run]
set -euo pipefail

API="${PAPERCLIP_API_BASE:-https://org.baisoln.com}"
WORKSPACE_CONN="${WORKSPACE_CONN_NAME:-Loc-Google Workspace}"
DRIVE_WRITE_TOOLS='["gw_create_file","gw_create_folder"]'
NON_READ_RISKS='["low","medium","high","critical","write","destructive"]'
ALLOW_POLICY="job-function: C-level agents write to Google Drive"
REPORT_POLICY="job-function: C-level agents report to the board"
BLOCK_POLICY="job-function: C-level agents do not write elsewhere"
BLOCK_NAMED_POLICY="job-function: C-level agents do not use mutating tools classified read"
# A tool classified read whose name has one of these words. Tokens, not substrings.
MUTATING_NAME='(^|[_.:-])(merge|push|fork|assign|dismiss|create|update|delete|remove|add|star|unstar|subscribe|unsubscribe|write|trigger|send|publish|execute|run|cancel|rerun|request|manage|close|reopen|submit|register|modify|move|share|rename|upload|reply|edit|set|post|approve|reject|revoke|invite|lock|unlock|import|sync|restart|deploy|append|hset|hdel|hincrby|incr|decr|lpush|rpush|lpop|rpop|lset|mset|expire|persist|flushdb|flushall|begin|commit|rollback|exec|clone|resize|reclassify|requeue|migrate|enable|disable|log|watch|unwatch)([_.:-]|$)'
# A connection prefix is allowed (gh_get_post). calc_ only does arithmetic. preview-post only renders.
READ_NAME='^([a-z0-9]+_)?(get|list|search|read|fetch)[_.:-]|[_.:-](read|get|list)$|^calc_|^preview-post-tool$'
READ_ONLY_POLICY="job-function: this GitHub connection is read-only"
BEGIN='<!-- BEGIN bionic-org:job-function -->'
END='<!-- END bionic-org:job-function -->'
ONLY_COMPANY=""; DRY=0; PENDING=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company-id) ONLY_COMPANY="${2:?--company-id needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[job-function] $*"; }
pending() { log "  PENDING: $*"; PENDING=$((PENDING + 1)); }
for b in curl jq; do command -v "$b" >/dev/null || die "$b is required"; done
[[ -r "${PAPERCLIP_BOARD_KEY_FILE:-}" ]] || die "PAPERCLIP_BOARD_KEY_FILE must point to a readable file"
[[ "$(stat -c %a "$PAPERCLIP_BOARD_KEY_FILE")" == 600 ]] || die "$PAPERCLIP_BOARD_KEY_FILE must be mode 0600"

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$PAPERCLIP_BOARD_KEY_FILE")" > "$WORK/auth"

# api METHOD PATH [json-file]  -> body on stdout; non-2xx is fatal with the body.
api() {
  local code
  code="$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X "$1" -H @"$WORK/auth" \
    -H 'Content-Type: application/json' -H 'User-Agent: paperclip-job-function/1' \
    ${3:+--data-binary @"$3"} --max-time 120 "$API/api$2")" || die "$1 $2: transport error"
  [[ "$code" =~ ^2 ]] || die "$1 $2 -> HTTP $code: $(head -c 400 "$WORK/resp")"
  cat "$WORK/resp"
}

# ensure_policy CID EXISTING_JSON WANT_JSON: create, or update in place if drifted.
ensure_policy() {
  local cid="$1" existing="$2" want="$3" name have
  name="$(jq -r .name <<<"$want")"
  have="$(jq -c --arg n "$name" '[.[] | select(.name==$n)][0] // empty' <<<"$existing")"
  printf '%s' "$want" > "$WORK/p.json"
  if [[ -z "$have" ]]; then
    log "  policy create: $name"
    (( DRY )) || api POST "/companies/$cid/tools/policies" "$WORK/p.json" >/dev/null
  elif ! jq -e --argjson w "$want" '
      def norm: with_entries(.value |= (if type=="array" then sort else . end));
      (.policyType==$w.policyType) and (.enabled==true) and (.priority==$w.priority)
      and ((.selectors|norm)==($w.selectors|norm))' <<<"$have" >/dev/null; then
    log "  policy update (drifted): $name"
    (( DRY )) || api PATCH "/companies/$cid/tools/policies/$(jq -r .id <<<"$have")" "$WORK/p.json" >/dev/null
  else
    log "  policy ok: $name"
  fi
}

# ensure_installs CONNECTION AGENT_IDS_JSON: exactly these agent install targets.
ensure_installs() {
  local conn="$1" ids="$2" cur want
  cur="$(api GET "/tool-connections/$conn/installs" | jq -c '[.installs[] | "\(.targetType):\(.targetId)"] | sort')"
  want="$(jq -c '[.[] | "agent:\(.)"] | sort' <<<"$ids")"
  if [[ "$cur" == "$want" ]]; then log "  installs ok: $conn"; return; fi
  log "  installs change on $conn: $(jq -c 'map(select(startswith("company:")))|length' <<<"$cur") company, $(jq length <<<"$cur") total -> $(jq length <<<"$want") agents"
  (( DRY )) && return
  jq -n --argjson i "$ids" '{installs: [$i[] | {targetType: "agent", targetId: .}]}' > "$WORK/i.json"
  api PUT "/tool-connections/$conn/installs" "$WORK/i.json" >/dev/null
}

# ensure_instructions AGENT_ID: replace or append the delegation section.
ensure_instructions() {
  local aid="$1" cur content next
  cur="$(api GET "/agents/$aid/instructions-bundle/file?path=AGENTS.md")"
  content="$(jq -r '.content // ""' <<<"$cur")"
  next="$(jq -rn --arg c "$content" --arg b "$BEGIN" --arg e "$END" --rawfile s "$WORK/section.md" '
    ($b + "\n" + $s + $e) as $block
    | if ($c | contains($b)) then
        ($c | index($b)) as $i | ($c | index($e)) as $j
        | $c[:$i] + $block + $c[($j + ($e | length)):]
      else ($c | sub("\\s+$"; "")) + "\n\n" + $block + "\n" end')"
  if [[ "$next" == "$content" ]]; then log "  instructions ok: $aid"; return; fi
  log "  instructions update: $aid"
  (( DRY )) && return
  jq -n --arg c "$next" --arg h "$(jq -r '.contentHash // empty' <<<"$cur")" \
    '{path: "AGENTS.md", content: $c} + (if $h == "" then {} else {baseHash: $h} end)' > "$WORK/f.json"
  api PUT "/agents/$aid/instructions-bundle/file" "$WORK/f.json" >/dev/null
}

cat > "$WORK/section.md" <<'EOF'
## Your job function (owner's rule)

You delegate, review, strategize and answer to the board. You do not do tactical execution.

- **You may write only** to Google Drive (documents) and your own agent memory. You can read everything.
- **Repo, website and code changes:** create a task for the Sr. Engineer or a member of the development team. Do not ask for GitHub access. Repo writes are their job function.
- **Blogs, marketing material, decks and collateral:** create a task for the Content Marketer or the agent the CMO designates.
- Review the result when the task comes back. A missing write permission is expected: delegate, do not report it as a blocker.
- **One new task per deliverable.** Never route new work through an existing task, and never through a closed one: its assignee has finished and will not look at it again.
- **Check what you wait on.** Each time you wake, check the status of every task you are waiting on. If one is done or cancelled without your deliverable, open a new task at once. Never wait more than a day on a hand-off without checking it.
EOF

# An instance admin lists every company but can change only those it is a member
# of. Report the others: a skipped company must not look like a finished one.
companies="$(api GET "/companies" | jq 'if type=="array" then . else (.companies // .items) end | [.[] | select((.status // "active") != "archived")]')"
accessible="$(api GET "/companies?scope=accessible" | jq -c 'if type=="array" then . else (.companies // .items) end | [.[].id]')"
while read -r skipped; do
  [[ -z "$skipped" ]] || pending "not applied to company '$skipped': this key's user is not a member of it"
done < <(jq -r --argjson a "$accessible" --arg only "$ONLY_COMPANY" '.[] | select(($only == "" or .id == $only) and (.id | IN($a[]) | not)) | .name' <<<"$companies")
companies="$(jq --argjson a "$accessible" '[.[] | select(.id | IN($a[]))]' <<<"$companies")"
[[ -z "$ONLY_COMPANY" ]] || companies="$(jq --arg id "$ONLY_COMPANY" '[.[] | select(.id==$id)]' <<<"$companies")"
[[ "$(jq length <<<"$companies")" -gt 0 ]] || die "no matching active company visible to this board key"

while read -r cid; do
  cname="$(jq -r --arg id "$cid" '.[]|select(.id==$id)|.name' <<<"$companies")"
  log "== $cname"
  agents="$(api GET "/companies/$cid/agents" | jq '[.[] | select(.status != "terminated")]')"
  clevel="$(jq -c '[.[] | select((.role | IN("ceo","cto","cmo","cfo"))
      or ((.title // "") | test("^Chief .*Officer$")) or (.name | test("^C[A-Z]O$"))) | .id]' <<<"$agents")"
  engineers="$(jq -c --argjson c "$clevel" '[.[] | select((.role | ascii_downcase | test("engineer|devops|^qa$")) and (.id | IN($c[]) | not)) | .id]' <<<"$agents")"
  others="$(jq -c --argjson e "$engineers" '[.[] | select(.id | IN($e[]) | not) | .id]' <<<"$agents")"
  log "  C-level: $(jq -r --argjson c "$clevel" '[.[] | select(.id | IN($c[])) | .name] | join(", ")' <<<"$agents")"
  log "  engineering: $(jq -r --argjson c "$engineers" '[.[] | select(.id | IN($c[])) | .name] | join(", ")' <<<"$agents")"
  if [[ "$(jq length <<<"$clevel")" -eq 0 ]]; then pending "no C-level agents found, skipped"; continue; fi

  conns="$(api GET "/companies/$cid/tools/connections" | jq '(if type=="array" then . else .connections end) | [.[] | select(.status=="active")]')"
  ws="$(jq -r --arg n "$WORKSPACE_CONN" '[.[] | select(.name==$n)][0].id // empty' <<<"$conns")"
  if [[ -z "$ws" ]]; then pending "$cname has no active '$WORKSPACE_CONN' connection, skipped: blocking now would leave C-level agents no place to write"; continue; fi
  catalog="$(api GET "/tool-connections/$ws/catalog")"
  jq -e --argjson t "$DRIVE_WRITE_TOOLS" '[(if type=="array" then . else (.tools // .entries // .catalog // []) end) | .[]? | select((.status // "active") == "active") | .toolName] as $have | all($t[]; . as $x | $have | index($x))' <<<"$catalog" >/dev/null \
    || die "$cname: $WORKSPACE_CONN catalog lacks a Drive write tool ($DRIVE_WRITE_TOOLS). Refresh the catalog first"

  # What the block will take away, and which routines C-level agents still own.
  jq -c '.[]' <<<"$conns" > "$WORK/conns"
  : > "$WORK/named"
  while read -r conn; do
    cid_conn="$(jq -r .id <<<"$conn")"
    while read -r aid; do
      access="$(api GET "/tool-connections/$cid_conn/test-agents/$aid/access")"
      open="$(jq -r '[.access.tools[] | select(.risk != "read" and .decision != "off") | .toolName] | join(", ")' <<<"$access")"
      [[ -z "$open" ]] || log "  open now: $(jq -r --arg a "$aid" '.[]|select(.id==$a)|.name' <<<"$agents") on $(jq -r .name <<<"$conn"): $open"
      jq -r --arg m "$MUTATING_NAME" --arg r "$READ_NAME" '.access.tools[] | select(.risk == "read"
          and (.toolName | test($m; "i")) and (.toolName | test($r; "i") | not)) | .toolName' <<<"$access" >> "$WORK/named"
      if (( DRY )) && [[ "$aid" == "$(jq -r '.[0]' <<<"$clevel")" ]]; then
        log "  read-classified on $(jq -r .name <<<"$conn"), check these by eye: $(jq -r '[.access.tools[] | select(.risk == "read") | .toolName] | join(", ")' <<<"$access")"
      fi
    done < <(jq -r '.[]' <<<"$clevel")
  done < "$WORK/conns"
  named="$(sort -u "$WORK/named" | jq -R . | jq -cs .)"
  # Everything below that can abort runs before the first change, so a bad
  # precondition cannot leave a company half-applied.
  while read -r aid; do
    api GET "/agents/$aid/instructions-bundle/file?path=AGENTS.md" >/dev/null
    access="$(api GET "/tool-connections/$ws/test-agents/$aid/access")"
    jq -e --argjson t "$DRIVE_WRITE_TOOLS" '[.access.tools[] | select(.toolName | IN($t[]))] | length == ($t | length)' <<<"$access" >/dev/null \
      || die "$cname: agent $aid does not see the Drive write tools. Is $WORKSPACE_CONN healthy and installed? Nothing was changed for this company"
  done < <(jq -r '.[]' <<<"$clevel")
  legacy="$(api GET "/companies/$cid/secrets" | jq -r '(if type=="array" then . else .secrets end) | [.[] | .name | select(test("^(GH|GITHUB)_TOKEN$"))] | join(", ")')"
  [[ -z "$legacy" ]] || pending "$cname has legacy company secrets ($legacy). An agent with no GitHub install can fall back to them for git"
  routines="$(api GET "/companies/$cid/routines")"
  jq -r --argjson c "$clevel" --argjson a "$agents" '.[] | select(.status != "archived" and (.assigneeAgentId | IN($c[])))
      | "[job-function]   C-level routine: \(.title) -> \(.assigneeAgentId as $i | $a[] | select(.id==$i) | .name)"' <<<"$routines"

  github="$(jq -c '[.[] | select((.config.sourceTemplateKey // .transportConfig.sourceTemplateKey) == "github")]' <<<"$conns")"
  managed="$(jq -r '[.[] | select(.config.oauth.connectorProfile == "github.code")] | if length == 1 then .[0].id else "" end' <<<"$github")"
  readconn="$(jq -r '[.[] | select(.config.oauth.connectorProfile != "github.code")] | if length == 1 then .[0].id else "" end' <<<"$github")"
  exports=""
  if [[ -n "$readconn" ]]; then
    # git-credentials.ts issues a token only from an active agent or user grant
    # with both of these. The route can hide such grants from a key without the
    # capability, so a hidden list counts as able to export. A connection with no
    # such grant fails closed in the resolver: "The managed GitHub identity is
    # incomplete". That failure is what keeps git and gh away from these agents.
    exports="$(api GET "/tool-connections/$readconn/grants" | jq -r '
      if (.capabilities.canViewOtherPersonalIdentities // false) | not then "(hidden from this key)" else
        [.grants[] | select(.status == "active" and (.kind | IN("agent","user")))
         | select(([.credentialSecretRefs[]?.configPath] | index("oauth.access_token")) and (.providerTenant.github != null))
         | .id] | join(", ") end')"
  fi
  # Read now, so that a failed read cannot stop the run after the policies changed.
  [[ -z "$managed" ]] || api GET "/tool-connections/$managed/installs" >/dev/null
  [[ -z "$readconn" ]] || api GET "/tool-connections/$readconn/installs" >/dev/null
  existing="$(api GET "/companies/$cid/tools/policies" | jq 'if type=="array" then . else .policies end')"
  ensure_policy "$cid" "$existing" "$(jq -n --arg n "$ALLOW_POLICY" --arg ws "$ws" --argjson a "$clevel" --argjson t "$DRIVE_WRITE_TOOLS" \
    '{name: $n, description: "C-level agents write documents to Google Drive.", policyType: "allow", priority: 10, enabled: true,
      selectors: {agentIds: $a, connectionId: $ws, toolNames: $t}, conditions: null}')"
  if [[ -n "${BOARD_REPORT_TOOLS:-}" ]]; then
    ensure_policy "$cid" "$existing" "$(jq -n --arg n "$REPORT_POLICY" --argjson a "$clevel" --arg t "$BOARD_REPORT_TOOLS" \
      '{name: $n, description: "C-level agents answer to the board.", policyType: "allow", priority: 10, enabled: true,
        selectors: {agentIds: $a, toolNames: ($t | split(" "))}, conditions: null}')"
  fi
  ensure_policy "$cid" "$existing" "$(jq -n --arg n "$BLOCK_POLICY" --argjson a "$clevel" --argjson r "$NON_READ_RISKS" \
    '{name: $n, description: "C-level agents delegate tactical work. Create a task for the agent whose job function it is.",
      policyType: "block", priority: 11, enabled: true, selectors: {agentIds: $a, riskLevels: $r}, conditions: null}')"

  if [[ "$named" != "[]" ]]; then
    log "  mutating names classified read: $(jq -r 'join(", ")' <<<"$named")"
    ensure_policy "$cid" "$existing" "$(jq -n --arg n "$BLOCK_NAMED_POLICY" --argjson a "$clevel" --argjson t "$named" \
      '{name: $n, description: "C-level agents delegate tactical work. Create a task for the agent whose job function it is.",
        policyType: "block", priority: 11, enabled: true, selectors: {agentIds: $a, toolNames: $t}, conditions: null}')"
  fi

  if [[ "$(jq length <<<"$engineers")" -eq 0 ]]; then
    pending "$cname has no engineering agents: GitHub installs not narrowed"
  elif [[ -z "$managed" ]]; then
    pending "$cname needs exactly one managed GitHub connection for engineering (owner's consent): GitHub installs not narrowed"
  elif [[ -z "$readconn" ]]; then
    pending "$cname needs exactly one separate read-only GitHub connection for everyone else: GitHub installs not narrowed. Until then C-level agents can still use git and gh"
  elif [[ -n "$exports" ]]; then
    pending "$cname: grant(s) $exports on the read connection can give git and gh a real token: GitHub installs not narrowed. Use a credential without GitHub metadata"
  else
    ensure_policy "$cid" "$existing" "$(jq -n --arg n "$READ_ONLY_POLICY" --arg c "$readconn" --argjson r "$NON_READ_RISKS" \
      '{name: $n, description: "Repo writes go through the engineering agents.", policyType: "block", priority: 12, enabled: true,
        selectors: {connectionId: $c, riskLevels: $r}, conditions: null}')"
    ensure_installs "$managed" "$engineers"
    ensure_installs "$readconn" "$others"
  fi

  while read -r aid; do ensure_instructions "$aid"; done < <(jq -r '.[]' <<<"$clevel")

  if (( DRY )); then continue; fi
  log "  proving"
  while read -r conn; do
    cid_conn="$(jq -r .id <<<"$conn")"
    while read -r aid; do
      access="$(api GET "/tool-connections/$cid_conn/test-agents/$aid/access")"
      open="$(jq -r --argjson t "$DRIVE_WRITE_TOOLS" --arg x "${BOARD_REPORT_TOOLS:-}" --arg ws "$ws" --arg c "$cid_conn" '
        ($x | split(" ")) as $rep
        | [.access.tools[] | select(.risk != "read" and .decision == "allowed")
           | select((.toolName | IN($rep[])) | not)
           | select(($c == $ws and (.toolName | IN($t[]))) | not) | .toolName] | join(", ")' <<<"$access")"
      [[ -z "$open" ]] || die "$cname: agent $aid can still write without the board on $(jq -r .name <<<"$conn"): $open"
      misread="$(jq -r --arg m "$MUTATING_NAME" --arg r "$READ_NAME" '[.access.tools[] | select(.risk == "read" and .decision == "allowed"
          and (.toolName | test($m; "i")) and (.toolName | test($r; "i") | not)) | .toolName] | join(", ")' <<<"$access")"
      [[ -z "$misread" ]] || die "$cname: agent $aid can still use mutating tools classified read on $(jq -r .name <<<"$conn"): $misread"
    done < <(jq -r '.[]' <<<"$clevel")
  done < "$WORK/conns"
  while read -r aid; do
    access="$(api GET "/tool-connections/$ws/test-agents/$aid/access")"
    jq -e --argjson t "$DRIVE_WRITE_TOOLS" '[.access.tools[] | select(.toolName | IN($t[])) | select(.decision == "allowed")] | length == ($t | length)' <<<"$access" >/dev/null \
      || die "$cname: agent $aid cannot write to Google Drive: $(jq -c --argjson t "$DRIVE_WRITE_TOOLS" '[.access.tools[] | select(.toolName | IN($t[])) | {toolName, decision}]' <<<"$access")"
  done < <(jq -r '.[]' <<<"$clevel")
  # A real gateway call as a C-level agent. The repository does not exist, so
  # nothing could be written even if the block failed.
  probe_agent="$(jq -r '.[0]' <<<"$clevel")"; first_gh=""
  while read -r g; do
    access="$(api GET "/tool-connections/$g/test-agents/$probe_agent/access")"
    if jq -e '[.access.tools[] | select(.toolName == "create_branch")] | length == 1' <<<"$access" >/dev/null; then first_gh="$g"; break; fi
  done < <(jq -r '.[].id' <<<"$github")
  if [[ -n "$first_gh" ]]; then
    jq -n --arg a "$probe_agent" '{agentId: $a, toolName: "create_branch", parameters: {owner: "zz-governance-probe", repo: "none", branch: "probe"}}' > "$WORK/probe.json"
    resp="$(api POST "/tool-connections/$first_gh/test-calls" "$WORK/probe.json")"
    [[ "$(jq -r '.decision // "none"' <<<"$resp")" == off && "$(jq -r '.error.reasonCode // ""' <<<"$resp")" == deny_policy_block ]] \
      || die "$cname: C-level create_branch was not refused by policy: $(head -c 300 <<<"$resp")"
    log "  probe ok: C-level create_branch -> off (deny_policy_block)"
  elif [[ "$(jq length <<<"$github")" -gt 0 ]]; then
    pending "$cname: no GitHub connection lists create_branch for $probe_agent, so the live refusal was not proven"
  fi
  if [[ -n "$managed" && "$(jq length <<<"$engineers")" -gt 0 ]]; then
    while read -r aid; do
      access="$(api GET "/tool-connections/$managed/test-agents/$aid/access")"
      jq -e '[.access.tools[] | select(.toolName == "create_branch" and .decision != "off")] | length == 1' <<<"$access" >/dev/null \
        || die "$cname: engineering agent $aid has no GitHub write access on the managed connection"
    done < <(jq -r '.[]' <<<"$engineers")
    log "  engineering agents can write on the managed connection"
  fi
done < <(jq -r '.[].id' <<<"$companies")

if (( PENDING )); then log "$PENDING pending item(s) above"; exit 3; fi
log "done"
