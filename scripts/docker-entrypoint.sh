#!/bin/sh
set -e

# Timestamped progress lines make the pre-start phase (container start to
# the first app log line) measurable from the container log alone.
log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) docker-entrypoint.sh: $*"
}

log "starting"

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Composio CLI is baked into the image (see Dockerfile tool layer). When a
# user API key is injected from Vault (t6-apps/<space>/config key
# composio_user_api_key, synced by External Secrets -> COMPOSIO_USER_API_KEY),
# log in non-interactively at every start so agent child processes get an
# authed `composio` CLI without a browser flow. Idempotent; the credential
# lands in $HOME/.composio (PAPERCLIP_HOME-backed on Kubernetes, so it also
# survives restarts there). Login failure must NEVER block the server boot.
maybe_composio_login() {
    [ -n "${COMPOSIO_USER_API_KEY:-}" ] || return 0
    command -v composio >/dev/null 2>&1 || return 0
    if composio login --user-api-key "$COMPOSIO_USER_API_KEY" --no-skill-install >/dev/null 2>&1; then
        echo "docker-entrypoint.sh: composio login ok" >&2
    else
        echo "docker-entrypoint.sh: composio login FAILED (continuing without composio)" >&2
    fi
}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    log "starting app as $(id -u):$(id -g)"
    maybe_composio_login
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request.
#
# `usermod -u` and `usermod -g` also re-own every file under the user's home
# directory. When that home is the app home (the data volume), the walk can
# take minutes on a large home, and the app cannot start until it ends. In
# that case the remap runs while the home points at a placeholder path that
# does not exist, so usermod changes only the account, and the ownership probe
# below repairs the app home when the IDs really changed (the home directory
# itself then has the old owner, which the shallow probe detects on the same
# boot). A passwd home outside the app home is not covered by that probe, so
# it keeps the plain usermod behavior, which re-owns it.
#
# The placeholder embeds the original home, so a boot that stops between the
# two usermod -d calls is repaired on the next start of the same container.
remap_home_prefix="/nonexistent/paperclip-uid-remap"
node_home="$(getent passwd node 2>/dev/null | cut -d: -f6 || true)"
case "$node_home" in
    "$remap_home_prefix"/*)
        node_home="${node_home#"$remap_home_prefix"}"
        echo "Restoring node home to $node_home after an interrupted remap"
        usermod -d "$node_home" node
        ;;
esac

remap_uid=0
remap_gid=0
[ "$(id -u node)" -ne "$PUID" ] && remap_uid=1
[ "$(id -g node)" -ne "$PGID" ] && remap_gid=1
app_home="${PAPERCLIP_HOME:-/paperclip}"
move_home=0
if { [ "$remap_uid" -eq 1 ] || [ "$remap_gid" -eq 1 ]; } \
    && [ -n "$node_home" ] && [ "${node_home%/}" = "${app_home%/}" ]; then
    move_home=1
    usermod -d "$remap_home_prefix$node_home" node
fi

if [ "$remap_uid" -eq 1 ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$remap_gid" -eq 1 ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

if [ "$move_home" -eq 1 ]; then
    usermod -d "$node_home" node
fi

# Ensure the app home is owned by the runtime user BEFORE dropping
# privileges -- not only after a UID/GID remap. A freshly mounted volume
# (Docker named volume, Railway volume, Kubernetes PV) arrives root-owned
# and shadows the image's build-time chown, so with the default UID the old
# remap-only condition dropped privileges onto an unwritable home and the
# server crashed on its first mkdir.
#
# A full-tree probe costs one stat per file, so the probe is tiered:
#  1. A shallow probe (the home and its first few levels) runs on every
#     boot. It catches a fresh root-owned mount and a UID/GID remap, because
#     both change the owner of the home directory itself.
#  2. A full-tree probe runs only when the marker file below is missing or
#     records a different node UID/GID. It catches a mismatch deeper in the
#     tree (init containers, backup restores, files written before a remap,
#     the first boot after an upgrade from an older image).
# After a clean probe or a successful repair, the marker records the verified
# node UID/GID, so later boots skip the full walk. Delete the marker to force
# a full probe on the next boot.
#
# Both probes and the repair PRUNE $home_dir/instances. That subtree is
# server-created runtime data (agent workspaces, trial-build rootfs copies)
# and is unbounded: an idle production instance accumulated millions of files
# there on NFS, and a whole-tree walk stalled the pod for ~10 minutes.
# Everything under instances/ is written by the server after privileges drop
# to node, so it is node-owned by construction; only the instances directory
# itself is repaired (non-recursive) to cover a root-owned fresh mount.
#
# Repair is per-mismatch (-exec chown -h ... +), not chown -R: it fixes exactly
# the entries that are wrong, follows -h so symlink ownership is set rather
# than dereferenced, and is best-effort. On a shared (RWX) volume another pod
# keeps creating and deleting files during the walk; find/chown then exit
# non-zero for vanished entries, which under `set -e` used to abort the boot.
# A vanished entry needs no repair, so a failed repair never fails startup
# (and is not recorded as verified).
#
# Every walk is bounded by PAPERCLIP_HOME_SCAN_TIMEOUT_SECONDS (default 120)
# so slow storage delays but never owns the boot. timeout cannot rescue a
# process stuck in D-state on an NFS hard mount -- the kill is delivered only
# once the hung RPC returns -- so on storage that can hang outright the escape
# hatch is PAPERCLIP_SKIP_HOME_OWNERSHIP_SCAN=1, which skips probe and repair
# and trusts the volume's ownership. (2026-10-23 incident: a degraded NFS
# export held the probe's first lstat in D for >8 minutes and liveness
# restart-looped the pod seven times.)
home_dir="${PAPERCLIP_HOME:-/paperclip}"
ownership_marker="$home_dir/.paperclip-ownership-verified"
ownership_shallow_depth=3
scan_budget="${PAPERCLIP_HOME_SCAN_TIMEOUT_SECONDS:-120}"
if command -v timeout >/dev/null 2>&1; then
    scan_wrapper="timeout $scan_budget"
else
    scan_wrapper=""
fi

# Sets needs_repair=1 when any entry outside instances/ is not node:node, and
# probe_failed=1 when find exits non-zero (I/O error, or 124 = budget spent),
# so an incomplete walk is never recorded as verified. The arguments bound the
# walk (empty for the full tree); -quit stops at the first mismatch.
probe_ownership() {
    set +e
    first_mismatch="$($scan_wrapper find "$home_dir" "$@" -path "$home_dir/instances" -prune -o \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)"
    probe_rc=$?
    set -e
    if [ "$probe_rc" -eq 124 ]; then
        probe_failed=1
        echo "docker-entrypoint.sh: WARNING ownership probe timed out after ${scan_budget}s; booting anyway (slow storage behind $home_dir; set PAPERCLIP_SKIP_HOME_OWNERSHIP_SCAN=1 if it can hang)" >&2
    elif [ "$probe_rc" -ne 0 ]; then
        probe_failed=1
        log "ownership probe of $home_dir failed; it will run again on the next boot"
    fi
    if [ -n "$first_mismatch" ]; then
        needs_repair=1
    fi
}

if [ "${PAPERCLIP_SKIP_HOME_OWNERSHIP_SCAN:-0}" = "1" ]; then
    echo "docker-entrypoint.sh: app-home ownership scan skipped (PAPERCLIP_SKIP_HOME_OWNERSHIP_SCAN=1)" >&2
elif [ -d "$home_dir" ]; then
    expected_marker="v1 $(id -u node):$(id -g node)"
    current_marker="$(cat "$ownership_marker" 2>/dev/null || true)"
    needs_repair=0
    probe_failed=0
    repair_ok=0
    probe_ownership -maxdepth "$ownership_shallow_depth"
    if [ "$needs_repair" -eq 0 ] && [ "$probe_failed" -eq 0 ] && [ "$current_marker" != "$expected_marker" ]; then
        log "full ownership probe of $home_dir (no current marker)"
        probe_started=$(date +%s)
        probe_ownership
        log "full ownership probe finished in $(( $(date +%s) - probe_started ))s"
    fi

    if [ "$needs_repair" -eq 1 ]; then
        log "repairing ownership of $home_dir to node:node"
        repair_started=$(date +%s)
        if $scan_wrapper find "$home_dir" -path "$home_dir/instances" -prune -o \( ! -user node -o ! -group node \) -exec chown -h node:node {} + 2>/dev/null; then
            repair_ok=1
        else
            echo "docker-entrypoint.sh: ownership repair skipped entries that changed during the scan (continuing)" >&2
        fi
        if [ -d "$home_dir/instances" ]; then
            chown -h node:node "$home_dir/instances" || true
        fi
        log "ownership repair finished in $(( $(date +%s) - repair_started ))s"
    fi

    # Record the marker only when the tree is known good: a repair that
    # completed, or probes that all completed without a mismatch.
    if [ "$current_marker" != "$expected_marker" ] && { [ "$repair_ok" -eq 1 ] || { [ "$needs_repair" -eq 0 ] && [ "$probe_failed" -eq 0 ]; }; }; then
        # Write as node so the marker itself never trips the shallow probe
        # (root-squashed network mounts included). Best effort: a read-only
        # home only costs a full probe on the next boot.
        # shellcheck disable=SC2016 # $1/$2 expand in the inner shell
        gosu node sh -c 'printf "%s\n" "$1" > "$2"' sh "$expected_marker" "$ownership_marker" 2>/dev/null || true
    fi
fi

# Run the Composio login as the runtime user so credentials land in its HOME.
if [ -n "${COMPOSIO_USER_API_KEY:-}" ] && command -v composio >/dev/null 2>&1; then
    if gosu node env COMPOSIO_USER_API_KEY="$COMPOSIO_USER_API_KEY" \
        composio login --user-api-key "$COMPOSIO_USER_API_KEY" --no-skill-install >/dev/null 2>&1; then
        echo "docker-entrypoint.sh: composio login ok" >&2
    else
        echo "docker-entrypoint.sh: composio login FAILED (continuing without composio)" >&2
    fi
fi

log "starting app as node"
exec gosu node "$@"
