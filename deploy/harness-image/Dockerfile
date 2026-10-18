# syntax=docker/dockerfile:1
# SRE harness image: DeepSeek Harness (dsh) + kubectl + git.
#
# Everything is pinned by design: this pod holds the cluster's most powerful
# namespaced credentials. Rebuild deliberately, bump one pin at a time.
#
# Build (on the GPU host, from the repo root):
#   docker build -t docker4zerocool/dsh:0.2.0-rc.2-b2 -f deploy/harness-image/Dockerfile deploy/harness-image
#   docker push docker4zerocool/dsh:0.2.0-rc.2-b2

FROM docker.io/library/node:24-trixie-slim

ARG DSH_VERSION=0.2.0-rc.2
# Match the k3s server version; kubectl is supported one minor version off
# server, but pinning exact removes drift entirely.
ARG KUBECTL_VERSION=v1.33.4
# Helm is needed by the approved-change deploy step (helm upgrade of the
# bionic-org release using the harness SA's scoped kubeconfig). Same
# pin-and-verify discipline as kubectl.
ARG HELM_VERSION=v3.16.4

# kubectl pinned to the cluster server version, verified against its public
# SHA256 checksum file at build time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL --retry 3 -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
 && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256")  /usr/local/bin/kubectl" \
      | sha256sum -c - \
 && chmod +x /usr/local/bin/kubectl

RUN curl -fsSL --retry 3 -o /tmp/helm.tgz \
      "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
 && echo "$(curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz.sha256sum" | awk '{print $1}')  /tmp/helm.tgz" \
      | sha256sum -c - \
 && tar -xzf /tmp/helm.tgz -C /tmp \
 && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
 && chmod +x /usr/local/bin/helm \
 && rm -rf /tmp/helm.tgz /tmp/linux-amd64

# dsh CLI pinned to an exact npm version. --ignore-scripts skips postinstall
# hooks (supply-chain hygiene); if a future dsh release genuinely needs
# install scripts, review them before flipping this.
RUN npm install -g --ignore-scripts "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force

USER node
ENV HOME=/home/node
WORKDIR /home/node

ENTRYPOINT ["/usr/bin/tini", "--", "dsh"]
# Default command overridden by the Helm chart (web --host/--port/--no-open).
CMD ["--help"]
