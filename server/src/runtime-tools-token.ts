import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyLocalAgentJwt } from "./agent-auth-jwt.js";
import { resolvePaperclipInstanceId } from "./home-paths.js";

export interface RuntimeToolsTokenClaims {
  sub: string;
  company_id: string;
  run_id: string;
  responsible_user_id: string;
  scope: "connection_intents" | "github_credentials";
  iat: number;
  exp: number;
  instance_id: string;
}

const TOKEN_TTL_SECONDS = 60 * 60;

function secret() {
  return process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || null;
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(value: string, companyId: string, instanceId: string) {
  const master = secret();
  if (!master) return null;
  const key = createHmac("sha256", master)
    .update(`runtime-tools:${instanceId}:${companyId}`)
    .digest();
  return createHmac("sha256", key).update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRuntimeToolsToken(input: {
  agentId: string;
  companyId: string;
  runId: string;
  responsibleUserId: string;
  scope?: RuntimeToolsTokenClaims["scope"];
}) {
  if (!secret()) return null;
  const now = Math.floor(Date.now() / 1000);
  const instanceId = resolvePaperclipInstanceId();
  const claims: RuntimeToolsTokenClaims = {
    sub: input.agentId,
    company_id: input.companyId,
    run_id: input.runId,
    responsible_user_id: input.responsibleUserId,
    scope: input.scope ?? "connection_intents",
    iat: now,
    // Broker tokens remain scoped to a live run, which is rechecked on every use.
    exp: now + (input.scope === "github_credentials" ? 30 * 24 * 60 * 60 : TOKEN_TTL_SECONDS),
    instance_id: instanceId,
  };
  const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = sign(signingInput, input.companyId, instanceId);
  return signature
    ? { token: `${signingInput}.${signature}`, expiresAt: new Date(claims.exp * 1000).toISOString() }
    : null;
}

export type RuntimeToolsTokenFailure =
  | "empty" | "not_jwt" | "unparseable" | "bad_alg" | "instance_mismatch" | "no_secret" | "bad_signature"
  | "claims" | "scope_mismatch" | "expired" | "agent_api_key";


/**
 * Why verifyRuntimeToolsToken rejected a token, for server logs only (never returned to the caller): the public
 * error stays "missing, invalid, or expired", but an operator must be able to tell an absent token from an expired
 * or foreign-signed one. Unverified claim values are reported only as shapes (run id, exp delta), never the token.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function explainRuntimeToolsTokenFailure(token: string, scope: RuntimeToolsTokenClaims["scope"] = "connection_intents"): {
  reason: RuntimeToolsTokenFailure | null; length: number; runId?: string; expiredSecondsAgo?: number; scope?: unknown;
} {
  const length = token.length;
  if (!token) return { reason: "empty", length };
  const parts = token.split(".");
  if (parts.length !== 3) return { reason: "not_jwt", length };
  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { reason: "unparseable", length };
  }
  if (!isRecord(header) || !isRecord(claims)) return { reason: "unparseable", length };
  // Unverified until the signature check below: bounded so a forged token cannot plant long strings in logs.
  const runId = typeof claims.run_id === "string" ? claims.run_id.slice(0, 64) : undefined;
  if (header.alg !== "HS256") return { reason: "bad_alg", length, runId };
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const instanceId = typeof claims.instance_id === "string" ? claims.instance_id : null;
  if (!companyId || !instanceId || instanceId !== resolvePaperclipInstanceId()) return { reason: "instance_mismatch", length, runId };
  const expected = sign(`${parts[0]}.${parts[1]}`, companyId, instanceId);
  if (!expected) return { reason: "no_secret", length, runId };
  if (!safeEqual(parts[2]!, expected)) {
    // A genuine agent API key of this instance ($PAPERCLIP_API_KEY) is named as such so the caller can correct
    // itself. It is still rejected: agent API keys can carry a key_scope these endpoints do not enforce. Only a key
    // that verifies is named — a forged or foreign-instance token stays bad_signature.
    return { reason: verifyLocalAgentJwt(token) ? "agent_api_key" : "bad_signature", length, runId };
  }
  if (claims.scope !== scope) return { reason: "scope_mismatch", length, runId, scope: claims.scope };
  if (typeof claims.exp === "number" && claims.exp <= Math.floor(Date.now() / 1000)) {
    return { reason: "expired", length, runId, expiredSecondsAgo: Math.floor(Date.now() / 1000) - claims.exp };
  }
  if (verifyRuntimeToolsToken(token, scope)) return { reason: null, length, runId };
  return { reason: "claims", length, runId };
}

export function verifyRuntimeToolsToken(token: string, scope: RuntimeToolsTokenClaims["scope"] = "connection_intents"): RuntimeToolsTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // A JSON null/array/scalar header or claims set is malformed: reject it (401), never throw (500).
  if (!isRecord(header) || !isRecord(claims)) return null;
  if (header.alg !== "HS256") return null;
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const instanceId = typeof claims.instance_id === "string" ? claims.instance_id : null;
  if (!companyId || !instanceId || instanceId !== resolvePaperclipInstanceId()) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`, companyId, instanceId);
  if (!expected || !safeEqual(parts[2]!, expected)) return null;
  if (
    typeof claims.sub !== "string"
    || typeof claims.run_id !== "string"
    || typeof claims.responsible_user_id !== "string"
    || claims.scope !== scope
    || typeof claims.iat !== "number"
    || typeof claims.exp !== "number"
    || claims.exp <= Math.floor(Date.now() / 1000)
  ) return null;
  return claims as unknown as RuntimeToolsTokenClaims;
}
