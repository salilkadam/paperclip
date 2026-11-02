/**
 * Worker tests: real tool handlers against a scripted IMAP server and a fake
 * Paperclip host.
 *
 * The host double is deliberately strict about the two things that matter
 * operationally — nothing secret reaches state/entities/activity, and a mailbox
 * the agent was not granted is refused before any network call.
 */
import * as net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PluginActivityLogEntry,
  PluginConfigValidationResult,
  PluginContext,
  PluginEntityUpsert,
  PluginJobContext,
  PluginStateScopeKey,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";

const COMPANY_A = "62d63984-df6c-49be-981c-1273f68a451c";
const COMPANY_B = "370325c2-a341-47fe-9ae2-bce9b5dd446f";
const AGENT_CEO = "73cae9f9-b419-48f1-b395-7e7e8c41048d";
const AGENT_COO = "70499d70-c8de-4a11-b75f-70596e18e7e2";
const SECRET_ID = "5f4c2a1b-9d3e-4f60-8b2a-1c7d5e9a0b3f";

type Handler = (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;
type JobHandler = (job: PluginJobContext) => Promise<void>;

function stateKey(key: PluginStateScopeKey): string {
  return JSON.stringify([key.scopeKind, key.scopeId ?? "", key.namespace ?? "", key.stateKey]);
}

function runContext(companyId = COMPANY_A, agentId = AGENT_CEO): ToolRunContext {
  return { runId: "run-1", companyId, agentId, issueId: null, projectId: null };
}

// ---------------------------------------------------------------------------
// Scripted IMAP server
// ---------------------------------------------------------------------------

interface StoredMail {
  uid: number;
  seq: number;
  flags: string[];
  raw: string;
}

function parseUidSet(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const range = /^(\d+):(\d+|\*)$/.exec(part);
    if (range) {
      const high = range[2] === "*" ? Number.MAX_SAFE_INTEGER : Number(range[2]);
      for (let uid = Number(range[1]); uid <= high; uid += 1) out.add(uid);
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part));
    }
  }
  return out;
}

class FakeImapServer {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  mails: StoredMail[] = [];
  requests: string[] = [];
  markedSeen: number[] = [];
  markedUnseen: number[] = [];
  loginLine = "";
  port = 0;
  /** CAPABILITY list the fake advertises. */
  capabilities = ["IMAP4rev1", "IDLE", "UNSELECT"];
  /** When true, refuse LOGIN the way a plaintext-strict server does. */
  refuseLogin = false;

  addMail(uid: number, from: string, subject: string, body: string, flags: string[] = []): void {
    const seq = this.mails.length + 1;
    const raw = [
      `From: ${from}`,
      `To: support@agentmail.reliora.ai`,
      `Subject: ${subject}`,
      `Date: Mon, 19 Oct 2026 12:0${uid}:00 +0000`,
      `Message-Id: <mid-${uid}@gmail.example>`,
      "",
      body,
      "",
    ].join("\r\n");
    this.mails.push({ uid, seq, flags, raw });
  }

  async listen(): Promise<void> {
    this.server = net.createServer((socket) => this.attach(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfoPort).port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private attach(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const index = buffer.indexOf(0x0a);
        if (index < 0) break;
        const line = buffer.subarray(0, index).toString("utf8").replace(/\r$/, "");
        buffer = buffer.subarray(index + 1);
        void this.handle(socket, line);
      }
    });
  }

  private send(socket: net.Socket, text: string): void {
    if (!socket.destroyed) socket.write(text);
  }

  private async handle(socket: net.Socket, line: string): Promise<void> {
    const match = /^(A\d+) (.*)$/.exec(line);
    if (!match) return;
    const [, tag, command] = match;
    this.requests.push(command);
    const parts = command.split(" ");
    const verb = (parts[0] ?? "").toUpperCase();

    if (verb === "CAPABILITY") {
      this.send(socket, `* CAPABILITY ${this.capabilities.join(" ")}\r\n${tag} OK CAPABILITY completed\r\n`);
      return;
    }
    if (verb === "LOGIN") {
      this.loginLine = parts.slice(1).join(" ");
      if (this.refuseLogin) {
        this.send(socket, `${tag} NO LOGIN failed\r\n`);
        return;
      }
      this.send(socket, `${tag} OK LOGIN completed\r\n`);
      return;
    }
    if (verb === "SELECT") {
      this.send(
        socket,
        `* ${this.mails.length} EXISTS\r\n* 0 RECENT\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`,
      );
      return;
    }
    if (verb === "LOGOUT") {
      this.send(socket, `* BYE fake server signing off\r\n${tag} OK LOGOUT completed\r\n`);
      socket.end();
      return;
    }
    if (verb === "UID") {
      const sub = (parts[1] ?? "").toUpperCase();
      const args = parts.slice(2);
      if (sub === "SEARCH") {
        const uids = this.matchCriteria(args.join(" "));
        this.send(socket, `* SEARCH${uids.length ? ` ${uids.join(" ")}` : ""}\r\n${tag} OK SEARCH completed\r\n`);
        return;
      }
      if (sub === "FETCH") {
        const wanted = parseUidSet(args[0] ?? "");
        for (const mail of this.mails.filter((item) => wanted.has(item.uid))) {
          const payload = Buffer.from(mail.raw, "utf8");
          // Written in pieces so the client has to reassemble across chunk boundaries.
          this.send(socket, `* ${mail.seq} FETCH (UID ${mail.uid} FLAGS (${mail.flags.join(" ")}) BODY[] {${payload.length}}\r\n`);
          await sleep(1);
          this.send(socket, payload.subarray(0, 4).toString("utf8"));
          await sleep(1);
          this.send(socket, payload.subarray(4).toString("utf8"));
          this.send(socket, ")\r\n");
        }
        this.send(socket, `${tag} OK FETCH completed\r\n`);
        return;
      }
      if (sub === "STORE") {
        const uids = [...parseUidSet(args[0] ?? "")];
        const mode = args[1] ?? "+FLAGS.SILENT";
        for (const mail of this.mails.filter((item) => uids.includes(item.uid))) {
          if (mode.startsWith("-")) mail.flags = mail.flags.filter((flag) => flag !== "\\Seen");
          else if (!mail.flags.includes("\\Seen")) mail.flags.push("\\Seen");
          (mode.startsWith("-") ? this.markedUnseen : this.markedSeen).push(mail.uid);
        }
        this.send(socket, `${tag} OK STORE completed\r\n`);
        return;
      }
    }
    this.send(socket, `${tag} BAD unsupported: ${command}\r\n`);
  }

  private matchCriteria(criteria: string): number[] {
    let list = [...this.mails];
    const open = /UID\s+(\d+):\*/i.exec(criteria);
    const bounded = /UID\s+(\d+):(\d+)/i.exec(criteria);
    if (open) list = list.filter((mail) => mail.uid >= Number(open[1]));
    else if (bounded) {
      const low = Number(bounded[1]);
      const high = Number(bounded[2]);
      list = list.filter((mail) => mail.uid >= low && mail.uid <= high);
    }
    if (/\bUNSEEN\b/i.test(criteria)) list = list.filter((mail) => !mail.flags.includes("\\Seen"));
    return list.map((mail) => mail.uid).sort((a, b) => a - b);
  }
}

type AddressInfoPort = { port: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fake Paperclip host
// ---------------------------------------------------------------------------

interface WorkerOptions {
  companies?: Array<{ id: string; name: string }>;
  configs?: Record<string, Record<string, unknown>>;
}

function makeWorkerContext(options: WorkerOptions = {}) {
  const companies = options.companies ?? [{ id: COMPANY_A, name: "Reliora" }];
  const configs = options.configs ?? {};
  const state = new Map<string, unknown>();
  const tools = new Map<string, Handler>();
  const jobs = new Map<string, JobHandler>();
  const entities: PluginEntityUpsert[] = [];
  const events: Array<{ name: string; companyId: string | null; payload: unknown }> = [];
  const activity: PluginActivityLogEntry[] = [];
  const reconciled: string[] = [];
  const resolveSecret = vi.fn(async () => "mailbox-secret");
  const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    manifest: { id: "paperclip.loc-agentmail" },
    logger: logs,
    config: {
      get: async (companyId?: string) => structuredClone(configs[companyId ?? ""] ?? {}),
    },
    secrets: { resolve: resolveSecret },
    state: {
      get: async (key: PluginStateScopeKey) => state.get(stateKey(key)) ?? null,
      set: async (key: PluginStateScopeKey, value: unknown) => {
        state.set(stateKey(key), value);
      },
      delete: async (key: PluginStateScopeKey) => {
        state.delete(stateKey(key));
      },
    },
    entities: {
      upsert: async (input: PluginEntityUpsert) => {
        entities.push(input);
        return { id: `entity-${entities.length}` };
      },
      list: async () => [],
    },
    events: {
      on: vi.fn(),
      subscribe: vi.fn(),
      emit: async (name: string, companyId: string | null, payload: unknown) => {
        events.push({ name, companyId, payload });
      },
    },
    activity: {
      log: async (entry: PluginActivityLogEntry) => {
        activity.push(entry);
      },
    },
    skills: {
      managed: {
        get: async () => ({}),
        reconcile: async (_key: string, companyId: string) => {
          reconciled.push(companyId);
          return { skillKey: "agentmail-mailroom" };
        },
        reset: async () => ({}),
      },
    },
    companies: {
      list: async () => companies,
      get: async (companyId: string) => companies.find((company) => company.id === companyId) ?? null,
    },
    tools: {
      register: (name: string, _declaration: unknown, fn: Handler) => {
        if (tools.has(name)) throw new Error(`duplicate tool registration for ${name}`);
        tools.set(name, fn);
      },
    },
    jobs: {
      register: (key: string, fn: JobHandler) => {
        jobs.set(key, fn);
      },
    },
    http: { fetch: async () => new Response("{}", { status: 200 }) },
  };

  return {
    ctx: ctx as unknown as PluginContext,
    tools,
    jobs,
    state,
    entities,
    events,
    activity,
    reconciled,
    resolveSecret,
    logs,
  };
}

/** Fresh worker module instance, so module-level caches cannot leak between tests. */
async function newWorker(options: WorkerOptions = {}) {
  vi.resetModules();
  const [{ default: plugin }, manifestModule] = await Promise.all([import("./plugin.js"), import("./manifest.js")]);
  const env = makeWorkerContext(options);
  env.ctx.manifest = manifestModule.default as unknown as PluginContext["manifest"];
  await plugin.definition.setup(env.ctx);
  return {
    plugin,
    manifest: manifestModule.default,
    call: (name: string, params: unknown, runCtx = runContext()) => tools_call(env.tools, name, params, runCtx),
    ...env,
  };
}

async function tools_call(tools: Map<string, Handler>, name: string, params: unknown, runCtx: ToolRunContext) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool "${name}" is not registered`);
  return handler(params, runCtx);
}

function serverConfig(port: number) {
  return {
    imap: { host: "127.0.0.1", port, tlsMode: "none" },
    send: {
      transport: "ses-api",
      sesRegion: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secretvalue",
    },
    accounts: [
      {
        key: "rel-support",
        address: "support@agentmail.reliora.ai",
        displayName: "Reliora Support",
        password: "mailbox-secret",
        companyIds: [COMPANY_A],
      },
    ],
    poll: { enabled: true, maxMessagesPerAccount: 25, markSeen: false },
  };
}

function sesOk(messageId: string) {
  return `<SendRawEmailResponse><SendRawEmailResult><MessageId>${messageId}</MessageId></SendRawEmailResult></SendRawEmailResponse>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("worker registration", () => {
  it("registers the five manifest tools and the poll job", async () => {
    const worker = await newWorker();
    expect([...worker.tools.keys()].sort()).toEqual(["create_drive_file", "list_inbox", "mark_read", "read_message", "send"]);
    expect(worker.jobs.has("poll-inbox")).toBe(true);
    // Declarations come from the manifest, so the two cannot drift apart.
    for (const name of ["send", "list_inbox", "read_message", "mark_read", "create_drive_file"]) {
      const declared = worker.manifest.tools?.find((tool) => tool.name === name);
      expect(declared?.description).toBeTruthy();
      expect(declared?.parametersSchema).toBeTruthy();
    }
  });
});

describe("send", () => {
  it("sends as the assigned mailbox and records what it did", async () => {
    const fetchMock = vi.fn(async () => new Response(sesOk("ses-msg-1"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(993) } });

    const result = await worker.call("send", {
      to: ["human@gmail.example"],
      cc: ["founders@reliora.ai"],
      subject: "Your order",
      text: "It shipped.",
    });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("ses-msg-1");
    expect(result.content).toContain("support@agentmail.reliora.ai");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get("Source")).toBe("support@agentmail.reliora.ai");
    expect(body.get("Destinations.member.1")).toBe("human@gmail.example");
    expect(body.get("Destinations.member.2")).toBe("founders@reliora.ai");

    const entry = worker.activity[0]!;
    expect(entry.companyId).toBe(COMPANY_A);
    expect(entry.message).toContain("support@agentmail.reliora.ai");
    expect(JSON.stringify(entry.metadata)).toContain("ses-msg-1");
    // The password never travels with the audit record.
    expect(JSON.stringify(entry)).not.toContain("secretvalue");
    expect(JSON.stringify(entry)).not.toContain("mailbox-secret");

    // The mailroom skill is reconciled on first real use.
    expect(worker.reconciled).toEqual([COMPANY_A]);
  });

  it("refuses a mailbox belonging to another company without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(993) } });

    const result = await worker.call("send", { to: ["a@b.example"], subject: "x", text: "y" }, runContext(COMPANY_B, AGENT_CEO));
    // COMPANY_B has no plugin config of its own, so the other company's mailboxes
    // are not even visible to it.
    expect(result.error).toMatch(/no mailboxes configured|not available to this company/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(worker.activity).toHaveLength(0);
  });

  it("refuses to send when sending is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const config = serverConfig(993);
    config.send = { transport: "disabled" };
    const worker = await newWorker({ configs: { [COMPANY_A]: config } });

    const result = await worker.call("send", { to: ["a@b.example"], subject: "x", text: "y" });
    expect(result.error).toMatch(/disabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty recipient list and an empty body", async () => {
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(993) } });
    expect((await worker.call("send", { to: [], subject: "x", text: "y" })).error).toMatch(/recipient/);
    expect((await worker.call("send", { to: ["a@b.example"], subject: "x", text: "  " })).error).toMatch(/`text`/);
    expect((await worker.call("send", { to: ["a@b.example"], subject: "", text: "y" })).error).toMatch(/`subject`/);
  });

  it("refuses to forge another sender when a second mailbox is not assigned", async () => {
    const config = serverConfig(993);
    config.accounts.push({
      key: "bai-support",
      address: "support@agentmail.baisoln.com",
      displayName: "Baisoln Support",
      password: "other-secret",
      companyIds: [COMPANY_B],
    });
    const worker = await newWorker({ configs: { [COMPANY_A]: config } });

    // Naming another company's mailbox is refused, not silently used.
    const result = await worker.call("send", { account: "bai-support", to: ["a@b.example"], subject: "x", text: "y" });
    expect(result.error).toMatch(/not available to this company/);
  });

  it("reports the provider rejection instead of pretending success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<ErrorResponse><Error><Code>MessageRejected</Code><Message>not verified</Message></Error></ErrorResponse>", { status: 400 }),
      ),
    );
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(993) } });
    const result = await worker.call("send", { to: ["a@b.example"], subject: "x", text: "y" });
    expect(result.error).toMatch(/MessageRejected/);
    expect(worker.activity).toHaveLength(0);
  });

  it("threads a reply through In-Reply-To", async () => {
    const fetchMock = vi.fn(async () => new Response(sesOk("ses-thread"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(993) } });
    await worker.call("send", {
      to: ["human@gmail.example"],
      subject: "Re: invoice",
      text: "attached",
      inReplyTo: "their-msg@gmail.example",
    });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    const raw = Buffer.from(body.get("RawMessage.Data") ?? "", "base64").toString("utf8");
    expect(raw).toContain("In-Reply-To: <their-msg@gmail.example>");
    expect(raw).toContain("From: Reliora Support <support@agentmail.reliora.ai>");
  });
});

describe("mailbox tools against the mail server", () => {
  async function withServer(mails: Array<{ uid: number; from: string; subject: string; body: string; flags?: string[] }> = []) {
    const server = new FakeImapServer();
    await server.listen();
    for (const mail of mails) server.addMail(mail.uid, mail.from, mail.subject, mail.body, mail.flags ?? []);
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(server.port) } });
    return { server, worker };
  }

  it("lists unread mail newest first and hands back a usable uid", async () => {
    const { server, worker } = await withServer([
      { uid: 1, from: "Old <old@gmail.example>", subject: "old mail", body: "ancient", flags: ["\\Seen"] },
      { uid: 2, from: "Priya <priya@gmail.example>", subject: "invoice", body: "can you send the invoice?" },
      { uid: 3, from: "Leo <leo@outlook.example>", subject: "renewal", body: "our contract renews" },
    ]);

    const result = await worker.call("list_inbox", { unreadOnly: true });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("uid=3");
    expect(result.content).toContain("uid=2");
    expect(result.content).not.toContain("uid=1");
    expect(result.content).toContain("Priya <priya@gmail.example>");
    expect(result.content).toContain("read_message");

    const requests = server.requests.join("\n");
    expect(requests).toContain('LOGIN "support@agentmail.reliora.ai" "mailbox-secret"');
    expect(requests).toContain('SELECT "INBOX"');
    expect(requests).toContain("UID SEARCH UNSEEN");
    expect(requests).toContain("UID FETCH 2:3 (UID FLAGS BODY.PEEK[])");

    const data = result.data as { messages: Array<{ uid: number; unread: boolean }> };
    expect(data.messages.map((row) => row.uid)).toEqual([3, 2]);
    expect(data.messages[0]).toMatchObject({ uid: 3, unread: true });
  });

  it("honours limit and returns an empty-listing answer without erroring", async () => {
    const { worker } = await withServer([
      { uid: 1, from: "one <one@x.example>", subject: "one", body: "1", flags: ["\\Seen"] },
      { uid: 2, from: "two <two@x.example>", subject: "two", body: "2", flags: ["\\Seen"] },
      { uid: 3, from: "three <three@x.example>", subject: "three", body: "3", flags: ["\\Seen"] },
    ]);
    const limited = await worker.call("list_inbox", { limit: 2 });
    expect(((limited.data as { messages: unknown[] }).messages)).toHaveLength(2);
    expect(limited.content).toContain("uid=3");
    expect(limited.content).not.toContain("uid=1");

    const empty = await worker.call("list_inbox", { unreadOnly: true, limit: 5 });
    expect(empty.error).toBeUndefined();
    expect(empty.content).toMatch(/no unread messages/);
    expect((empty.data as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("rejects an out-of-range limit before dialling the server", async () => {
    const { server, worker } = await withServer();
    expect((await worker.call("list_inbox", { limit: 500 })).error).toMatch(/`limit` must be an integer/);
    expect(server.requests).toHaveLength(0);
  });

  it("reads one message whole, with the ids needed to reply", async () => {
    const { worker } = await withServer([
      { uid: 7, from: "Priya <priya@gmail.example>", subject: "invoice #41", body: "Please send invoice 41 today." },
    ]);
    const result = await worker.call("read_message", { uid: 7 });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Subject: invoice #41");
    expect(result.content).toContain("Message-ID: <mid-7@gmail.example>");
    expect(result.content).toContain("Please send invoice 41 today.");
    expect(result.content).toContain("untrusted");
    const data = result.data as { messageId: string; from: string; unread: boolean };
    expect(data.messageId).toBe("mid-7@gmail.example");
    expect(data.from).toBe("priya@gmail.example");
    expect(data.unread).toBe(true);
  });

  it("says so when the uid is gone", async () => {
    const { worker } = await withServer([{ uid: 7, from: "a <a@b.example>", subject: "s", body: "b" }]);
    expect((await worker.call("read_message", { uid: 999 })).error).toMatch(/no message with uid 999/);
    expect((await worker.call("read_message", {})).error).toMatch(/`uid` is required/);
  });

  it("marks handled mail read, and reports a uid the server did not have", async () => {
    const { server, worker } = await withServer([
      { uid: 5, from: "a <a@b.example>", subject: "one", body: "1" },
      { uid: 6, from: "b <b@b.example>", subject: "two", body: "2" },
    ]);
    const result = await worker.call("mark_read", { uids: [5, 6] });
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/2 message/);
    expect(server.markedSeen).toEqual([5, 6]);
    expect(server.requests.join("\n")).toContain("UID STORE 5:6 +FLAGS.SILENT (\\Seen)");

    const unreadAgain = await worker.call("mark_read", { uid: 5, read: false });
    expect(unreadAgain.error).toBeUndefined();
    expect(server.markedUnseen).toEqual([5]);

    expect((await worker.call("mark_read", {})).error).toMatch(/`uid` or `uids`/);
  });

  it("surfaces a mail server failure as an actionable error", async () => {
    const server = new FakeImapServer();
    server.refuseLogin = true;
    await server.listen();
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(server.port) } });
    const result = await worker.call("list_inbox", {});
    expect(result.error).toMatch(/mail server error/);
    expect(result.error).toMatch(/SELECT|LOGIN/);
    expect(worker.logs.warn).toHaveBeenCalled();
  });

  it("resolves a saved-secret password through the host, naming its config path", async () => {
    const { server, worker } = await withServer([{ uid: 1, from: "a <a@b.example>", subject: "s", body: "b" }]);
    const config = serverConfig(server.port);
    config.accounts[0]!.password = { type: "secret_ref", secretId: SECRET_ID };
    const scoped = await newWorker({ configs: { [COMPANY_A]: config } });
    const result = await scoped.call("list_inbox", {});
    expect(result.error).toBeUndefined();
    expect(scoped.resolveSecret).toHaveBeenCalled();
    expect((scoped.resolveSecret.mock.calls[0] as unknown as [unknown, { configPath: string }])[1].configPath).toBe(
      "accounts.0.password",
    );
    expect(server.loginLine).toContain("mailbox-secret");
    // The resolved password is not written to state or entities.
    expect(JSON.stringify([...scoped.state.values()])).not.toContain("mailbox-secret");
    void worker;
  });
});

describe("poll-inbox job", () => {
  async function runJob(worker: Awaited<ReturnType<typeof newWorker>>, runId = "job-1") {
    const job = worker.jobs.get("poll-inbox");
    if (!job) throw new Error("poll job not registered");
    await job({ runId, trigger: "schedule", jobKey: "poll-inbox" } as unknown as PluginJobContext);
  }

  it("records new mail, advances the watermark once, and notifies the owning company", async () => {
    const server = new FakeImapServer();
    await server.listen();
    server.addMail(11, "Priya <priya@gmail.example>", "invoice", "please send it");
    server.addMail(12, "Leo <leo@outlook.example>", "renewal", "our contract renews");
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(server.port) } });

    await runJob(worker);

    expect(worker.events).toHaveLength(2);
    expect(worker.events[0]!.name).toBe("mail-received");
    expect(worker.events[0]!.companyId).toBe(COMPANY_A);
    expect(JSON.stringify(worker.events[1]!.payload)).toContain("renewal");

    expect(worker.entities).toHaveLength(2);
    expect(worker.entities[0]).toMatchObject({
      entityType: "loc-agentmail-message",
      scopeKind: "company",
      scopeId: COMPANY_A,
      externalId: "rel-support:11",
      status: "received",
    });
    // Envelope plus a snippet only: bodies stay in the mailbox, which is why the
    // connector needs no object storage of its own.
    const data = worker.entities[0]!.data as Record<string, unknown>;
    expect(Object.keys(data)).not.toContain("body");
    expect(Object.keys(data)).not.toContain("html");
    expect(data.textChars).toBe(16);

    expect(worker.state.get(
      stateKey({ scopeKind: "company", scopeId: COMPANY_A, namespace: "loc-agentmail", stateKey: "uid-watermark:rel-support" }),
    )).toBe(12);

    expect(worker.activity[0]!.message).toContain("Recorded 2 inbound message");

    // A second run must not re-announce the same mail.
    await runJob(worker, "job-2");
    expect(worker.events).toHaveLength(2);
    expect(worker.entities).toHaveLength(2);
    expect(server.requests.filter((line) => line.startsWith("UID SEARCH"))).toEqual(["UID SEARCH UID 1:* UNSEEN", "UID SEARCH UID 13:* UNSEEN"]);
  });

  it("does not advance the watermark over mail it could not fetch", async () => {
    const server = new FakeImapServer();
    await server.listen();
    server.addMail(11, "a <a@b.example>", "kept", "body", ["\\Seen"]);
    server.addMail(12, "b <b@b.example>", "kept2", "body", ["\\Seen"]);
    // markSeen = false above, so UNSEEN mail is 11 and 12 here:
    server.mails.forEach((mail) => (mail.flags = []));
    const config = serverConfig(server.port);
    // A mailbox that drifted far behind is drained in bounded batches.
    config.poll.maxMessagesPerAccount = 1;
    const worker = await newWorker({ configs: { [COMPANY_A]: config } });

    await runJob(worker);
    expect(worker.entities).toHaveLength(1);
    expect(worker.state.get(
      stateKey({ scopeKind: "company", scopeId: COMPANY_A, namespace: "loc-agentmail", stateKey: "uid-watermark:rel-support" }),
    )).toBe(11);

    await runJob(worker, "job-2");
    expect(worker.entities).toHaveLength(2);
    expect(worker.events).toHaveLength(2);
  });

  it("marks mail read when the operator opted in", async () => {
    const server = new FakeImapServer();
    await server.listen();
    server.addMail(21, "a <a@b.example>", "one", "body");
    const config = serverConfig(server.port);
    config.poll.markSeen = true;
    const worker = await newWorker({ configs: { [COMPANY_A]: config } });

    await runJob(worker);
    expect(server.markedSeen).toEqual([21]);
    // With markSeen the criteria carry no UNSEEN, so the watermark alone prevents repeats.
    expect(server.requests.join("\n")).toContain("UID SEARCH UID 1:*");
    expect(worker.events).toHaveLength(1);
  });

  it("reports a failing mailbox in the health snapshot without stopping the run", async () => {
    const dead = new FakeImapServer();
    await dead.listen();
    const deadPort = dead.port;
    await dead.close();

    const config = serverConfig(deadPort);
    config.accounts.push({
      key: "rel-info",
      address: "info@agentmail.reliora.ai",
      displayName: "Reliora Info",
      password: "s2",
      companyIds: [COMPANY_A],
    });
    const worker = await newWorker({ configs: { [COMPANY_A]: config } });
    const job = worker.jobs.get("poll-inbox")!;
    await job({ runId: "job-dead", trigger: "schedule", jobKey: "poll-inbox" } as unknown as PluginJobContext);

    const snapshot = worker.state.get(stateKey({ scopeKind: "instance", namespace: "loc-agentmail", stateKey: "health" })) as {
      lastRun: { failures: Array<{ account: string; error: string }>; recorded: number };
    };
    expect(snapshot.lastRun.recorded).toBe(0);
    expect(snapshot.lastRun.failures.map((failure) => failure.account)).toContain("rel-support");
    expect(worker.logs.error).toHaveBeenCalled();
    // Nothing was announced, so no company activity was written.
    expect(worker.activity).toHaveLength(0);
  });

  it("skips a company that turned polling off", async () => {
    const server = new FakeImapServer();
    await server.listen();
    server.addMail(1, "a <a@b.example>", "s", "b");
    const config = serverConfig(server.port);
    config.poll.enabled = false;
    const worker = await newWorker({ configs: { [COMPANY_A]: config } });
    await runJob(worker);
    expect(server.requests).toHaveLength(0);
    expect(worker.events).toHaveLength(0);
  });

  it("polls one mailbox once even when two companies claim it", async () => {
    const server = new FakeImapServer();
    await server.listen();
    server.addMail(1, "a <a@b.example>", "shared", "body");
    const config = serverConfig(server.port);
    config.accounts[0]!.companyIds = [COMPANY_A, COMPANY_B];
    const worker = await newWorker({
      companies: [
        { id: COMPANY_A, name: "Reliora" },
        { id: COMPANY_B, name: "Baisoln" },
      ],
      configs: { [COMPANY_A]: config, [COMPANY_B]: config },
    });
    await runJob(worker);
    expect(worker.entities).toHaveLength(1);
    expect(server.requests.filter((line) => line.startsWith("UID FETCH"))).toHaveLength(1);
    expect(worker.events[0]!.companyId).toBe(COMPANY_A);
  });
});

describe("onHealth", () => {
  it("is ok when the mail server answers CAPABILITY", async () => {
    const server = new FakeImapServer();
    await server.listen();
    server.addMail(1, "a <a@b.example>", "s", "b");
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(server.port) } });
    const health = await worker.plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
    expect(health.message).toContain(`127.0.0.1:${server.port}`);
    expect(health.details).toMatchObject({ tlsMode: "none", configuredCompanyCount: 1, mailboxes: [{ key: "rel-support", address: "support@agentmail.reliora.ai" }] });
    expect(JSON.stringify(health.details)).not.toContain("mailbox-secret");
  });

  it("is degraded when the configuration is present but the server is unreachable", async () => {
    const dead = new FakeImapServer();
    await dead.listen();
    const port = dead.port;
    await dead.close();
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(port) } });
    const health = await worker.plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(health.message).toMatch(/imap is unreachable/);
  });

  it("is an error until an operator configures a mailbox", async () => {
    const worker = await newWorker({ configs: {} });
    const health = await worker.plugin.definition.onHealth!();
    expect(health.status).toBe("error");
    expect(health.message).toMatch(/No mailboxes are configured/);
  });

  it("warns when the server refuses plaintext LOGIN", async () => {
    const server = new FakeImapServer();
    server.capabilities = ["IMAP4rev1", "LOGINDISABLED"];
    await server.listen();
    const worker = await newWorker({ configs: { [COMPANY_A]: serverConfig(server.port) } });
    const health = await worker.plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(health.message).toMatch(/refuses LOGIN over a plaintext connection/);
  });
});

describe("onValidateConfig", () => {
  const validate = async (config: unknown) => {
    const worker = await newWorker();
    return worker.plugin.definition.onValidateConfig!(config as Record<string, unknown>) as Promise<PluginConfigValidationResult>;
  };

  it("reports every configuration defect in one answer", async () => {
    const result = await validate({
      imap: { host: "", tlsMode: "starttls" },
      send: { transport: "ses-api" },
      accounts: [{ key: "Bad Key", address: "nope", password: "x", companyIds: [] }],
    });
    expect(result.ok).toBe(false);
    const joined = (result.errors ?? []).join("\n");
    expect(joined).toMatch(/imap.host is required/);
    expect(joined).toMatch(/tlsMode must be one of/);
    expect(joined).toMatch(/lowercase slug/);
    expect(joined).toMatch(/not a valid email address/);
  });

  it("tests the mail server for real and says what it found", async () => {
    const server = new FakeImapServer();
    await server.listen();
    const worker = await newWorker();
    const result = await worker.plugin.definition.onValidateConfig!(serverConfig(server.port));
    expect(result.ok).toBe(true);
    // No credentials in a reachability probe.
    expect(server.loginLine).toBe("");
    expect(server.requests.some((line) => line === "CAPABILITY")).toBe(true);
  });

  it("fails the test when the host cannot be reached", async () => {
    const dead = new FakeImapServer();
    await dead.listen();
    const port = dead.port;
    await dead.close();
    const worker = await newWorker();
    const result = await worker.plugin.definition.onValidateConfig!(serverConfig(port));
    expect(result.ok).toBe(false);
    expect((result.errors ?? []).join(" ")).toMatch(/could not reach the mail server at 127\.0\.0\.1:/);
  });

  it("warns about the ways a config can be legal but sharp-edged", async () => {
    const server = new FakeImapServer();
    await server.listen();
    const config = serverConfig(server.port);
    config.send = { transport: "disabled" };
    config.poll = { enabled: false, maxMessagesPerAccount: 25, markSeen: true };
    const worker = await newWorker();
    const result = await worker.plugin.definition.onValidateConfig!(config);
    expect(result.ok).toBe(true);
    const joined = (result.warnings ?? []).join("\n");
    expect(joined).toMatch(/disabled/);
    expect(joined).toMatch(/poll.enabled is false/);
    expect(joined).toMatch(/markSeen/);
    expect(joined).toMatch(/in the clear/);
  });
});


// ---------------------------------------------------------------------------
// Documents: agreement attachments and Drive filing
// ---------------------------------------------------------------------------

const AGREEMENT = "reliora-dp-agreement-v1.0";
const DRIVE_URL = "http://drive.test/mcp";
const agreementFields = {
  partnerLegalName: "Example Systems Ltd",
  signatoryName: "Ada Test",
  signatoryTitle: "Head of Platform",
  signatoryEmail: "ada@example.com",
  applicationReference: "DP-ABC12345",
  applicationSignedAt: "2026-11-02T09:29:19.000Z",
};

function documentsConfig(port: number) {
  const config = serverConfig(port) as Record<string, unknown> & { accounts: Array<Record<string, unknown>> };
  config.accounts[0].documentTemplates = [AGREEMENT];
  config.drive = {
    mcpUrl: DRIVE_URL,
    tenantId: "base",
    account: "bionicorg",
    folders: { "dp-sent": "folderSent0001", "dp-received": "folderRecv0001", "dp-executed": "folderExec0001" },
  };
  return config;
}

/** One fetch double for SES and the Drive MCP server. */
function fetchDouble(opts: { driveFails?: boolean } = {}) {
  const drive: Array<{ method: string; args?: Record<string, unknown> }> = [];
  const ses: string[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).startsWith(DRIVE_URL)) {
      const msg = JSON.parse(String(init.body));
      drive.push({ method: msg.method, args: msg.params?.arguments });
      if (msg.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26" } }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
        });
      }
      const payload = opts.driveFails
        ? { success: false, error: "File not found: folderSent0001" }
        : { success: true, data: { id: "driveFile123", name: msg.params.arguments.name, webViewLink: "https://drive.google.com/file/d/driveFile123/view" } };
      // FastMCP's SSE framing, to prove the client reads event streams too.
      return new Response(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false } })}\r\n\r\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const body = new URLSearchParams(String(init.body));
    ses.push(Buffer.from(body.get("RawMessage.Data") ?? "", "base64").toString("latin1"));
    return new Response(sesOk(`ses-msg-${ses.length}`), { status: 200 });
  });
  return { fn, drive, ses };
}

describe("send with an agreement attached", () => {
  it("renders the approved PDF, sends it to the signatory only, and returns ids and hashes", async () => {
    const f = fetchDouble();
    vi.stubGlobal("fetch", f.fn);
    const worker = await newWorker({ configs: { [COMPANY_A]: documentsConfig(993) } });
    const result = await worker.call("send", {
      to: ["Ada@Example.com"],
      subject: "Your Srenix Design Partner agreement (DP-ABC12345)",
      text: "Please sign the attached agreement.",
      attachments: [{ template: AGREEMENT, fields: agreementFields }],
    });
    expect(result.error).toBeUndefined();
    const data = result.data as { messageId: string; documents: Array<{ sha256: string; filename: string }> };
    expect(data.messageId).toMatch(/@agentmail\.reliora\.ai$/);
    expect(result.content).toContain(`Message-ID: <${data.messageId}>`);

    const { parseAttachments } = await import("./mime.js");
    const atts = parseAttachments(f.ses[0]!);
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe("example-systems-ltd-dp-agreement-v1.0-DP-ABC12345.pdf");
    expect(atts[0].sha256).toBe(data.documents[0].sha256);
    expect(atts[0].bytes.subarray(0, 5).toString()).toBe("%PDF-");

    const entry = worker.activity.at(-1)!;
    expect(JSON.stringify(entry.metadata)).toContain(data.documents[0].sha256);
    expect(JSON.stringify(entry.metadata)).toContain(data.messageId);
  });

  it("refuses any recipient other than the signatory, any cc, and a mailbox without the template", async () => {
    const f = fetchDouble();
    vi.stubGlobal("fetch", f.fn);
    const worker = await newWorker({ configs: { [COMPANY_A]: documentsConfig(993) } });
    const base = { subject: "s", text: "t", attachments: [{ template: AGREEMENT, fields: agreementFields }] };
    expect((await worker.call("send", { ...base, to: ["attacker@evil.example"] })).error).toMatch(/must be exactly the signatoryEmail/);
    expect((await worker.call("send", { ...base, to: ["ada@example.com", "attacker@evil.example"] })).error).toMatch(/must be exactly/);
    expect((await worker.call("send", { ...base, to: ["ada@example.com"], cc: ["attacker@evil.example"] })).error).toMatch(/cc/);
    expect((await worker.call("send", { ...base, to: ["ada@example.com"], attachments: [{ template: AGREEMENT, fields: agreementFields }, { template: AGREEMENT, fields: agreementFields }] })).error).toMatch(/at most one/);
    expect((await worker.call("send", { ...base, to: ["ada@example.com"], attachments: [{ template: AGREEMENT, fields: { ...agreementFields, injected: "x" } }] })).error).toMatch(/unknown fields/);

    const noTemplate = documentsConfig(993);
    noTemplate.accounts[0].documentTemplates = [];
    const other = await newWorker({ configs: { [COMPANY_A]: noTemplate } });
    expect((await other.call("send", { ...base, to: ["ada@example.com"] })).error).toMatch(/not allowed to send/);
    expect(f.ses).toHaveLength(0);
  });

  it("files the exact sent bytes in Drive in the same call", async () => {
    const f = fetchDouble();
    vi.stubGlobal("fetch", f.fn);
    const worker = await newWorker({ configs: { [COMPANY_A]: documentsConfig(993) } });
    const result = await worker.call("send", {
      to: ["ada@example.com"],
      subject: "s",
      text: "t",
      attachments: [{ template: AGREEMENT, fields: agreementFields }],
      fileSentCopyTo: "dp-sent",
    });
    expect(result.error).toBeUndefined();
    const upload = f.drive.find((c) => c.method === "tools/call")!;
    expect(upload.args).toMatchObject({ tenant_id: "base", account: "bionicorg", folder_id: "folderSent0001", content_is_base64: true, mime_type: "application/pdf" });
    const { parseAttachments } = await import("./mime.js");
    const sentBytes = parseAttachments(f.ses[0]!)[0].bytes;
    expect(Buffer.from(String(upload.args!.content), "base64").equals(sentBytes)).toBe(true);
    expect((result.data as { sentCopy: { status: string } }).sentCopy.status).toBe("filed");
  });

  it("checks the folder before sending, and reports a filing failure after a send loudly", async () => {
    const f = fetchDouble({ driveFails: true });
    vi.stubGlobal("fetch", f.fn);
    const worker = await newWorker({ configs: { [COMPANY_A]: documentsConfig(993) } });
    const base = { to: ["ada@example.com"], subject: "s", text: "t", attachments: [{ template: AGREEMENT, fields: agreementFields }] };
    expect((await worker.call("send", { ...base, fileSentCopyTo: "nowhere" })).error).toMatch(/unknown Drive folder/);
    expect(f.ses).toHaveLength(0);

    const result = await worker.call("send", { ...base, fileSentCopyTo: "dp-sent" });
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/WAS sent, but filing the sent copy FAILED: .*File not found/);
    expect(worker.activity.some((a) => /FAILED to file the sent copy/.test(a.message))).toBe(true);
  });
});

describe("attachments in received mail", () => {
  const pdfBytes = Buffer.from("%PDF-1.7\n% signed agreement\n" + "x".repeat(500), "latin1");
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const pdfSha = createHash("sha256").update(pdfBytes).digest("hex");
  const signedReply = (attachment: Buffer, filename = "example-signed.pdf") =>
    [
      "From: Ada Test <ada@example.com>",
      "To: support@agentmail.reliora.ai",
      "Subject: Re: Your agreement",
      "Date: Mon, 2 Nov 2026 12:00:00 +0000",
      "Message-Id: <reply-1@gmail.example>",
      "In-Reply-To: <sent-1@agentmail.reliora.ai>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "Signed copy attached.",
      "--b1",
      `Content-Type: application/pdf; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      attachment.toString("base64"),
      "--b1--",
      "",
    ].join("\r\n");

  async function withServer(mails: string[]) {
    const server = new FakeImapServer();
    mails.forEach((raw, i) => server.mails.push({ uid: i + 1, seq: i + 1, flags: [], raw }));
    await server.listen();
    return server;
  }

  it("lists attachments with hashes in read_message, without content", async () => {
    const server = await withServer([signedReply(pdfBytes)]);
    try {
      const worker = await newWorker({ configs: { [COMPANY_A]: documentsConfig(server.port) } });
      const result = await worker.call("read_message", { uid: 1 });
      expect(result.content).toContain(`Attachment 0: example-signed.pdf (application/pdf, ${pdfBytes.length} bytes, sha256 ${pdfSha})`);
      const data = result.data as { attachments: Array<Record<string, unknown>>; inReplyTo: string };
      expect(data.inReplyTo).toBe("sent-1@agentmail.reliora.ai");
      expect(data.attachments[0]).not.toHaveProperty("bytes");
    } finally {
      await server.close();
    }
  });

  it("files the attachment only when the hash matches, only as a PDF, only to a configured folder", async () => {
    const notPdf = Buffer.from("MZ not a pdf", "latin1");
    const server = await withServer([signedReply(pdfBytes), signedReply(notPdf, "evil.pdf")]);
    try {
      const f = fetchDouble();
      vi.stubGlobal("fetch", f.fn);
      const worker = await newWorker({ configs: { [COMPANY_A]: documentsConfig(server.port) } });
      const args = { uid: 1, attachmentIndex: 0, sha256: pdfSha, folder: "dp-received", name: "example-dp-agreement-signed-2026-11-02.pdf" };

      expect((await worker.call("create_drive_file", { ...args, sha256: "0".repeat(64) })).error).toMatch(/not the 0+ you read/);
      expect((await worker.call("create_drive_file", { ...args, folder: "anywhere" })).error).toMatch(/unknown Drive folder/);
      expect((await worker.call("create_drive_file", { ...args, name: "../x.pdf" })).error).toMatch(/plain file name/);
      const notPdfSha = createHash("sha256").update(notPdf).digest("hex");
      expect((await worker.call("create_drive_file", { ...args, uid: 2, sha256: notPdfSha })).error).toMatch(/not a PDF/);
      expect(f.drive.filter((c) => c.method === "tools/call")).toHaveLength(0);
      expect(worker.activity.filter((a) => /REFUSED to file/.test(a.message)).length).toBeGreaterThanOrEqual(2);

      const ok = await worker.call("create_drive_file", args);
      expect(ok.error).toBeUndefined();
      const upload = f.drive.find((c) => c.method === "tools/call")!;
      expect(upload.args).toMatchObject({ folder_id: "folderRecv0001", name: args.name });
      expect(Buffer.from(String(upload.args!.content), "base64").equals(pdfBytes)).toBe(true);
      const data = ok.data as { inReplyTo: string; drive: { fileId: string } };
      expect(data.inReplyTo).toBe("sent-1@agentmail.reliora.ai");
      expect(data.drive.fileId).toBe("driveFile123");
    } finally {
      await server.close();
    }
  });
});
