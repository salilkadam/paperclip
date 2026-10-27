# Sub-skill: Generate an illustration for a post

Adds an optional image to a draft (feed illustration, carousel slide, or
quote-card) and attaches it to the TryPost draft. Uses Loc-GenImage
(`gi_generate_image`, `gi_edit_image`, `gi_text_edit_image`,
`gi_upscale_image`) through the tool gateway, which returns a public URL that
goes straight into the TryPost post's `media` (`social-core` sections 1 and 2).

## When this runs

- User says "add an image", "make an illustration", "make a quote-card", or
  "add a cover" for a post.
- Offer it once after a post draft is approved, when a visual would lift reach
  (LinkedIn image posts get more dwell time than plain text).

## Backends (mirrors the publish layer)

- **Loc-GenImage** - connection `ready`: the image is generated and attached to
  the draft.
- **manual** - no ready Loc-GenImage connection: the skill drafts the image
  prompt and aspect in the task and asks for the image (or a public URL) to be
  supplied. Never blocks a draft.

`connections_search` reports which is available.

## Steps

1. **Pick the kind** (maps to an aspect ratio):
   - `wide` / `link` (1200:628) - link-preview / single feed image (default for a text post)
   - `portrait` / `carousel` / `quote` (4:5) - feed portrait, carousel slide, quote-card
   - `square` (1:1) - generic
   Pass the aspect or size using the input names in the `gi_generate_image`
   tool schema; never guess a parameter name.
2. **Craft the prompt.** Describe the scene concretely: subject, composition,
   style, palette. Default to a clean, non-literal, professional editorial look
   unless the Voice & Brand Profile §6 sets a `Visual style default`. Do NOT try
   to render the post's words inside the art (see brand text below).
3. **Apply brand text (if profile has it).** Read the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`)
   §6 Brand assets. If a handle, brand color, or logo is set, put the handle on
   the generated image with `gi_text_edit_image` so the text comes out legible
   (image models garble words in a generation prompt). Name the position (e.g.
   bottom-right) and the color in the edit instruction:
   ```
   img = gi_generate_image("Minimal flat-vector lighthouse cutting through fog, calm blue palette, editorial", 1200:628)
   out = gi_text_edit_image(img, "add the text @yourhandle, bottom-right, color #0A66C2")
   ```
   For a **quote-card**, see "Quote-cards" below: generate a plain background,
   then set the line with `gi_text_edit_image`.
4. **Model choice.** Use the connection's default model; the text edit handles
   the words, so the standard model is fine. Only reach for a premium option if
   the tool offers one and the task asks for premium art. Never silently
   upgrade the tier.
5. **Show + confirm.** Present the returned URL in the task. On approval, attach
   it to the TryPost draft as `media: [{ url }]` (or upload it and attach by
   `media: [{ id }]`, see the `trypost` skill), with `status: "draft"`. Going
   live follows `social-core` section 2.
6. **Manual mode.** If Loc-GenImage is not ready, put the drafted prompt + aspect
   in the task and ask for a supplied image or public URL to attach.

## Refine instead of regenerating

When the user wants a tweak ("make the sky darker", "swap the headline", "more
whitespace"), do NOT regenerate from scratch. Take the previous result and edit
it:

```
first = gi_generate_image("<scene>", 1200:628)        -> image + public URL
fixed = gi_edit_image(first, "make the background darker and increase contrast")
words = gi_text_edit_image(fixed, "replace the headline with: <new headline>")
final = gi_upscale_image(words)                        (last step, once text is right)
```

Editing the previous image is cheaper and more consistent than a fresh
generation. Chain it as many times as needed. Read back the text after every
`gi_text_edit_image`; a misspelled card is regenerated, not published.

## Cost-guard

- Every generation and edit costs compute. Generate one image at a time and
  stop at the count the post needs.
- Default to the connection's standard model and size; upscale only the final
  approved image. Use a premium model only when the task asks for it by name,
  and confirm that was intended.
- Record in the task how many images were generated and edited.

## Quote-cards: set the text, do not draw it

A quote-card is text-led, and image models draw text unreliably. Generate a
plain background (4:5, 1:1, or 16:9) with room for the line, then typeset the
pulled hook line onto it with `gi_text_edit_image`, so the hook line is crisp
every time, and attach the result exactly like an illustration:

```
bg   = gi_generate_image("<plain textured background in brand palette, empty centre>", 4:5)
card = gi_text_edit_image(bg, "set this text centred, large, high contrast: <the pulled hook line, up to 280 chars>; small @yourhandle bottom-right")
```

- Vary palette/layout between consecutive cards so a series doesn't look
  copy-pasted, or lock to the brand color in the profile.
- Long lines: break the line yourself into 2-4 short rows in the instruction;
  read back every word on the result.
- Manual mode (no Loc-GenImage) returns the card content as a spec for the
  user, same as an illustration.

## Brand logo

If the Voice & Brand Profile §6 names a logo, use the logo image (a public URL
the company supplied) as the input to `gi_edit_image` with an instruction to
place it (e.g. bottom-right, small), or describe it in the text edit if no image
is available. Never invent a logo.

- Logo constraints worth keeping: transparent PNG, small file, placed in a
  corner so it does not fight the subject.

## Multi-image grid (LinkedIn, up to 10)

LinkedIn posts can carry up to 10 images in a grid layout (not a swipeable
carousel, which the API does not support). Generate a set, one prompt at a time,
and attach them all to the one TryPost draft:

```
shots = [gi_generate_image(p, 1200:628) for p in ["scene A prompt", "scene B prompt", "scene C prompt"]]
media = [{url: s.url} for s in shots]   -> TryPost draft media
```

Take 2-10 prompts and keep the results in order. LinkedIn cannot mix images
with video in one post. Check `list-content-types-tool` for the account's
current media limits before attaching.

## Hard rules

- One image per request; for a multi-image grid, generate one prompt at a time.
- Keep real words in a `gi_text_edit_image` instruction, never baked into the
  prompt art.
- Respect the company's cost: default to the standard model and size unless asked.
- Never attach an image that has not been shown in the task and approved.
- No outside image service; if Loc-GenImage is not ready, use manual mode.
