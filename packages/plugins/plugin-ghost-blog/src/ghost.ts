/**
 * Minimal Ghost Admin API client (Ghost 6).
 *
 * Auth is a short-lived HS256 JWT minted per request from the integration's
 * Admin API key ("id:hexsecret"): kid = id, aud = "/admin/", 5-minute expiry.
 * The transport is injected (the plugin passes ctx.http.fetch, which the host
 * audits and confines), so this module is testable without a network.
 */
import { createHmac } from "node:crypto";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GhostError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly errorType = "",
  ) {
    super(status === null ? message : `HTTP ${status}${errorType ? ` ${errorType}` : ""}: ${message}`);
  }
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function parseAdminKey(key: string): { id: string; secret: Buffer } {
  const [id, secret, ...rest] = key.trim().split(":");
  if (!id || !secret || rest.length || !/^[0-9a-f]+$/i.test(secret) || secret.length % 2) {
    throw new GhostError(null, "the Admin API key must be 'id:hexsecret' (a Ghost custom integration key)");
  }
  return { id, secret: Buffer.from(secret, "hex") };
}

export function mintAdminToken(key: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const { id, secret } = parseAdminKey(key);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds, exp: nowSeconds + 300, aud: "/admin/" }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

export interface GhostSite {
  siteUrl: string;
  adminApiKey: string;
  forwardedProto: "https" | "none";
}

export async function ghostRequest(
  fetchImpl: FetchLike,
  site: GhostSite,
  method: string,
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  if (!/^\/[a-z0-9/_-]*\/$/.test(path)) throw new GhostError(null, `refusing unexpected API path ${path}`);
  const url = new URL(site.siteUrl.replace(/\/+$/, "") + "/ghost/api/admin" + path);
  for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    Authorization: `Ghost ${mintAdminToken(site.adminApiKey)}`,
    "Accept-Version": "v6.0",
  };
  if (site.forwardedProto === "https") headers["X-Forwarded-Proto"] = "https";
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { method, headers, body, redirect: "manual" });
  } catch (error) {
    throw new GhostError(null, `cannot reach the blog: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status === 204) return {};
  if (res.status >= 300 && res.status < 400) {
    throw new GhostError(res.status, `unexpected redirect to ${res.headers.get("location") ?? "?"} (check siteUrl / forwardedProto)`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* handled below */
  }
  if (res.status >= 400) {
    const err = (json as { errors?: Array<{ message?: string; type?: string; context?: string }> } | null)?.errors?.[0];
    throw new GhostError(res.status, [err?.message, err?.context].filter(Boolean).join(" — ") || text.slice(0, 300) || "no body", err?.type ?? "");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new GhostError(res.status, "response was not a JSON object");
  return json as Record<string, unknown>;
}

/** Lexical document holding one Markdown card (Ghost renders it). */
export function markdownLexical(markdown: string): string {
  return JSON.stringify({
    root: {
      children: [{ type: "markdown", version: 1, markdown }],
      direction: null, format: "", indent: 0, type: "root", version: 1,
    },
  });
}

export interface ArticleSummary {
  id: string;
  title: string;
  slug: string;
  status: string;
  url: string | null;
  publishedAt: string | null;
  updatedAt: string;
  tags: string[];
  authors: string[];
  excerpt: string | null;
}

export function summarize(p: Record<string, unknown>): ArticleSummary {
  const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => String((x as { name?: unknown })?.name ?? "")) : []);
  return {
    id: String(p.id),
    title: String(p.title ?? ""),
    slug: String(p.slug ?? ""),
    status: String(p.status ?? ""),
    url: (p.url as string) ?? null,
    publishedAt: (p.published_at as string) ?? null,
    updatedAt: String(p.updated_at ?? ""),
    tags: names(p.tags),
    authors: names(p.authors),
    excerpt: ((p.custom_excerpt ?? p.excerpt) as string) ?? null,
  };
}
