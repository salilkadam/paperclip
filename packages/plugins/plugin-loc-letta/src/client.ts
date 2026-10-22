/**
 * Minimal Letta REST client (verified against Letta 0.16.7).
 *
 * Every request carries `Authorization: Bearer <token>`; this build does not
 * accept HTTP Basic. Some routes answer with a 307 redirect, so every call
 * follows redirects. All request bodies are JSON; responses are JSON except on
 * unexpected errors, where Letta answers `{"detail": ...}`.
 *
 * Verified endpoint shapes:
 *   GET    /v1/agents/?limit=N                       -> JSON array of agents
 *   POST   /v1/agents/                               -> AgentState {id, blocks:[{id,label,...}]}
 *   GET    /v1/blocks/{id}                           -> Block {id,label,value,limit,...}
 *   PATCH  /v1/blocks/{id}  {"value": "..."}         -> updated Block (there is no PUT)
 *   POST   /v1/agents/{id}/archival-memory           -> [Passage] (requires "text"; no
 *          metadata field on this build — provenance travels in "tags")
 *   GET    /v1/agents/{id}/archival-memory/search
 *              ?query=...&top_k=N                    -> {results:[{id,timestamp,content,tags}],count}
 *   DELETE /v1/agents/{id}                           -> 200
 * A bad or missing token answers 401.
 */

import { ConfigError } from "./config.js";

/** Raised for Letta-side failures; the message is safe to show an agent. */
export class LettaError extends Error {
  /** HTTP status when the server answered, otherwise undefined. */
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LettaError";
    this.status = status;
  }
}

export interface LettaClientOptions {
  /** Base URL without trailing slash (config already normalized it). */
  baseUrl: string;
  /** Resolved Bearer token. Never log this value. */
  token: string;
  /** Per-request timeout, from server.requestTimeoutMs. */
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface LettaAgentSummary {
  id: string;
  name: string;
}

export interface LettaBlock {
  id: string;
  label: string;
  value: string;
  limit: number;
}

export interface LettaPassage {
  id: string;
  text: string;
  tags: string[];
  created_at: string;
}

export interface LettaSearchResult {
  id: string;
  timestamp: string;
  content: string;
  tags: string[];
}

/** Replace every occurrence of the token with a fixed mask. */
export function maskSecret(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}

/** Join the configured base URL and an API path without doubling slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract Letta's `detail` (or a truncated raw body) for an error message. */
function describeErrorBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300) || "empty response body";
}

export class LettaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(options: LettaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.doFetch = options.fetchImpl ?? globalThis.fetch;
    if (!this.token) throw new ConfigError("server.token is required");
  }

  /** Never let the raw token escape in an error message. */
  mask(text: string): string {
    return maskSecret(text, this.token);
  }

  private async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { query?: Record<string, string | number>; body?: unknown } = {},
  ): Promise<unknown> {
    const query = options.query
      ? `?${new URLSearchParams(Object.entries(options.query).map(([key, value]) => [key, String(value)] as [string, string]))}`
      : "";
    const url = joinUrl(this.baseUrl, `/v1${path}`) + query;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    const init: RequestInit = {
      method,
      headers,
      // Some routes answer 307; always follow.
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.doFetch(url, init);
    } catch (error) {
      const host = new URL(this.baseUrl).host;
      throw new LettaError(`could not reach the Letta server at ${host}: ${this.mask((error as Error).message)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new LettaError(
        `Letta rejected the request (HTTP ${response.status}). Check server.token in the Loc-Letta Memory settings — the token was refused.`,
        response.status,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new LettaError(
        `Letta answered HTTP ${response.status} for ${method} ${path}: ${this.mask(describeErrorBody(text))}`,
        response.status,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new LettaError(`Letta answered ${method} ${path} with a non-JSON body (${this.mask(text.slice(0, 200))})`, response.status);
    }
  }

  /** `GET /v1/agents/` returns a bare JSON array on this build. */
  private async listAgents(limit: number): Promise<LettaAgentSummary[]> {
    const data = await this.request("GET", "/agents/", { query: { limit } });
    if (!Array.isArray(data)) throw new LettaError("unexpected response from GET /v1/agents/ (expected a JSON array)");
    return data
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({ id: String(item.id ?? ""), name: String(item.name ?? "") }))
      .filter((agent) => agent.id);
  }

  /** Cheap authenticated read used by health and config validation. */
  async ping(): Promise<{ agentCount: number }> {
    const agents = await this.listAgents(1);
    return { agentCount: agents.length };
  }

  /** Find an existing agent by exact name so state loss cannot duplicate it. */
  async findAgentByName(name: string): Promise<LettaAgentSummary | null> {
    const agents = await this.listAgents(500);
    return agents.find((agent) => agent.name === name) ?? null;
  }

  /**
   * Create the per-company memory agent with one empty core block.
   *
   * This build refuses agent creation without a model even when no
   * conversation will ever run on the agent, and duplicate names are allowed,
   * so callers must go through `findAgentByName` first.
   */
  async createMemoryAgent(params: {
    name: string;
    blockLabel: string;
    blockLimit: number;
    model: string;
    embeddingModel?: string;
    embeddingEndpoint?: string;
    embeddingDim?: number;
  }): Promise<{ agent: LettaAgentSummary; block: LettaBlock }> {
    const body: Record<string, unknown> = {
      name: params.name,
      include_base_tools: false,
      description: "Paperclip org-memory store (Loc-Letta Memory connector). Not a conversational agent.",
      model: params.model,
      memory_blocks: [{ label: params.blockLabel, value: "", limit: params.blockLimit }],
    };
    if (params.embeddingModel && params.embeddingEndpoint) {
      body.embedding = `${params.embeddingModel}`;
      body.embedding_config = {
        embedding_endpoint_type: "openai",
        embedding_endpoint: params.embeddingEndpoint,
        embedding_model: params.embeddingModel,
        embedding_dim: params.embeddingDim ?? 1024,
        embedding_chunk_size: 300,
      };
    }
    const data = await this.request("POST", "/agents/", { body });
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new LettaError("unexpected response from POST /v1/agents/ (expected an agent object with an id)");
    }
    const blocks = Array.isArray(data.blocks) ? data.blocks : [];
    const block = blocks.find((item: unknown) => isRecord(item) && item.label === params.blockLabel);
    if (!isRecord(block) || typeof block.id !== "string") {
      throw new LettaError(`created agent ${data.id} without the "${params.blockLabel}" core block`);
    }
    return {
      agent: { id: data.id, name: String(data.name ?? params.name) },
      block: {
        id: block.id,
        label: String(block.label ?? params.blockLabel),
        value: String(block.value ?? ""),
        limit: Number(block.limit ?? params.blockLimit),
      },
    };
  }

  async getBlock(blockId: string): Promise<LettaBlock> {
    const data = await this.request("GET", `/blocks/${encodeURIComponent(blockId)}`);
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new LettaError(`unexpected response from GET /v1/blocks/${blockId} (expected a block object)`);
    }
    return {
      id: data.id,
      label: String(data.label ?? ""),
      value: String(data.value ?? ""),
      limit: Number(data.limit ?? 0),
    };
  }

  /** Set a core block's value. This build updates blocks with PATCH, not PUT. */
  async patchBlockValue(blockId: string, value: string): Promise<LettaBlock> {
    const data = await this.request("PATCH", `/blocks/${encodeURIComponent(blockId)}`, { body: { value } });
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new LettaError(`unexpected response from PATCH /v1/blocks/${blockId} (expected a block object)`);
    }
    return {
      id: data.id,
      label: String(data.label ?? ""),
      value: String(data.value ?? ""),
      limit: Number(data.limit ?? 0),
    };
  }


  /** Core blocks attached to an agent, from `GET /v1/agents/{id}/core-memory/blocks`. */
  async listAgentBlocks(agentId: string): Promise<LettaBlock[]> {
    const data = await this.request("GET", `/agents/${encodeURIComponent(agentId)}/core-memory/blocks`);
    if (!Array.isArray(data)) {
      throw new LettaError(`unexpected response from GET core-memory blocks for agent ${agentId}`);
    }
    return data
      .filter((item: unknown): item is Record<string, unknown> => isRecord(item))
      .map((item: Record<string, unknown>) => ({
        id: String(item.id ?? ""),
        label: String(item.label ?? ""),
        value: String(item.value ?? ""),
        limit: Number(item.limit ?? 0),
      }));
  }

  /** Create a standalone block (adopted agent may lack the org block). */
  async createBlock(params: { label: string; value: string; limit: number }): Promise<LettaBlock> {
    const data = await this.request("POST", "/blocks/", {
      body: { label: params.label, value: params.value, limit: params.limit },
    });
    if (!isRecord(data) || typeof data.id !== "string") {
      throw new LettaError("unexpected response from POST /v1/blocks/ (expected a block object)");
    }
    return {
      id: data.id,
      label: String(data.label ?? params.label),
      value: String(data.value ?? params.value),
      limit: Number(data.limit ?? params.limit),
    };
  }

  /** Attach a standalone block to an agent's core memory. */
  async attachBlockToAgent(agentId: string, blockId: string): Promise<void> {
    await this.request("PATCH", `/agents/${encodeURIComponent(agentId)}/core-memory/blocks/attach/${encodeURIComponent(blockId)}`);
  }

  /**
   * Insert one archival passage.
   *
   * This build's insert body takes `text` and `tags` only (no document or
   * metadata fields), so connector provenance is carried as tags and the
   * server's own `created_at` provides the timestamp.
   */
  async insertArchivalMemory(agentId: string, text: string, tags: string[]): Promise<LettaPassage> {
    const data = await this.request("POST", `/agents/${encodeURIComponent(agentId)}/archival-memory`, {
      body: { text, tags },
    });
    const passage = Array.isArray(data) ? data[0] : data;
    if (!isRecord(passage) || typeof passage.id !== "string") {
      throw new LettaError("unexpected response from the archival insert (expected a passage object)");
    }
    return {
      id: passage.id,
      text: String(passage.text ?? text),
      tags: Array.isArray(passage.tags) ? passage.tags.map((tag: unknown) => String(tag)) : tags,
      created_at: String(passage.created_at ?? ""),
    };
  }

  /**
   * Semantic search over the agent's default archival store.
   *
   * Search is a GET with `query`/`top_k` on this build, and results carry no
   * numeric score — the server returns them best-match first.
   */
  async searchArchivalMemory(agentId: string, query: string, topK: number): Promise<LettaSearchResult[]> {
    const data = await this.request("GET", `/agents/${encodeURIComponent(agentId)}/archival-memory/search`, {
      query: { query, top_k: topK },
    });
    if (!isRecord(data) || !Array.isArray(data.results)) {
      throw new LettaError("unexpected response from the archival search (expected {results:[...]})");
    }
    return data.results
      .filter((item: unknown): item is Record<string, unknown> => isRecord(item))
      .map((item: Record<string, unknown>) => ({
        id: String(item.id ?? ""),
        timestamp: String(item.timestamp ?? ""),
        content: String(item.content ?? ""),
        tags: Array.isArray(item.tags) ? item.tags.map((tag: unknown) => String(tag)) : [],
      }));
  }
}
