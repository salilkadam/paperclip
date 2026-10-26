import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { chatActions, chatConversations, chatEndpoints, chatMessageLinks, heartbeatRuns, issueComments, runIdentityContexts, type Db } from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { boundRunIssueId, boundRunIssueIdSql } from "../run-task-binding.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "responsibleUserId" | "activeIdentityContextId" | "nativeIssueId" | "issueId" | "contextSnapshot">;
type Context = typeof runIdentityContexts.$inferSelect;

/** Upper bound on the identity chain a derived task may carry; a longer chain fails closed. */
const MAX_FOREIGN_ORIGIN_CHAIN = 10_000;

/**
 * A task created by one agent run for another (or for another task) carries the
 * creating run's identity context as its parent. Crossing that boundary is safe
 * for Slack only when nothing in the remaining chain is chat provenance and no
 * task in it holds private Slack research: the per-task `slack_private_source`
 * boundary is never copied to derived tasks, so without this check a derived
 * task could publish what its origin task read. Every anomaly fails closed.
 */
async function assertForeignOriginCarriesNoChatSource(db: Db, run: Run, start: Context) {
  const seen = new Set<string>();
  const issueIds = new Set<string>();
  let context: Context | undefined = start;
  while (context) {
    if (seen.has(context.id) || seen.size >= MAX_FOREIGN_ORIGIN_CHAIN) throw forbidden("Chat source provenance could not be verified");
    seen.add(context.id);
    if (context.companyId !== run.companyId || context.status !== "accepted" ||
        context.responsibleUserId !== run.responsibleUserId) throw forbidden("Chat requester provenance changed");
    if (context.messageId) throw forbidden("Chat tools cannot be inherited by another task");
    const [contextRun] = await db.select({ issueId: boundRunIssueIdSql() }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, context.runId),
      eq(heartbeatRuns.companyId, run.companyId),
    )).limit(1);
    if (!contextRun) throw forbidden("Chat requester provenance changed");
    if (typeof contextRun.issueId === "string") issueIds.add(contextRun.issueId);
    if (!context.parentContextId) break;
    [context] = await db.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.id, context.parentContextId),
      eq(runIdentityContexts.companyId, run.companyId),
    )).limit(1);
    if (!context) throw forbidden("Chat requester provenance changed");
  }
  if (issueIds.size === 0) return;
  const [privateSource] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
    eq(chatActions.companyId, run.companyId),
    eq(chatActions.kind, "slack_private_source"),
    inArray(sql<string>`${chatActions.payload}->>'issueId'`, [...issueIds]),
  )).limit(1);
  if (privateSource) throw forbidden("Private Slack research in an originating task cannot be delivered from a derived task");
}

export async function chatRunSourceMessageId(db: Db, run: Run, options: {
  context?: Context | null;
  allowLegacyWakeComment?: boolean;
  provider?: ChatProvider;
  /**
   * Slack only: a parent context from another agent's run or another task ends
   * the walk as "no chat source" when assertForeignOriginCarriesNoChatSource
   * passes. Other callers (GitHub) keep the hard refusal.
   */
  allowForeignOriginWithoutChatSource?: boolean;
} = {}): Promise<string | null> {
  let legacyMessageId = options.allowLegacyWakeComment && typeof run.contextSnapshot?.wakeCommentId === "string"
    ? run.contextSnapshot.wakeCommentId : null;
  if (!run.activeIdentityContextId) {
    return legacyMessageId;
  }
  let origin = options.context ?? (await db.select().from(runIdentityContexts).where(and(
    eq(runIdentityContexts.id, run.activeIdentityContextId),
    eq(runIdentityContexts.runId, run.id),
    eq(runIdentityContexts.companyId, run.companyId),
    eq(runIdentityContexts.status, "accepted"),
  )).limit(1))[0];
  if (!origin || origin.id !== run.activeIdentityContextId || origin.runId !== run.id ||
      origin.companyId !== run.companyId || origin.status !== "accepted" ||
      origin.responsibleUserId !== run.responsibleUserId) {
    throw forbidden("Chat requester provenance changed");
  }
  const seen = new Set<string>();
  let acceptedMessageSeen = false;
  while (true) {
    if (origin.messageId) {
      acceptedMessageSeen = true;
      if (!options.provider) return origin.messageId;
      const [link] = await db.select({ issueId: chatConversations.issueId, provider: chatEndpoints.provider }).from(chatMessageLinks)
        .innerJoin(chatConversations, and(eq(chatConversations.id, chatMessageLinks.conversationId), eq(chatConversations.companyId, run.companyId)))
        .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId), eq(chatEndpoints.companyId, run.companyId)))
        .where(and(eq(chatMessageLinks.companyId, run.companyId), eq(chatMessageLinks.commentId, origin.messageId), eq(chatMessageLinks.direction, "inbound"))).limit(1);
      if (link) {
        if (link.issueId !== boundRunIssueId(run)) throw forbidden("Chat request belongs to another task");
        if (link.provider !== options.provider) return null;
        return origin.messageId;
      }
      const [message] = await db.select({ authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
        eq(issueComments.id, origin.messageId), eq(issueComments.companyId, run.companyId),
        eq(issueComments.issueId, boundRunIssueId(run) ?? "00000000-0000-0000-0000-000000000000"),
        or(eq(issueComments.authorType, "user"), and(isNull(issueComments.authorType), isNull(issueComments.authorAgentId))),
        isNull(issueComments.deletedAt),
      )).limit(1);
      if (!run.responsibleUserId || message?.authorUserId !== run.responsibleUserId) throw forbidden("Chat requester provenance changed");
      // This verified board message may continue its same-user channel history,
      // but its own wake metadata is not the earlier channel request.
      legacyMessageId = null;
    }
    if (!origin.parentContextId) return legacyMessageId;
    if (seen.has(origin.id)) throw forbidden("Chat source provenance could not be verified");
    seen.add(origin.id);
    const [parent] = await db.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.id, origin.parentContextId),
      eq(runIdentityContexts.companyId, run.companyId),
      eq(runIdentityContexts.status, "accepted"),
    )).limit(1);
    if (!parent) throw forbidden("Chat requester provenance changed");
    if (parent.responsibleUserId !== run.responsibleUserId) {
      if (acceptedMessageSeen) return null;
      throw forbidden("Chat requester provenance changed");
    }
    const [sourceRun] = await db.select({
      agentId: heartbeatRuns.agentId,
      issueId: boundRunIssueIdSql(),
      responsibleUserId: heartbeatRuns.responsibleUserId,
      wakeCommentId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'wakeCommentId'`,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, parent.runId),
      eq(heartbeatRuns.companyId, run.companyId),
    )).limit(1);
    if (!sourceRun || !boundRunIssueId(run) || sourceRun.agentId !== run.agentId || sourceRun.issueId !== boundRunIssueId(run)) {
      // Only an existing parent run of another agent or task may be crossed,
      // and only for callers that opted in; a missing parent run or an unbound
      // current run is an integrity failure for everyone.
      if (options.allowForeignOriginWithoutChatSource && sourceRun && boundRunIssueId(run)) {
        await assertForeignOriginCarriesNoChatSource(db, run, parent);
        return legacyMessageId;
      }
      throw forbidden("Chat tools cannot be inherited by another task");
    }
    if (options.allowLegacyWakeComment && sourceRun.responsibleUserId === run.responsibleUserId &&
        typeof sourceRun.wakeCommentId === "string") legacyMessageId ??= sourceRun.wakeCommentId;
    origin = parent;
  }
}
