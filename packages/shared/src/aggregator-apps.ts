import { z } from "zod";
import type { ComposioAppSnapshot, ComposioAppSyncState } from "./composio-app-setup.js";
import type { AppCatalogAggregator } from "./aggregator-app-catalog.js";

export const AGGREGATOR_NAMES = { composio: "Composio", arcade: "Arcade", executor: "Executor", connecthub: "Connect Hub" } as const;
export function isAppAggregator(value: unknown): value is AppCatalogAggregator {
  return typeof value === "string" && Object.hasOwn(AGGREGATOR_NAMES, value);
}

/** Cached upstream observations. These neither grant access nor create tool connections. */
export interface AggregatorAppSnapshot extends ComposioAppSnapshot {
  provider: AppCatalogAggregator;
  appSlug: string;
  appName: string;
  freshness: "fresh" | "stale";
}
export interface AggregatorAppsResponse {
  provider: AppCatalogAggregator;
  apps: AggregatorAppSnapshot[];
  discovery: {
    availability: "available" | "setup_required" | "unsupported" | "disabled";
    message: string | null;
  };
  sync: Omit<ComposioAppSyncState, "coverage"> & {
    coverage: "supported_catalog" | "gateway_tools" | "visible_accounts";
  };
}
export const aggregatorAppsSyncSchema = z.object({ force: z.boolean().default(false) }).strict();
export const aggregatorAppsRefreshSchema = z.object({
  toolkits: z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();
export const arcadeDiscoverySetupSchema = z.object({
  apiKey: z.string().trim().min(1).max(8192),
  userId: z.string().trim().min(1).max(500),
}).strict();
export type ArcadeDiscoverySetupInput = z.infer<typeof arcadeDiscoverySetupSchema>;

/** Connect Hub is self-hosted: its own MCP catalog, not a hostname, identifies it. */
export const CONNECT_HUB_DISCOVERY_TOOLS = ["hub_list_connections", "hub_connect"] as const;
export function isConnectHubToolCatalog(toolNames: Iterable<string>): boolean {
  const names = new Set(toolNames);
  return CONNECT_HUB_DISCOVERY_TOOLS.every(name => names.has(name));
}

/** The hub's https origin, derived only from the connection's configured endpoint. */
export function connectHubOrigin(endpoint: string | URL | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

/** Only trustworthy browser destinations; never expose URL credentials or active schemes.
 * Connect Hub has no fixed host: its management URL must stay on the connection endpoint's host. */
export function aggregatorManagementUrl(provider: AppCatalogAggregator, configured?: string | null, endpoint?: string | URL | null): string | null {
  const hubOrigin = provider === "connecthub" ? connectHubOrigin(endpoint) : null;
  if (provider === "connecthub" && !hubOrigin) return null;
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol !== "https:" || url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|api.?key|authorization|code/i.test(key))) return null;
      if (provider === "composio" && url.hostname !== "dashboard.composio.dev") return null;
      if (provider === "arcade" && url.hostname !== "app.arcade.dev") return null;
      if (provider === "connecthub" && url.origin !== hubOrigin) return null; // same origin: host and port
      return url.toString();
    } catch { return null; }
  }
  return provider === "composio" ? "https://dashboard.composio.dev/~/org/connect/apps"
    : provider === "arcade" ? "https://app.arcade.dev/"
    : provider === "connecthub" ? `${hubOrigin}/dashboard` : null;
}
