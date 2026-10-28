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
  quarantineNewEntries: boolean;
  matchesConnection?: (connection: ConnectionIdentity) => boolean;
  matchesEndpoint?: (connection: ConnectionIdentity) => boolean;
}

// Our Ghost MCP server (https://mcp.baisoln.com/ghost/mcp, deploy-ghost.sh).
// The generic verb heuristic reads "post" in gh_get_post as a write and has no
// "upload", so gh_get_post was labelled write and gh_upload_image read. The
// whole tool set is reviewed here; an unknown tool falls back to the heuristic.
const GHOST_TOOL_RISK: Record<string, ToolRiskLevel> = {
  gh_list_sites: "read", gh_site_info: "read", gh_list_posts: "read", gh_get_post: "read", gh_list_tags: "read",
  gh_create_post: "write", gh_update_post: "write", gh_create_tag: "write", gh_upload_image: "write",
  gh_publish_post: "write", gh_unpublish_post: "destructive", gh_delete_post: "destructive",
};
const endpointPath = (url: unknown): string | null => {
  if (typeof url !== "string") return null;
  try { const u = new URL(url); return `${u.host}${u.pathname.replace(/\/+$/, "")}`; } catch { return null; }
};
const isGhostMcpEndpoint = (url: unknown) => endpointPath(url) === "mcp.baisoln.com/ghost/mcp";
// TryPost (https://socialx.baisoln.com/mcp/trypost): get-post-tool and
// get-post-metrics-tool read, but "post" in their names made the heuristic call
// them writes. Its get-/list-/preview- tools are reads unless the provider says
// otherwise; everything else keeps the heuristic.
const isTryPostEndpoint = (url: unknown) => endpointPath(url) === "socialx.baisoln.com/mcp/trypost";
const tryPostRisk = (tool: ToolDescriptor): ToolRiskLevel | null => {
  const annotations = tool.annotations ?? {};
  if (annotations.readOnlyHint === false || annotations.writeHint === true) return null;
  return /^(get|list|preview)-[a-z0-9-]+-tool$/.test(tool.name) ? "read" : null;
};

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
    classifyRisk: tryPostRisk,
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
];

const bySource = new Map(reviewedPolicies.map(policy => [policy.sourceTemplateKey, policy]));

export function connectorToolPolicy(sourceTemplateKey?: string | null, connection?: ConnectionIdentity): {
  sourceTemplateKey: string | null;
  classifyRisk?: (tool: ToolDescriptor) => ToolRiskLevel | null;
  quarantineNewEntries: boolean;
} {
  const policy = (connection && reviewedPolicies.find(candidate => candidate.matchesEndpoint?.(connection)))
    || bySource.get(sourceTemplateKey ?? "");
  return {
    sourceTemplateKey: policy?.sourceTemplateKey ?? sourceTemplateKey ?? null,
    classifyRisk: policy?.classifyRisk,
    // Initial setup declares this default before discovery. Subsequent
    // refresh/reconnect preserves it only for the reviewed connection identity.
    quarantineNewEntries: Boolean(policy?.quarantineNewEntries
      && (!connection || !policy.matchesConnection || policy.matchesConnection(connection))),
  };
}
