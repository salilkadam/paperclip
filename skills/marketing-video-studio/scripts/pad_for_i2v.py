#!/usr/bin/env python3
"""Pad 16:9 stills to 1:1 with a blurred extension, so avatalk's centre-crop keeps the whole frame.

avatalk centre-crops any input to a square (measured: NCC 0.988 for centre-crop vs
0.465 for an anamorphic-squeeze hypothesis). Feed it a bare 16:9 image and the left and
right sides are gone before the model runs -- unrecoverable downstream.

Padding to 1:1 first puts the entire 16:9 frame inside the crop window. After the render,
make_live_clips.py crops the middle 9/16 band back out, restoring the original framing
(measured NCC 0.979 vs source, against 0.323 for cropping an unpadded render).

A blurred extension beats black bars: the model reads it as scene content instead of
producing a hard seam it then tries to animate.

Usage:
    python3 pad_for_i2v.py out_dir img1.jpg img2.png ...
"""
import sys, os
from PIL import Image, ImageFilter


def pad_to_square(src, out_dir):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    if w == h:
        dst = os.path.join(out_dir, f"pad_{os.path.splitext(os.path.basename(src))[0]}.jpg")
        im.save(dst, quality=94)
        return dst, (w, h), im.size
    side = max(w, h)
    # blurred, upscaled copy of the image itself as the extension
    bg = im.resize((side, side), Image.LANCZOS).filter(
        ImageFilter.GaussianBlur(max(24, side // 40)))
    bg.paste(im, ((side - w) // 2, (side - h) // 2))
    dst = os.path.join(out_dir, f"pad_{os.path.splitext(os.path.basename(src))[0]}.jpg")
    bg.save(dst, quality=94)
    return dst, (w, h), bg.size


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out_dir, srcs = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)
    for s in srcs:
        dst, before, after = pad_to_square(s, out_dir)
        print(f"  {os.path.basename(s):26s} {before[0]}x{before[1]} -> {after[0]}x{after[1]}  {dst}")
