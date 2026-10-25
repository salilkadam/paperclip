import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePaperclipSkillSymlink } from "./server-utils.js";

// The shared skills home in production held a real `trypost` directory from
// before the gateway-header fix. ensurePaperclipSkillSymlink returned
// "skipped" for it, so every agent read the stale copy and every TryPost call
// failed with 401. These tests pin the replacement rules.
describe("ensurePaperclipSkillSymlink with an unmanaged copy at the target", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-skill-symlink-"));
    roots.push(root);
    const source = path.join(root, "app", "skills", "trypost");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "X-Paperclip-Tool-Gateway-Token\n");
    const skillsHome = path.join(root, "home", ".claude", "skills");
    await mkdir(skillsHome, { recursive: true });
    const target = path.join(skillsHome, "trypost");
    return { root, source, skillsHome, target };
  }

  it("replaces a differing real directory with a link and keeps a backup outside the skills home", async () => {
    const { root, source, skillsHome, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "Authorization: Bearer <sessionToken>\n");

    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("replaced");

    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readlink(target)).toBe(source);
    const backupRoot = path.join(root, "home", ".claude", "skills-replaced");
    const backups = await readdir(backupRoot);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^trypost-/);
    expect(await readFile(path.join(backupRoot, backups[0]!, "SKILL.md"), "utf8")).toBe(
      "Authorization: Bearer <sessionToken>\n",
    );
    // The backup must not be loadable as a second skill.
    expect(await readdir(skillsHome)).toEqual(["trypost"]);
  });

  it("replaces a stray regular file at the target", async () => {
    const { source, target } = await setup();
    await writeFile(target, "not a skill");
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("replaced");
    expect(await readlink(target)).toBe(source);
  });

  it("leaves an identical copy alone", async () => {
    const { source, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "X-Paperclip-Tool-Gateway-Token\n");
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
    expect((await lstat(target)).isDirectory()).toBe(true);
  });

  it("leaves a Paperclip-materialized copy alone even when it differs", async () => {
    const { root, source, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "older materialized content\n");
    await writeFile(path.join(target, ".paperclip-materialized-skill.json"), JSON.stringify({ version: 1, sourceFingerprint: "old" }));
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
    expect((await lstat(target)).isDirectory()).toBe(true);
    await expect(readdir(path.join(root, "home", ".claude", "skills-replaced"))).rejects.toThrow();
  });

  it("keeps the backup and leaves the target empty when linking fails", async () => {
    // The acpx EPERM fallback materializes into the target with fs.rm first, so
    // putting the stale copy back would let that fallback destroy it unbacked.
    const { root, source, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "stale\n");
    const failingLink = async () => {
      throw Object.assign(new Error("symlinks unavailable"), { code: "EPERM" });
    };
    await expect(ensurePaperclipSkillSymlink(source, target, failingLink)).rejects.toThrow("symlinks unavailable");
    await expect(lstat(target)).rejects.toThrow();
    const backupRoot = path.join(root, "home", ".claude", "skills-replaced");
    const backups = await readdir(backupRoot);
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(backupRoot, backups[0]!, "SKILL.md"), "utf8")).toBe("stale\n");
  });

  it("puts the original back when linking fails for a reason other than EPERM", async () => {
    // opencode_local (production) has no materialize fallback: losing the old
    // skill and installing nothing would be worse than keeping it.
    const { root, source, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "stale\n");
    const failingLink = async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    await expect(ensurePaperclipSkillSymlink(source, target, failingLink)).rejects.toThrow("permission denied");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("stale\n");
    expect(await readdir(path.join(root, "home", ".claude", "skills-replaced"))).toEqual([]);
  });

  it("creates nothing beside the skills home for an identical copy", async () => {
    const { root, source, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "X-Paperclip-Tool-Gateway-Token\n");
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
    await expect(readdir(path.join(root, "home", ".claude", "skills-replaced"))).rejects.toThrow();
  });

  it("converges without errors when many runs race on the same stale copy", async () => {
    const { root, source, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "stale\n");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ensurePaperclipSkillSymlink(source, target)),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(results.map((r) => (r as PromiseFulfilledResult<string>).value)).toContain("replaced");
    expect(await readlink(target)).toBe(source);
    expect(await readdir(path.join(root, "home", ".claude", "skills-replaced"))).toHaveLength(1);
  });

  it("treats a concurrent run's link (EEXIST) as done, not as a failure", async () => {
    const { source, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "stale\n");
    const raceLink = async (src: string, dst: string) => {
      await symlink(src, dst); // the other run wins
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    await expect(ensurePaperclipSkillSymlink(source, target, raceLink)).resolves.toBe("skipped");
    expect(await readlink(target)).toBe(source);
  });

  it("leaves a real directory alone when the managed source is missing", async () => {
    const { root, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "stale\n");
    await expect(ensurePaperclipSkillSymlink(path.join(root, "missing"), target)).resolves.toBe("skipped");
    expect((await lstat(target)).isDirectory()).toBe(true);
  });

  it("keeps the existing created / skipped / repaired behaviour", async () => {
    const { root, source, target } = await setup();
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("created");
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");

    await rm(target);
    await symlink(path.join(root, "gone"), target);
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("repaired");
    expect(await readlink(target)).toBe(source);
  });
});

describe("ensurePaperclipSkillSymlink with a link to another existing copy", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // Production after rev 65: ~/.claude/skills/trypost -> a company-skill copy
  // imported before trypost was bundled. The old code skipped any link whose
  // target still existed, so agents kept the pre-fix gateway header.
  async function setup(oldContent: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-skill-relink-"));
    roots.push(root);
    const source = path.join(root, "app", "skills", "trypost");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "X-Paperclip-Tool-Gateway-Token\n");
    const old = path.join(root, "instances", "skills", "company-a", "trypost");
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, "SKILL.md"), oldContent);
    const skillsHome = path.join(root, "home", ".claude", "skills");
    await mkdir(skillsHome, { recursive: true });
    const target = path.join(skillsHome, "trypost");
    await symlink(old, target);
    return { root, source, old, skillsHome, target };
  }

  it("re-points a link whose target differs from the source and keeps the old copy", async () => {
    const { source, old, skillsHome, target } = await setup("Authorization: Bearer <sessionToken>\n");
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("repaired");
    expect(await readlink(target)).toBe(source);
    expect(await readFile(path.join(old, "SKILL.md"), "utf8")).toBe("Authorization: Bearer <sessionToken>\n");
    expect(await readdir(skillsHome)).toEqual(["trypost"]);
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
  });

  it("leaves a link to an identical copy alone", async () => {
    const { source, old, target } = await setup("X-Paperclip-Tool-Gateway-Token\n");
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
    expect(await readlink(target)).toBe(old);
  });

  it("never re-points away from an immutable __versions__ pin, so two sources converge", async () => {
    const { root, source, target } = await setup("unused\n");
    const pinned = path.join(root, "instances", "skills", "company-b", "__versions__", "skill-1", "version-1");
    await mkdir(pinned, { recursive: true });
    await writeFile(path.join(pinned, "SKILL.md"), "pinned older version\n");
    await rm(target);
    await symlink(pinned, target);
    // Agents with different sources alternate; the pin must win every time.
    for (let i = 0; i < 4; i += 1) {
      await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
      await expect(ensurePaperclipSkillSymlink(pinned, target)).resolves.toBe("skipped");
    }
    expect(await readlink(target)).toBe(pinned);
  });

  it("treats a mode-only difference as identical (read-only pinned copies)", async () => {
    const { source, old, target } = await setup("X-Paperclip-Tool-Gateway-Token\n");
    await chmod(path.join(old, "SKILL.md"), 0o444);
    await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
    expect(await readlink(target)).toBe(old);
  });

  it("skips (does not throw) when the linked copy cannot be read", async () => {
    const { source, old, target } = await setup("stale\n");
    const locked = path.join(old, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await expect(ensurePaperclipSkillSymlink(source, target)).resolves.toBe("skipped");
      expect(await readlink(target)).toBe(old);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it("leaves no staging link when linking fails after creating it", async () => {
    const { source, old, root, target } = await setup("stale\n");
    const partialLink = async (src: string, dst: string) => {
      await symlink(src, dst);
      throw new Error("failed after linking");
    };
    await expect(ensurePaperclipSkillSymlink(source, target, partialLink)).rejects.toThrow("failed after linking");
    expect(await readlink(target)).toBe(old);
    const staging = await readdir(path.join(root, "home", ".claude", "skills-replaced")).catch(() => []);
    expect(staging.filter((name) => name.includes(".link-"))).toEqual([]);
  });

  it("keeps the original link when the new link cannot be made", async () => {
    const { source, old, root, target } = await setup("stale\n");
    const failingLink = async () => {
      throw Object.assign(new Error("symlinks unavailable"), { code: "EPERM" });
    };
    await expect(ensurePaperclipSkillSymlink(source, target, failingLink)).rejects.toThrow("symlinks unavailable");
    expect(await readlink(target)).toBe(old);
    const staging = await readdir(path.join(root, "home", ".claude", "skills-replaced")).catch(() => []);
    expect(staging.filter((name) => name.includes(".link-"))).toEqual([]);
  });
});
