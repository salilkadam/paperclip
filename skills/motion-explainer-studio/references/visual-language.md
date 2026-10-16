# Visual language — how to make it read like a studio explainer

Read this before writing the storyboard. The renderer will faithfully animate a
bad script; nothing downstream fixes weak copy or a flat arc.

## Table of contents
1. The arc
2. Pacing maths
3. Writing for TTS
4. Captions vs narration
5. Colour and type
6. Motion grammar
7. Scene sequencing
8. Things that make it look cheap

---

## 1. The arc

The reliable eight-beat explainer, ~75 seconds:

| Beat | Template | Seconds |
|---|---|---|
| Hook — name the reader's world | `title_card` / `statement` | 5-7 |
| Problem — three specific frictions | `problem` | 7-9 |
| Turn — "there is another way" | `statement` / `solution_reveal` | 5-6 |
| Product — what it actually is | `ui_walkthrough` / `phone_walkthrough` | 8-10 |
| How — three steps, no more | `steps_flow` | 8-10 |
| Proof — numbers or a named customer | `stat_burst` / `chart_proof` / `quote` | 6-8 |
| Trust — who else uses it | `logo_wall` | 4-5 |
| Ask — one action, one URL | `cta_outro` | 5-6 |

Deviate deliberately. A 30-second social cut is Hook → Problem → Product → Ask.
A 2-minute onboarding video expands How into three separate `ui_walkthrough` scenes.

**Vary the DNA between projects** — arc, palette, voice, music genre, scene count.
Successive videos built from the same defaults feel templated, and that is exactly
what a client notices first.

## 2. Pacing maths

- ~150 words ≈ 60 seconds at normal narration pace. Voices vary >10%, so probe.
- 5-8 seconds per scene. Under 4s the entrance animation has not finished landing
  before the cut; over 12s a static vector frame goes dead no matter how good it is.
- If a scene must run long, give it internal movement: a counter, a `chart` in
  `ui_walkthrough`, a delayed callout. `a-float` and the mesh drift alone are not
  enough past ~10s.
- Scene duration is computed as `lead (0.35s) + VO + tail (0.45s)`. You do not set
  it; the narration does. Scenes with no VO default to 4s or an explicit `duration`.

## 3. Writing for TTS

This is where quality actually dies.

- **No em-dashes, no ellipses.** Cloned voices hallucinate filler in those pauses.
- **Never make the voice speak a URL or a long letter-string.** It will mangle it,
  and the best-of-N scorer can even reward a take that silently drops it. Put the
  URL in a caption or the `cta_outro` props.
- Numbers as words in narration; digits are fine in captions and props.
- Short acronyms spelled as separate letters.
- One to three short sentences per scene. Two clauses maximum per sentence.
- Hyphenated brand names read better with the hyphen removed ("TMobile").
- Read every line out loud. If you run out of breath, it is too long for one scene.

## 4. Captions vs narration

They are not the same text and should never be identical — a caption that repeats
the narration verbatim reads as a subtitle, which is a different genre of video.

- **Narration** carries the argument.
- **Caption** carries the thing that must be *legible*: the URL, the price, the
  date, the metric, the product name.
- Roughly 40 characters fits comfortably at caption size. Longer belongs in `sub`.

## 5. Colour and type

- `mes.py ingest --apply-theme` lifts `brand` and `accent` from the site's own
  stylesheets. Check them: some sites' most frequent colour is a link blue nobody
  thinks of as their brand. Override with `edit project --set theme.brand=#...`.
- **One accent.** The accent marks exactly one thing per scene — the number that
  matters, the callout, the CTA. Two accents and nothing is emphasised.
- `mode: "dark"` (default) suits product/technical stories; `mode: "light"` suits
  healthcare, education and finance. Set it once, per project, never per scene.
- The type scale in `theme.css` is deliberate. Reach for the existing class
  (`display`, `h1`, `h2`, `lead`, `body`) rather than overriding font-size inline;
  ad-hoc sizes are what make a deck of scenes stop looking like one video.
- `<span class="hi">` and `class="hi-a"` colour a word inside a headline. Use once
  per headline at most.

## 6. Motion grammar

Every entrance has a direction and the direction means something:

| Class | Reads as | Use for |
|---|---|---|
| `a-rise` | arriving, settling | headlines, body copy, cards — the default |
| `a-drop` | landing from above | eyebrows, badges |
| `a-left` / `a-right` | sequence, comparison | list items, before/after columns |
| `a-pop` | appearing, arriving with force | numbers, buttons, callouts, icons |
| `a-wipe` | being revealed left-to-right | progress bars, UI rows, underlines |
| `a-zoom` | slow push over the whole scene | full-bleed art, long scenes |
| `a-float` | idle life | illustrations, phone/device mocks |

Stagger with `style="--i:N"` or `data-stagger` on the parent. 0.13s between items
is the built-in step: fast enough to feel like one gesture, slow enough to read.

Between scenes, one transition family per video. `fade` is neutral, `wipeleft`
is energetic, `circleopen` is playful. Mixing three in one 75-second video looks
like a template demo.

## 7. Scene sequencing

- Never put two scenes with the same template back to back. Two `problem` scenes
  in a row read as one long scene that glitched.
- Alternate density: a dense scene (`feature_grid`, `comparison`) should be
  followed by a sparse one (`statement`, `stat_burst`).
- Alternate composition: centred, then split, then centred.
- The logo belongs on the first and last scene, not on every one.

## 8. Things that make it look cheap

- Narration and caption saying the same words.
- More than four items in a `feature_grid` or `steps_flow`. Three is the number.
- A generated illustration in a style that does not match the others — always use
  one `art_style` for the whole project; the default in `lib/art.py` is already a
  strict style contract, so change it once at project level or not at all.
- Photoreal AI art dropped between flat vector scenes. Pick one world.
- Claims with no source. If the site does not say it, do not put it on screen.
- A hard cut to black at the end. The assembler fades; do not disable it.
