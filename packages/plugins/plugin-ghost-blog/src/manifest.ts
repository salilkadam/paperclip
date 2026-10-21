/**
 * Manifest for the Ghost blog connector.
 *
 * Installed once per instance; configured per company. Each company's
 * configuration names ITS OWN Ghost site and Admin API key, and every tool call
 * uses only the calling agent's company configuration — so a company's agents
 * can reach that company's blog and nothing else. Agents never choose the site
 * or see the key.
 */
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.ghost-blog";

export const TOOL_NAMES = {
  siteInfo: "site_info",
  listArticles: "list_articles",
  getArticle: "get_article",
  createDraft: "create_draft",
  updateArticle: "update_article",
  publishArticle: "publish_article",
  unpublishArticle: "unpublish_article",
  deleteArticle: "delete_article",
  listTags: "list_tags",
} as const;

/** Tools that should be "ask first" (approval before they run). */
export const ASK_FIRST_TOOLS = [
  TOOL_NAMES.publishArticle,
  TOOL_NAMES.unpublishArticle,
  TOOL_NAMES.deleteArticle,
] as const;

const id = { type: "string", pattern: "^[0-9a-f]{24}$", description: "Ghost post id (24 hex characters)." };
const body = {
  markdown: { type: "string", description: "Article body as Markdown (rendered by Ghost)." },
  html: { type: "string", description: "Article body as HTML. Pass markdown OR html, not both." },
  tags: { type: "array", items: { type: "string" }, description: "Tag names; missing tags are created." },
  excerpt: { type: "string", description: "Custom excerpt shown in lists and previews." },
  featureImage: { type: "string", description: "Feature image URL." },
  metaTitle: { type: "string", description: "SEO title." },
  metaDescription: { type: "string", description: "SEO description." },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Ghost Blog",
  description:
    "Write and manage articles on your company's Ghost blog. Each company uses its own site and key; agents only ever reach their own company's blog.",
  author: "Bionic AI Solutions",
  categories: ["connector"],
  capabilities: [
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      siteUrl: {
        type: "string",
        format: "uri",
        description:
          "Base URL the connector calls, e.g. http://ghost-bionic.blog.svc.cluster.local:2368 (in-cluster). A private host must also be listed for this plugin in PAPERCLIP_PLUGIN_HTTP_ALLOWED_PRIVATE_HOSTS.",
      },
      publicUrl: { type: "string", format: "uri", description: "Public URL of the blog, used in links returned to agents." },
      siteName: { type: "string", description: "Display name, e.g. `Bionic AI Solutions`." },
      adminApiKey: {
        type: ["string", "object"],
        format: "secret-ref",
        maxLength: 8192,
        description:
          "Admin API key of a Ghost custom integration (`id:secret`). Pick a saved Paperclip secret; only the reference is stored.",
      },
      agentEmail: {
        type: "string",
        format: "email",
        default: "blog-agent@baisoln.com",
        description: "Ghost staff user credited as the author of agent-written articles.",
      },
      forwardedProto: {
        type: "string",
        enum: ["https", "none"],
        default: "https",
        description: "Send X-Forwarded-Proto: https (needed when calling Ghost's in-cluster http address while its url is https).",
        "x-paperclip-advanced": true,
      },
    },
    required: ["siteUrl", "adminApiKey"],
    additionalProperties: false,
  },
  tools: [
    {
      name: TOOL_NAMES.siteInfo,
      displayName: "Blog: site info",
      description: "Your company's blog: title, description, URL and Ghost version.",
      parametersSchema: obj({}),
    },
    {
      name: TOOL_NAMES.listArticles,
      displayName: "Blog: list articles",
      description: "List articles on your company's blog, newest first.",
      parametersSchema: obj({
        status: { type: "string", enum: ["draft", "published", "scheduled"] },
        tag: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", description: "Tag slug." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 15 },
        page: { type: "integer", minimum: 1, default: 1 },
      }),
    },
    {
      name: TOOL_NAMES.getArticle,
      displayName: "Blog: get article",
      description: "One article with its rendered HTML, by id.",
      parametersSchema: obj({ id }, ["id"]),
    },
    {
      name: TOOL_NAMES.createDraft,
      displayName: "Blog: create draft",
      description: "Create a DRAFT article on your company's blog, credited to the Blog Agent. Use publish_article to make it live.",
      parametersSchema: obj({ title: { type: "string", minLength: 1 }, ...body }, ["title"]),
    },
    {
      name: TOOL_NAMES.updateArticle,
      displayName: "Blog: update article",
      description: "Change fields of an article. Passing markdown/html replaces the body; passing tags replaces the tags.",
      parametersSchema: obj({ id, title: { type: "string", minLength: 1 }, ...body }, ["id"]),
    },
    {
      name: TOOL_NAMES.publishArticle,
      displayName: "Blog: publish article",
      description: "Publish an article now, or schedule it with a future publishAt (ISO-8601 with timezone). Never sends a newsletter.",
      parametersSchema: obj({ id, publishAt: { type: "string", description: "e.g. 2026-11-01T09:00:00Z" } }, ["id"]),
    },
    {
      name: TOOL_NAMES.unpublishArticle,
      displayName: "Blog: unpublish article",
      description: "Take a published or scheduled article back to draft.",
      parametersSchema: obj({ id }, ["id"]),
    },
    {
      name: TOOL_NAMES.deleteArticle,
      displayName: "Blog: delete article",
      description: "Permanently delete an article. Prefer unpublish_article.",
      parametersSchema: obj({ id }, ["id"]),
    },
    {
      name: TOOL_NAMES.listTags,
      displayName: "Blog: list tags",
      description: "Tags on your company's blog with post counts.",
      parametersSchema: obj({}),
    },
  ],
};

export default manifest;
