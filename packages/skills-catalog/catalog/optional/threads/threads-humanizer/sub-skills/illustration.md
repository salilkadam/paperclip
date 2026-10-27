# Sub-skill: Generate an illustration for a Threads post

Adds an optional image to a draft (feed image, square art, or quote-card) and
attaches it to the TryPost draft. Uses Loc-GenImage (`gi_generate_image`,
`gi_edit_image`, `gi_text_edit_image`, `gi_upscale_image`) through the tool
gateway, which returns a public URL that goes straight into the TryPost post's
`media` (`social-core` sections 1 and 2).

## When this runs

- User says "add an image", "make an illustration", "make a quote-card", or
  "make a image" for a Threads post.
- Offer it once after a draft is approved, when a visual would lift reach.

## Backends (mirrors the publish layer)

- **Loc-GenImage** - connection `ready`: image generated + attached to the
  draft.
- **manual** - no ready Loc-GenImage connection: the skill drafts the image
  prompt and aspect in the task and asks for the image (or a public URL) to be
  supplied. Never blocks a draft.

`connections_search` reports which is available.

## Steps

1. **Pick the kind.** Default for Threads is `square` (aspect 1:1). Override
   the aspect when needed. Other kinds: thumbnail 16:9, carousel/
   quote/portrait 4:5, story/cover 9:16, wide/link 16:9, square 1:1. Pass the
   aspect or size using the input names in the `gi_generate_image` tool schema;
   never guess a parameter name.
2. **Craft the prompt.** Describe subject, composition, style, palette. Default
   to a clean professional look unless Voice & Brand Profile §6 sets a visual
   style. Do NOT bake the post's words into the art (use the text edit below).
3. **Apply brand text (if profile has it).** Read the voice profile in memory
   (`$AGENT_HOME/life/resources/social/voice-profile.md`, plus
   `threads/voice-profile.md` overrides) §6. If a handle, brand color, or logo is set,
   put it on the generated image with `gi_text_edit_image` so the text comes out
   legible (image models garble words in a generation prompt). Name the position
   and the color in the edit instruction:
   ```
   img = gi_generate_image("<scene prompt>", 1:1)
   out = gi_text_edit_image(img, "add the text @handle, bottom-right, color #RRGGBB")
   ```
   For a **quote-card**, generate a plain background with room for the line,
   then set the pulled hook line with `gi_text_edit_image` (not in the prompt),
   at 4:5.
4. **Model choice.** Use the connection's default model. The text edit handles
   the words, so the standard model is fine; only reach for a premium option if
   the tool offers one and the task asks for premium art. Never silently
   upgrade the tier.
5. **Show + confirm.** Present the returned URL in the task. On approval, attach
   it to the TryPost draft as `media: [{ "url": "<url>" }]` (or upload it and
   attach by `media: [{ id }]`, see the `trypost` skill), with
   `status: "draft"`. Threads takes up to 10 images per post (check
   `list-content-types-tool`). Going live follows
   `social-core` section 2.
6. **Manual mode.** If Loc-GenImage is not ready, put the drafted prompt + aspect
   in the task and ask for a supplied image or public URL.

## Refine instead of regenerating

When the user wants a tweak ("make the sky darker", "swap the headline", "more
whitespace"), do NOT regenerate from scratch. Take the previous result and edit
it:

```
first = gi_generate_image("<scene>", 16:9)     -> image + public URL
fixed = gi_edit_image(first, "make the background darker and increase contrast")
final = gi_upscale_image(fixed)                 (last step, once it is right)
```

Editing the previous image inherits its shape and is cheaper + more consistent
than a fresh generation. Chain it as many times as needed. Read back the text
after every `gi_text_edit_image`; a misspelled card is regenerated, not
published.

## Cost-guard

- Every generation and edit costs compute. Generate one image at a time and
  stop at the count the post needs.
- Default to the connection's standard model and size; upscale only the final
  approved image. Use a premium model only when the task asks for it by name,
  and confirm that was intended.
- Record in the task how many images were generated and edited.

## Hard rules

- One image per request; generate carousel slides one at a time.
- Keep real words in a `gi_text_edit_image` instruction, not baked into the prompt art.
- Default to the standard model and size unless the task asks for premium.
- Never attach an image that has not been shown in the task and approved.
- No outside image service; if Loc-GenImage is not ready, use manual mode.
