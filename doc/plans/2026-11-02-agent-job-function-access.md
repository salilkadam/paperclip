# Agent access follows job function

Date: 2026-11-02
Status: Owner's decision recorded. Not applied to production yet.

## Decision

- **C-level agents** delegate, review, strategize and answer to the board. They have full read access. They write only to Google Drive and to their own agent memory. Tactical work goes downstream.
- **Repo writes** are a technical job function. They go through the Sr. Engineer or the development team. This includes website changes.
- **Blogs, marketing material, decks and collateral** go to the Content Marketer or the agent the CMO designates.
- **Lower-level staff** have GitHub write and cluster access for code changes, and content access through their tools, as their function needs.

The reason: the Reliora CMO reported that it could not open website pull requests without GitHub access. That work is not the CMO's job function.

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
- **Risk levels come from the catalog.** A mutating tool that is classified `read` is not blocked. The script reports the names that look mutating and exits 3.
- **Board reporting:** if C-level agents post to Slack through a tool connection, the block stops it until `BOARD_REPORT_TOOLS` names those tools. Use the dry-run output to find them.
- **Routines assigned to C-level agents** can fail after the block. The script lists them but does not reassign them.
- **Gmail and Calendar writes** are blocked for C-level agents. "Write only to Google Drive" is read literally.

## Not built: cluster access

Agents run as child processes inside the `bionic-org` container and share one identity. `bionic-org-sa` is not a per-agent identity, and `paperclip-agent-web-sa` does not automount a token. Per-agent cluster access needs its own design.
