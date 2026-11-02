import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, connectionGrants, createDb, toolApplications, toolCatalogEntries, toolConnections, toolConnectionAppSnapshots } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { isComposioConnection } from "../services/connectors/composio-guard.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const HUB = "https://hub.example";

describe("Connect Hub is not a Composio connection", () => {
  it("never applies the Composio community-write guard to a hub server", () => {
    expect(isComposioConnection({ config: { sourceTemplateKey: "connecthub", url: `${HUB}/mcp` } })).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Connect Hub database tests unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("Connect Hub app aggregator", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-connect-hub-");
    db = createDb(database.connectionString); cleanup = database.cleanup;
  }, 90_000);
  afterAll(async () => { await cleanup?.(); });

  async function fixture(options: { connectUrl?: string; connectError?: boolean } = {}) {
    const [company] = await db.insert(companies).values({ name: "Connect Hub test", issuePrefix: randomUUID().slice(0, 6).toUpperCase() }).returning();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "admin", status: "active" });
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "Connect Hub", type: "mcp_http", metadata: { sourceTemplateKey: "connecthub" } }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, uid: randomUUID(), name: "Hub", transport: "mcp_remote", authKind: "none", credentialPolicy: "shared", status: "active", enabled: true,
      config: { sourceTemplateKey: "connecthub", connectionMethodKey: "mcp", url: `${HUB}/mcp` } }).returning();
    await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, kind: "organization", status: "active", isDefault: true });
    const names = ["hub_list_connections", "hub_connect", "hub_list_options", "github__github_list_repos"];
    await db.insert(toolCatalogEntries).values(names.map(toolName => ({ companyId: company.id, connectionId: connection.id, name: toolName, toolName, versionHash: "v1", status: "active", riskLevel: "read" as const })));
    let connected: Record<string, unknown>[] = [];
    let fail = false;
    const calls: { name?: string; args?: unknown }[] = [];
    const text = (id: unknown, value: unknown) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
    const remoteHttpRequest = async (_url: string | URL, init: RequestInit) => {
      const rpc = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ name: rpc?.params?.name, args: rpc?.params?.arguments });
      if (rpc?.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: names.map(name => ({ name, inputSchema: { type: "object" } })) } });
      if (fail) return new Response("upstream error with private token", { status: 401 });
      if (rpc?.params?.name === "hub_list_connections") return text(rpc.id, { connected, available_toolkits: ["github", "google-drive"] });
      if (rpc?.params?.name === "hub_connect" && options.connectError) return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "Toolkit is not on this MCP server" }) }] } });
      if (rpc?.params?.name === "hub_connect") return text(rpc.id, { connect_url: options.connectUrl ?? `${HUB}/connect/ln_1?sig=abc`, expires_at: "2026-11-02T12:00:00.000Z" });
      return new Response("unexpected", { status: 500 });
    };
    const access = toolAccessService(db, { remoteHttpRequest });
    return { company, connection, actor: { actorType: "user" as const, actorId: userId }, access, calls, remoteHttpRequest,
      connect: () => { connected = [{ id: "ca_1", toolkit: "github", status: "ACTIVE", identifier: "octocat", access_token: "never-stored" }]; },
      fail: () => { fail = true; } };
  }
  async function sync(f: Awaited<ReturnType<typeof fixture>>) {
    await f.access.syncAggregatorApps(f.connection.id, true, f.actor);
    let result = await f.access.listAggregatorApps(f.connection.id, f.actor);
    await vi.waitFor(async () => { result = await f.access.listAggregatorApps(f.connection.id, f.actor); expect(result.sync.status).not.toBe("syncing"); }, { timeout: 5000 });
    return result;
  }

  it("lists every hub toolkit as an app and marks ACTIVE accounts connected, without storing credentials", async () => {
    const f = await fixture();
    f.connect();
    const result = await sync(f);
    expect(result.provider).toBe("connecthub");
    expect(result.discovery.availability).toBe("available");
    expect(result.sync.coverage).toBe("gateway_tools");
    const github = result.apps.find(app => app.toolkit === "github");
    expect(github).toMatchObject({ provider: "connecthub", appSlug: "github", status: "connected" });
    expect(github?.accounts[0]).toMatchObject({ id: "ca_1", alias: "octocat", status: "ACTIVE", managementUrl: `${HUB}/dashboard` });
    expect(result.apps.find(app => app.toolkit === "google-drive")).toMatchObject({ status: "not_connected", accounts: [] });
    expect(f.calls.filter(call => call.name === "hub_list_connections")).toHaveLength(1);
    const rows = await db.select().from(toolConnectionAppSnapshots).where(eq(toolConnectionAppSnapshots.connectionId, f.connection.id));
    expect(JSON.stringify(rows)).not.toContain("never-stored");
  });

  it("surfaces a failed hub read as an error and keeps stale observations", async () => {
    const f = await fixture();
    f.connect(); await sync(f); f.fail();
    const result = await sync(f);
    expect(result.sync.status).toBe("error");
    expect(result.apps.find(app => app.toolkit === "github")?.accounts).toHaveLength(1);
    expect(result.apps.every(app => app.freshness === "stale")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private token");
  });

  it("reports discovery unavailable when the catalog lacks hub_list_connections", async () => {
    const f = await fixture();
    await db.update(toolCatalogEntries).set({ status: "inactive" }).where(eq(toolCatalogEntries.connectionId, f.connection.id));
    expect((await f.access.syncAggregatorApps(f.connection.id, true, f.actor)).discovery.availability).toBe("unsupported");
    expect(f.calls).toHaveLength(0);
  });

  it("starts a connect handoff with hub_connect and returns the hub's own link", async () => {
    const f = await fixture();
    const result = await f.access.setupAggregatorApp(f.connection.id, "google-drive", { action: "start" }, f.actor);
    expect(result).toEqual({ status: "authorization_required", authorizationUrl: `${HUB}/connect/ln_1?sig=abc` });
    expect(f.calls.find(call => call.name === "hub_connect")?.args).toEqual({ toolkit: "google-drive" });
    await expect(f.access.setupAggregatorApp(f.connection.id, "google-drive", { action: "complete" }, f.actor)).rejects.toMatchObject({ status: 409 });
    f.connect();
    expect(await f.access.setupAggregatorApp(f.connection.id, "github", { action: "complete" }, f.actor)).toEqual({ status: "connected" });
    expect(await f.access.setupAggregatorApp(f.connection.id, "github", { action: "start" }, f.actor)).toEqual({ status: "connected" });
    await expect(f.access.setupAggregatorApp(f.connection.id, "slack", { action: "start" }, f.actor)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a hub_connect link on a foreign host", async () => {
    const f = await fixture({ connectUrl: "https://attacker.example/connect/ln_1?sig=abc" });
    await expect(f.access.setupAggregatorApp(f.connection.id, "github", { action: "start" }, f.actor)).rejects.toMatchObject({ status: 422 });
  });

  it("surfaces failed hub reads and failed hub_connect calls as errors, never as an empty result", async () => {
    const failing = await fixture();
    failing.fail();
    await expect(failing.access.setupAggregatorApp(failing.connection.id, "github", { action: "start" }, failing.actor)).rejects.toMatchObject({ status: 502 });
    const refused = await fixture({ connectError: true });
    await expect(refused.access.setupAggregatorApp(refused.connection.id, "github", { action: "start" }, refused.actor)).rejects.toMatchObject({ status: 422 });
    expect(refused.calls.filter(call => call.name === "hub_connect")).toHaveLength(1);
  });

  it("exposes app setup only to connection managers", async () => {
    const f = await fixture();
    const app = express(); app.use(express.json());
    let viewingUser = randomUUID();
    let memberCompanies: string[] = [];
    app.use((req, _res, next) => { req.actor = { type: "board", userId: viewingUser, source: "session", isInstanceAdmin: false, companyIds: viewingUser === f.actor.actorId ? [f.company.id] : memberCompanies }; next(); });
    app.use("/api", toolAccessRoutes(db, { remoteHttpRequest: f.remoteHttpRequest })); app.use(errorHandler);
    const endpoint = `/api/tool-connections/${f.connection.id}/aggregator/apps/github/setup`;
    expect([403, 404]).toContain((await request(app).post(endpoint).send({ action: "start" })).status);
    expect(f.calls.some(call => call.name === "hub_connect")).toBe(false);
    // A company member without tools:manage_connections is refused by the manager gate itself.
    const memberId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: memberId, membershipRole: "member", status: "active" });
    viewingUser = memberId;
    memberCompanies = [f.company.id];
    expect((await request(app).post(endpoint).send({ action: "start" })).status).toBe(403);
    expect(f.calls.some(call => call.name === "hub_connect")).toBe(false);
    memberCompanies = [];
    viewingUser = f.actor.actorId;
    await request(app).post(endpoint).send({ action: "bogus" }).expect(400);
    const response = await request(app).post(endpoint).send({ action: "start" }).expect(200);
    expect(response.body).toEqual({ status: "authorization_required", authorizationUrl: `${HUB}/connect/ln_1?sig=abc` });
  });
});
