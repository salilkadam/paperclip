#!/usr/bin/env python3
"""Poll avatalk jobs across one or more workspaces; download each result as it lands,
and optionally motion-interpolate avatar clips to true 30fps on arrival.

avatalk jobs are GPU-bound and strictly serial (i2v ~1 min, avatar ~5-8 min), so a batch
runs for a long time. Run this in the background and build each cut as its clips appear
rather than blocking on the whole batch.

Job lists are plain text, one "<name> <job_id>" per line -- the same format the submit
step writes.

Usage:
    python3 poll_jobs.py --jobs outreach/jobs.txt:outreach/clips \
                         --jobs sponsor/jobs.txt:sponsor/clips \
                         [--interpolate a3,a6,a8] [--interval 60]

--interpolate takes the scene-name prefixes that are avatar (not i2v) renders; those get
the 16fps fix applied automatically. See references/geometry.md for why that matters.
"""
import argparse, json, os, subprocess, time

BASE_URL = "https://mcp.baisoln.com/avatalk/v1/jobs"
MINT = "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1:me_mode=bidir"


def key():
    k = os.environ.get("MCP_API_KEY", "").strip()
    if k:
        return k
    here = os.path.dirname(os.path.abspath(__file__))
    r = subprocess.run([os.path.join(here, "get_key.sh")], capture_output=True, text=True)
    k = r.stdout.strip()
    if not k:
        raise SystemExit("no API key (see get_key.sh diagnostics)")
    return k


def status(jid, k):
    r = subprocess.run(["curl", "-s", "-m", "25", "-H", f"X-API-Key: {k}", f"{BASE_URL}/{jid}"],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--jobs", action="append", required=True,
                   help="<jobs_file>:<output_dir>, repeatable")
    p.add_argument("--interpolate", default="",
                   help="comma-separated scene-name prefixes that are avatar renders")
    p.add_argument("--interval", type=int, default=60)
    p.add_argument("--max-wait", type=int, default=5400,
                   help="give up on still-pending jobs after this many seconds")
    p.add_argument("--max-restarts", type=int, default=6,
                   help="flag a job whose started_at keeps changing (dispatcher requeue loop)")
    a = p.parse_args()
    t0 = time.time()

    k = key()
    interp = [s for s in a.interpolate.split(",") if s]
    jobs = []
    for spec in a.jobs:
        jf, outdir = spec.rsplit(":", 1)
        if not os.path.exists(jf):
            print(f"  skip (missing) {jf}"); continue
        os.makedirs(outdir, exist_ok=True)
        for line in open(jf):
            if line.strip():
                nm, jid = line.split()
                jobs.append({"name": nm, "id": jid, "out": outdir, "done": False,
                             "started": None, "restarts": 0, "stuck": False})

    if not jobs:
        raise SystemExit("no jobs found")
    print(f"tracking {len(jobs)} job(s)")

    while True:
        pending = [j for j in jobs if not j["done"]]
        if not pending:
            print("ALL DONE", flush=True); return
        for j in pending:
            d = status(j["id"], k)
            st = d.get("status")
            if st == "done":
                dst = os.path.join(j["out"], f"{j['name']}.mp4")
                subprocess.run(["curl", "-s", "-m", "300", "-o", dst,
                                d["result"]["video_url"]])
                msg = f"{j['name']} -> {dst}"
                if any(j["name"].startswith(pfx) for pfx in interp):
                    out = dst.replace(".mp4", "_i30.mp4")
                    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", dst,
                        "-vf", MINT, "-c:v", "libx264", "-crf", "18", "-preset", "medium",
                        "-pix_fmt", "yuv420p", "-c:a", "copy", out], check=False)
                    msg += "  (+interpolated to 30fps)"
                print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
                j["done"] = True
            elif st in ("failed", "canceled"):
                print(f"[{time.strftime('%H:%M:%S')}] {j['name']} {st}: {d.get('error')}", flush=True)
                j["done"] = True
            elif st == "running":
                # The dispatcher requeues a job that crashes (e.g. GPU out of memory)
                # but keeps reporting "running"; each requeue resets started_at.
                started = d.get("started_at")
                if started and j["started"] and started != j["started"]:
                    j["restarts"] += 1
                j["started"] = started or j["started"]
                if j["restarts"] >= a.max_restarts and not j["stuck"]:
                    j["stuck"] = True
                    print(f"[{time.strftime('%H:%M:%S')}] {j['name']} restarted {j['restarts']}x "
                          "with no progress: avatalk is requeueing it (usually the GPU is out "
                          f"of memory). Cancel with DELETE /avatalk/v1/jobs/{j['id']} and report "
                          "the GPU capacity blocker; offer a Ken-Burns still instead.", flush=True)
        n = sum(1 for j in jobs if j["done"])
        print(f"[{time.strftime('%H:%M:%S')}] {n}/{len(jobs)}", flush=True)
        if n < len(jobs) and time.time() - t0 > a.max_wait:
            left = " ".join(j["name"] for j in jobs if not j["done"])
            raise SystemExit(f"gave up after {a.max_wait}s; still pending: {left}")
        if n < len(jobs):
            time.sleep(a.interval)


if __name__ == "__main__":
    main()
