import { describe, expect, it } from "vitest";

import { ConfigError, agentNameForCompany, parseConfig } from "./config.js";

const COMPANY_A = "62d63984-df6c-49be-981c-1273f68a451c";
const SECRET_ID = "5f4c2a1b-9d3e-4f60-8b2a-1c7d5e9a0b3f";

function minimalConfig() {
  return {
    server: { url: "http://letta-server.letta.svc:8283", token: "letta-test-token" },
  };
}

describe("parseConfig", () => {
  it("fills in the defaults an operator should not have to type", () => {
    const config = parseConfig(minimalConfig());
    expect(config.server).toMatchObject({
      url: "http://letta-server.letta.svc:8283",
      token: "letta-test-token",
      requestTimeoutMs: 20000,
    });
    expect(config.memory).toMatchObject({
      orgBlockLabel: "org_profile",
      profileLimit: 4000,
      archivalLimit: 20,
      agentNameTemplate: "paperclip-org-memory-{companyId}",
      agentModel: "letta/letta-free",
      embeddingModel: undefined,
      embeddingDim: undefined,
    });
  });

  it("normalizes the server URL so joins never double a slash", () => {
    expect(parseConfig({ server: { url: "https://letta.baisoln.com///", token: "t" } }).server.url).toBe("https://letta.baisoln.com");
    expect(parseConfig({ server: { url: " http://host:8283/letta ", token: "t" } }).server.url).toBe("http://host:8283/letta");
  });

  it("accepts a saved-secret binding in place of a pasted token", () => {
    const raw = minimalConfig();
    raw.server.token = { type: "secret_ref", secretId: SECRET_ID, version: "latest" } as never;
    const config = parseConfig(raw);
    expect(config.server.token).toMatchObject({ type: "secret_ref", secretId: SECRET_ID });
  });

  it("reports every problem at once instead of one per save", () => {
    const raw = {
      server: { url: "not-a-url", token: "", requestTimeoutMs: 5 },
      memory: { orgBlockLabel: "Bad Label", profileLimit: 10, archivalLimit: 100, agentNameTemplate: "paperclip-memory" },
    };
    let message = "";
    try {
      parseConfig(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    for (const expected of [
      'server.url "not-a-url" is not a valid http(s) URL',
      "server.token is required",
      "server.requestTimeoutMs must be an integer between 1000 and 300000",
      "memory.orgBlockLabel must be a lowercase slug",
      "memory.profileLimit must be an integer between 200 and 100000",
      "memory.archivalLimit must be an integer between 1 and 50",
      'memory.agentNameTemplate must contain "{companyId}"',
    ]) {
      expect(message).toContain(expected);
    }
    // One save names every defect, so the operator fixes them in one pass.
    expect(message.split("\n- ").length).toBeGreaterThan(6);
  });

  it("rejects non-http schemes and query strings on the server URL", () => {
    expect(() => parseConfig({ server: { url: "ftp://letta.example", token: "t" } })).toThrow(/must be an http\(s\) URL/);
    expect(() => parseConfig({ server: { url: "http://letta.example/?admin=1", token: "t" } })).toThrow(/query string/);
  });

  it("requires a token, and refuses a binding object without a secret id", () => {
    expect(() => parseConfig({ server: { url: "http://h:8283" } })).toThrow(/server.token is required/);
    expect(() => parseConfig({ server: { url: "http://h:8283", token: { type: "secret_ref" } } })).toThrow(/without a secret id/);
  });

  it("keeps embedding overrides paired, with a sensible default dimension", () => {
    expect(() =>
      parseConfig({ server: minimalConfig().server, memory: { embeddingModel: "Qwen/Qwen3-Embedding-0.6B" } }),
    ).toThrow(/must be set together/);
    const config = parseConfig({
      server: minimalConfig().server,
      memory: { embeddingModel: "Qwen/Qwen3-Embedding-0.6B", embeddingEndpoint: "http://embed.svc:8000/v1" },
    });
    expect(config.memory.embeddingDim).toBe(1024);
    expect(config.memory.embeddingEndpoint).toBe("http://embed.svc:8000/v1");
  });
});

describe("agentNameForCompany", () => {
  it("substitutes the full company uuid into the template", () => {
    const config = parseConfig(minimalConfig());
    expect(agentNameForCompany(config, COMPANY_A)).toBe(`paperclip-org-memory-${COMPANY_A}`);
  });

  it("honours a custom template and lowercases the result", () => {
    const config = parseConfig({ ...minimalConfig(), memory: { agentNameTemplate: "Acme-Memory-{companyId}" } });
    expect(agentNameForCompany(config, COMPANY_A)).toBe(`acme-memory-${COMPANY_A}`);
  });
});
