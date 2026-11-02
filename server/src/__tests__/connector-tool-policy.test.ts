import { randomUUID } from "node:crypto";
import { companies, createDb } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectorToolPolicy } from "../services/connectors/tool-policy.js";
import { DAYTONA_API_URL, DAYTONA_METHOD } from "../services/daytona.js";
import { classifyRisk, toolAccessService, type McpToolDescriptor } from "../services/tool-access.js";
import { RAILWAY_MCP_URL } from "../services/railway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("reviewed connector risk dispatch", () => {
  it("labels every tool of our Ghost and TryPost MCP servers by review, not by the verb heuristic", () => {
    // the heuristic: "post" anywhere reads as a write, and "upload" is not a write verb
    expect(classifyRisk({ name: "gh_get_post" })).toBe("write");
    expect(classifyRisk({ name: "gh_upload_image" })).toBe("read");
    const ghost = connectorToolPolicy(null, { transport: "mcp_remote", config: { url: "https://mcp.baisoln.com/ghost/mcp" } });
    expect(ghost.sourceTemplateKey).toBe("baisoln-ghost-mcp");
    for (const [name, risk] of [
      ["gh_get_post", "read"], ["gh_list_posts", "read"], ["gh_list_tags", "read"], ["gh_site_info", "read"], ["gh_list_sites", "read"],
      ["gh_upload_image", "write"], ["gh_create_post", "write"], ["gh_update_post", "write"], ["gh_create_tag", "write"],
      ["gh_publish_post", "write"], ["gh_unpublish_post", "destructive"], ["gh_delete_post", "destructive"],
    ] as const) expect(classifyRisk({ name }, ghost.sourceTemplateKey), name).toBe(risk);
    // a provider's destructive hint still wins; an unknown tool falls back to the heuristic
    expect(classifyRisk({ name: "gh_get_post", annotations: { destructiveHint: true } }, ghost.sourceTemplateKey)).toBe("destructive");
    expect(classifyRisk({ name: "gh_new_tool_delete" }, ghost.sourceTemplateKey)).toBe("destructive");
    expect(connectorToolPolicy(null, { transport: "mcp_remote", config: { url: "https://mcp.baisoln.com/ghost/mcp/" } }).sourceTemplateKey).toBe("baisoln-ghost-mcp");

    const tryPost = connectorToolPolicy(null, { transport: "mcp_remote", config: { url: "https://socialx.baisoln.com/mcp/trypost" } });
    expect(tryPost.sourceTemplateKey).toBe("baisoln-trypost-mcp");
    for (const [name, risk] of [
      ["get-post-tool", "read"], ["get-post-metrics-tool", "read"], ["list-posts-tool", "read"], ["preview-post-tool", "read"],
      ["list-post-notes-tool", "read"],
      // mutations the heuristic called reads (repurposes auto-post)
      ["attach-media-from-url-tool", "write"], ["request-media-upload-tool", "write"], ["activate-repurpose-tool", "write"],
      ["resume-repurpose-tool", "write"], ["reorder-queue-tool", "write"], ["copy-posting-schedule-tool", "write"],
      ["create-post-tool", "write"], ["update-post-tool", "write"],
      ["publish-post-tool", "destructive"], ["delete-post-tool", "destructive"], ["rotate-webhook-secret-tool", "destructive"],
    ] as const) expect(classifyRisk({ name }, tryPost.sourceTemplateKey), name).toBe(risk);
    // an unknown tool is not trusted by its prefix: it falls back to the heuristic
    expect(classifyRisk({ name: "list-and-delete-ideas-tool" }, tryPost.sourceTemplateKey)).toBe("destructive");
    expect(classifyRisk({ name: "get-or-create-label-tool" }, tryPost.sourceTemplateKey)).toBe("write");

    // look-alike endpoints are not reviewed
    for (const url of ["http://mcp.baisoln.com/ghost/mcp", "wss://socialx.baisoln.com/mcp/trypost", "https://mcp.baisoln.com/ghost/mcp-evil", "https://evil.example/ghost/mcp", "https://mcp.baisoln.com.evil.example/ghost/mcp", "not a url"]) {
      expect(connectorToolPolicy(null, { transport: "mcp_remote", config: { url } }).sourceTemplateKey, url).toBeNull();
    }
  });

  it("keeps destructive provider hints above every reviewed classifier", () => {
    for (const [source, name] of [
      ["railway", "list-projects"], ["daytona", "daytona_api_list_sandboxes"],
      ["enterpret", "run_graph_query"], ["braintrust", "sql_query"],
    ]) {
      for (const annotations of [{ destructiveHint: true }, { destructive: true }]) {
        expect(classifyRisk({ name, annotations }, source)).toBe("destructive");
      }
    }
  });

  it("retains each provider's reviewed annotation precedence", () => {
    expect(classifyRisk({ name: "listProjects" }, "railway")).toBe("read");
    expect(classifyRisk({ name: "listProjects", annotations: { writeHint: true } }, "railway")).toBe("write");
    expect(classifyRisk({ name: "redeploy", annotations: { readOnlyHint: true } }, "railway")).toBe("destructive");
    // The native catalog owns this risk; a write hint does not replace it.
    expect(classifyRisk({ name: "daytona_api_list_sandboxes", annotations: { writeHint: true } }, "daytona")).toBe("read");
    expect(classifyRisk({ name: "unknown", annotations: { readOnlyHint: true } }, "daytona")).toBe("destructive");
    expect(classifyRisk({ name: "runGraphQuery", annotations: { readOnlyHint: true } }, "enterpret")).toBe("write");
    expect(classifyRisk({ name: "get_organization_details", annotations: { readOnlyHint: true } }, "enterpret")).toBe("read");
    expect(classifyRisk({ name: "edit_dataset_rows", annotations: { readOnlyHint: false } }, "braintrust")).toBe("destructive");
    expect(classifyRisk({ name: "sql_query", annotations: { writeHint: true } }, "braintrust")).toBe("write");
    expect(classifyRisk({ name: "new_tool", annotations: { readOnlyHint: true } }, "braintrust")).toBe("write");
  });

  it("reviews Connect Hub meta tools and holds router-mode hub_execute for review", () => {
    const hub = connectorToolPolicy("connecthub");
    expect(hub.sourceTemplateKey).toBe("connecthub");
    expect(hub.quarantineNewEntries).toBe(false);
    expect(hub.quarantineTool?.({ name: "hub_execute" })).toBe(true);
    for (const name of ["hub_list_connections", "hub_connect", "github__github_create_issue"]) expect(hub.quarantineTool?.({ name })).toBe(false);
    expect(classifyRisk({ name: "hub_execute", annotations: { readOnlyHint: false, destructiveHint: true } }, "connecthub")).toBe("destructive");
    expect(classifyRisk({ name: "hub_connect" }, "connecthub")).toBe("write");
    expect(classifyRisk({ name: "slack__slack_list_channels", annotations: { readOnlyHint: true } }, "connecthub")).toBe("read");
    expect(classifyRisk({ name: "slack__slack_post_message", annotations: { readOnlyHint: false } }, "connecthub")).toBe("write");
    // No other connector inherits it.
    expect(connectorToolPolicy("composio").quarantineTool).toBeUndefined();
    expect(connectorToolPolicy("custom").quarantineTool).toBeUndefined();
  });

  it("retains generic risk behavior when the connector has no reviewed override", () => {
    expect(classifyRisk({ name: "get_object" }, "custom")).toBe("read");
    expect(classifyRisk({ name: "new_tool", annotations: { readOnlyHint: true } }, "custom")).toBe("read");
    expect(connectorToolPolicy("custom").classifyRisk).toBeUndefined();
  });
});

describe("reviewed connector catalog policies", () => {
  it.each(["railway", "enterpret", "daytona", "unikraft", "braintrust"])("declares the initial drift policy for %s", source => {
    expect(connectorToolPolicy(source).quarantineNewEntries).toBe(true);
  });

  it.each([undefined, null, "custom", "notion"])("keeps existing initial defaults for %s", source => {
    expect(connectorToolPolicy(source).quarantineNewEntries).toBe(false);
  });

  it.each(["https://mcp.railway.com", "https://mcp.railway.com/"])("recognizes the exact Railway endpoint for a custom connection: %s", url => {
    const policy = connectorToolPolicy("custom", { transport: "mcp_remote", config: { url } });
    expect(policy.sourceTemplateKey).toBe("railway");
    expect(policy.quarantineNewEntries).toBe(true);
    expect(classifyRisk({ name: "redeploy", annotations: { readOnlyHint: true } }, policy.sourceTemplateKey)).toBe("destructive");
  });

  it.each(["https://mcp.railway.com.evil.test", "https://mcp.railway.com/custom", "https://other.test"])("does not extend Railway's catalog policy to %s", url => {
    expect(connectorToolPolicy("custom", { transport: "mcp_remote", config: { url } }).quarantineNewEntries).toBe(false);
    expect(connectorToolPolicy("railway", { transport: "mcp_remote", config: { url } }).quarantineNewEntries).toBe(false);
  });

  it("preserves native Daytona review only for the reviewed REST method and endpoint", () => {
    const config = { sourceTemplateKey: "daytona", connectionMethodKey: DAYTONA_METHOD, url: DAYTONA_API_URL };
    expect(connectorToolPolicy("daytona", { transport: "rest_api", config }).quarantineNewEntries).toBe(true);
    for (const connection of [
      { transport: "mcp_remote", config },
      { transport: "rest_api", config: { ...config, connectionMethodKey: "mcp-oauth" } },
      { transport: "rest_api", config: { ...config, url: "https://other.test" } },
    ]) expect(connectorToolPolicy("daytona", connection).quarantineNewEntries).toBe(false);
  });

  it.each(["enterpret", "braintrust"])("preserves %s review when reconnect resets the saved flag", sourceTemplateKey => {
    const policy = connectorToolPolicy(sourceTemplateKey, {
      transport: "mcp_remote", config: { sourceTemplateKey, quarantineNewEntries: false },
    });
    expect(policy.quarantineNewEntries).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("custom connection catalog policy", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-connector-policy-");
    db = createDb(temp.connectionString);
  }, 30000);
  afterAll(async () => { await temp?.cleanup(); });

  it("applies reviewed endpoint risks and keeps changed tools quarantined without enabling a native bridge", async () => {
    const [company] = await db.insert(companies).values({ name: "Custom policy fixture", issuePrefix: `CP${randomUUID().slice(0, 6)}` }).returning();
    let tools: McpToolDescriptor[] = [{ name: "redeploy", annotations: { readOnlyHint: true } }];
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url.replace(/\/$/, "")).toBe(RAILWAY_MCP_URL);
      const rpc = JSON.parse(String(init.body));
      if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Policy fixture", version: "1" } } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
    });
    const service = toolAccessService(db, { remoteHttpRequest: request,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const actor = { actorType: "user" as const, actorId: "policy-reviewer" };
    const connection = await service.createConnection(company.id, {
      name: "Custom reviewed endpoint", transport: "mcp_remote", enabled: true, status: "active",
      config: { sourceTemplateKey: "custom", url: RAILWAY_MCP_URL, quarantineNewEntries: true },
    }, actor);
    const initial = await service.refreshCatalog(connection.id, actor, { enableAllByDefault: true });
    expect(initial.catalog).toEqual([expect.objectContaining({ toolName: "redeploy", riskLevel: "destructive", status: "active" })]);
    tools = [...tools, { name: "provider_added_tool", annotations: { readOnlyHint: true } }];
    const refreshed = await service.refreshCatalog(connection.id, actor, { enableAllByDefault: true });
    expect(refreshed.catalog.find(tool => tool.toolName === "provider_added_tool")).toMatchObject({ riskLevel: "write", status: "quarantined" });
    expect(refreshed.connection.config.quarantineNewEntries).toBe(true);
    expect(refreshed.connection.config.sourceTemplateKey).toBe("custom");
    expect(request).toHaveBeenCalled();
  });

  it("detects a custom Connect Hub server from its catalog and quarantines hub_execute", async () => {
    const [company] = await db.insert(companies).values({ name: "Connect Hub detection fixture", issuePrefix: `CH${randomUUID().slice(0, 6)}` }).returning();
    let tools: McpToolDescriptor[] = [
      { name: "hub_list_connections", annotations: { readOnlyHint: true } },
      { name: "hub_connect", annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: "hub_execute", annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: "github__github_list_repos", annotations: { readOnlyHint: true } },
    ];
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      const rpc = JSON.parse(String(init.body));
      if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "connect-hub/test", version: "1" } } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
    });
    const service = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const actor = { actorType: "user" as const, actorId: "hub-reviewer" };
    const connection = await service.createConnection(company.id, {
      name: "GitHub (Connect Hub)", transport: "mcp_remote", enabled: true, status: "active",
      config: { url: "https://hub.example/mcp" },
    }, actor);
    const initial = await service.refreshCatalog(connection.id, actor, { enableAllByDefault: true });
    expect(initial.connection.config.sourceTemplateKey).toBe("connecthub");
    expect(initial.catalog.find(tool => tool.toolName === "hub_execute")).toMatchObject({ riskLevel: "destructive", status: "quarantined" });
    expect(initial.catalog.find(tool => tool.toolName === "hub_list_connections")).toMatchObject({ riskLevel: "read", status: "active" });
    expect(initial.catalog.find(tool => tool.toolName === "github__github_list_repos")).toMatchObject({ riskLevel: "read", status: "active" });
    // An unreviewed hub_execute stays quarantined on the next refresh.
    const again = await service.refreshCatalog(connection.id, actor, { enableAllByDefault: true });
    expect(again.catalog.find(tool => tool.toolName === "hub_execute")?.status).toBe("quarantined");

    // A provider template is never reclassified, and a catalog without both hub tools is not a hub.
    tools = [{ name: "hub_list_connections" }];
    const other = await service.createConnection(company.id, {
      name: "Not a hub", transport: "mcp_remote", enabled: true, status: "active", config: { url: "https://other.example/mcp" },
    }, actor);
    expect((await service.refreshCatalog(other.id, actor, { enableAllByDefault: true })).connection.config.sourceTemplateKey).toBeUndefined();
  });
});
