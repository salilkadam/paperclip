import { existsSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
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

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function alertFileCandidates(opts: InspectDatabaseBackupHealthOptions) {
  return [...new Set([
    opts.alertFile,
    ...(opts.alertFiles ?? []),
    join(opts.backupDir, "db-backup-to-s3.failure"),
    resolve(opts.backupDir, "..", "db-backup-to-s3.failure"),
  ].filter((value): value is string => Boolean(value)))];
}

function readLastFailure(alertFiles: string[]) {
  const failures = alertFiles
    .filter((alertFile) => existsSync(alertFile))
    .map((alertFile) => {
      const stat = statSync(alertFile);
      const message = readFileSync(alertFile, "utf8").trim().split(/\r?\n/)[0] ||
        "Database backup failure marker is present.";
      return {
        path: alertFile,
        mtime: new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs,
        message,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = failures[0];
  if (!latest) return null;
  return {
    path: latest.path,
    mtime: latest.mtime,
    message: latest.message,
  };
}

function findLatestBackup(backupDir: string, nowMs: number) {
  if (!existsSync(backupDir)) return null;

  const candidates = readdirSync(backupDir)
    .filter((name) => name.endsWith(".sql.gz"))
    .map((name) => {
      const fullPath = join(backupDir, name);
      const stat = statSync(fullPath);
      return { fullPath, name, stat };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const latest = candidates[0];
  if (!latest) return null;

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtime: new Date(latest.stat.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - latest.stat.mtimeMs) / 3_600_000),
    sizeBytes: latest.stat.size,
  };
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

// Async twin of `findLatestBackup` for request paths: `fs/promises` runs on the
// libuv pool instead of blocking the event loop, which matters because health
// checks read directories that can live on slow mounts (NFS) where a sync scan
// freezes the whole process for seconds.
async function findLatestBackupAsync(backupDir: string, nowMs: number) {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }

  const candidates = await Promise.all(
    names
      .filter((name) => name.endsWith(".sql.gz"))
      .map(async (name) => {
        const fullPath = join(backupDir, name);
        try {
          return { fullPath, name, stat: await stat(fullPath) };
        } catch (error) {
          // A backup pruned by retention between listing and stat is not an
          // error — the sync scan used to fail the whole check on that race.
          if (isNotFound(error)) return null;
          throw error;
        }
      }),
  );

  const sorted = candidates
    .filter((candidate): candidate is { fullPath: string; name: string; stat: Stats } => candidate !== null)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const latest = sorted[0];
  if (!latest) return null;

  return {
    name: basename(latest.fullPath),
    path: latest.fullPath,
    mtime: new Date(latest.stat.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - latest.stat.mtimeMs) / 3_600_000),
    sizeBytes: latest.stat.size,
  };
}

async function readLastFailureAsync(alertFiles: string[]) {
  const failures = (
    await Promise.all(
      alertFiles.map(async (alertFile) => {
        try {
          const [fileStat, contents] = await Promise.all([
            stat(alertFile),
            readFile(alertFile, "utf8"),
          ]);
          const message = contents.trim().split(/\r?\n/)[0] ||
            "Database backup failure marker is present.";
          return {
            path: alertFile,
            mtime: new Date(fileStat.mtimeMs).toISOString(),
            mtimeMs: fileStat.mtimeMs,
            message,
          };
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
      }),
    )
  )
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

function evaluateDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
  now: Date,
  read: {
    latestBackup: DatabaseBackupHealthStatus["latestBackup"];
    lastFailure: DatabaseBackupHealthStatus["lastFailure"];
  },
): DatabaseBackupHealthStatus {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const maxAgeHours = Math.max(1, opts.maxAgeHours);

  if (!read.latestBackup) {
    warnings.push({
      code: "database_backup_missing",
      message: `No .sql.gz database backups found in ${opts.backupDir}.`,
    });
  } else if (read.latestBackup.ageHours > maxAgeHours) {
    warnings.push({
      code: "database_backup_stale",
      message: `Latest database backup is ${read.latestBackup.ageHours}h old, exceeding ${maxAgeHours}h.`,
    });
  }

  if (read.lastFailure) {
    warnings.push({
      code: "database_backup_last_failure",
      message: read.lastFailure.message,
    });
  }

  return {
    enabled: opts.enabled,
    status: warnings.length > 0 ? "warning" : "ok",
    backupDir: opts.backupDir,
    maxAgeHours,
    latestBackup: read.latestBackup,
    lastFailure: read.lastFailure,
    warnings,
  };
}

export function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): DatabaseBackupHealthStatus {
  const now = opts.now ?? new Date();

  try {
    return evaluateDatabaseBackupHealth(opts, now, {
      latestBackup: findLatestBackup(opts.backupDir, now.getTime()),
      lastFailure: readLastFailure(alertFileCandidates(opts)),
    });
  } catch (error) {
    return {
      enabled: opts.enabled,
      status: "warning",
      backupDir: opts.backupDir,
      maxAgeHours: Math.max(1, opts.maxAgeHours),
      latestBackup: null,
      lastFailure: null,
      warnings: [{
        code: "database_backup_check_failed",
        message: `Database backup health check failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
}

// Async variant for HTTP handlers: identical verdicts, but every filesystem
// touch goes through the thread pool so a stalled mount (the NFS-backed
// backup directory mid-backup) delays this one request's snapshot instead of
// blocking the event loop for every in-flight request.
export async function inspectDatabaseBackupHealthAsync(
  opts: InspectDatabaseBackupHealthOptions,
): Promise<DatabaseBackupHealthStatus> {
  const now = opts.now ?? new Date();

  try {
    const latestBackup = await findLatestBackupAsync(opts.backupDir, now.getTime());
    const lastFailure = await readLastFailureAsync(alertFileCandidates(opts));
    return evaluateDatabaseBackupHealth(opts, now, { latestBackup, lastFailure });
  } catch (error) {
    return {
      enabled: opts.enabled,
      status: "warning",
      backupDir: opts.backupDir,
      maxAgeHours: Math.max(1, opts.maxAgeHours),
      latestBackup: null,
      lastFailure: null,
      warnings: [{
        code: "database_backup_check_failed",
        message: `Database backup health check failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
}

// The health endpoint (wired to kubelet liveness/readiness probes) evaluates
// backup freshness on every request. Directory listings of a multi-gigabyte
// backup store over a network mount take hundreds of round trips, so the scan
// is memoized: probes are answered from memory and the disk is touched at
// most once per TTL, in the background, serving the previous snapshot while
// the refresh is in flight. Backup freshness moves on an hourly cadence, so
// a snapshot this young is not observably stale.
export const DATABASE_BACKUP_HEALTH_CACHE_TTL_MS = 30_000;

type BackupHealthCacheSlot = {
  entry: { at: number; value: DatabaseBackupHealthStatus } | null;
  inflight: Promise<void> | null;
};

const backupHealthCache = new Map<string, BackupHealthCacheSlot>();

function backupHealthCacheKey(opts: InspectDatabaseBackupHealthOptions): string {
  return JSON.stringify([
    opts.enabled,
    opts.backupDir,
    opts.maxAgeHours,
    opts.alertFile ?? null,
    opts.alertFiles ?? null,
  ]);
}

function backupHealthCheckFailed(opts: InspectDatabaseBackupHealthOptions, message: string) {
  return {
    enabled: opts.enabled,
    status: "warning" as const,
    backupDir: opts.backupDir,
    maxAgeHours: Math.max(1, opts.maxAgeHours),
    latestBackup: null,
    lastFailure: null,
    warnings: [{
      code: "database_backup_check_failed" as const,
      message: `Database backup health check failed: ${message}`,
    }],
  };
}

export async function getCachedDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
  deps: { ttlMs?: number; now?: () => number } = {},
): Promise<DatabaseBackupHealthStatus> {
  const nowFn = deps.now ?? Date.now;

  // Deterministic callers (callers injecting `now`, mostly tests) bypass the
  // cache so an injected clock always observes the directory as of that clock.
  if (opts.now) return inspectDatabaseBackupHealthAsync(opts);

  const ttlMs = deps.ttlMs ?? DATABASE_BACKUP_HEALTH_CACHE_TTL_MS;
  const key = backupHealthCacheKey(opts);
  let slot = backupHealthCache.get(key);
  if (!slot) {
    slot = { entry: null, inflight: null };
    backupHealthCache.set(key, slot);
  }

  const cachedSnapshot = (): DatabaseBackupHealthStatus | null =>
    slot.entry ? slot.entry.value : null;
  const freshSnapshot = slot.entry && nowFn() - slot.entry.at < ttlMs ? slot.entry.value : null;
  if (freshSnapshot) return freshSnapshot;

  if (!slot.inflight) {
    const activeSlot = slot;
    activeSlot.inflight = inspectDatabaseBackupHealthAsync(opts)
      .then((value) => {
        activeSlot.entry = { at: nowFn(), value };
      })
      .catch(() => {
        // Keep serving the last known snapshot; the next expiry retries.
      })
      .finally(() => {
        activeSlot.inflight = null;
      });
  }

  // Serve stale (or fresh) from memory while a refresh is in flight, so a
  // stalled backup mount can never add latency to a probe.
  const staleServed = cachedSnapshot();
  if (staleServed) return staleServed;

  // Cold cache: wait for the single in-flight scan. It runs on the thread
  // pool, so the event loop stays responsive to everything else.
  await slot.inflight;
  const settled = cachedSnapshot();
  if (settled) return settled;
  backupHealthCache.delete(key);
  return backupHealthCheckFailed(opts, "backup health scan did not produce a snapshot");
}
