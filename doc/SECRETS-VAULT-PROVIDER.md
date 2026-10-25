# HashiCorp Vault secret provider — operator guide

Status: provider implemented (PR-A of `doc/plans/2026-10-24-hashicorp-vault-secret-provider.md`).
Company-level default selection, migration of existing secrets and the production
Vault role are later phases (PR-B, PR-C, PR-D); until they land, nothing moves to
Vault unless a secret is explicitly created against a Vault provider vault.

## How it works

- **Custody.** Paperclip stores no Vault credential. The server signs in with its own
  Kubernetes ServiceAccount (Vault Kubernetes auth) and gets a short-lived token,
  renewed at 2/3 of its TTL and re-acquired on a 403 (at most once per 30 s, and only
  if no concurrent request already replaced the token, so a policy gap cannot mint a
  token per failing call). The projected
  ServiceAccount token is re-read on every login (the kubelet rotates it). The token
  is revoked (`revoke-self`) as the last step of a graceful shutdown.
- **Per-company provider vaults** carry only an optional Vault Enterprise
  `namespace`, and it must be the deployment namespace or listed in
  `PAPERCLIP_SECRETS_VAULT_ALLOWED_NAMESPACES` (the namespace picks which auth mount
  receives the server's ServiceAccount JWT). Address, KV mount and path prefix are
  deployment settings; the API rejects them per company so a company admin cannot
  redirect the server's identity. A provider vault saved before this provider existed
  loses any stored address/mount/prefix on its next update.
- **Layout** (KV v2, one entry per Paperclip secret, the secret UUID as leaf, one KV
  version per Paperclip version, value in field `value`):

  ```
  <mount>/<prefix>/companies/<companyId>/company/<secretId>
  <mount>/<prefix>/companies/<companyId>/users/<ownerUserId>/<secretId>
  <mount>/<prefix>/companies/<companyId>/agents/<ownerAgentId>/<secretId>
  <mount>/<prefix>/companies/<companyId>/projects/<ownerProjectId>/<secretId>
  <mount>/<prefix>/companies/<companyId>/plugins/<ownerPluginId>/<secretId>
  <mount>/<prefix>/_health/<host-hash>          (health-check canary)
  ```

  Instance-scoped secrets always have a plugin owner *and* an agent or project owner;
  they are filed under the agent or project. `plugins/` is only a fallback.

- **Writes** set metadata first (`max_versions`, default 100) and then data with
  check-and-set (`cas=0` on create, `cas=<current>` on rotate); a lost race is a typed
  `conflict`, never a silent overwrite.
- **Reads** use the version's own stored material (mount, path, KV version) and check
  the path lies inside the requesting company's subtree; a managed read or delete
  without a company is refused.
- **Deletes are soft only** (`archive` = one version, `delete` = all live versions).
  Paperclip never calls destroy; `vault kv undelete` recovers. Vault itself still
  permanently prunes the oldest version once an entry exceeds `max_versions`
  (soft-deleted versions count), and a pinned pruned version then resolves as
  `not_found`.
- **External references** (`<kv path>#<field>`) link values operators own, read-only,
  only under `PAPERCLIP_SECRETS_VAULT_EXTERNAL_PATHS` and never inside the managed
  prefix. The allowlist is re-checked on every read. Writing external values is not
  supported.
- **Health** writes a canary (metadata first, then data) and reads it back. The
  result is cached per server for 5 minutes (1 minute after a failure), so the Secrets
  page's 60 s poll does not write to Vault on every tick.
- **Errors** map to typed codes: 400 cas → `conflict`, 400 → `invalid_request`,
  403 → `access_denied`, 404 / deleted / pruned → `not_found`, 429 → `throttled`,
  unreachable / sealed / 5xx gateway → `provider_unavailable`, else `provider_error`.
  A missing value is never returned as an empty string.

## Deployment configuration (server env)

| Variable | Required | Meaning |
|---|---|---|
| `PAPERCLIP_SECRETS_VAULT_ADDR` | yes | Vault origin, e.g. `http://vault.vault.svc.cluster.local:8200` |
| `PAPERCLIP_SECRETS_VAULT_PREFIX` | yes | Managed prefix inside the mount, e.g. `t6-apps/bionic-org/paperclip` |
| `PAPERCLIP_SECRETS_VAULT_AUTH_METHOD` | no | `kubernetes` (default) or `token_file` (local development only) |
| `PAPERCLIP_SECRETS_VAULT_K8S_ROLE` | with kubernetes | Vault Kubernetes auth role bound to the server's ServiceAccount |
| `PAPERCLIP_SECRETS_VAULT_K8S_MOUNT` | no | Kubernetes auth mount (default `kubernetes`) |
| `PAPERCLIP_SECRETS_VAULT_K8S_JWT_PATH` | no | Projected SA token path (default `/var/run/secrets/kubernetes.io/serviceaccount/token`) |
| `PAPERCLIP_SECRETS_VAULT_TOKEN_FILE` | with token_file | File holding a Vault token (development) |
| `PAPERCLIP_SECRETS_VAULT_MOUNT` | no | KV v2 mount (default `secret`) |
| `PAPERCLIP_SECRETS_VAULT_NAMESPACE` | no | Vault Enterprise namespace |
| `PAPERCLIP_SECRETS_VAULT_ALLOWED_NAMESPACES` | no | Comma-separated extra namespaces a provider vault may select |
| `PAPERCLIP_SECRETS_VAULT_EXTERNAL_PATHS` | no | Comma-separated read-only paths for external refs: `a/b` allows exactly that KV entry, `a/b/` allows its subtree |
| `PAPERCLIP_SECRETS_VAULT_MAX_VERSIONS` | no | KV versions kept per secret (default 100) |
| `PAPERCLIP_SECRETS_VAULT_TIMEOUT_MS` | no | Per-request timeout (default 30000) |

For a private CA, use `NODE_EXTRA_CA_CERTS`.

## Vault policy for the server role

Least privilege for the managed prefix plus read-only external paths. **`create` on
metadata is required**: setting `max_versions` on a new entry is a metadata *create*
(proven against Vault 1.21.2 by the integration test; `read, update` alone is denied).

```hcl
path "secret/data/<prefix>/*"     { capabilities = ["create", "read", "update"] }
path "secret/metadata/<prefix>/*" { capabilities = ["create", "read", "update"] }
path "secret/delete/<prefix>/*"   { capabilities = ["update"] }
# one line per external path, read-only:
path "secret/data/t6-apps/bionic-org/sandbox" { capabilities = ["read"] }
path "secret/data/t6-apps/mcp/config"         { capabilities = ["read"] }
```

No `patch`, `undelete`, `destroy`, metadata `delete` or `list`. Metadata `update` does
let the server lower `max_versions` on its own entries (owner decision 7.3).

## Verification

- Unit: `server/src/__tests__/vault-provider.test.ts` (fake KV v2 with check-and-set;
  HTTP gateway auth with stubbed fetch).
- Integration against a real Vault: `scripts/test-vault-provider-integration.sh`
  (starts `hashicorp/vault:1.21.2`, installs the policy above, mints a token with only
  that policy). Needs a Docker host whose published ports are reachable — run it in
  the gpu build sandbox, not the devcontainer. A planted over-broad policy makes the
  scope test fail.

## Known limits (later phases)

- No remote listing/import for Vault yet (listing field names would require reading
  values); link external refs by typing `path#field`.
- Which provider a new secret uses still follows the caller and the deployment
  default (`PAPERCLIP_SECRETS_PROVIDER`); a company-level default and routing of the
  sites that hard-code `local_encrypted` arrive in PR-B.
- `token_file` mode re-reads the file on a 403, so a rotating Vault Agent sink works.
- Routine webhook secrets and the legacy OAuth backfill call providers directly and
  cannot target Vault until PR-B routes them through the secrets service.
