/**
 * Worker tests: real tool handlers against a scripted in-memory Letta server
 * and a fake Paperclip host.
 *
 * The host double is deliberately strict about the three things that matter
 * operationally — nothing secret reaches state, activity, or logs; a company's
 * Letta agent is created exactly once even across repeated tool calls; and a
 * mapping whose agent was deleted on the Letta side recovers instead of
 * leaking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PluginActivityLogEntry,
  PluginContext,
  PluginStateScopeKey,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";

const COMPANY_A = "62d63984-df6c-49be-981c-1273f68a451c";
const COMPANY_B = "370325c2-a341-47fe-9ae2-bce9b5dd446f";
const AGENT_CEO = "73cae9f9-b419-48f1-b395-7e7e8c41048d";
const SECRET_ID = "5f4c2a1b-9d3e-4f60-8b2a-1c7d5e9a0b3f";
const TOKEN = "letta-test-token";

type Handler = (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;

function stateKey(key: PluginStateScopeKey): string {
  return JSON.stringify([key.scopeKind, key.scopeId ?? "", key.namespace ?? "", key.stateKey]);
}

function runContext(companyId = COMPANY_A, agentId = AGENT_CEO): ToolRunContext {
  return { runId: "run-1", companyId, agentId, issueId: null, projectId: null } as unknown as ToolRunContext;
}

// ---------------------------------------------------------------------------
// Scripted Letta server (shapes verified live on Letta 0.16.7)
// ---------------------------------------------------------------------------

interface FakeAgent {
  id: string;
  name: string;
  blockIds: string[];
}

class FakeLetta {
  token = TOKEN;
  agents: FakeAgent[] = [];
  blocks: Record<string, { id: string; label: string; value: string; limit: number; agentId?: string }> = {};
  passages: { agentId: string; id: string; text: string; tags: string[]; created_at: string }[] = [];
  createAgentCount = 0;
  createBlockCount = 0;
  /** Force the archival insert to fail like the live server's 500. */
  failInsert = false;
  private nAgents = 0;
  private nBlocks = 0;
  private nPassages = 0;

  fetch = async (url: string, init: RequestInit): Promise<Response> => this.handle(url, init);

  /** Pre-seed an existing agent the way a prior install would have left one. */
  seedAgent(name: string): FakeAgent {
    const agent = this.createAgent({ name, memory_blocks: [{ label: "org_profile", value: "", limit: 4000 }] });
    this.createAgentCount = 0; // seeding is not a live creation
    return agent;
  }

  private createAgent(body: Record<string, unknown>): FakeAgent {
    const id = `agent-${++this.nAgents}`;
    const blockIds: string[] = [];
    for (const mb of (body.memory_blocks as Record<string, unknown>[] | null) ?? []) {
      const bid = `block-${++this.nBlocks}`;
      this.blocks[bid] = { id: bid, label: String(mb.label), value: String(mb.value ?? ""), limit: Number(mb.limit ?? 100000), agentId: id };
      blockIds.push(bid);
    }
    const agent = { id, name: String(body.name), blockIds };
    this.agents.push(agent);
    return agent;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private handle(url: string, init: RequestInit): Response {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const auth = (init.headers as Record<string, string> | undefined)?.authorization;
    if (auth !== `Bearer ${this.token}`) return this.json(401, { detail: "Invalid password" });

    const rest = u.pathname.replace(/^\/v1/, "");

    if (rest === "/agents/" || rest === "/agents") {
      if (method === "GET") return this.json(200, this.agents.map((a) => ({ id: a.id, name: a.name, model: "letta/letta-free" })));
      if (method === "POST") {
        if (!body?.model) return this.json(422, { detail: "INVALID_ARGUMENT: Must specify either model or llm_config in request" });
        this.createAgentCount += 1;
        const agent = this.createAgent(body);
        return this.json(200, { id: agent.id, name: agent.name, blocks: agent.blockIds.map((id) => this.blocks[id]) });
      }
    }

    if (rest === "/blocks/") {
      if (method === "POST") {
        this.createBlockCount += 1;
        const id = `block-${++this.nBlocks}`;
        this.blocks[id] = { id, label: String(body?.label ?? ""), value: String(body?.value ?? ""), limit: Number(body?.limit ?? 100000) };
        return this.json(200, this.blocks[id]);
      }
    }

    if (rest.startsWith("/blocks/")) {
      const id = rest.slice("/blocks/".length).replace(/\/+$/, "");
      const block = this.blocks[id];
      if (!block) return this.json(404, { detail: `Block with id '${id}' not found` });
      if (method === "GET") return this.json(200, block);
      if (method === "PATCH" && typeof body?.value === "string") {
        block.value = body.value;
        return this.json(200, block);
      }
    }

    const agentScoped = /^\/agents\/([^/]+)\/(.+)$/.exec(rest);
    if (agentScoped) {
      const agent = this.agents.find((item) => item.id === agentScoped[1]);
      const tail = agentScoped[2];
      if (!agent) return this.json(404, { detail: `Agent with ID ${agentScoped[1]} not found` });

      if (tail === "archival-memory" && method === "POST") {
        if (this.failInsert) return this.json(500, { detail: "An unknown error occurred" });
        const passage = {
          agentId: agent.id,
          id: `passage-${++this.nPassages}`,
          text: String(body?.text ?? ""),
          tags: Array.isArray(body?.tags) ? (body.tags as string[]) : [],
          created_at: "2026-10-21T00:00:00Z",
        };
        this.passages.push(passage);
        return this.json(200, [passage]);
      }

      if (tail === "archival-memory/search" && method === "GET") {
        const query = (u.searchParams.get("query") ?? "").toLowerCase();
        const topK = Number(u.searchParams.get("top_k") ?? 10);
        const words = query.split(/[^\w]+/).filter(Boolean);
        const scored = this.passages
          .filter((p) => p.agentId === agent.id)
          .map((p) => ({ p, score: words.filter((w) => p.text.toLowerCase().includes(w)).length }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        return this.json(200, {
          results: scored.map((item) => ({ id: item.p.id, timestamp: item.p.created_at, content: item.p.text, tags: item.p.tags })),
          count: scored.length,
        });
      }

      if (tail === "core-memory/blocks" && method === "GET") {
        return this.json(200, agent.blockIds.map((id) => this.blocks[id]));
      }

      const attach = /^core-memory\/blocks\/attach\/([^/]+)$/.exec(tail);
      if (attach && method === "PATCH") {
        const block = this.blocks[attach[1]];
        if (!block) return this.json(404, { detail: "Block not found" });
        block.agentId = agent.id;
        agent.blockIds.push(block.id);
        return this.json(200, { id: agent.id });
      }

      const byLabel = /^core-memory\/blocks\/([^/]+)$/.exec(tail);
      if (byLabel && method === "PATCH") {
        const block = agent.blockIds.map((id) => this.blocks[id]).find((b) => b.label === byLabel[1]);
        if (!block) return this.json(404, { detail: `No block with label ${byLabel[1]}` });
        if (typeof body?.value === "string") block.value = body.value;
        return this.json(200, block);
      }
    }

    return this.json(404, { detail: `no route ${method} ${rest}` });
  }
}

// ---------------------------------------------------------------------------
// Fake Paperclip host
// ---------------------------------------------------------------------------

interface WorkerOptions {
  companies?: Array<{ id: string; name: string }>;
  configs?: Record<string, Record<string, unknown>>;
  resolvedToken?: string;
}

function makeWorkerContext(options: WorkerOptions = {}) {
  const companies = options.companies ?? [{ id: COMPANY_A, name: "Bionic" }];
  const configs = options.configs ?? {};
  const state = new Map<string, unknown>();
  const tools = new Map<string, Handler>();
  const activity: PluginActivityLogEntry[] = [];
  const reconciled: string[] = [];
  const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    manifest: { id: "paperclip.loc-letta" },
    logger: logs,
    config: {
      get: async (companyId?: string) => structuredClone(configs[companyId ?? ""] ?? {}),
    },
    secrets: {
      resolve: async () => options.resolvedToken ?? TOKEN,
    },
    state: {
      get: async (key: PluginStateScopeKey) => state.get(stateKey(key)) ?? null,
      set: async (key: PluginStateScopeKey, value: unknown) => {
        state.set(stateKey(key), value);
      },
      delete: async (key: PluginStateScopeKey) => {
        state.delete(stateKey(key));
      },
    },
    entities: { upsert: async () => ({ id: "entity-1" }), list: async () => [] },
    events: { on: vi.fn(), subscribe: vi.fn(), emit: async () => undefined },
    activity: {
      log: async (entry: PluginActivityLogEntry) => {
        activity.push(entry);
      },
    },
    skills: {
      managed: {
        get: async () => ({}),
        reconcile: async (_key: string, companyId: string) => {
          reconciled.push(companyId);
          return { skillKey: "loc-letta-org-memory" };
        },
        reset: async () => ({}),
      },
    },
    companies: {
      list: async () => companies,
      get: async (companyId: string) => companies.find((company) => company.id === companyId) ?? null,
    },
    tools: {
      register: (name: string, _declaration: unknown, fn: Handler) => {
        if (tools.has(name)) throw new Error(`duplicate tool registration for ${name}`);
        tools.set(name, fn);
      },
    },
    jobs: { register: vi.fn() },
    http: { fetch: async () => new Response("{}", { status: 200 }) },
  };

  return {
    ctx: ctx as unknown as PluginContext,
    tools,
    state,
    activity,
    reconciled,
    logs,
  };
}

function defaultConfig(overrides: Record<string, unknown> = {}) {
  return {
    server: { url: "http://letta.test:8283", token: TOKEN },
    memory: overrides,
  };
}

/** Fresh worker module instance, so module-level caches cannot leak between tests. */
async function newWorker(options: WorkerOptions = {}) {
  vi.resetModules();
  const [{ default: plugin }, manifestModule] = await Promise.all([import("./plugin.js"), import("./manifest.js")]);
  const env = makeWorkerContext(options);
  env.ctx.manifest = manifestModule.default as unknown as PluginContext["manifest"];
  await plugin.definition.setup(env.ctx);
  return {
    plugin,
    manifest: manifestModule.default,
    env,
    call: (name: string, params: unknown, runCtx: ToolRunContext = runContext()) => {
      const handler = env.tools.get(name);
      if (!handler) throw new Error(`tool "${name}" is not registered`);
      return handler(params, runCtx);
    },
  };
}

describe("registration", () => {
  it("registers the four manifest tools, nothing more", async () => {
    const worker = await newWorker();
    expect([...worker.env.tools.keys()].sort()).toEqual(["read_profile", "recall", "remember", "update_profile"]);
    expect(worker.manifest.id).toBe("paperclip.loc-letta");
  });
});

describe("remember", () => {
  let fake: FakeLetta;
  let worker: Awaited<ReturnType<typeof newWorker>>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function withLetta() {
    fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    worker = await newWorker({ configs: { [COMPANY_A]: defaultConfig() } });
  }

  it("refuses invalid params before touching the network", async () => {
    await withLetta();
    expect((await worker.call("remember", {})).error).toMatch(/`text` is required/);
    expect((await worker.call("remember", { text: "x".repeat(20001) })).error).toMatch(/too long/);
    expect((await worker.call("remember", { text: "ok", label: "Bad Label" })).error).toMatch(/lowercase slug/);
    expect(fake.agents).toHaveLength(0);
  });

  it("creates the company agent once, remembers, and persists the mapping", async () => {
    await withLetta();
    const result = (await worker.call("remember", { text: "Priya owns the billing platform", label: "people" })) as { content?: string; data?: unknown; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/passage-1/);
    expect(result.content).toMatch(/label "people"/);

    // One Letta agent, named by the template, with the configured block label.
    expect(fake.createAgentCount).toBe(1);
    expect(fake.agents).toHaveLength(1);
    expect(fake.agents[0]!.name).toBe(`paperclip-org-memory-${COMPANY_A}`);
    expect(Object.values(fake.blocks)[0]!.label).toBe("org_profile");

    // Provenance rides in tags: label, paperclip agent, run, timestamp.
    expect(fake.passages[0]!.text).toBe("Priya owns the billing platform");
    expect(fake.passages[0]!.tags).toContain("label:people");
    expect(fake.passages[0]!.tags).toContain(`paperclip-agent:${AGENT_CEO}`);
    expect(fake.passages[0]!.tags).toContain("paperclip-run:run-1");
    expect(fake.passages[0]!.tags.some((t) => t.startsWith("paperclip-timestamp:"))).toBe(true);

    // The mapping is persisted in company-scoped state.
    const mapping = worker.env.state.get(stateKey({ scopeKind: "company", scopeId: COMPANY_A, namespace: "loc-letta", stateKey: `letta-agent:${COMPANY_A}` })) as Record<string, string>;
    expect(mapping.agentId).toBe(fake.agents[0]!.id);
    expect(mapping.blockId).toBe(fake.agents[0]!.blockIds[0]);

    // Activity recorded; skill reconciled.
    expect(worker.env.activity[0]!.message).toMatch(/Remembered org fact/);
    expect(worker.env.reconciled).toEqual([COMPANY_A]);
  });

  it("is idempotent: the agent is not re-created on later calls", async () => {
    await withLetta();
    await worker.call("remember", { text: "first fact", label: "facts" });
    await worker.call("remember", { text: "second fact", label: "facts" });
    expect(fake.createAgentCount).toBe(1);
    expect(fake.agents).toHaveLength(1);
    expect(fake.passages).toHaveLength(2);
    // The second call skipped the discovery list and went straight to the insert.
    const inserts = fake.passages;
    expect(inserts.map((p) => p.text)).toEqual(["first fact", "second fact"]);
  });

  it("does not duplicate an agent that already exists by name when state was lost", async () => {
    fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    fake.seedAgent(`paperclip-org-memory-${COMPANY_A}`);
    worker = await newWorker({ configs: { [COMPANY_A]: defaultConfig() } });
    const result = (await worker.call("remember", { text: "fact" })) as { error?: string };
    expect(result.error).toBeUndefined();
    expect(fake.agents).toHaveLength(1);
    expect(fake.createAgentCount).toBe(0);
  });

  it("never lets the token reach state, activity, or logs", async () => {
    await withLetta();
    await worker.call("remember", { text: "a fact" });
    const everything = JSON.stringify([...worker.env.state.entries(), worker.env.activity, worker.env.logs.info.mock.calls, worker.env.logs.warn.mock.calls, worker.env.logs.error.mock.calls]);
    expect(everything).not.toContain(TOKEN);
  });

  it("surfaces a refused token as a check-the-token error", async () => {
    await withLetta();
    fake.token = "some-other-token";
    const result = (await worker.call("remember", { text: "a fact" })) as { error?: string };
    expect(result.error).toMatch(/Letta error/);
    expect(result.error).toMatch(/server\.token/);
  });

  it("surfaces a server-side 500 with the Letta detail", async () => {
    await withLetta();
    fake.failInsert = true;
    const result = (await worker.call("remember", { text: "a fact" })) as { error?: string };
    expect(result.error).toMatch(/HTTP 500/);
    expect(result.error).toMatch(/An unknown error occurred/);
  });
});

describe("recall", () => {
  let fake: FakeLetta;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function withLetta(memoryOverrides: Record<string, unknown> = {}) {
    fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    const worker = await newWorker({ configs: { [COMPANY_A]: defaultConfig(memoryOverrides) } });
    return worker;
  }

  it("returns ranked matches with labels and ids", async () => {
    const worker = await withLetta();
    await worker.call("remember", { text: "Priya owns the billing platform", label: "people" });
    await worker.call("remember", { text: "We chose Rust for new services in Q3", label: "decisions" });

    const result = (await worker.call("recall", { query: "billing" })) as { content?: string; data?: unknown; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/Org memory matches for "billing"/);
    expect(result.content).toMatch(/\[people\]/);
    expect(result.content).toMatch(/passage-1/);
    const data = result.data as { matches: Array<{ rank: number; label: string }> };
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ rank: 1, label: "people" });
  });

  it("caps results at the configured archival limit and honours the limit param", async () => {
    const worker = await withLetta({ archivalLimit: 2 });
    for (const text of ["billing one", "billing two", "billing three"]) {
      await worker.call("remember", { text });
    }
    const all = (await worker.call("recall", { query: "billing" })).data as { matches: unknown[] };
    expect(all.matches).toHaveLength(2);
    const limited = (await worker.call("recall", { query: "billing", limit: 1 })).data as { matches: unknown[] };
    expect(limited.matches).toHaveLength(1);
  });

  it("validates the query and limit", async () => {
    const worker = await withLetta();
    expect((await worker.call("recall", {})).error).toMatch(/`query` is required/);
    expect((await worker.call("recall", { query: "x", limit: 51 })).error).toMatch(/integer between 1 and 50/);
  });

  it("says plainly when nothing matches", async () => {
    const worker = await withLetta();
    await worker.call("remember", { text: "Priya owns billing" });
    const result = (await worker.call("recall", { query: "kubernetes ingress" })) as { content?: string };
    expect(result.content).toMatch(/No remembered passages match/);
  });
});

describe("read_profile / update_profile", () => {
  let fake: FakeLetta;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function withLetta(memoryOverrides: Record<string, unknown> = {}) {
    fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    const worker = await newWorker({ configs: { [COMPANY_A]: defaultConfig(memoryOverrides) } });
    return worker;
  }

  it("reports an empty profile instead of inventing one", async () => {
    const worker = await withLetta();
    const result = (await worker.call("read_profile", {})) as { content?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/No org profile yet/);
  });

  it("replaces the profile and logs the change", async () => {
    const worker = await withLetta();
    const result = (await worker.call("update_profile", { text: "Bionic makes agent infrastructure. CEO: Ada." })) as { content?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/replaced/);
    const block = Object.values(fake.blocks).find((b) => b.label === "org_profile")!;
    expect(block.value).toBe("Bionic makes agent infrastructure. CEO: Ada.");
    expect(worker.env.activity.some((entry) => entry.message.includes("Updated org profile block"))).toBe(true);

    const read = (await worker.call("read_profile", {})) as { content?: string };
    expect(read.content).toContain("Bionic makes agent infrastructure.");
  });

  it("refuses profile text over the configured limit", async () => {
    const worker = await withLetta({ profileLimit: 100 });
    const result = (await worker.call("update_profile", { text: "x".repeat(101) })) as { error?: string };
    expect(result.error).toMatch(/memory\.profileLimit/);
  });

  it("appends, and trims the oldest lines when the block would overflow", async () => {
    const worker = await withLetta({ profileLimit: 200 });
    await worker.call("update_profile", { text: "Line one of the old profile." });
    const long = "y".repeat(195);
    const result = (await worker.call("update_profile", { text: long, mode: "append" })) as { content?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/appended/);
    expect(result.content).toMatch(/oldest line\(s\) were trimmed/);
    const block = Object.values(fake.blocks).find((b) => b.label === "org_profile")!;
    expect(block.value).toBe(long);
    expect(block.value.length).toBeLessThanOrEqual(200);
  });

  it("rejects an unknown mode", async () => {
    const worker = await withLetta();
    expect((await worker.call("update_profile", { text: "x", mode: "overwrite" })).error).toMatch(/"replace" or "append"/);
  });

  it("recovers from a mapping whose agent was deleted in Letta", async () => {
    const worker = await withLetta();
    // First a normal call creates and persists the mapping.
    await worker.call("read_profile", {});
    // An operator (or a stack migration) deletes the agent in Letta, taking
    // its core blocks with it, so every mapped id now answers 404.
    const doomed = fake.agents[0]!;
    const agentId = doomed.id;
    fake.agents = fake.agents.filter((a) => a.id !== agentId);
    for (const blockId of doomed.blockIds) delete fake.blocks[blockId];

    const result = (await worker.call("read_profile", {})) as { content?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/No org profile yet/);
    // The stale mapping was cleared and one fresh agent adopted/created.
    expect(fake.agents).toHaveLength(1);
    expect(fake.agents[0]!.id).not.toBe(agentId);
    const mapping = worker.env.state.get(stateKey({ scopeKind: "company", scopeId: COMPANY_A, namespace: "loc-letta", stateKey: `letta-agent:${COMPANY_A}` })) as Record<string, string>;
    expect(mapping.agentId).toBe(fake.agents[0]!.id);
  });

  it("keeps companies apart: company B gets its own agent and profile", async () => {
    fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    const worker = await newWorker({
      companies: [
        { id: COMPANY_A, name: "Bionic" },
        { id: COMPANY_B, name: "Other" },
      ],
      configs: { [COMPANY_A]: defaultConfig(), [COMPANY_B]: defaultConfig() },
    });
    await worker.call("update_profile", { text: "Company A profile" });
    await worker.call("update_profile", { text: "Company B profile" }, runContext(COMPANY_B));
    expect(fake.agents).toHaveLength(2);
    const a = fake.agents.find((agent) => agent.name === `paperclip-org-memory-${COMPANY_A}`)!;
    const b = fake.agents.find((agent) => agent.name === `paperclip-org-memory-${COMPANY_B}`)!;
    expect(Object.values(fake.blocks).find((block) => block.agentId === a.id)!.value).toBe("Company A profile");
    expect(Object.values(fake.blocks).find((block) => block.agentId === b.id)!.value).toBe("Company B profile");
  });
});

describe("onValidateConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports every schema defect in one pass", async () => {
    const worker = await newWorker();
    const result = await worker.plugin.definition.onValidateConfig!({
      server: { url: "nope", token: "" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors!.join("\n")).toMatch(/not a valid http\(s\) URL/);
    expect(result.errors!.join("\n")).toMatch(/server\.token is required/);
  });

  it("passes when the server answers with the pasted token", async () => {
    const fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    const worker = await newWorker();
    const result = await worker.plugin.definition.onValidateConfig!({
      server: { url: "http://letta.test:8283", token: TOKEN },
    });
    expect(result).toMatchObject({ ok: true, errors: [] });
  });

  it("fails closed when the token is refused", async () => {
    const fake = new FakeLetta();
    fake.token = "different";
    vi.stubGlobal("fetch", fake.fetch);
    const worker = await newWorker();
    const result = await worker.plugin.definition.onValidateConfig!({
      server: { url: "http://letta.test:8283", token: TOKEN },
    });
    expect(result.ok).toBe(false);
    expect(result.errors!.join("\n")).toMatch(/server\.token/);
  });

  it("fails closed when the server is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const worker = await newWorker();
    const result = await worker.plugin.definition.onValidateConfig!({
      server: { url: "http://letta.test:8283", token: TOKEN },
    });
    expect(result.ok).toBe(false);
    expect(result.errors![0]).toMatch(/could not reach/);
    expect(result.errors![0]).toMatch(/ECONNREFUSED/);
  });

  it("resolves a saved-secret token through the first company's binding", async () => {
    const fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    const worker = await newWorker({ configs: { [COMPANY_A]: defaultConfig() } });
    const result = await worker.plugin.definition.onValidateConfig!({
      server: { url: "http://letta.test:8283", token: { type: "secret_ref", secretId: SECRET_ID, version: "latest" } },
    });
    expect(result.ok).toBe(true);
  });

  it("still proves reachability when the binding is unresolvable, and warns", async () => {
    const fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    // No companies exist, so no binding can be resolved.
    const worker = await newWorker({ companies: [] });
    const result = await worker.plugin.definition.onValidateConfig!({
      server: { url: "http://letta.test:8283", token: { type: "secret_ref", secretId: SECRET_ID } },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings!.join(" ")).toMatch(/not resolvable/);
  });
});

describe("onHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes with the token, snapshots url/ok/latency without the secret", async () => {
    const fake = new FakeLetta();
    vi.stubGlobal("fetch", fake.fetch);
    const worker = await newWorker({ configs: { [COMPANY_A]: defaultConfig() } });
    const health = await worker.plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
    expect(health.message).toMatch(/Bearer auth accepted/);

    const snapshot = worker.env.state.get(stateKey({ scopeKind: "instance", namespace: "loc-letta", stateKey: "health" })) as Record<string, unknown>;
    expect(snapshot.url).toBe("http://letta.test:8283");
    expect(snapshot.ok).toBe(true);
    expect(typeof snapshot.latencyMs).toBe("number");
    expect(snapshot.updatedAt).toBeTruthy();
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
  });

  it("degrades (not crashes) when the server refuses the token", async () => {
    const fake = new FakeLetta();
    fake.token = "different";
    vi.stubGlobal("fetch", fake.fetch);
    const worker = await newWorker({ configs: { [COMPANY_A]: defaultConfig() } });
    const health = await worker.plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    const snapshot = worker.env.state.get(stateKey({ scopeKind: "instance", namespace: "loc-letta", stateKey: "health" })) as Record<string, unknown>;
    expect(snapshot.ok).toBe(false);
  });

  it("errors clearly when nothing is configured", async () => {
    const worker = await newWorker({ configs: {} });
    const health = await worker.plugin.definition.onHealth!();
    expect(health.status).toBe("error");
    expect(health.message).toMatch(/No Letta server is configured/);
  });
});
