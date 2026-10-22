import { describe, expect, it, vi } from "vitest";

import { LettaClient, LettaError, joinUrl, maskSecret } from "./client.js";

const TOKEN = "letta-test-token";
const BASE = "http://letta-server.letta.svc:8283";

function client(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof LettaClient>[0]> = {}) {
  return new LettaClient({
    baseUrl: `${BASE}/`,
    token: TOKEN,
    timeoutMs: 20000,
    fetchImpl,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Capture the (url, init) pairs a fetchImpl received. */
function callsOf(fetchImpl: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
  return (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
}

describe("joinUrl", () => {
  it("never doubles a slash and keeps a mounted subpath", () => {
    expect(joinUrl(`${BASE}/`, "/v1/agents/")).toBe(`${BASE}/v1/agents/`);
    expect(joinUrl("http://host/letta", "v1/blocks/abc")).toBe("http://host/letta/v1/blocks/abc");
  });
});

describe("maskSecret", () => {
  it("replaces every occurrence of the token", () => {
    expect(maskSecret(`bad token ${TOKEN} in "Bearer ${TOKEN}"`, TOKEN)).toBe('bad token [redacted] in "Bearer [redacted]"');
  });
});

describe("LettaClient.request", () => {
  it("sends the Bearer header, follows redirects, and wires a timeout signal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    await client(fetchImpl).ping();
    const [url, init] = callsOf(fetchImpl)[0]!;
    expect(url).toBe(`${BASE}/v1/agents/?limit=1`);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("follow");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("json-encodes POST bodies with a content-type", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ id: "passage-1", text: "t", tags: [], created_at: "2026-01-01T00:00:00Z" }]),
    ) as unknown as typeof fetch;
    await client(fetchImpl).insertArchivalMemory("agent-1", "hello", ["label:x"]);
    const [, init] = callsOf(fetchImpl)[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello", tags: ["label:x"] });
  });

  it("maps 401 to a token-check error without echoing credentials", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "Invalid password" }, 401)) as unknown as typeof fetch;
    const promise = client(fetchImpl).ping();
    await expect(promise).rejects.toThrow(LettaError);
    await expect(client(fetchImpl).ping()).rejects.toThrow(/check server\.token/i);
    await expect(client(fetchImpl).ping()).rejects.toMatchObject({ status: 401 });
  });

  it("surfaces the Letta detail on other failures, masking the token if it leaks", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ detail: `token ${TOKEN} rejected by policy` }, 500),
    ) as unknown as typeof fetch;
    await expect(client(fetchImpl).ping()).rejects.toThrow(/rejected by policy/);
    await expect(client(fetchImpl).ping()).rejects.toThrow(/\[redacted\]/);
    const error = await client(fetchImpl).ping().catch((item) => item);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("names the host on a transport failure and still masks", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect timeout, retry with ${TOKEN}`);
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).ping()).rejects.toThrow(/could not reach the Letta server at letta-server\.letta\.svc:8283/);
    await expect(client(fetchImpl).ping()).rejects.toThrow(/\[redacted\]/);
  });

  it("rejects a non-JSON success body", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(client(fetchImpl).ping()).rejects.toThrow(/non-JSON body/);
  });
});

describe("agent endpoints", () => {
  it("findAgentByName matches an exact name in the bare-array list", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { id: "agent-1", name: "other" },
        { id: "agent-2", name: "paperclip-org-memory-abc" },
      ]),
    ) as unknown as typeof fetch;
    const found = await client(fetchImpl).findAgentByName("paperclip-org-memory-abc");
    expect(found).toEqual({ id: "agent-2", name: "paperclip-org-memory-abc" });
    expect(callsOf(fetchImpl)[0]![0]).toContain("/v1/agents/?limit=500");
    expect(await client(fetchImpl).findAgentByName("missing")).toBeNull();
  });

  it("createMemoryAgent posts the block spec and model, and returns the block it requested", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: "agent-9",
        name: "pc",
        blocks: [{ id: "block-9", label: "org_profile", value: "", limit: 4000 }],
      }),
    ) as unknown as typeof fetch;
    const result = await client(fetchImpl).createMemoryAgent({
      name: "pc",
      blockLabel: "org_profile",
      blockLimit: 4000,
      model: "letta/letta-free",
      embeddingModel: "Qwen/Qwen3-Embedding-0.6B",
      embeddingEndpoint: "http://embed.svc:8000/v1",
      embeddingDim: 1024,
    });
    expect(result.agent).toEqual({ id: "agent-9", name: "pc" });
    expect(result.block.id).toBe("block-9");
    const body = JSON.parse(callsOf(fetchImpl)[0]![1]!.body as string);
    expect(body).toMatchObject({
      name: "pc",
      include_base_tools: false,
      model: "letta/letta-free",
      memory_blocks: [{ label: "org_profile", value: "", limit: 4000 }],
      embedding_config: {
        embedding_endpoint_type: "openai",
        embedding_endpoint: "http://embed.svc:8000/v1",
        embedding_model: "Qwen/Qwen3-Embedding-0.6B",
        embedding_dim: 1024,
      },
    });
  });

  it("omits embedding_config when the operator did not configure embeddings", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "agent-9", name: "pc", blocks: [{ id: "block-9", label: "org_profile", value: "", limit: 4000 }] }),
    ) as unknown as typeof fetch;
    await client(fetchImpl).createMemoryAgent({ name: "pc", blockLabel: "org_profile", blockLimit: 4000, model: "m" });
    const body = JSON.parse(callsOf(fetchImpl)[0]![1]!.body as string);
    expect(body.embedding_config).toBeUndefined();
    expect(body.embedding).toBeUndefined();
  });
});

describe("block and archival endpoints", () => {
  it("reads and patches blocks by id", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH") return jsonResponse({ id: "block-1", label: "org_profile", value: "new", limit: 4000 });
      return jsonResponse({ id: "block-1", label: "org_profile", value: "old", limit: 4000 });
    }) as unknown as typeof fetch;
    const c = client(fetchImpl);
    expect(await c.getBlock("block-1")).toEqual({ id: "block-1", label: "org_profile", value: "old", limit: 4000 });
    expect(await c.patchBlockValue("block-1", "new")).toMatchObject({ value: "new" });
    const [get, patch] = callsOf(fetchImpl);
    expect(get[0]).toBe(`${BASE}/v1/blocks/block-1`);
    expect(patch[1]!.method).toBe("PATCH");
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ value: "new" });
  });

  it("inserts archival memory and unwraps the passage from the array", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { id: "passage-7", text: "Priya owns billing", tags: ["label:people"], created_at: "2026-01-02T00:00:00Z" },
      ]),
    ) as unknown as typeof fetch;
    const passage = await client(fetchImpl).insertArchivalMemory("agent-1", "Priya owns billing", ["label:people"]);
    expect(passage).toEqual({
      id: "passage-7",
      text: "Priya owns billing",
      tags: ["label:people"],
      created_at: "2026-01-02T00:00:00Z",
    });
    expect(callsOf(fetchImpl)[0]![0]).toBe(`${BASE}/v1/agents/agent-1/archival-memory`);
  });

  it("searches with query and top_k encoded, and maps the results", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [{ id: "passage-1", timestamp: "2026-01-01T00:00:00Z", content: "text", tags: ["label:x"] }],
        count: 1,
      }),
    ) as unknown as typeof fetch;
    const results = await client(fetchImpl).searchArchivalMemory("agent 1", "who owns billing?", 20);
    expect(results).toEqual([{ id: "passage-1", timestamp: "2026-01-01T00:00:00Z", content: "text", tags: ["label:x"] }]);
    const url = new URL(callsOf(fetchImpl)[0]![0]);
    expect(url.searchParams.get("query")).toBe("who owns billing?");
    expect(url.searchParams.get("top_k")).toBe("20");
  });

  it("lists an agent's core blocks and attaches a block", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return jsonResponse([{ id: "block-2", label: "org_profile", value: "", limit: 4000 }]);
      return jsonResponse({ id: "agent-1" });
    }) as unknown as typeof fetch;
    const c = client(fetchImpl);
    expect(await c.listAgentBlocks("agent-1")).toEqual([{ id: "block-2", label: "org_profile", value: "", limit: 4000 }]);
    await c.attachBlockToAgent("agent-1", "block-3");
    expect(callsOf(fetchImpl)[1]![0]).toBe(`${BASE}/v1/agents/agent-1/core-memory/blocks/attach/block-3`);
    expect(callsOf(fetchImpl)[1]![1]!.method).toBe("PATCH");
  });

  it("propagates a 404 with its status for stale-mapping recovery", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "Block with id 'block-x' not found" }, 404)) as unknown as typeof fetch;
    await expect(client(fetchImpl).getBlock("block-x")).rejects.toMatchObject({ status: 404 });
    await expect(client(fetchImpl).getBlock("block-x")).rejects.toThrow(/not found/);
  });
});
