---
name: fb-post-writer
description: Draft a short punchy Facebook Page post or a longer story post with a 2026 hook formula (one-line opinion, tiny number, ask-the-page, this-or-that, tip, story) picked by goal. Favors the under-80-char sweet spot, runs the humanizer pass, publishes via TryPost.
key: paperclipai/optional/facebook/fb-post-writer
recommendedForRoles:
  - content-marketer
  - marketer
  - social-media-manager
  - writer
tags:
  - facebook
  - social-media
  - copywriting
  - page-posts
---

# Facebook Page Post Writer

> Read `social-core`, then the `facebook-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Ship a short punchy Page post, or a longer story post when the material earns it,
using hook shapes that actually travel on a Facebook Page in 2026. The single
highest-engagement move on a Page is the short post: posts under 80 characters
get a reported ~66% engagement lift, so this skill leads short and only goes long
on purpose.

## When to use

- User says "write me a Facebook Page post about X"
- User has a topic or a rough line and wants a sharper, shorter hook
- User wants to pick a proven Page-post shape and fill in their voice
- User wants a quick draft that publishes through TryPost once the board approves it

## Formulas this skill uses

| Code | Formula | Primary goal | Best for |
|---|---|---|---|
| FB1 | One-Line Opinion | shares | a sharp, defensible take in one short line |
| FB2 | The Tiny Number | shares | one concrete number that reframes a thing |
| FB3 | Ask-the-Page Question | comments | an easy, fun question the audience answers |
| FB4 | This-or-That | comments | a friendly binary choice readers pick a side on |
| FB5 | Relatable One-Liner | reactions | a specific shared moment, no setup |
| FB6 | Behind-the-Scenes | reactions | a real human moment inside the business |
| FB7 | Useful Tip | shares | one usable tip the reader passes on |
| FB8 | Story Post with a Turn | shares | a longer true story with a quotable turn |
| FB9 | Announcement with Stakes | shares | a launch or news, led human not corporate |
| FB10 | Community Spotlight | shares | featuring a real customer or team member |

Full skeletons in the `facebook-marketing` skill's `references/hook-formulas.md`. FB1-FB7 are short-post
shapes (lead here). FB8-FB10 are longer story shapes (use on purpose).

### Pick by goal first

| Goal | Reach for |
|---|---|
| Shares | FB1, FB2, FB7, FB8, FB9, FB10 |
| Comments | FB3, FB4, FB8 |
| Reactions | FB5, FB6 |

## Steps

**Voice profile first (all drafts).** If the voice profile in agent memory (`$AGENT_HOME/life/resources/social/voice-profile.md`, with Facebook-only overrides in `$AGENT_HOME/life/resources/social/facebook/voice-profile.md`; template: the `facebook-marketing` skill's `references/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `fb-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules.

**Story bank next.** If the story bank in agent memory (`$AGENT_HOME/life/resources/social/story-bank.md`; template: the `facebook-marketing` skill's `references/story-bank.md`) has `filled: yes`, load it and take every concrete detail (numbers, dates, named projects, positions) from there instead of asking mid-draft. **Never invent a figure, a date or a client name that is not in the bank or supplied by the user in the task or this conversation.** If the bank has nothing that fits, ask the user, or say once that `fb-humanizer --mode interview` fills it in 20 to 40 minutes. A draft with a plausible invented number is worse than a draft with none: one is vague, the other is a retraction.

1. **Gather inputs.** Topic, angle, any rough draft, target audience (B2C / B2B /
   local / community), and the goal (shares / comments / reactions).
2. **Pick the container.** Default to a short post (aim under 80 chars). If it is
   one opinion, number, question, or moment, it stays short. Only escalate to a
   story post (FB8-FB10) if the idea is a true narrative, a real launch, or a
   spotlight that needs room.
3. **Pick the formula.** Use the goal table to shortlist, then suggest 2-3 that
   also fit the topic and let the user choose.
4. **Draft the post.** Fill the skeleton in the user's voice. Respect the 2026
   Facebook rules:
   - Lead short. Try to land the whole point under 80 chars.
   - First line carries the post (Facebook folds longer posts behind "See more").
   - One idea per post. Line breaks as beats.
   - 0-2 hashtags, 0-2 emoji, none on a serious take.
   - If the post includes a link, write framing text above it (Facebook builds a
     preview card) and warn that link posts reach fewer people organically.
5. **Humanizer pass.** Scrub 2026 AI vocab by paragraph density, cap em
   dashes (about one per 100 words, never swap one for a period), strip "We
   are thrilled to announce" and every corporate opener, break stacked triads
   and reveal bridges. Fix only a story paragraph that reads machine-flat;
   never manufacture variance, and never fragment a short post for punch. Add
   an odd-precision number with a named referent or a named entity where the
   claim allows it. Canonical rules: `fb-humanizer` V3.
6. **Optional audit.** Invoke `fb-humanizer --mode audit` for a pass-fail check.
7. **Approval card.** Show: formula used, full draft, char count (flag if it
   crosses the 80-char sweet spot), suggested posting window, primary goal.
8. **On approval.** Create the post in TryPost as a draft on the company's
   own Facebook Page (`create-post-tool`, `status: "draft"`, content type from
   `list-content-types-tool`, usually `facebook_post`; a deliberate long story
   post is the same type), attach any image by its public URL, then
   `preview-post-tool`, the publishing block in the task (Page name, post id,
   intended time in the Page timezone and UTC, final text, media) and one go-live
   request with `update-post-tool`. The board approves the card
   (`social-core` section 2).

## Hard rules

Global voice rules: see the `facebook-marketing` hub's Voice rules. Additional skill-specific
rules:

- Lead short. Default to under 80 chars; that is the engagement sweet spot. A
  long post is a deliberate choice for a story, not the fallback.
- The first line must carry the post on its own (everything above the "See more"
  fold).
- One specific number where the claim allows it. "4 minutes" beats "fast".
- Never open with "We are thrilled / excited / delighted to announce".
- Do not beg for engagement. Earn the share or comment with the post itself.

## Anti-patterns (skill will refuse)

- "We are thrilled to announce.." and every variant.
- Engagement bait ("LIKE and SHARE if you agree", "comment YES", "tag 3 friends").
- Em dashes above the cap (more than about one per 100 words), or an em dash swapped for a period.
- "Here's what" or "Stop X, start Y" as the opener; "The result?" as a reveal.
- Announced candor ("We'll be honest with you", "real talk") with no dated fact behind it.
- Staccato stacks ("No X. No Y. Just Z.") and one-word lines added for drama.
- Padding a one-line idea into five paragraphs.
- Rule-of-three lists without specifics.
- "leverage", "fundamentally", "game-changer", "deep dive".
- A bare external link with no framing text.
- 5+ hashtags stuffed at the bottom.

## Resources

- the `facebook-marketing` skill's `references/hook-formulas.md` - all 10 Facebook formula skeletons (FB1-FB7 short, FB8-FB10 story)
- the `facebook-marketing` skill's `references/algorithm-heuristics.md` - 2026 Facebook Page ranking rules (signals, the under-80 boost, timing, limits)
- `references/short-post-checklist.md` - the per-post scrub and the under-80 fit check

## Optional illustration

Offer a generated image when a visual would lift reach. Draft a prompt and
generate it with Loc-GenImage (`gi_generate_image`, 16:9 wide; `gi_text_edit_image`
for any words such as the brand handle so they render legibly), pulling brand
handle/color from Voice & Brand Profile section 6. Show the returned image URL in
the task, then attach it to the TryPost draft as `media: [{ url }]`. Full workflow
(incl. quote-cards): the `fb-humanizer` skill's `sub-skills/illustration.md`. No
Loc-GenImage connection -> draft the prompt for a human to generate manually.

## Related skills

- `fb-humanizer` - aggressive AI-tell scrubber, plus `--mode audit` for review
- `fb-hook-extractor` - reverse-engineer a hook from a Page post you admire
- `fb-content-planner` - plan a week of these posts
- `fb-engagement-drafter` - reply to the comments your post earns
