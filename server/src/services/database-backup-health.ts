import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_last_failure"
  | "database_backup_missing"
  | "database_backup_stale";

export type DatabaseBackupHealthWarning = {
  code: DatabaseBackupHealthWarningCode;
  message: string;
};

export type DatabaseBackupHealthStatus = {
  enabled: boolean;
  status: "ok" | "warning";
  backupDir: string;
  maxAgeHours: number;
  latestBackup: {
    name: string;
    path: string;
    mtime: string;
    ageHours: number;
    sizeBytes: number;
  } | null;
  lastFailure: {
    path: string;
    mtime: string;
    message: string;
  } | null;
  warnings: DatabaseBackupHealthWarning[];
};

export type InspectDatabaseBackupHealthOptions = {
  enabled: boolean;
  backupDir: string;
  maxAgeHours: number;
  alertFile?: string;
  alertFiles?: string[];
  now?: Date;
};

/**
 * The backup directory can sit on a slow network mount and hold hundreds of
 * dump files, so scanning it is expensive. Health checks call this endpoint
 * frequently; cache successful scans so a slow mount cannot turn every probe
 * into a full directory walk. Explicit `now` callers (tests, one-shot checks)
 * bypass the cache and always observe current filesystem state.
 */
const HEALTH_CACHE_TTL_MS = 60_000;
const healthCache = new Map<string, { expiresAt: number; value: DatabaseBackupHealthStatus }>();
const healthInFlight = new Map<string, Promise<DatabaseBackupHealthStatus>>();

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function alertFileCandidates(opts: InspectDatabaseBackupHealthOptions) {
  return [...new Set([
    opts.alertFile,
    ...(opts.alertFiles ?? []),
    join(opts.backupDir, "db-backup-to-s3.failure"),
    resolve(opts.backupDir, "..", "db-backup-to-s3.failure"),
  ].filter((value): value is string => Boolean(value)))];
}

async function readLastFailure(alertFiles: string[]) {
  const results = await Promise.all(alertFiles.map(async (alertFile) => {
    try {
      const alertStat = await stat(alertFile);
      const raw = await readFile(alertFile, "utf8");
      return {
        path: alertFile,
        mtime: new Date(alertStat.mtimeMs).toISOString(),
        mtimeMs: alertStat.mtimeMs,
        message: raw.trim().split(/\r?\n/)[0] || "Database backup failure marker is present.",
      };
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }));
  const failures = results
    .filter((failure): failure is NonNullable<typeof failure> => failure !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = failures[0];
  if (!latest) return null;
  return {
    path: latest.path,
    mtime: latest.mtime,
    message: latest.message,
  };
}

async function findLatestBackup(backupDir: string, nowMs: number) {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }

  const candidates = await Promise.all(
    names
      .filter((name) => name.endsWith(".sql.gz"))
      .map(async (name) => {
        const fullPath = join(backupDir, name);
        const entryStat = await stat(fullPath);
        return { fullPath, name, mtimeMs: entryStat.mtimeMs, size: entryStat.size };
      }),
  );

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const latest = candidates[0];
  if (!latest) return null;

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtime: new Date(latest.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - latest.mtimeMs) / 3_600_000),
    sizeBytes: latest.size,
  };
}

async function inspectDatabaseBackupHealthUncached(
  opts: InspectDatabaseBackupHealthOptions,
): Promise<DatabaseBackupHealthStatus> {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);

  let latestBackup: DatabaseBackupHealthStatus["latestBackup"] = null;
  let lastFailure: DatabaseBackupHealthStatus["lastFailure"] = null;

  try {
    latestBackup = await findLatestBackup(opts.backupDir, now.getTime());
    lastFailure = await readLastFailure(alertFileCandidates(opts));

    if (!latestBackup) {
      warnings.push({
        code: "database_backup_missing",
        message: `No .sql.gz database backups found in ${opts.backupDir}.`,
      });
    } else if (latestBackup.ageHours > maxAgeHours) {
      warnings.push({
        code: "database_backup_stale",
        message: `Latest database backup is ${latestBackup.ageHours}h old, exceeding ${maxAgeHours}h.`,
      });
    }

    if (lastFailure) {
      warnings.push({
        code: "database_backup_last_failure",
        message: lastFailure.message,
      });
    }
  } catch (error) {
    warnings.push({
      code: "database_backup_check_failed",
      message: `Database backup health check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return {
    enabled: opts.enabled,
    status: warnings.length > 0 ? "warning" : "ok",
    backupDir: opts.backupDir,
    maxAgeHours,
    latestBackup,
    lastFailure,
    warnings,
  };
}

export function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): Promise<DatabaseBackupHealthStatus> {
  if (opts.now) {
    return inspectDatabaseBackupHealthUncached(opts);
  }

  const cacheKey = JSON.stringify([
    opts.enabled,
    opts.backupDir,
    opts.maxAgeHours,
    opts.alertFile ?? null,
    opts.alertFiles ?? null,
  ]);

  const cached = healthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

  const inFlight = healthInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const pending = inspectDatabaseBackupHealthUncached(opts)
    .then((value) => {
      if (!value.warnings.some((warning) => warning.code === "database_backup_check_failed")) {
        healthCache.set(cacheKey, { expiresAt: Date.now() + HEALTH_CACHE_TTL_MS, value });
      }
      return value;
    })
    .finally(() => {
      healthInFlight.delete(cacheKey);
    });
  healthInFlight.set(cacheKey, pending);
  return pending;
}
