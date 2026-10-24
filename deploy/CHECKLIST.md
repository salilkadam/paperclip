# Deployment Checklist: Bionic (Paperclip) to org.baisoln.com

## Prerequisites (Infrastructure)
- [x] Namespace `bionicorg` exists
- [x] CNPG cluster `pg-ceph` running (2/2 instances)
- [x] ClusterIssuer `letsencrypt-prod` ready
- [x] ClusterSecretStore `vault-backend` valid
- [x] Kong ingress controller running
- [x] cert-manager running
- [x] external-secrets-operator running
- [x] Keycloak running (keycloak ns, keycloak-0 pod)
- [x] MinIO running (minio ns, 3 replicas)
- [x] dockerhub-pull-secret exists in bionicorg ns

## Step 1: Image Push
- [ ] Push `docker4zerocool/bionic:71d7f47fe` to Docker Hub
- [ ] Verify image is pullable from Docker Hub

## Step 2: PostgreSQL Setup
- [ ] Create `bionicorg` user in pg-ceph cluster
- [ ] Create `bionicorg` database in pg-ceph cluster
- [ ] Save generated password for Vault

## Step 3: Keycloak Setup
- [ ] Create Keycloak client `bionic-org` in realm `Bionic`
- [ ] Record client_id and client_secret

## Step 4: Vault Secrets
- [ ] Populate Vault path `t6-apps/bionic-org/config` with:
  - [ ] `database_url`
  - [ ] `better_auth_secret`
  - [ ] `session_secret`
  - [ ] `keycloak_client_id`
  - [ ] `keycloak_client_secret`
  - [ ] `minio_root_user`
  - [ ] `minio_root_password`

## Step 4b: Vault JWT auth for ESO
- [ ] Run `./deploy/scripts/setup-vault-jwt.sh` (creates/refreshes policy `eso-bionic-org-policy` + broad shared-store policy `eso-reader` on KV mount `secret`, and merges both onto JWT role `eso-reader` additively — never replacing policies other orgs attached; re-run after k3s API-server reinit, which rotates OIDC signing keys)
- [ ] Confirm policy exists and is attached: `vault policy read eso-bionic-org-policy` (a missing policy = 403 on every read while login still succeeds)
- [ ] Confirm the shared role carries BOTH policies: `vault read auth/jwt/role/eso-reader` shows `eso-reader` (broad `secret/data/*` read, needed by every other tenant sharing the instance store) AND `eso-bionic-org-policy`
- [ ] After any Vault role/policy change, flush ESO's cached store token: `kubectl rollout restart deploy/external-secrets -n external-secrets`

## Step 5: Helm Deploy
- [ ] Run `helm upgrade --install bionic-org deploy/helm/bionic-org --namespace bionicorg --set "image.tag=71d7f47fe" --set "domain=org.baisoln.com" --create-namespace --wait --timeout 5m --atomic`
- [ ] Verify pods are Running
- [ ] Verify rollout status

## Step 6: Post-Deploy Verification
- [ ] Check ExternalSecret synced — `kubectl -n bionicorg get externalsecret -o wide` shows READY=True / reason=SecretSynced for BOTH `bionic-org-secrets` and `bionic-org-api-keys` (a failed sync silently keeps STALE secret data)
- [ ] Cluster-wide ESO gate (shared store = cross-tenant blast radius): `kubectl get externalsecret -A -o custom-columns='READY:.status.conditions[?(@.type=="Ready")].status' --no-headers | sort | uniq -c` must show ALL True (currently 186/186 across ~25 namespaces); any False means our store/role change broke another tenant — see README "Shared-store path prefix"
- [ ] Claude subscription check: pod has NO uppercase `ANTHROPIC_API_KEY` (`kubectl -n bionicorg exec deploy/bionic-org -c bionic -- sh -c '[ -n "$ANTHROPIC_API_KEY" ] && echo POISONED || echo clean'`) and `CLAUDE_CODE_OAUTH_TOKEN` hash matches Vault's `shared/api-keys` → `claude_subscription_token`
- [ ] Check TLS certificate provisioned
- [ ] Check pod health (no restarts, no crash loops)
- [ ] Verify DNS resolves org.baisoln.com
- [ ] Verify HTTP health endpoint responds
- [ ] Check Keycloak login flow works
