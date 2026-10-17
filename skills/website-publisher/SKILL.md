---
name: website-publisher
description: Update the marketing website deployments (Bionic AI Solutions and Reliora) with content changes by swapping their container images. Use when asked to publish, refresh, or roll back website content. Scoped service account grants these two deployments only; Paperclip and API services are off-limits.
---

# Website publisher

You hold a scoped credential (`paperclip-agent-web-sa`) that lets you update
exactly two marketing website deployments and read their namespaces. Everything
else — Paperclip itself, API services, secrets, deletes — is refused by the
cluster. Do not probe or work around those refusals.

## What you may change

| Namespace | Deployment | You may |
| --- | --- | --- |
| website ns for Bionic AI Solutions | `baisoln-web` | `kubectl set image`, patch image, watch rollout, read logs |
| website ns for Reliora | `reliora-website` | same as above |

Use the mounted service account token (default in-cluster location, or the
`KUBECONFIG`/token path your environment provides). Namespace names come from
your environment configuration.

## Allowed commands

```sh
# Observe
kubectl get pods,services,deployments -n <website-namespace>
kubectl get events -n <website-namespace>
kubectl logs deploy/baisoln-web -n <web-namespace>
kubectl logs deploy/reliora-website -n <reliora-website-namespace>

# Publish a new image tag (the only write you have)
kubectl set image deploy/baisoln-web web=<registry>/baisoln-web:<tag> -n <web-namespace>
kubectl set image deploy/reliora-website reliora-website=<registry>/reliora-website:<tag> -n <reliora-website-namespace>

# Confirm
kubectl rollout status deploy/baisoln-web -n <web-namespace> --timeout=180s
```

## Forbidden (the API will refuse these anyway)

- Never touch `contact-api` or `reliora-forms-api`. They are production APIs,
  not marketing content, and your credential excludes them by name.
- Never delete or scale any workload, in any namespace.
- Never read secrets or configmaps that contain credentials.
- Never attempt to deploy, restart, patch, or delete anything in the Paperclip
  namespace. Deploy and restart rights for Paperclip belong to the external
  SRE harness. If Paperclip needs a deploy or restart, report it, do not do it.
- Never attempt cluster-scoped operations (`get nodes`, `get clusterroles`, ...).

## Content-change workflow

1. Make the content change in the website repository and open a pull request.
   Wait for it to be merged per the normal review rules.
2. Build the new website image on the designated build host (GPU sandbox),
   push it with a tag equal to the short commit SHA, and clean up the build
   sandbox.
3. Swap the tag with `kubectl set image` (table above).
4. Run `kubectl rollout status`; then fetch the live page and verify the change
   is visible.
5. If the new pod fails its readiness, swap back to the previous tag
   immediately — the rollback is the same single `set image` command.
6. Report the old tag, new tag, rollout result, and the URL you verified.

## If something is refused

A 403 from `kubectl` means the action is outside your remit by design. Record
what you were trying to do and report it to the operator or the SRE harness
channel instead of retrying with different verbs or identities.
