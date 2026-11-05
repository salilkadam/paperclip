import * as fsp from "node:fs/promises";
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
  /**
   * Budget for the whole filesystem sweep. The backup directory can live on a
   * slow or saturated mount (e.g. NFS while an hourly pg_dump streams a
   * multi-hundred-megabyte archive to the same share), and `/health` runs this
   * inspection on every kubelet probe. Blocking the event loop here makes
   * readiness probes time out while the backup writes, so every filesystem
   * access is asynchronous and the sweep as a whole is time-boxed.
   */
  timeoutMs?: number;
  /** How long a last-known-good result may be reused after a failed sweep. */
  cacheMaxAgeMs?: number;
};

const DEFAULT_INSPECT_TIMEOUT_MS = 2_000;
const FALLBACK_CACHE_MAX_AGE_MS = 15 * 60_000;

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

async function statOrNull(path: string) {
  try {
    return await fsp.stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function pathExists(path: string) {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readLastFailure(alertFiles: string[]) {
  // One concurrent pass instead of sequential existsSync+statSync+readFileSync
  // round trips per candidate alert file.
  const inspected = await Promise.all(alertFiles.map(async (alertFile) => {
    const stat = await statOrNull(alertFile);
    if (!stat) return null;
    const message = (await fsp.readFile(alertFile, "utf8")).trim().split(/\r?\n/)[0] ||
      "Database backup failure marker is present.";
    return {
      path: alertFile,
      mtime: new Date(stat.mtimeMs).toISOString(),
      mtimeMs: stat.mtimeMs,
      message,
    };
  }));
  const failures = inspected
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
  if (!(await pathExists(backupDir))) return null;

  const names = (await fsp.readdir(backupDir)).filter((name) => name.endsWith(".sql.gz"));
  // Stat all candidates concurrently; stat can fail if retention pruning
  // removes a file between readdir and stat.
  const inspected = await Promise.all(names.map(async (name) => {
    const fullPath = join(backupDir, name);
    const stat = await statOrNull(fullPath);
    return stat ? { fullPath, name, stat } : null;
  }));
  const candidates = inspected
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(resolvePromise, rejectPromise).then(() => clearTimeout(timer));
  });
}

type CachedInspection = { atMs: number; status: DatabaseBackupHealthStatus };

let lastSuccessfulInspection: CachedInspection | undefined;

/** Test seam: drop the last-known-good inspection result. */
export function resetDatabaseBackupHealthInspectionCache() {
  lastSuccessfulInspection = undefined;
}

export async function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): Promise<DatabaseBackupHealthStatus> {
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS);
  const cacheMaxAgeMs = Math.max(0, opts.cacheMaxAgeMs ?? FALLBACK_CACHE_MAX_AGE_MS);
  const base = {
    enabled: opts.enabled,
    backupDir: opts.backupDir,
    maxAgeHours,
  };

  try {
    // Async, concurrent fs calls with a hard budget: a saturated mount delays
    // this response instead of freezing the event loop and every co-located
    // request behind it.
    const [latestBackup, lastFailure] = await withTimeout(
      Promise.all([
        findLatestBackup(opts.backupDir, now.getTime()),
        readLastFailure(alertFileCandidates(opts)),
      ]),
      timeoutMs,
      "database backup health check",
    );

    const warnings: DatabaseBackupHealthWarning[] = [];
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

    const status: DatabaseBackupHealthStatus = {
      ...base,
      status: warnings.length > 0 ? "warning" : "ok",
      latestBackup,
      lastFailure,
      warnings,
    };
    if (status.status === "ok") {
      lastSuccessfulInspection = { atMs: Date.now(), status };
    }
    return status;
  } catch (error) {
    // A degraded mount must not turn into probe timeouts: serve the
    // last-known-good healthy result while it is recent, otherwise fall back
    // to the same check-failed warning the synchronous version produced.
    if (lastSuccessfulInspection && Date.now() - lastSuccessfulInspection.atMs <= cacheMaxAgeMs) {
      return lastSuccessfulInspection.status;
    }
    return {
      ...base,
      status: "warning",
      latestBackup: null,
      lastFailure: null,
      warnings: [
        {
          code: "database_backup_check_failed",
          message: `Database backup health check failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
