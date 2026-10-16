# Renderer — the seek model, and what it forbids

Read this before hand-writing a scene or debugging one that renders wrong.

## Table of contents
1. Why seek instead of record
2. The two hard constraints
3. Writing a scene by hand
4. The `--scene-duration` variable
5. Preview vs delivery
6. Symptoms and causes
7. Verifying a render

---

## 1. Why seek instead of record

`lib/render.py` does not screen-record. For each frame it:

1. pauses every animation on the page,
2. sets `animation.currentTime = frame / fps * 1000` on all of them,
3. calls `window.MES.seek(t)` for JS-driven effects,
4. screenshots, and pipes the PNG straight into ffmpeg.

Real-time recording makes the output depend on machine speed — a busy box drops
frames and you get a video that stutters on one machine and not another, which is
close to impossible to debug after the fact. Seeking gives the same bytes on any
machine at any speed, and lets a 10-second scene render in whatever wall time it
takes without affecting the result.

## 2. The two hard constraints

**Motion must be CSS animations, transitions or WAAPI.** Only those appear in
`document.getAnimations()`. SVG SMIL — `<animate>`, `<animateTransform>`,
`<animateMotion>` — is *not* seekable this way and renders frozen at its initial
state. Animate SVG with CSS transforms on the SVG elements instead.

**Anything JS-driven must be a pure function of t** and must go through
`window.MES.seek(t)`. An effect that accumulates (`count += 1` per tick) or reads
`Date.now()` will render differently depending on how many frames happened to be
drawn before it. `templates/engine.js` implements the pure versions of the three
things people reach for:

```html
<span data-count-to="4200" data-count-from="0" data-at="0.5" data-dur="1.6"
      data-prefix="$" data-comma="1" data-dp="0">0</span>
<span data-type="typed out over time" data-at="0.3" data-dur="1.2"></span>
<i data-progress="72" data-at="0.5" data-dur="1.0"></i>   <!-- sets width % -->
```

A third, softer rule: `theme.css` forces `animation-fill-mode: both` globally.
Without it, seeking to a time inside an animation's delay snaps the element back
to its un-animated state — elements flicker on for one frame and vanish. If you
write a scene with its own `<style>` block, do not override that.

## 3. Writing a scene by hand

`scenes/sNN.html` is standalone: open it in a browser and it renders the scene at
its final state (all animations complete, since they play once on load). Edit
anything — it is ordinary HTML/CSS with `theme.css` inlined at the top.

The build records a hash of what it generated. If the file no longer matches,
`mes.py status` reports `hand-edited` and `mes.py build` skips it. Only
`mes.py build --scene sNN --force` will overwrite your work.

To preview the motion rather than the end state, reload with the animations
restarted — or just render it:

```bash
mes.py render <dir> --scene s04 --preview --force
```

## 4. The `--scene-duration` variable

The renderer sets `--scene-duration` on `<html>` before seeking. Anything that
should last exactly as long as the scene binds to it:

```css
.thing { animation: drift var(--scene-duration) linear infinite; }
```

`a-zoom`, `a-out` and the background mesh already do. Entrance animations
deliberately do **not** — a 0.75s entrance should be 0.75s whether the scene runs
5 seconds or 11.

## 5. Preview vs delivery

`--preview` renders at `device_scale_factor=0.5` — same layout, half the pixels,
roughly four times faster. Note the distinction: the viewport is always the stage
size in CSS pixels and `scale` is the device pixel ratio. Scaling the *viewport*
instead would leave the fixed-size stage sitting in the corner of an oversized
page — an easy mistake with an output that looks convincingly like a framing bug.

Iterate in preview; do one `mes.py render <dir> --force` at full resolution before
delivering, then `mes.py assemble <dir> --force`.

Rough cost: ~2x realtime at 1080p, ~0.5x at preview, single-threaded per scene.

## 6. Symptoms and causes

| Symptom | Cause |
|---|---|
| Element visible for one frame then gone | an animation without `fill-mode: both` |
| SVG animation frozen | SMIL — rewrite as CSS transforms |
| Counter stuck at its start value | not going through `MES.seek`, or `data-at` later than the scene |
| Scene renders in the corner of a black frame | viewport scaled instead of `device_scale_factor` |
| Whole scene is one static frame | all motion is `transition:` on a state change that never fires — transitions need a trigger; use `animation` |
| Text clipped at the frame edge | caption over ~40 chars, or a headline overriding the type scale |
| Fonts differ between machines | the theme names web-safe stacks by design; if you add a webfont, embed it in the scene HTML rather than linking it |

## 7. Verifying a render

```bash
ffprobe -v error -show_entries format=duration -show_entries stream=width,height,r_frame_rate final.mp4

# pull frames either side of a cut and actually look at them
ffmpeg -ss 4.85 -i final.mp4 -frames:v 1 -y /tmp/f.png

# frame duplication in a window — ~50% duplication means judder
ffmpeg -ss 10 -t 6 -i final.mp4 -vf mpdecimate -vsync vfr -f rawvideo -y /dev/null -stats 2>&1 | tail -1
```

Extract a few frames and look at them. Caption overflow, a callout landing on top
of a chart, and a stat that never finished counting are all obvious in a still and
completely invisible in a duration check.
