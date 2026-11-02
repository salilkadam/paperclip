import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { checkOAuthEndpointUrl, type ToolUpstreamPending } from "@paperclipai/shared";
import { connectHubOrigin } from "@paperclipai/shared/aggregator-apps";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export interface RemoteMcpPendingOptions {
  /** The connection's configured endpoint. Connect Hub links are trusted only on its origin. */
  endpoint?: string | URL | null;
}

/** Recognize protocol/provider envelopes, never generic app-data statuses.
 * Links are navigation targets kept outside durable result/audit storage. */
export function extractRemoteMcpPending(value: unknown, provider?: string | null, toolName?: string, options: RemoteMcpPendingOptions = {}): ToolUpstreamPending | null {
  const root = record(value);
  if (!root) return null;
  const links = new Map<string, { url: string; host: string; elicitationId?: string }>();
  let pending: ToolUpstreamPending | null = null;
  const addLink = (url: unknown, id?: string) => {
    const checked = checkOAuthEndpointUrl(url);
    if (checked.ok && links.size < 8) links.set(checked.url, { url: checked.url, host: checked.host, ...(id ? { elicitationId: id } : {}) });
  };
  const urlElicitation = (value: unknown) => {
    const item = record(value);
    if (item?.mode !== "url" || typeof item.elicitationId !== "string") return;
    // A Connect Hub link is trusted only on the connection's own origin, whichever way the hub hands it over.
    if (provider === "connecthub") {
      const origin = connectHubOrigin(options.endpoint);
      const checked = checkOAuthEndpointUrl(item.url);
      if (!origin || !checked.ok || new URL(checked.url).origin !== origin) return;
    }
    pending ??= { kind: "authorization", links: [] };
    const id = item.elicitationId.slice(0, 512);
    addLink(item.url, id);
    if (links.size && !pending.elicitationId) pending.elicitationId = id;
  };
  if (root.method === "elicitation/create") urlElicitation(root.params);
  const error = record(root.error);
  const elicitations = record(error?.data)?.elicitations;
  if (error?.code === -32042 && Array.isArray(elicitations)) elicitations.slice(0, 8).forEach(urlElicitation);

  const result = record(root.result) ?? root;
  const payloads: Record<string, unknown>[] = [result];
  const structured = record(result.structuredContent);
  if (structured) payloads.push(structured);
  if (Array.isArray(result.content)) {
    for (const item of result.content.slice(0, 100)) {
      const content = record(item);
      if (content?.type !== "text" || typeof content.text !== "string" || content.text.length > 512_000) continue;
      try { const parsed = record(JSON.parse(content.text)); if (parsed) payloads.push(parsed); } catch { /* Ordinary text. */ }
    }
  }
  for (const payload of payloads) {
    if (provider === "executor" && payload.status === "waiting_for_interaction"
      && typeof payload.executionId === "string" && payload.executionId) {
      const interaction = record(payload.interaction);
      if (interaction?.kind !== "form" && interaction?.kind !== "url") continue;
      pending = { kind: "approval", links: [], executionId: payload.executionId.slice(0, 512), resumeTool: "resume" };
      if (typeof payload.expiresAt === "string" && Number.isFinite(Date.parse(payload.expiresAt))) pending.expiresAt = payload.expiresAt;
      if (typeof interaction.message === "string") pending.message = redactSensitiveText(interaction.message).slice(0, 4000);
      const schema = record(interaction.requestedSchema);
      if (schema) pending.requestedSchema = redactEventPayload(schema) ?? undefined;
      if (interaction.kind === "url") addLink(interaction.url);
    }
    if (provider === "arcade" && (result.isError === true || /(?:^|[._])ManageAuthorization$/.test(toolName ?? ""))
      && typeof payload.authorization_url === "string") {
      addLink(payload.authorization_url);
      pending ??= { kind: "authorization", links: [] };
    }
    // hub_connect returns {connect_url, expires_at}. The hub is self-hosted, so
    // its link is trusted only on the connection's own configured origin.
    if (provider === "connecthub" && toolName === "hub_connect" && typeof payload.connect_url === "string") {
      const origin = connectHubOrigin(options.endpoint);
      const checked = checkOAuthEndpointUrl(payload.connect_url);
      if (origin && checked.ok && new URL(checked.url).origin === origin) {
        addLink(checked.url);
        pending ??= { kind: "authorization", links: [] };
        if (typeof payload.expires_at === "string" && Number.isFinite(Date.parse(payload.expires_at))) pending.expiresAt = payload.expires_at;
      }
    }
    // This tool returns connection handoffs keyed by app. Other Composio tools
    // may return arbitrary application data with redirect_url/status fields.
    if (provider === "composio" && toolName === "COMPOSIO_MANAGE_CONNECTIONS") {
      let visited = 0;
      const visit = (item: unknown, depth: number) => {
        if (++visited > 500 || depth > 10 || !item || typeof item !== "object") return;
        const entry = record(item);
        const checked = checkOAuthEndpointUrl(entry?.redirect_url);
        if (checked.ok && checked.host === "connect.composio.dev" && new URL(checked.url).pathname.startsWith("/link/")) {
          addLink(checked.url);
          pending ??= { kind: "authorization", links: [] };
        }
        for (const child of Object.values(item).slice(0, 100)) visit(child, depth + 1);
      };
      visit(payload, 0);
    }
  }
  return pending ? { ...pending, links: [...links.values()] } : null;
}
