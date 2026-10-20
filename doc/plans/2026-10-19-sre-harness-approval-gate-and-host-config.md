# SRE Harness: Approval Gate, Action Markers, and Build-Host Configuration

Date: 2026-10-19
Status: implemented (PRs #55, #56, #57, #58 on the fork)

## Why this document exists

The harness can propose fixes, but a human decides when a fix deploys. This
week three gaps made that gate unreliable or undocumented. This document
records the decisions and the one-time operator steps.

## 1. The live approval route is a comment, not a review

The harness opens pull requests with the repository owner's personal access
token. GitHub does not allow a user to approve a pull request they authored.
A click of "Approve" in the review UI is therefore impossible for these pull
requests while the author account and the approver account are the same.

The supported route is a pull request comment that says exactly:

```
deploy: approve
```

or, to refuse:

```
deploy: decline
```

The approvals scanner acts on those comments. A review of either kind is
ignored by design, because it cannot be trusted as a gate when authorship and
approval share one identity.

## 2. Action markers: one approval, at most one deploy

Fix (PR #56). Two defects made approvals either repeat or freeze:

- An approval that could not complete stayed pending, and the next 15-minute
  pass re-ran the whole merge, build, and deploy chain, forever.
- The scanner honored the oldest decision, so one early `deploy: decline`
  vetoed every later approve on that pull request.

The rules now:

- The newest operator decision wins. A same-second approve and decline
  resolves to decline, the safe side.
- After acting, the harness must leave a final comment that starts with
  `dsh-action: merged`, `dsh-action: blocked <reason>`, or
  `dsh-action: failed <reason>`. That marker closes the decision.
- A later `deploy: approve` comment after the last marker re-arms the
  decision. This is the retry route after a `blocked` or `failed` marker or a
  silent no-result run.

The marker contract is enforced in the approvals prompt and proven by
`pnpm test:sre-harness-scan` (PR #56), which renders the chart and runs ten
fixed scenarios against the scanner, including both defect regressions.

## 3. The build-host address is runtime configuration (PR #55)

The fork is public. The GPU build host address must never be chart content,
because the chart ships to a public repository. The chart now renders
`buildHost.host: ""` and the two SSH-bearing jobs read `GPU_SSH_HOST` from an
operator-owned ConfigMap through an optional `envFrom`.

One-time step per namespace that builds (already applied in `bionicorg` after
rev 18):

```sh
kubectl -n bionicorg create configmap sre-harness-buildhost \
  --from-literal=GPU_SSH_HOST=<gpu-build-host-address>
```

If the value is missing, the bootstrap prints the exact fix command instead
of failing later inside a build. Note: the address remains in git history of
commits before PR #55; removing it from history is a separate, deliberate
decision by the repository owner.

## 4. Durable run records (PR #57)

The Job controller deletes a harness pod when it kills it on the run deadline,
so container logs preserved nothing and incident reviews had no primary
evidence. Each run now appends one JSON line (component, timing, exit code,
terminated flag, event and tool-call counts, a short excerpt) to the
namespaced ConfigMap `sre-harness-run-log`, cap 20 lines. That ConfigMap is
created at runtime and must never become chart-owned; helm upgrades would
revert operator history.

## 5. Node read for the monitor (PR #58)

The monitor previously inferred node loss from taint events and a 502 from the
kubelet proxy. The chart now creates one value-gated ClusterRole (`nodes:
get, list` only) plus its binding. Everything else in the harness stays
namespaced. Set `rbac.clusterNodeRead.enabled=false` to remove it.

## 6. Runbook: replace the owner PAT with a machine account

The harness acts on GitHub with the owner's personal access token today. That
causes the approval impossibility in section 1 and mixes human and bot
identity in the commit history. The clean end-state:

1. Create a GitHub machine account (not a personal account).
2. Grant it write access to the fork only.
3. Create a fine-grained personal access token on that account, scoped to the
   fork, with contents:write and pull-requests:write.
4. Store it in Vault at `t6-apps/bionic-org/config` as the pull-request token
   property the harness reads (`GIT_PAT` property name in the chart's Vault
   config keys).
5. Restart the harness jobs. New pull requests then show the machine account
   as author, and the owner can use real review Approve/Request-changes
   again. The `deploy: approve` comment route keeps working either way.

## Verification commands

```sh
pnpm test:sre-harness-scan        # scanner scenarios, 10 cases
helm lint deploy/helm/sre-harness
kubectl auth can-i get nodes --as=system:serviceaccount:bionicorg:sre-harness-sa
kubectl -n bionicorg get configmap sre-harness-run-log -o jsonpath='{.data.runs}'
```
