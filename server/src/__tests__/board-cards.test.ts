import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agents, approvals, chatActions, chatEndpointResources, chatEndpoints, companies, createDb,
  issueThreadInteractions, issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import { BOARD_CARD_KIND, BOARD_CARD_PROCESSING_STALE_MS, createBoardCards } from "../services/chat-channels/board-cards.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

const SENTINEL = "SENTINEL-ARGUMENT-7f3c";

type Sent = { op: "post" | "edit"; threadId: string; messageId?: string; text: string; card: unknown };

describeDatabase("board-channel cards", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyIds: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-board-cards-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(async () => {
    for (const companyId of companyIds.splice(0)) {
      await db.delete(chatActions).where(eq(chatActions.companyId, companyId));
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
      await db.delete(approvals).where(eq(approvals.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(opts: { channel?: Record<string, unknown> | null; failPost?: Error } = {}) {
    const prefix = `BC${randomUUID().slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: `Board ${randomUUID()}`, issuePrefix: prefix }).returning();
    companyIds.push(company.id);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "COO" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "Slack", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Slack", uid: randomUUID(), transport: "mcp_remote" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company.id, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", publicId: randomUUID(), status: "active" }).returning();
    const [resource] = await db.insert(chatEndpointResources).values({ companyId: company.id, endpointId: endpoint.id, type: "channel", providerResourceId: "slack:C0BOARD", label: "#board", enabled: true, boardCards: true }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Send the agreement", identifier: `${prefix}-1`, issueNumber: 1 } as typeof issues.$inferInsert).returning();
    const sent: Sent[] = [];
    let clock = Date.now();
    const cards = createBoardCards(db, {
      now: () => clock,
      publicBaseUrl: () => "https://org.example.com",
      inspectSlackBoardChannel: async () => (opts.channel === undefined ? { private: true, extShared: false } : opts.channel),
      runtimeFor: async () => ({
        thread: (threadId: string) => ({
          id: threadId,
          post: async (message: { card: unknown; fallbackText: string }) => {
            if (opts.failPost) throw opts.failPost;
            const id = `ts-${sent.length + 1}`;
            sent.push({ op: "post", threadId, messageId: id, text: message.fallbackText, card: message.card });
            return { id };
          },
          adapter: {
            editMessage: async (id: string, messageId: string, message: { card: unknown; fallbackText: string }) => {
              sent.push({ op: "edit", threadId: id, messageId, text: message.fallbackText, card: message.card });
              return { id: messageId };
            },
          },
        }),
      }) as never,
    });
    const run = async () => { clock += 30_000; await cards.processPendingBoardCards(); };
    const interaction = async (values: Partial<typeof issueThreadInteractions.$inferInsert> & { payload: Record<string, unknown> }, issueId = issue.id) => {
      const [row] = await db.insert(issueThreadInteractions).values({
        companyId: company.id, issueId, kind: "request_confirmation", status: "pending", createdByAgentId: agent.id, ...values,
      } as typeof issueThreadInteractions.$inferInsert).returning();
      return row;
    };
    const cardRows = () => db.select().from(chatActions).where(and(eq(chatActions.companyId, company.id), eq(chatActions.kind, BOARD_CARD_KIND)));
    return { company, agent, endpoint, resource, issue, sent, run, interaction, cardRows, advance: (ms: number) => { clock += ms; }, prefix };
  }

  const toolActionPayload = (actionRequestId = randomUUID()) => ({
    version: 1,
    prompt: "Approve: Send email to ada@example.com?",
    detailsMarkdown: `Arguments reviewed for execution:\n\`\`\`json\n{"body":"${SENTINEL}"}\n\`\`\``,
    toolAction: {
      version: 1, actionRequestId, toolName: "paperclip.loc-agentmail:send", risk: "write",
      previewMarkdown: "Send an email with the Design Partner agreement to ada@example.com",
      argumentsSummaryJson: `{"body":"${SENTINEL}"}`,
    },
  });

  it("posts a pending tool action top-level with the preview and never the arguments", async () => {
    const f = await fixture();
    await f.interaction({ payload: toolActionPayload() });
    await f.run();
    expect(f.sent).toHaveLength(1);
    const [post] = f.sent;
    expect(post.op).toBe("post");
    expect(post.threadId).toBe("slack:C0BOARD:");
    expect(post.text).toContain("Send an email with the Design Partner agreement");
    expect(post.text).toContain("COO asks on");
    expect(JSON.stringify(post)).not.toContain(SENTINEL);
    // Another pass does not post it again.
    await f.run();
    expect(f.sent).toHaveLength(1);
  });

  it("edits the card to the outcome when the decision is made in Paperclip", async () => {
    const f = await fixture();
    const row = await f.interaction({ payload: toolActionPayload() });
    await f.run();
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, row.id));
    await f.run();
    await f.run();
    expect(f.sent.map((s) => s.op)).toEqual(["post", "edit"]);
    expect(f.sent[1].messageId).toBe("ts-1");
    expect(f.sent[1].text).toMatch(/^Approved:/);
  });

  it("posts a content-free card for a private task", async () => {
    const f = await fixture();
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issue.id));
    await f.interaction({ payload: toolActionPayload() });
    await f.run();
    expect(f.sent[0].text).toContain("A task needs board attention");
    expect(f.sent[0].text).not.toContain("Send an email");
    expect(f.sent[0].text).not.toContain("Send the agreement");
  });

  it("gives a tool action behind a formal approval one card, link-only, naming both decisions", async () => {
    const f = await fixture();
    const actionRequestId = randomUUID();
    await db.insert(approvals).values({ companyId: f.company.id, type: "request_board_approval", requestedByAgentId: f.agent.id,
      payload: { title: "Approve: delete repo", summary: "destructive", source: "tool_gateway", actionRequestId } });
    await f.interaction({ payload: { ...toolActionPayload(actionRequestId), toolAction: { ...toolActionPayload(actionRequestId).toolAction, risk: "destructive" } } });
    await f.run();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].text).toContain("needs two decisions in Paperclip");
    expect(JSON.stringify(f.sent[0].card)).not.toMatch(/"type":"button"(?![^}]*url)/);
  });

  it("posts ordinary approvals link-only with title and summary, never the payload", async () => {
    const f = await fixture();
    await db.insert(approvals).values({ companyId: f.company.id, type: "hire_agent", requestedByAgentId: f.agent.id,
      payload: { title: "Hire a Content Marketer", summary: "Needs a writer for the blog", adapterConfig: { apiKey: SENTINEL } } });
    await f.run();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].text).toContain("Hire a Content Marketer");
    expect(f.sent[0].text).toContain(`/${f.prefix}/approvals/`);
    expect(JSON.stringify(f.sent[0])).not.toContain(SENTINEL);
  });

  it("skips agent-chat tasks, agent-addressed and user-created interactions", async () => {
    const f = await fixture();
    const [chatIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "chat", identifier: `${f.prefix}-2`, issueNumber: 2, conversationAgentId: f.agent.id, conversationUserId: "u1", assigneeAgentId: f.agent.id, conversationState: "active" } as typeof issues.$inferInsert).returning();
    await f.interaction({ payload: toolActionPayload() }, chatIssue.id);
    await f.interaction({ payload: toolActionPayload(), addresseeAgentId: f.agent.id });
    await f.interaction({ payload: toolActionPayload(), createdByAgentId: null, createdByUserId: "u1" });
    await f.run();
    expect(f.sent).toHaveLength(0);
  });

  it("never re-sends a post whose delivery is uncertain, and settles it with a follow-up", async () => {
    const f = await fixture();
    const row = await f.interaction({ payload: toolActionPayload() });
    await f.run();
    const [card] = await f.cardRows();
    // Simulate a crash mid-send: the row stays processing with no message id.
    await db.update(chatActions).set({ status: "processing", result: null, updatedAt: new Date(Date.now() - BOARD_CARD_PROCESSING_STALE_MS - 1000) }).where(eq(chatActions.id, card.id));
    f.sent.length = 0;
    await f.run();
    expect(f.sent).toHaveLength(0);
    expect((await f.cardRows()).find((r) => r.id === card.id)?.status).toBe("delivery_unknown");
    await db.update(issueThreadInteractions).set({ status: "rejected" }).where(eq(issueThreadInteractions.id, row.id));
    await f.run();
    await f.run();
    expect(f.sent.map((s) => s.op)).toEqual(["post"]);
    expect(f.sent[0].text).toMatch(/^Rejected:/);
  });

  it("posts nothing when the channel is no longer private and logs why", async () => {
    const f = await fixture({ channel: { private: false } });
    await f.interaction({ payload: toolActionPayload() });
    await f.run();
    expect(f.sent).toHaveLength(0);
    const [card] = await f.cardRows();
    expect(card.status).toBe("cancelled");
    expect(card.result).toMatchObject({ code: "board_channel_unsafe" });
  });

  it("posts a new card when a decided item is re-pended", async () => {
    const f = await fixture();
    const row = await f.interaction({ payload: toolActionPayload() });
    await f.run();
    await db.update(issueThreadInteractions).set({ status: "expired" }).where(eq(issueThreadInteractions.id, row.id));
    await f.run(); await f.run();
    await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, row.id));
    await f.run(); await f.run();
    expect(f.sent.map((s) => s.op)).toEqual(["post", "edit", "post"]);
  });
});
