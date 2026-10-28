import { aiConnectionCatalogSlug, aiConnectionMetadataSchema, getAppDefinitionForUrl, type AppDefinition, type ToolApplication, type ToolConnection } from "@paperclipai/shared";
import { aiConnectionRouterSlug, aiConnectionRouterPluginKey } from "@paperclipai/shared";

export type AppGalleryDisplayEntry = AppDefinition & {
  key?: string;
  logoUrl?: string;
  tagline?: string;
  branding?: AppDefinition["branding"];
};

export function appDefinitionSlug(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.slug ?? entry?.key ?? "";
}

export function appDefinitionName(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.name ?? appDefinitionSlug(entry) ?? "App";
}

export function appDefinitionDescription(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.description ?? entry?.tagline ?? "";
}

export function appDefinitionLogoUrl(entry: AppGalleryDisplayEntry | null | undefined): string | undefined {
  return entry?.branding?.logoUrl ?? entry?.logoUrl;
}

export function appDefinitionDarkLogoUrl(entry: AppGalleryDisplayEntry | null | undefined): string | undefined {
  return entry?.branding?.darkLogoUrl;
}

export function appApplicationSourceSlug(application: ToolApplication | null | undefined): string | null {
  if (!application) return null;
  const metadata = application.metadata;
  const source = metadata?.sourceTemplateKey ?? metadata?.galleryKey;
  if (typeof source === "string" && source.trim()) return source.trim();
  const key = application.applicationKey?.trim();
  if (!key) return null;
  const router = key.match(/^plugin:(.+):ai-router$/);
  if (router) return aiConnectionRouterSlug(router[1]);
  const galleryPrefix = "app-gallery:";
  if (key.startsWith(galleryPrefix)) {
    const slug = key.slice(galleryPrefix.length).split(":")[0] || null;
    // Curated apps deliberately group multiple accounts by provider. Generic
    // URL apps use `link` only as a synthetic key, so grouping on it would make
    // every unrelated MCP server in the company look like the same app.
    return slug === "link" ? null : slug;
  }
  return key;
}

export function appConnectionSourceSlug(connection: ToolConnection | null | undefined): string | null {
  if (!connection) return null;
  if (connection.connectionPurpose === "ai") {
    const metadata = aiConnectionMetadataSchema.safeParse(connection.config?.ai);
    if (metadata.success) return aiConnectionCatalogSlug(metadata.data.provider, metadata.data.routing);
  }
  const router = aiConnectionRouterPluginKey(connection);
  if (router) return aiConnectionRouterSlug(router);
  const source = connection.config?.sourceTemplateKey ?? connection.transportConfig?.sourceTemplateKey;
  return typeof source === "string" && source.trim() ? source.trim() : null;
}

function connectionServerUrl(connection: ToolConnection | null | undefined): string | null {
  const url = connection?.config?.url ?? connection?.transportConfig?.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

/**
 * Last-resort match of a connection to a curated app by name. A custom
 * connection that only shares a curated app's name is not that app: a
 * connection named "TryPost" pointing at a self-hosted server must not pick up
 * the hosted app's methods, sign-in or reconnect target. So when the
 * connection has a server URL and the curated app lists URL patterns, the URL
 * has to match one of them.
 */
export function galleryEntryByName(
  apps: readonly AppGalleryDisplayEntry[],
  name: string | null | undefined,
  connection: ToolConnection | null | undefined,
): AppGalleryDisplayEntry | null {
  const wanted = name?.trim().toLowerCase();
  if (!wanted) return null;
  const candidate = apps.find((app) => appDefinitionName(app).toLowerCase() === wanted) ??
    apps.find((app) => appDefinitionSlug(app) === wanted) ??
    null;
  if (!candidate) return null;
  const url = connectionServerUrl(connection);
  if (!url || !candidate.urlPatterns?.length) return candidate;
  return getAppDefinitionForUrl(url, [candidate]) ? candidate : null;
}
