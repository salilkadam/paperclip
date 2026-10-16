# Geometry and frame rate — the two silent defects

Both defects here are invisible in a single still frame and only appear in motion.
That is exactly why they ship. Each was found by measurement after a human noticed
something looked wrong; each is cheap to prevent and annoying to discover late.

## Table of contents
1. avatalk centre-crops its input
2. The padding fix
3. avatar output is 16fps
4. Stretching short i2v clips
5. Verifying numerically
6. Pillarboxing (unresolved)

---

## 1. avatalk centre-crops its input

`i2v` and `avatar` both return **640×640 square** video regardless of input aspect,
and regardless of `resolution: "480p"` vs `"720p"` (tested — no difference).

The critical question is *how* a 16:9 input becomes square. Two plausible answers:

- **Anamorphic squeeze** — the whole frame is compressed horizontally. Nothing is
  lost; un-squeezing restores it.
- **Centre-crop** — the sides are discarded. The square is correctly proportioned;
  stretching it back to 16:9 distorts everything.

These demand opposite corrections, so guessing wrong actively damages the output.
Measure with normalised cross-correlation between the i2v first frame and each
hypothesis:

```
H1 full-frame anamorphic squeeze   NCC = +0.465
H2 centre-crop 1080x1080 -> 1:1    NCC = +0.988   <-- what actually happens
H3 letterbox pad                   NCC = +0.140
```

**avatalk centre-crops.** A 1920×1080 input becomes its central 1080×1080, scaled to
640×640. You permanently lose 44% of the frame width before the model even runs.

This was originally misdiagnosed as a squeeze, and the resulting "un-squeeze" stretched
every b-roll clip by 16/9 — horizontally stretched, vertically compressed. The mistake
came from comparing two candidate frames by eye: the stretched one contained more of
the scene, and *more content* was read as *more correct*. Field of view and geometry
are independent properties. Ten seconds of correlation would have caught it.

## 2. The padding fix

Simply cropping the square back to 16:9 is undistorted but harshly tight — it recovers
only the central ~56% in each axis, correlating about **0.32** with the original
framing. The sides are already gone.

Instead, make the crop window contain the whole picture. Pad the source to 1:1 with a
blurred extension *before* submitting, then crop the middle 9/16 band back out:

```
pad_for_i2v.py     1920x1080 --> 1920x1920 (blurred extension top and bottom)
avatalk centre-crop  captures the full 16:9 content, now centred in the square
make_live_clips.py   crop=iw:ih*9/16 --> the original framing, undistorted
```

Measured against the source photo: **NCC 0.979**. Compare:

| Approach | Geometry match |
|---|---|
| Padded input → recover band | **0.979** |
| Un-squeeze (wrong) | 0.469 |
| Centre-crop of unpadded input | 0.323 |

A blurred extension works better than black bars — the model treats it as scene content
and doesn't produce a hard seam. Any 16:9 image sent to avatalk without padding loses
its edges, so pad by default.

## 3. avatar output is 16fps

`avatar` returns **16fps** (e.g. 129 frames over 8.06s). Assemblers normalise to 30fps,
and 16→30 is not an integer ratio, so frames duplicate unevenly. On a mouth this reads
as judder — the single most common complaint about these talking heads.

It is often worse than it looks, because a naive avatar path applies `fps=30` twice:
once compositing over the background, once in normalisation.

Fix with genuine motion interpolation:

```bash
ffmpeg -i avatar.mp4 \
  -vf "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1:me_mode=bidir" \
  -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -c:a copy avatar_30.mp4
```

Measured on a CTA scene: unique frames rose from **96/180 to 143/180** (47% duplication
down to 21%), roughly doubling real motion information. Interpolated frames show clean
intermediate mouth positions with no warping.

The lip-sync model itself is fine — native frames articulate correctly. This is purely
frame-rate handling. Do not re-render hoping for a better take; re-rendering cannot fix
16fps.

`scripts/interpolate_avatar.py` applies this. Run it on every avatar clip.

## 4. Stretching short i2v clips

i2v returns about **3.06s**. Scenes usually need 4-10s, so the clip must cover more time
than it has.

Options, in order of preference:

1. **Motion-interpolated stretch** (`make_live_clips.py`). Re-time with `setpts`, then
   `minterpolate` to synthesise real intermediate frames. Smooth up to roughly 2.5-3×.
2. **Shorten the scene.** Duration comes from the VO line — a shorter line needs less
   stretch. Cheapest fix, costs nothing but words.
3. **`video.continue`** to generate genuinely longer footage. Best quality, but
   **15-20 minutes per clip** and GPU-serialised. Rarely worth it; confirm with the user
   before spending an hour on five clips.
4. **Ken-Burns on the still instead.** Frequently the best answer when the source is
   sharp real photography. A slow push on a crisp 1920px photo beats a 3× stretched
   generative clip.

Avoid plain `setpts` without interpolation (duplicated frames, judder) and boomerang
loops (the reverse is visible as a back-and-forth).

Beyond about 3×, no amount of interpolation hides it. Rewrite the line instead.

## 5. Verifying numerically

`scripts/verify_geometry.py` correlates a rendered frame against its source image.

```bash
python3 scripts/verify_geometry.py --frame out.png --source photo.jpg --crop-caption
```

Interpretation:

| NCC | Meaning |
|---|---|
| > 0.95 | Framing and geometry preserved |
| 0.6 – 0.95 | Content moved (animation) or tighter crop — sample the scene's *first* frame instead |
| < 0.5 | Something is stretched or wrongly cropped |

Two traps when reading this:

- **Sample the first frame of a scene.** Later frames have legitimately animated away
  from the source; a low score mid-scene means motion, not distortion.
- **Exclude the caption band.** A burned-in caption over the lower third drags the score
  down for reasons unrelated to geometry.

## 6. Pillarboxing (unresolved)

Because avatar output is square, compositing it into 16:9 leaves dark bars either side.
Current builds place a logo in the left bar to use the space, which is a mitigation, not
a fix.

Real options, none yet implemented:
- Crop-to-fill the presenter (loses the top of the head — check framing first)
- A deliberate lower-third layout that treats the square as an intentional element
- A generated 16:9 background plate that extends the scene rather than blurring it

Worth telling the user this exists rather than letting them discover it in review.
