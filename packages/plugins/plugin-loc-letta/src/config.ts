/**
 * Plugin configuration parsing for the Loc-Letta Memory connector.
 *
 * Two properties are load-bearing here:
 *
 * 1. Every network detail lives in `server`, so moving the Letta stack to
 *    another host is a one-value config change with no code change. The
 *    in-cluster Service DNS is the default precisely so a stack move can be
 *    done by editing that one Service instead of this plugin.
 * 2. The Bearer token may be pasted or saved as a Paperclip secret
 *    (`secret_ref` binding), identical in mechanism to Loc-AgentMail's
 *    mailbox password. Only the reference is stored; the value is resolved
 *    at call time and never written to state, logs, or activity.
 */

/** Raised for configuration problems; messages name the offending field. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A secret reference as stored in config: a binding object or a pasted value. */
export type SecretRefValue =
  | string
  | { type?: string; secretId?: string; id?: string; version?: string | number }
  | null
  | undefined;

/** Where the Letta server lives and how to reach it. */
export interface LettaServerSettings {
  /** Base URL of the Letta REST API, without a trailing slash (normalized). */
  url: string;
  /** Bearer token: pasted string or a `secret_ref` binding. */
  token: SecretRefValue;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
}

/** How org memory is shaped inside Letta. */
export interface LettaMemorySettings {
  /** Label of the core block holding the company's org profile. */
  orgBlockLabel: string;
  /** Max characters accepted for a profile update. */
  profileLimit: number;
  /** Max results returned by `recall`. */
  archivalLimit: number;
  /** Template for the per-company Letta agent name; must contain `{companyId}`. */
  agentNameTemplate: string;
  /**
   * Model handle sent when creating the Letta agent. The live Letta API
   * refuses agent creation without one ("Must specify either model or
   * llm_config"), even though this connector never runs a conversation.
   */
  agentModel: string;
  /**
   * Optional embedding overrides applied at agent creation. The server
   * default embedding on some builds points at an unreachable hosted
   * endpoint, which makes every archival insert fail server-side; an
   * operator with a working embedding endpoint sets these three fields.
   */
  embeddingModel?: string;
  embeddingEndpoint?: string;
  embeddingDim?: number;
}

/** Fully validated plugin configuration. */
export interface LocLettaConfig {
  server: LettaServerSettings;
  memory: LettaMemorySettings;
}

export const DEFAULT_ORG_BLOCK_LABEL = "org_profile";
export const DEFAULT_AGENT_NAME_TEMPLATE = "paperclip-org-memory-{companyId}";

const BLOCK_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function asObject(value: unknown, field: string, errors: string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  errors.push(`${field} must be an object`);
  return {};
}

function str(value: unknown, field: string, errors: string[], fallback?: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) errors.push(`${field} is required`);
    return fallback;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return fallback;
  }
  return value.trim();
}

function int(value: unknown, field: string, fallback: number, min: number, max: number, errors: string[]): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${field} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

/** Accepts a pasted string or a secret binding object; empty is an error. */
function secretValue(value: unknown, field: string, errors: string[]): SecretRefValue {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      errors.push(`${field} is required (paste it or pick a saved secret)`);
      return null;
    }
    return trimmed;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const secretId = typeof record.secretId === "string" ? record.secretId.trim() : "";
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (secretId || id) return record as SecretRefValue;
    errors.push(`${field} is a secret binding without a secret id — re-pick the saved secret`);
    return null;
  }
  errors.push(`${field} is required (paste it or pick a saved secret)`);
  return null;
}

/** Validates and normalizes a base URL, rejecting query strings. */
export function normalizeBaseUrl(raw: string, field: string, errors: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push(`${field} "${raw}" is not a valid http(s) URL`);
    return raw;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(`${field} "${raw}" must be an http(s) URL`);
    return raw;
  }
  if (parsed.search || parsed.hash) {
    errors.push(`${field} must not carry a query string or fragment`);
  }
  return parsed.href.replace(/\/+$/, "");
}

/** Validate raw plugin config, collecting every problem before throwing. */
export function parseConfig(raw: Record<string, unknown> | undefined): LocLettaConfig {
  const errors: string[] = [];
  const root = asObject(raw, "config", errors);

  const serverRaw = asObject(root.server, "server", errors);
  const urlRaw = str(serverRaw.url, "server.url", errors) ?? "";
  const server: LettaServerSettings = {
    url: urlRaw ? normalizeBaseUrl(urlRaw, "server.url", errors) : "",
    token: secretValue(serverRaw.token, "server.token", errors),
    requestTimeoutMs: int(serverRaw.requestTimeoutMs, "server.requestTimeoutMs", 20000, 1000, 300000, errors),
  };

  const memoryRaw = asObject(root.memory, "memory", errors);
  const orgBlockLabel = str(memoryRaw.orgBlockLabel, "memory.orgBlockLabel", errors, DEFAULT_ORG_BLOCK_LABEL) ?? DEFAULT_ORG_BLOCK_LABEL;
  if (!BLOCK_LABEL_RE.test(orgBlockLabel)) {
    errors.push("memory.orgBlockLabel must be a lowercase slug (letters, digits, dot, dash, underscore)");
  }
  const agentNameTemplate =
    str(memoryRaw.agentNameTemplate, "memory.agentNameTemplate", errors, DEFAULT_AGENT_NAME_TEMPLATE) ?? DEFAULT_AGENT_NAME_TEMPLATE;
  if (!agentNameTemplate.includes("{companyId}")) {
    errors.push('memory.agentNameTemplate must contain "{companyId}" so each company gets its own Letta agent');
  }
  const embeddingModel = typeof memoryRaw.embeddingModel === "string" && memoryRaw.embeddingModel.trim() ? memoryRaw.embeddingModel.trim() : undefined;
  const embeddingEndpoint = typeof memoryRaw.embeddingEndpoint === "string" && memoryRaw.embeddingEndpoint.trim() ? memoryRaw.embeddingEndpoint.trim() : undefined;
  if ((embeddingModel && !embeddingEndpoint) || (embeddingEndpoint && !embeddingModel)) {
    errors.push("memory.embeddingModel and memory.embeddingEndpoint must be set together");
  }
  const memory: LettaMemorySettings = {
    orgBlockLabel,
    profileLimit: int(memoryRaw.profileLimit, "memory.profileLimit", 4000, 200, 100000, errors),
    archivalLimit: int(memoryRaw.archivalLimit, "memory.archivalLimit", 20, 1, 50, errors),
    agentNameTemplate,
    agentModel: str(memoryRaw.agentModel, "memory.agentModel", errors, "letta/letta-free") ?? "letta/letta-free",
    embeddingModel,
    embeddingEndpoint,
    embeddingDim: embeddingEndpoint ? int(memoryRaw.embeddingDim, "memory.embeddingDim", 1024, 8, 8192, errors) : undefined,
  };

  if (errors.length > 0) {
    throw new ConfigError(`Loc-Letta Memory configuration is invalid:\n- ${Array.from(new Set(errors)).join("\n- ")}`);
  }
  return { server, memory };
}

/** The Letta agent name this company maps to. */
export function agentNameForCompany(config: LocLettaConfig, companyId: string): string {
  return config.memory.agentNameTemplate.replaceAll("{companyId}", companyId.trim()).toLowerCase();
}
