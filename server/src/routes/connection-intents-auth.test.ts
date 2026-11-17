import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/error-handler.js";
import { runtimeConnectionIntentRoutes, WRONG_TOKEN_MESSAGE } from "./connection-intents.js";

// The token check runs before any database access, so a rejected request never touches the db.
function app() {
  const server = express();
  server.use(express.json());
  server.use(runtimeConnectionIntentRoutes({} as never));
  server.use(errorHandler);
  return server;
}

describe("runtime tools token rejection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("tells a caller that sent its agent API key which token to use, still as a 401", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    const apiKey = createLocalAgentJwt("agent-1", "company-1", "opencode_local", "run-1", "user-1")!;
    for (const path of ["/runtime-tools/connections/search", "/mcp/runtime-tools"]) {
      const res = await request(app()).post(path).set("Authorization", `Bearer ${apiKey}`).send({ query: "linkedin" });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe(WRONG_TOKEN_MESSAGE);
      expect(JSON.stringify(res.body)).not.toContain(apiKey.split(".")[2]);
    }
  });

  it("keeps the generic message for every other rejection", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    const minted = createRuntimeToolsToken({ agentId: "agent-1", companyId: "company-1", runId: "run-1", responsibleUserId: "user-1" })!;
    for (const token of ["", "garbage", `${minted.token.slice(0, -1)}x`]) {
      const res = await request(app()).post("/runtime-tools/connections/search").set("Authorization", `Bearer ${token}`).send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Runtime tools token is missing, invalid, or expired");
    }
  });
});
