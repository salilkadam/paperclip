---
name: product-capability-notes
description: "Weekly product research: read the product's GitHub repositories (read-only) and keep capability notes in memory — what it solves, how well proven, what it does not do, and what may be said in public. Use for the weekly product research or to refresh the notes."
---

# Product capability notes

The notes answer one question for the content team: **which real problems does
the product solve, how, how well proven, and what may we say in public?**
Every claim in a blog comes from these notes, so they follow the **code**, not
the marketing copy or the roadmap.

## Inputs (from the routine description)

- The product name (e.g. `srenix`) and its repositories, each marked
  `source-available` (public facts) or `proprietary` (internal only).
- The notes folder: `$AGENT_HOME/life/resources/<product>/` (`summary.md`,
  `items.yaml`), following the **para-memory-files** skill.

## Reach the tools

GitHub tools come from the company's **GitHub** connection on the Paperclip tool
gateway (see the `trypost` skill, "Reaching the tools"). Use **read** tools only:
`get_file_contents`, `list_commits`, `get_commit`, `search_code`, `list_releases`,
`get_latest_release`, `list_tags`. Never create, push, comment, merge or trigger
anything in these repositories.

`get_file_contents` with a directory `path` lists it; with a file `path` it returns
the content. Pass `owner`, `repo`, `path`, and `ref` = the commit you are reading.

## Weekly run

1. **Where you left off.** Read `summary.md`; its first lines record the commit
   of each repository you last read. If the notes do not exist yet, the routine
   names a seed task: copy its `summary` and `items` documents into the notes
   folder as is, then continue from step 2 with the seed's commits as "last read".
2. **What changed.** `list_commits` on each repository's default branch since
   the last-read commit. Also `get_latest_release` / `list_tags`. Note the new
   head commit; read everything below at that commit.
3. **Read the changes that matter.** Skip tests-only and CI-only commits. For the
   rest, `get_commit` shows the files; read the ones that change what the
   product does: README, STATUS, ROADMAP, CHANGELOG, `docs/`, the catalogue of
   checks and fixes, the Helm values (what is on by default), and the source of
   any new or changed check, fixer or integration.
4. **Update the facts** in `items.yaml`. One fact per entry:

   ```yaml
   - id: cap-027
     fact: "One sentence, checkable."
     category: capability   # capability | limit | safety | integration | positioning
     status: shipped        # shipped | partial | planned
     visibility: public     # public | internal
     source: "repo/path/file.go"
     as_of: 2026-11-02
   ```

   Never delete a fact: mark it `status: superseded` with `superseded_by: <id>`.
5. **Rewrite `summary.md`** from the active facts (write `items.yaml` first, then
   `summary.md` last, each to a temporary name renamed into place, so the daily
   scan never reads half a rewrite), in this order:
   the `Last researched:` line with the date and each repository's commit;
   a plain-English description; the "Problems it solves" table (the problem as a
   practitioner would post it | what the product does | status | visibility |
   evidence); search keywords (exact error strings and phrases people use, for
   the daily scan); what it does **not** do; the safety model; how well proven.
6. **Report in the task**: what changed this week in plain words (new
   capabilities, things that moved from planned to shipped, new limits), the
   commits read, and anything you could not classify. No raw ids; repository
   names and file paths are fine.

## Rules that keep the notes honest

- **Shipped** means in the code, wired, and reachable in a release. Something on
  the default branch but not yet in a tagged release is `partial`. Something in a
  roadmap, PRD or plan only is `planned`. Off by default is still `shipped`,
  but say "off by default" in the fact.
- **Public** facts are those anyone can check in a source-available repository.
  Everything that comes only from a proprietary repository is `internal`, and so
  are pricing, Enterprise internals, customer names, unreleased dates,
  competitive analysis, security weaknesses and incident detail, wherever they
  appear. When unsure, `internal`. Blogs use public facts only.
- Where the docs and the code disagree, follow the code, and record the conflict
  in the fact.
- Record what the product does **not** do as carefully as what it does: these
  limits are what stop a blog from overclaiming.
- Quote modelled figures (for example "hours saved" dashboards) only as modelled.
