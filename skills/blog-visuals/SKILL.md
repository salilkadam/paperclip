---
name: blog-visuals
description: "Give a Ghost blog post its visuals: a hero image (ComfyUI), a workflow diagram as SVG where the post describes a process, and the hero as the LinkedIn thumbnail of its company post (TryPost). Use whenever a draft is written or formatted, or a company post is prepared."
---

# Blog visuals

Every blog post gets a **hero image**. A post that describes a process, a
sequence of causes or a pipeline also gets a **workflow diagram**. Its LinkedIn
company post gets the hero as its **thumbnail**. On reliora.ai the hero shows
under the post's lead paragraph and is the post's link-preview image, so every
post previews differently.

Never change a post's status, schedule, title, excerpt or text here: only add
images. Pass `tenant_id` (e.g. `"reliora"`) in every `gh_*` call. Make exactly
**one call per action, with its final arguments**: never probe argument
variants, and never call `connection_request` for Ghost, ComfyUI or TryPost
tools you already have.

## 1. Hero image (ComfyUI connection)

The hero is an **expressive editorial illustration on a pure white background**:
a small scene that tells the post's story at a glance, the way a magazine
illustrates an article. Not an abstract shape, not a dark background.

**Research the metaphor first** (write it in the task before generating):
1. Read the post. In one sentence, what goes wrong, and why? List the 3 to 7
   concrete things involved (the causes, the parts, the stages).
2. Pick an everyday scene a non-engineer understands in two seconds that has
   the same shape, and map each concrete thing to an object in it. Examples
   that worked:
   - "seven unrelated problems wearing the same status line": a police lineup of
     identical pods in the same red alarm mask, a magnifying glass revealing a
     different cause inside each (an expired key, a full drum, a toppled crown);
   - "the primary waits for the standby, which is buried in tiny reads": a
     courier robot waiting with a clipboard at a red light for a signature from
     a clerk buried under a mountain of envelopes pouring from a narrow funnel.
3. Prefer characters with a visible emotion (waiting, overwhelmed, relieved),
   one clear focal point, and objects instead of words.

1. `z_image_t2i` with `width: 1216`, `height: 640`, `return_inline_preview: false`
   and a prompt built as:
   "Editorial illustration on a pure white background. <the scene, with each
   mapped object and what the characters are doing or feeling>. Expressive,
   <playful|comic|tense>, clear storytelling, flat vector illustration with soft
   shadows, navy and teal with <red|amber> accents, generous white space, wide
   composition, no text, no letters, no numbers, no logos."
   Make the drama explicit ("buried up to its neck", "a long line stretching off
   the edge"); mild wording gives a mild picture. Record the prompt in the task.
   Each post's scene must differ from the others'.
2. If the call times out, the render usually still finishes: `list_assets`, and
   take the newest `z_image_t2i` asset of 1216x640 created in the last few
   minutes.
3. `view_image` takes the `asset_id` (not a URL or path); use it to confirm the
   size and format.
4. Fetch the asset's `asset_url` with `curl` from your runtime (it is reachable
   from your runner) and base64-encode the PNG. (`publish_asset` does not work
   here.)
5. `gh_upload_image` with `tenant_id`, `image_base64` and
   `filename: "<slug>-hero.png"`. It returns the image URL.
6. Set it: `gh_update_post` with `tenant_id`, `post_id`, `feature_image: <URL>`.

## 2. Workflow diagram (when the post describes a process)

1. Write it yourself as an **SVG**, `viewBox="0 0 1200 540"`:
   - white background `#FFFFFF`, matching the hero; boxes with a teal `#2BB3A8`
     outline and a light teal fill `#E8F6F5`; text navy `#0E1B2A`; the failing or
     key step may use a red `#D64545` accent; arrows navy;
     `font-family="system-ui, -apple-system, Segoe UI, sans-serif"`;
   - a title and a one-line subtitle at the top, 3 to 6 numbered boxes joined by
     arrows, each with a short label and at most two short lines taken from the
     post, and one closing line at the bottom;
   - no `<script>`, no event handlers, no links, no external fonts or images.
     Nothing the post does not say.
2. `gh_upload_image` with `filename: "<slug>-flow.svg"`.
3. Insert it once, in the section it explains, right after that section's
   steps list or first paragraph:
   `<!--kg-card-begin: html--><figure class="diagram"><img src="<URL>" width="1200" height="540" loading="lazy" decoding="async" alt="<one sentence describing the flow>"><figcaption><short caption></figcaption></figure><!--kg-card-end: html-->`
4. **Edit the body safely.** `gh_update_post` with `html` replaces the whole
   body. Read the CURRENT body with `gh_get_post` (only `tenant_id` and
   `post_id`; the full body is in `post.html`), insert the figure, and check
   that the new length is exactly the old length plus the figure's length. Then
   write once with `gh_update_post` (`html`, and `feature_image` in the same call
   if you set the hero now). Never send a partial body. Read it back and check
   the figure is there and nothing else changed.

## 3. LinkedIn thumbnail (TryPost connection)

1. The hero's public address is reliora.ai's media proxy: the Ghost URL
   `.../content/images/<path>` becomes `https://reliora.ai/blog-media/<path>`.
   Check it returns 200 `image/png`.
2. A post with no media yet: `attach-media-from-url-tool` with `post_id` and
   `urls: [{"url": "https://reliora.ai/blog-media/<path>", "alt": "<one sentence>"}]`
   (objects, not bare strings: bare strings fail).
   To REPLACE an image on a post (a new hero), use `update-post-tool` with the
   post's new `media` list, keeping its `status` and `scheduled_at` unchanged. On
   a scheduled post that is an approval card for the board: expected, request it
   once. Upload a new hero under a new file name (`<slug>-hero-v2.png`):
   previews and the CDN cache the old address.
3. Verify with `list-posts-tool`, not `get-post-tool`: the post has 1 media item
   and its status and time are unchanged.

## 4. Record

In the task, per post: the metaphor you chose and why, the hero prompt and its
public URL (`https://reliora.ai/blog-media/<path>`), the diagram URL and the
section it went into, and whether the LinkedIn media is attached. Put the hero's
public link in the board note too: you cannot see images, so the board's look
at the picture when it approves the schedule is the quality check. If a step failed, say
which and what you did instead.
