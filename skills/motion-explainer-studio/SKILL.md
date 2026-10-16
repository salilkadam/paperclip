---
name: motion-explainer-studio
description: Produce MotionGility-style flat 2D animated explainer videos (product, app walkthrough, onboarding, pitch) from a URL, PRD, doc or deck, or edit one incrementally. Vector scenes render in headless Chromium; voice on the self-hosted GPU stack. For live-action promos use marketing-video-studio.
---

# Motion Explainer Studio

Website URL or product doc in, 60–90 second flat-vector animated explainer out. Every
stage is a file on disk; every stage has a gate; every rebuild is incremental.

```
mes.py = scripts/mes.py    # one CLI, every stage
```

## What makes this look like a MotionGility video

Scenes are **HTML/SVG rendered deterministically in Chromium**, not AI-generated
frames. That is the whole trick, and it buys three things text-to-video cannot:

- **On-screen text is real text.** Headlines, URLs, prices and numbers are crisp
  vector type in the brand's own font. Generative video garbles words; this can't.
- **The brand's actual colours and logo.** Pulled from their site, not approximated.
- **Frame-exact repeatability.** Change one word, re-render one scene, everything
  else is byte-identical.

Generated art (GenImage) fills in *illustration* only — a character, a metaphor,
a spot image — inside a layout that is always vector. That is the hybrid: vector
structure, AI fills.

## Running inside Paperclip

- Script paths (`scripts/...`, `references/...`, `templates/...`) are relative to
  this skill's directory (the folder containing this `SKILL.md`): run
  `python3 "$SKILL_DIR/scripts/mes.py" ...` with the project folder inside your
  issue workspace.
- The runtime ships `ffmpeg`/`ffprobe`, Python 3 with Pillow and Playwright, and a
  preinstalled headless Chromium. `MCP_API_KEY` is a platform-provided env var
  (Vault → External Secrets); never fetch secrets yourself. If it is missing,
  report it to the board.
- Hand `review.html` and the final MP4 to the user as issue artifacts using the
  `paperclip` skill's artifact workflow. The storyboard and voice gates below are
  issue confirmations: stop and wait for approval before spending GPU time.

## When not to use

- Live-action-style promos, presenters/talking avatars, real-photo b-roll: use
  `marketing-video-studio`.
- Written copy only, with no video: use `human-write`.

## First run

```bash
bash scripts/setup.sh          # verifies ffmpeg, playwright + chromium launch, and the key
```

It reports anything missing with the exact fix. Voice, art and music go to the
self-hosted cluster; rendering and assembly are entirely local and work with no API
key at all.

## Pipeline

```
1 research   URL -> research.md          mes.py ingest --url ... --apply-theme
2 script     you write storyboard.json   mes.py script --import storyboard.json   ◀ GATE
3 voice      best-of-N TTS, sets timing  mes.py vo                                ◀ GATE
4 art        flat-vector fills           mes.py art
5 scene      spec -> scenes/sNN.html     mes.py build                             ◀ GATE
6 render     HTML -> clips/sNN.mp4       mes.py render [--preview]
7 assemble   crossfade + duck + fade     mes.py assemble  -> final.mp4
   review    mes.py dashboard -> review.html
```

`mes.py all <dir>` runs every stage that is stale, in order. `mes.py status <dir>`
shows what is stale and why.

**Narration sets the clock.** Each scene lasts exactly as long as its VO line plus
lead-in and tail, so stage 3 must run before stage 6 — the script *is* the runtime
budget. Roughly 150 words ≈ 60s, but voices differ by more than 10%, so probe
before committing to a full script:

```bash
mes.py probe <dir> --voices "Jessica,Lily,Julie Andrews,Don LaFontaine"
```

## Stage 2 — the storyboard is the real work

You (the agent) write `storyboard.json`. Nothing else in the pipeline invents
content. Shape:

```json
{"theme": {"brand": "#4F7CFF", "accent": "#FF7A59", "mode": "dark"},
 "scenes": [
   {"id": "s01", "template": "title_card", "vo": "Spoken line.",
    "caption": "On-screen lower third", "art_prompt": null,
    "props": {"eyebrow": "Introducing", "headline": "Acme <span class='hi'>Flow</span>"}}
 ]}
```

Read **`references/scene-library.md`** for all 15 templates and their props, and
**`references/visual-language.md`** before writing a word of copy — it carries the
narrative arc, the pacing maths, the TTS writing rules (the ones that actually
break narration), and the rule about never making the voice speak a URL.

Then: `mes.py script <dir> --import storyboard.json` and **stop**. Show the user
`script.md` and get sign-off before spending GPU time on voice.

## Editing — the point of the whole thing

Three levels, cheapest first. All of them mark only the affected scene stale.

```bash
# 1. reword a line          (re-voices + re-renders that scene, nothing else)
mes.py edit script <dir> s04 --vo "New narration." --caption "New caption"

# ...or edit script.md in any editor, then
mes.py script <dir> --sync

# 2. change what is on screen
mes.py edit scene <dir> s04 --set headline="New headline" --set url="app.acme.com"
mes.py edit scene <dir> s04 --template feature_grid
mes.py edit project <dir> --set voice=Lily --set theme.brand=#0F62FE --set transition.type=wipeleft

# 3. take over the scene completely
open <dir>/scenes/s04.html     # standalone; open it in a browser, edit anything
mes.py render <dir> --scene s04
```

Level 3 is safe: the build records a hash of what it generated, so a hand-edited
scene is detected and **never silently overwritten**. `mes.py status` shows it as
`hand-edited`. `mes.py build --scene s04 --force` deliberately throws your edits away.

After any edit: `mes.py all <dir>` rebuilds only the stale parts, then refreshes
`review.html`.

## Reviewing

`mes.py dashboard <dir>` writes `review.html` — every scene with its poster frame,
narration, audio, staleness badges and the exact command to change it, plus the
final cut inline. Open it in a browser; it is the thing to hand the user at each gate.

## Cost and time

| Stage | Cost |
|---|---|
| voice | ~3-6s per take, K takes per scene (default 5). A 10-scene script ≈ 4 min. |
| art | ~20-40s per illustration, GPU-serial |
| render | ~2x realtime at 1080p, ~0.5x with `--preview` (half res). 10 scenes ≈ 6-10 min |
| assemble | seconds |

Iterate at `--preview` (960×540, ~4x faster), then do one full-resolution pass for
delivery. `mes.py render <dir> --force` at full res once the cut is approved.

## Reference files

| File | Read it |
|---|---|
| `references/visual-language.md` | **Before writing the script.** Arc, pacing, copy rules, colour, motion grammar |
| `references/scene-library.md` | While writing the storyboard — all templates and props |
| `references/renderer.md` | Before hand-writing or debugging a scene HTML. The seek model and its two hard constraints |
| `references/cluster-api.md` | Before the first API call — endpoints, auth, and the failure modes worth knowing |

## Delivering

State duration, resolution, and where the file is. Then say plainly what is still
imperfect: any claim in the copy you could not verify from the source, art that was
generated rather than real, a logo you cropped. A user who discovers those after
publishing is much worse off than one who was told.
