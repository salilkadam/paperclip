# Agent access follows job function

Date: 2026-11-02
Status: Owner's decision recorded. Not applied to production yet.

## Decision

- **C-level agents** delegate, review, strategize and answer to the board. They have full read access. They write only to Google Drive and to their own agent memory. Tactical work goes downstream.
- **Repo writes** are a technical job function. They go through the Sr. Engineer or the development team. This includes website changes.
- **Blogs, marketing material, decks and collateral** go to the Content Marketer or the agent the CMO designates.
- **Lower-level staff** have GitHub write and cluster access for code changes, and content access through their tools, as their function needs.

The reason: the Reliora CMO reported that it could not open website pull requests without GitHub access. That work is not the CMO's job function.

## Reliora website pages

The site is in `Reliora-Inc/reliora-website`. The CMO routes a page, the Content Marketer writes the copy, and engineering builds and deploys it. Pages must follow the existing site styles. Blog posts stay with the marketer, in Ghost.

`deploy/scripts/setup-reliora-website-routing.sh` writes this into the three agents' instructions. The site's build fails a page that brings its own look.

**Open gap:** engineering cannot deploy yet. Agents have no cluster access or image build, so a deploy needs the owner or the SRE harness. Engineering reports "merged, not deployed" until then.

## How it is enforced

`deploy/scripts/setup-agent-job-function-access.sh` applies this per company.

| Surface | Control | Why |
|---|---|---|
| MCP tools | `allow` (priority 10) for Drive write tools, then `block` (priority 11) for all non-read risk levels, over the C-level agents | Policies are evaluated in priority order. A new write tool is blocked by default. |
| `git` and `gh` | The connection's install targets | The credential broker checks trust and grants, not tool policies. A tool block does not stop a real token. |
| Instructions | A marker-delimited section in each C-level `AGENTS.md` | The agent should delegate, not report a missing permission. |

### GitHub needs two connections per company

A company-wide managed connection gives every standard-trust agent a token. So:

- The **managed** connection (`github.code`) is installed for engineering agents only.
- A separate **non-managed** connection is installed for everyone else and is blocked to read-only. `git` and `gh` fail on it with "The managed GitHub identity is incomplete", which is the wanted result for those agents.

An agent must not have both installed. The non-managed grant has no GitHub account ID, so the resolver reports "More than one managed GitHub identity".

State found on 2026-11-02:

| Company | Connection | Kind | Installed for | Needed |
|---|---|---|---|---|
| Reliora | `77af219a` | Non-managed | Whole company | Add a managed connection for engineering, then narrow this one |
| Bionic | `9372637a` | Managed | Whole company | Add a read-only connection, then narrow this one. Until then Bionic's C-level agents can use `git` and `gh` |

## Known limits

- **Agent memory** is not covered by these policies. The script does not restrict or test it.
- **Risk levels come from the catalog.** The catalog classifies an unrecognized verb as `read`. The script also blocks tools whose names look mutating, and the proof fails if one stays open. A mutating tool with an innocent name is still open, so `--dry-run` lists every read-classified tool for a person to check.
- **`git` and `gh` depend on the read connection's credential.** An active agent or user grant with both `oauth.access_token` and GitHub metadata can export a token. The script refuses to narrow while one exists, or while the key cannot see the grants. Whether `gh` really fails for a C-level agent is not proven by the script: it needs a real run.
- **New agents:** the installs are explicit agent lists, so a new agent has no GitHub access and C-level policies do not cover a new executive. Run the script again after each hire. An agent with no install can fall back to `GH_TOKEN` or `GITHUB_TOKEN` company secrets, so the script reports those secrets.
- **Approved requests in flight:** an ask-first request that was created before the script ran can still execute if it is approved. Accepted risk. Owner: Salil. Trigger: each apply. Decline open requests from C-level agents before you run the script, or wait for the 60-minute approval window to end.
- **Agent classification:** C-level means role `ceo`, `cto`, `cmo` or `cfo`, a title of `Chief ... Officer`, or a name like `COO`. Engineering means a role with `engineer` or `devops`, or `qa`. Check both lists in the `--dry-run` output before you apply.
- **Board reporting:** Slack for the CEO and CMO is a chat channel with no tools, so the block does not stop it. Paperclip issues, comments and confirmations are not tool connections either.
- **Routines assigned to C-level agents** can fail after the block. The script lists them but does not reassign them. On Reliora, the CEO board report and the COO pace report use Paperclip and Drive, so they should keep working. The COO mailbox triage uses the agent mail plugin (`mark_read`, `send`). The block has no connection selector, so it can reach write-risk plugin tools. Not tested, and the dry run does not list plugin tools.
- **Media and AI tools stay open:** image, 3D, PDF and audio generation, and AI completion, are classified read. They do not change a shared system, but they do cost money.
- **Bionic has no Google Workspace connection.** The script skips Bionic and exits 3 until it has one. Bionic's C-level agents keep their current access until then, including `git` and `gh`.
- **Gmail and Calendar writes** are blocked for C-level agents. "Write only to Google Drive" is read literally.

## Writes the board approves (owner, 2026-11-02)

Some older policies are evaluated before the job-function block and give C-level agents "ask first" instead of a block: connecting a Composio app, LinkedIn writes through Composio, and the Design Partner agreement pipeline (the COO). The owner keeps them: each needs the board's approval, and each approval reaches the owner in the company's board channel in Slack (board-channel cards; `#reliora-board` for Reliora). Destructive actions post a card with an "Open in Paperclip" link instead of buttons.

The script's proof therefore fails only on a write a C-level agent can make without the board (`decision == "allowed"`), not on "ask first".

## Not built: cluster access

Agents run as child processes inside the `bionic-org` container and share one identity. `bionic-org-sa` is not a per-agent identity, and `paperclip-agent-web-sa` does not automount a token. Per-agent cluster access needs its own design.

## Update (owner, 2026-11-04): Slack, routing and Connect Hub

- **C-level agents** read everything and write to Google Drive and **Slack** (their channels and the board channel). They assign work in their function to their own agents, and work in another function to the **peer C-level** who owns it, never to that C-level's agents. Example: a web page from the CMO or Content Marketer goes to the CIO, who assigns the Sr. Engineer.
- **Working agents** never post to Slack or the board. They report on the task they were given; the C-level they report to posts what is needed.
- `setup-agent-job-function-access.sh` writes both rules into the agents' `AGENTS.md`: the C-level section, and a new `reporting-line` section for every working agent. `setup-reliora-website-routing.sh` routes pages Content Marketer → CMO → CIO → Sr. Engineer.
- **Connect Hub** (router mode) runs each app action through one of three tools, each limited by the hub to one risk class: `hub_read` (read-only actions), `hub_execute` (writes; it refuses destructive ones) and `hub_execute_destructive` (deletes, archives, raw API calls and anything else the hub marks destructive). The hub takes the class from each piece's own READ/SEARCH/WRITE/DESTRUCTIVE label where there is one, and otherwise from the action name. `deploy/scripts/setup-connecthub-governance.sh` writes the company policies, matching the app on the `tool` argument:
  - C-level agents may write only to Drive and Slack.
  - Working agents may not post to Slack.
  - Nobody posts to Reddit or Stack Exchange, or posts to Slack as a person.
  - GitHub writes are for engineering only.
  - These need the board: anything destructive, connecting an app, social publishing (including Google Business Profile) and external email.
  - No policy touches `hub_read`, so everyone can read.
  - The server rejects `|` in policy patterns, so each app or verb is a separate policy. The script checks every pattern the same way before writing.
  - The script refuses a direct-mode hub server, and a hub too old to have `hub_execute_destructive`.
- **Fixed:** the job-function script now writes the `AGENTS.md` rules before the step that skips a company with no Workspace connection, so Bionic gets them too. Its check that C-level agents have no open writes no longer counts the hub's `hub_execute`, which the hub script governs and proves app by app.
- **Fixed:** both scripts located their marker section with jq `index`, which counts bytes, then cut with string slicing, which counts characters. Any `AGENTS.md` with multi-byte text (—, …, “”) was cut in the wrong place, which damaged the markers in Reliora's CMO file. The scripts now split on the markers, and stop on a damaged file instead of making it worse: a section that appears twice, or whose END comes before its BEGIN, counts as damaged.

Live state found on 2026-11-04 (read-only check):

| | Bionic | Reliora |
|---|---|---|
| C-level policies (Drive allow, write block) | **Not applied** | Applied, all 5 C-level agents |
| GitHub | One connection, **installed company-wide** (C-level can use `git`/`gh`) | Split: write for Sr. Engineer, QA, Kubernetes Engineer; read-only for the rest |
| Google Workspace connection | **None** | Loc-Google Workspace, company-wide |
| Connect Hub | Company-wide, **no policies** | Company-wide, **no policies** |
| Slack | CEO and CMO bots (chat channels) | CEO and CMO bots (chat channels) |
| Trust rules | None | None |
| `AGENTS.md` delegation sections | None | Present; CMO file has **damaged markers** (repair by hand) |
