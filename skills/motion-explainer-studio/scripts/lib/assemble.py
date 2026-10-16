"""Final cut: crossfade the scene clips, lay the narration on an absolute
timeline, duck a looping music bed under it, fade out.

Why the audio is placed by absolute offset rather than muxed per scene and
concatenated: every crossfade eats `overlap` seconds of wall-clock, so after
three transitions a naively concatenated narration is a second and a half out of
sync with the picture. Computing each scene's start from the accumulated
timeline keeps VO locked to its scene no matter how the transitions change.
"""
import json
import os
import subprocess

TRANSITIONS = ["fade", "wipeleft", "wiperight", "slideup", "slidedown",
               "circleopen", "smoothleft", "smoothup", "dissolve", "fadeblack"]


def probe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "json", path], capture_output=True, text=True).stdout
    try:
        return float(json.loads(out)["format"]["duration"])
    except Exception:
        return 0.0


def probe_dims(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", path],
        capture_output=True, text=True).stdout
    try:
        s = json.loads(out)["streams"][0]
        return int(s["width"]), int(s["height"])
    except Exception:
        return 0, 0


def timeline(durations, overlap):
    """Absolute start time of each scene once crossfades are accounted for."""
    starts, t = [], 0.0
    for i, d in enumerate(durations):
        starts.append(t)
        t += d - (overlap if i < len(durations) - 1 else 0)
    total = t
    return starts, total


def build(clips, vos, durations, out_path, fps=30, overlap=0.5, transition="fade",
          music=None, music_volume=0.5, lead=0.35, tail_fade=1.4, per_scene_transition=None,
          dry_run=False):
    n = len(clips)
    if n == 0:
        raise ValueError("no clips")
    overlap = min(overlap, min(durations) * 0.4) if n > 1 else 0.0
    starts, total = timeline(durations, overlap)

    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    for c in clips:
        cmd += ["-i", c]
    vin = list(range(n))
    ain = {}
    k = n
    for i, v in enumerate(vos):
        if v and os.path.exists(v):
            cmd += ["-i", v]
            ain[i] = k
            k += 1
    music_in = None
    if music and os.path.exists(music):
        cmd += ["-stream_loop", "-1", "-i", music]
        music_in = k
        k += 1

    fc = []
    # --- video ---
    for i in vin:
        fc.append("[%d:v]setpts=PTS-STARTPTS,fps=%d,format=yuv420p[v%d]" % (i, fps, i))
    if n == 1:
        vlast = "v0"
    else:
        vlast = "v0"
        for i in range(1, n):
            tr = (per_scene_transition or {}).get(i) or transition
            out = "vx%d" % i
            fc.append("[%s][v%d]xfade=transition=%s:duration=%.3f:offset=%.3f[%s]"
                      % (vlast, i, tr, overlap, max(0.0, starts[i]), out))
            vlast = out
    fc.append("[%s]fade=t=out:st=%.3f:d=%.3f[vout]"
              % (vlast, max(0.0, total - tail_fade), tail_fade))

    # --- narration on an absolute timeline ---
    vo_labels = []
    for i, idx in ain.items():
        delay = int(round((starts[i] + lead) * 1000))
        fc.append("[%d:a]aresample=48000,adelay=%d:all=1[a%d]" % (idx, delay, i))
        vo_labels.append("[a%d]" % i)

    if vo_labels:
        fc.append("%samix=inputs=%d:duration=longest:normalize=0,"
                  "apad,atrim=0:%.3f,asetpts=PTS-STARTPTS[vomix]"
                  % ("".join(vo_labels), len(vo_labels), total))
        vo_out = "vomix"
    else:
        fc.append("anullsrc=r=48000:cl=stereo,atrim=0:%.3f[vomix]" % total)
        vo_out = "vomix"

    if music_in is not None:
        fc.append("[%d:a]aresample=48000,atrim=0:%.3f,asetpts=PTS-STARTPTS,volume=%.3f,"
                  "afade=t=in:st=0:d=1.2,afade=t=out:st=%.3f:d=2.4[mus]"
                  % (music_in, total, music_volume, max(0.0, total - 2.4)))
        fc.append("[%s]asplit=2[vomix1][vokey]" % vo_out)
        # Sidechain rather than a static cut: the bed breathes back up between
        # lines instead of sitting flat under the whole video.
        fc.append("[mus][vokey]sidechaincompress=threshold=0.09:ratio=4:attack=25:"
                  "release=450:makeup=1[musd]")
        fc.append("[vomix1][musd]amix=inputs=2:duration=first:normalize=0,"
                  "loudnorm=I=-14:TP=-1.5,afade=t=out:st=%.3f:d=2.0[aout]"
                  % max(0.0, total - 2.0))
    else:
        fc.append("[%s]loudnorm=I=-14:TP=-1.5,afade=t=out:st=%.3f:d=1.6[aout]"
                  % (vo_out, max(0.0, total - 1.6)))

    cmd += ["-filter_complex", ";".join(fc),
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", str(fps),
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart", "-t", "%.3f" % total, out_path]

    if dry_run:
        return cmd, total
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg assemble failed:\n" + (r.stderr or "")[-2500:])
    return out_path, total
