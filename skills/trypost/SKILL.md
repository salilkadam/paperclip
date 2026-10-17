---
name: trypost
description: Manage a TryPost social-media workspace through its MCP server — create, schedule, publish, preview, and analyze posts; manage labels, signatures, queue, media, and workspace settings. Use when the user asks to post, schedule, queue, repurpose, or inspect social content in TryPost.
---

# TryPost MCP skill

## Reaching the tools from inside Paperclip (read first)

Your run's MCP surface advertises only `connections_search` and
`connection_request`. TryPost tools are **never** listed there. That is the
designed shape, not a failure — do not conclude the connection is broken, and do
not ask the user to re-authorize just because the tools are absent from your
tool list.

Run `connections_search` to confirm the TryPost connection is `ready`, then
reach the tools through the Paperclip **tool gateway**, which injects the
workspace credential server-side. There are two supported paths:

1. If your tool list contains `paperclip_search_assigned_tools` and
   `paperclip_call_assigned_tool`, use them: search for the tool, then call it
   with the exact returned name and arguments.
2. Otherwise open a gateway session for the current run and call over HTTP:

```sh
API="${PAPERCLIP_API_URL%/}"; API="${API%/api}"
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -H "Content-Type: application/json" \
  -d '{}' "$API/api/tool-gateway/sessions"
# -> { "sessionId": "...", "token": "...", "expiresAt": "...", "toolsUrl", "callUrl" }

# The session token goes in X-Paperclip-Tool-Gateway-Token, NOT in
# Authorization. Bearer<sessionToken> is rejected as an agent token (401
# "Agent token did not verify"). See server/src/routes/tool-gateway.ts:
# gatewayToken() only reads x-paperclip-tool-gateway-token.
curl -s -H "X-Paperclip-Tool-Gateway-Token: <sessionToken>" \
  "$API/api/tool-gateway/tools"
curl -s -X POST -H "X-Paperclip-Tool-Gateway-Token: <sessionToken>" \
  -H "Content-Type: application/json" \
  -d '{"tool":"get-workspace-tool","parameters":{}}' "$API/api/tool-gateway/tools/call"

curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -H "Content-Type: application/json" \
  -d '{}' "$API/api/tool-gateway/sessions/<sessionId>/revoke"
```

- Revoke the session when you finish; never paste a session token into an issue
  comment or log.
- Calls are audited as `tool_call_events` rows named
  `mcp.app-gallery-link-<app>-<connection>:<tool>`.
- Do **not** call the provider MCP endpoint named in the connection config
  directly. With run credentials it returns `401 Unauthenticated`, and OAuth
  dynamic client registration from an agent container is blocked. Browser OAuth
  is only for the human connecting the app, and an active connection already
  carries the grant.
- Gateway `502` on a write tool almost always means TryPost rejected the
  arguments (see the content-type quirk below), not an auth problem. Re-read
  `list-content-types-tool` and retry; do not escalate to the user as "blocked".
- The gateway replays identical (tool, arguments) calls per issue
  (args-hash dedupe). A retried write whose arguments are byte-identical can
  return the cached (failed) result, and a provider 502 still burns the
  upload token/idempotency key. When retrying a failed write, change the
  arguments (e.g. re-upload media), do not resend byte-for-byte.

## Known provider quirk: media attach

`request-media-upload-tool` returns both an `upload_token` and a `media_id`
plus a direct upload URL. Attaching via `media: [{ upload_token }]` on
`create-post-tool`/`update-post-tool` (and the `attach-media-from-*` tools)
fails with a provider 502 in some deployments. Attach with
`media: [{ id: <media_id> }]` instead — verified working end-to-end on
LinkedIn image posts and YouTube Shorts.

## Known provider quirk: LinkedIn pages

A `linkedin-page` account needs `content_type: linkedin_page_post`. Forcing
`linkedin_post` on a page account fails with gateway `502`. When unsure, omit
`content_type` and let TryPost pick the page type, then confirm with
`get-post-tool`.

## Core rules

1. Never invent IDs. Discover `social_account_id`, `content_type`, Pinterest
   `board_id`, Discord `channel_id`, post IDs, label IDs, and signature IDs
   using the relevant list/get tools.
2. Always call `get-workspace-tool` first to check:
   - `me.requires_approval`
   - `me.publishes_directly`
   - `me.is_admin`
3. Call `list-social-accounts-tool` before posting to obtain the account ID,
   platform, timezone, content limits, and whether it has a posting schedule.
4. Call `list-content-types-tool` before choosing a content type or attaching
   media. It defines media rules, hashtag limits, and required `meta`.
5. Treat all user-relative times ("tomorrow at 9am") as local time, then convert
   them to an explicit ISO 8601 UTC time or a time with an offset for
   `scheduled_at`.
6. `create-post-tool` creates one post for one channel. For multiple channels,
   use `create-posts-tool`, which creates independent posts sharing a
   `post_group_id`.
7. Prefer creating a `draft` first, then use `preview-post-tool`, and ask for
   explicit confirmation before `publish-post-tool`, deletion, approval,
   rejection, or other destructive actions.
8. Do not pass an empty `media[]` on create or update; omit `media` entirely
   when there is no media change.
9. Media items must contain exactly one of `url`, `upload_token`, or `id`. Use
   `request-media-upload-tool` for local files, upload within 15 minutes, then
   attach using the returned `upload_token`.
10. MCP cannot connect/disconnect social channels, generate AI captions/images/
    videos, turn ideas into posts, manage templates, members, invites, or
    billing. Direct the user to the TryPost web app for those actions.

## Standard posting workflow

1. `get-workspace-tool` — check approval and publishing permissions.
2. `list-social-accounts-tool` — resolve the destination account and timezone.
3. `list-content-types-tool` — select a valid `content_type` and inspect media/
   meta requirements.
4. Resolve platform-specific requirements:
   - TikTok: `get-tiktok-creator-info-tool`, then set `meta.privacy_level`.
   - Pinterest: `list-pinterest-boards-tool`, then set `meta.board_id`.
   - Discord: `list-discord-channels-tool`, then set `meta.channel_id`.
   - YouTube: provide `meta.title` or ensure the first line of the content can
     serve as the title.
5. Prepare media:
   - Public direct file URL: pass it in `media[].url`.
   - Existing workspace asset: pass its `id`.
   - Local file: `request-media-upload-tool`, upload via the signed URL, then
     pass `upload_token`.
6. `create-post-tool` with `status: draft` unless the user explicitly asks to
   schedule or publish immediately.
7. `preview-post-tool` before publishing.
8. `publish-post-tool` only after explicit user approval.
9. After publication, use `get-post-metrics-tool` for per-platform analytics.

## Queue workflow

1. `get-posting-schedule-tool` to inspect the channel's schedule and timezone.
2. Use `list-free-slots-tool` for exact available queue slots.
3. Create with:
   - `queue: "next"` for the next free slot
   - `queue: "top"` for the first slot, shifting other queued posts back
   - `queue_slot` for a specific free slot
4. Use `move-post-to-slot-tool` or `reorder-queue-tool` only if the user has
   direct-publish permission.

## Scheduling example

For "Post this to LinkedIn next Tuesday at 9am Pacific":

1. Resolve the LinkedIn `social_account_id`.
2. Convert the requested local time to UTC or ISO 8601 with offset.
3. Validate content type and length limits.
4. Create a draft:
   - `platforms`: `[{ "social_account_id": "<resolved-id>" }]`
   - `content`: user-approved caption
   - `status`: `"scheduled"`
   - `scheduled_at`: resolved ISO 8601 timestamp
5. Preview, then confirm before publishing if the user asked for immediate
   publication.

## Safety and confirmation

Ask for explicit confirmation before:

- `publish-post-tool`
- `approve-post-tool`
- `reject-post-tool`
- `delete-post-tool`
- `delete-post-note-tool`
- `delete-ideas-tool`
- `delete-idea-stage-tool`
- `delete-label-tool`
- `delete-signature-tool`
- `delete-webhook-tool`
- `delete-api-key-tool`
- `rotate-webhook-secret-tool`
- Any bulk create/update operation

TryPost marks many of these tools destructive; clients are expected to seek
confirmation before running them.

## Useful tool groups

- **Posts:** `list-posts-tool`, `get-post-tool`, `create-post-tool`,
  `create-posts-tool`, `update-post-tool`, `publish-post-tool`,
  `preview-post-tool`, `delete-post-tool`, `get-post-metrics-tool`.
- **Media/assets:** `attach-media-from-url-tool`, `request-media-upload-tool`,
  `attach-media-from-upload-tool`, `list-assets-tool`, `get-asset-tool`,
  `attach-existing-asset-tool`.
- **Queue/accounts:** `list-social-accounts-tool`, `get-posting-schedule-tool`,
  `list-free-slots-tool`, `reorder-queue-tool`, `move-post-to-slot-tool`.
- **Organization:** labels, signatures, ideas, notes, webhooks, API keys,
  workspace, and platform tools.
