# TikTok post settings (TryPost `meta`): full matrix, defaults, and known bugs

Every TikTok setting TryPost accepts in a post's `meta`, with the default the
skills use and the gotchas. Always call `get-tiktok-creator-info-tool` with the
company's TikTok `account_id` first: it says which values this creator may use
right now. `list-content-types-tool` lists `required_meta` for TikTok and is the
live source if it disagrees with this file. Never invent a meta key.

## Privacy level

`meta.privacy_level` is **required** to schedule or publish. Pick it from the
creator info's `privacy_level_options` (only those values are allowed for this
creator). Always set it explicitly, even on a draft.

| Value | Who can view |
|---|---|
| `PUBLIC_TO_EVERYONE` | anyone (use this for reach) |
| `MUTUAL_FOLLOW_FRIENDS` | only mutual followers |
| `FOLLOWER_OF_CREATOR` | only your followers |
| `SELF_ONLY` | only you (use this to test a post end to end) |

A `SELF_ONLY` test post is still a go-live request: it goes through the
approval card like any other.

## Interaction settings

| Field | Default | Intended meaning |
|---|---|---|
| `allow_comments` | true | viewers can comment |
| `allow_duet` | false | viewers can Duet your video (`tiktok_video` only) |
| `allow_stitch` | false | viewers can Stitch your video (`tiktok_video` only) |

When creator info reports `comment_disabled`, `duet_disabled` or
`stitch_disabled` as true, the matching `allow_*` flag must stay false.

> **Known boolean inversion bug (upstream publisher).** The publisher these
> skills were written for mapped these to TikTok's `disable_*` flags, which
> inverted them: sending `allowDuet: true` could **disable** duets. That bug is
> not known for TryPost, and the mapping cannot be confirmed from the tool
> description alone.
>
> **How to handle it:** after the first post that changes a flag goes live,
> check the live post (`get-post-tool`, or in the app) before you trust the
> value. If duets are off when you asked for on, record it in the task and
> raise it; do not silently send the opposite.

## Commercial content settings

| Field | Default | Meaning |
|---|---|---|
| `disclose` | false | the video is commercial / promotional |
| `brand_organic_toggle` | false | promoting your own brand or product |
| `brand_content_toggle` | false | paid partnership or sponsored content |

> **Disclosure rule:** if `disclose` is true, at least one of
> `brand_organic_toggle` or `brand_content_toggle` must also be true, or the
> post is rejected. `SELF_ONLY` cannot be combined with `brand_content_toggle`.
> Check this yourself before creating the draft.

Set the right flag. Failing to disclose a paid partnership violates TikTok's
community guidelines, not just a validation rule. A company promoting its own
product sets `disclose` plus `brand_organic_toggle`.

## Other TikTok meta

| Field | Applies to | Meaning |
|---|---|---|
| `is_aigc` | `tiktok_video` | AI-generated content label; set it when the video came from the in-house generators |
| `auto_add_music` | `tiktok_photo` | let TikTok add music to a photo post |

## Posting reality

- **Unaudited apps post PRIVATE only.** Until the publishing app passes TikTok's
  review, every post is forced to `SELF_ONLY` regardless of `privacy_level`. If a
  "public" post lands private, or `privacy_level_options` offers only
  `SELF_ONLY`, this is why.
- **`can_post` false** in creator info means TikTok banned this creator from
  posting. Block the task.
- **Video length:** `max_video_post_duration_sec` is not checked when you
  schedule. Compare the video's duration yourself.
- **Rate limits:** 15 to 20 posts/day, 2 videos/minute. Space posts out. When
  TikTok reports a posting limit, creator info returns an error; scheduled posts
  retry once it lifts.
- **Caption cap:** 2,200 chars on the API (hashtags included). The native app
  allows 4,000, but the API enforces 2,200.

## Examples

Public reach video, comments on, duet/stitch off (the common default):

```json
{ "privacy_level": "PUBLIC_TO_EVERYONE", "allow_comments": true,
  "allow_duet": false, "allow_stitch": false }
```

A paid partnership, public, duets enabled (check the live post once):

```json
{ "privacy_level": "PUBLIC_TO_EVERYONE", "allow_comments": true,
  "allow_duet": true, "allow_stitch": false,
  "disclose": true, "brand_content_toggle": true }
```

A safe end-to-end test post nobody else sees:

```json
{ "privacy_level": "SELF_ONLY", "allow_comments": true,
  "allow_duet": false, "allow_stitch": false }
```

Each `privacy_level` must be one of the creator's `privacy_level_options`; each
`allow_*` must stay false where creator info reports it disabled.
