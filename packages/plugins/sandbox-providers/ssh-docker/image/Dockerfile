# Sandbox runtime image for the ssh-docker provider.
#
# Meets packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md: node 24+,
# POSIX sh, tar, git, curl, ripgrep, writable home/cache/tmp, non-root user.
# ripgrep is preinstalled so OpenCode skill tooling never downloads a pinned
# build at run time. Agent CLIs are installed system-wide (/usr/local/bin)
# because Paperclip gives each run a managed $HOME, so per-user installs would
# not be on PATH.
#
# Build on the Docker host itself (no registry needed), for example:
#   docker build -t paperclipai/agent-runtime-opencode:sandbox \
#     packages/plugins/sandbox-providers/ssh-docker/image
# then set the environment's image to that tag (`pullPolicy: if-not-present`
# accepts host-local tags).
ARG NODE_IMAGE=node:24-bookworm
FROM ${NODE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep unzip xz-utils procps \
      python3 python3-venv python3-pip build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g opencode-ai@latest \
 && npm cache clean --force \
 && chown -R 1000:1000 /usr/local/lib/node_modules

USER node
RUN command -v opencode >/dev/null 2>&1 || (echo "opencode not on PATH" && exit 1)
WORKDIR /home/node
RUN mkdir -p /home/node/paperclip-workspace /home/node/.cache
