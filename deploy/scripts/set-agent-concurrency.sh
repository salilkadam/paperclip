#!/usr/bin/env bash
# Applies the org's agent concurrency policy to the bionic-org (Reliora Inc)
# Paperclip database, so a from-scratch org recreation ends in the same safe
# state.
#
# WHY: Paperclip bounds concurrent runs only PER AGENT
# (runtimeConfig.heartbeat.maxConcurrentRuns, default 20; enforced in
# server/src/services/heartbeat.ts startNextQueuedRunForAgent via
# countRunningRunsForAgent). There is NO cross-agent/global governor. Each
# concurrent run spawns a ~1Gi adapter/CLI child inside the single control-plane
# pod (OOM ceiling 6Gi). With 5 org agents and the default 20, the worst-case
# fan-out (5 x 20) blows far past the limit.
#
# Setting maxConcurrentRuns=1 bounds the whole org to at most (agents x 1)
# concurrent children — for 5 agents ~5Gi, inside the 6Gi ceiling. Extra wakes
# are NOT dropped: they land in the durable wake-queue / run-dispatch modules and
# drain as slots free, so a burst degrades to *queueing* (slower), never an OOM.
# Raise this only together with the memory limit, keeping:
#     agents x maxConcurrentRuns x ~1Gi  <  memory limit
#
# Idempotent. Edit COMPANY_ID / PG context for your environment.
set -euo pipefail

COMPANY_ID="${COMPANY_ID:-62d63984-df6c-49be-981c-1273f68a451c}"   # Reliora Inc
MAX_CONCURRENT_RUNS="${MAX_CONCURRENT_RUNS:-1}"
PG_NS="${PG_NS:-pg}"
# The CNPG primary moves on failover (pg-ceph-7 was primary until 2026-11): find it.
PG_POD="${PG_POD:-$(kubectl -n pg get pods -l cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')}"
[ -n "$PG_POD" ] || { echo "no CNPG primary found in namespace ${PG_NS}" >&2; exit 1; }
PG_DB="${PG_DB:-bionicorg}"
PG_USER="${PG_USER:-postgres}"

echo "==> Setting heartbeat.maxConcurrentRuns=${MAX_CONCURRENT_RUNS} for company ${COMPANY_ID}"
kubectl -n "${PG_NS}" exec "${PG_POD}" -c postgres -- \
  psql -d "${PG_DB}" -U "${PG_USER}" -v ON_ERROR_STOP=1 -c "
    BEGIN;
    UPDATE agents
      SET runtime_config = jsonb_set(
            runtime_config,
            '{heartbeat,maxConcurrentRuns}',
            '${MAX_CONCURRENT_RUNS}'::jsonb,
            true
          ),
          updated_at = now()
      WHERE company_id = '${COMPANY_ID}';
    COMMIT;"

echo "==> Result:"
kubectl -n "${PG_NS}" exec "${PG_POD}" -c postgres -- \
  psql -d "${PG_DB}" -U "${PG_USER}" -A -F'|' -c "
    SELECT name, status, runtime_config->'heartbeat' AS heartbeat
      FROM agents
     WHERE company_id = '${COMPANY_ID}'
     ORDER BY role;"
