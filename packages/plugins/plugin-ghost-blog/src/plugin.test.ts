/**
 * Drives the REAL tool handlers through a stub PluginContext whose http.fetch
 * is a scripted Ghost. The isolation property under test: a tool call uses
 * only the calling company's config and key.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildHandlers } from "./plugin.js";
import { mintAdminToken, parseAdminKey } from "./ghost.js";
import manifest, { ASK_FIRST_TOOLS, TOOL_NAMES } from "./manifest.js";

const KEY_B = "6a1b2c3d4e5f60718293a4b5:" + "ab".repeat(32);
const KEY_R = "7b2c3d4e5f60718293a4b5c6:" + "cd".repeat(32);
const PID = "65f0a1b2c3d4e5f601234567";
const CONFIGS: Record<string, unknown> = {
  "company-b": { siteUrl: "http://ghost-bionic.blog.svc.cluster.local:2368", adminApiKey: { type: "secret_ref", secretId: "sec-b" } },
  "company-r": { siteUrl: "http://ghost-reliora.blog.svc.cluster.local:2368", adminApiKey: { type: "secret_ref", secretId: "sec-r" } },
};
const SECRETS: Record<string, Record<string, string>> = { "company-b": { "sec-b": KEY_B }, "company-r": { "sec-r": KEY_R } };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function stubCtx(responder: (c: Call) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const ctx = {
    config: { get: async (companyId: string) => CONFIGS[companyId] ?? null },
    secrets: {
      resolve: async (ref: { secretId: string }, opts: { companyId: string }) => {
        const v = SECRETS[opts.companyId]?.[ref.secretId];
        if (!v) throw new Error("secret not bound to this company");
        return v;
      },
    },
    http: {
      fetch: async (url: string, init?: RequestInit) => {
        const c: Call = {
          url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(c);
        const r = responder(c);
        return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), { status: r.status });
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    manifest,
  } as never;
  return { ctx, calls };
}

const post = (extra: Record<string, unknown> = {}) => ({
  id: PID, title: "Hi", slug: "hi", status: "draft", url: "https://blog/p/hi/", updated_at: "2026-10-21T00:00:00.000Z",
  tags: [], authors: [{ name: "Blog Agent" }], ...extra,
});

function kidOf(call: Call) {
  const jwt = call.headers.Authorization.replace(/^Ghost /, "");
  return JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()).kid;
}

describe("company isolation", () => {
  it("each company's call goes to its own site with its own key", async () => {
    const { ctx, calls } = stubCtx(() => ({ status: 200, json: { site: { title: "T", url: "u" } } }));
    const h = buildHandlers(ctx);
    await h[TOOL_NAMES.siteInfo]({}, "company-b");
    await h[TOOL_NAMES.siteInfo]({}, "company-r");
    expect(calls[0]!.url).toMatch(/^http:\/\/ghost-bionic\.blog\.svc\.cluster\.local:2368\/ghost\/api\/admin\/site\//);
    expect(kidOf(calls[0]!)).toBe(KEY_B.split(":")[0]);
    expect(calls[1]!.url).toMatch(/^http:\/\/ghost-reliora\./);
    expect(kidOf(calls[1]!)).toBe(KEY_R.split(":")[0]);
  });

  it("tool arguments cannot redirect a call to another site", async () => {
    const { ctx, calls } = stubCtx(() => ({ status: 200, json: { site: { title: "T" } } }));
    await buildHandlers(ctx)[TOOL_NAMES.siteInfo]({ siteUrl: "http://ghost-reliora.blog.svc.cluster.local:2368" }, "company-b");
    expect(calls[0]!.url).toMatch(/ghost-bionic/);
  });

  it("an unconfigured company gets a configuration error and no HTTP call", async () => {
    const { ctx, calls } = stubCtx(() => ({ status: 200 }));
    await expect(buildHandlers(ctx)[TOOL_NAMES.siteInfo]({}, "company-x")).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
  });

  it("ids that could escape the posts path are refused before any call", async () => {
    const { ctx, calls } = stubCtx(() => ({ status: 200 }));
    const h = buildHandlers(ctx);
    for (const id of ["../members/abc", "65f0a1b2c3d4e5f60123456?x=1", ""]) {
      for (const t of [TOOL_NAMES.getArticle, TOOL_NAMES.deleteArticle, TOOL_NAMES.publishArticle, TOOL_NAMES.unpublishArticle]) {
        await expect(h[t]({ id }, "company-b")).rejects.toThrow(/24-character hex/);
      }
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Ghost wire format", () => {
  it("mints a valid Admin JWT", () => {
    const tok = mintAdminToken(KEY_B, 1_700_000_000);
    const [h, p, s] = tok.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT", kid: KEY_B.split(":")[0] });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: 1_700_000_000, exp: 1_700_000_300, aud: "/admin/" });
    const want = createHmac("sha256", parseAdminKey(KEY_B).secret).update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(want);
  });

  it("create_draft: markdown card, draft status, Blog Agent byline, X-Forwarded-Proto", async () => {
    const { ctx, calls } = stubCtx((c) =>
      c.url.includes("/users/") ? { status: 200, json: { users: [{ id: "agent1" }] } } : { status: 201, json: { posts: [post()] } });
    const res = await buildHandlers(ctx)[TOOL_NAMES.createDraft]({ title: "Hi", markdown: "# Hi", tags: ["AI"] }, "company-b");
    const create = calls.find((c) => c.method === "POST")!;
    const sent = (create.body as { posts: Record<string, unknown>[] }).posts[0]!;
    expect(sent.status).toBe("draft");
    expect(sent.authors).toEqual([{ id: "agent1" }]);
    expect(sent.tags).toEqual([{ name: "AI" }]);
    expect(JSON.parse(String(sent.lexical)).root.children[0]).toEqual({ type: "markdown", version: 1, markdown: "# Hi" });
    expect(create.headers["X-Forwarded-Proto"]).toBe("https");
    expect((res.data as { warnings: string[] }).warnings).toEqual([]);
  });

  it("publish sends updated_at, never a newsletter, and reports a status mismatch as an error", async () => {
    const { ctx, calls } = stubCtx((c) =>
      c.method === "GET" ? { status: 200, json: { posts: [post()] } } : { status: 200, json: { posts: [post({ status: "draft" })] } });
    const res = await buildHandlers(ctx)[TOOL_NAMES.publishArticle]({ id: PID }, "company-b");
    const put = calls.find((c) => c.method === "PUT")!;
    expect((put.body as { posts: Record<string, unknown>[] }).posts[0]).toEqual({ status: "published", updated_at: "2026-10-21T00:00:00.000Z" });
    expect(put.url).not.toMatch(/newsletter/);
    expect(res.error).toMatch(/expected 'published'/);
  });

  it("surfaces Ghost errors and refuses redirects", async () => {
    const { ctx } = stubCtx(() => ({ status: 401, json: { errors: [{ message: "Invalid token", type: "UnauthorizedError" }] } }));
    await expect(buildHandlers(ctx)[TOOL_NAMES.siteInfo]({}, "company-b")).rejects.toThrow(/HTTP 401 UnauthorizedError: Invalid token/);
  });
});

describe("manifest", () => {
  it("declares exactly the handled tools and the ask-first set", () => {
    const { ctx } = stubCtx(() => ({ status: 200 }));
    expect(Object.keys(buildHandlers(ctx)).sort()).toEqual(manifest.tools!.map((t) => t.name).sort());
    expect([...ASK_FIRST_TOOLS].sort()).toEqual(["delete_article", "publish_article", "unpublish_article"]);
  });
});
