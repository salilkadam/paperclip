# Bionic AI Solutions: content routines at parity with Reliora (running list)

Owner's request (2026-10-29): Bionic AI Solutions gets the same content routines
as Reliora Inc, as a different company. **Blocked on one decision: what Bionic's
blog covers.** Update this list as items are decided or done.

## 1. Decisions needed from the owner (blocking)

- [ ] **What the blog is about**: Bionic's products/services and the problems
      its readers have (the equivalent of "Kubernetes reliability" for Reliora).
- [ ] **Audience**: who reads it (role, company size).
- [ ] **Communities to watch**: subreddits, Stack Exchange sites and tags,
      Hacker News queries (Reliora: r/kubernetes, r/sre, r/devops; serverfault,
      stackoverflow, devops tag `kubernetes`; HN `kubernetes`, `outage`, ...).
- [ ] **Product sources** for the weekly capability notes: which GitHub
      repositories (and which are source-available vs proprietary), or other
      sources if Bionic's products are not in GitHub.
- [ ] **Public blog URL**: the board decided Bionic's public blog is
      `https://blog-bionic.baisoln.com/<slug>` (27 Oct 2026, board-approval-notify);
      confirm it renders published posts publicly, or name the site that will.
- [ ] **Style reference posts** (2 published posts the agent copies the house
      style from), once some exist.
- [ ] **Disclosure line** for replies: "Full disclosure: I run Bionic AI
      Solutions (<what it does>)".

## 2. Already in place for Bionic

- Composio connection `65504839` (Salil's; Reddit, Stack Exchange, Discord,
  Zoom, Todoist connected). Bionic's Content Marketer (`9d85b7f3`) bound to it
  2026-10-29; read searches on Reddit and Stack Exchange verified.
- Reddit / Hacker News / Stack Exchange writes refused in code for every Composio
  connection (`server/src/services/connectors/composio-guard.ts`), plus the
  policies from `deploy/scripts/setup-composio-governance.sh` (applied to Bionic).
- Replies are posted by Salil from his own accounts for both companies; the
  `source-back-post` skill already handles a Bionic disclosure and counts his
  replies across both companies.
- `board-plain-language` carried by every Bionic agent with skill support.
- Ghost connection and governance for Bionic (`setup-ghost-connections.sh`,
  `setup-ghost-governance.sh`); board channel `#bionic-board`.
- `setup-cmo-blog-amplifier.sh` already runs the "Daily blog -> LinkedIn" routine
  for Bionic, but with **no public blog URL** (it stops before drafting).

## 3. Work to do once section 1 is decided (parity with Reliora)

| Reliora routine (script) | For Bionic |
|---|---|
| "Reliora product research", Mon 05:00 PT, `product-capability-notes` (`setup-reliora-content-research.sh`) | Same, with Bionic's sources; a GitHub connection in Bionic with read access to its repos, and its write tools turned off for the marketer (the script enforces this for Reliora). Seed notes optional. |
| "Reliora community scan", daily 06:00 PT, `community-pain-blog` | Same, with Bionic's communities and queue limit; ledger in the Bionic marketer's `$AGENT_HOME`. |
| "Reliora source back-post", daily 09:30 PT, `source-back-post` | Same; Bionic disclosure; limits shared with Reliora because the same person posts. |
| "Reliora content calendar" + repost lane (`setup-reliora-content-calendar.sh`): Ghost "post created" webhook, scheduling, TryPost LinkedIn with board approval | Same for Bionic: Ghost webhook on Bionic's Ghost tenant, Bionic TryPost workspace/connection (split since 2026-10-28), `#bionic-board` notes. Decide whether it replaces the amplifier's "Daily blog -> LinkedIn" for Bionic (as Reliora's did: amplifier row `off`). |
| `blog-visuals` (heroes, white diagrams, LinkedIn thumbnail) | Add to the Bionic marketer's skills. |

Engineering notes:
- `setup-reliora-content-research.sh` and `setup-reliora-content-calendar.sh` are
  Reliora-specific (`COMPANY="Reliora Inc"`, routine titles, `reliora` Ghost
  tenant, reliora.ai URLs, a Reliora instance path in the back-post description).
  Make them take a company profile (like the `SITES` table in
  `setup-cmo-blog-amplifier.sh`) rather than copy them.
- Product facts skill: Reliora uses `srenix-facts`; Bionic has `bionic-facts`.
- Run `setup-composio-governance.sh` after any new Composio connection.
- Before go-live: different-model review of the plan (story level), dry runs,
  then a first manual run of each routine with the owner watching.
