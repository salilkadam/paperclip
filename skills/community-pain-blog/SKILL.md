---
name: community-pain-blog
description: "Daily scan of Reddit, Hacker News, Stack Exchange (via Composio) and GitHub issues for infrastructure problems, scored against the product capability notes with a weighted rubric that also covers problems the product can only diagnose or could learn to fix; turns the best one into a single Ghost blog draft in the house style for the content calendar. Use for the daily community scan."
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
- Sources: subreddits, Stack Exchange sites/tags, Hacker News queries, GitHub issue
  search.
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

Composio's sandboxes (`COMPOSIO_REMOTE_BASH_TOOL`, `COMPOSIO_REMOTE_WORKBENCH`) are
blocked at the gateway, and so is any Reddit or Stack Exchange write: this skill
only reads. Fetch Hacker News from your own runtime with `curl` (below).

Use **only** these toolkits: `reddit` and `stack_exchange` (our own connected
accounts) and the public Hacker News API from your own runtime. Do **not** use
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
| Stack Exchange | `STACK_EXCHANGE_SEARCH_ADVANCED` | `site: "serverfault"` (or `stackoverflow`, `devops`, `kubernetes`), `tagged:` one of `kubernetes`, `cert-manager`, `external-secrets`, `argocd`, `gitops`, `coredns`, `ingress-nginx`, `prometheus-operator`, `persistent-volume`, `sort: "creation"`, `order: "desc"`, `fromdate: <unix, 30 days ago>`, `pagesize: 10` |
| GitHub issues | `curl` from your own runtime (below) | public search API, unauthenticated |

Keep Reddit queries simple: one `subreddit:` plus at most one keyword. Boolean
`OR` groups and parentheses returned nothing in testing. Tool names and argument
shapes are Composio's and may change: if a call fails, re-read the schema with
`COMPOSIO_GET_TOOL_SCHEMAS` before giving up.

Stack Exchange is one site × one tag per call, and **its date filters are silently
ignored**: filter the returned questions by their own creation date yourself, and
do not conclude a site is quiet because `fromdate` brought back nothing. In testing
(October/November 2026) the whole site × tag grid gave 2 fresh questions across 45
combinations: keep a couple of calls for it, do not spend the run there.

Hacker News (stories and Ask HN, last 7 days), with `curl` from your own runtime:

```sh
FROM=$(date -d '7 days ago' +%s)
for q in kubernetes outage postmortem postgres "crash loop" "pending pod" oomkilled \
         "external secrets" cert-manager "rollout stuck" "pv stuck" "admission webhook" gitops; do
  curl -sS -m 20 -G https://hn.algolia.com/api/v1/search \
    --data-urlencode "query=$q" --data-urlencode 'tags=(story,ask_hn)' \
    --data-urlencode "numericFilters=created_at_i>$FROM" --data-urlencode hitsPerPage=10
done
# a thread with its comments: https://hn.algolia.com/api/v1/items/<objectID>
```

HN works, but most of what the wider queries bring back is security news and
opinion, not operator pain: keep it for outages and postmortems, and expect to
discard most of it.

GitHub issues, from your own runtime — the public search API needs no key, and
rate-limits unauthenticated calls to about 10 requests a minute, so pace the loop:

```sh
for repo in argoproj/argo-cd fluxcd/flux2 kubernetes/kubernetes \
            kubernetes-sigs/external-dns prometheus/prometheus \
            prometheus/prometheus-operator longhorn/longhorn kyverno/kyverno \
            crossplane/crossplane; do
  curl -sS -m 20 -G https://api.github.com/search/issues \
    --data-urlencode "repo=$repo type:issue state:open created:>$(date -d '7 days ago' +%Y-%m-%d)" \
    --data-urlencode 'sort=created' --data-urlencode 'order=desc' --data-urlencode per_page=10
  sleep 7
done
```

GitHub issues are where the operator pain actually is: in testing this was the best
source by a wide margin (375 fresh issues, 127 candidates, against 2 questions from
the whole Stack Exchange grid). Read the issue body and the first comments before
scoring; a CI-bot or dependabot row is not a problem statement.

Two channels the owner asked for are **not reachable read-only** from this skill,
and are recorded here rather than searched:

- **Discord** — needs a Discord account in a server token, which Composio does not
  offer as a connected toolkit.
- **X / Twitter** — needs API credentials; Composio exposes it only through
  per-call-billed "instant account" toolkits, which this skill never uses (above).

Say so in the task when they would have mattered. Do not reach either through a
paid proxy, and do not report them as searched.

## 3. Pick one problem

Shortlist up to five posts that describe a **concrete operational problem**
(an error, an outage, a failure mode), not opinion, careers, tool lists or
news. For each, open the thread and note: the symptom in the poster's words, the
cause if found, the fix if found, the engagement (score, comments), and the link.
Posters on Reddit, HN and Stack Exchange are private people: paraphrase them,
never quote them at length, and never name them in the blog. Credit published
authors (an article, a postmortem, a repository) by name.

Then score each against the product notes. First place it in one **fit bucket**:

| Bucket | What it means | Decided by the notes |
|---|---|---|
| (a) | An existing fixer fixes it | a capability with status `shipped`, visibility `public`, that *fixes* this failure |
| (b) | The product diagnoses it, no auto-fix | a `shipped` + `public` capability that *detects or diagnoses* it, and names the resolution |
| (c) | Diagnosis needs a small extension of the same shape | adjacent to a `shipped` + `public` detection; the notes describe extending it |
| (d) | Learnable: outside today's fixes, but a researched fix could become one | no `shipped` capability covers it; the four learn gates below decide |
| (e) | Out of reach | nothing in the notes, or the fix needs a capability the notes mark `planned`, `partial` or `internal` |

**Release-state rule:** `shipped` means in a tagged release, per the notes. Code
that exists but is unreleased is not shipped and is not citable; if the notes are
unclear which, treat it as not shipped.

The four **learn gates** for bucket (d) — all four must hold to score 1.0, three for
0.6, and 0.3 when the failure is diagnosable but no remedy is established yet:

1. The failure is diagnosable from what the cluster already reports.
2. The fix is reversible and repeatable-safe, and never edits a Secret, ConfigMap
   or CRD.
3. The fix is a kind of action the product already takes.
4. The class of problem can be written down as a rule: where it shows up, what
   action, what message it matches.

**Gates that end the topic, whatever the score:**

- **G1 (claim gate):** the closing note must be writable using only `shipped` +
  `public` facts from the notes. If it cannot, skip the topic — see section 4.
- **G2:** a concrete operational failure, not opinion, careers, news or bot noise.

Score each surviving post (weights sum to 100; score exactly one fit row, the
highest bucket that holds):

| Dimension | Weight | Score |
|---|---|---|
| Existing-fix fit (a) | 30 | 1.0 exact fixer match; 0.6 same failure family, one stage; 0 otherwise |
| Diagnose-only fit (b) | 22 | 1.0 a shipped, public check names this failure **and its resolution**; 0.5 adjacent |
| Catalogue-extension fit (c) | 16 | 1.0 same shape as an existing check, small extension; 0.5 needs a new object type |
| Learn-path fit (d) | 16 | 1.0 all four gates; 0.6 three; 0.3 diagnosable, remedy not established |
| Community engagement | 10 | ≥50 → 1.0; 20–49 → 0.8; 10–19 → 0.6; 5–9 → 0.4; 2–4 → 0.2; <2 → 0 |
| Evidence quality | 12 | 1.0 cause **and** fix in the thread or its cited primary; 0.7 cause located, fix upstream; 0.4 symptom and repro only; 0.2 symptom only |
| Novelty vs ledger | 8 | 1.0 never covered; 0.5 same tool, genuinely new failure; 0 same failure |

Bucket (e) scores 0 on fit. Engagement cannot buy its way past a missing
capability: a bucket (e) post, a 0 fit, or a G1 failure is never a blog, however
loud the thread.

**Decision rule.** Highest total wins; break ties on fit, then engagement.
**≥ 55** → draft (still subject to G1, G2, novelty above 0, the queue limit, and at
most one draft per run). **35–54** → bank. **< 35** → drop. If nothing reaches 55,
write no blog: add the shortlist to the ledger as "banked" and finish the task with
the shortlist.

If 6 or more posts are already scheduled or ready drafts (the queue limit), bank
the topic in the ledger instead of drafting; the calendar is full.

**Learn-path topics (bucket c and d winners).** They produce two things, and the
conservative one is the public one.

- A blog **only if G1 passes**: the post teaches the failure, how to confirm it, and
  the **researched human fix, credited to its real author**. The closing note states
  only the shipped, public surface that *sees* this class of failure, and what the
  product does **not** do here. It must not say the product fixes, learns, proposes
  or will support this: no roadmap, no dates, no tier names, no internal paths. If
  that note cannot be written truthfully, G1 fails and there is no blog.
- Always, a **learn-pipeline candidate** line in the ledger and the task — never in
  Ghost. This is where "this could become a policy" belongs, off the public channel
  (format in section 5).

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

- Ledger line: `YYYY-MM-DD | drafted|banked | <title or topic> | <source URL> | <source type: reddit|hn|stackexchange|github|article> | <named author, only for a real article or postmortem, never an anonymous poster> | <ghost slug> | <bucket a-e> | <score>`.
  The **source-back-post** skill uses the source URL and type to find the thread
  once the blog is live, so those two fields keep their place and meaning; the
  bucket and score are appended.
- Learn-pipeline candidate (bucket c or d, whether or not a blog came of it): a
  separate line, `YYYY-MM-DD | learn-candidate | <class of problem> | <source URL> | <symptom> | <what the fix would be> | <which of the 4 learn gates pass> | <what is missing>`.
  These lines have no blog and no slug: **source-back-post must ignore them** (its
  source lane reads `drafted` lines only), and nothing from them goes to Ghost.
- In the task: the shortlist (one line each, with links and engagement), why the
  chosen one won, the matched capability (its `items.yaml` id), the sources you
  verified, and the draft's title and slug. Write for the board per
  **board-plain-language**: titles and links, plain words, no raw ids.
- If a source was unreachable or a toolkit not connected, say which and what you
  did instead. A scan that searched nothing is a failed scan, not an empty one.
