import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseObject } from "../adapters/utils.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** A repository-free sandbox task needs isolation, but has no Git base. */
export function shouldUseIsolatedTaskDirectory(input: {
  trustPreset: string;
  environmentDriver: string | null;
  mode: string;
  hasProjectWorkspace: boolean;
  projectWorkspaceId: string | null;
  workspaceStrategies: unknown[];
}): boolean {
  return input.trustPreset === "low_trust_review"
    && input.environmentDriver === "sandbox"
    && input.mode === "isolated_workspace"
    && !input.hasProjectWorkspace
    && !input.projectWorkspaceId
    // Never discard an explicit repository/branch requirement or setup hook.
    && input.workspaceStrategies.every((value) => Object.keys(parseObject(value)).length === 0);
}

/** The two Core-owned task namespaces: the retained root and its retry siblings. */
export const ISOLATED_TASK_WORKSPACE_DIRS = ["isolated-workspaces", "isolated-workspace-attempts"] as const;

/** Stable across turns, separate from project roots and shared agent homes. */
export async function materializeIsolatedTaskDirectory(input: {
  companyId: string;
  issueId: string;
  attemptId?: string;
}): Promise<string> {
  // Files belong to the task, so reassignment preserves the same workspace.
  const identities = [input.companyId, input.issueId, ...(input.attemptId ? [input.attemptId] : [])];
  if (identities.some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new Error("Invalid isolated task workspace identity");
  }
  const root = resolvePaperclipInstanceRoot();
  await mkdir(root, { recursive: true });
  let cwd = await realpath(root);
  // A retry is a sibling namespace, never a descendant of the retained root.
  // An old copyback operation must not be able to overwrite its replacement.
  for (const segment of [input.attemptId ? ISOLATED_TASK_WORKSPACE_DIRS[1] : ISOLATED_TASK_WORKSPACE_DIRS[0], ...identities]) {
    cwd = path.join(cwd, segment);
    await mkdir(cwd, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cwd) !== cwd) {
      throw new Error("Isolated task workspace path is not a private directory");
    }
  }
  return cwd;
}

/**
 * True only for the exact private task paths the Core writers create (a
 * retained task root, one retry attempt, or the seeded workspace under an
 * attempt) — layout `isolated-workspaces/<company>/<issue>`,
 * `isolated-workspace-attempts/<company>/<issue>/<attempt>` and its
 * `<attempt>/workspace` seed. Never match project, agent-home, or worktree
 * paths that merely sit inside the instance root — those can be legitimate
 * Git bases.
 */
export async function isCoreIsolatedTaskWorkspacePath(cwd: string | null | undefined): Promise<boolean> {
  const candidate = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  if (!candidate) return false;
  const instanceRoot = await realpath(resolvePaperclipInstanceRoot()).catch(() => null);
  if (!instanceRoot) return false;
  let relative: string;
  try {
    relative = path.relative(instanceRoot, path.resolve(candidate));
  } catch {
    return false;
  }
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const parts = relative.split(path.sep);
  const shapeOk = (parts.length === 3 && ISOLATED_TASK_WORKSPACE_DIRS.includes(parts[0] as (typeof ISOLATED_TASK_WORKSPACE_DIRS)[number]))
    || (parts.length === 4 && parts[0] === "isolated-workspace-attempts")
    || (parts.length === 5 && parts[0] === "isolated-workspace-attempts" && parts[4] === "workspace");
  if (!shapeOk) return false;
  // Honor the private-directory invariant: an intermediate symlink that points
  // elsewhere is not the task path the Core writers created.
  let cursor = instanceRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor).catch(() => null);
    if (!stat || !stat.isDirectory()) return false;
    const resolved = await realpath(cursor).catch(() => null);
    if (!resolved || resolved !== cursor) return false;
  }
  return true;
}
