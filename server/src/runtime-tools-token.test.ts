import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeToolsToken, explainRuntimeToolsTokenFailure, verifyRuntimeToolsToken } from "./runtime-tools-token.js";

describe("runtime connection tools token", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("binds the token to company, agent, run, responsible user, and scope", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const minted = createRuntimeToolsToken({
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      responsibleUserId: "user-1",
    });
    expect(minted).not.toBeNull();
    expect(verifyRuntimeToolsToken(minted!.token)).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
      responsible_user_id: "user-1",
      scope: "connection_intents",
    });
  });

  it("rejects tampering and expiry", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const minted = createRuntimeToolsToken({
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      responsibleUserId: "user-1",
    })!;
    expect(verifyRuntimeToolsToken(`${minted.token.slice(0, -1)}x`)).toBeNull();
    vi.setSystemTime(new Date("2026-08-26T13:00:01.000Z"));
    expect(verifyRuntimeToolsToken(minted.token)).toBeNull();
  });

  it("explains each rejection without exposing the token", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-tools-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const minted = createRuntimeToolsToken({ agentId: "agent-1", companyId: "company-1", runId: "run-1", responsibleUserId: "user-1" })!;
    expect(explainRuntimeToolsTokenFailure(minted.token)).toEqual({ reason: null, length: minted.token.length, runId: "run-1" });
    expect(explainRuntimeToolsTokenFailure("").reason).toBe("empty");
    expect(explainRuntimeToolsTokenFailure("abc").reason).toBe("not_jwt");
    expect(explainRuntimeToolsTokenFailure("a.b.c").reason).toBe("unparseable");
    expect(explainRuntimeToolsTokenFailure(`${minted.token.slice(0, -1)}x`).reason).toBe("bad_signature");
    expect(explainRuntimeToolsTokenFailure(minted.token, "github_credentials").reason).toBe("scope_mismatch");
    vi.setSystemTime(new Date("2026-08-26T13:00:05.000Z"));
    expect(explainRuntimeToolsTokenFailure(minted.token)).toMatchObject({ reason: "expired", runId: "run-1", expiredSecondsAgo: 5 });
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "a-different-secret");
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    expect(explainRuntimeToolsTokenFailure(minted.token).reason).toBe("bad_signature");
    // Structures verify rejects without throwing must not throw here either (a 401 must stay a 401).
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    for (const t of [`${b64({ alg: "none" })}.${b64(null)}.x`, `${b64(null)}.${b64({ run_id: "r" })}.x`, `${b64([])}.${b64("s")}.x`]) {
      expect(verifyRuntimeToolsToken(t)).toBeNull();
      expect(explainRuntimeToolsTokenFailure(t).reason).toBe("unparseable");
    }
    const longRun = `${b64({ alg: "HS256" })}.${b64({ run_id: "x".repeat(5000) })}.x`;
    expect(explainRuntimeToolsTokenFailure(longRun).runId).toHaveLength(64);
    const result = explainRuntimeToolsTokenFailure(minted.token);
    expect(JSON.stringify(result)).not.toContain(minted.token.split(".")[2]);
  });
});
