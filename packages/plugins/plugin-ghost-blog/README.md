# Ghost Blog plugin (`paperclip.ghost-blog`)

Agents write and manage articles on **their own company's** Ghost blog.

- **Installed once per instance**, from the bundled catalog (key `ghost-blog`).
- **Configured per company.** Each company's settings name its blog's URL and a
  `secret_ref` to that company's Ghost Admin API key, stored as a write-only
  Paperclip company secret.
- **Isolation is structural.** A tool call reads only the calling agent's company
  configuration. Site and key never come from tool arguments, so an agent cannot
  reach another company's blog.
- **Ask first.** `publish_article`, `unpublish_article` and `delete_article` are
  meant to sit behind a company `require_approval` policy.
  `deploy/scripts/setup-ghost-plugin.sh` creates it and verifies the policy
  decisions.

| Tool | What it does |
|---|---|
| `site_info` | Title, description, URL, Ghost version |
| `list_articles` | Newest first; filter by `status`, `tag` |
| `get_article` | One article with rendered HTML |
| `create_draft` | Draft from `markdown` or `html`, credited to the Blog Agent staff user |
| `update_article` | Change fields; the body and tags are replaced when passed |
| `publish_article` | Publish now, or schedule with `publishAt`. Never sends a newsletter. |
| `unpublish_article` | Back to draft |
| `delete_article` | Permanent |
| `list_tags` | Tags with post counts |

## Network

Calls go through the host's `ctx.http` (audited, DNS-pinned). The blogs are
in-cluster (`http://ghost-<site>.blog.svc.cluster.local:2368`), so the instance
must allow them for this plugin only:

```
PAPERCLIP_PLUGIN_HTTP_ALLOWED_PRIVATE_HOSTS="paperclip.ghost-blog=ghost-bionic.blog.svc.cluster.local,ghost-reliora.blog.svc.cluster.local"
```

This is the bionic-org chart value `env.PAPERCLIP_PLUGIN_HTTP_ALLOWED_PRIVATE_HOSTS`.
Exact hostnames only. Loopback, link-local and metadata addresses stay blocked.
`X-Forwarded-Proto: https` is sent because Ghost's configured URL is https.

## Relation to the MCP connection

Each company can instead (or also) use the per-company **Ghost blog** Apps
connection to `https://mcp.baisoln.com/ghost/mcp`
(`deploy/scripts/setup-ghost-connections.sh`). Both paths are scoped to the
company's own blog. The plugin talks to Ghost directly with the company's
Admin API key. The connection goes through the ghost MCP server with a
company-scoped gateway key.

## Development

```sh
pnpm --filter @paperclipai/plugin-ghost-blog typecheck
pnpm --filter @paperclipai/plugin-ghost-blog test
pnpm --filter @paperclipai/plugin-ghost-blog build
```
