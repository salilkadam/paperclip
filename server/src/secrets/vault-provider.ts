import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DeploymentMode } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type {
  PreparedSecretVersion,
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

/**
 * HashiCorp Vault (KV v2) secret provider.
 *
 * Custody: Paperclip never stores a Vault credential. The server logs in with
 * its own Kubernetes ServiceAccount (or, for local development, a token file)
 * and gets a short-lived token; per-company provider vault rows carry only a
 * Vault namespace label. Address, mount and path prefix come from deployment
 * env, so a company admin cannot redirect where the server sends its identity.
 *
 * Layout under the deployment prefix (one KV entry per Paperclip secret, the
 * secret UUID as leaf, one KV version per Paperclip version):
 *   <prefix>/companies/<companyId>/company/<secretId>
 *   <prefix>/companies/<companyId>/users/<ownerUserId>/<secretId>
 *   <prefix>/companies/<companyId>/{agents,projects}/<ownerId>/<secretId>
 * An instance-scoped secret is filed under its owning agent or project (every
 * instance owner today names one; the plugin id is kept in the DB row, and
 * `plugins/<id>` is only a fallback for an owner with neither).
 *
 * Material is self-describing (mount, path, KV version), and every managed
 * read checks the path lies inside the requesting company's subtree.
 */

const VAULT_SCHEME = "vault_kv2_v1";
const DEFAULT_MOUNT = "secret";
const DEFAULT_K8S_MOUNT = "kubernetes";
const DEFAULT_K8S_JWT_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_VERSIONS = 100;
const HEALTH_CANARY_MAX_VERSIONS = 5;
const RENEW_AT_FRACTION = 2 / 3;
/** The Secrets page polls provider health every 60 s; the probe writes, so it is cached. */
const HEALTH_CACHE_OK_MS = 5 * 60_000;
const HEALTH_CACHE_ERROR_MS = 60_000;
/** A 403 forces at most one fresh login per auth identity in this window. */
const FORCED_LOGIN_MIN_INTERVAL_MS = 30_000;
const NAMESPACE_RE = /^[A-Za-z0-9_.\/-]{1,160}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PATH_RE = /^[A-Za-z0-9_./-]{1,512}$/;

export type VaultAuthMethod = "kubernetes" | "token_file";

export interface VaultProviderConfig {
  address: string;
  namespace: string | null;
  mount: string;
  prefix: string;
  authMethod: VaultAuthMethod;
  k8sRole: string | null;
  k8sMount: string;
  k8sJwtPath: string;
  tokenFile: string | null;
  timeoutMs: number;
  maxVersions: number;
  externalPrefixes: string[];
  /** Namespaces a provider vault may select besides `namespace` (PAPERCLIP_SECRETS_VAULT_ALLOWED_NAMESPACES). */
  allowedNamespaces?: string[];
}

interface VaultMaterial extends StoredSecretVersionMaterial {
  scheme: typeof VAULT_SCHEME;
  mount: string;
  path: string;
  kvVersion: number | null;
  source: "managed" | "external_reference";
  field?: string | null;
}

interface VaultKvMetadata {
  currentVersion: number;
  maxVersions: number;
  versions: Record<string, { deleted: boolean; destroyed: boolean }>;
}

/** The HTTP surface the provider needs; injectable for tests. */
export interface VaultKvGateway {
  writeMetadata(path: string, body: { max_versions: number }): Promise<void>;
  readMetadata(path: string): Promise<VaultKvMetadata | null>;
  writeData(path: string, data: Record<string, string>, cas: number | null): Promise<{ version: number }>;
  readData(path: string, version: number | null): Promise<{ data: Record<string, unknown>; version: number } | null>;
  softDeleteVersions(path: string, versions: number[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function cleanPath(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function normalizeAddress(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unprocessable("PAPERCLIP_SECRETS_VAULT_ADDR must be an http(s) URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    throw unprocessable("PAPERCLIP_SECRETS_VAULT_ADDR must be an origin-only http(s) URL");
  }
  return url.origin;
}

function positiveInt(raw: string | null, fallback: number, name: string): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw unprocessable(`${name} must be a positive integer`);
  return value;
}

export function getVaultConfigReadiness() {
  const missingConfig: string[] = [];
  if (!env("PAPERCLIP_SECRETS_VAULT_ADDR")) missingConfig.push("PAPERCLIP_SECRETS_VAULT_ADDR");
  if (!env("PAPERCLIP_SECRETS_VAULT_PREFIX")) missingConfig.push("PAPERCLIP_SECRETS_VAULT_PREFIX");
  const method = env("PAPERCLIP_SECRETS_VAULT_AUTH_METHOD") ?? "kubernetes";
  if (method === "kubernetes" && !env("PAPERCLIP_SECRETS_VAULT_K8S_ROLE")) missingConfig.push("PAPERCLIP_SECRETS_VAULT_K8S_ROLE");
  if (method === "token_file" && !env("PAPERCLIP_SECRETS_VAULT_TOKEN_FILE")) missingConfig.push("PAPERCLIP_SECRETS_VAULT_TOKEN_FILE");
  if (method !== "kubernetes" && method !== "token_file") missingConfig.push("PAPERCLIP_SECRETS_VAULT_AUTH_METHOD (kubernetes|token_file)");
  return { ready: missingConfig.length === 0, missingConfig };
}

export function loadVaultProviderConfig(): VaultProviderConfig {
  const readiness = getVaultConfigReadiness();
  if (!readiness.ready) {
    throw unprocessable(`HashiCorp Vault provider is not configured: missing ${readiness.missingConfig.join(", ")}`);
  }
  const prefix = cleanPath(env("PAPERCLIP_SECRETS_VAULT_PREFIX")!);
  const mount = cleanPath(env("PAPERCLIP_SECRETS_VAULT_MOUNT") ?? DEFAULT_MOUNT);
  if (!PATH_RE.test(prefix) || prefix.includes("..")) throw unprocessable("PAPERCLIP_SECRETS_VAULT_PREFIX is not a valid KV path");
  if (!SEGMENT_RE.test(mount)) throw unprocessable("PAPERCLIP_SECRETS_VAULT_MOUNT is not a valid mount name");
  const externalPrefixes = (env("PAPERCLIP_SECRETS_VAULT_EXTERNAL_PATHS") ?? "")
    .split(",")
    .map((value) => value.trim().replace(/^\/+/, ""))
    .filter(Boolean);
  for (const external of externalPrefixes) {
    if (!PATH_RE.test(external) || external.includes("..")) {
      throw unprocessable(`PAPERCLIP_SECRETS_VAULT_EXTERNAL_PATHS entry is not a valid KV path: ${external}`);
    }
    if (isWithin(external, prefix) || isWithin(prefix, external)) {
      throw unprocessable("PAPERCLIP_SECRETS_VAULT_EXTERNAL_PATHS must not overlap the managed prefix");
    }
  }
  return {
    address: normalizeAddress(env("PAPERCLIP_SECRETS_VAULT_ADDR")!),
    namespace: env("PAPERCLIP_SECRETS_VAULT_NAMESPACE") ? cleanPath(env("PAPERCLIP_SECRETS_VAULT_NAMESPACE")!) : null,
    mount,
    prefix,
    authMethod: (env("PAPERCLIP_SECRETS_VAULT_AUTH_METHOD") ?? "kubernetes") as VaultAuthMethod,
    k8sRole: env("PAPERCLIP_SECRETS_VAULT_K8S_ROLE"),
    k8sMount: cleanPath(env("PAPERCLIP_SECRETS_VAULT_K8S_MOUNT") ?? DEFAULT_K8S_MOUNT),
    k8sJwtPath: env("PAPERCLIP_SECRETS_VAULT_K8S_JWT_PATH") ?? DEFAULT_K8S_JWT_PATH,
    tokenFile: env("PAPERCLIP_SECRETS_VAULT_TOKEN_FILE"),
    timeoutMs: positiveInt(env("PAPERCLIP_SECRETS_VAULT_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS, "PAPERCLIP_SECRETS_VAULT_TIMEOUT_MS"),
    maxVersions: positiveInt(env("PAPERCLIP_SECRETS_VAULT_MAX_VERSIONS"), DEFAULT_MAX_VERSIONS, "PAPERCLIP_SECRETS_VAULT_MAX_VERSIONS"),
    externalPrefixes,
    allowedNamespaces: (env("PAPERCLIP_SECRETS_VAULT_ALLOWED_NAMESPACES") ?? "")
      .split(",")
      .map((value) => cleanPath(value.trim()))
      .filter(Boolean),
  };
}

/**
 * Per-company provider vault rows may only label a Vault namespace. Where the
 * server connects, which mount and which prefix it writes under are
 * deployment decisions (env), never company-editable data.
 */
function applyProviderVaultConfig(
  base: VaultProviderConfig,
  providerConfig: SecretProviderVaultRuntimeConfig | null | undefined,
): VaultProviderConfig {
  if (!providerConfig) return base;
  if (providerConfig.provider !== "vault") throw unprocessable("Provider vault does not match HashiCorp Vault provider");
  if (providerConfig.status === "disabled") throw unprocessable("Provider vault is disabled");
  if (providerConfig.status === "coming_soon") throw unprocessable("Provider vault is not enabled");
  const config = providerConfig.config ?? {};
  for (const key of ["address", "mountPath", "secretPathPrefix"]) {
    const value = config[key];
    if (value !== undefined && value !== null && value !== "") {
      throw unprocessable(
        `Provider vault config field "${key}" is set by the deployment, not per company; edit the provider vault to clear it`,
      );
    }
  }
  const namespace = typeof config.namespace === "string" && config.namespace.trim() ? cleanPath(config.namespace.trim()) : null;
  if (!namespace || namespace === (base.namespace ? cleanPath(base.namespace) : null)) return base;
  // The namespace picks which auth mount receives the server's ServiceAccount
  // JWT, so a company may only choose one the deployment has allowed.
  if (!NAMESPACE_RE.test(namespace) || !(base.allowedNamespaces ?? []).map(cleanPath).includes(namespace)) {
    throw unprocessable(
      "This Vault namespace is not allowed by the deployment (PAPERCLIP_SECRETS_VAULT_ALLOWED_NAMESPACES)",
    );
  }
  return { ...base, namespace };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isWithin(path: string, prefix: string): boolean {
  const p = cleanPath(path);
  const root = cleanPath(prefix);
  return p === root || p.startsWith(`${root}/`);
}

function segment(value: string | null | undefined, what: string): string {
  if (!value || !SEGMENT_RE.test(value)) {
    throw unprocessable(`HashiCorp Vault provider needs a valid ${what} to place this secret`);
  }
  return value;
}

function companyRoot(config: VaultProviderConfig, companyId: string): string {
  return `${config.prefix}/companies/${segment(companyId, "company id")}`;
}

/** Ownership scope, not bindings, decides the path (see module comment). */
export function managedSecretPath(config: VaultProviderConfig, context: SecretProviderWriteContext | undefined): string {
  if (!context) throw unprocessable("HashiCorp Vault provider needs the secret's identity to store a managed value");
  const root = companyRoot(config, context.companyId);
  const secretId = segment(context.secretId, "secret id");
  switch (context.scope ?? "company") {
    case "company":
      return `${root}/company/${secretId}`;
    case "user":
      return `${root}/users/${segment(context.ownerUserId, "owner user id")}/${secretId}`;
    case "instance": {
      if (context.ownerAgentId) return `${root}/agents/${segment(context.ownerAgentId, "owner agent id")}/${secretId}`;
      if (context.ownerProjectId) return `${root}/projects/${segment(context.ownerProjectId, "owner project id")}/${secretId}`;
      if (context.ownerPluginId) return `${root}/plugins/${segment(context.ownerPluginId, "owner plugin id")}/${secretId}`;
      throw unprocessable("HashiCorp Vault provider needs the owner of an instance-scoped secret");
    }
    default:
      throw unprocessable("HashiCorp Vault provider does not recognise this secret scope");
  }
}

function parseExternalRef(config: VaultProviderConfig, externalRef: string): { path: string; field: string } {
  const trimmed = externalRef.trim().replace(/^\/+/, "");
  const hash = trimmed.lastIndexOf("#");
  if (hash <= 0 || hash === trimmed.length - 1) {
    throw unprocessable("HashiCorp Vault external references use the form <kv path>#<field>");
  }
  const path = cleanPath(trimmed.slice(0, hash));
  const field = trimmed.slice(hash + 1);
  if (!PATH_RE.test(path) || path.includes("..") || !/^[A-Za-z0-9_.-]{1,128}$/.test(field)) {
    throw unprocessable("HashiCorp Vault external reference is not a valid KV path and field");
  }
  if (isWithin(path, config.prefix)) {
    throw unprocessable("External references cannot point inside the Paperclip-managed Vault prefix");
  }
  // "a/b/" allows the subtree under a/b; "a/b" allows exactly that KV entry.
  if (!config.externalPrefixes.some((allowed) => (allowed.endsWith("/") ? path.startsWith(allowed) : path === cleanPath(allowed)))) {
    throw unprocessable("This Vault path is not in the deployment's allowed external paths (PAPERCLIP_SECRETS_VAULT_EXTERNAL_PATHS)");
  }
  return { path, field };
}

function asVaultMaterial(value: StoredSecretVersionMaterial): VaultMaterial {
  const material = value as Partial<VaultMaterial>;
  if (
    material?.scheme !== VAULT_SCHEME ||
    typeof material.mount !== "string" ||
    typeof material.path !== "string" ||
    (material.source !== "managed" && material.source !== "external_reference")
  ) {
    throw unprocessable("Secret version material is not HashiCorp Vault material");
  }
  return material as VaultMaterial;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function classify(status: number | null, raw: string): SecretProviderClientErrorCode {
  if (status === 400 && /check-and-set/i.test(raw)) return "conflict";
  if (status === 400) return "invalid_request";
  if (status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "throttled";
  if (status === null || status === 502 || status === 503 || status === 504 || /sealed/i.test(raw)) return "provider_unavailable";
  return "provider_error";
}

const SAFE_MESSAGES: Record<SecretProviderClientErrorCode, string> = {
  access_denied: "Vault denied this request; check the server's Vault role policy.",
  throttled: "Vault is rate limiting requests; try again shortly.",
  not_found: "The Vault secret or version was not found (it may have been deleted or pruned).",
  conflict: "The Vault secret changed concurrently; retry the operation.",
  invalid_request: "Vault rejected the request as invalid.",
  provider_unavailable: "Vault is unreachable or sealed; try again shortly.",
  provider_error: "Vault returned an unexpected error.",
};

function vaultError(operation: string, status: number | null, raw: string, cause?: unknown): SecretProviderClientError {
  const code = classify(status, raw);
  return new SecretProviderClientError({
    code,
    provider: "vault",
    operation,
    message: SAFE_MESSAGES[code],
    rawMessage: raw.slice(0, 500) || null,
    cause,
  });
}

// ---------------------------------------------------------------------------
// HTTP gateway with Kubernetes / token-file auth
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  renewAt: number;
  renewable: boolean;
  accessor: string | null;
}

interface LoginEntry {
  config: VaultProviderConfig;
  cached: CachedToken | null;
  pending: Promise<CachedToken> | null;
  lastForcedLoginAt: number;
}

const loginCache = new Map<string, LoginEntry>();

function authKey(config: VaultProviderConfig) {
  return [config.address, config.namespace ?? "", config.authMethod, config.k8sMount, config.k8sRole ?? "", config.tokenFile ?? ""].join("|");
}

export class VaultHttpGateway implements VaultKvGateway {
  constructor(private readonly config: VaultProviderConfig) {}

  private headers(token: string | null): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-vault-token"] = token;
    if (this.config.namespace) headers["x-vault-namespace"] = this.config.namespace;
    return headers;
  }

  private async raw(operation: string, method: string, path: string, body: unknown, token: string | null) {
    let response: Response;
    try {
      response = await fetch(`${this.config.address}/v1/${path}`, {
        method,
        headers: this.headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw vaultError(operation, null, error instanceof Error ? error.message : String(error), error);
    }
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  private async login(): Promise<CachedToken> {
    if (this.config.authMethod === "token_file") {
      const token = readFileSync(this.config.tokenFile!, "utf8").trim();
      if (!token) throw vaultError("login", 400, "token file is empty");
      return { token, renewAt: Number.POSITIVE_INFINITY, renewable: false, accessor: null };
    }
    // Re-read the projected ServiceAccount token on every login: the kubelet
    // rotates it and the application is responsible for reloading it.
    let jwt: string;
    try {
      jwt = readFileSync(this.config.k8sJwtPath, "utf8").trim();
    } catch (error) {
      throw vaultError("login", null, `cannot read ServiceAccount token at ${this.config.k8sJwtPath}`, error);
    }
    const result = await this.raw("login", "POST", `auth/${this.config.k8sMount}/login`, { role: this.config.k8sRole, jwt }, null);
    const auth = (result.json?.auth ?? null) as { client_token?: string; lease_duration?: number; renewable?: boolean; accessor?: string } | null;
    if (result.status !== 200 || !auth?.client_token) {
      throw vaultError("login", result.status, errorText(result.json, result.text));
    }
    const ttlMs = Math.max(1, auth.lease_duration ?? 0) * 1000;
    return {
      token: auth.client_token,
      renewAt: Date.now() + ttlMs * RENEW_AT_FRACTION,
      renewable: auth.renewable === true,
      accessor: auth.accessor ?? null,
    };
  }

  private entry(): LoginEntry {
    const key = authKey(this.config);
    let entry = loginCache.get(key);
    if (!entry) {
      entry = { config: this.config, cached: null, pending: null, lastForcedLoginAt: 0 };
      loginCache.set(key, entry);
    }
    return entry;
  }

  private async token(forceLogin = false): Promise<string> {
    const entry = this.entry();
    if (!forceLogin && entry.cached && Date.now() < entry.cached.renewAt) return entry.cached.token;
    if (!forceLogin && entry.cached?.renewable) {
      const renewed = await this.raw("renew", "POST", "auth/token/renew-self", {}, entry.cached.token);
      const auth = (renewed.json?.auth ?? null) as { lease_duration?: number } | null;
      if (renewed.status === 200 && auth?.lease_duration) {
        entry.cached = { ...entry.cached, renewAt: Date.now() + auth.lease_duration * 1000 * RENEW_AT_FRACTION };
        return entry.cached.token;
      }
    }
    if (!entry.pending) {
      entry.pending = this.login().finally(() => {
        entry.pending = null;
      });
    }
    entry.cached = await entry.pending;
    return entry.cached.token;
  }

  /**
   * Authenticated request; on 403 one fresh login (Kubernetes) or token-file
   * re-read and a retry, because the token may have expired, been revoked or
   * been rotated. A 403 from a policy gap would otherwise mint a new token per
   * failing call, so a forced login happens only if nobody has replaced the
   * failing token yet and at most once per FORCED_LOGIN_MIN_INTERVAL_MS.
   */
  private async request(operation: string, method: string, path: string, body?: unknown) {
    const used = await this.token();
    let result = await this.raw(operation, method, path, body, used);
    if (result.status !== 403) return result;
    const entry = this.entry();
    let retryToken: string | null = null;
    if (entry.pending) {
      retryToken = (await entry.pending).token; // a concurrent caller is re-authenticating; share it
    } else if (entry.cached && entry.cached.token !== used) {
      retryToken = entry.cached.token; // a concurrent caller already re-authenticated
    } else if (Date.now() - entry.lastForcedLoginAt >= FORCED_LOGIN_MIN_INTERVAL_MS) {
      entry.lastForcedLoginAt = Date.now();
      retryToken = await this.token(true);
    }
    if (retryToken && retryToken !== used) {
      result = await this.raw(operation, method, path, body, retryToken);
    }
    return result;
  }

  private kv(kind: "data" | "metadata" | "delete", path: string) {
    return `${this.config.mount}/${kind}/${path}`;
  }

  async writeMetadata(path: string, body: { max_versions: number }) {
    const result = await this.request("writeMetadata", "POST", this.kv("metadata", path), body);
    if (result.status !== 204 && result.status !== 200) throw vaultError("writeMetadata", result.status, errorText(result.json, result.text));
  }

  async readMetadata(path: string): Promise<VaultKvMetadata | null> {
    const result = await this.request("readMetadata", "GET", this.kv("metadata", path));
    if (result.status === 404) return null;
    if (result.status !== 200) throw vaultError("readMetadata", result.status, errorText(result.json, result.text));
    const data = (result.json?.data ?? {}) as { current_version?: number; max_versions?: number; versions?: Record<string, { deletion_time?: string; destroyed?: boolean }> };
    const versions: VaultKvMetadata["versions"] = {};
    for (const [version, meta] of Object.entries(data.versions ?? {})) {
      versions[version] = { deleted: Boolean(meta.deletion_time), destroyed: meta.destroyed === true };
    }
    return { currentVersion: data.current_version ?? 0, maxVersions: data.max_versions ?? 0, versions };
  }

  async writeData(path: string, data: Record<string, string>, cas: number | null) {
    const body = cas === null ? { data } : { options: { cas }, data };
    const result = await this.request("writeData", "POST", this.kv("data", path), body);
    const version = (result.json?.data as { version?: number } | undefined)?.version;
    if (result.status !== 200 || typeof version !== "number") throw vaultError("writeData", result.status, errorText(result.json, result.text));
    return { version };
  }

  async readData(path: string, version: number | null) {
    const query = version === null ? "" : `?version=${version}`;
    const result = await this.request("readData", "GET", `${this.kv("data", path)}${query}`);
    if (result.status === 404) return null;
    if (result.status !== 200) throw vaultError("readData", result.status, errorText(result.json, result.text));
    const outer = (result.json?.data ?? {}) as { data?: Record<string, unknown> | null; metadata?: { version?: number; deletion_time?: string; destroyed?: boolean } };
    if (!outer.data || outer.metadata?.destroyed || outer.metadata?.deletion_time) return null;
    return { data: outer.data, version: outer.metadata?.version ?? version ?? 0 };
  }

  async softDeleteVersions(path: string, versions: number[]) {
    if (versions.length === 0) return;
    const result = await this.request("softDelete", "POST", this.kv("delete", path), { versions });
    if (result.status !== 204 && result.status !== 200) throw vaultError("softDelete", result.status, errorText(result.json, result.text));
  }

  async revokeSelf(): Promise<boolean> {
    const entry = loginCache.get(authKey(this.config));
    if (!entry?.cached || this.config.authMethod !== "kubernetes") return false;
    const token = entry.cached.token;
    entry.cached = null;
    const result = await this.raw("revokeSelf", "POST", "auth/token/revoke-self", {}, token);
    return result.status === 204 || result.status === 200;
  }
}

function errorText(json: Record<string, unknown> | null, text: string): string {
  const errors = json?.errors;
  if (Array.isArray(errors) && errors.length > 0) return errors.map(String).join("; ");
  return text.slice(0, 500);
}

/**
 * Revoke the server's cached Vault login token at shutdown. A Kubernetes-auth
 * token otherwise stays valid until its TTL; revoking it on SIGTERM keeps a
 * crashed-or-replaced pod's token from outliving the pod.
 */
export async function revokeVaultLoginForShutdown(timeoutMs = 5_000): Promise<"revoked" | "none" | "failed"> {
  // Let in-flight logins land first so their tokens are revoked too.
  await Promise.allSettled([...loginCache.values()].map((entry) => entry.pending).filter(Boolean));
  // Every cached login (one per allowed namespace), not just the env default.
  const entries = [...loginCache.values()].filter((entry) => entry.cached && entry.config.authMethod === "kubernetes");
  if (entries.length === 0) return "none";
  const results = await Promise.all(
    entries.map((entry) =>
      new VaultHttpGateway({ ...entry.config, timeoutMs }).revokeSelf().catch(() => false),
    ),
  );
  return results.every(Boolean) ? "revoked" : "failed";
}

/** Test hook: forget cached logins and health results. */
export function resetVaultProviderCachesForTests() {
  loginCache.clear();
  healthCache.clear();
}

const healthCache = new Map<string, { result: SecretProviderHealthCheck; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function vaultDescriptor() {
  return {
    id: "vault" as const,
    label: "HashiCorp Vault",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: true,
    supportsExternalValueWrites: false,
    configured: getVaultConfigReadiness().ready,
  };
}

export function createVaultProvider(options?: {
  config?: VaultProviderConfig;
  gateway?: VaultKvGateway;
}): SecretProviderModule {
  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null): VaultProviderConfig {
    return applyProviderVaultConfig(options?.config ?? loadVaultProviderConfig(), providerConfig);
  }

  function resolveGateway(config: VaultProviderConfig): VaultKvGateway {
    return options?.gateway ?? new VaultHttpGateway(config);
  }

  function managedMaterial(config: VaultProviderConfig, path: string, version: number): VaultMaterial {
    return { scheme: VAULT_SCHEME, mount: config.mount, path, kvVersion: version, source: "managed" };
  }

  function assertCompanyPath(config: VaultProviderConfig, material: VaultMaterial, companyId: string | undefined) {
    if (material.mount !== config.mount || !isWithin(material.path, config.prefix)) {
      throw unprocessable("Managed Vault secret path is outside the deployment's managed prefix");
    }
    // Fail closed: a managed read or delete without a company is never allowed.
    if (!companyId || !isWithin(material.path, companyRoot(config, companyId))) {
      throw unprocessable("Managed Vault secret path does not belong to this company");
    }
  }

  async function writeManagedValue(
    operation: "createSecret" | "createVersion",
    input: { value: string; context?: SecretProviderWriteContext; providerConfig?: SecretProviderVaultRuntimeConfig | null; externalRef?: string | null },
  ): Promise<PreparedSecretVersion> {
    const config = resolveConfig(input.providerConfig);
    const gateway = resolveGateway(config);
    const path = managedSecretPath(config, input.context);
    const ref = `${config.mount}/${path}`;
    if (operation === "createVersion" && input.externalRef && input.externalRef !== ref) {
      throw unprocessable("Managed Vault secret ref drifted from its derived path");
    }
    let cas = 0;
    if (operation === "createSecret") {
      // Metadata first, so the version cap is in place before the first
      // version exists (a high-churn secret must never fall back to the
      // mount default of 10 versions).
      await gateway.writeMetadata(path, { max_versions: config.maxVersions });
    } else {
      const metadata = await gateway.readMetadata(path);
      if (!metadata) throw vaultError(operation, 404, "managed secret metadata not found");
      cas = metadata.currentVersion;
    }
    const { version } = await gateway.writeData(path, { value: input.value }, cas);
    const valueSha256 = sha256(input.value);
    return {
      material: managedMaterial(config, path, version),
      valueSha256,
      fingerprintSha256: valueSha256,
      externalRef: ref,
      providerVersionRef: String(version),
    };
  }

  function externalMaterial(config: VaultProviderConfig, path: string, field: string, version: number | null): VaultMaterial {
    return { scheme: VAULT_SCHEME, mount: config.mount, path, kvVersion: version, source: "external_reference", field };
  }

  async function validateConfig(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.deploymentMode === "authenticated" && input.strictMode !== true) {
      warnings.push("Strict secret mode should be enabled for authenticated deployments");
    }
    const config = resolveConfig(input?.providerConfig);
    if (config.address.startsWith("http://") && !/^http:\/\/[^/]*\.svc(\.cluster\.local)?(:\d+)?$/.test(config.address)) {
      warnings.push("PAPERCLIP_SECRETS_VAULT_ADDR uses plain http outside the cluster network");
    }
    return { ok: true, warnings };
  }

  async function healthCheck(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderHealthCheck> {
    const readiness = getVaultConfigReadiness();
    if (!options?.config && !readiness.ready) {
      return {
        provider: "vault",
        status: "warn",
        message: `HashiCorp Vault provider is not ready: missing ${readiness.missingConfig.join(", ")}.`,
        warnings: ["Managed secret create/rotate/resolve calls will fail until the Vault provider is configured."],
        details: {
          missingConfig: readiness.missingConfig,
          requiredConfig: ["PAPERCLIP_SECRETS_VAULT_ADDR", "PAPERCLIP_SECRETS_VAULT_PREFIX", "PAPERCLIP_SECRETS_VAULT_K8S_ROLE (or AUTH_METHOD=token_file + TOKEN_FILE)"],
          optionalConfig: [
            "PAPERCLIP_SECRETS_VAULT_MOUNT", "PAPERCLIP_SECRETS_VAULT_NAMESPACE", "PAPERCLIP_SECRETS_VAULT_K8S_MOUNT",
            "PAPERCLIP_SECRETS_VAULT_K8S_JWT_PATH", "PAPERCLIP_SECRETS_VAULT_TIMEOUT_MS", "PAPERCLIP_SECRETS_VAULT_MAX_VERSIONS",
            "PAPERCLIP_SECRETS_VAULT_EXTERNAL_PATHS",
          ],
        },
      };
    }
    let cacheKey: string | null = null;
    try {
      const validation = await validateConfig(input);
      const config = resolveConfig(input?.providerConfig);
      cacheKey = [authKey(config), config.mount, config.prefix].join("|");
      const hit = healthCache.get(cacheKey);
      if (hit && Date.now() < hit.expiresAt) return hit.result;
      const gateway = resolveGateway(config);
      // Canary written exactly like a managed secret (metadata first), then
      // read back: proves login, write, read and the version cap together.
      const canaryPath = `${config.prefix}/_health/${sha256(`${process.env.HOSTNAME ?? "paperclip"}`).slice(0, 12)}`;
      await gateway.writeMetadata(canaryPath, { max_versions: HEALTH_CANARY_MAX_VERSIONS });
      const stamp = new Date().toISOString();
      await gateway.writeData(canaryPath, { checked_at: stamp }, null);
      const read = await gateway.readData(canaryPath, null);
      const metadata = await gateway.readMetadata(canaryPath);
      if (read?.data.checked_at !== stamp) throw vaultError("healthCheck", 500, "canary read-back did not match the write");
      if (metadata?.maxVersions !== HEALTH_CANARY_MAX_VERSIONS) {
        throw vaultError("healthCheck", 500, "canary max_versions was not applied; the Vault role may lack metadata update");
      }
      const result: SecretProviderHealthCheck = {
        provider: "vault",
        status: validation.warnings.length > 0 ? "warn" : "ok",
        message: "HashiCorp Vault is reachable; the server's Vault role can write, read and cap versions under the managed prefix.",
        warnings: validation.warnings,
        details: {
          address: config.address,
          mount: config.mount,
          prefix: config.prefix,
          namespace: config.namespace,
          authMethod: config.authMethod,
          maxVersions: config.maxVersions,
          externalPaths: config.externalPrefixes,
          probedAt: new Date().toISOString(), // results are cached; this is when Vault was actually probed
        },
        backupGuidance: [
          "Back up Vault (its storage) as well as the Paperclip database: Vault holds the only copy of managed values.",
          "Restoring access requires the same Vault mount, prefix and a Kubernetes auth role bound to the server's ServiceAccount.",
        ],
      };
      healthCache.set(cacheKey, { result, expiresAt: Date.now() + HEALTH_CACHE_OK_MS });
      return result;
    } catch (error) {
      const message = error instanceof SecretProviderClientError ? error.message : error instanceof Error ? error.message : String(error);
      const result: SecretProviderHealthCheck = {
        provider: "vault",
        status: "error",
        message: `HashiCorp Vault health check failed: ${message}`,
        warnings: [],
        details: {
          code: error instanceof SecretProviderClientError ? error.code : "provider_error",
          operation: error instanceof SecretProviderClientError ? error.operation : null,
          probedAt: new Date().toISOString(),
        },
      };
      if (cacheKey) healthCache.set(cacheKey, { result, expiresAt: Date.now() + HEALTH_CACHE_ERROR_MS });
      return result;
    }
  }

  return {
    id: "vault",
    descriptor() {
      return vaultDescriptor();
    },
    validateConfig,
    async createSecret(input) {
      if (input.externalRef?.trim()) throw unprocessable("Managed Vault secrets cannot override their path");
      return writeManagedValue("createSecret", input);
    },
    async createVersion(input) {
      return writeManagedValue("createVersion", input);
    },
    async linkExternalSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const { path, field } = parseExternalRef(config, input.externalRef);
      const version = input.providerVersionRef?.trim() ? Number(input.providerVersionRef) : null;
      if (version !== null && (!Number.isInteger(version) || version <= 0)) {
        throw unprocessable("Vault providerVersionRef must be a positive KV version number");
      }
      const externalRef = `${path}#${field}`;
      const fingerprint = sha256(`vault:${config.mount}/${externalRef}:${version ?? ""}`);
      return {
        material: externalMaterial(config, path, field, version),
        valueSha256: fingerprint,
        fingerprintSha256: fingerprint,
        externalRef,
        providerVersionRef: version === null ? null : String(version),
      };
    },
    async resolveVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const material = asVaultMaterial(input.material);
      if (material.source === "managed") {
        assertCompanyPath(config, material, input.context?.companyId);
        const version = Number(input.providerVersionRef ?? material.kvVersion);
        if (!Number.isInteger(version) || version <= 0) throw unprocessable("Managed Vault material has no KV version");
        const read = await gateway.readData(material.path, version);
        const value = read?.data.value;
        if (typeof value !== "string") {
          throw vaultError("resolveVersion", 404, `KV version ${version} is deleted, pruned or empty`);
        }
        return value;
      }
      // External references: re-validate against the deployment's current
      // allowlist on every read, then read the requested (or latest) version.
      const { path, field } = parseExternalRef(config, `${material.path}#${material.field ?? ""}`);
      const read = await gateway.readData(path, material.kvVersion ?? null);
      const value = read?.data[field];
      if (typeof value !== "string" || value === "") {
        throw vaultError("resolveVersion", 404, `external Vault field ${field} is missing or empty`);
      }
      return value;
    },
    async deleteOrArchive(input) {
      if (!input.material || typeof input.material !== "object") return;
      const material = asVaultMaterial(input.material);
      if (material.source !== "managed") return; // external refs are metadata-only in Paperclip
      const config = resolveConfig(input.providerConfig);
      assertCompanyPath(config, material, input.context?.companyId);
      const gateway = resolveGateway(config);
      // Soft delete only: Paperclip never calls destroy. Deleted versions stay
      // recoverable with `vault kv undelete` until an operator purges them or
      // they fall out of the max_versions window (Vault prunes the oldest).
      if (input.mode === "archive") {
        if (material.kvVersion) await gateway.softDeleteVersions(material.path, [material.kvVersion]);
        return;
      }
      const metadata = await gateway.readMetadata(material.path);
      if (!metadata) return;
      const live = Object.entries(metadata.versions)
        .filter(([, meta]) => !meta.deleted && !meta.destroyed)
        .map(([version]) => Number(version));
      await gateway.softDeleteVersions(material.path, live);
    },
    healthCheck,
  };
}

export const vaultProvider = createVaultProvider();
