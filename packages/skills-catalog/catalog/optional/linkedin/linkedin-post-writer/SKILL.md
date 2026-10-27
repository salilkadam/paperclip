---
name: linkedin-post-writer
description: Draft a new LinkedIn post from scratch with one of 20 2026 hook formulas plus a founders-edition angle library, picked by engagement goal (comments, reposts, likes, saves), then humanize and stage it as a TryPost draft. Not for reviewing drafts (use linkedin-humanizer).
key: paperclipai/optional/linkedin/linkedin-post-writer
recommendedForRoles:
  - content-marketer
  - marketer
  - writer
  - social-media-manager
  - founder
tags:
  - linkedin
  - social-media
  - copywriting
  - hooks
---

# LinkedIn Post Writer

> Read `social-core`, then the `linkedin-marketing` hub, before using this skill. Tools, publishing and approval follow `social-core`. If either skill is not installed, stop and ask the board to install the Social Content Studio team or both skills.

Ship long-form LinkedIn posts using hook formulas that actually performed in 2025-2026 (verified engagement multipliers).

## When to use

- User says "write me a LinkedIn post about X"
- User has a topic + a rough angle and needs a hook + structure
- User wants to pick from known-winning formats and fill in their voice
- User wants to audit + schedule in one flow

## Formulas this skill can use

| Code | Formula | Reference eng | Best for |
|---|---|---|---|
| F1 | Platform Risk Anaphora | 4,240 | Category/platform posts, product-as-fix |
| F2 | R.I.P. Obituary | 3,822 | Era-ending claims, industry pivots |
| F3 | Year-over-Year Pivot | 494, 3.74x | Identity shifts, founder reflection |
| F4 | Time-Anchor Confession | 1,519+ | Vulnerability, voice reset, ICP re-targeting (2026: use with care, see caveats) |
| F5 | Self-Proving Meta | 1,082 / 435 comments | Commitment-based posts, tests in public |
| F6 | Comment-Gate Lead Magnet | 717-3,008 | List building (2026: use with care, real deliverable only, see caveats) |
| F7 | Odd-Precision Money Ledger | 1,755, 9.4x | Founder build-log, cost breakdowns (2026: strongest opener, number-first) |
| F8 | Paid-vs-Free Reversal | 550, 19.64x | Free framework give-away |
| F9 | Curiosity-Gap Teaser | 306, 4.25x | Emergent behavior, behind-the-scenes (2026: use with care, pay off in 2 lines) |
| F10 | Contrarian + Historical Receipts | 3,083 | Sacred-cow takes, AI/tech cycles |
| F11 | Emotional Cold-Open | high-reach* | Real story with emotional stakes (likes) |
| F12 | Permission Slip | comment-heavy* | Encouragement, reassurance (comments; 2026: use with care, needs a dated fact) |
| F13 | Bait-and-Switch Reversal | high-reach* | Policy/process change that's an upgrade (likes) |
| F14 | Named Gratitude / Tribute | repost-heavy* | Thanking mentors / team / departing colleague (reposts) |
| F15 | Explain-to-Kids | save-heavy* | Demystifying jargon (saves) |
| F16 | Status-Strip Humility | like-heavy* | Senior voice wanting warmth not distance (likes) |
| F17 | Controlled A/B Anecdote | structural† | One-variable comparison, delegation/AI takes (comments) |
| F18 | False-Binary Dissolve | structural† | "Both obvious answers fail" governance/strategy (comments/reposts; 2026: it is the post's one contrast) |
| F19 | Anecdote-Meets-Evidence Bridge | structural† | Personal noticing + a data stack (comments/saves) |
| F20 | Diverging-Curves Close | structural† | Two trajectories that diverge, quotable maxim (reposts) |

\* F11-F16 reach is absolute 2026-corpus reach (often source-driven: a reshare or a famous author), NOT a baseline multiplier like the F1-F10 numbers. The two columns measure different things and are not comparable: F11's "256k" is raw reach, F8's "550, 19.64x" is a format multiplier. Do not rank formulas by putting these side by side. See the `linkedin-marketing` skill's `references/hook-formulas.md` for each formula's real reference and caveats.

† F17-F20 are **structural formulas**: they shape the logic of a post (a controlled comparison, a false binary, an evidence bridge, two diverging curves) rather than its topic. They carry no reference number and are chosen by primary goal. They were built for the founders edition and several founder angles pin them by name.

Full skeletons in the `linkedin-marketing` skill's `references/hook-formulas.md`. F1-F10 are the long-form thought-leadership set; F11-F16 (validated against a 2026 corpus of above-average performers) skew shorter and emotional and each carries a primary engagement goal.

### 2026 reach caveats (Sep 2026 audit)

The reference numbers above are unchanged; what changed is how the 2026 feed treats the *device* each formula leans on. Every formula in the `linkedin-marketing` skill's `references/hook-formulas.md` now carries a "2026 reach note"; the ones that matter when picking:

- **Never open with a question.** Question as the first line is -34% median likes across all follower bands (MagicPost, 1.2M posts; vendor data, proprietary AI-score). Move the question to the close, where it is +3%.
- **Prefer number-first.** An odd-precision number in line 1 is +34% median likes (same source). F7 is the strongest 2026 opener; F3, F5, F17 are number-first by construction.
- **F4 Confession, use with care:** a specific, dated, uncomfortable fact with no "let me be honest" / "confession:" framing; substance inside the first 3 lines. Manufactured candor is the "false vulnerability" tell; genuine vulnerability is +7 to +10% (vendor data).
- **F6 Comment-Gate, use with care:** comment-gate CTAs are the named target of LinkedIn's March 2026 authenticity update, and the July 2026 "AI slop" report button cuts flagged posts ~40% views. Only with a real, named deliverable, and never "comment X to get Y" phrasing.
- **F9 Curiosity-Gap, use with care:** teaser phrases ("what nobody tells you", "what most people miss", "the real question is") are on the 2026 AI-tell consensus lists. The gap must be specific and pay off within 2 lines, before the fold.
- **F12 Permission Slip and F18 False-Binary, use with care:** both are generic-frame devices ("Stop X, start Y" -6.7%, "It's not X, it's Y" -4.9%, vendor data). They survive with a dated fact and as the post's only contrast.
- **Density rule:** one contrast and one triple per post, zero "The result?" / "Plot twist:" / "Here's what" bridges. 98-100% of top human creators still use these devices; the tell is repetition plus emptiness, not the device.
- **Still lifts reach:** number-first line, closing question, P.S. sign-off (+7.5%), 1,000+ chars (1.18x) and 20+ sentences (1.14x, AuthoredUp 3M posts), 1-2 sentence paragraphs with blank lines (recommended layout, not a tell).

### Pick by goal first

If the user knows what they want the post to earn, start here, then narrow by topic. Canonical mapping: the `linkedin-marketing` skill's `references/hook-formulas.md` → Engagement-goal split.

| Goal | Reach for |
|---|---|
| Comments | F17, F10, F4, F12, F9 (F4/F12/F9 with their 2026 caveats) |
| Reposts | F14, F2, F8 |
| Likes | F11, F13, F16 |
| Saves | F15, F7, F8 |

## Steps

**Voice profile first (all drafts).** If the voice profile in memory (`$AGENT_HOME/life/resources/social/voice-profile.md`) has `filled: yes`, load it and match the user's voice fingerprint, hard rules, and CTA/link style throughout. If it is not filled, mention once that `linkedin-humanizer --mode profile` can learn their voice from a few posts, then proceed with the generic voice rules. If the story bank in memory (`$AGENT_HOME/life/resources/social/story-bank.md`) has `filled: yes`, load it too and take concrete details (numbers, dates, named projects) from there instead of asking mid-draft. Never invent a figure that is not in it; if the bank has nothing that fits, ask the user or offer `linkedin-interviewer`.

**Founder mode (when the writer is a founder).** Before picking a formula, open the `linkedin-marketing` skill's `references/founder-topics.md` and offer a founder **angle** (A1-A10) that fits their goal. The angle picks the *territory* (reprice the category, the scarce-shots math, the delegation line, and so on); several angles pin the formula for you (A9 uses F17, A10 uses F18+F20). Founder angles compound trust with a narrow audience of investors, hires, and design partners rather than chasing broad reach. Fill the angle's bracketed slots with the founder's real numbers, then continue from step 3.

**Spine from an interview (skip the asking).** If `linkedin-interviewer --mode post` handed over a five-line spine (Moment, Number, Correction, Opposition, Ask), that spine is the skeleton: Moment opens the post, Number is the proof, Correction is the turn, Opposition fixes the audience, Ask is the close. Do not re-ask for anything the spine already carries, and do not fill a line the interview left labelled empty. Pick the formula that fits the spine rather than bending the spine to a formula; if none fits, say which line is the obstacle.

1. **Gather inputs.** Topic, angle, draft ideas if the user has them, target audience (founders / operators / marketers), desired length (short 300-500 / medium 900-1300 / long 1500-1900 chars).
2. **Pick the formula.** First ask (or infer) the goal: comments, reposts, likes, or saves. Use the "Pick by goal first" table to shortlist, then suggest 2-3 formulas that also fit the topic and let the user pick. Show the reference engagement number next to each, plus the formula's 2026 caveat if it has one. Two hook rules apply regardless of formula: **never open with a question** (-34% median likes; the question goes at the close, +3%) and **prefer a number-first line** (+34% median likes; both MagicPost vendor data, proprietary AI-score). If the best hook you have is a question, invert it into the number that answers it.
3. **Draft the post.** Fill the formula skeleton with user voice. Respect the 2026 algorithm rules:
   - Hook in first 210 chars (before "… see more"); line 1 is a statement or a number, never a question, never "Here's what/how", never "Stop X, start Y"
   - Length: **the target the user picked in step 1 wins.** 900-1,300 chars is the default when they express no preference, not a ceiling over their choice. If they asked for long (1,500-1,900), write long and do not trim toward the sweet spot: 1,000+ chars and 20+ sentences carry a 1.18x / 1.14x reach lift (AuthoredUp, 3M posts), so the evidence runs with them, not against them. The one hard limit is LinkedIn's 3,000 characters.
   - Double line-breaks between ideas, not single; 1-2 sentence paragraphs are the recommended layout
   - One contrast and one triple per post maximum; no "The result?" / "Plot twist:" reveal bridges (Density rule in the `linkedin-marketing` skill's `references/hook-formulas.md`)
   - Close with a specific question, and add a one-line P.S. when there is a real follow-up (+7.5%)
   - 0-2 hashtags, placed at end
   - No external links in body (move to first comment)
4. **Humanizer pass.** Scrub 2026 AI vocab by density, cap em dashes (about one per 100 words), break stacked triads, generic openers and reveal bridges. Add at least 1 specific number, 1 named entity, 1 first-person concrete detail per 100 words.
5. **Run audit.** Optionally invoke `linkedin-humanizer --mode audit` for algorithm + voice checks before showing to user.
6. **Optional illustration.** If the post would land better with a visual (or the user asks), offer one: draft an image and generate it with Loc-GenImage `gi_generate_image` (wide, 1200:628), pulling brand handle/color from Voice & Brand Profile §6 and setting the handle with `gi_text_edit_image`. Show the returned URL in the publishing block and attach it to the TryPost draft as `media`. For a **multi-image grid** (2-10 images in one post) generate one prompt at a time and attach every URL to the one draft. For a **quote-card of the hook**, generate a plain background and typeset the hook line on it with `gi_text_edit_image` (never in the generation prompt), same URL flow. Full workflow: the `linkedin-humanizer` skill's `sub-skills/illustration.md`. No ready Loc-GenImage connection -> it drafts the prompt for a human to generate manually.
7. **Publishing block.** Create the TryPost draft (`status: "draft"`) on the company's LinkedIn account (resolve it with `list-social-accounts-tool`; a `linkedin-page` account needs `content_type: linkedin_page_post`, see the `trypost` skill), run `preview-post-tool`, and put in the task: formula used, full draft, char count, account display name, post id, suggested posting window (Tue/Wed/Thu 7:30-9:00 AM local, with the UTC time), reaction targets from likely commenters, and the illustration (if any).
8. **Request go-live.** Call `update-post-tool` once with `status: "scheduled"` and `scheduled_at` (or `status: "publishing"` for now). The gateway answers `approval_required` and posts the approval card; move the task to `in_review` and end the run (`social-core` section 2). If the link belongs in the first comment, put that comment in a copy-paste block for after the post is live. If the company reconsiders after the card is approved, call `update-post-tool` with `status: "draft"` to pull it back before it goes out.

## Hard rules (from user feedback)

Global voice rules: see the `linkedin-marketing` hub `SKILL.md` §Voice rules. Additional skill-specific rules:

- Never frame LinkedIn as inferior in a LinkedIn post (algo penalty).
- Don't name-drop the user's product in a way that reads as self-promo. One mention max, and only when it's the natural conclusion, not the pitch.
- Include at least one moment of real vulnerability or concrete stakes. Pure insight posts don't land in 2026.
- Natural rhythm, not manufactured variance: one genuinely long sentence next to a short one per paragraph is fine; never alternate long/short across the post and never stack fragments (at most 2 standalone fragments per post). Touch a paragraph only if every sentence reads the same flat length.

## Anti-patterns (skill will refuse)

- All-caps first line ("THIS CHANGED EVERYTHING."). This holds even for F11 Emotional Cold-Open: carry the intensity with word choice, never caps.
- Question as the first line ("Ever wondered why...?"). Invert to a number, move the question to the close.
- "Here's what / here's how" or "Stop X, start Y" as the opener; "The result?" / "Plot twist:" as a reveal bridge
- Announced candor ("Let me be honest", "Confession:") with no dated fact behind it
- "Comment X to get Y" comment-gate phrasing
- Em dashes above the cap (more than about one per 100 words)
- "In today's fast-paced world" openers
- Rule-of-three lists without receipts
- "Game-changer", "deep dive", "leverage", "fundamentally"
- External links in the body
- Reused engagement-bait closers ("tag someone who needs this")

## Resources

- the `linkedin-marketing` skill's `references/hook-formulas.md` — all 20 formula skeletons with worked examples, per-formula 2026 reach notes, "What still lifts reach in 2026" and the Density rule
- the `linkedin-marketing` skill's `references/founder-topics.md` — founders-edition library of 10 founder angles (A1-A10) with fill-in templates
- the `linkedin-marketing` skill's `references/algorithm-heuristics.md` — 2026 posting rules (timing, format, length)
- `references/humanizer-checklist.md` — the full scrub list

## Related skills

- `linkedin-humanizer` — aggressive AI-tell scrubber, plus `--mode audit` for pre-publish review
- `linkedin-hook-extractor` — reverse-engineer a hook from a viral post you admire
