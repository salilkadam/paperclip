---
name: yt-thumbnail-brief
description: "Turn a YouTube video idea into a thumbnail brief: focal subject, face and emotion, a text overlay of 4 words or fewer that the title does not repeat, contrast, composition, and 2 to 3 A/B concepts. Renders the approved concept with Loc-GenImage and gives the attach step."
key: paperclipai/optional/youtube/yt-thumbnail-brief
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - video-producer
  - designer
tags:
  - youtube
  - social-media
  - thumbnails
  - design-brief
---

# YouTube Thumbnail Brief

> Read `social-core`, then the `youtube-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

This skill writes the brief a human designer (or an image tool) executes,
grounded in what actually drives the click in 2026, and documents how a custom
thumbnail gets attached when you auto-publish. Here the image tool is
Loc-GenImage: once a concept is approved, it can render it (step 6).

## When to use

- User says "what should the thumbnail be for this video"
- User wants a brief to hand to a designer or paste into an image generator
- User wants 2 to 3 thumbnail concepts to A/B test
- User is auto-publishing and needs the thumbnail upload steps

## What the brief contains

For each concept the skill outputs:

- **Concept name and the angle** it sells (and how it complements the title).
- **Focal subject:** a face plus the specific emotion, or the object/result.
- **Text overlay:** the exact words (4 or fewer), and where they sit. Never the
  same words as the title.
- **Background and contrast:** color, lighting, and how the subject separates.
- **Composition:** rule-of-thirds placement, gaze direction, crop.
- **120-pixel test note:** what must still read when shrunk to mobile size.

## Steps

1. **Gather inputs.** The title (so the thumbnail complements, never repeats it),
   the video's payoff and emotional tone, whether there is a face available, the
   single most visual moment or result, and long-form vs Short. If a URL is
   given, read the ids from it (URL table in the `youtube-marketing` hub).
2. **Split the load with the title.** Decide what the title already says and make
   the thumbnail carry the rest (the face/emotion, the result, the object). List
   the split explicitly.
3. **Write 2 to 3 concepts.** Vary one big element between them (face vs object,
   text vs no text, color), not five small things, so the A/B test is readable.
   Each concept fills the six fields above.
4. **Apply the non-negotiables.** One focal point, a legible real emotion, high
   contrast, 4 words or fewer of text, and it must read at 120 px. Flag any
   concept that risks failing the shrink test.
5. **Recommend the lead concept** for YouTube's Test & Compare and say why.
6. **Hand off the brief.** Give it to a designer, or render the approved concept
   with Loc-GenImage: `gi_generate_image` for the scene (16:9, 1280x720 or
   larger, no words in the art), then `gi_text_edit_image` to set the overlay
   words so they render legibly, `gi_edit_image` for tweaks to the same image
   instead of regenerating, and `gi_upscale_image` if it comes back under
   1280x720. Keep the result under 2 MB, JPEG or PNG. Show the image URL in the
   task and apply the 120 px shrink test to the real image, not the brief.
7. **If auto-publishing, give the upload flow** (see below). Otherwise the user
   sets the thumbnail in YouTube Studio.

## The thumbnail flow (auto-publish)

A custom thumbnail is a separate image from the video upload. The order is:

1. Create the video post as a **draft** in TryPost (`create-post-tool`,
   `status: "draft"`, no `scheduled_at`), per the `youtube-marketing` hub.
2. **Make the image** (step 6 above): JPEG or PNG, max 2 MB, 1280x720
   recommended. Keep its public URL.
3. **Attach it if TryPost can.** Check `list-content-types-tool` for a thumbnail
   or cover field on the YouTube content type. If one is listed, set it on the
   draft with `update-post-tool` (`status: "draft"`). When last checked
   (2026-10-27) the YouTube type listed none, so the thumbnail is set by a human
   in YouTube Studio: put the image URL in the publishing block (or the upload
   package) and say so.
4. Request go-live once (`social-core` section 2).

So this skill outputs the thumbnail **brief, the image, and the attach
instructions**. If the thumbnail cannot be attached through TryPost, ship the
video without the custom thumbnail and have it set in YouTube Studio.

Constraints: the channel must be **verified**; the apply is **best-effort** (a
rejected thumbnail does not block the video, it just ships without the custom
one); and you cannot change the thumbnail while the video is still processing.

## Hard rules

Global voice rules: see the `youtube-marketing` hub's Voice rules. Additional skill-specific
rules:

- Text overlay is 4 words or fewer, and never repeats the title's words.
- One focal point per concept. Two competing subjects halve the click.
- The emotion on a face must match the video. A shocked face on a calm tutorial
  is a broken promise the retention graph punishes.
- Every concept must pass the 120-pixel mobile read test.
- Always produce 2 to 3 concepts, each varying one big element.

## Anti-patterns (skill will refuse)

- Repeating the full title as the thumbnail text.
- A face with a fake exaggerated expression that the video does not earn.
- A busy collage with no single focal point.
- Tiny text or full sentences that vanish at 120 px.
- A thumbnail showing a moment that is not in the video.
- Punctuation in overlay text, em dashes included (a 3-word overlay is read at thumbnail size; it carries words, not clauses).

## Resources

- the `youtube-marketing` skill's `references/thumbnail-principles.md` - the full design language and the upload flow
- the `youtube-marketing` skill's `references/algorithm-heuristics.md` - packaging, CTR, Test & Compare
- `references/brief-template.md` - the fill-in brief a designer or image tool can execute

## Related skills

- `yt-title-optimizer` - the other half of the click; build them as a pair
- `yt-hook-scripter` - the spoken open should match the thumbnail's emotion
- `yt-content-planner` - pair titles and thumbnails across a week
