/**
 * A small IMAP4rev1 client over an explicit TLS socket.
 *
 * This exists so the connector bundle has no third-party mail dependency and so
 * every byte that reaches the mailbox is auditable. Only the commands the
 * connector needs are implemented: CAPABILITY, LOGIN, SELECT, UID SEARCH,
 * UID FETCH, UID STORE, LOGOUT.
 *
 * Wire-response interpretation lives in the exported pure helpers
 * ({@link parseSearchUids}, {@link parseFetchEntries}, {@link parseCapability})
 * so it can be unit-tested against canned server bytes without a socket.
 */

import net from "node:net";
import tls from "node:tls";

const CRLF = "\r\n";
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How the socket to the mail server is secured.
 *
 * `implicit` is TLS from the first byte (port 993, what Stalwart and the
 * in-cluster gateway speak). `none` is plaintext and exists only for a
 * loopback test harness; it is never a sensible production value.
 */
export type ImapTlsMode = "implicit" | "none";

/** Connection settings, resolved from plugin config by the caller. */
export interface ImapOptions {
  host: string;
  port: number;
  tlsMode: ImapTlsMode;
  /** SNI/peer name override, for when the certificate names a different host. */
  serverName?: string;
  /** PEM bundle trusted for this connection only. */
  caPem?: string;
  /** Set false only for a deliberately untrusted test endpoint. */
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}

/** One untagged response and the literal that belongs to it, if any. */
interface UntaggedResponse {
  line: string;
  literal?: Buffer;
}

/** Result of a tagged IMAP command. */
interface TaggedResponse {
  status: "OK" | "NO" | "BAD";
  text: string;
  untagged: UntaggedResponse[];
}

/** A fetched message as returned by {@link parseFetchEntries}. */
export interface FetchedMessage {
  uid: number;
  flags: string[];
  raw: Buffer;
}

/** Raised for protocol-level and transport failures. */
export class ImapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapError";
  }
}

/** Quote an IMAP string literal (8-bit text is sent as-quoted). */
export function imapQuote(value: string): string {
  return `"${value.replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
}

/** Extract UIDs from `* SEARCH 1 2 3` style responses. */
export function parseSearchUids(untagged: UntaggedResponse[]): number[] {
  const uids: number[] = [];
  for (const item of untagged) {
    if (!/^\* SEARCH\b/i.test(item.line)) continue;
    for (const token of item.line.slice("* SEARCH".length).trim().split(/\s+/)) {
      const n = Number(token);
      if (Number.isInteger(n) && n > 0) uids.push(n);
    }
  }
  return Array.from(new Set(uids)).sort((a, b) => a - b);
}

/** Read capabilities out of a `* CAPABILITY ...` response. */
export function parseCapability(untagged: UntaggedResponse[]): string[] {
  for (const item of untagged) {
    if (/^\* CAPABILITY\b/i.test(item.line)) {
      return item.line.slice(2).trim().split(/\s+/).slice(1).map((c) => c.toLowerCase());
    }
  }
  return [];
}

/**
 * Pair each `* <seq> FETCH (...)` response with its UID, flags and literal.
 *
 * Servers may emit `FLAGS` after the literal, so a response's continuation
 * lines are joined onto the entry that opened the literal before parsing.
 */
function parenDepth(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  return depth;
}

export function parseFetchEntries(untagged: UntaggedResponse[]): FetchedMessage[] {
  // A literal can close inside an open paren, so items the server sends after
  // it (notably FLAGS) belong to the response that opened the literal.
  const merged: UntaggedResponse[] = [];
  for (const item of untagged) {
    const previous = merged[merged.length - 1];
    const continuesPrevious =
      previous !== undefined &&
      previous.literal !== undefined &&
      parenDepth(previous.line) > 0 &&
      !item.line.startsWith("*") &&
      !/^A\d{4}\s/.test(item.line);
    if (continuesPrevious && previous) {
      previous.line = `${previous.line}${CRLF}${item.line}`;
      continue;
    }
    merged.push({ ...item });
  }

  const out: FetchedMessage[] = [];
  for (const item of merged) {
    if (!/^\*\s+\d+\s+FETCH\b/i.test(item.line)) continue;
    if (!item.literal) continue;
    const uidText = /\bUID\s+(\d+)/i.exec(item.line);
    const flagsText = /FLAGS\s+\(([^)]*)\)/i.exec(item.line);
    out.push({
      uid: Number(uidText?.[1] ?? 0),
      flags: (flagsText?.[1] ?? "").trim().split(/\s+/).filter(Boolean),
      raw: item.literal,
    });
  }
  return out;
}

/**
 * Serialize a UID set for `UID FETCH`/`UID STORE`.
 * Contiguous runs collapse to `first:last`, which keeps one poll cheap.
 */
export function toUidSet(uids: number[]): string {
  const sorted = Array.from(new Set(uids)).sort((a, b) => a - b);
  const chunks: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const uid of sorted.slice(1)) {
    if (uid === prev + 1) {
      prev = uid;
      continue;
    }
    chunks.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = uid;
    prev = uid;
  }
  if (start !== undefined) chunks.push(start === prev ? `${start}` : `${start}:${prev}`);
  return chunks.join(",");
}

/** Minimal blocking-socket IMAP client. One command may be in flight at a time. */
export class ImapClient {
  private socket: tls.TLSSocket | net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private failure: Error | null = null;
  private tagCount = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;

  constructor(private readonly options: ImapOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Open the socket and consume the server greeting. */
  async connect(): Promise<void> {
    const { host, port, tlsMode, serverName, caPem, rejectUnauthorized } = this.options;
    if (!host) throw new ImapError("imap host is not configured");
    const tlsOptions: tls.ConnectionOptions = {
      servername: serverName || host,
      rejectUnauthorized: rejectUnauthorized !== false,
      ...(caPem ? { ca: caPem } : {}),
    };
    this.socket =
      tlsMode === "none"
        ? net.connect({ host, port })
        : tls.connect(tlsMode === "implicit" ? { host, port, ...tlsOptions } : { host, port, ...tlsOptions });

    const socket = this.socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on("error", (error: Error) => {
      this.fail(new ImapError(`imap socket error connecting to ${host}:${port}: ${error.message}`));
    });
    socket.on("close", () => this.fail(new ImapError(`imap connection to ${host}:${port} closed`)));
    socket.setTimeout(this.timeoutMs, () => {
      this.fail(new ImapError(`imap connection to ${host}:${port} timed out after ${this.timeoutMs}ms`));
    });

    // Greeting: "* OK ...ready for commands"
    for (;;) {
      const line = await this.readLine();
      if (/^\*\s+OK\b/i.test(line)) return;
      if (/^\*\s+(PREAUTH|BYE)\b/i.test(line)) throw new ImapError(`unexpected imap greeting: ${line}`);
    }
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiting;
    this.waiting = null;
    waiter?.();
  }

  private async readLine(): Promise<string> {
    for (;;) {
      if (this.failure) throw this.failure;
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      await this.sleep();
    }
  }

  /**
   * Read exactly `count` bytes, then the rest of the line that carried the
   * literal. Servers commonly close the enclosing `)` on the line that follows
   * the literal, so that remainder is read (and discarded) rather than skipped.
   */
  private async readBytes(count: number): Promise<Buffer> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.buffer.length >= count) {
        const body = this.buffer.subarray(0, count);
        this.buffer = this.buffer.subarray(count);
        await this.readLine();
        return body;
      }
      await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.fail(new ImapError("imap read timed out"));
        resolve();
      }, this.timeoutMs);
      timer.unref?.();
      this.waiting = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Run one tagged command, serialised behind any command already in flight. */
  private command(command: string): Promise<TaggedResponse> {
    const run = this.queue.then(async () => {
      if (!this.socket) throw new ImapError("imap socket is not connected");
      if (this.failure) throw this.failure;
      const tag = `A${String(++this.tagCount).padStart(4, "0")}`;
      this.socket.write(`${tag} ${command}${CRLF}`);
      const untagged: UntaggedResponse[] = [];
      for (;;) {
        const line = await this.readLine();
        if (line.startsWith("+")) {
          throw new ImapError(`imap server asked for a continuation (${line}); this client sends no literals`);
        }
        if (line.startsWith("*")) {
          const literalMatch = /\{(\d+)\}$/.exec(line);
          if (literalMatch) {
            const literal = await this.readBytes(Number(literalMatch[1]));
            untagged.push({ line, literal });
          } else {
            untagged.push({ line });
          }
          continue;
        }
        if (line.startsWith(`${tag} `)) {
          const statusText = line.slice(tag.length + 1);
          const upper = statusText.toUpperCase();
          const status: TaggedResponse["status"] = upper.startsWith("OK")
            ? "OK"
            : upper.startsWith("NO")
              ? "NO"
              : "BAD";
          return { status, text: statusText, untagged };
        }
        // Anything else (an unrequested response) is recorded and ignored.
        untagged.push({ line });
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async checked(command: string): Promise<TaggedResponse> {
    const response = await this.command(command);
    if (response.status !== "OK") {
      throw new ImapError(`imap command failed (${response.status}): ${command} -> ${response.text}`);
    }
    return response;
  }

  /** `CAPABILITY` — safe before login, used for health probes. */
  async capability(): Promise<string[]> {
    const response = await this.command("CAPABILITY");
    return parseCapability(response.untagged);
  }

  /** `LOGIN` with quoted arguments so no literals are ever needed. */
  async login(user: string, password: string): Promise<void> {
    await this.checked(`LOGIN ${imapQuote(user)} ${imapQuote(password)}`);
  }

  /** `SELECT` a mailbox and return nothing; failures throw. */
  async selectMailbox(mailbox = "INBOX"): Promise<void> {
    await this.checked(`SELECT ${imapQuote(mailbox)}`);
  }

  /** `UID SEARCH` returning matching UIDs in ascending order. */
  async uidSearch(criteria: string): Promise<number[]> {
    const response = await this.checked(`UID SEARCH ${criteria}`);
    return parseSearchUids(response.untagged);
  }

  /** `UID FETCH` whole messages (`BODY.PEEK[]`) so flags are not changed. */
  async uidFetchMessages(uidSet: string): Promise<FetchedMessage[]> {
    const response = await this.checked(`UID FETCH ${uidSet} (UID FLAGS BODY.PEEK[])`);
    return parseFetchEntries(response.untagged);
  }

  /** `UID STORE` flags, silently. */
  async uidStoreFlags(uidSet: string, mode: "+" | "-", flags: string[]): Promise<void> {
    await this.checked(`UID STORE ${uidSet} ${mode}FLAGS.SILENT (${flags.join(" ")})`);
  }

  /** Close the session politely, tolerating a dead socket. */
  async logout(): Promise<void> {
    try {
      if (this.socket && !this.failure) await this.command("LOGOUT");
    } catch {
      // The socket is going away regardless.
    } finally {
      this.socket?.destroy();
      this.socket = null;
    }
  }
}

/**
 * Convenience wrapper: connect, log in, run a callback, always log out.
 * The password is never retained by this module.
 */
export async function withImap<T>(
  options: ImapOptions,
  user: string,
  password: string,
  fn: (client: ImapClient) => Promise<T>,
): Promise<T> {
  const client = new ImapClient(options);
  await client.connect();
  try {
    await client.login(user, password);
    return await fn(client);
  } finally {
    await client.logout();
  }
}
