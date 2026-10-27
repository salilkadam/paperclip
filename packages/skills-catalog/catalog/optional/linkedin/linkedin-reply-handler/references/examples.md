# Examples — LinkedIn Reply Handler

## Example — single comment

> User: "Reply to this: https://www.linkedin.com/feed/update/urn:li:activity:7449018753880834048?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7449018753880834048%2C7449758545140453376%29"
>
> Skill: parses → post 7449018753880834048, comment 7449758545140453376. Fetches thread. Sees: post-author's post → Serge's comment ("moat moved to taste") → author's reply ("How are you building that conviction muscle with your team?"). Drafts R1 Answer-Their-Question variant. Puts it in the task for review.
>
> Board: approves the draft.
>
> Skill: hands over a copy-paste block: react APPRECIATION on the author's reply → pause 12s → post the reply under Serge's original comment (parentComment = the TOP level, not the author's reply).

## Example — whole thread

> User: "Reply to everyone on this post: https://www.linkedin.com/posts/<author>_activity-<id>"
>
> Skill: resolves the post URN, fetches 23 comments (7 top-level, 16 replies). Filters out 6 ("Great post!" x4, 1 duplicate, 1 spam link). Drafts 17 replies, each tagged with author, quoted comment, reply, reaction, and parentComment URN. Puts one batch review block in the task.
>
> Board: "approve all except the one to Priya, I'll handle that myself"
>
> Skill: hands over the 16 approved replies as copy-paste blocks in posting order (react then reply, per comment), skips Priya's.
