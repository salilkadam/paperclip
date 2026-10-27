# LinkedIn Detector Tester

Collects scores for any text from 5+ AI detectors and reports how badly they disagree. The point is not to find the "right" score. The point is to show there is no right score.

## Before you run it: the draft leaves the company

This is the one step in the bundle that sends text to someone else. Every detector here
is a hosted service, so testing a draft discloses it, in full, to whichever services the
human pastes it into: GPTZero, Originality.ai, ZeroGPT, Sapling, Copyleaks, Hive,
QuillBot, Writer and Scribbr. Nothing else in this bundle does that. Drafting, scrubbing,
auditing and profile-building happen inside the run, and publishing goes only to TryPost.

In Paperclip this is a **manual paste step**: the agent has no detector connection and
never sends the text to a detector itself. A human pastes the draft into each detector's
web page and pastes the scores back into the task; the agent computes the spread and the
verdict.

What that means in practice:

- **An unpublished post is not private once you test it.** Treat the text as disclosed to
  every provider it was pasted into, under their terms and retention policy, not ours.
- **Do not run it on anything confidential**: unannounced launches, client names, numbers
  under embargo, anything covered by an NDA.
- **Only the detectors a human chose are used.** No paste, no request to that service.
- It is worth asking whether you need it. The verdict this sub-skill exists to deliver is
  that the scores disagree and none of them mean much, which is a point you can take on
  trust rather than paying for with your draft.

## Why this exists

AI detectors get treated like medical tests. They are not. They are vibe checks with a percentage sign.

The receipts:

- **Stanford 2023** (Liang et al., Patterns / Cell Press): 7 AI detectors flagged **61.3% of TOEFL essays from non-native English speakers** as AI-generated. Same detectors flagged 5.1% of US-born 8th graders. The bias is against ESL writers, not against AI.
- **OpenAI shut down its own AI Text Classifier in July 2023** because it hit only **26% accuracy** on AI-written text. The company that builds the AI could not reliably detect the AI.
- **Vanderbilt University disabled Turnitin's AI detection** citing false-positive risk to students. Other R1 schools followed.
- **Newby v. Adelphi University (October 2025)**: a federal court ordered the university to expunge an AI-cheating violation from a student's record after the only "evidence" was a detector score.
- **Sergey's team test**: same article, three detectors, scores **82% / 100% / 50%**. That is a 50-point spread on identical text.

If accusations are coming, this skill produces the screenshot.

## When to use

- Someone accuses a post, essay, or proposal of being AI-written based on a single detector score
- Before defending a writer publicly, get the spread on record
- As a follow-up to Sergey's controversial detector post — paste any flagged text, run it, screenshot the divergence
- Internal QA on drafts before publishing to high-stakes audiences

## Input

Any text. 200+ words gives the most stable spread; under 100 words and detectors get even more random.

Optional: a label (e.g. "ESL student essay", "GPT-4 output", "1995 Carl Sagan column") for the output header.

## Output

```
Text: "<first 60 chars>..."
Length: 412 words

Detector scores (% AI probability):
  GPTZero         82
  Originality.ai  100
  ZeroGPT         50
  Sapling         34
  Copyleaks       91

Min: 34   Max: 100   Spread: 66

Verdict: USELESS — detectors disagree by more than 50 points.
Translation: nobody actually knows. The accusation is a coin flip.
```

## The three verdicts

| Spread (max - min) | Verdict | What it means |
|---|---|---|
| ≤ 15 points | **CONSENSUS** | Detectors agree. Still not proof, but at least they're not contradicting each other. |
| 16-30 points | **MIXED** | Some signal, but enough disagreement that no single score is defensible. |
| 31-50 points | **DIVERGENT** | The detectors are flipping a coin. |
| > 50 points | **USELESS** | The spread is bigger than half the scale. Whatever you decide, the opposite detector also "proves" it. |

## How to run

1. Put the draft in the task with the list of detector web pages from
   `../references/detector-list.md` (GPTZero, Originality.ai, ZeroGPT, Sapling,
   Copyleaks, plus any optional ones) and the disclosure above.
2. Ask a human to paste the draft into each one and report the "% AI" score per
   detector back in the task. Detectors with no score reported are dropped from the
   report.
3. Compute min, max and spread, and give the verdict from the table above, in the
   output format above.

The upstream bundle also had an API mode (detector keys in a local file and a script
calling each API in parallel) and an offline demo mode. Neither is shipped here: there
are no detector keys in Paperclip and no scripts in this skill.

## Files

- `../references/detector-list.md` — supported detectors, web pages, known accuracy issues, citations

## Related skills

- `linkedin-humanizer` — rewrites text after a high score (or before, defensively)
- `post-audit.md` (sibling) — pre-publish check that catches AI tells without relying on detectors

## What this skill is not

It is not a detector. It does not claim a piece of text is or is not AI-written. It only documents how much the existing detectors disagree, so that a single score can never again be used as a trump card.
