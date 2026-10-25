import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseBackupHealth } from "./database-backup-health.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-backup-health-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeBackup(backupDir: string, name: string, mtime: Date): string {
  const fullPath = path.join(backupDir, name);
  fs.writeFileSync(fullPath, "not-a-real-dump");
  fs.utimesSync(fullPath, mtime, mtime);
  return fullPath;
}

describe("inspectDatabaseBackupHealth", () => {
  it("reports ok with the newest backup and no warnings", async () => {
    const backupDir = createTempDir();
    const now = new Date("2026-01-10T12:00:00Z");
    writeBackup(backupDir, "paperclip-20260110-100000.sql.gz", new Date(now.getTime() - 120 * 60_000));
    writeBackup(backupDir, "paperclip-20260110-113000.sql.gz", new Date(now.getTime() - 30 * 60_000));

    const status = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now,
    });

    expect(status.status).toBe("ok");
    expect(status.warnings).toEqual([]);
    expect(status.latestBackup?.name).toBe("paperclip-20260110-113000.sql.gz");
    expect(status.latestBackup?.ageHours).toBe(0.5);
  });

  it("warns when no backups exist", async () => {
    const backupDir = createTempDir();
    const status = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date(),
    });
    expect(status.status).toBe("warning");
    expect(status.latestBackup).toBeNull();
    expect(status.warnings.map((warning) => warning.code)).toEqual(["database_backup_missing"]);
  });

  it("warns when backups are stale", async () => {
    const backupDir = createTempDir();
    const now = new Date("2026-01-10T12:00:00Z");
    writeBackup(backupDir, "paperclip-20260101-120000.sql.gz", new Date(now.getTime() - 240 * 3_600_000));

    const status = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now,
    });
    expect(status.warnings.map((warning) => warning.code)).toEqual(["database_backup_stale"]);
  });

  it("surfaces the newest failure marker", async () => {
    const backupDir = createTempDir();
    const now = new Date("2026-01-10T12:00:00Z");
    writeBackup(backupDir, "paperclip-20260110-113000.sql.gz", new Date(now.getTime() - 30 * 60_000));
    const marker = path.join(backupDir, "db-backup-to-s3.failure");
    fs.writeFileSync(marker, "upload failed\nsecond line ignored\n");
    fs.utimesSync(marker, now, now);

    const status = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now,
    });
    expect(status.lastFailure?.message).toBe("upload failed");
    expect(status.warnings.map((warning) => warning.code)).toContain("database_backup_last_failure");
  });

  it("reports a missing backup directory as missing, not as a check failure", async () => {
    const status = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: path.join(os.tmpdir(), "db-backup-health-does-not-exist"),
      maxAgeHours: 26,
      now: new Date(),
    });
    expect(status.warnings.map((warning) => warning.code)).toEqual(["database_backup_missing"]);
  });

  it("serves cached scans without explicit now and bypasses the cache with now", async () => {
    const backupDir = createTempDir();
    const fullPath = writeBackup(backupDir, "paperclip-20260110-113000.sql.gz", new Date("2026-01-10T11:30:00Z"));

    const first = await inspectDatabaseBackupHealth({ enabled: true, backupDir, maxAgeHours: 26 });
    expect(first.latestBackup?.name).toBe("paperclip-20260110-113000.sql.gz");

    fs.rmSync(fullPath);

    const cached = await inspectDatabaseBackupHealth({ enabled: true, backupDir, maxAgeHours: 26 });
    expect(cached).toBe(first);

    const fresh = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
      now: new Date(),
    });
    expect(fresh.latestBackup).toBeNull();
  });
});
