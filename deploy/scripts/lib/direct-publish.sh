# shellcheck shell=bash
# direct-publish.sh — companies whose agents schedule their own blog and social
# posts without a board approval card. Sourced by setup-trypost-governance.sh,
# setup-ghost-governance.sh and setup-ghost-connections.sh.
#
# Owner decision, 2026-11-15 (Reliora): blogs and LinkedIn posts go live on
# schedule without board approval, so pending approvals never make a post miss
# its slot; the owner removes a post by hand if the board dislikes it.
#
# What stays gated for these companies too: TryPost publish-now, delete, approve,
# recurrence, repurpose and queue tools; Ghost unpublish and delete; TryPost
# keys and webhooks stay blocked. Every other company keeps the full gate.
DIRECT_PUBLISH_COMPANY_IDS=(
  62d63984-df6c-49be-981c-1273f68a451c   # Reliora Inc
)

# is_direct_publish COMPANY_ID -> exit 0 when the company publishes directly
is_direct_publish() {
  local id
  for id in "${DIRECT_PUBLISH_COMPANY_IDS[@]}"; do [[ "$id" == "$1" ]] && return 0; done
  return 1
}
