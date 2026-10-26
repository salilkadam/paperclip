import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, chatActions, chatConversations, chatDeliveries, chatEndpoints, chatMessageLinks, companies, createDb, heartbeatRuns, issueComments, issues, runIdentityContexts, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { boundRunIssueId, boundRunIssueIdSql } from "../run-task-binding.js";
import { chatRunSourceMessageId } from "./run-origin.js";
import { githubGuestBotConnectionForSession } from "../chat-github-tools.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("channel task provenance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-channel-origin-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Channel continuation", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Channel agent", role: "general", adapterType: "codex_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Channel task", assigneeAgentId: agent.id }).returning();
    const [source, continued] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: agent.id, status: "succeeded", contextSnapshot: { issueId: issue.id }, responsibleUserId: "requester" },
      { companyId: company.id, agentId: agent.id, status: "running", nativeIssueId: issue.id, contextSnapshot: {}, responsibleUserId: "requester" },
    ]).returning();
    const messageId = randomUUID();
    const [origin] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: source.id, revision: 1, responsibleUserId: "requester", messageId, cause: "instruction", correlationId: "message" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: continued.id, revision: 1, responsibleUserId: "requester", parentContextId: origin.id, cause: "monitor", correlationId: "dispatch" }).returning();
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, continued.id)).returning();
    return { company, agent, issue, source, run, origin, context, messageId };
  }

  it("recovers the accepted message across repeated native and legacy task continuations", async () => {
    const f = await fixture();
    expect(await chatRunSourceMessageId(db, f.run)).toBe(f.messageId);
    const [next] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", issueId: f.issue.id, responsibleUserId: "requester" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: next.id, revision: 1, responsibleUserId: "requester", parentContextId: f.context.id, cause: "retry", correlationId: "dispatch" }).returning();
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, next.id)).returning();
    expect(await chatRunSourceMessageId(db, run)).toBe(f.messageId);
  });

  it("keeps valid channel authority after more than 100 continuations", async () => {
    const f = await fixture();
    const runs = Array.from({ length: 120 }, () => ({ id: randomUUID(), companyId: f.company.id, agentId: f.agent.id, status: "succeeded", nativeIssueId: f.issue.id, responsibleUserId: "requester" }));
    await db.insert(heartbeatRuns).values(runs);
    const ids = runs.map(() => randomUUID());
    await db.insert(runIdentityContexts).values(runs.map((run, index) => ({ id: ids[index], companyId: f.company.id, runId: run.id, revision: 1, responsibleUserId: "requester", parentContextId: index ? ids[index - 1] : f.context.id, cause: "monitor", correlationId: "dispatch" })));
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: ids.at(-1)! }).where(eq(heartbeatRuns.id, runs.at(-1)!.id)).returning();
    expect(await chatRunSourceMessageId(db, run)).toBe(f.messageId);
  });

  it("stops at a new accepted message instead of borrowing an earlier person's origin", async () => {
    const f = await fixture();
    const messageId = randomUUID();
    await db.update(runIdentityContexts).set({ messageId, responsibleUserId: "new-requester" }).where(eq(runIdentityContexts.id, f.context.id));
    const [run] = await db.update(heartbeatRuns).set({ responsibleUserId: "new-requester", contextSnapshot: { wakeCommentId: f.messageId } }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    expect(await chatRunSourceMessageId(db, run, { allowLegacyWakeComment: true })).toBe(messageId);
  });

  it("recovers a legacy wake only through a verified same-requester parent run", async () => {
    const f = await fixture();
    await db.update(runIdentityContexts).set({ messageId: null }).where(eq(runIdentityContexts.id, f.origin.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, wakeCommentId: f.messageId } }).where(eq(heartbeatRuns.id, f.source.id));
    expect(await chatRunSourceMessageId(db, f.run)).toBeNull();
    expect(await chatRunSourceMessageId(db, f.run, { allowLegacyWakeComment: true })).toBe(f.messageId);
    await db.update(heartbeatRuns).set({ responsibleUserId: "another-person" }).where(eq(heartbeatRuns.id, f.source.id));
    expect(await chatRunSourceMessageId(db, f.run, { allowLegacyWakeComment: true })).toBeNull();
  });

  it("does not borrow GitHub origin from an earlier requester after a board message", async () => {
    const f = await fixture();
    const [message] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", authorUserId: "new-requester", body: "Continue" }).returning();
    await db.update(runIdentityContexts).set({ messageId: message.id, responsibleUserId: "new-requester" }).where(eq(runIdentityContexts.id, f.context.id));
    const [run] = await db.update(heartbeatRuns).set({ responsibleUserId: "new-requester", contextSnapshot: { wakeCommentId: f.messageId } }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    expect(await chatRunSourceMessageId(db, run, { provider: "github", allowLegacyWakeComment: true })).toBeNull();
  });

  it("recovers a legacy GitHub source after a verified same-user board message", async () => {
    const f = await fixture();
    const [message] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", authorUserId: "requester", body: "Continue" }).returning();
    await db.update(runIdentityContexts).set({ messageId: null }).where(eq(runIdentityContexts.id, f.origin.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, wakeCommentId: f.messageId } }).where(eq(heartbeatRuns.id, f.source.id));
    await db.update(runIdentityContexts).set({ messageId: message.id }).where(eq(runIdentityContexts.id, f.context.id));
    const [run] = await db.update(heartbeatRuns).set({ contextSnapshot: { wakeCommentId: message.id } }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    expect(await chatRunSourceMessageId(db, run, { provider: "github", allowLegacyWakeComment: true })).toBe(f.messageId);
    await db.update(heartbeatRuns).set({ responsibleUserId: "another-person" }).where(eq(heartbeatRuns.id, f.source.id));
    expect(await chatRunSourceMessageId(db, run, { provider: "github", allowLegacyWakeComment: true })).toBeNull();
  });

  it.each(["task", "agent", "company", "requester", "missing-parent", "pending-parent", "pending-current", "cycle"])(
    "rejects a %s break in inherited authority", async fault => {
      const f = await fixture();
      if (fault === "task") {
        const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Other task" }).returning();
        const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded", nativeIssueId: other.id }).returning();
        await db.update(runIdentityContexts).set({ runId: otherRun.id }).where(eq(runIdentityContexts.id, f.origin.id));
      }
      if (fault === "agent") {
        const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other agent", role: "general", adapterType: "codex_local" }).returning();
        await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.source.id));
      }
      if (fault === "company") {
        const [other] = await db.insert(companies).values({ name: "Other company", issuePrefix: randomUUID().slice(0, 8) }).returning();
        await db.update(runIdentityContexts).set({ companyId: other.id }).where(eq(runIdentityContexts.id, f.origin.id));
      }
      if (fault === "requester") await db.update(runIdentityContexts).set({ responsibleUserId: "another-person" }).where(eq(runIdentityContexts.id, f.origin.id));
      if (fault === "missing-parent") await db.update(runIdentityContexts).set({ parentContextId: randomUUID() }).where(eq(runIdentityContexts.id, f.context.id));
      if (fault === "pending-parent") await db.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.id, f.origin.id));
      if (fault === "pending-current") await db.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.id, f.context.id));
      if (fault === "cycle") await db.update(runIdentityContexts).set({ messageId: null, parentContextId: f.context.id }).where(eq(runIdentityContexts.id, f.origin.id));
      await expect(chatRunSourceMessageId(db, f.run)).rejects.toMatchObject({ status: 403 });
    },
  );

  // A task one agent run creates for another agent (or another task) carries the
  // creating run's context as its parent. Production: the Content Marketer's
  // REL-3057 run created REL-3060 for the CMO, and the CMO's Slack calls were
  // refused although no chat message existed anywhere in the chain.
  async function derivedFixture(options: { sameAgent?: boolean } = {}) {
    const [company] = await db.insert(companies).values({ name: "Derived task", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [creator, assignee] = await db.insert(agents).values([
      { companyId: company.id, name: "Content Marketer", role: "general", adapterType: "codex_local" },
      { companyId: company.id, name: "CMO", role: "cmo", adapterType: "codex_local" },
    ]).returning();
    const owner = options.sameAgent ? assignee : creator;
    const [originTask, derivedTask] = await db.insert(issues).values([
      { companyId: company.id, title: "Daily blog -> LinkedIn", assigneeAgentId: owner.id },
      { companyId: company.id, title: "Slack board note", assigneeAgentId: assignee.id },
    ]).returning();
    const [originRun, derivedRun] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: owner.id, status: "succeeded", nativeIssueId: originTask.id, responsibleUserId: "requester" },
      { companyId: company.id, agentId: assignee.id, status: "running", nativeIssueId: derivedTask.id, responsibleUserId: "requester" },
    ]).returning();
    const [originContext] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: originRun.id, revision: 1, responsibleUserId: "requester", cause: "issue_assigned", correlationId: "dispatch" }).returning();
    const [derivedContext] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: derivedRun.id, revision: 1, responsibleUserId: "requester", parentContextId: originContext.id, cause: "issue_assigned", correlationId: "dispatch" }).returning();
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: derivedContext.id }).where(eq(heartbeatRuns.id, derivedRun.id)).returning();
    return { company, creator, assignee, originTask, derivedTask, originRun, originContext, derivedContext, run };
  }
  const slackOnly = { allowForeignOriginWithoutChatSource: true } as const;

  it.each([false, true])("lets Slack treat a derived task without chat provenance as an ordinary task (same agent: %s)", async sameAgent => {
    const f = await derivedFixture({ sameAgent });
    expect(await chatRunSourceMessageId(db, f.run, slackOnly)).toBeNull();
    // Callers that did not opt in (GitHub) keep the hard refusal.
    await expect(chatRunSourceMessageId(db, f.run)).rejects.toMatchObject({ status: 403 });
    await expect(chatRunSourceMessageId(db, f.run, { provider: "github", allowLegacyWakeComment: true })).rejects.toMatchObject({ status: 403 });
  });

  it("says which inheritance check refused and on which run and contexts", async () => {
    const f = await derivedFixture();
    await expect(chatRunSourceMessageId(db, f.run)).rejects.toMatchObject({
      status: 403,
      details: {
        code: "chat_provenance_foreign_origin", runId: f.run.id, parentContextId: f.originContext.id,
        parentRunId: f.originRun.id, parentRunFound: true, parentRunAgentId: f.creator.id,
        parentRunIssueId: f.originTask.id, boundIssueId: f.derivedTask.id, foreignOriginAllowed: false,
      },
    });
    // Ids and booleans only: the exact key sets keep message content and user ids out.
    const keys = async (call: Promise<unknown>) => call.then(() => [], (e: { details?: object }) => Object.keys(e.details ?? {}).sort());
    expect(await keys(chatRunSourceMessageId(db, f.run))).toEqual(["agentId", "boundIssueId", "code", "foreignOriginAllowed", "originContextId", "parentContextId", "parentRunAgentId", "parentRunFound", "parentRunId", "parentRunIssueId", "runId"]);
    await db.update(runIdentityContexts).set({ messageId: randomUUID() }).where(eq(runIdentityContexts.id, f.originContext.id));
    await expect(chatRunSourceMessageId(db, f.run, slackOnly)).rejects.toMatchObject({
      status: 403, details: { code: "chat_provenance_foreign_message", contextId: f.originContext.id, contextRunId: f.originRun.id },
    });
    expect(await keys(chatRunSourceMessageId(db, f.run, slackOnly))).toEqual(["code", "contextId", "contextRunId", "runId"]);
  });

  it("lets the gateway's GitHub guest check pass a derived task without chat provenance", async () => {
    // The gateway runs this check while assembling every session's tool list, so a
    // refusal here aborted all tool calls on agent-created tasks in production.
    const f = await derivedFixture();
    const session = { companyId: f.company.id, agentId: f.assignee.id, runId: f.run.id, issueId: f.derivedTask.id };
    await expect(githubGuestBotConnectionForSession(db, session)).resolves.toBeNull();
    // A message beyond the boundary (a guest-originated chain carries one) still refuses.
    await db.update(runIdentityContexts).set({ messageId: randomUUID() }).where(eq(runIdentityContexts.id, f.originContext.id));
    await expect(githubGuestBotConnectionForSession(db, session)).rejects.toMatchObject({ status: 403, details: { code: "chat_provenance_foreign_message" } });
  });

  // Guest and chat provenance as production stores it: an inbound chat comment is
  // linked through chat_message_links; a GitHub guest's comment has no author
  // (system comment) and reaches the run only as contextSnapshot.wakeCommentId.
  async function inboundComment(f: Awaited<ReturnType<typeof derivedFixture>>, options: {
    issueId: string; provider: "github" | "slack"; guest: boolean; agentId: string; authorUserId?: string;
  }) {
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, name: `${options.provider}-${randomUUID()}`, type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application.id, uid: randomUUID(), name: options.provider, transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: connection.id, provider: options.provider, publicId: randomUUID(), assignedAgentId: options.agentId, status: "active", providerAccountId: `T-${randomUUID()}`, botExternalId: `B-${randomUUID()}` }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.company.id, endpointId: endpoint.id, issueId: options.issueId, externalConversationId: `${options.provider}:${randomUUID()}`, externalLabel: "thread" }).returning();
    const [comment] = await db.insert(issueComments).values({
      companyId: f.company.id, issueId: options.issueId, body: "please do this",
      ...(options.authorUserId ? { authorType: "user", authorUserId: options.authorUserId } : { authorType: "system" }),
    }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({
      companyId: f.company.id, endpointId: endpoint.id, conversationId: conversation.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(),
      eventKind: "message", state: "processed", normalizedEvent: { githubAuthority: { guest: options.guest } },
    }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.company.id, endpointId: endpoint.id, conversationId: conversation.id, deliveryId: delivery.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
    return { endpoint, comment };
  }

  it("refuses a derived task whose origin run was woken by a GitHub guest", async () => {
    const f = await derivedFixture();
    const { comment } = await inboundComment(f, { issueId: f.originTask.id, provider: "github", guest: true, agentId: f.creator.id });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.originTask.id, wakeCommentId: comment.id } }).where(eq(heartbeatRuns.id, f.originRun.id));
    await expect(chatRunSourceMessageId(db, f.run, slackOnly)).rejects.toMatchObject({ status: 403, details: { code: "chat_provenance_foreign_wake" } });
    await expect(githubGuestBotConnectionForSession(db, { companyId: f.company.id, agentId: f.assignee.id, runId: f.run.id, issueId: f.derivedTask.id }))
      .rejects.toMatchObject({ status: 403, details: { code: "chat_provenance_foreign_wake" } });
  });

  it("refuses a guest wake carried in wakeCommentIds two hops beyond the boundary", async () => {
    const f = await derivedFixture();
    const [grandTask] = await db.insert(issues).values({ companyId: f.company.id, title: "Grand origin", assigneeAgentId: f.creator.id }).returning();
    const { comment } = await inboundComment(f, { issueId: grandTask.id, provider: "github", guest: true, agentId: f.creator.id });
    const [board] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: grandTask.id, authorType: "user", authorUserId: "requester", body: "ok" }).returning();
    const [grandRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.creator.id, status: "succeeded", issueId: grandTask.id, responsibleUserId: "requester", contextSnapshot: { issueId: grandTask.id, wakeCommentId: board.id, wakeCommentIds: [comment.id, board.id] } }).returning();
    const [grandContext] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: grandRun.id, revision: 1, responsibleUserId: "requester", cause: "issue_commented", correlationId: "dispatch" }).returning();
    await db.update(runIdentityContexts).set({ parentContextId: grandContext.id }).where(eq(runIdentityContexts.id, f.originContext.id));
    await expect(chatRunSourceMessageId(db, f.run, slackOnly)).rejects.toMatchObject({ status: 403, details: { code: "chat_provenance_foreign_wake" } });
  });

  it.each(["deleted", "other-task"])("does not accept a responsible user's board comment that is %s", async variant => {
    const f = await derivedFixture();
    const [elsewhere] = await db.insert(issues).values({ companyId: f.company.id, title: "Unrelated" }).returning();
    const [board] = await db.insert(issueComments).values({
      companyId: f.company.id, issueId: variant === "other-task" ? elsewhere.id : f.originTask.id, authorType: "user", authorUserId: "requester", body: "Draft",
      ...(variant === "deleted" ? { deletedAt: new Date() } : {}),
    }).returning();
    await db.update(runIdentityContexts).set({ messageId: board.id }).where(eq(runIdentityContexts.id, f.originContext.id));
    await expect(chatRunSourceMessageId(db, f.run, slackOnly)).rejects.toMatchObject({ status: 403, details: { code: "chat_provenance_foreign_message" } });
  });

  it("refuses a derived task whose origin carries an inbound chat message, even from the responsible user", async () => {
    const f = await derivedFixture();
    const { comment } = await inboundComment(f, { issueId: f.originTask.id, provider: "slack", guest: false, agentId: f.creator.id, authorUserId: "requester" });
    await db.update(runIdentityContexts).set({ messageId: comment.id }).where(eq(runIdentityContexts.id, f.originContext.id));
    await expect(chatRunSourceMessageId(db, f.run, slackOnly)).rejects.toMatchObject({ status: 403, details: { code: "chat_provenance_foreign_message" } });
  });

  it.each(["message", "wake"])("allows a derived task whose origin has a direct board comment by the responsible user (%s)", async where => {
    const f = await derivedFixture();
    const [board] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.originTask.id, authorType: "user", authorUserId: "requester", body: "Draft the post" }).returning();
    if (where === "message") await db.update(runIdentityContexts).set({ messageId: board.id }).where(eq(runIdentityContexts.id, f.originContext.id));
    else await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.originTask.id, wakeCommentId: board.id } }).where(eq(heartbeatRuns.id, f.originRun.id));
    expect(await chatRunSourceMessageId(db, f.run, slackOnly)).toBeNull();
    // Another user's board comment is not the requester's instruction.
    await db.update(issueComments).set({ authorUserId: "someone-else" }).where(eq(issueComments.id, board.id));
    await expect(chatRunSourceMessageId(db, f.run, slackOnly)).rejects.toMatchObject({ status: 403 });
  });

  it("keeps a GitHub guest session restricted to its bot connection, on its own task and on a derived task it comments on", async () => {
    const f = await derivedFixture();
    // A guest-woken run on its own task (no parent context).
    const own = await inboundComment(f, { issueId: f.originTask.id, provider: "github", guest: true, agentId: f.creator.id });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.originTask.id, wakeCommentId: own.comment.id } }).where(eq(heartbeatRuns.id, f.originRun.id));
    await db.update(heartbeatRuns).set({ activeIdentityContextId: f.originContext.id }).where(eq(heartbeatRuns.id, f.originRun.id));
    await expect(githubGuestBotConnectionForSession(db, { companyId: f.company.id, agentId: f.creator.id, runId: f.originRun.id, issueId: f.originTask.id }))
      .resolves.toBe(own.endpoint.connectionId);
    // A guest comments on the derived task itself; its chain beyond the boundary is clean.
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.originTask.id } }).where(eq(heartbeatRuns.id, f.originRun.id));
    const derived = await inboundComment(f, { issueId: f.derivedTask.id, provider: "github", guest: true, agentId: f.assignee.id });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.derivedTask.id, wakeCommentId: derived.comment.id } }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(githubGuestBotConnectionForSession(db, { companyId: f.company.id, agentId: f.assignee.id, runId: f.run.id, issueId: f.derivedTask.id }))
      .resolves.toBe(derived.endpoint.connectionId);
  });

  it("refuses a derived task whose origin task holds private Slack research", async () => {
    const f = await derivedFixture();
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application.id, uid: randomUUID(), name: "Slack", transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" }).returning();
    // The origin task's own bot (the creator's), not the CMO's: boundaries are
    // per endpoint, the derived-task check must look across all of them.
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: connection.id, provider: "slack", publicId: randomUUID(), assignedAgentId: f.creator.id, status: "active", providerAccountId: `T-${randomUUID()}`, botExternalId: `B-${randomUUID()}` }).returning();
    await db.insert(chatActions).values({
      companyId: f.company.id, endpointId: endpoint.id, kind: "slack_private_source", status: "processed",
      providerActionId: `slack-private:${f.originTask.id}:C1:U1`, payload: { issueId: f.originTask.id, channelId: "C1", requesterId: "U1", allowedDmChannel: null },
    });
    await expect(chatRunSourceMessageId(db, f.run, slackOnly)).rejects.toMatchObject({
      status: 403, message: "Private Slack research in an originating task cannot be delivered from a derived task",
    });
  });

  it("refuses a derived task when a deeper ancestor task holds private Slack research", async () => {
    // G (grand-origin) read a private channel; G's run created O; O's run created D.
    const f = await derivedFixture();
    const [grandTask] = await db.insert(issues).values({ companyId: f.company.id, title: "Grand origin", assigneeAgentId: f.creator.id }).returning();
    const [grandRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.creator.id, status: "succeeded", nativeIssueId: grandTask.id, responsibleUserId: "requester" }).returning();
    const [grandContext] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: grandRun.id, revision: 1, responsibleUserId: "requester", cause: "issue_assigned", correlationId: "dispatch" }).returning();
    await db.update(runIdentityContexts).set({ parentContextId: grandContext.id }).where(eq(runIdentityContexts.id, f.originContext.id));
    expect(await chatRunSourceMessageId(db, f.run, slackOnly)).toBeNull();
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application.id, uid: randomUUID(), name: "Slack", transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: connection.id, provider: "slack", publicId: randomUUID(), assignedAgentId: f.creator.id, status: "active", providerAccountId: `T-${randomUUID()}`, botExternalId: `B-${randomUUID()}` }).returning();
    await db.insert(chatActions).values({
      companyId: f.company.id, endpointId: endpoint.id, kind: "slack_private_source", status: "processed",
      providerActionId: `slack-private:${grandTask.id}:C2:U1`, payload: { issueId: grandTask.id, channelId: "C2", requesterId: "U1", allowedDmChannel: null },
    });
    await expect(chatRunSourceMessageId(db, f.run, slackOnly)).rejects.toMatchObject({
      status: 403, message: "Private Slack research in an originating task cannot be delivered from a derived task",
    });
  });

  it.each(["message", "cycle", "requester", "pending", "missing", "foreign-run", "unbound"])(
    "keeps refusing a derived task across a %s break beyond the boundary", async fault => {
      const f = await derivedFixture();
      let run = f.run;
      if (fault === "message") await db.update(runIdentityContexts).set({ messageId: randomUUID() }).where(eq(runIdentityContexts.id, f.originContext.id));
      if (fault === "cycle") await db.update(runIdentityContexts).set({ parentContextId: f.derivedContext.id }).where(eq(runIdentityContexts.id, f.originContext.id));
      if (fault === "requester" || fault === "pending" || fault === "missing") {
        const [olderRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.creator.id, status: "succeeded", nativeIssueId: f.originTask.id, responsibleUserId: "requester" }).returning();
        const [older] = await db.insert(runIdentityContexts).values({
          companyId: f.company.id, runId: olderRun.id, revision: 1, cause: "issue_assigned", correlationId: "dispatch",
          responsibleUserId: fault === "requester" ? "another-person" : "requester",
          status: fault === "pending" ? "pending" : "accepted",
        }).returning();
        await db.update(runIdentityContexts).set({ parentContextId: fault === "missing" ? randomUUID() : older.id }).where(eq(runIdentityContexts.id, f.originContext.id));
      }
      if (fault === "foreign-run") {
        const [other] = await db.insert(companies).values({ name: "Other company", issuePrefix: randomUUID().slice(0, 8) }).returning();
        await db.update(heartbeatRuns).set({ companyId: other.id }).where(eq(heartbeatRuns.id, f.originRun.id));
      }
      if (fault === "unbound") {
        [run] = await db.update(heartbeatRuns).set({ nativeIssueId: null, issueId: null, contextSnapshot: {} }).where(eq(heartbeatRuns.id, f.run.id)).returning();
        expect(boundRunIssueId(run)).toBeNull();
      }
      await expect(chatRunSourceMessageId(db, run, slackOnly)).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(["native", "issue-column", "legacy-issue", "legacy-task"])("uses the same %s task binding in SQL and runtime authority", async source => {
    const f = await fixture();
    const values = {
      nativeIssueId: source === "native" ? f.issue.id : null,
      issueId: source === "issue-column" ? f.issue.id : null,
      contextSnapshot: source === "legacy-task" ? { issueId: "", taskId: f.issue.id }
        : { issueId: source === "native" ? randomUUID() : source === "issue-column" ? [] : f.issue.id },
    };
    const [run] = await db.update(heartbeatRuns).set(values).where(eq(heartbeatRuns.id, f.run.id)).returning();
    const [projection] = await db.select({ issueId: boundRunIssueIdSql() }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(projection.issueId).toBe(f.issue.id);
    expect(boundRunIssueId(run)).toBe(projection.issueId);
  });
});
