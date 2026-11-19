import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeIsolatedTaskDirectory, isCoreIsolatedTaskWorkspacePath, shouldUseIsolatedTaskDirectory } from "./isolated-task-directory.js";
import { prepareSandboxManagedRuntime, type SandboxManagedRuntimeClient, type SandboxSyncOperation } from "@paperclipai/adapter-utils/sandbox-managed-runtime";

const execFile = promisify(execFileCallback);

const policy = {
  trustPreset: "low_trust_review",
  environmentDriver: "sandbox",
  mode: "isolated_workspace",
  hasProjectWorkspace: false,
  projectWorkspaceId: null,
  workspaceStrategies: [undefined, null, {}],
};

describe("repository-free low-trust workspace selection", () => {
  it("selects a private directory for sandbox tasks without a repository", () => {
    expect(shouldUseIsolatedTaskDirectory(policy)).toBe(true);
  });

  it.each([
    { trustPreset: "standard" },
    { environmentDriver: "local" },
    { environmentDriver: "ssh" },
    { mode: "shared_workspace" },
    { hasProjectWorkspace: true },
    { projectWorkspaceId: "workspace-1" },
    { workspaceStrategies: [{ type: "git_worktree" }] },
    { workspaceStrategies: [{ existingBranch: "main" }] },
    { workspaceStrategies: [{ provisionCommand: "setup" }] },
  ])("preserves configured workspace requirements: %j", (override) => {
    expect(shouldUseIsolatedTaskDirectory({ ...policy, ...override })).toBe(false);
  });
});

describe("isolated task directories", () => {
  let root: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-task-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    return { companyId: "company-1", issueId: "issue-1" };
  }

  it("retains a task's files across turns without sharing them with another task or company", async () => {
    const identity = await setup();
    const cwd = await materializeIsolatedTaskDirectory(identity);
    await writeFile(path.join(cwd, "notes.txt"), "private task output");
    expect(await materializeIsolatedTaskDirectory(identity)).toBe(cwd);
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe("private task output");
    for (const other of [{ issueId: "issue-2" }, { companyId: "company-2" }]) {
      const otherCwd = await materializeIsolatedTaskDirectory({ ...identity, ...other });
      expect(otherCwd).not.toBe(cwd);
      expect(otherCwd.startsWith(`${cwd}${path.sep}`)).toBe(false);
      expect(await readdir(otherCwd)).toEqual([]);
    }
  });

  it("rejects a symlink to another task's directory", async () => {
    const identity = await setup();
    const cwd = await materializeIsolatedTaskDirectory(identity);
    await symlink(cwd, path.join(path.dirname(cwd), "issue-2"));
    await expect(materializeIsolatedTaskDirectory({ ...identity, issueId: "issue-2" }))
      .rejects.toThrow("not a private directory");
  });

  it("round-trips sandbox output into the task directory and stages it on the next turn", async () => {
    const identity = await setup();
    const cwd = await materializeIsolatedTaskDirectory(identity);
    // Only provider I/O is emulated. Production archive, ignore, sync-back and
    // merge logic runs against distinct host and remote filesystem roots.
    const transfer = async (operations: SandboxSyncOperation[]) => ({
      operations: await Promise.all(operations.map(async (operation) => {
        for (const file of operation.files) {
          await mkdir(path.dirname(file.targetPath), { recursive: true });
          await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: file.followSymlinks ?? false });
        }
        for (const command of operation.postUploadCommands ?? []) {
          await execFile("sh", ["-c", command.command]);
        }
        return { operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred: 0 };
      })),
    });
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (target) => { await mkdir(target, { recursive: true }); },
      writeFile: async (target, bytes) => { await writeFile(target, Buffer.from(bytes)); },
      readFile: async (target) => readFile(target),
      listFiles: async (target) => readdir(target),
      remove: async (target) => { await rm(target, { recursive: true, force: true }); },
      run: async (command) => { await execFile("sh", ["-c", command]); },
      syncIn: transfer,
      syncOut: transfer,
    };
    for (let turn = 0; turn < 2; turn += 1) {
      const remoteCwd = path.join(root!, `sandbox-${turn}`);
      const runtime = await prepareSandboxManagedRuntime({
        spec: { transport: "sandbox", provider: "test", sandboxId: `turn-${turn}`, remoteCwd, timeoutMs: 30_000, apiKey: null },
        adapterKey: "test",
        client,
        workspaceLocalDir: cwd,
      });
      if (turn === 0) {
        await writeFile(path.join(remoteCwd, "result.txt"), "created in sandbox");
      } else {
        expect(await readFile(path.join(remoteCwd, "result.txt"), "utf8")).toBe("created in sandbox");
        await writeFile(path.join(remoteCwd, "result.txt"), "continued in a new sandbox");
      }
      await runtime.restoreWorkspace();
    }
    expect(await readFile(path.join(cwd, "result.txt"), "utf8")).toBe("continued in a new sandbox");
    const other = await materializeIsolatedTaskDirectory({ ...identity, issueId: "issue-2" });
    expect(await readdir(other)).toEqual([]);
  });

  it("rejects path traversal identities", async () => {
    const identity = await setup();
    await expect(materializeIsolatedTaskDirectory({ ...identity, issueId: "../outside" }))
      .rejects.toThrow("Invalid isolated task workspace identity");
  });
});

describe("Core isolated task path detection", () => {
  let root: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-detect-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    return { companyId: "company-1", issueId: "issue-1" };
  }

  it("recognizes exactly the writers' task, attempt, and seed layouts", async () => {
    const identity = await setup();
    const taskRoot = await materializeIsolatedTaskDirectory(identity);
    expect(await isCoreIsolatedTaskWorkspacePath(taskRoot)).toBe(true);
    const attemptRoot = await materializeIsolatedTaskDirectory({ ...identity, attemptId: "11111111-1111-4111-8111-111111111111" });
    expect(await isCoreIsolatedTaskWorkspacePath(attemptRoot)).toBe(true);
    const seeded = path.join(attemptRoot, "workspace");
    await mkdir(seeded, { mode: 0o700 });
    expect(await isCoreIsolatedTaskWorkspacePath(seeded)).toBe(true);
  });

  it.each([
    "missing directories below the instance root",
    "the instance root itself",
    "an agent home, project workspace, or worktree path inside the instance root",
    "a path outside the instance root",
    "an attempt directory one level too deep",
  ])("rejects %s", async () => {
    const identity = await setup();
    const taskRoot = await materializeIsolatedTaskDirectory(identity);
    const outside = await mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-outside-"));
    const deep = path.join(taskRoot, "nested");
    await mkdir(deep, { recursive: true });
    const candidates = [
      path.join(root!, "isolated-workspaces", "company-1"),
      root!,
      path.join(root!, "workspaces", "agent-1"),
      path.join(root!, "projects", "company-1", "project-1", "repo"),
      outside,
      deep,
      undefined,
      null,
      "  ",
    ];
    for (const candidate of candidates) {
      expect(await isCoreIsolatedTaskWorkspacePath(candidate)).toBe(false);
    }
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a task path reached through a symlink", async () => {
    const identity = await setup();
    const taskRoot = await materializeIsolatedTaskDirectory(identity);
    const linkRoot = path.join(root!, "isolated-workspaces", "company-2");
    await mkdir(linkRoot, { recursive: true });
    await symlink(taskRoot, path.join(linkRoot, "issue-1"));
    expect(await isCoreIsolatedTaskWorkspacePath(path.join(linkRoot, "issue-1"))).toBe(false);
  });
});
