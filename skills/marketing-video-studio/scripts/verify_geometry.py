#!/usr/bin/env python3
"""Check a rendered frame against its source image by normalised cross-correlation.

Why bother: a geometrically wrong frame can look completely plausible on its own. The
only reliable comparison is against the source. This exact check would have caught an
"un-squeeze" bug that stretched every b-roll clip by 16/9 and shipped, because the
stretched version contained MORE of the scene and that was mistaken for being correct.
Field of view and geometry are independent properties.

    > 0.95   framing and geometry preserved
    0.6-0.95 content has moved (animation) or a tighter crop -- sample the scene's
             FIRST frame, not the middle
    < 0.5    something is stretched or wrongly cropped

Two traps:
  - sample the FIRST frame of a scene; later frames have legitimately animated away
  - pass --crop-caption so a burned-in lower-third does not drag the score down

Usage:
    python3 verify_geometry.py --frame out.png --source photo.jpg [--crop-caption]
    python3 verify_geometry.py --frame out.png --hypotheses photo.jpg
"""
import argparse, sys
import numpy as np
from PIL import Image


def ncc(a_img, b_img, size=(640, 360)):
    a = np.asarray(a_img.convert("RGB").resize(size, Image.LANCZOS), dtype=np.float32).mean(2)
    b = np.asarray(b_img.convert("RGB").resize(size, Image.LANCZOS), dtype=np.float32).mean(2)
    a = (a - a.mean()) / (a.std() + 1e-6)
    b = (b - b.mean()) / (b.std() + 1e-6)
    return float((a * b).mean())


def drop_caption(im, keep=0.70):
    return im.crop((0, 0, im.width, int(im.height * keep)))


def verdict(s):
    if s > 0.95:
        return "OK     geometry preserved"
    if s > 0.6:
        return "CHECK  moved/animated, or a tighter crop -- try the scene's first frame"
    return "BAD    stretched or mis-cropped"


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--frame", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--crop-caption", action="store_true")
    p.add_argument("--hypotheses", action="store_true",
                   help="also test how the square output was derived from the source")
    a = p.parse_args()

    fr = Image.open(a.frame); src = Image.open(a.source)
    if a.crop_caption:
        fr, src = drop_caption(fr), drop_caption(src)
    s = ncc(fr, src)
    print(f"  frame vs source   NCC = {s:+.4f}   {verdict(s)}")

    if a.hypotheses:
        # Which transform produced a square render from this source?
        full = Image.open(a.source).convert("RGB")
        W, H = full.size
        sq = min(W, H); x, y = (W - sq) // 2, (H - sq) // 2
        f2 = Image.open(a.frame)
        print("\n  How was the square derived from the source?")
        print(f"    anamorphic squeeze   NCC = {ncc(f2, full, (640,640)):+.4f}")
        print(f"    centre-crop          NCC = {ncc(f2, full.crop((x,y,x+sq,y+sq)), (640,640)):+.4f}")
        pad = Image.new("RGB", (max(W,H), max(W,H)))
        pad.paste(full, (0, (max(W,H)-H)//2))
        print(f"    letterbox pad        NCC = {ncc(f2, pad, (640,640)):+.4f}")
        print("    (avatalk centre-crops: expect ~0.99 on that row)")
