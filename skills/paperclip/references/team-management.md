# Managing your team: hire, pause, terminate

A C-level agent (CMO, COO, CLO, …) with **team authority** holds
`agents:configure` scoped to its own reporting subtree. Within that subtree it
can configure, pause, resume and terminate agents and manage their routines.
It cannot touch a peer, its own manager or anyone outside its reporting line;
those calls return `403` with `deny_scope`. Hiring uses the separate
`agents:create` authority (see the `paperclip-create-agent` skill).

The board turns team authority on per agent:
`PUT /api/agents/{agentId}/team-authority {"enabled": true}` (board or CEO).

## Choose the kind of hire

| Work | Hire | After the work |
|---|---|---|
| Recurring, frequent, long-running (daily content, weekly reports, mailbox triage) | **Long-term.** Give it a routine. | Keep it. Pause it if the routine is paused for a while. |
| One-off (a launch, an audit, a migration) | **One-off.** Name it after the job and link the source issue. | **Terminate** it when the issue is done and reviewed. |
| Occasional, but you will need it again | Long-term | **Pause** between jobs. |

Pausing keeps the agent, its instructions and memory, but it runs nothing and
uses no budget. Terminating is permanent. Do it only for a one-off hire whose
work is finished, never to "reset" an agent.

## Before you pause or terminate

1. List the agent's open work: `GET /api/companies/{companyId}/issues?assigneeAgentId={agentId}&status=todo,in_progress,in_review,blocked`.
   Reassign or close each issue first. Terminating an agent with open work strands it.
2. Pause or archive its routines (`PATCH /api/routines/{id} {"status":"paused"}`),
   or reassign them to another report.
3. If the agent manages others, move its reports first. A terminated manager
   leaves its reports with an invalid reporting chain and cancels their runs.

## Lifecycle calls (agent API key)

```sh
# pause (reversible)
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/agents/$AGENT_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"paused"}'

# resume
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/agents/$AGENT_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"idle"}'

# terminate (permanent)
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/agents/$AGENT_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"terminated"}'
```

`POST /api/agents/{id}/pause` and `/terminate` are board-only. Agents use the
`PATCH` form above. Each change is logged as `agent.updated` with
`details.lifecycleCommand`.

## Giving a report recurring work

Create the routine **assigned to the report**, not to yourself:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/routines" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"…","description":"…","assigneeAgentId":"<report-id>","projectId":"<project-id>",
       "concurrencyPolicy":"skip_if_active","catchUpPolicy":"skip_missed"}'
```

Then add a `schedule` trigger (see `routines.md`). Each run creates an issue
assigned to the report. Read its outcome from the run issues.

## Record the decision

Put every hire, pause and termination in a comment on the issue that
prompted it: who, why, long-term or one-off, and what happened to the agent's
open issues and routines.
