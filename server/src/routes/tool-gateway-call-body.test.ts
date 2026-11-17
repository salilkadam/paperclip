import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { toolCallBodyError, toolGatewayRoutes } from "./tool-gateway.js";

// The real router with a spy service: a rejected body must never reach executeTool.
function app() {
  const executeTool = vi.fn(async (input: { parameters: unknown }) => ({ status: "succeeded", parameters: input.parameters }));
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = { type: "none" }; next(); });
  server.use(toolGatewayRoutes({} as never, { executeTool } as never));
  return { server, executeTool };
}
const call = (server: express.Express, body: unknown) => request(server).post("/tool-gateway/tools/call")
  .set("x-paperclip-tool-gateway-token", "session-token").send(body as object);

describe("REST tools/call body", () => {
  it("rejects arguments sent under the MCP name instead of silently running the tool with {}", async () => {
    const { server, executeTool } = app();
    for (const key of ["arguments", "args", "input", "params"]) {
      const res = await call(server, { tool: "composio:multi-execute", [key]: { tools: [{ tool_slug: "X" }] } });
      expect(res.status).toBe(400);
      expect(res.body.reasonCode).toBe("invalid_tool_call_body");
      expect(res.body.error).toContain(`"${key}"`);
      expect(res.body.error).toContain('"parameters"');
    }
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects other unknown fields and non-object parameters", async () => {
    const { server, executeTool } = app();
    for (const body of [{ tool: "t", parameters: {}, extra: 1 }, { tool: "t", parameters: [] }, { tool: "t", parameters: "x" }, { tool: "t", parameters: null }]) {
      const res = await call(server, body);
      expect(res.status).toBe(400);
    }
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("passes a well-formed body through unchanged, and still allows omitting parameters", async () => {
    const { server, executeTool } = app();
    const ok = await call(server, { tool: "t", parameters: { tools: [{ tool_slug: "X" }] }, idempotencyKey: "k" });
    expect(ok.status).toBe(200);
    expect(executeTool.mock.calls[0]![0].parameters).toEqual({ tools: [{ tool_slug: "X" }] });
    const bare = await call(server, { tool: "t" });
    expect(bare.status).toBe(200);
    expect(executeTool.mock.calls[1]![0].parameters).toEqual({});
  });

  it("checks the session token before the body", async () => {
    const { server } = app();
    const res = await request(server).post("/tool-gateway/tools/call").send({ tool: "t", arguments: {} });
    expect(res.status).toBe(401);
  });

  it("bounds what an unknown key can echo back", () => {
    expect(toolCallBodyError({ tool: "t", ["k".repeat(5000)]: 1 })!.length).toBeLessThan(300);
  });
});
