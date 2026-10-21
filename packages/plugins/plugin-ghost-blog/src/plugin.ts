/**
 * Ghost blog connector worker.
 *
 * Isolation model: every tool call loads the configuration of the CALLING
 * agent's company (runCtx.companyId) and nothing else. The site URL and the
 * Admin API key come only from that configuration — never from tool
 * arguments — so an agent cannot point a call at another company's blog.
 */
import { definePlugin, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { GhostError, ghostRequest, markdownLexical, summarize, type GhostSite } from "./ghost.js";
import { TOOL_NAMES } from "./manifest.js";

export class ConfigError extends Error {}

const POST_ID = /^[0-9a-f]{24}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface GhostBlogConfig {
  siteUrl: string;
  publicUrl: string | null;
  siteName: string | null;
  adminApiKey: unknown;
  agentEmail: string;
  forwardedProto: "https" | "none";
}

function agentEmailOf(value: unknown): string {
  const email = typeof value === "string" && value.trim() ? value.trim() : "blog-agent@baisoln.com";
  // Interpolated into Ghost's NQL filter email:'...': refuse anything that could break out.
  if (!/^[^\s'"\\@]+@[^\s'"\\@]+$/.test(email)) throw new ConfigError(`agentEmail is not a plain email address: ${email}`);
  return email;
}

export function parseConfig(raw: unknown): GhostBlogConfig {
  if (!isRecord(raw) || typeof raw.siteUrl !== "string" || !raw.siteUrl.trim()) {
    throw new ConfigError(
      "The Ghost blog is not configured for this company. An instance admin must save the plugin configuration (siteUrl and adminApiKey) for it.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw.siteUrl);
  } catch {
    throw new ConfigError(`siteUrl is not a valid URL: ${raw.siteUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError("siteUrl must be http(s)");
  if (raw.adminApiKey === undefined || raw.adminApiKey === null || raw.adminApiKey === "") {
    throw new ConfigError("adminApiKey is not configured for this company");
  }
  return {
    siteUrl: raw.siteUrl.trim(),
    publicUrl: typeof raw.publicUrl === "string" ? raw.publicUrl : null,
    siteName: typeof raw.siteName === "string" ? raw.siteName : null,
    adminApiKey: raw.adminApiKey,
    agentEmail: agentEmailOf(raw.agentEmail),
    forwardedProto: raw.forwardedProto === "none" ? "none" : "https",
  };
}

/** Resolve the configured key: a secret_ref binding (preferred) or a pasted literal. */
export async function resolveAdminKey(ctx: PluginContext, value: unknown, companyId: string): Promise<string> {
  const binding = isRecord(value) && (value.type === "secret_ref" || typeof value.secretId === "string") ? value : null;
  if (binding) {
    const secretId = String(binding.secretId ?? "").trim();
    let resolved: string | null | undefined;
    try {
      resolved = await ctx.secrets.resolve(
        { type: "secret_ref", secretId, version: (binding.version as "latest" | number | undefined) ?? "latest" },
        { companyId, configPath: "adminApiKey" },
      );
    } catch (error) {
      throw new ConfigError(
        `adminApiKey could not be resolved from Paperclip secrets (${error instanceof Error ? error.message : String(error)}). Re-pick the saved secret in the Ghost Blog settings.`,
      );
    }
    if (!resolved) throw new ConfigError("adminApiKey resolved to an empty value");
    return resolved;
  }
  throw new ConfigError(
    typeof value === "string" && UUID_RE.test(value.trim())
      ? "adminApiKey holds a bare secret id; pick the saved secret so it is stored as a secret_ref binding"
      : "adminApiKey must be a saved Paperclip secret (secret_ref); plaintext keys are not accepted",
  );
}

async function siteFor(ctx: PluginContext, companyId: string): Promise<{ site: GhostSite; config: GhostBlogConfig }> {
  const config = parseConfig(await ctx.config.get(companyId));
  const adminApiKey = await resolveAdminKey(ctx, config.adminApiKey, companyId);
  return { config, site: { siteUrl: config.siteUrl, adminApiKey, forwardedProto: config.forwardedProto } };
}

function requireId(params: Record<string, unknown>): string {
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!POST_ID.test(id)) throw new ConfigError("`id` must be a 24-character hex Ghost post id");
  return id;
}

function postFields(p: Record<string, unknown>): Record<string, unknown> {
  if (typeof p.markdown === "string" && typeof p.html === "string") throw new ConfigError("pass markdown OR html, not both");
  const out: Record<string, unknown> = {};
  if (typeof p.title === "string") out.title = p.title;
  if (typeof p.excerpt === "string") out.custom_excerpt = p.excerpt;
  if (typeof p.featureImage === "string") out.feature_image = p.featureImage;
  if (typeof p.metaTitle === "string") out.meta_title = p.metaTitle;
  if (typeof p.metaDescription === "string") out.meta_description = p.metaDescription;
  if (Array.isArray(p.tags)) out.tags = p.tags.filter((t) => typeof t === "string").map((name) => ({ name }));
  if (typeof p.markdown === "string") out.lexical = markdownLexical(p.markdown);
  if (typeof p.html === "string") out.html = p.html;
  return out;
}

async function run(ctx: PluginContext, tool: string, companyId: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof GhostError) return { error: error.message };
    ctx.logger.error(`ghost-blog ${tool} failed`, { companyId, error: error instanceof Error ? error.message : String(error) });
    return { error: `unexpected error in ${tool}` };
  }
}

const ok = (content: string, data: unknown): ToolResult => ({ content, data });

/** Exported for tests: the tool handlers, keyed by tool name. */
export function buildHandlers(ctx: PluginContext) {
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
  const call = (site: GhostSite, method: string, path: string, opts?: Parameters<typeof ghostRequest>[4]) =>
    ghostRequest(fetchImpl, site, method, path, opts);
  const current = async (site: GhostSite, id: string) =>
    ((await call(site, "GET", `/posts/${id}/`)).posts as Record<string, unknown>[])[0]!;

  return {
    [TOOL_NAMES.siteInfo]: async (_p: Record<string, unknown>, companyId: string) => {
      const { site } = await siteFor(ctx, companyId);
      const s = (await call(site, "GET", "/site/")).site as Record<string, unknown>;
      return ok(`${s.title} (${s.url})`, { title: s.title, description: s.description, url: s.url, version: s.version });
    },
    [TOOL_NAMES.listArticles]: async (p: Record<string, unknown>, companyId: string) => {
      const { site } = await siteFor(ctx, companyId);
      const filters: string[] = [];
      if (p.status !== undefined) {
        if (!["draft", "published", "scheduled"].includes(String(p.status))) throw new ConfigError("status must be draft, published or scheduled");
        filters.push(`status:${p.status}`);
      }
      if (p.tag !== undefined) {
        if (!SLUG.test(String(p.tag))) throw new ConfigError("tag must be a slug (lowercase letters, digits, hyphens)");
        filters.push(`tag:${p.tag}`);
      }
      const res = await call(site, "GET", "/posts/", {
        query: {
          limit: Math.min(Math.max(Number(p.limit ?? 15) || 15, 1), 100),
          page: Math.max(Number(p.page ?? 1) || 1, 1),
          include: "tags,authors",
          order: "updated_at desc",
          filter: filters.length ? filters.join("+") : undefined,
        },
      });
      const posts = ((res.posts as Record<string, unknown>[]) ?? []).map(summarize);
      return ok(`${posts.length} article(s)`, { articles: posts, pagination: (res.meta as Record<string, unknown>)?.pagination ?? null });
    },
    [TOOL_NAMES.getArticle]: async (p: Record<string, unknown>, companyId: string) => {
      const id = requireId(p);
      const { site } = await siteFor(ctx, companyId);
      const post = ((await call(site, "GET", `/posts/${id}/`, { query: { include: "tags,authors", formats: "html" } })).posts as Record<string, unknown>[])[0]!;
      return ok(String(post.title ?? ""), { ...summarize(post), html: post.html ?? null });
    },
    [TOOL_NAMES.createDraft]: async (p: Record<string, unknown>, companyId: string) => {
      if (typeof p.title !== "string" || !p.title.trim()) throw new ConfigError("`title` is required");
      const { site, config } = await siteFor(ctx, companyId);
      const fields = { ...postFields(p), status: "draft" };
      const users = ((await call(site, "GET", "/users/", { query: { filter: `email:'${config.agentEmail}'`, fields: "id" } })).users as Record<string, unknown>[]) ?? [];
      const warnings: string[] = [];
      if (users[0]?.id) (fields as Record<string, unknown>).authors = [{ id: users[0].id }];
      else warnings.push(`no staff user ${config.agentEmail} on this blog; credited to the site owner`);
      const res = await call(site, "POST", "/posts/", {
        query: { include: "tags,authors", ...(typeof p.html === "string" ? { source: "html" } : {}) },
        body: { posts: [fields] },
      });
      const post = summarize((res.posts as Record<string, unknown>[])[0]!);
      return ok(`Draft "${post.title}" created (${post.id})`, { article: post, warnings });
    },
    [TOOL_NAMES.updateArticle]: async (p: Record<string, unknown>, companyId: string) => {
      const id = requireId(p);
      const fields = postFields(p);
      if (Object.keys(fields).length === 0) throw new ConfigError("nothing to update: pass at least one field");
      const { site } = await siteFor(ctx, companyId);
      const prev = await current(site, id);
      if (prev.status !== "draft") {
        throw new ConfigError(
          `article ${id} is '${String(prev.status)}', not a draft. Live content changes need approval: use the Ghost blog connection or Ghost admin.`,
        );
      }
      const res = await call(site, "PUT", `/posts/${id}/`, {
        query: { include: "tags,authors", ...(typeof p.html === "string" ? { source: "html" } : {}) },
        body: { posts: [{ ...fields, updated_at: prev.updated_at }] },
      });
      const post = summarize((res.posts as Record<string, unknown>[])[0]!);
      return ok(`Updated "${post.title}"`, { article: post });
    },
    [TOOL_NAMES.listTags]: async (_p: Record<string, unknown>, companyId: string) => {
      const { site } = await siteFor(ctx, companyId);
      const tags = ((await call(site, "GET", "/tags/", { query: { limit: "all", include: "count.posts" } })).tags as Record<string, unknown>[]) ?? [];
      return ok(`${tags.length} tag(s)`, {
        tags: tags.map((t) => ({ name: t.name, slug: t.slug, posts: (t.count as Record<string, unknown> | undefined)?.posts ?? null })),
      });
    },
  };

}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx: PluginContext): Promise<void> {
    const handlers = buildHandlers(ctx);
    for (const tool of ctx.manifest.tools ?? []) {
      const handler = handlers[tool.name as keyof typeof handlers];
      if (!handler) throw new Error(`no handler for declared tool ${tool.name}`);
      ctx.tools.register(
        tool.name,
        { displayName: tool.displayName, description: tool.description, parametersSchema: tool.parametersSchema },
        async (params, runCtx): Promise<ToolResult> =>
          run(ctx, tool.name, runCtx.companyId, () => handler(isRecord(params) ? params : {}, runCtx.companyId)),
      );
    }
    ctx.logger.info("Ghost blog connector ready", { tools: (ctx.manifest.tools ?? []).map((t) => t.name) });
  },

  async onHealth() {
    return { status: "ok", message: "Ghost blog connector loaded; per-company reachability shows on each tool call." };
  },
});

export default plugin;
