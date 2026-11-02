# Reliora website: automatic deploys with release directories (plan, round 2)

Date: 2026-11-02
Status: plan. Replaces the image-per-release plan in Reliora-Inc/reliora-website#37, which a different-model review refuted.

## Owner's requirements

1. A merge to `main` of `Reliora-Inc/reliora-website` deploys reliora.ai. Agents may merge. Nobody clicks to deploy.
2. Every deploy runs a smoke test. A failed smoke test restores the previous build.
3. The SRE harness is the watchdog. It does not deploy.
4. Do not cut scope because a plan needed more review rounds (owner, 2026-11-02).

## Threat model

- Anyone who can merge to `main` can change what reliora.ai serves. The owner accepts that. On GitHub Free nothing else is possible: no branch protection, rulesets, environments or runner groups on a private repository.
- Code from a commit (JavaScript in `site-src/`, the nginx config, the pages) is untrusted. It must never run where a credential is readable, and it must never decide whether its own deploy passed.
- A commit must not be able to reach any credential, push an image, or change the deployer.

## Design

### Serving: one fixed nginx, release directories on a shared volume

- PVC `site-releases`, StorageClass `cephfs`, ReadWriteMany, 2 GiB, in namespace `reliora-website`.
- Layout: `/srv/site/releases/<sha>/` holds `html/` (the commit's `public/`), `default.conf` and `security-headers.conf`. `/srv/site/current` is a symlink to one release. `/srv/site/state.json` holds the deploy state.
- The website Deployment uses the pinned base image `nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:<digest>`. No site files are in the image. It mounts the PVC read-only at `/srv/site`, and a ConfigMap holds `conf.d/default.conf` with one line: `include /srv/site/current/default.conf;`.
- Content switches when the symlink changes, because nginx opens files per request. A change to `default.conf` needs the pods restarted. The deployer does that only when the config changed.
- The Deployment's pods mount no Secret and no ServiceAccount token (`automountServiceAccountToken: false`). The pod that serves commit content has nothing to leak.

### Deployer: a CronJob whose steps hold separate privileges

CronJob `site-deployer`, every 2 minutes. `concurrencyPolicy: Forbid`, `activeDeadlineSeconds: 900`, `backoffLimit: 0`, `startingDeadlineSeconds: 120`. The pod sets `automountServiceAccountToken: false`. Each step is an initContainer, so they run in order and the first failure stops the rest. Every image is pinned by digest. The script for each step comes from a ConfigMap in this repository, never from the commit.

| Step | Image | Mounts | Runs commit code |
|---|---|---|---|
| 0 lock | `alpine/k8s` (kubectl) | projected SA token | No |
| 1 fetch | `alpine/git` | deploy key, PVC read-only, `/work` | No |
| 2 check | `node:24-alpine` | `/work` only | **Yes** |
| 3 stage | nginx base image | PVC read-write, `/work` | Its nginx config only |
| 4 switch | `alpine/k8s` | projected SA token, PVC read-write, `/work` | No |
| 5 report (main container) | `alpine/k8s` | projected SA token, `/work` | No |

- **0 lock.** Take Lease `site-deployer`, with the holder set to this Job. Every Job takes it, including one created by hand from the CronJob, so two deployers never run at once. A Lease not renewed for 20 minutes is stale and can be taken. Exit if another holder is live.
- **1 fetch.** `git ls-remote` `main`'s head with the read-only deploy key. Read `state.json`. If `state` is `ok` for that commit and `current` points at its release, write `/work/skip` and stop. If `state` is `failed_check` or `failed_smoke` for that commit, skip too: a new commit is needed. If `state` is `infra_error`, retry with backoff (2, 4, 8, 16 minutes, then hourly). If a previous run stopped in the middle (`staging` or `switching`), go to recovery in step 4. Otherwise clone that commit into `/work/src` and write `/work/sha`. The deploy key is mounted in this container only.
- **2 check.** `node site-src/build.cjs --check` in `/work/src`. This step has no credential, no token and no PVC. It catches mistakes, not malice: commit code could fake its own result, so step 3 never relies on it to stop malice. Exit 1 sets `failed_check`.
- **3 stage.** Copy `public/`, `deploy/nginx.conf` and `deploy/security-headers.conf` from `/work/src` into `releases/<sha>/`, written to a temporary directory and renamed when complete. Render two configs by substituting exact strings. Fail closed if a string is not found the expected number of times:
  - `default.conf` for live use: `/usr/share/nginx/html` becomes `/srv/site/current/html`, and `/etc/nginx/snippets/security-headers.conf` becomes `/srv/site/current/security-headers.conf`;
  - `staging.conf` for the test: the same substitutions with `releases/<sha>` instead of `current`, and the port changed from 8080 to 8081.

  Run `nginx -t` on the staging config. Start nginx on `127.0.0.1:8081` only, and run the smoke test against it. This container holds no credential and no token, so a hostile config can serve nothing of value.
- **4 switch.** Write `state.json` as `switching`, with the commit and the previous release. Swap `current` atomically (`ln -s` to a temporary name, then `mv -T`). If `default.conf` differs from the previous release's, run `kubectl rollout restart` and wait for `rollout status` (240 seconds). Smoke-test the live Service. On failure, swap back, restart if the config had changed, smoke-test again, and write `failed_smoke` (or `broken` if the old release also fails). The previous release is a directory recorded in `state.json`, not a revision number, so a concurrent edit of the Deployment cannot change what a rollback restores.
  **Recovery:** if step 1 found `staging` or `switching`, smoke-test what `current` points at. Pass makes it `ok`, failure rolls back as above.
- **5 report.** Write ConfigMap `site-deploy-state`: commit, state, reason, time, and a `heartbeat` timestamp written on every run, including skips. Release the Lease. Exit non-zero if the run ended in a failure state, so the Job shows failed.

`releases/` keeps the last 10 releases plus `current` and the previous release.

### Smoke test (owned by the deployer)

`deploy/reliora-website/smoke.sh` in this repository. It runs against a base URL and fails on any of:

- `/healthz` not 200;
- any URL in the release's `sitemap.xml` not 200, or not containing its page's `<title>` element. The list comes from the release's own `sitemap.xml`, but a sitemap with fewer than 10 URLs fails;
- missing `X-Content-Type-Options`, `X-Frame-Options` or `Referrer-Policy` on `/` and on one page;
- `/` not redirecting to the home page as `deploy/nginx.conf` defines, or a 404 not served by `_site-404.html`.

The commit cannot replace this script. It can only change which pages exist.

### Credentials

| Credential | Source | Mounted in |
|---|---|---|
| Read-only deploy key, this repository only | Vault `secret/t6-apps/reliora-website/deployer` (the owner writes it once: the ops role cannot write new paths), ExternalSecret into Secret `site-deployer-git` | Step 1 only |
| ServiceAccount `site-deployer` | Role: Lease `site-deployer` (get, create, update); ConfigMap `site-deploy-state` (get, patch); Deployment `reliora-website` (get, list, watch, patch, all limited by `resourceNames`) | Steps 0, 4 and 5 only, through a projected token volume |

There is no registry credential. The deployer never pushes an image.

### Who else can reach the deployer

- **Its source** lives in `salilkadam/paperclip`, which no Paperclip agent's GitHub connection reaches (they cover `Bionic-AI-Solutions` and `Reliora-Inc` only). The owner applies it with `kubectl apply`.
- **SRE harness:** `sre-harness-full` in `reliora-website` is replaced by `sre-harness-watch`: get, list and watch on deployments, pods, jobs, cronjobs, events and configmaps, and pods/log. It loses secrets, exec and write. The harness keeps full rights in its other namespaces.
- **Paperclip agents:** `paperclip-agent-website-publisher` (patch on the website Deployment) is removed. The deployer is the only writer.
- **Runners:** see "GitHub runners" below.

### Watchdog (SRE harness)

The monitor reads `site-deploy-state`. It reports to Slack when:
- the state is `failed_check`, `failed_smoke`, `broken` or `infra_error`;
- the heartbeat is older than 15 minutes (the deployer is dead or blocked);
- a state stays `staging` or `switching` for more than 20 minutes;
- an independent smoke test of `https://reliora.ai` fails.

It does not deploy. Only its Role in this namespace enforces that, not its prompt.

### GitHub runners

A pull-request check is useful, but only after the runners are isolated. Today `k3s-reliora` runs privileged Docker-in-Docker with no node selection, and the control-plane node `cp1` has no taint. In this order:
1. Taint `cp1` with `node-role.kubernetes.io/control-plane:NoSchedule` after checking which workloads already run there without a toleration.
2. Pin the Reliora runner set to a labelled node that runs neither the website nor the deployer.
3. Add `.github/workflows/check.yml`: `runs-on: k3s-reliora`, `permissions: contents: read`, no secrets, `timeout-minutes: 10`, running `npm run check`.

Steps 1 and 2 belong in `Bionic-AI-Solutions/Deploy`, which has an open pull request (#343) that must be merged first (workspace rule 0).

## Cutover

1. The owner stores the deploy key in Vault. I add the public key to the repository as a read-only deploy key.
2. Apply the PVC, ConfigMaps, ServiceAccount, Role, Lease and ExternalSecret. Run the deployer once by hand. It publishes current `main`, but the live site does not use the volume yet.
3. Check the published release through a temporary port-forward to a test pod.
4. Change the website Deployment to the fixed image and the volume (rolling update with 2 replicas). Smoke-test the live site.
5. Unsuspend the CronJob.
6. Replace the harness and agent Roles. Update the harness monitor. Update the Sr. Engineer instructions: "a merge deploys automatically; check the live page; the deployer rolls back on a failed smoke test."
7. Retire `k8s/50-website-deployment.yaml`, `60` and `70` in the site repository, which point to this directory instead, and update `docs/website-deploy.md`.

**Rollback of the cutover:** apply the previous Deployment, the image `0.20.0-f8c6502`. The image is still in Docker Hub.

## Verification before calling it done

- Plant a failing check, a failing smoke test (a page that returns 500), a config change, and a missing page. Each must produce the documented state, Slack alert and restored release.
- Kill the deployer pod during step 4. The next run must recover.
- Create a Job by hand while the CronJob runs. The Lease must stop one of them.
- Check by test pods that step 2 and step 3 see no Secret and no token.

## Accepted risks

- **Anyone who can merge can deploy:** owner's decision. Accepted risk. Owner: Salil. Trigger: every merge.
- **Readiness is `/healthz`**, a static 200. A broken page is caught by the smoke test, not by readiness. Content from the switch is live for up to the smoke test's duration (about 30 seconds) before a rollback.
- **CephFS is shared storage.** If it is down, the live site is down. Accepted risk. Owner: Salil. Trigger: a CephFS incident. Mitigation: the harness alerts through its independent public smoke test.
