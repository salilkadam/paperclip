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
  token per failing call; concurrent callers share the one re-login). Consequence: a
  second revocation within 30 s of the first gives up to 30 s of `access_denied`
  before the server re-authenticates. The projected
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
  page's 60 s poll does not write to Vault on every tick. `details.probedAt` records
  when Vault was actually probed; a revoked role can show healthy for up to 5 minutes.
- **Errors** map to typed codes: 400 cas → `conflict`, 400 → `invalid_request`,
  403 → `access_denied`, 404 / deleted / pruned → `not_found`, 429 → `throttled`,
  unreachable / sealed / 5xx gateway → `provider_unavailable`, else `provider_error`.
  A missing value is never returned as an empty string.

## Company default provider

Each company can mark one `ready`/`warning` provider vault as its **company default**
(Secrets → Provider vaults → *Make company default*). New secrets that don't name a
provider are stored there. That covers the create dialog's starting selection,
connection and OAuth credentials, AI connections, chat and email channels, adapter
config secrets, routine webhook secrets, the Claude Code login, imports and the CLI.
Without a company default, new secrets use the deployment provider
(`PAPERCLIP_SECRETS_PROVIDER`, default `local_encrypted`). This includes the
credential flows that used to force local storage. A request that names a provider
family but no vault uses that family's default vault if one exists.

- Changing the default affects **new** secrets only. Moving existing ones is a
  separate migration (PR-C).
- Each secret version records the provider and provider vault it was written to and
  resolves through them. A pinned old version keeps working after its secret moves.
- Deleting a secret deletes in every provider its versions live in.
- Deleting a secret whose versions live in a disabled or removed vault leaves the
  provider-side value in place and logs a warning (Paperclip can no longer reach it).
- Disabling the company-default vault clears the default. New secrets then fall back
  to the deployment provider; the Provider vaults tab shows which default applies.
- API: `POST /api/secret-provider-configs/:id/company-default`,
  `DELETE /api/companies/:companyId/secret-provider-configs/company-default`. Both are
  recorded in the activity log.

## Moving existing secrets between providers

```
paperclip secrets migrate-provider --company-id <id> --dry-run            # to the company default
paperclip secrets migrate-provider --company-id <id> --to-vault <configId>
paperclip secrets migrate-provider --company-id <id> --to-provider local_encrypted   # rollback
paperclip secrets migrate-provider --company-id <id> --secret <id> [--secret <id>]   # a subset
```

(API: `POST /api/companies/:companyId/secrets/migrate-provider` with `targetProviderConfigId`,
`targetProvider`, `dryRun`, `secretIds`. Requires an instance admin who also has access
to that company.)

For each active, Paperclip-managed secret (company, user and instance scope; user
values first, the most-rotated last):

1. Read the current version through the provider it lives in, and check that its value
   hashes to the version's recorded `value_sha256`.
2. **Dry run stops here.** Nothing is written.
3. Write the value to the target as the next version. If the secret was stored in the
   target before (e.g. after a rollback), add a version to that entry instead of
   creating a new one.
4. Read the value back from the target and compare digests.
5. Commit in one transaction:
   `UPDATE company_secrets SET latest_version=N+1, provider=…, provider_config_id=… WHERE id=? AND latest_version=N`,
   plus the version insert. If anything rotated the secret meanwhile (including an OAuth
   refresh in another process), the UPDATE matches nothing: the target write is removed
   and that secret reports a 409 conflict. Re-run to pick it up.
6. A user-secret definition moves to the target once all its **active** values have
   moved, so new values for that definition follow. A full company run (no `--secret`)
   also moves definitions that have no values yet. Each definition gets its own result
   row (`kind: "definition"`).

**Re-running after a failure.** A failed attempt archives the version it wrote.
- **HashiCorp Vault.** The KV version is soft-deleted and the entry kept. Vault paths
  end in the secret's id, so a re-run safely adds a version to that leftover entry. If
  an operator removed an entry that rows still point at, it is re-created.
- **AWS Secrets Manager.** Entry names come from the secret's key, which other secrets
  can share (instance-scoped plugin secrets, company vs instance scope). So a
  migration never writes into an existing AWS entry it did not create in this
  attempt: a collision fails with `secret_migration_target_entry_exists`.
  - A failed *first* write to AWS can leave the created entry with its value
    (archiving only removes Paperclip's pending label). A re-run then reports that
    code. Remove the entry in AWS, then re-run.
  - On AWS, only the current and the latest pending version stay readable. Older
    pinned versions are not kept there (pre-existing; this deployment uses Vault).

**Limits.**
- The source vault must be usable. Re-enable a disabled vault before migrating away
  from it, and disable it afterwards.
- A company run is a single HTTP request. Behind a proxy with a short timeout, the CLI
  can report an error while the server finishes the run. Re-running is safe (secrets
  already moved report `already_on_target`), or split the work with `--secret`.

Older versions stay where they were written and keep resolving there (on Vault and
local storage; see the AWS note above). External
references are refused: Paperclip does not own those values. Each read is an access
event (`consumer_type = secret_migration`), and each migration is in the activity log.
The output gives a status per secret (`migrated`, `already_on_target`, `dry_run`,
`failed` with a code). The CLI exits 1 if any secret failed.

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

### Rolling it out on the bionic-org cluster

1. `VAULT_TOKEN_FILE=<0600 admin token file> deploy/scripts/setup-vault-paperclip-provider.sh`
   writes policy `paperclip-secrets` and role `bionic-org`. The role is bound to
   `bionicorg/bionic-org-sa`, audience `vault`, TTL 1 h, max 24 h.
2. `deploy/scripts/probe-paperclip-vault-provider.sh` logs in as that role and checks
   every needed capability, and that the master-key entry, other apps and destroy are
   denied. It must exit 0. Its local gate is
   `deploy/scripts/test-vault-paperclip-provider-local.sh`: a planted over-broad
   policy or a missing metadata `create` must fail it.
3. Helm: `secretsVault.enabled=true` (values.yaml `secretsVault`). This sets the
   `PAPERCLIP_SECRETS_VAULT_*` env and projects an audience-`vault` token at
   `/var/run/secrets/vault/token`.
4. Create a `vault` provider vault per company, check its health, and make it the
   company default.
5. `paperclip secrets migrate-provider --company-id <id> --dry-run`, then without
   `--dry-run`.

**Exposure note.** Local agents run in the server's pod under the same uid. They can
read the projected token and so act as the server's Vault role. They can already
read the server's environment (including the local master key), so this adds no
new class of access. The fix is agent-process isolation (plan §6), not this
provider.

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
