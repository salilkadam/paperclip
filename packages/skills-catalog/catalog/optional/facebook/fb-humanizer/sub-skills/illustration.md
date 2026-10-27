# Sub-skill: Generate an illustration for a Facebook post

> Read `social-core`, then the `facebook-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`.

Adds an optional image to a draft (feed image, link-preview image, or quote-card) and
attaches it on publish. Uses Loc-GenImage (`gi_generate_image`, `gi_edit_image`,
`gi_text_edit_image`, `gi_upscale_image`), which returns a public image URL that
goes into TryPost media (`media: [{ url }]`) on the Page post draft.

## When this runs

- User says "add an image", "make an illustration", "make a quote-card", or
  "make a cover" for a Facebook post.
- Offer it once after a draft is approved, when a visual would lift reach.

## Backends

- **Loc-GenImage** - connection ready: image generated, URL attached
  automatically.
- **manual** - no ready connection: the skill drafts the image prompt and asks
  in the task for someone to generate it and paste the URL. Never blocks a draft.

`connections_search` tells you which is active.

## Steps

1. **Pick the kind.** Default for Facebook is `wide` (aspect 1200:628). Override
   the aspect ratio when needed. Other kinds: thumbnail 16:9, carousel/
   quote/portrait 4:5, story/cover 9:16, wide/link 16:9, square 1:1.
2. **Craft the prompt.** Describe subject, composition, style, palette. Default
   to a clean professional look unless Voice & Brand Profile §6 sets a visual
   style. Do NOT bake the post's words into the art (use overlay).
3. **Apply brand overlay (if profile has it).** Read the voice profile in agent
   memory (`$AGENT_HOME/life/resources/social/voice-profile.md`) §6. If a handle,
   brand color, or logo is set, generate the scene first with `gi_generate_image`,
   then add the text with `gi_text_edit_image` (handle, position such as
   bottom-right, brand color) so the words render legibly and exactly. Name the
   tool's real arguments from the tool search; do not guess them.
   For a **quote-card**, put the pulled hook line in the `gi_text_edit_image`
   step (not the scene prompt), 4:5.
4. **Model choice.** Use the connection's default model and resolution. The text
   step handles the words, so the default base model is fine; only pick a premium
   option on premium art when the task asks. Never silently upgrade the tier.
5. **Show + confirm.** Present the returned image URL in the task. On approval,
   attach it to the TryPost draft as `media: [{ url: "<image url>" }]` (or by
   `media: [{ id }]` after `request-media-upload-tool`).
6. **Manual mode.** If there is no ready Loc-GenImage connection, put the prompt in
   the task and ask for a pasted URL.

## Refine instead of regenerating

When the user wants a tweak ("make the sky darker", "swap the headline", "more
whitespace"), do NOT regenerate from scratch. Edit the previous result:
`gi_edit_image` for the scene ("make the background darker and increase
contrast"), `gi_text_edit_image` for the words. Editing keeps the source shape
and is more consistent than a fresh generation. Chain it as many times as
needed; `gi_upscale_image` once at the end if the result is too small.

## Cost-guard

- Generate only what the task needs: one image per concept, edits instead of
  regenerations.
- Default to the connection's standard model and resolution. Premium options
  cost more - only use them when the task asks by name, and never upgrade on
  your own.
- If a result reports a cost or a low balance, record it in the task before
  generating more.

## Hard rules

- One image per request (`n>1` unsupported); generate carousel slides one at a time.
- Keep real words in the `gi_text_edit_image` step, not baked into the prompt art.
- Default to the standard model and resolution unless the task asks for premium.
- Never attach an image the user has not seen and approved.
