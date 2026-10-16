# Scene library — templates and their props

Fifteen templates in `templates/scenes.html`. Every scene in a storyboard picks
one and supplies `props`. Unlisted props are ignored; missing ones fall back to
the defaults in `scripts/lib/build.py`.

`mes.py templates <dir>` lists the names. Every scene also accepts these
scene-level keys alongside `template` and `props`:

| Key | Meaning |
|---|---|
| `vo` | narration; its length sets the scene's duration |
| `caption` / `sub` | lower third — the legible layer, see visual-language.md §4 |
| `art_prompt` | subject for a generated flat-vector illustration (stage 4) |
| `art` | path to an image to use instead of generating one |
| `duration` | only for scenes with no VO |
| `transition` | override the incoming transition for this scene |
| `show_logo` | `false` to suppress the project logo on this scene |
| `grid` | `false` to drop the faint background grid |

Headline props accept inline HTML: `"headline": "Ship <span class='hi'>faster</span>"`.

---

### `title_card` — opener
`eyebrow`, `headline`, `subhead`, `kicker`
Centred, biggest type in the video. One per project, at the front.

### `statement` — a single idea, full frame
`headline`, `subhead`, `align` (`center` | `left`)
The turn beat. Also the right choice any time you catch yourself putting one
sentence into a template designed for six.

### `problem` — the frictions
`headline`, `items[{text, icon}]`
Three items. Four fits; four never lands. Icons: `clock alert chart bolt shield
users money search cloud spark check gear doc link target`.

### `solution_reveal` — copy beside a picture
`eyebrow`, `headline`, `body`, `side` (`wide-left` | `wide-right`), plus either
scene-level `art` / `art_prompt`, or nothing — with no art it draws a flat vector
figure from CSS, which never drifts in style the way generated characters do.

### `stat_burst` — the numbers
`headline`, `stats[{value, from, prefix, suffix, dp, comma, label, at, dur}]`
Two or three stats. Values count up on the timeline; `at` is when each starts
(auto-staggered if you omit it), `dur` how long it counts. `comma: 1` for
thousands separators, `dp` for decimal places.

### `ui_walkthrough` — the product, in a browser
`headline`, `url`, `rows[{w, accent}]`, `callout`, `callout_at`, `chart`
A fake browser chrome with skeleton rows that wipe in. `chart: true` adds an
animated bar row. `callout` is the orange flag with `callout_at` seconds of delay —
the single most useful "look here" device in the whole library.

### `phone_walkthrough` — the product, in a phone
`headline`, `body`, `screen_title`, `rows[{w, accent}]`
Use for mobile products. Do not use both this and `ui_walkthrough` in the same
video unless the product genuinely has both surfaces.

### `feature_grid` — capabilities
`headline`, `items[{title, text, icon}]`, `cols` (default 3)
Three cards. Each `text` is one line, not a paragraph.

### `steps_flow` — how it works
`headline`, `steps[{title, text}]`
Numbered, with a line drawing itself across them. Exactly three steps.

### `comparison` — before and after
`headline`, `before_title`, `before[]`, `after_title`, `after[]`
Crosses on the left, ticks on the right. Three or four bullets a side, matched in
length — a three-word "before" against a twelve-word "after" reads as a straw man.

### `chart_proof` — a metric with evidence
`headline`, `note`, `bars[{h, label}]`, `metric{value, prefix, suffix, dp, comma, label}`
`h` is bar height as a percentage. Five bars reads best; the last one is accented
automatically, so make it the one that matters.

### `quote` — testimonial
`quote`, `name`, `role`, `avatar`
Only with a real quote from a real named person. An invented testimonial is the
one thing in this list that can get a client in actual trouble.

### `logo_wall` — trust
`headline`, `names[]`
Text chips, not logo files — no rights questions, no mismatched aspect ratios,
and it reads at a glance. Six to ten names.

### `cta_outro` — the ask
`headline`, `subhead`, `button`, `url`, `logo_big`
One action. The URL goes here, never into the narration.

### `full_art` — full-bleed illustration
`art` (required), `headline`, `subhead`, `overlay`
Slow push over a generated image with a gradient veil. Use sparingly — at most
one per video, usually the hook.

---

## Writing good `art_prompt`s

The prompt is the *subject only*. `lib/art.py` appends a strict flat-vector style
contract (and the project palette) to every prompt, which is what keeps a set of
generated images looking like one commission rather than four.

Good: `"a person carrying an oversized calendar up a staircase"`
Bad: `"beautiful 3d render of productivity, trending on artstation"` — fights the
style contract and will come back inconsistent.

Never ask for text in the image. The model garbles it and the layout already has
real, crisp type.
