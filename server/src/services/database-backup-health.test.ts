import { mkdtempSync, mkfifoSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inspectDatabaseBackupHealth,
  resetDatabaseBackupHealthInspectionCache,
} from "./database-backup-health.js";

const NOW = new Date("2026-11-05T08:00:00.000Z");

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
  let hangingFifos: string[] = [];

  beforeEach(() => {
    resetDatabaseBackupHealthInspectionCache();
  });

  afterEach(async () => {
    // A pending fsp.readFile on a FIFO parks a libuv threadpool thread until a
    // writer arrives. Open and close a writer side so the thread is released
    // even though the timed-out sweep promise stays pending forever.
    await Promise.all(hangingFifos.map(async (fifo) => {
      try {
        const handle = await Promise.race([
          fsOpen(fifo, "w"),
          new Promise<undefined>((resolveTimer) => setTimeout(() => resolveTimer(undefined), 2_000)),
        ]);
        await handle?.close();
      } catch {
        // best effort
      }
    }));
    hangingFifos = [];
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

  // A FIFO with no writer makes fsp.readFile block indefinitely — a
  // deterministic stand-in for a saturated mount (e.g. NFS serving a
  // multi-hundred-MB pg_dump write while kubelet probes /health).
  function makeHangingAlertFile(parent: string) {
    const fifo = join(parent, "hang.failure");
    mkfifoSync(fifo);
    hangingFifos.push(fifo);
    return fifo;
  }

  it("serves the cached healthy result when a sweep exceeds its budget", async () => {
    const made = makeBackupDir(10);
    dir = made.dir;
    const alertFile = makeHangingAlertFile(dir);

    const good = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
    });
    expect(good.status).toBe("ok");

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
    const alertFile = makeHangingAlertFile(dir);

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
    expect(result.latestBackup).toBeNull();
  });

  it("ignores an expired cached result after a timeout", async () => {
    const made = makeBackupDir(10);
    dir = made.dir;
    const alertFile = makeHangingAlertFile(dir);

    await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
      now: NOW,
    });
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));

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
