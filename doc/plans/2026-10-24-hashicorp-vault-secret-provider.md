# HashiCorp Vault Secret Provider — Plan

Status: **revision 4 — owner decisions recorded 2026-10-24 (§7); decision 7.1 needs one clarification** · reviews §10 · 2026-10-24 · branch `docs/hashicorp-vault-provider-plan`

## 1. Goal

1. Make HashiCorp Vault a first-class Paperclip secret provider, built like the AWS
   Secrets Manager provider (`server/src/secrets/aws-secrets-manager-provider.ts`),
   replacing the stub in `server/src/secrets/external-stub-providers.ts`.
2. Make Paperclip *consistently* write persisted secrets to the provider the company
   selected, instead of the many call sites that hard-code `local_encrypted` today.
3. Move the secrets currently stored in Postgres (`local_encrypted`) into Vault under
   `secret/t6-apps/bionic-org/…`, in a hierarchy that mirrors Paperclip's scopes.
4. Replace the copy-from-Vault scripts (`sync-brev-sandbox-key.sh`,
   `setup-ghost-connections.sh`) with secrets that link to Vault paths and are read
   at run time.

Exit condition: every live `company_secrets` row on the production instance has a
current version on the `vault` provider (or is a listed exception, §7), production
runs from a clean `main` image, and the checks in §9 pass on the live instance.

**What this plan does not claim.** Moving to Vault does **not** narrow who can read
secrets inside the app pod (§6). It gives a central custody point, a single audit
trail, rotation in one place, and the end of the copy scripts. Isolating agents from
the server is a separate piece of work.

## 2. Facts this plan rests on (verified 2026-10-24)

### Code (fork `main` @ `465dad279`)

- **Upstream design.** Upstream (paperclipai, PR #5429/#6381, May 2026) designed
  **provider vaults**: named, company-scoped, *non-secret* routing config per
  provider family. Only `local_encrypted` and `aws_secrets_manager` are real.
  `vault` and `gcp_secret_manager` are stubs locked to `coming_soon`:
  - shared validator: `packages/shared/src/validators/secret.ts:338`
  - server: `secrets.ts:102-105, 842, 1318, 3686`
  - UI: `Secrets.tsx:212, 2997-3000, 3038-3043, 3574-3612`;
    `ImportFromVaultDialog.tsx:78-100`

  Upstream `master` also has no Vault provider.
- **Credential custody rule (upstream).** A provider vault row holds routing
  metadata only. Credentials for the backend come from the deployment.
- **How the AWS template works:**
  - The endpoint comes from env. The per-vault config supplies only region,
    namespace and prefix (`readProviderVaultConfig` 282-324).
  - Managed names are `prefix/deploymentId/companyId/secretKey`. A guard keeps
    external refs out of the managed namespace (485-509), and a drift check
    validates stored managed refs (511-531).
  - Managed material carries its own `secretId`/`versionId`; resolution uses the
    material, not the parent row.
  - Typed `SecretProviderClientError` mapping (840-870), 30 s timeout, injectable
    gateway for tests.
- **No cross-provider migration exists.** `company_secrets.provider` is immutable.
  `assertSelectableProviderConfig` requires `config.provider === secret.provider`
  (`secrets.ts:965-979`). `rotate()` keeps the provider. PATCH rejects a
  `providerConfigId` change for managed secrets.
- **Pinned old versions resolve through the parent's *current* provider and
  config** (`secrets.ts:1379-1400`).
- **There is no "company default provider" concept.** `isDefault` is unique per
  **(company, provider family)** (`company_secret_provider_configs.ts:29-31`), and
  only the UI applies it (`Secrets.tsx:538-563`). The server never reads it. Routes
  always fill `provider: req.body.provider ?? PAPERCLIP_SECRETS_PROVIDER`
  (`routes/secrets.ts:117, 622, 896`), so "unspecified" never reaches the service.
  The same applies at `routes/environments.ts:1037, 1197` and
  `company-portability.ts:3561`.
- **User-scoped values take their provider from `user_secret_definitions.provider`**
  (`schema/user_secret_definitions.ts:16`; `secrets.ts:3020-3027`). The Claude Code
  OAuth definition is hard-coded local (`secrets.ts:121-128`), and
  `isCompatibleClaudeOAuthDefinition` requires `provider === "local_encrypted"`
  (`secrets.ts:3163-3171`).
- **Hard-coded `local_encrypted` storage sites** (will not follow any default):
  - connection credentials (`connection-credentials.ts:76`)
  - tool OAuth client secret (`tool-access.ts:12459`)
  - AI connections (`ai-connections.ts:556, 573`)
  - chat channels (`chat-channels.ts:6554`)
  - email channels / AgentMail (`email-channels.ts:258`, `email-connections.ts:170`)
  - inline adapter-config secrets (`createManagedLocalSecret`, `secrets.ts:~2086-2104`)
  - Codex home (`routes/agents.ts:939`)
  - Claude OAuth definition (above)
  - legacy tool OAuth backfill (`tool-oauth-legacy-backfill.ts:174-202`, direct
    inserts)
  - routine webhook secrets (`routines.ts:1586-1650`, direct inserts)
  - proposal approval fallback (`secret-proposals.ts:586`)
  - `scripts/migrate-inline-env-secrets.ts:77`
  - `cli/src/commands/client/secrets.ts:326`
- **Encryption-primitive uses** (material lives outside `company_secret_versions`)
  stay local by design:
  - run redaction (`run-secret-redaction.ts:60`)
  - Teams file-consent (`chat-teams-file-consent.ts:108`)
  - proposal staging (`secret-proposals.ts:333, 574`)
  - **Consequence:** the master key cannot be retired.
- **Locking.** `rotate` has **no per-secret lock**. It is serialised by a
  company-wide *filesystem* lock (`codex-auth-cache.ts:340`) plus an **optional**
  `expectedLatestVersion` CAS. The OAuth refresh at `tool-gateway.ts:3764-3770`
  calls `rotate` without CAS. A separate CLI process does not share the filesystem
  lock.
- **Deletion.** `removeSecret` calls `deleteOrArchive` once, with the *latest*
  version's material.
- `company_secret_versions.value_sha256` holds `sha256(plaintext)` for managed local
  material (`local-encrypted-provider.ts:98-106`). It holds a ref fingerprint for
  external refs.
- **Scopes on `main`:** `company` and `user`. Upstream added `scope=instance` with
  `owner_agent_id`/`owner_plugin_id` (da9af6741). Fork `main` is **847 commits
  behind** `origin/master` (the upstream mirror; `git rev-list --count
  origin/main..origin/master`). Upstream also reworked `secrets.ts`.
- **Agent environment.** Local agents run as child processes in the server's
  container, under the same uid (no `securityContext`), with the SA token
  automounted.
  - The main agent spawn strips only `PAPERCLIP_*` (`server-utils.ts:3512`).
  - **Adapter preflight/install subprocesses get the unstripped `process.env`**
    (`claude-local/src/server/execute.ts:309`). The same `{...process.env}` pattern
    is in the codex, cursor, gemini, grok, kimi, opencode and pi adapters.
  - `VAULT_TOKEN`, `DATABASE_URL`, `KEYCLOAK_CLIENT_SECRET` and `MINIO_ROOT_*` reach
    local agents.
  - The app never reads `VAULT_TOKEN`.

### Live infrastructure (read-only probes, 2026-10-24)

- Vault 1.21.2, single replica, **file storage** on PVC `data-vault-0` (ceph-rbd).
  It is unsealed by a CronJob running **every minute**. KV v2 is mounted at
  `secret/` with mount `max_versions=0` (Vault keeps 10).
- Auth methods: `kubernetes/`, `jwt/`, `token/`. **There is no
  `auth/kubernetes/role/bionic-org`**, although the chart sets
  `VAULT_K8S_ROLE=bionic-org`. The precedent is the `bionic-platform` role (SA-bound,
  1 h / 24 h).
- App pod: SA `bionic-org-sa`, namespace `bionicorg`, `replicaCount: 1`.
- `secret/t6-apps/bionic-org/` contains `config` (ESO bootstrap), `logins`,
  `sandbox`.
- **Production inventory:** **37** live secrets, all `local_encrypted` /
  `paperclip_managed` / active.
  - **33** have `scope=company` and **4** have `scope=user`, across 2 companies
    (21 / 16).
  - **887** versions; the maximum `latest_version` is **211**.
  - Bindings: 12 plugin, 11 tool_connection, 2 agent, 1 environment.
  - **0** provider vault rows.
  - The per-secret listing is Phase 0.2 (further production reads were blocked by
    the permission check).

## 3. Target design

### 3.1 Vault path hierarchy

All paths are in KV v2 mount `secret`. Paperclip writes only under
`t6-apps/bionic-org/paperclip/`.

```
secret/t6-apps/bionic-org/
  config                      existing — ESO bootstrap. UNCHANGED (vault_token key removed, §3.6).
  sandbox                     existing — operator-owned Brev key material. Paperclip: read-only (external ref).
  logins                      existing — not touched, not readable by Paperclip.
  external/                   NEW, operator-owned — values operators place for Paperclip to link. Paperclip: read-only.
  paperclip/                  NEW — Paperclip-managed namespace (the "deployment prefix")
    companies/<companyId>/
      company/<secretId>        scope=company
      users/<ownerUserId>/<secretId>   scope=user (opaque auth id)
secret/t6-apps/mcp/config       existing — MCP config incl. apikey_ghost_<site>_key. Paperclip: read-only (decision 7.4).
```

- **The path follows the ownership scope, not the bindings.** A company secret bound
  to an agent stays under `company/`. Agent- or plugin-owned secrets arrive with
  upstream's `instance` scope. When they do, they take
  `companies/<c>/agents/<agentId>/…` and `…/plugins/<pluginId>/…`. That is a note,
  not something built now.
- **The leaf is the secret's UUID** (decision 7.2). Nothing descriptive is written to
  Vault, so there is no `custom_metadata`. Names live in the Paperclip DB, looked up
  by UUID.
- Each KV entry holds one field, `value`. **Paperclip version N maps to one KV
  version.** The KV version number is stored in the material (and in
  `providerVersionRef`) and resolved with `?version=N`.
- **Material is self-describing**:
  `{scheme:"vault_kv2_v1", mount, path, kvVersion, source}`. `resolveVersion` uses
  only the material, never `secret.external_ref`, so versions keep resolving after
  the parent moves provider.

### 3.2 Authentication (deployment-owned)

- **Deployment env:**
  - `PAPERCLIP_SECRETS_VAULT_ADDR`
  - `…_AUTH_METHOD`: `kubernetes` | `token_file`
  - `…_K8S_ROLE`
  - `…_K8S_MOUNT` (default `kubernetes`)
  - `…_K8S_JWT_PATH` (default
    `/var/run/secrets/kubernetes.io/serviceaccount/token`)
  - `…_TOKEN_FILE` (development only)
  - `…_NAMESPACE`
  - `…_MOUNT` (default `secret`)
  - `…_PREFIX` (here `t6-apps/bionic-org/paperclip`)
  - `…_CACERT`
  - `…_TIMEOUT_MS` (default 30 000)
- **The JWT file is re-read on every login.** The kubelet rotates projected tokens at
  80 % of their TTL or after 24 h, and the application is expected to reload them.
- **Vault token.** The token is held in memory and renewed at about 2/3 of its TTL.
  A 403 triggers one re-login, then fails with `access_denied`. Concurrent logins are
  de-duplicated.
  - Role TTL 1 h, max 24 h.
  - The server calls `auth/token/revoke-self` on SIGTERM. On a suspected leak, an
    operator revokes the token by its accessor. (Round 1 assumed Kubernetes-auth
    tokens are unrevocable; round 2 showed that misread the Vault docs.) PR-A checks
    that the live `default` policy grants `revoke-self`.
- **Per-vault config cannot change where or under what path Paperclip connects.**
  `address`, `mountPath` and `secretPathPrefix` in a vault provider row are
  **rejected** on save. The address, mount and prefix come from env only, like the
  AWS endpoint. Only `namespace` remains, as a label. No SSRF allowlist and no prefix
  validation are needed.

### 3.3 Vault policy and role (new, additive script)

`deploy/scripts/setup-vault-paperclip-provider.sh` is idempotent and touches no other
role or policy:

- **Role** `auth/kubernetes/role/bionic-org`: SA `bionic-org-sa`, namespace
  `bionicorg`, TTL 1 h, max 24 h, policy `paperclip-secrets`.
- **Policy** `paperclip-secrets`:
  - `secret/data/t6-apps/bionic-org/paperclip/*`: create, read, update
  - `secret/metadata/t6-apps/bionic-org/paperclip/*`: **create**, read, update. Only to
    set `max_versions` (decision 7.3). `create` is required: setting `max_versions` on a
    new entry is a metadata create. Found by the PR-A integration test against Vault
    1.21.2 on 2026-10-25; `read, update` alone is denied on the first write.
  - `secret/delete/t6-apps/bionic-org/paperclip/*`: update (soft delete)
  - `secret/data/t6-apps/bionic-org/sandbox`,
    `secret/data/t6-apps/bionic-org/external/*` and `secret/data/t6-apps/mcp/config`:
    read. Paperclip reads the whole of `mcp/config`, which also holds the gworkspace
    tenant OAuth JSON (owner decision 7.4, accepted risk in §6).
  - `secret/metadata/t6-apps/bionic-org/external/*`: read, list. Only for remote
    import preview.
  - **No** `patch`, `undelete`, `destroy`, metadata `delete`, or `list` on
    `paperclip/*`.
- **On erasure (honest version).** Metadata `update` lets Paperclip lower
  `max_versions` on its own entries, and Vault then permanently deletes older
  versions. So Paperclip *can* shrink the history of its own subtree. It cannot touch
  anything outside it. The alternative is a dedicated mount (decision 7.3).
- **Probe script.** It must show:
  - in-scope create/read succeed
  - writes to `config`, `t6-apps/mcp/config` and `logins` are denied, while a read of
    `t6-apps/mcp/config` succeeds
  - `destroy` is denied
  - reads of `logins` are denied

  It must also **fail** when run against a planted over-broad policy (CLAUDE.md
  rule 6).

### 3.4 Provider module `server/src/secrets/vault-provider.ts`

Built like the AWS provider: injectable gateway, `fetch` + `AbortSignal.timeout`,
no SDK.

| Method | Behaviour |
|---|---|
| `descriptor` | managed + external refs. `supportsExternalValueWrites: false` (external paths are read-only). `configured` = env readiness. |
| `validateConfig` / `healthCheck` | Login. Create a canary at `<prefix>/_health/<instance>` the same way as a real secret (metadata first), then read back both its data and its `max_versions`. Check the mount is KV v2. `ok`/`warn` with missing-env guidance. |
| `createSecret` | **Metadata first** (`max_versions`, proposed 100), then data with `cas=0`. If the second call fails, the entry exists with no versions, and the retry is idempotent. `valueSha256 = sha256(plaintext)` for managed material, as AWS managed does (aws:1126,1143), so the agreement check works in both directions. |
| `createVersion` | Data write with `cas=<kvVersion from latest version's material>`. On a cas 400, read metadata `current_version` and fail as `conflict` (the caller retries via `rotate`). Drift check: the material path must equal the derived path. |
| `linkExternalSecret` | Ref `<path>#<field>` under `sandbox`, `external/` or `t6-apps/mcp/config`. Rejected inside the managed prefix. Metadata only. |
| `updateExternalSecretValue` | Not supported (the descriptor says so). |
| `listRemoteSecrets` | KV `LIST` under `external/` (+ `sandbox`). Names only; values are never read. |
| `discoverProviderConfigs` | Not implemented (no AWS-style discovery is needed: there is one deployment prefix). |
| `resolveVersion` | Managed: `GET data/<material.path>?version=<material.kvVersion>`. External: latest, then `field`. A soft-deleted or pruned version gives typed `not_found`, never an empty string (verified against a real `vault server -dev` in tests). |
| `deleteOrArchive` | `archive`: soft-delete that KV version. `delete`: soft-delete all versions. No destroy; an operator purges after a retention period. |
| Errors | 400 cas→conflict, other 400→invalid_request, 403→access_denied (after one re-login), 404→not_found, 429→throttled, 503/sealed/network→provider_unavailable, else provider_error. Raw Vault messages go to `rawMessage` only. |

### 3.5 Server changes that make use "consistent"

1. **Company default provider.**
   - Add `companies.default_secret_provider_config_id`: nullable FK, which must point
     at a `ready`/`warning` vault of that company.
   - The service resolves `resolveWriteTarget(companyId, {providerConfigId?, provider?})`
     in this order: explicit `providerConfigId` → explicit `provider` → company
     default → deployment `PAPERCLIP_SECRETS_PROVIDER`.
   - Routes stop filling `provider` when the caller did not choose one
     (`routes/secrets.ts:117, 622, 896`, `routes/environments.ts`,
     `company-portability.ts`).
   - **A bare `provider` with no `providerConfigId` no longer picks the storage
     backend** (round 2, R2-1). The UI create form (`Secrets.tsx:708, 1099`) and the
     CLI (`cli/src/commands/client/secrets.ts:326`) always send a provider. Rule:
     - Payload family = the company default's family → use the company default.
     - Otherwise → that family's `isDefault` vault.
     - Otherwise → for `local_encrypted`, the deployment provider; for any other
       family, 422.
   - The UI create form starts with the company default selected, and leaves
     `provider` out of the payload unless the user changes it.
   - UI: a "Company default" selector on the Provider vaults tab.
   - The existing per-family `isDefault` stays, meaning "default vault *within* a
     family".
2. **All storage sites go through `resolveWriteTarget`.** That covers every site in
   §2's list, plus:
   - `connection-credentials.ts:89`, which inserts a user-secret definition
     directly.
   - The legacy backfill, which moves onto `secretService`.
   - **Routine webhook secrets** (`routines.ts:1589-1656`). These are inserted
     inside the routine-creation transaction, and today pass no `providerConfig` to
     the provider. They keep that transaction: the service gains a
     `createInTransaction(executor, …)` variant. The external Vault write happens
     before the transaction, and is archived if the transaction rolls back (the
     pattern `rotateUnlocked` already uses for lost writes).
   - New user-secret definitions take the company default.
3. **Claude OAuth definition** (decision 7.5). Recommended option (a) needs **two**
   changes:
   - Drop `provider` from `isCompatibleClaudeOAuthDefinition` (`secrets.ts:3167`).
   - Route `ensureClaudeOAuthUserSecretDefinitionInternal`'s insert
     (`secrets.ts:3233-3234`) through `resolveWriteTarget`.

   An incompatible definition makes `readClaudeOAuthUserSecretStatusInternal` return
   null, and `agents.ts:629-636` / `routes/agents.ts:3726, 6632` fail closed. So
   **PR-B must be deployed before any user secret is migrated** (phase 6 ordering).
   Under option (b), `migrateProvider` **refuses** any secret whose definition key
   is `CLAUDE_CODE_OAUTH_TOKEN`.
4. **Each version records its provider.**
   - Add nullable `provider` and `provider_config_id` to `company_secret_versions`,
     backfilled from the parent.
   - Resolution uses the version's own provider and config. That includes the
     `getSelectableRuntimeProviderConfig` call at `secrets.ts:1395-1401`, which
     today passes the parent's provider. Material is self-describing (§3.1).
   - `environment-runtime.ts:950` reports the version's provider, not the
     parent's.
   - No other reader is affected. Portability does not export versions, remote
     import keys on the parent, and there is no version-history route or UI
     (round 2, R2-5).
   - `removeSecret` fans `deleteOrArchive` out across every distinct
     (provider, config) among the secret's versions, so a vault→local rollback does
     not orphan Vault entries.
5. **Cross-provider migration**, `secretService.migrateProvider(secretId, targetProviderConfigId, {dryRun})`.
   **The guarantee is the database CAS, not the lock** (round 2, R2-3):
   - Body `migrateProviderUnlocked`, modelled on `rotateUnlocked`. It must *not*
     call `rotate`, because `rotate` always writes through the parent's provider,
     and the company lock is a non-reentrant mkdir lock with a 30 s deadline. It is
     wrapped once in `withAccountHomeSecretMutationLock`. The CLI calls an
     instance-admin route, so the migration always runs in the server process.
   - The commit is **one statement**:
     `UPDATE company_secrets SET latest_version=N+1, provider=<target>, provider_config_id=<target> WHERE id=? AND latest_version=N`,
     in the same transaction as the version insert and status flip.
   - If an unguarded OAuth refresh landed first, the UPDATE matches 0 rows. The
     migration then archives its Vault write and returns 409; the caller retries.
   - A mutant that splits the UPDATE into two statements must fail a test.
   - Refuses `external_reference` and non-active secrets.
   - Resolves current version N.
   - Writes through the target.
   - **Reads back from the target and compares sha256 with version N's
     `value_sha256`.** This is valid: for managed local material it is
     `sha256(plaintext)`.
   - Commits as above. When migrating a user secret, it also updates the
     user-secret definition row.
   - Writes an access event and an activity log entry. Idempotent.
   - The reverse direction is the rollback path.
6. **Unlock `vault`.** Remove `vault` from every coming-soon site in §2 (GCP stays
   locked). Import eligibility becomes "provider implements `listRemoteSecrets`".
   Generalise `safeRemoteProviderErrorDetails` and `sanitizeRemoteProviderMetadata`.
7. **Read cache.**
   - **Placement:** the cache wraps only the `provider.resolveVersion` call. It sits
     *after* the binding assertion and every status check at `secrets.ts:1383-1393`
     (secret deleted/inactive, version disabled/destroyed/`revokedAt`). A revoked
     version or a disabled secret is refused before the cache is consulted.
   - What is cached: **managed** entries only, keyed by
     `(secretId, version, providerConfigId)`. External refs are never cached: they
     resolve "latest" and change.
   - Bounded LRU, entries live for 15 minutes.
   - It is evicted on delete, archive, rotate, revoke and disable.
   - **Stale-on-error window:** if Vault is `provider_unavailable`, an entry may be
     served up to **10 minutes** past its expiry. Every such use writes an access
     event with the new `outcome='stale_served'`. After that the read fails with
     `provider_unavailable`. It is never an empty value.
   - Test: warm the cache, revoke the version, and the next resolve fails.
   - Decision 7.6.

**As built in PR-B (2026-10-25), deviations from the text above:**
- The company default is a flag, `company_secret_provider_configs.is_company_default`,
  with a partial unique index (one per company), not a `companies` column. A
  `companies` FK would make the two tables reference each other. The flag also
  clears itself when its vault is deleted, and is cleared when the vault is
  disabled or set back to coming soon.
- An explicit non-local family with no vault of that family keeps today's behaviour:
  it uses the deployment's env configuration for that provider, instead of 422. AWS
  deployments configured only through env would otherwise break. The UI no longer
  sends a bare family: the create dialog starts on the company default vault and
  sends its id.
- **Behaviour changes for deployments that never set a company default** (review
  F2, accepted as intended):
  - Every site that hard-coded `local_encrypted` now uses the deployment provider
    (`PAPERCLIP_SECRETS_PROVIDER`). This is identical when that is `local_encrypted`,
    as in production.
  - A request that names a family but no vault now lands in that family's
    `isDefault` vault. Before, it used env configuration even when such a vault
    existed.
- **Backfill caveat** (review F1): `provider_config_id` is copied from the parent's
  *current* vault. A secret rotated across two vaults of one provider before 0375
  keeps the pre-existing behaviour of resolving old versions through the current
  vault. Production had 0 provider vault rows (§2), so no row is affected.
- The legacy OAuth backfill shares the routines limit (review F4): the provider write
  happens before its per-connection transaction commits. A rolled-back connection
  leaves an unreferenced provider entry under the company's own path. It is a
  one-off job.
- Routine webhook secrets did not get a `createInTransaction` variant. They resolve
  the company default, pick the secret id up front (Vault derives the path from it),
  write to the provider, then insert in the existing transaction, and remove the
  provider write if that insert fails. **Known limit:** when a caller passes its own
  transaction (`executor`) and rolls it back *after* `createWebhookSecret` returns,
  the provider-side value is orphaned. Under Vault that is an unreferenced entry
  under the company's own path; under `local_encrypted` nothing is left behind.

**As built in PR-C (2026-10-25):**
- `migrateProvider` follows 3.5.5. In addition, `migrateCompanyProvider` (route
  `POST /companies/:companyId/secrets/migrate-provider`, instance admin, CLI
  `secrets migrate-provider`) runs it per secret in the phase-6 order and reports a
  result per secret instead of stopping at the first failure.
- The source value is checked against its recorded `value_sha256` before anything is
  written, as well as on read-back. A tampered or corrupted source is refused.
- A user-secret definition moves only once every live value of it is on the target.
  Moving it with the first value would send other users' new values to the target
  while their existing values were still on the source. That is harmless, but it
  would contradict the definition's meaning.

### 3.6 Deployment changes

- Helm configmap: add the `PAPERCLIP_SECRETS_VAULT_*` variables. Remove `VAULT_ADDR`
  and `VAULT_K8S_ROLE`.
- **Retire the `bionic-org-app` ops token completely**:
  - Unmount `VAULT_TOKEN` (`deployment.yaml:214`).
  - Delete the `vault_token` key from `secret/t6-apps/bionic-org/config`, then
    force an ESO refresh. `externalsecret-app.yaml` uses `dataFrom.extract`, so this
    delete is the real removal; the YAML only needs a comment edit.
  - Stop `setup-vault-secrets.sh:137` from writing `vault_token` back.
  - Revoke the token by accessor, and delete or annotate the orphaned
    `bionic-org-app` policy.
  - Update `deploy/README.md` and `deploy/CHECKLIST.md`.
- **Ops scripts stop using any static token, including `/workspace/.env`** (owner,
  2026-10-24). New helper `deploy/scripts/lib/vault-ops-login.sh`:
  - Mints a 10-minute ServiceAccount JWT (audience `vault`) with
    `kubectl -n vault create token bionic-org-ops --duration=10m`. The SA is an
    identity only and lives in `vault`: in `bionicorg`, `sre-harness-sa` can mint
    tokens and create pods (PR-0 review F2).
  - Exchanges the JWT for a Vault token through the new Kubernetes-auth role
    `bionic-org-ops`: TTL 15 m, max 1 h. Policy `bionic-org-ops`: read `sandbox` and
    `ghost/config`; read/update/patch `mcp/config`. **Not** `bionic-org/config`,
    which holds the master key (PR-0 review F3).
  - Pipes the token into `vault-0` on stdin. It is never written to disk or to argv,
    and it is revoked with `revoke-self` when the script exits.
  - The bootstrap credential is the operator's kubeconfig, which these scripts
    already require. Eight scripts move to the helper: `probe-bionic-vault-token`,
    `switch-tenant-client-1`, `-3`, `-3b`, `sync-brev-sandbox-key`,
    `setup-ghost-connections`, `setup-ghost-plugin`, `test-ghost-connections-local`.
    `setup-vault-secrets.sh` and `setup-vault-jwt.sh` change Vault auth and
    policies, so they stay on an operator-supplied admin token. They read it from
    stdin or `VAULT_TOKEN_FILE`, never from `/workspace/.env`.
  - **Why not `secret/t6-apps/vault/admin_token`** (the owner's offered fallback):
    on 2026-10-24 that token was **expired** (lookup returns `invalid token`;
    created 2026-05-18, 768 h period, never renewed). The path is also readable
    by the instance-wide `eso-reader` role, as well as `bionic-platform`,
    `credential-shape-scan` and `eso-pg-superuser-writer`. A live admin token stored
    there could be pulled by any namespace that can create an ExternalSecret.
    Short-lived Kubernetes-auth tokens remove the need for a stored token.
    Recommendation to the owner: stop storing admin tokens at that path.
- **Adapter env hygiene: dropped (2026-10-24).** Verified on the production pod:
  a process running as uid 1000 (the server's uid, which every local agent shares)
  can read the server's full environment at `/proc/<server-pid>/environ`. `/proc`
  is not mounted with `hidepid`. Such a process can also read the SA token file.
  Stripping keys from child envs therefore removes nothing an agent cannot already
  read. A sweep over `{...process.env}` would also be incomplete: `quota.ts`
  passes `env: process.env`, and the ACP adapters merge the host env. A repo check
  over spread syntax would give false assurance. The real fix is the
  agent-isolation epic (§6).
- `PAPERCLIP_SECRETS_PROVIDER` stays `local_encrypted` as the deployment fallback.
  Vault is chosen per company through `default_secret_provider_config_id`.

## Rollout status (2026-10-25)

| Phase | State |
|---|---|
| 1 PR-A | #13, #14 merged; deployed |
| 2 PR-B | #15 merged; migration 0375 applied (1059 versions backfilled) |
| 3 PR-C | #16 merged (+ #18 CLI `--company-id` fix) |
| 4 PR-D | #17 merged; owner ran `setup-vault-paperclip-provider.sh`; probe exit 0 |
| 5 deploy | Helm rev 63 `edf9430e2` (19:31 UTC). The pod's own Vault login was verified as uid 1000 (health `ok`, canary written, revoke-self `revoked`). A Vault provider vault per company is health `ready` and is the company default. |
| 6 migrate | Dry run: 0 failures. Real run: Bionic AI Solutions 18 secrets + 2 definitions (19:48), Reliora Inc 25 secrets + 3 definitions (20:05). **All 43 active managed secrets on `vault`**; 0 external refs, 0 non-active. |
| 6 checks | Post-move reads through Vault, 0 failures, 0 server error lines: plugin workers 14, tool connections 17 (Bionic AI Solutions 19:48-20:20, Reliora Inc 20:05-20:20). **Not yet observed:** an agent run resolving a secret, the Brev environment probe, an OAuth refresh writing a new Vault version. |
| 7 PR-E | **Brev:** done 2026-10-25. The environment `sshPrivateKey` is the Vault external ref `939ce914…` (`sandbox#brev_ssh_private_key`); probe OK before and after; `sync-brev-sandbox-key.sh` retired. **Ghost:** the connect API gains `credentialSecretIds` (back a credential field with an existing company secret, organization grants only); `setup-ghost-connections.sh` defaults to linking `mcp/config#apikey_ghost_<site>_key` references. The Ghost *plugin* Admin API keys stay copies: their source `t6-apps/ghost/config` is outside the server's Vault policy by design. |
| 8 | Blank superseded local material after the 48 h soak (decision 7.7): not before 2026-10-27 20:05 UTC |

Rollback: `paperclip secrets migrate-provider --company-id <id> --to-provider local_encrypted`,
then `provider-config:clear-company-default`. Old local versions are intact (phase 8 not run).
Pre-deploy dump: `pg-ceph-8:/var/lib/postgresql/data/predeploy-edf9430e2-20261025192943.dump`.

## 4. Phases and delivery units

Every unit goes branch → PR → review → merge into `main`. Images are built from a
clean `main` and tagged with the SHA. `predeploy-check.sh` runs before every deploy.

| Phase | Unit | Contents | Gate |
|---|---|---|---|
| 0 | ops + PR-0 | 0.1 Vault backup **and restore drill**. 0.2 Per-secret inventory (key, scope, binding types, version selectors, rotation rate), run by the operator. 0.3 PR-0: retire the ops token from the pod and Vault, and move ops scripts to short-lived Kubernetes-auth tokens (§3.6). Order: helm upgrade (the pod stops referencing `vault_token`) → run the ops-role setup → probe → delete the Vault key → ESO refresh → revoke the old token. 0.4 Owner decisions §7. | Restore drill reads back a KV entry written before the snapshot. `probe-bionic-vault-token.sh` exits 0, and exits 1 against a planted over-broad policy. After the ESO refresh, `bionic-org-secrets` has no `vault_token`. `vault token lookup -accessor <old>` fails. |
| 1 | PR-A | Vault provider module. Unit tests (fake gateway). **Integration tests against a real `vault server -dev`**: cas conflict, prefix escape, read of a soft-deleted or pruned version, JWT re-read, metadata-first create. Unlock `vault` in shared, server and UI (reject `address`). `doc/SECRETS-VAULT-PROVIDER.md`. | Safety-tier code review round 1. Each integration test fails on a planted defect. |
| 2 | PR-B | Company default provider (schema, routes, UI). `resolveWriteTarget` at every §2 site. Per-version provider + backfill + per-provider delete fan-out. Claude OAuth compatibility (decision 7.5). | Existing secrets suite green. A pinned old version resolves after a provider change. **Real UI on a staging instance with a vault company default**: the plain Create Secret dialog, a connection credential, an AI connection, a chat channel, a routine webhook and a user secret each land on `provider=vault`. A Claude-login hire still works. |
| 3 | PR-C | `migrateProvider` (in-server, CAS, agreement, reverse) + admin route + CLI. | local→vault→local round trip with agreement. Test: a concurrent `rotate` during migration gives 409, not a revert. |
| 4 | PR-D | `setup-vault-paperclip-provider.sh` + probe. Helm env. | Probe passes, and fails on a planted over-broad policy. |
| 5 | deploy | Deploy `main`. Run the Vault setup script. Create one `vault` provider vault per company and check its health is `ready`. Set it as the **company default**. Soak 48 h. | Real UI: create a secret, bind it to an agent, run the agent; the access event has `provider=vault`. |
| 6 | ops | **Precondition: PR-B deployed** (Claude OAuth compatibility). Migrate company by company: dry-run, then migrate. User-scoped and low-churn secrets first, the 211-version credential last. Watch `secret_access_events.error_code`. | DB query shows all on `vault` (minus exceptions). Real runs: agent, plugin, tool connection, Brev environment probe, an OAuth refresh producing a new KV version. |
| 7 | PR-E + ops | Brev key → external ref `t6-apps/bionic-org/sandbox#brev_ssh_private_key`, then retire `sync-brev-sandbox-key.sh`. Ghost connections → external refs `t6-apps/mcp/config#apikey_ghost_<site>_key`, then remove the key push from `setup-ghost-connections.sh`. Update `deploy/README.md`. | A key rotated in Vault reaches the next environment probe with no script run (external refs are uncached). |
| 8 | decision | After soak: blank the `material` of superseded `local_encrypted` versions or keep it. The master key is kept regardless. | Owner. |

**Rollback after phase 5.** Set the company default back to local. Migrate secrets
back with the same command. Pinned versions keep resolving because of the
per-version provider.

## 5. Observability (CLAUDE.md rule 8)

- Provider health is shown per provider vault in the Secrets UI and in
  `/api/health` details. "Sealed or unreachable" is distinguished from "denied" and
  from "missing".
- Every resolution failure records `secret_access_events.error_code`. Stale-cache
  serves are recorded too. SRE harness monitor: any `provider_unavailable` or
  `access_denied` in a 15-minute window raises an alert, and so does any `stale`
  serve.
- Migration prints one result line per secret (`migrated` / `skipped:already` /
  `refused:<reason>` / `failed:<code>`). Totals are queried from the DB, never typed
  by hand.

## 6. Risks, threat model, accepted limits

**Threat model.**
- **Inside the app pod, Vault does not narrow access.** Local agents run in the same
  container under the same uid. They can read the SA token file and
  `/proc/<server-pid>/environ`, so they can log in to Vault as role `bionic-org`. They
  can reach Postgres through `DATABASE_URL`, and through `/proc` the master key.
  Today: master key in env plus ciphertext in Postgres. After: an SA token plus a
  Vault role. Both are readable by the same processes.
- **What Vault does improve:** one custody point outside the database and its
  backups, a Vault audit trail, operator rotation without scripts, and a policy that
  confines Paperclip to its own subtree plus two read-only external paths.
- **What real isolation would take:** a separate uid for agents, an env *allowlist*,
  `hidepid` on `/proc`, or sandbox-only execution. This is a separate epic and is
  **not** delivered here.
  - Disposition: accepted risk, owner = operator, trigger = the first agent that
    runs untrusted third-party code locally, or any claim of isolation.

| Risk | Handling |
|---|---|
| Vault becomes a run-time dependency (single replica; up to ~60 s sealed after a restart). | Managed-entry cache with a bounded stale window, typed failure, alert. HA Vault is a separate infra item. |
| Vault data loss (file storage, single PVC). | The Phase 0 restore drill is a hard precondition for phase 5. Superseded local versions stay until phase 8. |
| Paperclip can shrink history in its own subtree (metadata `update`). | Decision 7.3. Confined to `paperclip/*`. |
| `value_sha256` (sha256 of plaintext) stays in Postgres, indexed. Low-entropy values can be guessed offline. | Not changed by this plan. Named here; a follow-up can null it for vault-backed versions once agreement checks no longer need it. |
| Fork is 847 commits behind upstream, which reworked `secrets.ts`. | Decision 7.1. |
| Paperclip (and so, per the threat model, any local agent) can read all of `t6-apps/mcp/config`, including the gworkspace tenant OAuth client JSON. | **Accepted by owner 2026-10-24** (decision 7.4). Trigger to revisit: the agent-isolation epic, or a new high-value key added to `mcp/config`. |
| High-churn credential vs `max_versions`. | Metadata-first create with 100 versions; the health check verifies it. Bindings default to `latest`. Phase 0.2 checks for pinned numeric selectors. |
| A Vault login token outlives a crashed pod. | TTL 1 h. `revoke-self` on SIGTERM. Revoke by accessor on suspected leak. |

## 7. Owner decisions (recorded 2026-10-24)

| # | Decision | Owner's choice |
|---|---|---|
| 7.1 | Upstream sync first? | "Follow the recommendation." The recommendation is conditional: sync first *if* an upstream sync is planned. Git history shows the fork split from upstream on 2026-09-30 (merge-base `c8f874311`) and has never merged it back. Upstream has added 847 commits since (tip 2026-10-22). **Clarification requested:** is an upstream sync planned? PR-0 does not depend on the answer. |
| 7.2 | Vault leaf | Secret UUID. |
| 7.3 | History control | Stay at `secret/t6-apps/bionic-org/paperclip`; Paperclip may set `max_versions` on its own entries. |
| 7.4 | Ghost keys | **Paperclip reads all of `t6-apps/mcp/config`** (not the recommended copy). Policy in §3.3, risk in §6. |
| 7.5 | Claude OAuth user secrets | Follow the company default (two-site change, §3.5.3). |
| 7.6 | Read cache | 15-minute TTL, served stale up to 10 minutes while Vault is unavailable. |
| 7.7 | Phase 8 | **Blank** superseded `local_encrypted` material after the soak period. The master key is kept for the encryption-primitive uses (§2). |
| 7.8 | Root token in `/workspace/.env` | Remove the dependency on `/workspace/.env`; `t6-apps/vault/admin_token:token` "if needed". Implemented as short-lived Kubernetes-auth ops tokens; no stored token is needed (§3.6). |

## 8. Out of scope

GCP provider, HA Vault, agent-process isolation (§6), the ESO bootstrap secrets in
`config` (needed before the app can reach Vault or the DB), upstreaming the provider
(it is written upstream-shaped so it can be offered later).

## 9. Definition of done

- PR-0 and PR-A..E merged into `main`. The production image is the `main` SHA
  (`git branch --contains`).
- On the live instance:
  - Both companies have a `ready` vault set as company default.
  - `select provider, count(*) from company_secrets where deleted_at is null group by 1`
    shows only `vault` plus the listed exceptions.
- Real end-to-end runs show `provider=vault` in their access events: an agent run, a
  plugin secret, a tool connection, the Brev environment probe, and an OAuth refresh.
- Fault drill in a maintenance window: seal Vault. Cached managed resolutions succeed
  and are marked `stale`. Uncached ones fail as `provider_unavailable`. The alert
  fires. Unseal and recovery are confirmed.
- The old ops token is revoked, and `VAULT_TOKEN` is absent from the pod.
- Different-model reviews recorded for this plan (§10) and for each safety-tier PR.

## 10. Review record

**Round 1 — plan safety review**, 2026-10-24, reviewer `thirteenth-man` (Claude
Fable 5.1; the author is Claude Opus 5.5).
- Verdict: *partly confirmed*. Phase 0 and PR-A may start. PR-B was blocked on
  B1, B2 and A2.
- The author re-verified every finding marked "fixed" or "accepted" against the
  source before revising.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| A1 | major | Adapter preflight/install subprocesses get the unstripped `process.env` (claude-local:309; same pattern in 8 adapters). Env stripping is not isolation. | §6 rewritten. Hygiene part **rejected 2026-10-24** with evidence: uid 1000 can read `/proc/<server-pid>/environ` on the production pod, so stripping protects nothing (§3.6). |
| A2 | major | No per-secret lock; OAuth refresh rotates without CAS; a CLI process does not share the FS lock. | **Fixed:** migration in-server, `expectedLatestVersion` CAS, 409-on-race test (§3.5.5, PR-C gate). |
| A3 | major | Metadata `update` lets Paperclip erase versions via `max_versions`. | **Accepted, owner decision 7.3:** documented in §3.3; dedicated mount offered. |
| A4 | minor | Hard-coded site list incomplete. | **Fixed:** §2 list extended (proposals:586, script, CLI, route defaults). |
| A5 | minor | Unmounting `VAULT_TOKEN` is not enough. | **Fixed:** revoke + remove from config/ESO (§3.6). |
| A6 | — | Core claims confirmed. | — |
| A7 | — | "847 behind" and live facts not checkable by the reviewer. | **Verified by author:** `rev-list` against `origin/master`; live probes in §2. |
| B1 | blocker | No company-level default provider; per-family `isDefault`; routes always fill `provider`. | **Fixed:** `companies.default_secret_provider_config_id` + resolver + routes stop filling (§3.5.1). |
| B2 | blocker | User secrets take their provider from the definition; the Claude OAuth check requires local. | **Fixed + decision 7.5:** definition updated by migration; compatibility change recommended. |
| B3 | major | SA JWT must be re-read (kubelet rotation). | **Fixed:** §3.2, integration test. |
| B4 | major | k8s-auth tokens cannot be revoked before TTL. | **Accepted:** TTL 1 h, documented (§3.2, §6). Owner: operator; trigger: suspected token leak. |
| B5 | major | Metadata must be written before data, or the entry is pruned at 10. | **Fixed:** §3.4 + health-check verification. |
| B6 | minor | Migration must refuse external refs and non-active secrets. | **Fixed:** §3.5.5. |
| B7 | minor | Delete uses only the latest version's provider; a rollback orphans Vault entries. | **Fixed:** per-provider delete fan-out (§3.5.4). |
| B8 | minor | `value_sha256` of plaintext remains in Postgres. | **Accepted:** named in §6. Owner: operator; trigger: the agreement checks no longer need it. |
| C1 | major | Caching external refs contradicts phase 7; stale window unspecified. | **Fixed:** managed-only cache, explicit stale window (§3.5.7). |
| C2 | major | §3.2 overstated isolation. | **Fixed:** §1 note, §6 rewritten. |
| C3 | minor | Policy carries unneeded `patch`, `undelete`, `list`. | **Fixed:** removed (§3.3). |
| C4 | minor | cas source unspecified. | **Fixed:** kvVersion from the latest version's material; metadata read on conflict (§3.4). |
| C5 | minor | Resolution must use material, not the parent's `external_ref`. | **Fixed:** self-describing material (§3.1, §3.4). |
| C6 | minor | PR-B needs a real-surface gate. | **Fixed:** PR-B gate (§4). |
| D1 | — | SSRF allowlist only exists because of per-vault `address`. | **Accepted cut:** `address` rejected; allowlist removed. |
| D2 | — | `custom_metadata` duplicates the DB and leaks names. | **Accepted cut.** |
| D3 | — | Reserved agents/plugins paths are speculative. | **Accepted:** reduced to a note. |

Correction from round 2: B4 was wrongly accepted as a vendor limitation. Replaced by
`revoke-self` (R2-11).

**Round 2**, 2026-10-24, reviewer `thirteenth-man` (Claude Fable 5.1, the same model
as round 1).
- Verdict: *partly confirmed*. 12 of 17 round-1 fixes closed against source; B1, A2
  and B2 were not closed as written.
- The author re-verified R2-1, R2-2, R2-3 and R2-7 against source before revising.
- Reviewer's open item: is the `/workspace/.env` `VAULT_TOKEN` the same as the
  app's ops token? The author checked during the live probe: it is a **root-policy**
  token, not `bionic-org-app`. It is flagged to the owner separately and is outside
  this plan.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| R2-1 | blocker | UI and CLI always send `provider`, so the company default is bypassed on the main create path. | **Fixed:** a bare `provider` no longer selects storage; UI preselects the company default; Create Secret dialog added to the PR-B gate (§3.5.1). |
| R2-2 | major | `connection-credentials.ts:89` direct definition insert; routine webhook transaction atomicity. | **Fixed:** §3.5.2, including the `createInTransaction` decision. |
| R2-3 | blocker (PR-C) | `rotate` cannot do a cross-provider write; non-reentrant 30 s lock; two-step commit races OAuth refresh; Vault write orphaned when the CAS is lost. | **Fixed:** `migrateProviderUnlocked`, single-UPDATE CAS, archive on loss, mutant test (§3.5.5). |
| R2-4 | blocker | The Claude OAuth change is two sites, and fails closed if user secrets are migrated before PR-B. | **Fixed:** two-site change, phase 6 precondition, refusal under option (b) (§3.5.3, §4). |
| R2-5 | minor | Two per-version readers must change. | **Fixed:** §3.5.4. |
| R2-6 | major | Cache placement and eviction could serve revoked versions. | **Fixed:** cache after status checks, revoke/disable eviction, `stale_served` outcome, test (§3.5.7). |
| R2-7 | major | Token retirement misses `setup-vault-secrets.sh:137`, the `dataFrom.extract` semantics, the orphaned policy, and docs. | **Fixed:** §3.6 and the PR-0 gate. The Ghost scripts use the operator's root token and are unaffected. |
| R2-8 | minor | 10 files, not 8. | **Moot:** hygiene dropped (see A1). |
| R2-9 | minor | `vault` with no config id reaches the provider with null config. | **Fixed:** covered by the §3.5.1 rule (422). The provider also rejects a null config. |
| R2-10 | minor | `value_sha256` for vault managed material unspecified. | **Fixed:** §3.4. |
| R2-11 | minor | Kubernetes-auth tokens *are* revocable. | **Fixed:** `revoke-self` on SIGTERM (§3.2). |
| cut | — | Per-vault `mountPath`/`secretPathPrefix` validation; sample-based `max_versions` check; 60-minute stale window. | **Accepted cuts:** fields rejected; canary-based check; 10-minute window. |

Rounds are capped at 2 (CLAUDE.md rule 4). Round 2 found no new class of problem:
each finding refined a round-1 area (default-provider plumbing, locking, the Claude
OAuth coupling, the cache, token retirement). Remaining review happens at code
level, on PR-A, PR-B and PR-C, where the reviewer's probes become tests.
