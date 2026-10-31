import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCachedDatabaseBackupHealth,
  inspectDatabaseBackupHealth,
  inspectDatabaseBackupHealthAsync,
} from "../database-backup-health.js";

async function makeBackupDir(options: { files?: Array<{ name: string; mtimeMs: number }> } = {}) {
  const backupDir = await mkdtemp(join(tmpdir(), "paperclip-backup-health-"));
  for (const file of options.files ?? []) {
    const fullPath = join(backupDir, file.name);
    await writeFile(fullPath, "backup");
    await utimes(fullPath, new Date(file.mtimeMs), new Date(file.mtimeMs));
  }
  return backupDir;
}

const NOW = new Date("2026-07-06T04:00:00.000Z");

async function waitForRefresh(
  opts: { enabled: boolean; backupDir: string; maxAgeHours: number },
  deps: { ttlMs: number; now: () => number },
  expectedName: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await getCachedDatabaseBackupHealth(opts, deps);
    if (status.latestBackup?.name === expectedName) return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`backup health cache never refreshed to ${expectedName}`);
}

describe("inspectDatabaseBackupHealthAsync", () => {
  it("matches the sync inspector for a fresh backup", async () => {
    const backupDir = await makeBackupDir({
      files: [{ name: "paperclip-20260706-031702.sql.gz", mtimeMs: NOW.getTime() - 43 * 60_000 }],
    });
    const opts = { enabled: true, backupDir, maxAgeHours: 26, now: NOW };

    const sync = inspectDatabaseBackupHealth(opts);
    const async = await inspectDatabaseBackupHealthAsync(opts);

    expect(async).toEqual(sync);
    expect(async.status).toBe("ok");
    expect(async.latestBackup?.name).toBe("paperclip-20260706-031702.sql.gz");
  });

  it("reports missing backups when the directory does not exist", async () => {
    const backupDir = join(await makeBackupDir(), "missing");
    const status = await inspectDatabaseBackupHealthAsync({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(status.status).toBe("warning");
    expect(status.warnings.map((warning) => warning.code)).toEqual(["database_backup_missing"]);
  });

  it("reports stale backups", async () => {
    const backupDir = await makeBackupDir({
      files: [{ name: "paperclip-20260701-031702.sql.gz", mtimeMs: NOW.getTime() - 50 * 3_600_000 }],
    });
    const status = await inspectDatabaseBackupHealthAsync({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(status.warnings.map((warning) => warning.code)).toEqual(["database_backup_stale"]);
  });

  it("surfaces backup alert files", async () => {
    const backupDir = await makeBackupDir({
      files: [{ name: "paperclip-20260706-031702.sql.gz", mtimeMs: NOW.getTime() - 60_000 }],
    });
    const alertFile = join(backupDir, "db-backup-to-s3.failure");
    await writeFile(alertFile, "upload to s3 failed\n");

    const status = await inspectDatabaseBackupHealthAsync({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      alertFile,
      now: NOW,
    });

    expect(status.lastFailure?.message).toBe("upload to s3 failed");
    expect(status.warnings.map((warning) => warning.code)).toEqual(["database_backup_last_failure"]);
  });

  it("ignores entries that are not database backups", async () => {
    const backupDir = await makeBackupDir({
      files: [
        { name: "paperclip-20260706-031702.sql.gz", mtimeMs: NOW.getTime() - 60_000 },
        { name: "rel-staged-build.tar.gz", mtimeMs: NOW.getTime() },
        { name: "paperclip-20260706-031702.sql.gz.partial", mtimeMs: NOW.getTime() },
      ],
    });
    const status = await inspectDatabaseBackupHealthAsync({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });

    expect(status.latestBackup?.name).toBe("paperclip-20260706-031702.sql.gz");
    expect(status.status).toBe("ok");
  });
});

describe("getCachedDatabaseBackupHealth", () => {
  it("answers repeated probes from the cache and serves stale snapshots while refreshing", async () => {
    const backupDir = await makeBackupDir({
      files: [{ name: "paperclip-20260706-031702.sql.gz", mtimeMs: NOW.getTime() - 60_000 }],
    });
    const opts = { enabled: true, backupDir, maxAgeHours: 26 };
    let clock = NOW.getTime();
    const deps = { ttlMs: 30_000, now: () => clock };

    const first = await getCachedDatabaseBackupHealth(opts, deps);
    expect(first.latestBackup?.name).toBe("paperclip-20260706-031702.sql.gz");

    // A newer backup lands (the hourly backup finishing) — probes stay cached.
    const newer = join(backupDir, "paperclip-20260706-040000.sql.gz");
    await writeFile(newer, "backup");
    await utimes(newer, new Date(NOW.getTime()), new Date(NOW.getTime()));

    const cached = await getCachedDatabaseBackupHealth(opts, deps);
    expect(cached.latestBackup?.name).toBe("paperclip-20260706-031702.sql.gz");

    // After the TTL the probe still gets the stale snapshot immediately and
    // the refresh lands in the background.
    clock += 30_001;
    const staleServed = await getCachedDatabaseBackupHealth(opts, deps);
    expect(staleServed.latestBackup?.name).toBe("paperclip-20260706-031702.sql.gz");

    const refreshed = await waitForRefresh(opts, deps, "paperclip-20260706-040000.sql.gz");
    expect(refreshed.latestBackup?.name).toBe("paperclip-20260706-040000.sql.gz");
  });

  it("bypasses the cache for deterministic callers that inject now", async () => {
    const backupDir = await makeBackupDir({
      files: [{ name: "paperclip-20260706-031702.sql.gz", mtimeMs: NOW.getTime() - 60_000 }],
    });
    const first = await getCachedDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });
    expect(first.latestBackup?.name).toBe("paperclip-20260706-031702.sql.gz");

    const newer = join(backupDir, "paperclip-20260706-040000.sql.gz");
    await writeFile(newer, "backup");
    await utimes(newer, new Date(NOW.getTime()), new Date(NOW.getTime()));

    const second = await getCachedDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: NOW,
    });
    expect(second.latestBackup?.name).toBe("paperclip-20260706-040000.sql.gz");
  });

  it("keeps cache entries per backup directory", async () => {
    const dirA = await makeBackupDir({
      files: [{ name: "paperclip-20260706-010000.sql.gz", mtimeMs: NOW.getTime() - 60_000 }],
    });
    const dirB = await makeBackupDir({
      files: [{ name: "paperclip-20260706-020000.sql.gz", mtimeMs: NOW.getTime() - 60_000 }],
    });
    const deps = { ttlMs: 30_000, now: () => NOW.getTime() };

    const a = await getCachedDatabaseBackupHealth({ enabled: true, backupDir: dirA, maxAgeHours: 26 }, deps);
    const b = await getCachedDatabaseBackupHealth({ enabled: true, backupDir: dirB, maxAgeHours: 26 }, deps);

    expect(a.latestBackup?.name).toBe("paperclip-20260706-010000.sql.gz");
    expect(b.latestBackup?.name).toBe("paperclip-20260706-020000.sql.gz");
  });
});
