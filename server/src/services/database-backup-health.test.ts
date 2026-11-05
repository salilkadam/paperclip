import { mkdtempSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  inspectDatabaseBackupHealth,
  resetDatabaseBackupHealthInspectionCache,
} from "./database-backup-health.js";

const NOW = new Date("2026-11-05T08:00:00.000Z");

// A never-resolving fsp.readFile models a saturated mount (e.g. NFS serving
// hundreds of megabytes of hourly pg_dump writes while kubelet probes
// /health). The mock only swaps readFile; every other fs call stays real, so
// the sweep runs against real temp directories and can only block at the
// marker read.
const hangControl = vi.hoisted(() => ({ readFileHangs: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      hangControl.readFileHangs
        ? new Promise<never>(() => {})
        : (actual.readFile as (...a: unknown[]) => Promise<unknown>)(...args),
  } as typeof actual;
});

function makeBackupDir(backupAgeMinutes: number) {
  const dir = mkdtempSync(join(tmpdir(), "db-backup-health-"));
  const name = "paperclip-20261105-070000.sql.gz";
  const file = join(dir, name);
  writeFileSync(file, "compressed-bytes");
  const mtime = NOW.getTime() / 1000 - backupAgeMinutes * 60;
  utimesSync(file, mtime, mtime);
  return { dir, file };
}

describe("inspectDatabaseBackupHealth", () => {
  let dir: string | undefined;

  beforeEach(() => {
    hangControl.readFileHangs = false;
    resetDatabaseBackupHealthInspectionCache();
  });

  afterEach(() => {
    hangControl.readFileHangs = false;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    resetDatabaseBackupHealthInspectionCache();
  });

  it("reports the latest backup with ok status", async () => {
    const made = makeBackupDir(30);
    dir = made.dir;

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
    expect(result.latestBackup?.name).toBe("paperclip-20261105-070000.sql.gz");
    expect(result.latestBackup?.ageHours).toBeCloseTo(0.5, 5);
    expect(result.latestBackup?.sizeBytes).toBeGreaterThan(0);
  });

  it("warns when the latest backup is stale", async () => {
    const made = makeBackupDir(60 * 30);
    dir = made.dir;

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.status).toBe("warning");
    expect(result.warnings.map((w) => w.code)).toEqual(["database_backup_stale"]);
  });

  it("reports an S3 failure marker", async () => {
    const made = makeBackupDir(5);
    dir = made.dir;
    writeFileSync(join(dir, "db-backup-to-s3.failure"), "upload rejected\nsecond line");

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.lastFailure?.message).toBe("upload rejected");
    expect(result.warnings.map((w) => w.code)).toEqual(["database_backup_last_failure"]);
  });

  it("warns when no backups exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "db-backup-health-empty-"));

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(result.warnings.map((w) => w.code)).toEqual(["database_backup_missing"]);
  });

  it("serves the cached healthy result when a sweep exceeds its budget", async () => {
    const made = makeBackupDir(10);
    dir = made.dir;

    const good = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
    });
    expect(good.status).toBe("ok");

    const alertFile = join(dir, "db-backup-to-s3.failure");
    writeFileSync(alertFile, "upload rejected");
    hangControl.readFileHangs = true;

    const start = Date.now();
    const degraded = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
      alertFile,
      timeoutMs: 100,
    });
    const elapsedMs = Date.now() - start;

    // Bounded response despite the hung filesystem read.
    expect(elapsedMs).toBeLessThan(5_000);
    // Falls back to the last-known-good healthy inspection instead of a probe
    // timeout or a check-failed warning.
    expect(degraded).toEqual(good);
  });

  it("falls back to check_failed when a sweep times out with no cached result", async () => {
    const made = makeBackupDir(10);
    dir = made.dir;
    const alertFile = join(dir, "db-backup-to-s3.failure");
    writeFileSync(alertFile, "upload rejected");
    hangControl.readFileHangs = true;

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
      alertFile,
      timeoutMs: 100,
    });

    expect(result.status).toBe("warning");
    expect(result.warnings.map((w) => w.code)).toEqual(["database_backup_check_failed"]);
    expect(result.warnings[0]?.message).toContain("timed out");
    expect(result.latestBackup).toBeNull();
  });

  it("ignores an expired cached result after a timeout", async () => {
    const made = makeBackupDir(10);
    dir = made.dir;

    await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
    });
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));

    const alertFile = join(dir, "db-backup-to-s3.failure");
    writeFileSync(alertFile, "upload rejected");
    hangControl.readFileHangs = true;

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
      alertFile,
      timeoutMs: 100,
      cacheMaxAgeMs: 0,
    });

    expect(result.warnings.map((w) => w.code)).toEqual(["database_backup_check_failed"]);
  });
});
