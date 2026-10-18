import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.ssh-docker-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "SSH Docker Sandbox Provider",
  description:
    "Runs each Paperclip sandbox lease in its own Docker container on any Linux host reachable over SSH (Brev/Crusoe, cloud VMs, bare metal). Repoint it by changing the host and key.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "ssh-docker",
      kind: "sandbox_provider",
      displayName: "SSH Docker host",
      description:
        "One container per lease on a Docker host you own. Paperclip connects over SSH; the agent never gets the SSH key or the host.",
      // First acquire may pull the sandbox image.
      defaultAcquireTimeoutMs: 600_000,
      // Leases are containers; with reuseLease the container is kept and resumed.
      supportsReusableLeases: true,
      configSchema: {
        type: "object",
        required: ["host"],
        properties: {
          // ---- Essentials ----
          host: {
            type: "string",
            description: "Docker host address (DNS name or IP) reachable from the Paperclip server over SSH.",
          },
          sshUser: {
            type: "string",
            description: "SSH login user on the host. It must be able to run Docker (docker group, or set Docker command to `sudo -n docker`).",
            default: "ubuntu",
          },
          sshPrivateKey: {
            type: "string",
            format: "secret-ref",
            maxLength: 8192,
            description: "Paste the SSH private key for the host, or pick a saved Paperclip secret.",
          },
          knownHosts: {
            type: "string",
            maxLength: 16384,
            description:
              "known_hosts line(s) for the host (`ssh-keyscan -p <port> <host>`). When set, host keys are verified strictly.",
          },
          image: {
            type: "string",
            description:
              "Sandbox image. It needs node 24.11+, git, tar, curl and a POSIX shell. Preinstall agent CLIs to skip per-run installs.",
            default: "node:24-bookworm",
          },
          containerUser: {
            type: "string",
            description: "User the container runs as. Use a non-root user present in the image.",
            default: "node",
          },
          // ---- Advanced: SSH ----
          sshPort: {
            type: "number",
            default: 22,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "SSH access",
          },
          strictHostKeyChecking: {
            type: "string",
            description: "Used only when known hosts is empty: `accept-new` (default), `yes`, or `no`.",
            default: "accept-new",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "SSH access",
          },
          sshMultiplexing: {
            type: "boolean",
            description: "Reuse one SSH connection for many commands (ControlMaster). Raise sshd MaxSessions on the host for many concurrent runs.",
            default: true,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "SSH access",
          },
          dockerCommand: {
            type: "string",
            description: "Docker CLI invocation on the host, for example `docker` or `sudo -n docker`.",
            default: "docker",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "SSH access",
          },
          // ---- Advanced: container ----
          pullPolicy: {
            type: "string",
            enum: ["if-not-present", "always", "never"],
            default: "if-not-present",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          cpus: {
            type: "string",
            description: "Docker `--cpus` limit per sandbox, for example `2`.",
            default: "2",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          memory: {
            type: "string",
            description: "Docker `--memory` limit per sandbox, for example `4g`.",
            default: "4g",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          pidsLimit: {
            type: "number",
            default: 1024,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          gpus: {
            type: "string",
            description: "Docker `--gpus` value on GPU hosts (`all`, `device=0`). Requires the NVIDIA container toolkit on the host.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          network: {
            type: "string",
            description: "Docker network for sandboxes. Default `bridge` (outbound internet allowed).",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          dropCapabilities: {
            type: "boolean",
            description: "Run with `--cap-drop ALL --security-opt no-new-privileges` (recommended).",
            default: true,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          env: {
            type: "object",
            description: "Non-secret environment variables set on every sandbox container.",
            additionalProperties: { type: "string" },
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          namePrefix: {
            type: "string",
            default: "paperclip",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Container",
          },
          // ---- Advanced: runtime ----
          timeoutMs: {
            type: "number",
            description: "Default timeout for lifecycle and command operations in milliseconds.",
            default: 300000,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Runtime",
          },
          reuseLease: {
            type: "boolean",
            description: "Keep the container between runs and resume it (warm sandbox, installed CLIs persist).",
            default: false,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Runtime",
          },
        },
      },
    },
  ],
};

export default manifest;
