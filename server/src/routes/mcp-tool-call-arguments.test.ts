import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { mcpGatewayProtocolRoutes, mcpToolCallArgumentsError } from "./tool-gateway.js";
import { publicMcpIngressRoutes } from "./public-mcp.js";

describe("MCP tools/call arguments guard", () => {
  it("accepts absent or object arguments and other MCP params keys", () => {
    expect(mcpToolCallArgumentsError({ name: "t" })).toBeNull();
    expect(mcpToolCallArgumentsError({ name: "t", arguments: { a: 1 }, _meta: {}, task: {} })).toBeNull();
  });
  it("rejects non-object arguments and misnamed argument keys", () => {
    for (const bad of [[], "x", null, 1]) expect(mcpToolCallArgumentsError({ name: "t", arguments: bad })).toMatch(/must be a JSON object/);
    for (const key of ["args", "parameters", "input"]) expect(mcpToolCallArgumentsError({ name: "t", [key]: { a: 1 } })).toContain(`params.${key}`);
  });
});

describe("named MCP gateway tools/call", () => {
  it("never executes a call whose arguments were misnamed or malformed", async () => {
    const executeTool = vi.fn(async () => ({ status: "succeeded", result: { data: {} } }));
    const server = express(); server.use(express.json()); server.use(mcpGatewayProtocolRoutes({ executeTool } as never));
    for (const params of [{ name: "composio:multi", args: { tools: [] } }, { name: "composio:multi", arguments: [] }]) {
      const res = await request(server).post("/mcp/gateways/gw1").set("Authorization", "Bearer t")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32602);
    }
    expect(executeTool).not.toHaveBeenCalled();
    const ok = await request(server).post("/mcp/gateways/gw1").set("Authorization", "Bearer t")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "composio:multi", arguments: { tools: [] } } });
    expect(ok.status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ parameters: { tools: [] } }));
  });
});

describe("public MCP tools/call", () => {
  function app() {
    const execute = vi.fn(async () => ({ outcome: "succeeded" }));
    const oauth = { config: { origin: "http://localhost", resource: "http://localhost/mcp" }, authenticate: vi.fn(async () => ({ userId: "u" })), assertEnabled: vi.fn(async () => {}) };
    const server = express(); server.use(express.json());
    server.use(publicMcpIngressRoutes(oauth as never, execute as never));
    return { server, execute };
  }
  it("rejects a misnamed key on the legacy transport before the SDK strips it", async () => {
    const { server, execute } = app();
    const res = await request(server).post("/mcp").set("Authorization", "Bearer t").set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "paperclip_create_issue", args: { title: "x" } } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("params.args");
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects a misnamed key on the 2026-07-28 envelope", async () => {
    const { server, execute } = app();
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    const res = await request(server).post("/mcp").set("Authorization", "Bearer t")
      .set("mcp-protocol-version", "2026-07-28").set("mcp-method", "tools/call").set("mcp-name", "paperclip_create_issue")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "paperclip_create_issue", input: { title: "x" }, _meta: meta } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("params.input");
    expect(execute).not.toHaveBeenCalled();
  });
});
