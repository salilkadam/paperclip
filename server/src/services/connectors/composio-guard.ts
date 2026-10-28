// Composio community-write guard, enforced in the access decision itself.
//
// Owner's decision (2026-10-28): replies on Reddit, Hacker News and Stack
// Exchange are posted by a person. Agents may search and read those sites
// through Composio, never post, comment, vote or edit there. Company policies
// (deploy/scripts/setup-composio-governance.sh) said the same, but only for
// connections that existed when the script ran, and a board edit could turn
// them off. This guard covers every Composio connection in every company from
// the moment it exists, and only a code change lifts it: the policy decision
// runs it, and the two dispatch paths without a fresh decision (approved
// action requests, board health probes) call it too (tool-gateway.ts).
//
// What it refuses, for a Composio connection:
//   - a Reddit / Hacker News / Stack Exchange tool whose verb is not a read
//     (SEARCH, RETRIEVE, GET, LIST, FETCH), called directly or inside
//     COMPOSIO_MULTI_EXECUTE_TOOL (every item, any letter case or padding);
//   - a multi-execute call it cannot read with certainty: `tools` present but
//     not a list, an item without a text tool_slug, unknown item keys, a slug
//     with characters outside A-Z, 0-9 and "_", or a COMPOSIO_* meta tool as an
//     item (a call without `tools` executes nothing and is how discovery asks);
//   - the remote bash and workbench sandboxes (they can call any Composio tool
//     themselves);
//   - any other COMPOSIO_* meta tool not reviewed below. A new one stays
//     refused until someone reviews it and adds it here.

export const COMPOSIO_REVIEWED_META_TOOLS: ReadonlySet<string> = new Set([
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
  // load / search / edit Markdown guidance; they run no tools
  "COMPOSIO_SEARCH_SKILLS",
  "COMPOSIO_USE_SKILL",
  "COMPOSIO_MANAGE_SKILL",
  "COMPOSIO_SUBMIT_FEEDBACK",
]);
const COMPOSIO_SANDBOXES = new Set(["COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH"]);
const COMMUNITY_TOOLKITS = [
  { prefix: "REDDIT_", site: "Reddit" },
  { prefix: "HACKERNEWS_", site: "Hacker News" },
  { prefix: "STACK_EXCHANGE_", site: "Stack Exchange" },
];
// EXPAND (REDDIT_EXPAND_MORE_COMMENTS) and FIND (STACK_EXCHANGE_FIND_SIMILAR_QUESTIONS) are reads too
const READ_VERBS = ["SEARCH", "RETRIEVE", "GET", "LIST", "FETCH", "EXPAND", "FIND"];
const MULTI_EXECUTE_ITEM_KEYS = new Set(["tool_slug", "arguments", "account"]);

export type ComposioGuardRefusal = { code: string; explanation: string };

export function isComposioConnection(connection: { config?: unknown }): boolean {
  const config = connection.config && typeof connection.config === "object"
    ? connection.config as Record<string, unknown> : {};
  if (config.sourceTemplateKey === "composio") return true;
  // the same fields remoteEndpoint() dispatches to
  const url = config.url ?? config.endpoint ?? config.remoteUrl;
  if (typeof url !== "string") return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "composio.dev" || host.endsWith(".composio.dev");
  } catch {
    return false;
  }
}

function communityWrite(slug: string): ComposioGuardRefusal | null {
  const toolkit = COMMUNITY_TOOLKITS.find(candidate => slug.startsWith(candidate.prefix));
  if (!toolkit) return null;
  const verb = slug.slice(toolkit.prefix.length).split("_")[0];
  if (READ_VERBS.includes(verb)) return null;
  return {
    code: "composio_community_write",
    explanation: `Agents only read ${toolkit.site}; a person posts every reply (owner's decision, 2026-10-28). ${slug} was refused.`,
  };
}

function multiExecuteRefusal(args: Record<string, unknown>): ComposioGuardRefusal | null {
  const unreadable = (detail: string): ComposioGuardRefusal => ({
    code: "composio_unreadable_call",
    explanation: `This Composio call could not be checked for Reddit, Hacker News or Stack Exchange writes (${detail}), so it was refused. Send tools as a list of {tool_slug, arguments}.`,
  });
  const tools = args.tools;
  // No tools: the call can execute nothing. This is also how tool discovery asks (no arguments), and
  // refusing it would hide multi-execute from every agent.
  if (tools === undefined) return null;
  if (!Array.isArray(tools)) return unreadable("tools is not a list");
  for (const item of tools) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return unreadable("an item is not an object");
    const record = item as Record<string, unknown>;
    const extra = Object.keys(record).find(key => !MULTI_EXECUTE_ITEM_KEYS.has(key));
    if (extra) return unreadable(`unknown item field "${extra}"`);
    if (typeof record.tool_slug !== "string") return unreadable("an item has no text tool_slug");
    const slug = record.tool_slug.trim().toUpperCase();
    if (!/^[A-Z0-9_]+$/.test(slug)) return unreadable("a tool_slug has unexpected characters");
    // a meta tool run as an item (a sandbox, another multi-execute) would escape this check
    if (slug.startsWith("COMPOSIO_")) return unreadable(`${slug} cannot run inside multi-execute`);
    const refusal = communityWrite(slug);
    if (refusal) return refusal;
  }
  return null;
}

/** Why this Composio call must be refused, or null when the guard has no objection. */
export function composioGuardRefusal(toolNames: Array<string | null | undefined>, args: unknown): ComposioGuardRefusal | null {
  const record = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  for (const raw of new Set(toolNames.filter((name): name is string => typeof name === "string" && name.length > 0))) {
    const name = raw.trim().toUpperCase();
    if (COMPOSIO_SANDBOXES.has(name)) {
      return {
        code: "composio_sandbox",
        explanation: "Composio's remote sandboxes can call any connected app, including Reddit and Stack Exchange, so agents may not use them. Fetch public APIs from your own runtime instead.",
      };
    }
    if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
      const refusal = multiExecuteRefusal(record);
      if (refusal) return refusal;
      continue;
    }
    if (name.startsWith("COMPOSIO_")) {
      if (!COMPOSIO_REVIEWED_META_TOOLS.has(name)) {
        return {
          code: "composio_unreviewed_tool",
          explanation: `${name} is a Composio tool nobody has reviewed yet, so agents may not use it. Ask the board to review it.`,
        };
      }
      continue;
    }
    const refusal = communityWrite(name);
    if (refusal) return refusal;
  }
  return null;
}
