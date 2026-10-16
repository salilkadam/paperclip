#!/usr/bin/env python3
"""Turn short i2v renders into per-scene b-roll clips at the exact scene length.

Two corrections happen here, both measured -- see references/geometry.md:

1. UN-PAD. avatalk centre-crops its input to a square, so sources are pre-padded to 1:1
   by pad_for_i2v.py. Here we crop the middle 9/16 band back out, which restores the
   original framing undistorted (NCC 0.979 vs source). Do NOT "un-squeeze" a square
   render by stretching it to 16:9 -- avatalk does not squeeze, it crops, and stretching
   makes everything horizontally wide and vertically compressed.

2. SMOOTH STRETCH. i2v clips are ~3.06s but scenes need 4-10s. Plain setpts re-timing
   duplicates frames and judders; minterpolate synthesises real intermediate frames.
   Beyond ~3x no interpolation hides it -- shorten the VO line instead.

Input plan JSON: [{"variant": "...", "scene": "s1", "src": "wings", "dur": 6.4}, ...]
  variant  subdirectory holding this cut (use "." for a single-video project)
  src      basename of the i2v render, resolved as <i2v_dir>/i2v_pad_<src>.mp4
  dur      target seconds (the scene's VO duration + tail)

Usage:
    python3 make_live_clips.py live_plan.json [--i2v-dir .] [--root .] [--unpadded]

--unpadded: the render came from a NON-padded source, so skip the band crop and
            centre-crop the square to 16:9 instead (correct aspect, tighter framing).
"""
import argparse, json, os, subprocess


def dur(f):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", f], capture_output=True, text=True).stdout or 0)


def res(f):
    return subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", f],
        capture_output=True, text=True).stdout.strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("plan")
    p.add_argument("--i2v-dir", default=".")
    p.add_argument("--root", default=".", help="parent of the per-variant directories")
    p.add_argument("--unpadded", action="store_true")
    a = p.parse_args()

    plan = json.load(open(a.plan))
    ok = 0
    for item in plan:
        variant, scene = item["variant"], item["scene"]
        src = os.path.join(a.i2v_dir, f"i2v_pad_{item['src']}.mp4")
        if not os.path.exists(src):
            alt = os.path.join(a.i2v_dir, f"i2v_{item['src']}.mp4")
            if os.path.exists(alt):
                src = alt
        if not os.path.exists(src):
            print(f"  MISSING {src}"); continue

        out = os.path.join(a.root, variant, "clips", f"{scene}_live.mp4")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        T = float(item["dur"]); sd = dur(src)
        if sd <= 0:
            print(f"  UNREADABLE {src}"); continue
        factor = T / sd

        if a.unpadded:
            # square render of an unpadded source: centre-crop to 16:9 (undistorted, tight)
            geom = "scale=1280:1280:force_original_aspect_ratio=increase,crop=1280:720"
        else:
            # padded source: crop the middle 9/16 band back out, then scale
            geom = "crop=iw:ih*9/16:0:(ih-ih*9/16)/2,scale=1280:720"

        vf = (f"{geom},setpts={factor:.5f}*PTS,"
              f"minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1:me_mode=bidir,"
              f"trim=0:{T},setpts=PTS-STARTPTS")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-an", "-vf", vf,
            "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
            "-r", "30", "-vsync", "cfr", out], check=True)
        warn = "   <-- >3x stretch, consider shortening the VO line" if factor > 3 else ""
        print(f"  {variant:12s} {scene:3s} {sd:.2f}s -> {dur(out):.2f}s (x{factor:.2f})  {res(out)}{warn}")
        ok += 1
    print(f"DONE {ok}/{len(plan)}")


if __name__ == "__main__":
    main()
