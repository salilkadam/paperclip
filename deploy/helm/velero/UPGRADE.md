# velero release (namespace `velero`) — how to upgrade

This release is **not** GitOps-managed (no flux/argocd in this cluster) and was
originally hand-`helm install`ed. `values.yaml` in this directory is the
canonical values; always upgrade from it so the release stops drifting.

```sh
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm -n velero upgrade velero vmware-tanzu/velero \
  --version 12.1.0 \
  -f deploy/helm/velero/values.yaml
```

Do not use `--reuse-values`; this file is complete. The S3 credentials live in
the pre-existing secret `velero-s3-credentials` (ns `velero`, key `cloud`),
referenced via `credentials.existingSecret` above.

## Not chart-managed (apply manually, ns velero-backup)

- CronJobs `velero-nas-mirror` (mirrors BSL bucket to /nas) and
  `velero-staleness-check` (alerts if no restore point within MAX_AGE_HOURS=48;
  counts PartiallyFailed backups) are plain CronJobs, not part of this chart.

## Known follow-ups

- Kopia repo `maintain` jobs (one `<repo>-default-kopia-maintain-job-*` per
  repo, ~hourly) contend with the large-volume tail of the nightly fs backup.
  The chart manages their ConfigMap (`velero-repo-maintenance`, via
  `nodeAgent.repositoryMaintenanceJob.repositoryConfigData.global`) but only
  exposes `keepLatestMaintenanceJobs`, `podResources`, `loadAffinity` and
  `priorityClassName` — the maintain *frequency/mode* knobs are not surfaced
  by chart v12.1.0. Watch whether the 12h timeout suffices; if not, this is
  the next lever (e.g. quick-maintenance upstream).
- velero server pod has a 1Gi memory limit with no OOM evidence to date;
  raise only if it ever restarts.
- BSL is the `minio-velero` tenant in ns `velero-backup` (endpoint
  `http://minio.velero-backup.svc.cluster.local`, bucket `velero`).
