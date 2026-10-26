// Plain-language subjects for board approval cards.
//
// A gated tool call names its target by an opaque id (a Ghost post_id, a TryPost
// post_id). The board decides from the card, so for actions on a known kind of
// object the server looks the object up itself — with a read-only tool on the
// same connection — and states what is being approved in plain words:
//   Schedule blog "Pods running, site hanging" for Tue 3 Nov 2026, 08:00 (UTC-08:00)
// Only the server's own lookup reaches the card, never text the agent wrote, and
// looked-up text is reduced to plain text so a post title cannot add links or
// formatting to an approval card. The reviewed arguments stay in the details.

export type CardSubject = { headline: string; lines: string[] };

export type CardSubjectLookup = {
  /** Upstream name of the read-only tool to call on the same connection. */
  readTool: string;
  readArguments: Record<string, unknown>;
  describe: (looked: Record<string, unknown>) => CardSubject | null;
};

const normalizeToolName = (name: string) => name.trim().toLowerCase().replace(/_/g, "-");

/** Upstream tool names are compared with "-" and "_" treated alike (gh_get_post == gh-get-post). */
export function sameUpstreamTool(a: string | null | undefined, b: string): boolean {
  return Boolean(a) && normalizeToolName(a!) === normalizeToolName(b);
}

/** Plain text for a card: one line, no control characters, at most `max` characters. */
export function plainCardText(value: unknown, max = 160): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Escape plain card text for Markdown, so looked-up text cannot add links, emphasis or HTML. */
export function escapeCardMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+!|~]/g, (ch) => `\\${ch}`);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-03T08:00:00-08:00" -> "Tue 3 Nov 2026, 08:00 (UTC-08:00)"; "...Z" -> "... (UTC)". Unparseable -> null. */
export function formatWhen(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const iso = value.trim().replace(" ", "T");
  const at = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(at)) return null;
  const offset = /([+-])(\d\d):?(\d\d)$/.exec(iso);
  const offsetMinutes = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  const local = new Date(at + offsetMinutes * 60_000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const zone = offset ? `UTC${offset[1]}${offset[2]}:${offset[3]}` : "UTC";
  return `${WEEKDAYS[local.getUTCDay()]} ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}, ${hh}:${mm} (${zone})`;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The object a read tool returned, from a gateway execution result: MCP
 * structuredContent, a JSON text content block, or a plain object.
 */
export function lookedUpObject(result: unknown): Record<string, unknown> | null {
  const record = asRecord(result);
  if (!record) return null;
  const structured = asRecord(record.structuredContent) ?? asRecord(asRecord(record.data)?.structuredContent);
  if (structured) return structured;
  const content = record.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => (asRecord(block)?.type === "text" ? String(asRecord(block)?.text ?? "") : "")).join("")
      : null;
  if (text) {
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed) return parsed;
    } catch { /* not JSON */ }
  }
  return record.content === undefined && record.structuredContent === undefined ? record : null;
}

// ---- Ghost blog (gh_* tools of the ghost MCP server) ---------------------------------
const GHOST_ACTIONS: Record<string, (title: string, args: Record<string, unknown>) => string> = {
  "gh-publish-post": (title, args) => {
    const when = formatWhen(args.published_at);
    return when ? `Schedule blog "${title}" for ${when}` : `Publish blog "${title}" now`;
  },
  "gh-unpublish-post": (title) => `Take blog "${title}" off the site (back to draft)`,
  "gh-delete-post": (title) => `Permanently delete blog post "${title}"`,
  "gh-update-post": (title) => `Edit blog post "${title}"`,
};

function ghostSubject(action: string, args: Record<string, unknown>): CardSubjectLookup | null {
  const headline = GHOST_ACTIONS[action];
  if (!headline || typeof args.post_id !== "string" || typeof args.tenant_id !== "string") return null;
  return {
    readTool: "gh_get_post",
    readArguments: { tenant_id: args.tenant_id, post_id: args.post_id },
    describe: (looked) => {
      const post = asRecord(looked.post) ?? looked;
      if (typeof post.title !== "string" || !post.title.trim()) return null;
      const title = plainCardText(post.title, 140);
      const lines = [`Blog: "${title}"`];
      if (typeof post.slug === "string" && post.slug) lines.push(`Slug: ${plainCardText(post.slug, 120)}`);
      if (typeof post.status === "string") lines.push(`Status now: ${plainCardText(post.status, 20)}`);
      lines.push(`Site: ${plainCardText(args.tenant_id, 40)}`);
      return { headline: headline(title, args), lines };
    },
  };
}

// ---- TryPost social posts ---------------------------------------------------------------
const TRYPOST_ACTIONS: Record<string, (account: string, args: Record<string, unknown>) => string | null> = {
  "update-post-tool": (account, args) => {
    const when = formatWhen(args.scheduled_at);
    if (args.status === "scheduled") return when ? `Schedule social post on ${account} for ${when}` : `Schedule social post on ${account}`;
    if (args.status === "publishing") return `Publish social post on ${account} now`;
    return `Change social post on ${account}`;
  },
  "publish-post-tool": (account) => `Publish social post on ${account} now`,
  "delete-post-tool": (account) => `Delete social post on ${account}`,
  "approve-post-tool": (account) => `Approve social post on ${account}`,
  "move-post-to-slot-tool": (account) => `Move social post on ${account} to a queue slot`,
};

function tryPostSubject(action: string, args: Record<string, unknown>): CardSubjectLookup | null {
  const headline = TRYPOST_ACTIONS[action];
  if (!headline || typeof args.post_id !== "string") return null;
  return {
    readTool: "get-post-tool",
    readArguments: { post_id: args.post_id },
    describe: (looked) => {
      const post = asRecord(looked.post) ?? looked;
      const name = typeof post.display_name === "string" ? post.display_name : null;
      if (!name) return null;
      const platform = typeof post.platform === "string" ? ` (${plainCardText(post.platform, 30)})` : "";
      const account = `${plainCardText(name, 60)}${platform}`;
      const firstLine = typeof post.content === "string" ? post.content.split(/\r?\n/).find((line) => line.trim()) : undefined;
      const lines = [`Account: ${account}`];
      if (firstLine) lines.push(`First line: "${plainCardText(firstLine, 140)}"`);
      if (typeof post.status === "string") lines.push(`Status now: ${plainCardText(post.status, 20)}`);
      const text = headline(account, args);
      return text ? { headline: text, lines } : null;
    },
  };
}

/** The lookup for a gated call, or null when the action is not one we can describe. */
export function cardSubjectLookupFor(upstreamToolName: string | null | undefined, args: unknown): CardSubjectLookup | null {
  const record = asRecord(args);
  if (!upstreamToolName || !record) return null;
  const action = normalizeToolName(upstreamToolName);
  return ghostSubject(action, record) ?? tryPostSubject(action, record);
}

/** Markdown for the card preview: the subject lines, then the generic preview. */
export function subjectPreviewMarkdown(subject: CardSubject, fallbackPreview: string): string {
  return [`**${escapeCardMarkdown(subject.headline)}**`, "", ...subject.lines.map((line) => `- ${escapeCardMarkdown(line)}`), "", fallbackPreview].join("\n");
}
