import type { ToolRiskLevel } from "@paperclipai/shared";
import { NATIVE_PROVIDER_CATALOGS } from "../native-provider-catalogs.js";
import { classifyRailwayToolRisk, isRailwayEndpoint } from "../railway.js";
import { braintrustRisk } from "./braintrust/risk.js";
import { enterpretRisk } from "./enterpret/risk.js";

interface ToolDescriptor {
  name: string;
  annotations?: Record<string, unknown>;
}

interface ConnectionIdentity {
  transport: string;
  config: Record<string, unknown>;
}

interface ReviewedToolPolicy {
  sourceTemplateKey: string;
  classifyRisk?: (tool: ToolDescriptor) => ToolRiskLevel | null;
  /** Tools held for review when first seen or changed, even when the connection does not quarantine new entries. */
  quarantineTool?: (tool: ToolDescriptor) => boolean;
  quarantineNewEntries: boolean;
  matchesConnection?: (connection: ConnectionIdentity) => boolean;
  matchesEndpoint?: (connection: ConnectionIdentity) => boolean;
}

// Our Ghost MCP server (https://mcp.baisoln.com/ghost/mcp, connected by
// deploy/scripts/setup-ghost-connections.sh). The generic verb heuristic reads
// "post" in gh_get_post as a write and has no "upload", so gh_get_post was
// labelled write and gh_upload_image read. The whole tool set is reviewed here;
// an unknown tool falls back to the heuristic.
const GHOST_TOOL_RISK: Record<string, ToolRiskLevel> = {
  gh_list_sites: "read", gh_site_info: "read", gh_list_posts: "read", gh_get_post: "read", gh_list_tags: "read",
  gh_create_post: "write", gh_update_post: "write", gh_create_tag: "write", gh_upload_image: "write",
  gh_publish_post: "write", gh_unpublish_post: "destructive", gh_delete_post: "destructive",
};
// TryPost (https://socialx.baisoln.com/mcp/trypost), reviewed against its live
// catalog on 2026-10-28. The heuristic called four reads writes ("post" in
// the name) and a dozen mutations reads (verbs it does not know: attach,
// activate, resume, reorder, copy, generate, ...; repurposes auto-post).
// An unknown tool falls back to the heuristic.
const TRYPOST_READS = [
  "get-analytics-publication-tool", "get-analytics-report-tool", "get-channel-insights-tool", "get-idea-tool",
  "get-instagram-audio-tool", "get-post-metrics-tool", "get-post-tool", "get-posting-schedule-tool", "get-repurpose-tool",
  "get-tiktok-creator-info-tool", "get-webhook-tool", "get-workspace-tool", "list-api-keys-tool",
  "list-channel-publications-tool", "list-content-types-tool", "list-discord-channels-tool", "list-free-slots-tool",
  "list-idea-stages-tool", "list-ideas-tool", "list-labels-tool", "list-pinterest-boards-tool", "list-post-notes-tool",
  "list-posts-tool", "list-repurpose-items-tool", "list-repurpose-source-formats-tool", "list-repurposes-tool",
  "list-signatures-tool", "list-social-accounts-tool", "list-webhook-logs-tool", "list-webhooks-tool",
  "preview-post-tool", "search-instagram-audio-tool",
];
const TRYPOST_WRITES = [
  "activate-repurpose-tool", "attach-media-from-upload-tool", "attach-media-from-url-tool", "clear-post-recurrence-tool",
  "copy-posting-schedule-tool", "create-api-key-tool", "create-idea-stage-tool", "create-idea-tool", "create-label-tool",
  "create-pinterest-board-tool", "create-post-note-tool", "create-post-tool", "create-posts-tool", "create-repurpose-tool",
  "create-signature-tool", "create-webhook-tool", "disable-repurpose-tool", "duplicate-idea-tool",
  "generate-posting-schedule-tool", "move-ideas-tool", "move-post-to-slot-tool", "pause-repurpose-tool",
  "reject-post-tool", "reorder-idea-stages-tool", "reorder-queue-tool", "replay-webhook-log-tool",
  "request-media-upload-tool", "resume-repurpose-tool", "send-webhook-test-tool", "set-post-recurrence-tool",
  "update-idea-stage-tool", "update-idea-tool", "update-label-tool", "update-post-note-tool", "update-post-tool",
  "update-posting-schedule-tool", "update-repurpose-tool", "update-signature-tool", "update-webhook-tool",
];
const TRYPOST_DESTRUCTIVE = [
  "approve-post-tool", "delete-api-key-tool", "delete-idea-stage-tool", "delete-ideas-tool", "delete-label-tool",
  "delete-post-note-tool", "delete-post-tool", "delete-repurpose-tool", "delete-signature-tool", "delete-webhook-tool",
  "publish-post-tool", "rotate-webhook-secret-tool",
];
const TRYPOST_TOOL_RISK: Record<string, ToolRiskLevel> = Object.fromEntries([
  ...TRYPOST_READS.map(name => [name, "read" as const]),
  ...TRYPOST_WRITES.map(name => [name, "write" as const]),
  ...TRYPOST_DESTRUCTIVE.map(name => [name, "destructive" as const]),
]);
// Connect Hub (self-hosted; no fixed host). The hub_* meta tools are reviewed
// here. hub_execute (router mode) runs any tool on the server, so it is the
// worst case and waits for review. App tools are named <toolkit>__<action> and
// carry the hub's MCP annotations; without a read-only hint they are writes.
const CONNECT_HUB_TOOL_RISK: Record<string, ToolRiskLevel> = {
  hub_list_connections: "read", hub_list_options: "read", hub_search_tools: "read", hub_get_tool_schema: "read",
  hub_connect: "write", hub_execute: "destructive",
};
function connectHubRisk(tool: ToolDescriptor): ToolRiskLevel {
  const reviewed = CONNECT_HUB_TOOL_RISK[tool.name];
  if (reviewed) return reviewed;
  const annotations = tool.annotations ?? {};
  const action = tool.name.includes("__") ? tool.name.slice(tool.name.indexOf("__") + 2) : tool.name;
  if (annotations.destructiveHint === true || /(?:^|[_-])(?:delete|remove|destroy|purge|revoke)(?:[_-]|$)/i.test(action)) return "destructive";
  return annotations.readOnlyHint === true ? "read" : "write";
}

// host + path of an https endpoint (case-insensitive host, trailing slashes ignored); anything else is not ours
const endpointPath = (url: unknown): string | null => {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? `${u.host}${u.pathname.replace(/\/+$/, "")}` : null;
  } catch { return null; }
};
const isGhostMcpEndpoint = (url: unknown) => endpointPath(url) === "mcp.baisoln.com/ghost/mcp";
const isTryPostEndpoint = (url: unknown) => endpointPath(url) === "socialx.baisoln.com/mcp/trypost";

// Provider selection belongs here; authorization, catalog transitions, and
// operator-selected action policies remain owned by the shared tool service.
const reviewedPolicies: ReviewedToolPolicy[] = [
  {
    sourceTemplateKey: "baisoln-ghost-mcp",
    quarantineNewEntries: false,
    classifyRisk: tool => GHOST_TOOL_RISK[tool.name] ?? null,
    matchesEndpoint: connection => isGhostMcpEndpoint(connection.config.url),
  },
  {
    sourceTemplateKey: "baisoln-trypost-mcp",
    quarantineNewEntries: false,
    classifyRisk: tool => TRYPOST_TOOL_RISK[tool.name] ?? null,
    matchesEndpoint: connection => isTryPostEndpoint(connection.config.url),
  },
  {
    sourceTemplateKey: "railway",
    quarantineNewEntries: true,
    classifyRisk: classifyRailwayToolRisk,
    matchesConnection: connection => isRailwayEndpoint(connection.config.url),
    // A custom connection to the exact reviewed endpoint gets the same risk
    // review and drift handling, without enabling the native API bridge.
    matchesEndpoint: connection => isRailwayEndpoint(connection.config.url),
  },
  // Native REST providers (Daytona, Unikraft) classify from their generated contract.
  ...NATIVE_PROVIDER_CATALOGS.map((provider): ReviewedToolPolicy => ({
    sourceTemplateKey: provider.slug,
    quarantineNewEntries: true,
    classifyRisk: tool => provider.risk(tool.name),
    matchesConnection: provider.isConnection,
  })),
  { sourceTemplateKey: "enterpret", quarantineNewEntries: true, classifyRisk: enterpretRisk },
  { sourceTemplateKey: "braintrust", quarantineNewEntries: true, classifyRisk: braintrustRisk },
  { sourceTemplateKey: "connecthub", quarantineNewEntries: false, classifyRisk: connectHubRisk, quarantineTool: tool => tool.name === "hub_execute" },
];

const bySource = new Map(reviewedPolicies.map(policy => [policy.sourceTemplateKey, policy]));

export function connectorToolPolicy(sourceTemplateKey?: string | null, connection?: ConnectionIdentity): {
  sourceTemplateKey: string | null;
  classifyRisk?: (tool: ToolDescriptor) => ToolRiskLevel | null;
  quarantineTool?: (tool: ToolDescriptor) => boolean;
  quarantineNewEntries: boolean;
} {
  const policy = (connection && reviewedPolicies.find(candidate => candidate.matchesEndpoint?.(connection)))
    || bySource.get(sourceTemplateKey ?? "");
  return {
    sourceTemplateKey: policy?.sourceTemplateKey ?? sourceTemplateKey ?? null,
    classifyRisk: policy?.classifyRisk,
    quarantineTool: policy?.quarantineTool,
    // Initial setup declares this default before discovery. Subsequent
    // refresh/reconnect preserves it only for the reviewed connection identity.
    quarantineNewEntries: Boolean(policy?.quarantineNewEntries
      && (!connection || !policy.matchesConnection || policy.matchesConnection(connection))),
  };
}
