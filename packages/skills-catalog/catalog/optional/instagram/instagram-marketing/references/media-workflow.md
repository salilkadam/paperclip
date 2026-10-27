# Instagram Media Publishing Workflow

Instagram requires media on every post. There is no text-only Instagram post:
the API rejects it. So the writer skills in this bundle produce the **caption,
hook, hashtags, and slide or shot plan**, and the **media is produced in-house**
(or supplied by the task). Publishing is always a media flow, through TryPost,
with the go-live step gated by a board approval card (`social-core` section 2).

## Contents

- Producing the media in-house
- The flow (TryPost)
- Container rules (what the media list becomes)
- Media limits (publish-time)
- No media, or no TryPost account
- Cleaning up a failed attach

## Producing the media in-house

| Need | Tool | Notes |
|---|---|---|
| Single feed image, quote card | Loc-GenImage `gi_generate_image` | 4:5 portrait (1080x1350) fills the feed best |
| Carousel slides (2-10) | Loc-GenImage `gi_generate_image` per slide, or one base image edited with `gi_edit_image` for a consistent look | keep one visual style across the set |
| Legible text on a slide or cover | Loc-GenImage `gi_text_edit_image` | image models garble text; set the slide copy with the text-edit tool, never in the generation prompt alone |
| Final size / sharpness | Loc-GenImage `gi_upscale_image` | upscale after text is set |
| Cut-out product or face | Loc-GenImage `gi_remove_background` | |
| Reel, promo, ad (live action) | `marketing-video-studio` skill | brief it with the shot plan from the writer skill |
| Reel, 2D explainer | `motion-explainer-studio` skill | |
| Trim, 9:16 crop, transcode, carousel clip under 60s | Loc-FFmpeg | search the connection's tools by name |
| Blog article as source | Ghost blog `gh_*` tools | fetch the article, then plan slides from it |

Each tool returns a file or a public URL. Keep the slide order explicit in the
task (slide 1 = hook slide) and check every slide against the limits below
before attaching. Read back each slide's text after `gi_text_edit_image`: a
misspelled slide is a reshoot, not a caption fix.

If a connection a step needs is missing or not `ready`, block the task and name
it (`social-core` section 1). Do not swap in an outside image or video service.

## The flow (TryPost)

The order matters: the media is attached while the post is still a draft, and
scheduling is a separate go-live request.

```
1. get-workspace-tool, list-social-accounts-tool
      -> the company's Instagram Business/Creator account id and timezone
2. list-content-types-tool
      -> the Instagram content type (feed, carousel, Reel, story), media rules, required meta
3. attach the media, in slide order, one of:
      - public direct file URL (Loc-GenImage / video studio output) -> media: [{ url }]
      - existing TryPost media -> media: [{ id }]
      - local file -> request-media-upload-tool, upload to the signed URL,
        then attach with media: [{ id: <media_id> }]
4. create-post-tool  status "draft", content = approved caption, media in order
5. preview-post-tool, then the publishing block in the task
      (account display name, post id, intended time in account timezone and UTC,
       final caption, media list in order)
6. update-post-tool  status "scheduled" + scheduled_at (or "publishing")
      -> gateway answers approval_required, approval card posted
      -> task to in_review, end the run
7. on approval: get-post-tool, record the result
```

Media quirk (see the `trypost` skill): attaching with `media: [{ upload_token }]`
fails with a provider 502 in some deployments. After `request-media-upload-tool`,
attach with `media: [{ id: <media_id> }]` instead. Never send an empty
`media: []`; omit `media` when it does not change. An upload is temporary (24
hours, single use), so attach it in the same run.

Always send `status: "draft"` explicitly while drafting or editing; an omitted
status counts as a go-live request.

## Container rules (what the media list becomes)

| Media supplied | Becomes | Notes |
|---|---|---|
| 1 image (JPEG/PNG/WebP) | a single photo post | WebP auto-converts to JPEG |
| 2-10 images | a carousel, in list order | no mixed media, all images |
| 1 video (MP4/MOV) | a Reel by default | Story via the story content type |
| mixed images + video | rejected | the API does not allow mixed carousels |

The surface (feed post, carousel, Reel, story) is chosen by the TryPost
`content_type` and any meta that `list-content-types-tool` lists for Instagram.
Read it there; never guess a content type or meta key. At the time of writing
TryPost offers `instagram_feed` (a single video on it publishes as a Reel),
`instagram_reel` and story types; carousel order is the `media` order (the first
item is the cover). For a Reel cover frame, set the media item's
`meta.cover_offset_ms` on content types that report `supports_video_cover`;
otherwise the first frame is the cover, so design frame 1 as the cover. Mark
AI-generated media with `meta.is_ai_generated` where the content type takes it.
TryPost accepts at most 5 hashtags on Instagram, which matches the 3-5 rule.

## Media limits (publish-time)

| Item | Limit |
|---|---|
| Image formats | JPEG, PNG, WebP (WebP auto-converts to JPEG) |
| Image max size | 8 MB |
| Carousel items | 2-10 (API) |
| Reel duration | up to 3 min (180s); 5-90s eligible for the Reels tab |
| Reel/video size | 300 MB |
| Carousel video clip | up to 60s |
| Aspect ratio | 4:5 portrait to 1.91:1 landscape; 4:5 fills the feed best |
| Caption | 2,200 chars (first ~125 visible) |
| Account type | Business or Creator (personal is not supported) |

`list-content-types-tool` is the live source; if it disagrees with this table,
it wins.

## No media, or no TryPost account

If the media cannot be produced (a connection is missing) or the task says the
company will supply it, deliver the approved caption as a copy-paste block in
the task plus a note of exactly which image or video is still needed. Instagram
still needs the image or video, so the note is not optional.

If TryPost has no Instagram Business or Creator account for the company, block
the task and name the missing account; do not post to another account.

## Cleaning up a failed attach

If an attach fails after the draft exists, the draft can hold a broken media
reference that blocks scheduling. Re-upload (change the arguments; the gateway
replays byte-identical calls) and update the draft with `status: "draft"` and
the new media. If the draft is still broken, ask the board in the task to
delete it in TryPost; do not delete posts yourself.
