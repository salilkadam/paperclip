// Plain-language subjects for board approval cards.
//
// A gated tool call names its target by an opaque id (a Ghost post_id, a TryPost
// post_id). The board decides from the card, so for actions on a known kind of
// object the server looks the object up itself — with a read-only tool on the
// same connection — and states what is being approved in plain words:
//   Schedule blog "Pods running, site hanging" for Tue 3 Nov 2026, 08:00 (UTC-08:00)
// The looked-up fields (a post's title, an account name, a first line) can still
// have been written by an agent, so they are treated as untrusted: reduced to one
// plain line, their quotes neutralised so they cannot close the quotes around
// them, and Markdown-escaped (including URLs, which GFM would otherwise
// autolink) wherever a card renders Markdown. The reviewed arguments stay in the
// details.

export type CardSubject = { headline: string; lines: string[] };

export type CardSubjectLookup = {
  /** Upstream name of the read-only tool to call on the same connection. */
  readTool: string;
  readArguments: Record<string, unknown>;
  describe: (looked: Record<string, unknown>, now?: number) => CardSubject | null;
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
    .replace(/["\u201c\u201d\u00ab\u00bb\u2033]/g, "'")
    // Defang links: the UI linkifies URLs found in plain text after Markdown
    // parsing, so escaping alone cannot stop a title from becoming a link.
    .replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, "$1[:]//")
    .replace(/\bwww\./gi, "www[.]")
    .replace(/@/g, "[at]")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * A tool named for the board when Paperclip cannot say what it acts on: its catalog
 * display name (minus a trailing "Tool") and the app it belongs to, e.g.
 * "Delete Post (TryPost)" instead of
 * "mcp.app-gallery-link-2de1c4d0-…-49852674:delete-post-tool". Display names come
 * from the provider's catalog, so they get the same plain-text treatment as
 * looked-up values.
 */
export function plainToolLabel(tool: {
  name: string; displayName?: string | null; upstreamToolName?: string | null; applicationDisplayName?: string | null;
}): string {
  const humanize = (raw: string) => {
    const words = raw.replace(/[-_]+/g, " ").trim().replace(/\s+tool$/i, "");
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
  };
  // a catalog title can itself be an identifier ("gh_delete_post"): humanize that too
  const rawDisplay = tool.displayName?.trim() ?? "";
  const display = /^[\w.-]+$/.test(rawDisplay) && /[-_]/.test(rawDisplay) ? humanize(rawDisplay) : rawDisplay.replace(/\s+tool$/i, "");
  const fromName = tool.upstreamToolName?.trim() || tool.name.split(":").pop() || tool.name;
  const action = plainCardText(display || humanize(fromName), 80) || "Tool action";
  const app = tool.applicationDisplayName?.trim();
  return app ? `${action} (${plainCardText(app, 40)})` : action;
}

/** An untrusted looked-up value, quoted so it reads as data: “value”. */
const quoted = (value: unknown, max = 140) => `\u201c${plainCardText(value, max)}\u201d`;

/** Escape plain card text for Markdown, so looked-up text cannot add links, emphasis or HTML. */
export function escapeCardMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+!|~.:/@]/g, (ch) => `\\${ch}`);
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

/**
 * The same instant in a named IANA timezone (a TryPost account's own zone), so the
 * board reads the time the post goes out where the account posts:
 * "2026-11-11 17:00:00" + "America/Los_Angeles" -> "Wed 11 Nov 2026, 09:00 (PST)".
 * Times without an offset are UTC (TryPost's convention). Unknown zone or
 * unparseable time -> null, and callers fall back to formatWhen.
 */
export function formatWhenIn(value: unknown, timeZone: unknown): string | null {
  if (typeof value !== "string" || typeof timeZone !== "string" || !timeZone.trim()) return null;
  const iso = value.trim().replace(" ", "T");
  const at = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(at)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone.trim(), weekday: "short", day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
    }).formatToParts(new Date(at));
  } catch {
    return null;
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  // en-GB gives "GMT-8" where en-US gives the familiar "PST"; take only the zone name from en-US
  let zone = part("timeZoneName");
  try {
    zone = new Intl.DateTimeFormat("en-US", { timeZone: timeZone.trim(), timeZoneName: "short" })
      .formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value || zone;
  } catch { /* keep the en-GB name */ }
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} (${zone})`;
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
const GHOST_ACTIONS: Record<string, (title: string, args: Record<string, unknown>, now: number) => string> = {
  "gh-publish-post": (title, args, now) => {
    const when = formatWhen(args.published_at);
    if (!when) return `Publish blog ${title} now`;
    const at = Date.parse(String(args.published_at));
    return at > now + 60_000 ? `Schedule blog ${title} for ${when}` : `Publish blog ${title} now (dated ${when})`;
  },
  "gh-unpublish-post": (title) => `Take blog ${title} off the site (back to draft)`,
  "gh-delete-post": (title) => `Permanently delete blog post ${title}`,
  "gh-update-post": (title) => `Edit blog post ${title}`,
};

function ghostSubject(action: string, args: Record<string, unknown>): CardSubjectLookup | null {
  const headline = GHOST_ACTIONS[action];
  if (!headline || typeof args.post_id !== "string" || typeof args.tenant_id !== "string") return null;
  return {
    readTool: "gh_get_post",
    readArguments: { tenant_id: args.tenant_id, post_id: args.post_id },
    describe: (looked, now = Date.now()) => {
      const post = asRecord(looked.post) ?? looked;
      if (typeof post.title !== "string" || !post.title.trim()) return null;
      const title = quoted(post.title);
      const lines = [`Blog: ${title}`];
      if (typeof post.slug === "string" && post.slug) lines.push(`Slug: ${plainCardText(post.slug, 120)}`);
      if (typeof post.status === "string") lines.push(`Status when requested: ${plainCardText(post.status, 20)}`);
      lines.push(`Site: ${plainCardText(args.tenant_id, 40)}`);
      return { headline: headline(title, args, now), lines };
    },
  };
}

// ---- TryPost social posts ---------------------------------------------------------------
const changesText = (args: Record<string, unknown>) => typeof args.content === "string" || args.media !== undefined;

const TRYPOST_ACTIONS: Record<string, (account: string, args: Record<string, unknown>, now: number, timeZone: unknown) => string | null> = {
  "update-post-tool": (account, args, now, timeZone) => {
    const when = formatWhenIn(args.scheduled_at, timeZone) ?? formatWhen(args.scheduled_at);
    const edit = changesText(args) ? " and replace its text" : "";
    if (args.status === "scheduled") {
      if (!when) return `Schedule social post on ${account}${edit}`;
      const past = Date.parse(String(args.scheduled_at)) <= now + 60_000 ? " (that time has already passed)" : "";
      return `Schedule social post on ${account} for ${when}${past}${edit}`;
    }
    if (args.status === "publishing") return `Publish social post on ${account} now${edit}`;
    return `Change social post on ${account}${edit}`;
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
    describe: (looked, now = Date.now()) => {
      const post = asRecord(looked.post) ?? looked;
      const name = typeof post.display_name === "string" ? post.display_name : null;
      if (!name) return null;
      const platform = typeof post.platform === "string" ? ` (${plainCardText(post.platform, 30)})` : "";
      const account = `${quoted(name, 60)}${platform}`;
      const firstLineOf = (content: unknown) => typeof content === "string" ? content.split(/\r?\n/).find((line) => line.trim()) : undefined;
      const current = firstLineOf(post.content);
      const lines = [`Account: ${account}`];
      if (changesText(args)) {
        if (current) lines.push(`Current first line: ${quoted(current)}`);
        const next = firstLineOf(args.content);
        if (next) lines.push(`New first line (from this request): ${quoted(next)}`);
      } else if (current) {
        lines.push(`First line: ${quoted(current)}`);
      }
      if (typeof post.status === "string") lines.push(`Status when requested: ${plainCardText(post.status, 20)}`);
      const timeZone = asRecord(post.social_account)?.timezone;
      const text = headline(account, args, now, timeZone);
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
