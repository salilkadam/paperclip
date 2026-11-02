import { describe, expect, it, vi } from "vitest";
import { AggregatorDiscoveryUnavailableError, connectHubConnectLink, discoverArcadeApps, discoverConnectHubApps, discoverExecutorApps, EXECUTOR_INVENTORY_CODE, inventoryPayload } from "../services/aggregator-app-discovery.js";
import { aggregatorManagementUrl, isConnectHubToolCatalog } from "@paperclipai/shared/aggregator-apps";

const account = (id: string, user = "u1") => ({ id, user_id: user, provider_id: "notion-provider", connection_status: "active", provider_user_info: { email: "Work", access_token: "do-not-store" } });
const tool = { qualified_name: "Notion.ListPages", toolkit: { name: "Notion" }, requirements: { met: true, authorization: { provider_id: "notion-provider", token_status: "completed" } } };

describe("aggregator inventory adapters", () => {
  it("paginates Arcade, scopes the user and exposed tools, preserves distinct accounts, and strips credentials", async () => {
    const request = vi.fn(async (path: string) => path.startsWith("/v1/tools") ? { items: [tool, { ...tool, toolkit: { name: "Private" }, qualified_name: "Private.Read" }] }
      : path.includes("offset=100") ? { items: [account("last"), account("foreign", "u2")], total_count: 102, offset: 0 }
      : { items: Array.from({ length: 100 }, (_, index) => account(String(index))), total_count: 102, offset: 100 });
    const apps = await discoverArcadeApps({ request, userId: "u1", gatewayTools: ["Notion_ListPages"] });
    expect(apps).toHaveLength(1);
    expect(apps[0].accounts).toHaveLength(101);
    expect(apps[0].accounts[0]).toMatchObject({ appSlug: "notion", status: "ACTIVE", alias: "Work" });
    expect(JSON.stringify(apps)).not.toContain("do-not-store");
    expect(request.mock.calls[0][0]).toContain("user[id]=u1");
  });
  it("uses Arcade's next offset after a short page and rejects truncated final pages", async () => {
    const request = vi.fn(async (path: string) => path.startsWith("/v1/tools") ? { items: [tool], total_count: 1, offset: 0 }
      : path.includes("offset=1") ? { items: [account("second")], total_count: 2, offset: 0 }
      : { items: [account("first")], total_count: 2, offset: 1 });
    expect((await discoverArcadeApps({ request, userId: "u1", gatewayTools: ["Notion.ListPages"] }))[0].accounts).toHaveLength(2);
    expect(request.mock.calls.some(([path]) => path.includes("offset=1"))).toBe(true);
    await expect(discoverArcadeApps({ userId: "u1", gatewayTools: ["Notion.ListPages"], request: async path => path.startsWith("/v1/tools")
      ? { items: [tool], total_count: 1, offset: 0 } : { items: [account("one")], total_count: 2, offset: 0 } })).rejects.toThrow("Incomplete");
  });
  it("rejects an Arcade partial page rather than returning an authoritative empty inventory", async () => {
    for (const items of [[], [account("one")]]) await expect(discoverArcadeApps({ userId: "u1", gatewayTools: ["Notion.ListPages"], request: async path => path.startsWith("/v1/tools") ? { items: [tool] } : { items, total: 10 } })).rejects.toThrow("Incomplete");
  });
  it("does not claim Arcade authorization from account existence alone", async () => {
    const apps = await discoverArcadeApps({ userId: "u1", gatewayTools: ["Notion.ListPages"], request: async path => ({ items: path.startsWith("/v1/tools") ? [{ ...tool, requirements: { ...tool.requirements, met: false } }] : [account("1")] }) });
    expect(apps[0].accounts[0].status).toBe("UNVERIFIED");
  });
  it("enumerates Executor pages and uses owner/integration/account identity with honest health", async () => {
    const call = vi.fn(async (_name, args) => ({ result: { structuredContent: { items: [{ integration: args.offset ? "custom-notion-helper" : "notion", integrationName: "Custom helper", connection: "Work", owner: args.offset ? "user" : "org", identityLabel: "Work", lastHealth: args.offset ? null : { status: "healthy", checkedAt: 1000 }, secret: "never" }], hasMore: !args.offset, nextOffset: args.offset ? null : 50 } } }));
    const apps = await discoverExecutorApps({ call, toolNames: ["integrations"], managementUrl: "https://executor.example/team/integrations" });
    expect(apps[0].accounts[0]).toMatchObject({ appSlug: "notion", status: "ACTIVE", healthCheckedAt: "1970-01-01T00:00:01.000Z" });
    expect(apps[1].accounts[0]).toMatchObject({ appSlug: "executor:custom-notion-helper", status: "UNVERIFIED" });
    expect(JSON.stringify(apps)).not.toContain("never");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("uses fixed read-only code and preserves an upstream workspace management link", async () => {
    const call = vi.fn(async () => ({ structuredContent: { status: "completed", result: { connections: [{ integration: "notion", name: "Work", owner: "user", lastHealth: { status: "expired" } }], integrations: [{ slug: "notion" }], managementUrls: { notion: "https://self-host.example/my-org/integrations/notion?addAccount=1" } } } }));
    const apps = await discoverExecutorApps({ call, toolNames: ["execute"] });
    expect(call).toHaveBeenCalledWith("execute", { code: EXECUTOR_INVENTORY_CODE });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(await new AsyncFunction("tools", EXECUTOR_INVENTORY_CODE)({})).toEqual({ discoveryUnavailable: true });
    expect(apps[0].accounts[0]).toMatchObject({ status: "EXPIRED", managementUrl: "https://self-host.example/my-org/integrations/notion" });
  });
  it("rejects unsupported, failed, malformed and truncated Executor inventories", async () => {
    await expect(discoverExecutorApps({ toolNames: [], call: vi.fn() })).rejects.toThrow("unavailable");
    await expect(discoverExecutorApps({ toolNames: ["execute"], call: async () => ({ structuredContent: { result: { incompatible: true } } }) })).rejects.toBeInstanceOf(AggregatorDiscoveryUnavailableError);
    await expect(discoverExecutorApps({ toolNames: ["execute"], call: async () => ({ isError: true }) })).rejects.toThrow("failed");
    await expect(discoverExecutorApps({ toolNames: ["integrations"], call: async () => ({ items: [], hasMore: true, nextOffset: 0 }) })).rejects.toThrow("Incomplete");
    expect(() => inventoryPayload({ content: [{ type: "text", text: "No accounts" }] })).toThrow();
  });
  it("maps Connect Hub toolkits to apps, ACTIVE accounts to connected, and keeps only identity and status", async () => {
    const hubText = (value: unknown) => ({ jsonrpc: "2.0", id: "x", result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
    const call = vi.fn(async () => hubText({
      connected: [
        { id: "ca_1", toolkit: "google-drive", status: "ACTIVE", identifier: "ops@example.com", access_token: "do-not-store" },
        { id: "ca_2", toolkit: "github", status: "EXPIRED", identifier: null },
        { id: "ca_3", toolkit: "github", status: "SOMETHING_NEW" },
      ],
      available_toolkits: ["google-drive", "github", "acme-internal"],
    }));
    const apps = await discoverConnectHubApps({ call, toolNames: ["hub_list_connections", "hub_connect"], managementUrl: "https://hub.example/dashboard" });
    expect(call).toHaveBeenCalledWith("hub_list_connections", {});
    expect(apps.map(app => app.toolkit)).toEqual(["google-drive", "github", "acme-internal"]);
    expect(apps[0].accounts).toEqual([{ id: "ca_1", alias: "ops@example.com", status: "ACTIVE", isDefault: false, appSlug: "googledrive", appName: "Google Drive", managementUrl: "https://hub.example/dashboard" }]);
    expect(apps[1].accounts.map(account => account.status)).toEqual(["EXPIRED", "UNVERIFIED"]);
    expect(apps[2]).toEqual({ toolkit: "acme-internal", accounts: [] });
    expect(JSON.stringify(apps)).not.toContain("do-not-store");
  });
  it("surfaces unsupported, failed and malformed Connect Hub inventories as errors, never as empty", async () => {
    await expect(discoverConnectHubApps({ toolNames: ["hub_connect"], managementUrl: null, call: vi.fn() })).rejects.toBeInstanceOf(AggregatorDiscoveryUnavailableError);
    await expect(discoverConnectHubApps({ toolNames: ["hub_list_connections"], managementUrl: null, call: async () => ({ result: { isError: true, content: [{ type: "text", text: "{\"error\":\"bad token\"}" }] } }) })).rejects.toThrow("failed");
    await expect(discoverConnectHubApps({ toolNames: ["hub_list_connections"], managementUrl: null, call: async () => ({ result: { content: [{ type: "text", text: "No connections" }] } }) })).rejects.toThrow();
    await expect(discoverConnectHubApps({ toolNames: ["hub_list_connections"], managementUrl: null, call: async () => ({ connected: [] }) })).rejects.toThrow("Incomplete");
    await expect(discoverConnectHubApps({ toolNames: ["hub_list_connections"], managementUrl: null, call: async () => ({ connected: [{ toolkit: "github", status: "ACTIVE" }], available_toolkits: ["github"] }) })).rejects.toThrow("Malformed");
    await expect(discoverConnectHubApps({ toolNames: ["hub_list_connections"], managementUrl: null, call: async () => ({ connected: [{ id: "a", toolkit: "github" }, { id: "a", toolkit: "github" }], available_toolkits: ["github"] }) })).rejects.toThrow("Duplicate");
  });
  it("detects Connect Hub only from both discovery tools", () => {
    expect(isConnectHubToolCatalog(["hub_list_connections", "hub_connect", "github__github_list_repos"])).toBe(true);
    expect(isConnectHubToolCatalog(["hub_list_connections"])).toBe(false);
    expect(isConnectHubToolCatalog(["COMPOSIO_MANAGE_CONNECTIONS", "hub_connect"])).toBe(false);
  });
  it("trusts a hub_connect link only on the connection's own hub origin", () => {
    const result = (url: string) => ({ jsonrpc: "2.0", id: "x", result: { content: [{ type: "text", text: JSON.stringify({ connect_url: url, expires_at: "2026-11-02T12:00:00.000Z" }) }] } });
    expect(connectHubConnectLink(result("https://hub.example/connect/ln_1?sig=abc"), "https://hub.example/mcp")).toBe("https://hub.example/connect/ln_1?sig=abc");
    expect(connectHubConnectLink(result("https://evil.example/connect/ln_1?sig=abc"), "https://hub.example/mcp")).toBeNull();
    expect(connectHubConnectLink(result("https://hub.example.evil.example/connect/ln_1"), "https://hub.example/mcp")).toBeNull();
    expect(connectHubConnectLink(result("http://hub.example/connect/ln_1"), "https://hub.example/mcp")).toBeNull();
    expect(connectHubConnectLink(result("https://hub.example/connect/ln_1"), "http://hub.example/mcp")).toBeNull();
    expect(() => connectHubConnectLink({ result: { isError: true, content: [{ type: "text", text: "{\"error\":\"nope\"}" }] } }, "https://hub.example/mcp")).toThrow();
  });
  it("keeps Connect Hub management URLs on the connection endpoint's host", () => {
    expect(aggregatorManagementUrl("connecthub", null, "https://hub.example/mcp")).toBe("https://hub.example/dashboard");
    expect(aggregatorManagementUrl("connecthub", "https://hub.example/tenants/acme", "https://hub.example/mcp")).toBe("https://hub.example/tenants/acme");
    for (const url of ["https://other.example/dashboard", "http://hub.example/dashboard", "https://user:pw@hub.example/", "https://hub.example/?token=secret", "https://hub.example:8443/dashboard"]) {
      expect(aggregatorManagementUrl("connecthub", url, "https://hub.example/mcp")).toBeNull();
    }
    expect(aggregatorManagementUrl("connecthub")).toBeNull();
    expect(aggregatorManagementUrl("connecthub", null, "http://hub.internal/mcp")).toBeNull();
    expect(aggregatorManagementUrl("connecthub", "https://hub.example/dashboard", "not a url")).toBeNull();
  });
  it("validates browser destinations without leaking credentials", () => {
    expect(aggregatorManagementUrl("composio")).toBe("https://dashboard.composio.dev/~/org/connect/apps");
    for (const url of ["javascript:alert(1)", "https://user:password@executor.example/", "https://executor.example/?api_key=secret"]) expect(aggregatorManagementUrl("executor", url)).toBeNull();
    expect(aggregatorManagementUrl("arcade", "https://other.example")).toBeNull();
    expect(aggregatorManagementUrl("executor", "https://executor.example/team/accounts")).toBe("https://executor.example/team/accounts");
  });
});
