# Reliora website: automatic deploys with release directories (plan, round 3)

Date: 2026-11-02
Status: plan. Round 1 (image per release, Reliora-Inc/reliora-website#37) and round 2 (this file, first version) were refuted by different-model reviews. This version answers both. Scope is not cut because of the extra rounds (owner, 2026-11-02).

## Owner's requirements

1. A merge to `main` of `Reliora-Inc/reliora-website` deploys reliora.ai. Agents may merge. Nobody clicks to deploy.
2. Every deploy runs a smoke test. A failed smoke test restores the previous build.
3. The SRE harness is the watchdog. It does not deploy.

## Threat model

- Anyone who can merge to `main` can change what reliora.ai serves. The owner accepts that. On GitHub Free nothing else is possible for a private repository.
- Everything from a commit is untrusted: JavaScript in `site-src/`, `deploy/nginx.conf`, `deploy/security-headers.conf`, file names, symlinks and file sizes in `public/`.
- Untrusted input must never (a) run where a credential, a token or a writable copy of the releases is mounted, (b) write anything that a trusted step later reads, or (c) decide whether its own deploy passed.

## Serving

- PVC `site-releases`, StorageClass `cephfs`, ReadWriteMany, 2 GiB, namespace `reliora-website`. Layout:
  - `releases/<sha>/html/` (the commit's `public/`), `releases/<sha>/default.conf`, `releases/<sha>/security-headers.conf`;
  - `current`, a symlink to one release;
  - `state.json`, written only by trusted steps.
- Website Deployment: `nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:<digest>`, uid and gid 101, no site files in the image. It mounts the PVC **read-only** at `/srv/site`, and emptyDirs for nginx's temporary files and pid. ConfigMap `conf.d/default.conf` holds one line: `include /srv/site/current/default.conf;`. Pod annotation `reliora.ai/config-hash` holds the hash of the live config.
  - No ServiceAccount token (`automountServiceAccountToken: false`), no Secret, no `imagePullSecrets`: the base image is public.
  - `nodeSelector` keeps the pods off `cp1`. Per the workspace notes, cp1 masquerades pod egress, which defeats NetworkPolicies.
- NetworkPolicy `site-web`: ingress on 8080 only; **egress denied completely**. A static site needs no outbound traffic, so a commit's config cannot turn reliora.ai into a proxy into the cluster or the LAN.
- Content changes when the symlink changes: nginx opens files per request (verified in the pinned image). A config change needs new pods. The deployer triggers that by patching `reliora.ai/config-hash` on the pod template.

## Deployer

CronJob `site-deployer`, every 2 minutes, `concurrencyPolicy: Forbid`, `startingDeadlineSeconds: 120`. The Job has `backoffLimit: 0` and `activeDeadlineSeconds: 900`. The pod has `restartPolicy: Never`, `automountServiceAccountToken: false`, `shareProcessNamespace: false`, a `nodeSelector` that avoids `cp1`, uid 101, and pinned image digests. All scripts come from a ConfigMap in this repository.

### Volumes, and who may write them

| Volume | Kind | Written by | Read by |
|---|---|---|---|
| `trusted` | emptyDir, 600 MiB limit | steps 1 and 3 | steps 3, 4, 5 |
| `checkin` | emptyDir, 600 MiB limit | step 1 (a separate copy of the source) | step 2 |
| `checkout` | emptyDir, 1 MiB limit | step 2 (its result only) | step 5 reads it as data |
| `stagetmp` | emptyDir | step 3b (nginx temporary files, logs, pid) | nobody |
| `releases` | the PVC | read-write in steps 3a and 4; read-only in step 3b | |
| `git-key` | Secret | | step 1 only |
| `sa-token` | projected token | | steps 0, 4, 5 only |

Step 2 (commit code) mounts only `checkin` and `checkout`. Step 3b (the commit's nginx config) mounts the PVC read-only and only `stagetmp` writable. No trusted step reads anything that untrusted code could write, except the check result, which is treated as one word.

### Steps

Every step exits 0 and writes its outcome to `trusted/status/<step>`, except step 2, which writes to `checkout`. A step that sees an earlier failure or `skip` does nothing. Step 5, the main container, sets the Job's exit code. So the state, the heartbeat and the Lease release always happen.

0. **Lock** (`alpine/k8s`, token). Take Lease `site-deployer`, with the holder set to this Job's name. If another holder exists, take over only if its Job no longer exists or has finished (Role: `get` on Jobs), or if the Lease was not renewed for 5 minutes. Every later step renews the Lease.
1. **Fetch** (`alpine/git`, key). `git ls-remote` gives `main`'s head, which must match `^[0-9a-f]{40}$`. Read `state.json` from the PVC (read-only mount). Decide:
   - `ok` for that commit, `current` pointing at it, and the config hash matching: write `skip`;
   - `failed_check` or `failed_smoke` for that commit: `skip` until a new commit lands;
   - `infra_error` for that commit: retry after 2, 4, 8, 16 minutes, then hourly;
   - `staging`, `switching` or `restarting`: recovery (step 4);
   - otherwise: `git clone` that commit twice, once into `trusted/src` and once into `checkin/src`. Write the commit to `trusted/sha`.
2. **Check** (`node:24-alpine`; mounts `checkin` and `checkout` only). `node site-src/build.cjs --check`. Write `pass` or `fail` to `checkout/result`. Anything other than exactly `pass` counts as `failed_check`. This catches mistakes, not malice.
3a. **Copy** (base nginx image, PVC read-write, no nginx run). From `trusted/src` only:
   - reject the commit (`failed_check`) if `public/` contains a symlink, a device or a file over 50 MiB, or if the total is over 500 MiB;
   - copy `public/` to `releases/.tmp-<sha>/html/`, and the two config files beside it;
   - render `default.conf`, with exact-string substitutions that fail closed unless they match the expected count (counted in `deploy/nginx.conf` at e857dcc; a commit that changes them fails `failed_check` until `smoke.sh` and the counts are updated here): `/usr/share/nginx/html` (2) becomes `/srv/site/current/html`; `/etc/nginx/snippets/security-headers.conf` (5) becomes `/srv/site/current/security-headers.conf`;
   - render `staging.conf` the same way with `releases/<sha>` in place of `current`, and `listen 8080;` (1) becomes `listen 127.0.0.1:8081;`;
   - rename `.tmp-<sha>` to `<sha>`, unless `<sha>` already exists from an earlier run;
   - write `state.json`: `staging`.
3b. **Stage test** (base nginx image, PVC **read-only**, `stagetmp` writable, no token, no key). `nginx -t -c` a top-level config that includes `staging.conf`. Start nginx and run `smoke.sh http://127.0.0.1:8081`. Write the result to `trusted/status/stage`. Because the PVC is read-only here, exactly as in the live pods, a config that tries to log or write onto the volume fails here the same way it would fail live.
4. **Switch** (`alpine/k8s`, token, PVC read-write). If the stage test passed:
   - write `state.json`: `switching`, with the commit, the previous release directory and the previous config hash;
   - swap `current` atomically (`ln -s` to a temporary name, then `mv -T`);
   - if the release's config hash differs from the pod template's `reliora.ai/config-hash`: write `restarting`, patch the annotation, wait for `rollout status` (240 s);
   - smoke-test **each** website pod's IP (Role: `get`, `list` on EndpointSlices), not just the Service;
   - on success write `ok`;
   - on failure swap back to the recorded previous directory, put back its config hash if it changed, smoke-test each pod again, and write `failed_smoke` (or `broken` if the previous release fails too).

   **Recovery** (from step 1): compare `current` and the pod template's config hash with `state.json`. Finish an interrupted restart, smoke-test each pod, then write `ok` or roll back as above. A run killed at any point leaves a state that the next run can resume.
5. **Report** (`alpine/k8s`, token). Write ConfigMap `site-deploy-state`: commit, state, reason, time, and `heartbeat` (every run, skips included). Post to Slack for any state other than `ok` or `skip`, using a webhook from ExternalSecret `site-deployer-slack`, mounted in this step only. Release the Lease. Exit 1 if the run ended in a failure state.

Pruning: step 4 keeps the last 10 releases plus `current` and the previous release.

## Smoke test (deployer-owned)

`deploy/reliora-website/smoke.sh` in this repository, one argument: a base URL. It fails on any of:

- `/healthz` not 200;
- these fixed pages not 200, or without the expected `<title>` prefix: `/` (home), `/_site-features.html`, `/_site-pricing.html`, `/_site-security.html`, `/_site-design-partners.html`, `/_site-contact.html`;
- any other URL in the release's `sitemap.xml` not 200. URLs under `/_site-blog`, `/blog-media/` and `/sitemap-blog.xml` are skipped: the separate blog service serves them through Kong, not this nginx. A sitemap with fewer than 10 URLs fails;
- `/no-such-page-<random>` not returning 404 with the title `Page not found | Reliora`;
- `X-Content-Type-Options`, `X-Frame-Options` or `Referrer-Policy` missing on `/`, on a page, and on the 404.

`/` serves the home page with 200; there is no redirect.

## Credentials and permissions

| Credential | Source | Mounted in |
|---|---|---|
| Read-only deploy key for this repository only | Vault `secret/t6-apps/reliora-website/deployer:deploy_key`, which the owner writes once (my ops role cannot write new paths). ExternalSecret into Secret `site-deployer-git` | Step 1 |
| Slack webhook | Vault, same path, key `slack_webhook`. ExternalSecret into Secret `site-deployer-slack` | Step 5 |
| ServiceAccount `site-deployer` | Role: Lease `site-deployer` get/update (create is not restricted by name, a Kubernetes limit); ConfigMap `site-deploy-state` get/patch; Deployment `reliora-website` get/list/watch/patch, restricted by name (`kubectl rollout status` sends the name field selector, verified); EndpointSlices get/list; Jobs get | Steps 0, 4, 5, through a projected token volume |

There is no registry credential.

- **NetworkPolicy `site-deployer`.** Egress to GitHub (443), the Kubernetes API, the website pods (8080), Slack (443) and DNS. Kubernetes cannot narrow this per container, so step 2 shares the pod's network. It holds no secret to send.
- **Other principals:**
  - `sre-harness-full` in `reliora-website` is replaced by `sre-harness-watch`: get, list and watch on deployments, pods, pods/log, jobs, cronjobs, events and configmaps. No secrets, no exec, no write.
  - `paperclip-agent-website-publisher` is removed.
  - The deployer's source lives in `salilkadam/paperclip`. No Paperclip agent's GitHub connection reaches that repository. The SRE harness's `GIT_PAT` does: its prompt limits it to opening PRs, and merges need the owner's approval through the approvals watcher. **Accepted risk.** Owner: Salil. Trigger: the scope of the harness PAT is decided. Until then, a prompt is the only control.

## Watchdog

- **The deployer alerts at once** (step 5) on every failure state.
- **The SRE harness monitor** reads `site-deploy-state` every run. It treats each of these differently:
  - a missing ConfigMap ("deployer not installed or deleted");
  - a heartbeat older than 15 minutes ("deployer not running");
  - a state stuck in `staging`, `switching` or `restarting` for over 20 minutes;
  - a failure state.

  It runs every 30 minutes and is an LLM sweep, so it is the second line, not the first.
- **The blackbox exporter** (`gpu-monitor`) gets probes for `https://reliora.ai/healthz` and `https://reliora.ai/_site-pricing.html`, with an alert after 5 minutes of failure. This watches the site independently of both the deployer and the harness. Where its config lives decides the repository (to be confirmed at build time).

## GitHub runners: a separate piece of work

This plan does not depend on a pull-request check and does not add one. A check on the privileged `k3s-reliora` runners would run commit code with node-level privilege, and pinning the runners to a node does not stop that (the CephFS driver runs on every node). The fix is runner mode (rootless, or Kubernetes mode without privilege). It needs its own plan and safety review, in `Bionic-AI-Solutions/Deploy`, after its open PR #343. **Scheduled, tracked separately, not dropped.**

## Cutover

1. The owner writes the deploy key and the Slack webhook to Vault. I add the public key as a read-only deploy key on the repository.
2. Merge reliora-website#38, so that `--check` fails on stale pages.
3. Apply the PVC, ConfigMaps, ServiceAccount, Role, Lease, NetworkPolicies and ExternalSecrets, with the CronJob suspended. Run one Job by hand. It publishes `main` and stops at step 4, because the live Deployment does not use the volume yet.
4. Run the verification below against a test Deployment that uses the volume.
5. Change the website Deployment to the fixed image, the read-only volume and egress denial. Smoke-test each pod.
6. Unsuspend the CronJob. Replace the harness and agent Roles. Update the harness monitor and the blackbox probes. Update the Sr. Engineer instructions: "a merge deploys automatically; check the live page; the deployer rolls back on a failed smoke test."
7. In the site repository, retire `k8s/50`, `60` and `70`, which point here instead, and update `docs/website-deploy.md`.

**Rollback of the cutover:** apply the previous Deployment, the image `0.20.0-f8c6502`.

## Verification before calling it done (each one planted, then observed)

- A failing `--check`: `failed_check`, a Slack alert, the site unchanged.
- A page returning 404 or 500 after the switch: `failed_smoke`, the previous release restored, verified on each pod.
- A hostile config that logs to `/srv/site/state.json`: fails in 3b, and the PVC is unchanged.
- A config that proxies to a cluster Service: the request fails (egress denied).
- A symlink in `public/`: `failed_check`.
- A config change: the pods restart with the new config. A rollback restores the old config on each pod.
- The pod killed in step 4 before and after the restart: the next run recovers.
- A Job created by hand during a run: the Lease stops it.
- A test pod for steps 2 and 3b: it sees no Secret, no token and no writable PVC.
- The CronJob suspended for 20 minutes: the harness reports a stale heartbeat. The ConfigMap deleted: the harness reports "not installed".

## Accepted risks

- **Anyone who can merge can deploy:** the owner's decision.
- **Readiness is a static `/healthz`.** A broken switch is live for at most about one smoke-test cycle (under a minute) before the rollback.
- **CephFS is a dependency of the live site.** If CephFS is down, the site is down. The blackbox alert detects it. Owner: Salil. Trigger: a CephFS incident.
- **Symlink visibility across nodes after the rename** is expected to be immediate (CephFS metadata caps), but is unverified until the cutover's per-pod smoke test.
