# @paperclipai/plugin-loc-letta — Loc-Letta Memory

Paperclip connector that gives every company persistent **org memory** backed by
your own self-hosted [Letta](https://github.com/letta-ai/letta) server:

- **Archival memory** — large, semantically searchable store for durable facts
  (`remember`, `recall`).
- **Org profile** — one compact core block per company, always in context
  (`read_profile`, `update_profile`).

Each Paperclip company maps to exactly one Letta agent, named
`paperclip-org-memory-<companyId>` by default, created lazily on first tool use
and persisted in plugin state.

## Configuration

| Field | Default | Notes |
| --- | --- | --- |
| `server.url` | `http://letta-server.letta.svc:8283` | In-cluster Service; the public URL works too. Moving the stack is a one-value change. |
| `server.token` | — (required) | Bearer token; paste it or pick a saved Paperclip secret (`secret_ref`). |
| `server.requestTimeoutMs` | `20000` | Per-request timeout. |
| `memory.orgBlockLabel` | `org_profile` | Core block label holding the org profile. |
| `memory.profileLimit` | `4000` | Max chars accepted for profile updates; the block limit on creation. |
| `memory.archivalLimit` | `20` | Max passages `recall` returns. |
| `memory.agentNameTemplate` | `paperclip-org-memory-{companyId}` | Must contain `{companyId}`. |
| `memory.agentModel` | `letta/letta-free` | Letta requires a model at agent creation even for storage-only agents. |
| `memory.embeddingModel` / `embeddingEndpoint` / `embeddingDim` | off | Set when the server's default embedding endpoint is unreachable; applied at agent creation. |

## Verified API usage (Letta 0.16.7)

Auth is `Authorization: Bearer <token>` (HTTP Basic is rejected); some routes
answer 307, so requests follow redirects. A bad token answers 401.

- `GET /v1/agents/?limit=N` → bare JSON array (health probe + adoption search).
- `POST /v1/agents/` with `{name, model, memory_blocks:[{label,value,limit}]}`
  → `AgentState` including `blocks` (no `model` → 422; duplicate names are
  allowed, hence adopt-by-name before create).
- `GET /v1/agents/{id}/core-memory/blocks` → core blocks of the agent.
- `POST /v1/blocks/` + `PATCH /v1/agents/{id}/core-memory/blocks/attach/{blockId}`
  → recover a block when an adopted agent is missing it.
- `GET /v1/blocks/{id}` / `PATCH /v1/blocks/{id} {"value"}` → read/replace the
  profile (this build has no PUT and no block append route; appends are
  read-modify-patch).
- `POST /v1/agents/{id}/archival-memory` `{text, tags}` → `[Passage]`
  (no metadata field on this build, so provenance rides in tags; the server's
  `created_at` timestamps the passage).
- `GET /v1/agents/{id}/archival-memory/search?query=&top_k=` →
  `{results:[{id,timestamp,content,tags}],count}`, best match first (no numeric
  score is returned).

## Development

```sh
pnpm --filter @paperclipai/plugin-loc-letta typecheck
pnpm --filter @paperclipai/plugin-loc-letta test
pnpm --filter @paperclipai/plugin-loc-letta build
pnpm --filter @paperclipai/plugin-loc-letta bundle   # self-contained ./bundle for local install
```

Tests are network-free: a scripted in-memory Letta server (same endpoint shapes
as the live one) plus a fake Paperclip host.
