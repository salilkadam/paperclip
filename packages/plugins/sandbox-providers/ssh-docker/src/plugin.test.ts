import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import plugin, {
  buildContainerName,
  buildContainerScript,
  buildEnvPayload,
  buildExecScript,
  buildKillScript,
  buildRunScript,
  buildSshArgs,
  parseDriverConfig,
  shellQuote,
  validateConfig,
} from "./plugin.js";
import manifest from "./manifest.js";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinData = "";
  stdin = {
    on: () => undefined,
    end: (chunk?: string) => {
      this.stdinData += chunk ?? "";
    },
  };
  kill = vi.fn();
  constructor(input: { code?: number; stdout?: string; stderr?: string }) {
    super();
    queueMicrotask(() => {
      if (input.stdout) this.stdout.emit("data", input.stdout);
      if (input.stderr) this.stderr.emit("data", input.stderr);
      this.emit("close", input.code ?? 0, null);
    });
  }
}

const calls: { args: string[]; child: MockChild }[] = [];
function queue(input: { code?: number; stdout?: string; stderr?: string }) {
  spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
    const child = new MockChild(input);
    calls.push({ args, child });
    return child;
  });
}

const baseConfig = { host: "203.0.113.10", sshUser: "ubuntu", sshMultiplexing: false };

/** Run a generated script locally with sh to prove the quoting round-trips. */
function sh(script: string, stdin = ""): string {
  return execFileSync("sh", ["-c", script], { input: stdin, encoding: "utf8" });
}

describe("ssh-docker manifest", () => {
  it("declares a reusable sandbox_provider driver", () => {
    const driver = manifest.environmentDrivers?.[0];
    expect(driver?.driverKey).toBe("ssh-docker");
    expect(driver?.kind).toBe("sandbox_provider");
    expect(driver?.supportsReusableLeases).toBe(true);
    expect(manifest.capabilities).toEqual(["environment.drivers.register"]);
  });
});

describe("config", () => {
  it("applies safe defaults", () => {
    const config = parseDriverConfig({ host: " paperclip-linux " });
    expect(config).toMatchObject({
      host: "paperclip-linux",
      sshUser: "ubuntu",
      sshPort: 22,
      image: "node:24-bookworm",
      containerUser: "node",
      dropCapabilities: true,
      cpus: "2",
      memory: "4g",
      pidsLimit: 1024,
      pullPolicy: "if-not-present",
      reuseLease: false,
    });
  });

  it("rejects injection-shaped values", () => {
    const config = parseDriverConfig({
      host: "-oProxyCommand=evil",
      image: "node; rm -rf /",
      dockerCommand: "docker; curl x",
      memory: "4g && reboot",
      env: { "BAD-KEY": "x" },
    });
    const { errors } = validateConfig(config, null);
    expect(errors.join("\n")).toMatch(/host/);
    expect(errors.join("\n")).toMatch(/image/);
    expect(errors.join("\n")).toMatch(/dockerCommand/);
    expect(errors.join("\n")).toMatch(/memory/);
    expect(errors.join("\n")).toMatch(/BAD-KEY/);
  });

  it("rejects a public key pasted as the private key", () => {
    const { errors } = validateConfig(parseDriverConfig(baseConfig), "ssh-ed25519 AAAAC3Nza user@host");
    expect(errors.join()).toMatch(/PUBLIC key/);
  });

  it("validates through the plugin hook and returns normalized config", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "ssh-docker", config: baseConfig });
    expect(result?.ok).toBe(true);
    expect(result?.normalizedConfig).toMatchObject({ host: "203.0.113.10" });
    expect(result?.warnings?.join()).toMatch(/knownHosts/);
  });
});

describe("ssh args", () => {
  it("pins host keys when knownHosts is set and disables multiplexing when asked", () => {
    const config = parseDriverConfig({ ...baseConfig, knownHosts: "203.0.113.10 ssh-ed25519 AAAA" });
    const args = buildSshArgs(config, "true", { multiplex: false });
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.some((a) => a.startsWith("UserKnownHostsFile="))).toBe(true);
    expect(args).toContain("ControlPath=none");
    expect(args.at(-2)).toBe("ubuntu@203.0.113.10");
  });

  it("uses a control socket when multiplexing", () => {
    const args = buildSshArgs(parseDriverConfig(baseConfig), "true", { multiplex: true });
    expect(args).toContain("ControlMaster=auto");
    expect(args.some((a) => a.startsWith("ControlPath=") && a.endsWith("cm-%C"))).toBe(true);
  });
});

describe("generated scripts", () => {
  it("builds bounded container names", () => {
    const name = buildContainerName(parseDriverConfig(baseConfig), "9f1c-22aa-env", "RUN-1234-5678-abcd");
    expect(name).toBe("paperclip-9f1c22aa-run12345");
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("builds a hardened docker run command", () => {
    const script = buildRunScript(parseDriverConfig({ ...baseConfig, gpus: "all", env: { TZ: "UTC" } }), "pc-1", {
      "paperclip.run-id": "r1",
      "paperclip.agent-id": undefined,
    });
    expect(script).toContain("--cap-drop ALL --security-opt no-new-privileges");
    expect(script).toContain("--user 'node'");
    expect(script).toContain("--gpus 'all'");
    expect(script).toContain("--label 'paperclip.run-id=r1'");
    expect(script).not.toContain("paperclip.agent-id");
    expect(script).toMatch(/--entrypoint sleep 'node:24-bookworm' infinity$/);
  });

  it("round-trips hostile values through quoting", () => {
    const value = `it's "quoted" $HOME \`tick\` \\ ; | & \n newline`;
    expect(sh(`printf '%s' ${shellQuote(value)}`)).toBe(value);
  });

  it("delivers env via stdin, keeps it off the command line, and passes the rest of stdin through", () => {
    const secret = "tok'en $(rm -rf /) \nline2";
    const payload = buildEnvPayload({ PAPERCLIP_API_KEY: secret, PATH: "/custom/bin:/usr/bin:/bin" });
    const containerScript = buildContainerScript({
      execId: "test123",
      command: "sh",
      args: ["-c", 'printf "%s|%s|" "$PAPERCLIP_API_KEY" "$PATH"; cat'],
      cwd: "/tmp",
    });
    expect(containerScript).not.toContain("tok'en");
    const out = sh(containerScript, `${payload}\nstdin-body`);
    expect(out).toBe(`${secret}|/custom/bin:/usr/bin:/bin|stdin-body`);
  });

  it("works with an empty env and no stdin", () => {
    const script = buildContainerScript({ execId: "t2", command: "echo", args: ["hi there"] });
    expect(sh(script, "\n")).toBe("hi there\n");
  });

  it("propagates the command exit code through the session wrapper", () => {
    const script = buildContainerScript({ execId: "t3", command: "sh", args: ["-c", "exit 7"] });
    const exec = buildExecScript(parseDriverConfig(baseConfig), "c", script);
    // Strip the docker exec prefix and run the wrapper locally.
    const local = exec.replace(/^docker exec -i 'c' /, "");
    let code = 0;
    try {
      execFileSync("sh", ["-c", local], { input: "\n" });
    } catch (error) {
      code = (error as { status: number }).status;
    }
    expect(code).toBe(7);
  });

  it("kills the whole process group of a timed-out command", () => {
    const script = buildKillScript(parseDriverConfig(baseConfig), "c", "abc");
    expect(script).toContain("kill -s TERM -- -");
    expect(script).toContain("kill -s KILL -- -");
  });

  it("rejects invalid env keys", () => {
    expect(() => buildEnvPayload({ "A B": "x" })).toThrow(/Invalid environment variable key/);
  });
});

describe("lease lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    calls.length = 0;
  });

  it("acquires a container and reports workspace metadata", async () => {
    queue({ stdout: "" }); // ensure image
    queue({ stdout: "abc123\n" }); // docker run
    queue({ stdout: "/home/node\nbash\nv24.11.1\n" }); // inspect
    queue({ stdout: "" }); // mkdir
    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "ssh-docker",
      companyId: "co",
      environmentId: "env-1",
      runId: "run-1",
      config: baseConfig,
    });
    expect(lease?.providerLeaseId).toBe("paperclip-env1-run1");
    expect(lease?.metadata).toMatchObject({ remoteCwd: "/home/node/paperclip-workspace", nodeVersion: "v24.11.1" });
    expect(calls[1]!.args.at(-1)).toContain("run -d --init");
  });

  it("removes the container when post-start inspection fails", async () => {
    queue({ stdout: "" });
    queue({ stdout: "abc\n" });
    queue({ code: 1, stderr: "boom" });
    queue({ stdout: "" }); // rm -f
    await expect(
      plugin.definition.onEnvironmentAcquireLease?.({
        driverKey: "ssh-docker",
        companyId: "co",
        environmentId: "env-1",
        runId: "run-1",
        config: baseConfig,
      }),
    ).rejects.toThrow(/boom/);
    expect(calls[3]!.args.at(-1)).toContain("rm -f");
  });

  it("keeps the container on release when reuseLease is set, removes it otherwise", async () => {
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "ssh-docker", companyId: "co", environmentId: "e", providerLeaseId: "c1",
      config: { ...baseConfig, reuseLease: true },
    });
    expect(calls).toHaveLength(0);
    queue({});
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "ssh-docker", companyId: "co", environmentId: "e", providerLeaseId: "c1", config: baseConfig,
    });
    expect(calls[0]!.args.at(-1)).toContain("rm -f");
  });

  it("stops instead of deleting for stop_and_retain", async () => {
    queue({});
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "ssh-docker", companyId: "co", environmentId: "e", providerLeaseId: "c1", config: baseConfig,
      resourceDisposition: "stop_and_retain",
    });
    expect(calls[0]!.args.at(-1)).toContain("stop");
    expect(calls[0]!.args.at(-1)).not.toContain("rm -f");
  });

  it("reports an expired lease when the container is gone", async () => {
    queue({ stdout: "missing\n" });
    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "ssh-docker", companyId: "co", environmentId: "e", providerLeaseId: "gone", config: baseConfig,
    });
    expect(lease).toEqual({ providerLeaseId: null, metadata: { expired: true } });
  });

  it("executes with env on stdin, not argv", async () => {
    queue({ stdout: "ok\n" });
    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "ssh-docker", companyId: "co", environmentId: "e", config: baseConfig,
      lease: { providerLeaseId: "c1", metadata: { remoteCwd: "/w" } },
      command: "echo", args: ["ok"], env: { PAPERCLIP_API_KEY: "super-secret" }, stdin: "in",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok\n", timedOut: false });
    expect(calls[0]!.args.join(" ")).not.toContain("super-secret");
    const [envLine, rest] = calls[0]!.child.stdinData.split("\n");
    expect(Buffer.from(envLine!, "base64").toString()).toContain("super-secret");
    expect(rest).toBe("in");
  });

  it("retries on a dedicated connection when the shared one is refused", async () => {
    queue({ code: 255, stderr: "mux_client_request_session: session request failed: Session open refused by peer" });
    queue({ stdout: "ok\n" });
    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "ssh-docker", companyId: "co", environmentId: "e",
      config: { ...baseConfig, sshMultiplexing: true },
      lease: { providerLeaseId: "c1" }, command: "true",
    });
    expect(result?.exitCode).toBe(0);
    expect(calls[1]!.args).toContain("ControlPath=none");
  });
});
