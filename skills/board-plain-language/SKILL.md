---
name: board-plain-language
description: "How to write anything the board reads and answers: approval cards, request_confirmation cards, board notes in Slack, and the comment when a task waits in_review. Plain words, the decision first, what yes and no each do. Use every time you ask the board for something or report to it."
---

# Writing for the board

The board are busy people, not engineers on this task. They decide from what you
write, often on a phone. If they cannot tell in ten seconds what you ask and what
happens next, they cannot answer, or they answer wrongly.

This applies to every approval card, `request_confirmation`, board note in Slack
(**board-approval-notify**), the comment you write when a task waits `in_review`,
and any report to the board. It does not change the content itself (a blog for
engineers stays technical); it changes how you **describe** that content to the
board.

## The shape (in this order)

1. **The ask, in one sentence.** Start with what you want them to decide.
   "Approve this LinkedIn post for Tue 3 Nov, 9:00 PT?" Not background first.
2. **What it is.** Two or three short sentences: what will go out, where, to
   whom, when. Quote the first line of a post or the subject of an email.
3. **What yes does, what no does.** "Yes: it posts on Tuesday. No: nothing goes
   out; I will rework it if you say why."
4. **My recommendation, and why** in one sentence, when you have one.
5. **Anything they must know** (a risk, a cost, something unusual). Only if real.
6. **The link** to the public page or the Paperclip task.
7. Optional last line: `For the record:` and any ids.

## Words

- Short sentences, everyday words. One idea per sentence. Write it the way you
  would say it to a smart person outside the team (**simplified-english** has the
  word list).
- Name things the way the board knows them: "the Reliora LinkedIn page", "the
  Reliora blog", "the design-partner email". Never tool names, slugs, internal
  hosts, JSON, run ids, action-request ids or error codes in the main text.
- Explain any unavoidable technical term in five words or fewer the first time.
- Dates with the day name and timezone: "Tue 3 Nov, 9:00 PT".
- Numbers you counted, not estimates dressed as facts. Say "I could not check X"
  when that is true.
- No hype, no filler ("I hope this helps", "As an AI"), no walls of bullets.
  Under about 120 words for a card or note; put detail in the task, not the card.

## Summary first, conditions always

- The card is a summary; a task document is the record. Put rule packs,
  research and drafts in a task document and name it in the card.
- Every condition, limit or risk the board accepts by saying yes goes in the
  card itself. When space is short, cut the explanation, never a condition.
- Chat shows at most about 3,000 characters of a card and then shortens it
  with a link to the task. Aim well under that (about 1,200).
- While a card waits for an answer, keep the task `in_review`. Closing it
  expires the card and the board never sees the question.

## Check before you send

- Can someone answer it with yes or no without opening anything else?
- Is the first sentence the question?
- Did you say what happens on yes **and** on no?
- Is every condition in the card, not only in a document?
- Is every id, tool name and internal URL either gone or on the last line?

If any answer is no, rewrite it before you send.

## Example

Not this:

> Requesting approval for action-request 9b80c956: mcp.trypost:update-post-tool
> with media replacement on post 01a18031-c8ef (Ghost slug full-database-volume…).

This:

> Approve a new picture for the LinkedIn post about full database volumes?
> The post goes out Mon 9 Nov, 9:00 PT on the Reliora LinkedIn page; only its
> picture changes, to the new white illustration. Yes: the new picture is used.
> No: the old picture stays. I recommend yes; the old one looked like the other
> posts. Preview: https://reliora.ai/blog/full-database-volume-operator-blocks-expansion
> For the record: action request 9b80c956
