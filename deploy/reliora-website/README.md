# reliora.ai deployer

A merge to `main` of `Reliora-Inc/reliora-website` deploys reliora.ai. Design and threat model: [`doc/plans/2026-11-02-reliora-site-deployer.md`](../../doc/plans/2026-11-02-reliora-site-deployer.md).

This directory is the only place the deployer is defined. It lives here, not in the site repository, because no Paperclip agent can push to this repository. A commit to the site cannot change the deployer or its smoke test.

| File | What it is |
|---|---|
| `deployer.sh` | Every step of the deployer, one mode per step. |
| `smoke.sh` | The smoke test, run on a private port before the switch and on each pod after it. |
| `stage-top.conf` | The nginx top-level config for the stage test. Everything nginx writes goes to a scratch volume. |
| `known_hosts` | GitHub's SSH host keys, from `https://api.github.com/meta`. |
| `00`–`40-*.yaml`, `kustomization.yaml` | Volume, permissions, network policies, secrets, CronJob. |
| `50-website.yaml` | The website Deployment that serves from the release volume. Applied at cutover only. |
| `test/run-local.sh` | Runs the real steps in the pinned images against planted failures, with a fake `kubectl`. |

## Operating it

- **State:** `kubectl -n reliora-website get configmap site-deploy-state -o yaml` shows the last commit, state, reason and heartbeat. The volume's `state` file holds the same, plus the previous release.
- **A failed deploy** sends a Slack alert, keeps the previous release live, and pins the commit until a new commit (or a new deployer version) lands.
- **Deploy again after a temporary failure:** nothing to do. `infra_error` retries with backoff.
- **Pause deploys:** `kubectl -n reliora-website patch cronjob site-deployer -p '{"spec":{"suspend":true}}'`. The harness reports a stale heartbeat only while the CronJob is unsuspended.
- **Roll back by hand:** point `current` at an earlier release with a one-off Job running `deployer.sh` steps, or redeploy the previous commit by reverting it on `main`. Prefer the revert: it keeps production equal to `main`.
- **Change the deployer:** edit here, run `test/run-local.sh <site checkout>`, open a pull request, then `kubectl apply -k deploy/reliora-website`. A new deployer version retries a pinned commit.
- **Update GitHub's host keys:** regenerate `known_hosts` from `https://api.github.com/meta` and check the fingerprints against GitHub's documentation.

## Cutover

Follow "Cutover" in the plan, with its round-3 change: **first** run `deploy/rbac/apply.sh`, which gives the SRE harness a watch-only Role in this namespace and deletes its full one. Only then create the deploy key Secret, so the harness never holds rights to read it. `deploy/rbac/verify-authz.sh` checks the result.
