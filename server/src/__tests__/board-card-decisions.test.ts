import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agents, approvals, chatActions, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks,
  companies, companyMemberships, createDb, issueThreadInteractions, issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import { BOARD_CARD_DECISION_KIND, createBoardCards } from "../services/chat-channels/board-cards.js";
import { createBoardCardDecisions, type ToolActionDecisionInput } from "../services/chat-channels/board-card-decisions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("board-channel card decisions (Slack buttons)", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyIds: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-board-decisions-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(async () => {
    for (const companyId of companyIds.splice(0)) {
      await db.delete(chatActions).where(eq(chatActions.companyId, companyId));
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
      await db.delete(approvals).where(eq(approvals.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.companyId, companyId));
      await db.delete(chatExternalPrincipals).where(eq(chatExternalPrincipals.companyId, companyId));
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(role = "owner") {
    const prefix = `BD${randomUUID().slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: `Board ${randomUUID()}`, issuePrefix: prefix }).returning();
    companyIds.push(company.id);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "COO" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "Slack", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Slack", uid: randomUUID(), transport: "mcp_remote" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company.id, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", publicId: randomUUID(), status: "active" }).returning();
    await db.insert(chatEndpointResources).values({ companyId: company.id, endpointId: endpoint.id, type: "channel", providerResourceId: "slack:C0BOARD", label: "#board", enabled: true, boardCards: true });
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Send the agreement", identifier: `${prefix}-1`, issueNumber: 1, assigneeAgentId: agent.id, status: "in_progress" } as typeof issues.$inferInsert).returning();
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: company.id, provider: "slack", providerAccountId: "T1", externalId: `U${randomUUID().slice(0, 8)}` }).returning();
    const [link] = await db.insert(chatIdentityLinks).values({ companyId: company.id, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: userId, status: "linked" }).returning();
    let clock = Date.now();
    const cards = createBoardCards(db, {
      now: () => clock,
      publicBaseUrl: () => "https://org.example.com",
      inspectSlackBoardChannel: async () => ({ private: true }),
      runtimeFor: async () => ({
        thread: (threadId: string) => ({
          id: threadId,
          post: async () => ({ id: "ts-1" }),
          adapter: { editMessage: async () => ({ id: "ts-1" }) },
        }),
      }) as never,
    });
    const toolCalls: Array<{ op: string; input: ToolActionDecisionInput }> = [];
    const decisions = createBoardCardDecisions(db, {
      approveToolAction: async (input) => { toolCalls.push({ op: "approve", input }); await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, input.interactionId)); return { status: "succeeded" }; },
      declineToolAction: async (input) => { toolCalls.push({ op: "decline", input }); return { status: "declined" }; },
    });
    const post = async () => { clock += 30_000; await cards.processPendingBoardCards(); };
    const interaction = async (payload: Record<string, unknown>) => {
      const [row] = await db.insert(issueThreadInteractions).values({
        companyId: company.id, issueId: issue.id, kind: "request_confirmation", status: "pending", createdByAgentId: agent.id,
        continuationPolicy: "wake_assignee", payload,
      } as typeof issueThreadInteractions.$inferInsert).returning();
      return row;
    };
    const tokens = () => db.select().from(chatActions).where(and(eq(chatActions.companyId, company.id), eq(chatActions.kind, BOARD_CARD_DECISION_KIND)));
    const tokenFor = async (decision: "accept" | "reject") => (await tokens()).find((t) => t.payload.decision === decision)!;
    const click = (actionId: string, overrides: Partial<Parameters<typeof decisions.handleClick>[0]> = {}) => decisions.handleClick({
      endpoint, principalId: principal.id, userId, actionId, messageId: "ts-1", threadId: "slack:C0BOARD:", ...overrides,
    });
    return { company, agent, endpoint, issue, userId, principal, link, post, interaction, tokens, tokenFor, click, toolCalls };
  }

  const plain = { version: 1, prompt: "Publish the roundup page?", acceptLabel: "Publish", rejectLabel: "Hold" };
  const toolPayload = (risk: string) => ({
    version: 1, prompt: "Approve: Send email?",
    toolAction: { version: 1, actionRequestId: randomUUID(), toolName: "paperclip.loc-agentmail:send", risk, previewMarkdown: "Send email", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  });

  it("lets a linked owner accept a plain confirmation from Slack and wakes the assignee", async () => {
    const f = await fixture();
    const row = await f.interaction(plain);
    await f.post();
    const accept = await f.tokenFor("accept");
    expect(await f.click(accept.providerActionId)).toMatchObject({ outcome: "decided", status: "accepted" });
    const [after] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, row.id));
    expect(after.status).toBe("accepted");
    expect(after.resolvedByUserId).toBe(f.userId);
    expect((await f.tokens()).find((t) => t.id === accept.id)?.status).toBe("processed");
    const wake = await db.select().from(chatActions).where(and(eq(chatActions.companyId, f.company.id), eq(chatActions.kind, "interaction_wakeup")));
    expect(wake).toHaveLength(1);
    expect(wake[0].payload).toMatchObject({ interactionId: row.id, interactionStatus: "accepted", agentId: f.agent.id, requestedByUserId: f.userId });
    // The same button again does nothing more.
    expect(await f.click(accept.providerActionId)).toEqual({ outcome: "already_decided" });
  });

  it("refuses a member who is not owner or admin, and changes nothing", async () => {
    const f = await fixture("member");
    const row = await f.interaction(plain);
    await f.post();
    const accept = await f.tokenFor("accept");
    expect(await f.click(accept.providerActionId)).toMatchObject({ outcome: "refused" });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, row.id)))[0].status).toBe("pending");
    expect((await f.tokens()).find((t) => t.id === accept.id)?.status).toBe("issued");
  });

  it("refuses when the Slack link was revoked, the message does not match, or the button expired", async () => {
    const f = await fixture();
    const row = await f.interaction(plain);
    await f.post();
    const accept = await f.tokenFor("accept");
    expect(await f.click(accept.providerActionId, { messageId: "ts-other" })).toMatchObject({ outcome: "refused" });
    await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.id, f.link.id));
    expect(await f.click(accept.providerActionId)).toMatchObject({ outcome: "refused" });
    await db.update(chatIdentityLinks).set({ status: "linked" }).where(eq(chatIdentityLinks.id, f.link.id));
    await db.update(chatActions).set({ payload: { ...accept.payload, expiresAt: new Date(Date.now() - 1000).toISOString() } }).where(eq(chatActions.id, accept.id));
    expect(await f.click(accept.providerActionId)).toMatchObject({ outcome: "refused" });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, row.id)))[0].status).toBe("pending");
  });

  it("decides a read/write tool action through the gateway path, once", async () => {
    const f = await fixture();
    const row = await f.interaction(toolPayload("write"));
    await f.post();
    const accept = await f.tokenFor("accept");
    expect(await f.click(accept.providerActionId)).toMatchObject({ outcome: "decided" });
    expect(f.toolCalls).toEqual([{ op: "approve", input: expect.objectContaining({ interactionId: row.id, actor: { agentId: null, userId: f.userId } }) }]);
    await f.click(accept.providerActionId);
    expect(f.toolCalls).toHaveLength(1);
  });

  it("puts no buttons on destructive, formal-approval or private items", async () => {
    const f = await fixture();
    await f.interaction(toolPayload("destructive"));
    const formal = toolPayload("write");
    await db.insert(approvals).values({ companyId: f.company.id, type: "request_board_approval", payload: { source: "tool_gateway", actionRequestId: formal.toolAction.actionRequestId } });
    await f.interaction(formal);
    await f.post();
    expect(await f.tokens()).toHaveLength(0);
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issue.id));
    await f.interaction(plain);
    await f.post();
    expect(await f.tokens()).toHaveLength(0);
  });

  it("answers 'already decided' when the UI won the race, and retires the button", async () => {
    const f = await fixture();
    const row = await f.interaction(plain);
    await f.post();
    const reject = await f.tokenFor("reject");
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, row.id));
    expect(await f.click(reject.providerActionId)).toEqual({ outcome: "already_decided" });
    expect((await f.tokens()).find((t) => t.id === reject.id)?.status).toBe("expired");
  });

  it("does not let a token from one company act on another company's bot", async () => {
    const a = await fixture();
    const b = await fixture();
    await a.interaction(plain);
    await a.post();
    const accept = await a.tokenFor("accept");
    expect(await b.click(accept.providerActionId)).toMatchObject({ outcome: "refused" });
  });
});
