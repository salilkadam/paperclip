import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
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

  it("restores the original copy and rethrows when linking fails", async () => {
    const { source, target } = await setup();
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "stale\n");
    const failingLink = async () => {
      throw Object.assign(new Error("symlinks unavailable"), { code: "EPERM" });
    };
    await expect(ensurePaperclipSkillSymlink(source, target, failingLink)).rejects.toThrow("symlinks unavailable");
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("stale\n");
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
