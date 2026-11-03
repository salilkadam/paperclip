#!/usr/bin/env bash
# Per-agent OpenCode data-directory isolation for bionic-org.
#
# WHY: all agents run `opencode run` as the same OS user (HOME=/paperclip) in
# the app pod, so every agent shares ONE SQLite database
# (/paperclip/.local/share/opencode/opencode.db). Concurrent runs hit
# SQLITE_BUSY and opencode 1.18.x kills the whole run with
#   Error: Unexpected error / database is locked
# or mid-run "Failed to execute statement" (upstream issues
# anomalyco/opencode#33320, #47566, #48416; retry PRs unmerged).
#
# FIX: point each agent's XDG_DATA_HOME/XDG_STATE_HOME at its own directory
# under the /paperclip PVC (plain env bindings in agents.adapter_config.env)
# and pre-seed each with a copy of the shared DB so session resume keeps
# working after the switch.
#
# Idempotent: re-running only fills in missing dirs/copies and re-applies the
# env bindings.
#
# Usage: deploy/scripts/apply-agent-opencode-data-isolation.sh
# Requires: kubectl context with bionicorg + pg namespaces.
set -euo pipefail

APP_NS=bionicorg
# The CNPG primary moves on failover (pg-ceph-7 was primary until 2026-11): find it.
DB_POD="${DB_POD:-$(kubectl -n pg get pods -l cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')}"
[ -n "$DB_POD" ] || { echo "no CNPG primary found in namespace pg" >&2; exit 1; }
echo "database pod: $DB_POD (primary)"
DB_NS=pg
DB=bionicorg
COMPANY=62d63984-df6c-49be-981c-1273f68a451c
SHARED_DATA=/paperclip/.local/share/opencode

POD=$(kubectl get pods -n "$APP_NS" -l app=bionic-org -o jsonpath='{.items[0].metadata.name}' 2>/dev/null \
  || kubectl get pods -n "$APP_NS" -o name | grep '^pod/bionic-org' | head -1 | cut -d/ -f2)
echo "app pod: $POD"

# 1) Create per-agent dirs and seed each with the shared DB (only if absent).
IDS=$(kubectl exec "$DB_POD" -n "$DB_NS" -c postgres -- psql -d "$DB" -A -t -c \
  "SELECT id FROM agents WHERE company_id='$COMPANY' ORDER BY name;")
for id in $IDS; do
  d=/paperclip/agents/$id/opencode
  # NOTE: opencode nests its own `opencode/` dir under XDG_DATA_HOME, so the
  # effective DB path is $d/data/opencode/opencode.db. kubectl exec defaults to
  # root in this image while the app runs as node(1000) — always chown back.
  kubectl exec "$POD" -n "$APP_NS" -c bionic -- sh -c "
    mkdir -p '$d/data/opencode' '$d/state/opencode'
    if [ ! -f '$d/data/opencode/opencode.db' ] && [ -f '$SHARED_DATA/opencode.db' ]; then
      cp '$SHARED_DATA/opencode.db' '$d/data/opencode/opencode.db'
      [ -f '$SHARED_DATA/opencode.db-wal' ] && cp '$SHARED_DATA/opencode.db-wal' '$d/data/opencode/opencode.db-wal' || true
      echo \"seeded $id\"
    fi
    chown -R node:node '$d'
  "
done

# 2) Merge XDG bindings into each agent's adapter_config.env (plain values).
for id in $IDS; do
  d=/paperclip/agents/$id/opencode
  kubectl exec "$DB_POD" -n "$DB_NS" -c postgres -- psql -d "$DB" -c "
    UPDATE agents SET adapter_config = jsonb_set(
        jsonb_set(
          adapter_config,
          '{env,XDG_DATA_HOME}',
          '{\"type\":\"plain\",\"value\":\"$d/data\"}'::jsonb, true),
        '{env,XDG_STATE_HOME}',
        '{\"type\":\"plain\",\"value\":\"$d/state\"}'::jsonb, true),
      updated_at = now()
    WHERE id = '$id';"
done

# 3) Verify
kubectl exec "$DB_POD" -n "$DB_NS" -c postgres -- psql -d "$DB" -A -F'|' -c \
  "SELECT name, adapter_config->'env'->'XDG_DATA_HOME'->>'value' FROM agents WHERE company_id='$COMPANY' ORDER BY name;"
echo "OK: per-agent OpenCode data isolation applied"
