# Sub-skill: Generate an illustration for a Instagram post

Adds an optional image to a draft (feed image, carousel slide, or quote-card) and
attaches it to the TryPost draft. Uses Loc-GenImage (`gi_generate_image`,
`gi_edit_image`, `gi_text_edit_image`, `gi_upscale_image`) through the tool
gateway, which returns a public URL that goes straight into the TryPost post's
`media` (see the `instagram-marketing` skill's `references/media-workflow.md`).

## When this runs

- User says "add an image", "make an illustration", "make a quote-card", or
  "make a carousel" for a Instagram post.
- Offer it once after a draft is approved, when a visual would lift reach.

## Backends (mirrors the publish layer)

- **Loc-GenImage** - connection `ready`: image generated and attached to the
  draft automatically.
- **manual** - no ready Loc-GenImage connection: the skill drafts the image
  prompt in the task and asks for the image (or a public URL) to be supplied.
  Never blocks a draft.

`connections_search` reports which is available.

## Steps

1. **Pick the kind.** Default for Instagram is `carousel` (aspect 4:5). Override
   the aspect when needed. Other kinds: thumbnail 16:9, carousel/
   quote/portrait 4:5, story/cover 9:16, wide/link 16:9, square 1:1. Pass the
   aspect or size using the input names in the `gi_generate_image` tool schema;
   never guess a parameter name.
2. **Craft the prompt.** Describe subject, composition, style, palette. Default
   to a clean professional look unless Voice & Brand Profile §6 sets a visual
   style. Do NOT bake the post's words into the art prompt (set text in step 3).
3. **Apply brand text (if profile has it).** Read the Voice & Brand Profile in
   memory (`$AGENT_HOME/life/resources/social/voice-profile.md`) §6. If a handle,
   brand color, or logo is set, set the handle or slide text on the generated
   image with `gi_text_edit_image` so the words come out legible (image models
   garble text in a generation prompt). Name the position (e.g. bottom-right)
   and color in the edit instruction.
   For a **quote-card**, generate the background first, then put the pulled hook
   line on it with `gi_text_edit_image` (not in the generation prompt), aspect 4:5.
4. **Model choice.** Use the connection's default model. Only reach for a premium
   option if the tool offers one and the task asks for premium art. Never
   silently upgrade the tier.
5. **Show + confirm.** Present the returned URL in the task. On approval, attach
   it to the TryPost draft as `media: [{ url }]` (or upload it and attach by
   `media: [{ id }]`, see the `trypost` skill's media quirk), with `status: "draft"`.
6. **Manual mode.** If Loc-GenImage is not ready, put the prompt in the task and
   ask for a supplied image or public URL.

## Refine instead of regenerating

When the user wants a tweak ("make the sky darker", "swap the headline", "more
whitespace"), do NOT regenerate from scratch. Take the previous result and edit
it:

```text
first = gi_generate_image("<scene>", 16:9)          -> image + public URL
fixed = gi_edit_image(first, "make the background darker and increase contrast")
words = gi_text_edit_image(fixed, "replace the headline with: <new headline>")
final = gi_upscale_image(words)                      (last step, once text is right)
```

Editing the previous image is cheaper and more consistent than a fresh
generation. Chain it as many times as needed. Read back the text on every
slide after `gi_text_edit_image`; a misspelled slide is regenerated, not
published.

## Cost-guard

- Every generation and edit costs compute. Generate carousel slides one at a
  time and stop at the slide count the plan needs (2-10).
- Default to the connection's standard model and size; upscale only the final
  approved images.
- Record in the task how many images were generated and edited.

## Hard rules

- One image per request; generate carousel slides one at a time.
- Keep real words out of the generation prompt; set them with `gi_text_edit_image`.
- Default to the standard model and size unless the task asks for premium.
- Never attach an image that has not been shown in the task and approved.
- No outside image service; if Loc-GenImage is not ready, use manual mode.
