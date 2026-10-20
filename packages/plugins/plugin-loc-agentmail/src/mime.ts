/**
 * Dependency-free MIME construction and parsing for the Loc-AgentMail connector.
 *
 * The send path builds the complete RFC 822 message itself so threading headers
 * (`In-Reply-To`, `References`) and the `From:` header that DKIM must align with
 * are exactly what the caller intended once SES signs them. The receive path
 * parses whatever the mailbox returns, including multipart alternatives.
 */

const CRLF = "\r\n";
const ASCII_ONLY = /^[\x20-\x7E]*$/;
const LINE_BREAK_OR_NUL = /[\r\n\0]/;

/** Address shape used across the connector. */
export interface MailAddress {
  name?: string;
  email: string;
}

/**
 * Headers a caller may never set. Group-distribution headers (`List-*`) and
 * routing headers (`Return-Path`, `Sender`) are injected by mail systems, and
 * letting a caller set them enables both bounce-address spoofing and, in the
 * case of `List-Unsubscribe`, an agent unsubscribing its own mailbox.
 */
const FORBIDDEN_HEADERS = [
  "return-path",
  "sender",
  "resent-from",
  "received",
  "delivered-to",
  "x-original-to",
  "list-id",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "list-post",
  "list-help",
  "list-owner",
  "message-id",
  "date",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-description",
];

/** Thrown for malformed input; surfaces as a readable tool error. */
export class MimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeError";
  }
}

/** A single email address, deliberately strict about line breaks. */
const ADDRESS_RE = /^[^\s@"\\,]+(?:\.[^\s@"\\,]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function rejectInjection(value: string, what: string): string {
  if (LINE_BREAK_OR_NUL.test(value)) {
    throw new MimeError(`${what} must not contain line breaks or NUL bytes`);
  }
  return value;
}

/** Validate one address and return it trimmed. */
export function requireAddress(value: string, what = "address"): string {
  const email = rejectInjection(String(value ?? ""), what).trim();
  if (!ADDRESS_RE.test(email)) throw new MimeError(`${what} is not a valid email address: ${email}`);
  return email.toLowerCase();
}

/** Validate a list of addresses. */
export function requireAddressList(values: unknown, what: string, max = 50): string[] {
  const list = Array.isArray(values) ? values : [values];
  const out: string[] = [];
  for (const item of list) {
    for (const piece of String(item ?? "").split(",")) {
      const trimmed = piece.trim();
      if (trimmed) out.push(requireAddress(trimmed, what));
    }
  }
  if (out.length > max) throw new MimeError(`${what} has more than ${max} addresses`);
  return out;
}

/** Encode a display name or subject as an RFC 2047 encoded word when needed. */
export function encodeWord(text: string): string {
  const value = text ?? "";
  if (ASCII_ONLY.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const chunkSize = 48; // multiple of 4 so every chunk decodes standalone
  const words: string[] = [];
  for (let i = 0; i < b64.length; i += chunkSize) {
    words.push(`=?UTF-8?B?${b64.slice(i, i + chunkSize)}?=`);
  }
  return words.join(" ");
}

/** Fold an over-long header value onto continuation lines. */
function foldHeader(name: string, value: string): string {
  const first = `${name}: `;
  if (first.length + value.length <= 998) return first + value;
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = first;
  for (const word of words) {
    if (line.length + word.length + 1 > 76 && line !== first) {
      lines.push(line);
      line = " ";
    }
    line += line.endsWith(" ") || line === first ? word : ` ${word}`;
  }
  lines.push(line);
  return lines.join(CRLF);
}

/**
 * Characters allowed bare in an RFC 5322 `display-name` (atext plus spaces).
 * Anything else — a comma in `Acme, Inc.`, an apostrophe, an emoji — has to
 * travel as a quoted string, or the header no longer parses as one address.
 */
const BARE_DISPLAY_NAME = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/;

/** Format a display name as a bare atom or a quoted string. */
function formatDisplayName(name: string): string {
  if (BARE_DISPLAY_NAME.test(name)) return name;
  return `"${name.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/** Format an address for a `From:`/`To:` header, encoding the display name. */
export function formatAddress(address: MailAddress): string {
  const email = requireAddress(address.email, "address");
  const name = (address.name ?? "").trim();
  if (!name) return email;
  // Non-ASCII names go out as RFC 2047 encoded words; ASCII names that are not
  // bare-atom safe go out as a quoted string.
  const encoded = ASCII_ONLY.test(name) ? formatDisplayName(name) : encodeWord(name);
  return `${encoded} <${email}>`;
}

/**
 * Base64 a body and fold it to 76-column lines.
 *
 * Base64 is chosen over quoted-printable for outbound mail because a base64
 * payload cannot contain the leading-dot sequence that ends an SMTP transaction,
 * so dot-stuffing bugs are structurally impossible.
 */
export function base64Body(value: string): string {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return b64.replace(/(.{76})/g, `$1${CRLF}`);
}

/** One RFC 822 body part, base64 encoded so no dot-stuffing is possible. */
function encodedPart(contentType: string, body: string): { header: string; body: string } {
  return {
    header: `Content-Type: ${contentType}; charset=utf-8${CRLF}Content-Transfer-Encoding: base64`,
    body: base64Body(body),
  };
}

/** Input accepted by {@link buildRawMessage}. */
export interface MessageInput {
  from: MailAddress;
  to: string[];
  cc?: string[];
  replyTo?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  messageId: string;
  date?: Date;
  /** Extra `X-` style headers; forbidden names are dropped, not rejected. */
  headers?: Record<string, string>;
}

/**
 * Serialise a message to raw RFC 822 with CRLF endings, ready for
 * `ses:SendRawEmail`.
 */
export function buildRawMessage(input: MessageInput): string {
  const to = requireAddressList(input.to, "to");
  if (to.length === 0) throw new MimeError("at least one recipient is required");
  const cc = requireAddressList(input.cc ?? [], "cc");
  const replyTo = requireAddressList(input.replyTo ?? [], "reply-to");
  const subject = rejectInjection(String(input.subject ?? ""), "subject").trim();
  const text = String(input.text ?? "");
  const html = input.html === undefined ? undefined : String(input.html);
  const from = formatAddress(input.from);
  const messageId = rejectInjection(String(input.messageId ?? ""), "message-id").trim();
  if (!messageId) throw new MimeError("message-id is required");

  const headers: string[] = [];
  headers.push(foldHeader("From", from));
  headers.push(foldHeader("To", to.join(", ")));
  if (cc.length) headers.push(foldHeader("Cc", cc.join(", ")));
  if (replyTo.length) headers.push(foldHeader("Reply-To", replyTo.map((e) => `<${e}>`).join(", ")));
  headers.push(foldHeader("Subject", encodeWord(subject)));
  headers.push(`Date: ${(input.date ?? new Date()).toUTCString()}`);
  headers.push(`Message-ID: <${messageId}>`);
  if (input.inReplyTo) {
    headers.push(foldHeader("In-Reply-To", `<${rejectInjection(input.inReplyTo, "in-reply-to").trim()}>`));
  }
  const references = (input.references ?? [])
    .map((ref) => rejectInjection(ref, "references").trim())
    .filter(Boolean)
    .map((ref) => (ref.startsWith("<") ? ref : `<${ref}>`));
  if (references.length) headers.push(foldHeader("References", references.join(" ")));
  headers.push("MIME-Version: 1.0");

  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.includes(lower) || !/^x-[a-z0-9-]+$/.test(lower)) continue;
    headers.push(foldHeader(name, rejectInjection(String(value), `header ${name}`)));
  }

  let bodySection: string;
  if (html && html.trim()) {
    const boundary = `paperclip-loc-agentmail-${messageId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;
    const textPart = encodedPart("text/plain", text);
    const htmlPart = encodedPart("text/html", html);
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    bodySection = [
      `--${boundary}${CRLF}${textPart.header}${CRLF}${CRLF}${textPart.body}`,
      `--${boundary}${CRLF}${htmlPart.header}${CRLF}${CRLF}${htmlPart.body}`,
      `--${boundary}--`,
    ].join(CRLF);
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    bodySection = base64Body(text);
  }

  return `${headers.join(CRLF)}${CRLF}${CRLF}${bodySection}${CRLF}`;
}

/** Generate a Message-ID with a stable, non-revealing host part. */
export function newMessageId(domain: string): string {
  const host = (domain || "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
  const rand = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(12))).toString("hex");
  return `${Date.now().toString(36)}.${rand}@${host}`;
}

/** Decode a single RFC 2047 encoded word. */
function decodeOneWord(word: string): string {
  const m = /^=([^=]+)\?([QqBb])\?(.*?)\?=$/.exec(word);
  if (!m) return word;
  const [, charset, encoding, payload] = m;
  try {
    if (encoding.toUpperCase() === "B") {
      return decodeText(Buffer.from(payload, "base64"), charset);
    }
    const bytes = payload.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_all, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, "binary").toString(charsetToNode(charset));
  } catch {
    return word;
  }
}

function charsetToNode(charset: string): BufferEncoding {
  const c = charset.trim().toLowerCase();
  if (c === "utf-8" || c === "utf8") return "utf8";
  if (c === "us-ascii" || c === "ascii") return "ascii";
  if (c === "iso-8859-1" || c === "latin1" || c === "windows-1252") return "latin1";
  return "utf8";
}

function decodeText(buf: Buffer, charset: string): string {
  return buf.toString(charsetToNode(charset));
}

/** Decode any RFC 2047 encoded words inside a header value. */
export function decodeWords(value: string): string {
  if (!value || !value.includes("=?")) return value;
  return value
    .replace(/=\?[^?]+\?[QQBb]\?[^?]*\?=(?:\s+ (?==\?))?/g, (chunk) => {
      const cleaned = chunk.trim();
      const decoded = decodeOneWord(cleaned);
      return decoded === cleaned ? cleaned : decoded;
    })
    .replace(/=\?([^?]+)\?([QQBb])\?([^?]*)\?=/g, (_all, charset, enc, payload) =>
      decodeOneWord(`=?${charset}?${enc}?${payload}?=`),
    )
    .trim();
}

/** Parse an unfolded header block into a lower-cased map. */
export function parseHeaderBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = block.replace(/\r\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}

/** Decode a base64 body payload. */
export function decodeBase64Body(value: string): string {
  return Buffer.from(value.replace(/[^0-9+/=A-Za-z]/g, ""), "base64").toString("utf8");
}

/** Decode a quoted-printable body payload. */
export function decodeQuotedPrintableBody(value: string): string {
  const soft = value.replace(/=\r?\n/g, "");
  const bytes = soft.replace(/=([0-9A-Fa-f]{2})/g, (_all, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, "binary").toString("utf8");
}

/**
 * Decode bytes to text, preferring UTF-8 and falling back to latin1 when the
 * bytes are not valid UTF-8 (common for 8BIT mail from older senders).
 */
export function smartDecode(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  return buf.toString("latin1").replace(/\uFFFD/g, "\u00A5");
}

/** Parse a `To:`/`From:` style header into addresses. */
export function parseAddressList(value: string): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  const re = /(?:"((?:[^"\\]|\\.)*)"|([^<,"]*))?\s*<\s*([^>\s]+)\s*>|([^,;]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const quoted = match[1];
    const bareName = match[2];
    const angle = match[3];
    const plain = match[4];
    if (angle) {
      const name = decodeWords((quoted ?? bareName ?? "").trim().replace(/\\(["\\])/g, "$1"));
      out.push(name ? { name, email: angle.toLowerCase() } : { email: angle.toLowerCase() });
    } else if (plain) {
      const candidate = plain.trim();
      if (ADDRESS_RE.test(candidate)) out.push({ email: candidate.toLowerCase() });
    }
  }
  return out;
}

/** A message as the connector hands it to tools and the poll job. */
export interface ParsedMail {
  messageId: string;
  inReplyTo: string;
  references: string[];
  subject: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  date: string;
  text: string;
  html: string;
  snippet: string;
}

function bodyPart(contentType: string, body: string, cte: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("base64")) return decodeBase64Body(body);
  if (lower.includes("quoted-printable")) return decodeQuotedPrintableBody(body);
  void cte;
  return body;
}

function textFromParts(raw: string, depth = 0): { text: string; html: string } {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return { text: raw, html: "" };
  const headerText = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
  const headers = parseHeaderBlock(headerText);
  const contentType = headers["content-type"] ?? "text/plain";
  const cte = headers["content-transfer-encoding"] ?? "";

  if (contentType.includes("multipart/") && depth < 3) {
    const boundary = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1];
    if (boundary) {
      const parts = body
        .split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?(?:\\r?\\n|$)`))
        .filter((part) => part.trim().length > 0);
      const acc = { text: "", html: "" };
      for (const part of parts) {
        const nested = textFromParts(part, depth + 1);
        if (!acc.text && nested.text) acc.text = nested.text;
        if (!acc.html && nested.html) acc.html = nested.html;
      }
      return acc;
    }
  }

  const decoded = bodyPart(cte, body, cte);
  if (contentType.includes("text/html")) return { text: "", html: decoded };
  if (contentType.includes("text/")) return { text: decoded, html: "" };
  return { text: "", html: "" };
}

/** Strip quoted reply text and signatures down to the new content. */
function snippetOf(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^-{2,}\s*$/.test(line) || /^(on\s+.{10,}wrote:|in reply to|forwarded message)/i.test(line)) break;
    kept.push(line);
    if (kept.join(" ").length > 400) break;
  }
  return kept.join(" ").replace(/\s+/g, " ").trim().slice(0, 280);
}

/** Parse a complete RFC 822 message. */
export function parseRawMail(raw: string | Buffer): ParsedMail {
  const text = typeof raw === "string" ? raw : smartDecode(raw);
  const headerEnd = text.search(/\r?\n\r?\n/);
  const headerText = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const headers = parseHeaderBlock(headerText);
  const fromList = parseAddressList(headers["from"] ?? "");
  const toList = parseAddressList(headers["to"] ?? "");
  const ccList = parseAddressList(headers["cc"] ?? "");
  const { text: bodyText, html } = textFromParts(text);
  const rawId = (headers["message-id"] ?? "").trim();
  return {
    messageId: rawId.replace(/^<|>$/g, ""),
    inReplyTo: (headers["in-reply-to"] ?? "").trim().replace(/^<|>$/g, ""),
    references: (headers["references"] ?? "")
      .split(/\s+/)
      .map((ref) => ref.replace(/^<|>$/g, ""))
      .filter(Boolean),
    subject: decodeWords(headers["subject"] ?? ""),
    from: fromList[0]?.email ?? "",
    fromName: fromList[0]?.name ?? "",
    to: toList.map((a) => a.email),
    cc: ccList.map((a) => a.email),
    date: headers["date"] ?? "",
    text: bodyText,
    html,
    snippet: snippetOf(bodyText),
  };
}
