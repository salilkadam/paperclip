import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

/**
 * SSH + Docker sandbox provider.
 *
 * Every lease is one container on a Docker host that the Paperclip server
 * reaches over SSH. The host is plain configuration (address, user, key), so
 * the same environment can be repointed at any Linux box with Docker: a Brev /
 * Crusoe VM, a cloud VM, or bare metal.
 *
 * Boundary notes (see SANDBOX-REQUIREMENTS.md):
 * - The SSH key stays in the plugin worker. Sandbox code only ever sees its
 *   container, never the host shell or the Docker socket.
 * - Command environment (which can carry run-scoped tokens) is never placed on
 *   a command line. It travels base64-encoded as the first stdin line and is
 *   sourced inside the container, so it is invisible to `ps` on the host.
 * - Each command runs in its own process group with its PID recorded, so a
 *   timeout kills the whole tree instead of leaving it running in the container
 *   (killing the `docker exec` client alone does not stop the process).
 */

export interface SshDockerConfig {
  host: string;
  sshUser: string;
  sshPort: number;
  sshPrivateKey: string | null;
  knownHosts: string | null;
  strictHostKeyChecking: string;
  sshMultiplexing: boolean;
  dockerCommand: string;
  image: string;
  containerUser: string | null;
  pullPolicy: "if-not-present" | "always" | "never";
  cpus: string | null;
  memory: string | null;
  pidsLimit: number | null;
  gpus: string | null;
  network: string | null;
  dropCapabilities: boolean;
  env: Record<string, string>;
  namePrefix: string;
  timeoutMs: number;
  reuseLease: boolean;
}

export interface SshResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const PROVIDER = "ssh-docker";
const DEFAULT_IMAGE = "node:24-bookworm";
const DEFAULT_CONTAINER_USER = "node";
const DEFAULT_TIMEOUT_MS = 300_000;
const SSH_SIGKILL_GRACE_MS = 2_000;
const EXEC_STATE_DIR = "/tmp/.paperclip-exec";
const UUID_SECRET_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SSH_MUX_FAILURE_RE = /mux_client|Session open refused|ControlSocket|control socket|master is dead|Control master/i;

const HOST_RE = /^(?!-)[A-Za-z0-9.:_\-[\]]+$/;
const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
const CONTAINER_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-:]*$/;
const DOCKER_COMMAND_RE = /^[A-Za-z0-9_./ -]+$/;
const CPUS_RE = /^\d+(\.\d+)?$/;
const MEMORY_RE = /^\d+[bkmgBKMG]?$/;
const GPUS_RE = /^[A-Za-z0-9=,.:"-]+$/;
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function int(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function envMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const k = key.trim();
    if (k.length > 0 && typeof raw === "string") env[k] = raw;
  }
  return env;
}

function normalizeNamePrefix(value: string | null): string {
  const normalized = (value ?? "paperclip")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.length > 0 ? normalized.slice(0, 24) : "paperclip";
}

export function parseDriverConfig(raw: Record<string, unknown>): SshDockerConfig {
  const pullPolicy = str(raw.pullPolicy);
  const timeoutMs = int(raw.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  return {
    host: str(raw.host) ?? "",
    sshUser: str(raw.sshUser) ?? "ubuntu",
    sshPort: int(raw.sshPort) ?? 22,
    sshPrivateKey: str(raw.sshPrivateKey),
    knownHosts: str(raw.knownHosts),
    strictHostKeyChecking: str(raw.strictHostKeyChecking) ?? "accept-new",
    sshMultiplexing: raw.sshMultiplexing !== false,
    dockerCommand: str(raw.dockerCommand) ?? "docker",
    image: str(raw.image) ?? DEFAULT_IMAGE,
    containerUser: raw.containerUser === "" ? null : (str(raw.containerUser) ?? DEFAULT_CONTAINER_USER),
    pullPolicy: pullPolicy === "always" || pullPolicy === "never" ? pullPolicy : "if-not-present",
    cpus: raw.cpus === "" ? null : (str(raw.cpus) ?? "2"),
    memory: raw.memory === "" ? null : (str(raw.memory) ?? "4g"),
    pidsLimit: raw.pidsLimit === "" ? null : (int(raw.pidsLimit) ?? 1024),
    gpus: str(raw.gpus),
    network: str(raw.network),
    dropCapabilities: raw.dropCapabilities !== false,
    env: envMap(raw.env),
    namePrefix: normalizeNamePrefix(str(raw.namePrefix)),
    timeoutMs,
    reuseLease: raw.reuseLease === true,
  };
}

// Catch common key-paste mistakes before they turn into cryptic SSH errors.
export function validateSshPrivateKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  if (/^PuTTY-User-Key-File-\d/m.test(trimmed)) {
    return "sshPrivateKey looks like a PuTTY .ppk file. Export it in OpenSSH format.";
  }
  if (/^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-[a-z0-9-]+)\s+\S/.test(trimmed)) {
    return "sshPrivateKey looks like a PUBLIC key. Paste the matching private key.";
  }
  const header = trimmed.match(/^-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/m);
  const footer = trimmed.match(/^-----END ([A-Z0-9 ]*)PRIVATE KEY-----\s*$/m);
  if (!header) return "sshPrivateKey must be a PEM private key starting with '-----BEGIN … PRIVATE KEY-----'.";
  if (!footer) return "sshPrivateKey is missing its '-----END … PRIVATE KEY-----' footer.";
  if (header[1].trim() !== footer[1].trim()) return "sshPrivateKey header/footer mismatch; the key looks truncated.";
  return null;
}

export function validateConfig(config: SshDockerConfig, rawKey: string | null): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!config.host) errors.push("host is required.");
  else if (!HOST_RE.test(config.host)) errors.push("host must be a hostname or IP address.");
  if (!SSH_USER_RE.test(config.sshUser)) errors.push("sshUser contains invalid characters.");
  if (config.sshPort < 1 || config.sshPort > 65_535) errors.push("sshPort must be between 1 and 65535.");
  if (!IMAGE_RE.test(config.image)) errors.push("image is not a valid image reference.");
  if (config.containerUser && !CONTAINER_USER_RE.test(config.containerUser)) {
    errors.push("containerUser contains invalid characters.");
  }
  if (!DOCKER_COMMAND_RE.test(config.dockerCommand) || !/\bdocker\b/.test(config.dockerCommand)) {
    errors.push("dockerCommand must be a plain docker invocation such as `docker` or `sudo -n docker`.");
  }
  if (config.cpus && !CPUS_RE.test(config.cpus)) errors.push("cpus must be a number such as `2` or `1.5`.");
  if (config.memory && !MEMORY_RE.test(config.memory)) errors.push("memory must look like `4g` or `512m`.");
  if (config.pidsLimit != null && config.pidsLimit < 1) errors.push("pidsLimit must be positive.");
  if (config.gpus && !GPUS_RE.test(config.gpus)) errors.push("gpus contains invalid characters.");
  if (config.network && !NETWORK_RE.test(config.network)) errors.push("network is not a valid Docker network name.");
  if (config.timeoutMs < 1_000 || config.timeoutMs > 86_400_000) errors.push("timeoutMs must be between 1000 and 86400000.");
  if (!["accept-new", "yes", "no"].includes(config.strictHostKeyChecking)) {
    errors.push("strictHostKeyChecking must be `accept-new`, `yes`, or `no`.");
  }
  for (const key of Object.keys(config.env)) {
    if (!ENV_KEY_RE.test(key)) errors.push(`env contains an invalid key: ${key}`);
  }
  if (rawKey && !UUID_SECRET_REF_RE.test(rawKey)) {
    const keyError = validateSshPrivateKey(rawKey);
    if (keyError) errors.push(keyError);
  }
  if (!rawKey) warnings.push("No SSH private key configured; the Paperclip server's default SSH identity will be used.");
  if (!config.knownHosts) {
    warnings.push("knownHosts is empty; the host key is trusted on first use. Paste `ssh-keyscan` output to pin it.");
  }
  if (!config.containerUser) warnings.push("containerUser is empty; the image default user (often root) is used.");
  if (config.reuseLease) warnings.push("reuseLease keeps containers running between runs; they use host resources until released.");
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Shell + SSH plumbing
// ---------------------------------------------------------------------------

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

let runtimeDir: string | null = null;

/** Private 0700 dir for the identity file, known_hosts and SSH control sockets. */
function getRuntimeDir(): string {
  if (runtimeDir && existsSync(runtimeDir)) return runtimeDir;
  runtimeDir = mkdtempSync(path.join(tmpdir(), "pc-sshdk-"));
  chmodSync(runtimeDir, 0o700);
  const dir = runtimeDir;
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  return runtimeDir;
}

function materialize(kind: string, content: string): string {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const file = path.join(getRuntimeDir(), `${kind}-${digest}`);
  if (!existsSync(file)) {
    writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return file;
}

export function buildSshArgs(config: SshDockerConfig, remoteCommand: string, options: { multiplex: boolean }): string[] {
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4",
    "-o", "LogLevel=ERROR",
    "-p", String(config.sshPort),
  ];
  if (config.knownHosts) {
    args.push(
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${materialize("known_hosts", config.knownHosts)}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
    );
  } else {
    args.push("-o", `StrictHostKeyChecking=${config.strictHostKeyChecking}`);
  }
  if (options.multiplex) {
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${path.join(getRuntimeDir(), "cm-%C")}`,
      "-o", "ControlPersist=120",
    );
  } else {
    args.push("-o", "ControlMaster=no", "-o", "ControlPath=none");
  }
  if (config.sshPrivateKey) {
    args.push("-i", materialize("id", config.sshPrivateKey), "-o", "IdentitiesOnly=yes");
  }
  args.push(`${config.sshUser}@${config.host}`, remoteCommand);
  return args;
}

interface SpawnOptions {
  stdin?: string;
  timeoutMs: number;
  multiplex: boolean;
  /** Runs when the timeout fires, before the local ssh client is killed. */
  onTimeout?: () => Promise<unknown>;
}

function spawnSsh(config: SshDockerConfig, remoteCommand: string, options: SpawnOptions): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", buildSshArgs(config, remoteCommand, { multiplex: options.multiplex }), {
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (result: SshResult | Error) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    // With ControlMaster the mux client hands its stdio to the shared master,
    // so after a timeout the pipes can stay open until the remote process ends.
    // Never wait on them past the grace period.
    const forceFinish = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ exitCode: null, signal: "SIGKILL", timedOut: true, stdout, stderr });
    };
    if (options.timeoutMs > 0) {
      timers.push(setTimeout(() => {
        timedOut = true;
        const killLocal = () => {
          child.kill("SIGTERM");
          timers.push(setTimeout(() => child.kill("SIGKILL"), SSH_SIGKILL_GRACE_MS));
          timers.push(setTimeout(forceFinish, SSH_SIGKILL_GRACE_MS * 3));
        };
        if (options.onTimeout) {
          // Bound the remote cleanup so a dead host cannot stall the caller.
          const cleanupDeadline = setTimeout(killLocal, 30_000);
          timers.push(cleanupDeadline);
          options.onTimeout().catch(() => undefined).finally(() => {
            clearTimeout(cleanupDeadline);
            killLocal();
          });
        } else {
          killLocal();
        }
      }, options.timeoutMs));
    }
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", () => {
      if (timedOut) timers.push(setTimeout(forceFinish, 1_000));
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: timedOut ? null : code, signal, timedOut, stdout, stderr });
    });
    if (options.stdin != null && child.stdin) {
      child.stdin.on("error", () => {
        // The remote may exit before reading all input; that is not an error here.
      });
      child.stdin.end(options.stdin);
    }
  });
}

/** Run a remote host command. Falls back to a dedicated connection if the shared one is refused. */
export async function runSsh(
  config: SshDockerConfig,
  remoteCommand: string,
  options: { stdin?: string; timeoutMs?: number; onTimeout?: () => Promise<unknown> } = {},
): Promise<SshResult> {
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const first = await spawnSsh(config, remoteCommand, { ...options, timeoutMs, multiplex: config.sshMultiplexing });
  if (
    config.sshMultiplexing
    && !first.timedOut
    && first.exitCode === 255
    && SSH_MUX_FAILURE_RE.test(first.stderr)
  ) {
    return spawnSsh(config, remoteCommand, { ...options, timeoutMs, multiplex: false });
  }
  return first;
}

function hostSh(script: string): string {
  return `sh -c ${shellQuote(script)}`;
}

function failureText(action: string, result: SshResult): string {
  if (result.timedOut) return `${action} timed out.`;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  if (result.exitCode === 255) return `${action} failed: SSH connection error: ${detail}`;
  return `${action} failed: ${detail}`;
}

async function runChecked(config: SshDockerConfig, action: string, script: string, timeoutMs?: number): Promise<string> {
  const result = await runSsh(config, hostSh(script), { timeoutMs });
  if (result.timedOut || result.exitCode !== 0) throw new Error(failureText(action, result));
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Docker scripts
// ---------------------------------------------------------------------------

export function buildContainerName(config: SshDockerConfig, environmentId: string, runId: string): string {
  const envPart = environmentId.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase() || "env";
  const runPart = runId.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase() || randomUUID().slice(0, 8);
  return `${config.namePrefix}-${envPart}-${runPart}`.slice(0, 63);
}

export function buildEnsureImageScript(config: SshDockerConfig): string {
  const d = config.dockerCommand;
  const image = shellQuote(config.image);
  switch (config.pullPolicy) {
    case "always":
      return `${d} pull -q ${image} >/dev/null`;
    case "never":
      return `${d} image inspect ${image} >/dev/null`;
    default:
      return `${d} image inspect ${image} >/dev/null 2>&1 || ${d} pull -q ${image} >/dev/null`;
  }
}

export function buildRunScript(
  config: SshDockerConfig,
  name: string,
  labels: Record<string, string | null | undefined>,
): string {
  const parts = [config.dockerCommand, "run", "-d", "--init", "--name", shellQuote(name)];
  for (const [key, value] of Object.entries({ "paperclip.managed": "true", ...labels })) {
    if (value) parts.push("--label", shellQuote(`${key}=${value}`));
  }
  if (config.containerUser) parts.push("--user", shellQuote(config.containerUser));
  if (config.dropCapabilities) parts.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
  if (config.cpus) parts.push("--cpus", shellQuote(config.cpus));
  if (config.memory) parts.push("--memory", shellQuote(config.memory));
  if (config.pidsLimit != null) parts.push("--pids-limit", String(config.pidsLimit));
  if (config.gpus) parts.push("--gpus", shellQuote(config.gpus));
  if (config.network) parts.push("--network", shellQuote(config.network));
  for (const [key, value] of Object.entries(config.env)) {
    parts.push("-e", shellQuote(`${key}=${value}`));
  }
  parts.push("--entrypoint", "sleep", shellQuote(config.image), "infinity");
  return parts.join(" ");
}

/**
 * Script that runs inside the container for one command. stdin line 1 is the
 * base64 env payload; everything after it is the command's own stdin.
 * Profiles are sourced before the env payload so the caller's PATH and
 * variables win over login-profile defaults.
 */
export function buildContainerScript(input: {
  execId: string;
  command: string;
  args: string[];
  cwd?: string | null;
}): string {
  const stateFile = `${EXEC_STATE_DIR}/${input.execId}`;
  const commandParts = [input.command, ...input.args].map(shellQuote).join(" ");
  const lines = [
    `mkdir -p ${EXEC_STATE_DIR} 2>/dev/null || true`,
    `echo $$ > ${stateFile}.pid 2>/dev/null || true`,
    "IFS= read -r __pc_env || true",
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    `if [ -n "$__pc_env" ]; then __pc_f=${stateFile}.env; ( umask 077; printf '%s' "$__pc_env" | base64 -d > "$__pc_f" ) && . "$__pc_f"; rm -f "$__pc_f"; fi`,
    "unset __pc_env __pc_f",
  ];
  if (input.cwd) lines.push(`cd ${shellQuote(input.cwd)} || exit 1`);
  lines.push(`exec ${commandParts}`);
  return lines.join("\n");
}

/** Wrapper that starts the container script in its own session (process group) when possible. */
const SESSION_WRAPPER =
  'if command -v setsid >/dev/null 2>&1; then exec setsid -w sh -c "$1"; else exec sh -c "$1"; fi';

export function buildExecScript(config: SshDockerConfig, name: string, containerScript: string): string {
  return [
    config.dockerCommand,
    "exec",
    "-i",
    shellQuote(name),
    "sh",
    "-c",
    shellQuote(SESSION_WRAPPER),
    "pc-exec",
    shellQuote(containerScript),
  ].join(" ");
}

export function buildEnvPayload(env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  for (const [key] of entries) {
    if (!ENV_KEY_RE.test(key)) throw new Error(`Invalid environment variable key: ${key}`);
  }
  if (entries.length === 0) return "";
  const script = entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  return Buffer.from(script, "utf8").toString("base64");
}

export function buildKillScript(config: SshDockerConfig, name: string, execId: string): string {
  const pidFile = `${EXEC_STATE_DIR}/${execId}.pid`;
  const inner = [
    `p=$(cat ${pidFile} 2>/dev/null) || exit 0`,
    '[ -n "$p" ] || exit 0',
    // `--` is required: dash parses `-<pgid>` as an option otherwise.
    'kill -s TERM -- -"$p" 2>/dev/null || kill -s TERM "$p" 2>/dev/null',
    "sleep 3",
    'kill -s KILL -- -"$p" 2>/dev/null || kill -s KILL "$p" 2>/dev/null',
    `rm -f ${pidFile}`,
  ].join("; ");
  return `${config.dockerCommand} exec ${shellQuote(name)} sh -c ${shellQuote(inner)}`;
}

async function containerStatus(config: SshDockerConfig, name: string): Promise<string | null> {
  const result = await runSsh(
    config,
    hostSh(`${config.dockerCommand} inspect -f '{{.State.Status}}' ${shellQuote(name)} 2>/dev/null || echo missing`),
  );
  if (result.timedOut || result.exitCode !== 0) throw new Error(failureText(`inspect container ${name}`, result));
  const status = result.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "missing";
  return status === "missing" || status === "" ? null : status;
}

async function removeContainer(config: SshDockerConfig, name: string): Promise<void> {
  await runChecked(config, `remove container ${name}`, `${config.dockerCommand} rm -f ${shellQuote(name)} >/dev/null 2>&1 || true`);
}

async function buildLease(
  config: SshDockerConfig,
  name: string,
  requestedCwd: string | null | undefined,
  resumedLease: boolean,
): Promise<PluginEnvironmentLease> {
  const probe = [
    'printf "%s\\n" "${HOME:-/tmp}"',
    "if command -v bash >/dev/null 2>&1; then echo bash; else echo sh; fi",
    "node --version 2>/dev/null || echo none",
  ].join("; ");
  const stdout = await runChecked(
    config,
    `inspect container ${name}`,
    `${config.dockerCommand} exec ${shellQuote(name)} sh -c ${shellQuote(probe)}`,
  );
  const [homeRaw, shellRaw, nodeRaw] = stdout.split(/\r?\n/);
  const homeDir = homeRaw?.trim() || "/tmp";
  const remoteCwd = requestedCwd?.trim() || path.posix.join(homeDir, "paperclip-workspace");
  await runChecked(
    config,
    `create workspace in ${name}`,
    `${config.dockerCommand} exec ${shellQuote(name)} mkdir -p ${shellQuote(remoteCwd)}`,
  );
  return {
    providerLeaseId: name,
    metadata: {
      provider: PROVIDER,
      containerName: name,
      host: config.host,
      image: config.image,
      remoteCwd,
      homeDir,
      shellCommand: shellRaw?.trim() === "bash" ? "bash" : "sh",
      nodeVersion: nodeRaw?.trim() || "none",
      reuseLease: config.reuseLease,
      resumedLease,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("ssh-docker sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "ssh-docker sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const { errors, warnings } = validateConfig(config, str(params.config.sshPrivateKey));
    if (errors.length > 0) return { ok: false, errors, warnings };
    return { ok: true, warnings, normalizedConfig: { ...config } };
  },

  async onEnvironmentProbe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    const d = config.dockerCommand;
    const userFlag = config.containerUser ? ` --user ${shellQuote(config.containerUser)}` : "";
    const check = "node --version 2>/dev/null || echo node:missing; git --version 2>/dev/null || echo git:missing; id -un 2>/dev/null || id -u";
    const script = [
      `${d} version --format '{{.Server.Version}}'`,
      buildEnsureImageScript(config),
      `${d} run --rm${userFlag} --entrypoint sh ${shellQuote(config.image)} -c ${shellQuote(check)}`,
    ].join(" && ");
    try {
      const stdout = await runChecked(config, `probe ${config.host}`, script, Math.max(config.timeoutMs, 600_000));
      const [dockerVersion, nodeVersion, gitVersion, user] = stdout.trim().split(/\r?\n/);
      const missing = [nodeVersion, gitVersion].filter((line) => line?.endsWith(":missing"));
      return {
        ok: missing.length === 0,
        summary: missing.length === 0
          ? `Docker ${dockerVersion} on ${config.host}; image ${config.image} has ${nodeVersion} as ${user}.`
          : `Image ${config.image} is missing: ${missing.map((m) => m.split(":")[0]).join(", ")}.`,
        metadata: {
          provider: PROVIDER,
          host: config.host,
          dockerVersion,
          image: config.image,
          nodeVersion,
          gitVersion,
          containerUser: user,
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary: "SSH Docker host probe failed.",
        metadata: { provider: PROVIDER, host: config.host, error: errorMessage(error) },
      };
    }
  },

  async onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const name = buildContainerName(config, params.environmentId, params.runId);
    await runChecked(config, `prepare image ${config.image}`, buildEnsureImageScript(config), Math.max(config.timeoutMs, 600_000));
    // Names are per run, so a leftover container can only be a failed earlier
    // attempt of this same run; replace it.
    await runChecked(
      config,
      `start container ${name}`,
      `${config.dockerCommand} rm -f ${shellQuote(name)} >/dev/null 2>&1; ` + buildRunScript(config, name, {
        "paperclip.company-id": params.companyId,
        "paperclip.environment-id": params.environmentId,
        "paperclip.run-id": params.runId,
        "paperclip.agent-id": params.agentId,
        "paperclip.adapter-type": params.adapterType,
      }),
    );
    try {
      return await buildLease(config, name, params.requestedCwd, false);
    } catch (error) {
      await removeContainer(config, name).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const name = params.providerLeaseId;
    const status = await containerStatus(config, name);
    if (!status) return { providerLeaseId: null, metadata: { expired: true } };
    if (status !== "running") {
      await runChecked(config, `start container ${name}`, `${config.dockerCommand} start ${shellQuote(name)} >/dev/null`);
    }
    return buildLease(config, name, str(params.leaseMetadata?.remoteCwd), true);
  },

  async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    if (params.resourceDisposition === "stop_and_retain") {
      // Contract: stop and keep files; a failed stop must throw, never delete.
      await runChecked(
        config,
        `stop container ${params.providerLeaseId}`,
        `${config.dockerCommand} stop ${shellQuote(params.providerLeaseId)} >/dev/null`,
      );
      return;
    }
    if (config.reuseLease) return;
    await removeContainer(config, params.providerLeaseId);
  },

  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    await removeContainer(config, params.providerLeaseId);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      str(params.lease.metadata?.remoteCwd)
      ?? params.workspace.remotePath
      ?? "/tmp/paperclip-workspace";
    if (params.lease.providerLeaseId) {
      await runChecked(
        config,
        "create workspace",
        `${config.dockerCommand} exec ${shellQuote(params.lease.providerLeaseId)} mkdir -p ${shellQuote(remoteCwd)}`,
      );
    }
    return { cwd: remoteCwd, metadata: { provider: PROVIDER, remoteCwd } };
  },

  async onEnvironmentExecute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
    const name = params.lease.providerLeaseId;
    if (!name) {
      return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "No provider lease ID available for execution." };
    }
    const config = parseDriverConfig(params.config);
    const execId = randomUUID().replace(/-/g, "").slice(0, 16);
    let envPayload: string;
    try {
      envPayload = buildEnvPayload(params.env);
    } catch (error) {
      return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: errorMessage(error) };
    }
    const containerScript = buildContainerScript({
      execId,
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd ?? str(params.lease.metadata?.remoteCwd),
    });
    const timeoutMs = params.timeoutMs ?? config.timeoutMs;
    const result = await runSsh(config, hostSh(buildExecScript(config, name, containerScript)), {
      stdin: `${envPayload}\n${params.stdin ?? ""}`,
      timeoutMs,
      // Killing the ssh/docker client does not stop the process in the
      // container, so kill its process group first.
      onTimeout: () => runSsh(config, hostSh(buildKillScript(config, name, execId)), { timeoutMs: 25_000 }),
    });
    const sshFailed = !result.timedOut && result.exitCode === 255 && result.stdout.length === 0;
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: sshFailed ? failureText(`execute in ${name}`, result) : result.stderr,
      metadata: { provider: PROVIDER, containerName: name, host: config.host },
    };
  },
});

export default plugin;
