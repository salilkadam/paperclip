---
name: community-pain-blog
description: "Daily scan of Reddit, Hacker News and Stack Exchange (via Composio) for infrastructure problems, matched against the product capability notes; turns the best match into one Ghost blog draft in the house style for the content calendar. Use for the daily community scan."
---

# Community problems → blog draft

One run = one scan, and **at most one** new blog draft. Nothing goes public from
this skill: you only create a Ghost **draft**. The company's content-calendar
routine picks the draft up (Ghost's "post created" webhook wakes it), brings it to
the house style, schedules it and asks the board.

## Inputs (from the routine description)

- Ghost `tenant_id` (e.g. `reliora`) and the public blog base URL.
- The product notes: `$AGENT_HOME/life/resources/<product>/summary.md` and
  `items.yaml`, written weekly by the **product-capability-notes** skill.
- Sources: subreddits, Stack Exchange sites/tags, Hacker News queries.
- The queue limit (default 6). Count Ghost posts with status `scheduled`, plus
  drafts the calendar would schedule: drafts tagged `#calendar` (already
  requested) and drafts that are ready (a body, no TODO/WIP/TEST in the title,
  not marked do-not-publish). Do not draft at or above the limit.

## 0. Before you search

1. Read the product notes. If `summary.md` is missing or its `Last researched:`
   date is older than 14 days, say so in the task, and write no blog: claims
   would rest on stale notes. If `items.yaml` is newer than `summary.md`, the
   weekly research is mid-write: wait for the next run.
2. Read your topic ledger, `$AGENT_HOME/life/resources/blog-topics/ledger.md`
   (create it if missing). Every topic you have drafted or banked is there.
3. List Ghost posts (`gh_list_posts`, status `published`, `scheduled` and `draft`,
   all pages) and note their titles and slugs. A topic already covered is not
   repeated, even with a new angle, unless the routine says otherwise.

## 1. Reach the tools

Composio and Ghost tools come through the Paperclip tool gateway (see the
`trypost` skill, "Reaching the tools"). Composio exposes meta-tools only:

- `COMPOSIO_SEARCH_TOOLS` — once per run, with a fresh session
  (`"session": {"generate_id": true}`); reuse the returned `session_id` in every
  later Composio call. It also reports which toolkits are connected.
- `COMPOSIO_MULTI_EXECUTE_TOOL` — runs the search tools below.
- `COMPOSIO_REMOTE_BASH_TOOL` — runs `curl` in Composio's sandbox (Hacker News).

Use **only** these toolkits: `reddit` and `stack_exchange` (our own connected
accounts) and the public Hacker News API through the sandbox. Do **not** use
toolkits Composio offers through an "instant account" (`scrapecreators`,
`serpapi`, `tik_hub`, `just_one_api` and similar): each call is billed. Never call
`COMPOSIO_MANAGE_CONNECTIONS`; if a toolkit you need is not connected, say so in
the task and continue with the others.

### Response size (observed October 2026; Composio does not document it)

A `COMPOSIO_MULTI_EXECUTE_TOOL` call with several tools, or many results, returns
only `data_preview` (about two items per tool, then `"...N more items"`) and saves
the full response remotely. So:

- **One tool per call**, `limit`/`pagesize` 10 or less. Read `response.data` and
  fall back to `response.data_preview`.
- Never treat a preview as the whole result set.

## 2. Search (last 7 days)

| Source | Tool | Arguments |
|---|---|---|
| Reddit, per subreddit | `REDDIT_SEARCH_ACROSS_SUBREDDITS` | `search_query: "subreddit:kubernetes"`, `sort: "top"`, `time_filter: "week"`, `limit: 10` |
| Reddit, per keyword | `REDDIT_SEARCH_ACROSS_SUBREDDITS` | `search_query: "subreddit:sre incident"`, `sort: "new"`, `time_filter: "week"`, `limit: 10` |
| A Reddit thread | `REDDIT_RETRIEVE_POST_COMMENTS` | `article: <post id>`, `limit: 20` |
| Stack Exchange | `STACK_EXCHANGE_SEARCH_ADVANCED` | `site: "serverfault"` (or `stackoverflow`, `devops`), `tagged: "kubernetes"`, `sort: "creation"`, `order: "desc"`, `fromdate: <unix, 30 days ago>`, `pagesize: 10` |

Keep Reddit queries simple: one `subreddit:` plus at most one keyword. Boolean
`OR` groups and parentheses returned nothing in testing. Tool names and argument
shapes are Composio's and may change: if a call fails, re-read the schema with
`COMPOSIO_GET_TOOL_SCHEMAS` before giving up.

Hacker News (stories and Ask HN, last 7 days), through `COMPOSIO_REMOTE_BASH_TOOL`:

```sh
FROM=$(date -d '7 days ago' +%s)
for q in kubernetes outage postmortem postgres; do
  curl -sS -m 20 -G https://hn.algolia.com/api/v1/search \
    --data-urlencode "query=$q" --data-urlencode 'tags=(story,ask_hn)' \
    --data-urlencode "numericFilters=created_at_i>$FROM" --data-urlencode hitsPerPage=10
done
# a thread with its comments: https://hn.algolia.com/api/v1/items/<objectID>
```

Stack Overflow's Kubernetes traffic is now small (a handful of questions a
month). Reddit (`kubernetes`, `sre`, `devops`) and Hacker News carry most of the
signal; HN is where outages and postmortems surface.

## 3. Pick one problem

Shortlist up to five posts that describe a **concrete operational problem**
(an error, an outage, a failure mode), not opinion, careers, tool lists or
news. For each, open the thread and note: the symptom in the poster's words, the
cause if found, the fix if found, the engagement (score, comments), and the link.
Posters on Reddit, HN and Stack Exchange are private people: paraphrase them,
never quote them at length, and never name them in the blog. Credit published
authors (an article, a postmortem, a repository) by name.

Then match each against the product notes:

- **Strong match**: a capability with status `shipped` and visibility `public`
  addresses the problem (detects, diagnoses or fixes it).
- **Partial**: the problem is adjacent; the product helps with one stage only.
- **None**: skip it.

Choose the strong match with the most engagement that no existing post covers.
If there is none, write no blog: add the shortlist to the ledger as "banked" and
finish the task with the shortlist.

If 6 or more posts are already scheduled or ready drafts (the queue limit), bank
the topic in the ledger instead of drafting; the calendar is full.

## 4. Write the draft

Research the problem beyond the thread: the primary source (the article, issue
or documentation the thread cites), and the official documentation for every
command, setting and version you mention. Every technical claim must be
checkable. Credit the author of the primary source by name with a link at the
end.

Read two published posts as the style reference (`gh_get_post`): the routine
names them. Then write in that house style:

- 1 or 2 short opening paragraphs: the symptom as the reader meets it, and what
  the post gives them. No `<h1>`.
- At least 3 `<h2>` sections: how it fails, how to confirm it, what to change,
  and (optional) why it hides.
- Stages or causes as `<ol class="steps">` cards
  (`<li><span class="sn">01</span><div><h3>…</h3><p>…</p></div></li>`);
  checklists as `<ul class="ticks">`; commands in
  `<div class="post-code"><div class="cl">label</div><pre><code>…</code></pre></div>`.
  Wrap each such block in `<!--kg-card-begin: html-->` … `<!--kg-card-end: html-->`.
- The product appears **once**, at the end, as the post's only
  `<p class="note-i">` (the content calendar keeps it as is): what it does
  for this problem, in plain words, using only `shipped` + `public` facts from the
  notes, and what it does **not** do. Never claim a `planned`, `partial` or
  `internal` capability.
- Before writing that paragraph, trace **this** failure through the check: what
  does the cluster report while it happens, and does the product's condition
  actually become true? A check that watches the right object can still see
  nothing (for example, a standby that stops streaming while its pod stays
  Ready). If it would not fire, say so, and say what makes it visible.
- When a fix has a trade-off or only works combined with another setting, say
  so in the same bullet. A reader who applies one item of a list alone must not
  end up worse off.
- No customer names, numbers or quotes you cannot source. No pricing, Enterprise
  internals, roadmap dates or competitor comparisons. No link to any internal
  address (`*.baisoln.com`, cluster hosts). Link text in words, never a raw URL.
- 600–1000 words.

Create it with `gh_create_post`: `tenant_id`, `title`, `html`, `status: "draft"`,
a custom excerpt of 1–2 sentences (300 characters at most), and 2–3 existing
public tags (`gh_list_tags`; never create a tag, never `linkedin`). Never call
`gh_publish_post`, and never schedule: the content calendar does that, with the
board's approval.

Then give the new draft its visuals with the **blog-visuals** skill, sections 1
and 2: a hero image always, and a workflow diagram when the post describes a
process (the "how it fails" steps usually are one). A draft without a hero is
not finished.

## 5. Record

- Ledger line: `YYYY-MM-DD | drafted|banked | <title or topic> | <source links> | <ghost slug>`.
- In the task: the shortlist (one line each, with links and engagement), why the
  chosen one won, the matched capability (its `items.yaml` id), the sources you
  verified, and the draft's title and slug. Write for the board: titles and
  links, no raw ids.
- If a source was unreachable or a toolkit not connected, say which and what you
  did instead. A scan that searched nothing is a failed scan, not an empty one.
