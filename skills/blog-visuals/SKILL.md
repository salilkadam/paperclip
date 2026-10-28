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

1. `z_image_t2i` with `width: 1216`, `height: 640`, `return_inline_preview: false`
   and a prompt that depicts **this post's** failure or idea:
   "Editorial hero illustration for an engineering blog about <the post's
   problem in one sentence>. <2 or 3 concrete visual elements from the post>.
   Isometric, clean vector style, deep navy background (#0E1B2A), teal (#2BB3A8)
   and soft white accents, subtle grid, minimal, high contrast, lots of negative
   space, no text, no letters, no logos."
   Record the prompt in the task. Each post's prompt must differ from the
   others' (you cannot see images, so distinct, concrete prompts are the check).
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
   - background `#0E1B2A`; boxes outlined or filled in teal `#2BB3A8`; text white
     or `#D6E4F5`; `font-family="system-ui, -apple-system, Segoe UI, sans-serif"`;
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
2. `attach-media-from-url-tool` with `post_id` and
   `urls: [{"url": "https://reliora.ai/blog-media/<path>", "alt": "<one sentence>"}]`
   (objects, not bare strings: bare strings fail).
3. Verify with `list-posts-tool`, not `get-post-tool`: the post has 1 media item
   and its status and time are unchanged.

## 4. Record

In the task, per post: the hero prompt and URL, the diagram URL and the section
it went into, and whether the LinkedIn media is attached. If a step failed, say
which and what you did instead.
