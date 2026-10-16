"""Flat-vector illustration fills via GenImage, cut out to transparent PNG.

The style suffix is not decoration. Generated art drifts in style scene to
scene, and a photoreal still dropped between two flat vector scenes is the most
obvious "this was assembled by a machine" tell in the whole video. Appending one
identical style contract to every prompt — and the SAME one for a whole project
— is what makes a set of generated illustrations read as one piece.
"""
import os

from . import api

STYLE = ("flat 2d vector illustration, corporate memphis style, clean geometric shapes, "
         "bold flat color fills, no gradients, no texture, no photorealism, no text, "
         "no words, no letters, thick consistent line weight, generous negative space, "
         "isolated on plain white background, centered composition, "
         "limited palette of {brand} and {accent} with soft neutrals")

NEGATIVE_NOTE = ("Ask for what you want, not what you don't — this model ignores "
                 "negatives in a separate field, so the constraints live in the prompt.")


def build_prompt(subject, theme, style=None):
    s = (style or STYLE).format(brand=theme.get("brand", "#4F7CFF"),
                                accent=theme.get("accent", "#FF7A59"))
    return "%s, %s" % (subject.strip().rstrip(","), s)


def generate(subject, out_path, theme, size=1024, session=None, style=None, cutout=True):
    prompt = build_prompt(subject, theme, style)
    ok, err = api.image(prompt, out_path, width=size, height=size, session=session)
    if not ok:
        return False, err
    if cutout:
        try:
            make_transparent(out_path)
        except Exception as e:  # Pillow missing or odd image mode — keep the flat art
            return True, "cutout skipped: %s" % e
    return True, None


def make_transparent(path, tol=18):
    """Flood-fill the white surround to alpha from all four edges.

    Edge flood-fill rather than a global "white -> alpha" replace, because a
    global replace also punches holes in white shapes INSIDE the illustration —
    shirt highlights, screen fills, eyes — and you only notice once the art sits
    on a dark scene background.
    """
    from PIL import Image
    from collections import deque

    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()

    def white(p):
        return p[0] >= 255 - tol and p[1] >= 255 - tol and p[2] >= 255 - tol

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            q.append((x, y))
    while q:
        x, y = q.popleft()
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        if not white(px[x, y]):
            continue
        px[x, y] = (255, 255, 255, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                q.append((nx, ny))
    im.save(path)
    return path
