# `@paperclipai/plugin-ssh-docker`

SSH + Docker sandbox provider plugin for Paperclip. Each environment lease runs
as a Docker container on any Docker host reachable over SSH: the control plane
creates the container, syncs the workspace in, runs the agent command over
`ssh`/`docker exec`, and tears the container down when the lease is released
(unless `reuseLease` is enabled).

This package lives in the Paperclip monorepo, but it is intentionally excluded
from the root `pnpm` workspace and shaped to install like a standalone package
(the same contract as the Daytona and exe.dev providers). That keeps its
dependencies out of the root lockfile and lets operators install it per
instance without app-image rebuilds.

## Install

The app image ships this provider's source and it is listed in the bundled
plugin catalog under the key `ssh-docker`, so a bundled install works wherever
the built bundle is present (the `cloud` image variant builds it via
`CLOUD_BUNDLED_PLUGINS`). On a self-hosted instance whose image does not carry
a pre-built bundle, build the self-contained copy locally and install it by
path:

```sh
pnpm install --ignore-workspace
pnpm bundle          # emits ./bundle with the SDK inlined
```

Then `POST /api/plugins/install` with
`{ "packageName": "<absolute path to bundle>", "isLocalPath": true }` (board
actor), or point `PAPERCLIP_BUNDLED_PLUGINS_ROOT` at a catalog root that
carries the built bundle.

## Configuration

Configure the provider from `Instance Settings -> Environments`, not from the
plugin's page. The environment `config` is provider-specific:

- `host` (required), `sshPort`, `sshUser` — the Docker host to dial.
- `sshPrivateKey` — secret-ref field: paste a private key once, or pick a
  saved Paperclip secret. Paperclip stores it as a company secret and never
  returns it.
- `knownHosts` — `ssh-keyscan` output pinning the host key.
- `image` (required) — container image for the lease. It must preinstall the
  agent CLI the run needs (e.g. `opencode-ai`); plain distro images fail with
  "command not installed". `image/Dockerfile` builds a Node 24 + ripgrep +
  opencode base.
- `containerUser`, `cpus`, `memory`, `dropCapabilities` — container shaping.
- `reuseLease` — keep the container between runs of the same environment.
  Speeds up repeat runs, but leaked containers from failed runs must be
  cleaned up on the host.

`image/Dockerfile` also documents the `pullPolicy` behavior: `if-not-present`
accepts images pre-seeded on the host without a registry.

## Security posture

The provider shells out to the system `ssh` binary (no JS crypto stack), pins
host keys via `known_hosts`, drops container capabilities by default, and never
logs key material. The SSH private key stays a company secret; environment
config GETs redact it.
