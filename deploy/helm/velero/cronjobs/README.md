# velero namespace CronJobs (not chart-managed)

`velero-nas-mirror` and `velero-staleness-check` live in namespace
`velero-backup` and are NOT managed by the tanzu/velero Helm chart (which
installs only into namespace `velero`). They are applied manually from these
manifests:

    kubectl apply -f velero-nas-mirror.json
    kubectl apply -f velero-staleness-check.json

Do not `kubectl edit` in production — edit here and re-apply.

- `velero-nas-mirror` (`30 4 * * *`, Forbid): mirrors the MinIO bucket to the
  NAS. The `wait-for-backups` init container waits up to **13h** for in-flight
  backups; keep this >= the chart's `configuration.fsBackupTimeout` (12h) so a
  long nightly is never mirrored as "partial".
- `velero-staleness-check` (`47 */6 * * *`): alerts if no new backup appears.
