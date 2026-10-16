#!/usr/bin/env python3
"""Motion-interpolate avatalk avatar clips from 16fps to true 30fps.

avatalk avatar output is 16fps. Assemblers normalise to 30, and 16->30 is not an integer
ratio, so frames duplicate unevenly -- on a mouth that reads as judder. It is often
doubled up, because a naive avatar path applies fps=30 twice (compositing, then
normalising).

minterpolate synthesises genuine intermediate frames instead of repeating them.
Measured on a CTA scene: unique frames went from 96/180 to 143/180.

The lip-sync model itself is fine -- native frames articulate correctly. Re-rendering
will NOT fix this; only interpolation will.

Usage:
    python3 interpolate_avatar.py clips/a3.mp4 clips/a6.mp4 ...
    -> writes clips/a3_i30.mp4 alongside each input
"""
import subprocess, sys, os

MINT = "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1:me_mode=bidir"


def probe(f, stream, field):
    return subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", stream,
         "-show_entries", f"stream={field}", "-of", "default=nw=1:nk=1", f],
        capture_output=True, text=True).stdout.strip().splitlines()[0:1]


def frames(f):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-count_frames", "-show_entries", "stream=nb_read_frames",
        "-of", "default=nw=1:nk=1", f], capture_output=True, text=True).stdout.strip()
    return r or "?"


def interpolate(src):
    out = src.replace(".mp4", "_i30.mp4")
    if out == src:
        out = src + ".i30.mp4"
    before = frames(src)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf", MINT,
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "copy", out], check=True)
    fps = probe(out, "v:0", "avg_frame_rate")
    print(f"  {os.path.basename(src):22s} frames {before} -> {frames(out)}   fps now {fps[0] if fps else '?'}")
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for f in sys.argv[1:]:
        if os.path.exists(f):
            interpolate(f)
        else:
            print(f"  MISSING {f}")
