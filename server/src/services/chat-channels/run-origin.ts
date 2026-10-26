import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { chatActions, chatConversations, chatEndpoints, chatMessageLinks, heartbeatRuns, issueComments, runIdentityContexts, type Db } from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { boundRunIssueId, boundRunIssueIdSql } from "../run-task-binding.js";
import { logger } from "../../middleware/logger.js";

/**
 * Refuse with enough detail to tell which provenance check failed. These refusals
 * reach agents as "cannot be inherited" with no other context, and the same text
 * comes from two different checks; without the code and ids a production refusal
 * cannot be diagnosed (REL-3060). Ids and booleans only, never message content.
 */
function inheritanceRefused(details: Record<string, unknown>) {
  // Expected policy outcome for callers that did not opt in (GitHub): info, not warn.
  const level = details.foreignOriginAllowed === false ? "info" : "warn";
  logger[level]({ provenanceRefusal: details }, "chat provenance refused inheritance");
  return forbidden("Chat tools cannot be inherited by another task", details);
}

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "responsibleUserId" | "activeIdentityContextId" | "nativeIssueId" | "issueId" | "contextSnapshot">;
type Context = typeof runIdentityContexts.$inferSelect;

/** Upper bound on the identity chain a derived task may carry; a longer chain fails closed. */
const MAX_FOREIGN_ORIGIN_CHAIN = 256;

/**
 * True only for a comment the run's responsible user wrote directly on the board:
 * authored by that user and not an inbound chat message (Slack, GitHub, email...).
 * Everything else counts as outside provenance: guest comments (stored as
 * system comments with no author), other users, inbound chat messages, and
 * comments that cannot be found.
 */
async function isDirectBoardComment(db: Db, run: Run, commentId: string, issueId: string | null) {
  // The comment must still exist on the task the ancestor run was bound to.
  if (!issueId) return false;
  const [comment] = await db.select({ authorType: issueComments.authorType, authorUserId: issueComments.authorUserId })
    .from(issueComments).where(and(
      eq(issueComments.id, commentId), eq(issueComments.companyId, run.companyId),
      eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt),
    )).limit(1);
  if (!comment || comment.authorType !== "user" || !run.responsibleUserId || comment.authorUserId !== run.responsibleUserId) return false;
  const [inbound] = await db.select({ id: chatMessageLinks.id }).from(chatMessageLinks).where(and(
    eq(chatMessageLinks.companyId, run.companyId), eq(chatMessageLinks.commentId, commentId), eq(chatMessageLinks.direction, "inbound"),
  )).limit(1);
  return !inbound;
}

/**
 * A task created by one agent run for another (or for another task) carries the
 * creating run's identity context as its parent. Crossing that boundary is safe
 * only when nothing in the remaining chain came from outside the board and no
 * task in it holds private Slack research.
 *
 * Outside provenance is checked on BOTH places it is stored: a context's
 * messageId (linked users) and an ancestor run's wake comments (guests: their
 * inbound comments have no author, so they never become a context messageId and
 * survive only as wakeCommentId). Only direct board comments by the responsible
 * user pass. This covers wake-linked chains: a run started without wake metadata
 * (a manual wake) that read outside content from the thread is not detected here
 * (accepted risk, see PR #33's disposition). The per-task `slack_private_source` boundary is never copied to
 * derived tasks, so it is checked across the whole ancestry. Every anomaly fails
 * closed.
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
    const [contextRun] = await db.select({
      issueId: boundRunIssueIdSql(),
      wakeCommentId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'wakeCommentId'`,
      wakeCommentIds: sql<unknown>`${heartbeatRuns.contextSnapshot}->'wakeCommentIds'`,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, context.runId),
      eq(heartbeatRuns.companyId, run.companyId),
    )).limit(1);
    // Contexts outlive runs by design; a deleted originating run (for example
    // after its agent was removed) cannot be verified, so refuse, but say why.
    if (!contextRun) throw forbidden("Chat provenance could not be verified: an originating run is no longer available");
    const contextIssueId = typeof contextRun.issueId === "string" ? contextRun.issueId : null;
    if (contextIssueId) issueIds.add(contextIssueId);
    if (context.messageId && !(await isDirectBoardComment(db, run, context.messageId, contextIssueId))) throw inheritanceRefused({
      code: "chat_provenance_foreign_message", runId: run.id, contextId: context.id, contextRunId: context.runId,
    });
    const wakeComments = [contextRun.wakeCommentId, ...(Array.isArray(contextRun.wakeCommentIds) ? contextRun.wakeCommentIds : [])]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    for (const commentId of wakeComments) {
      if (!(await isDirectBoardComment(db, run, commentId, contextIssueId))) throw inheritanceRefused({
        code: "chat_provenance_foreign_wake", runId: run.id, contextId: context.id, contextRunId: context.runId,
      });
    }
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
   * A parent context from another agent's run or another task ends the walk as
   * "no chat source" when assertForeignOriginCarriesNoChatSource passes. Used by
   * Slack task authority and by the GitHub guest check that every gateway tool
   * listing runs; other GitHub callers keep the hard refusal.
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
      throw inheritanceRefused({
        code: "chat_provenance_foreign_origin",
        runId: run.id,
        agentId: run.agentId,
        boundIssueId: boundRunIssueId(run),
        originContextId: origin.id,
        parentContextId: parent.id,
        parentRunId: parent.runId,
        parentRunFound: Boolean(sourceRun),
        parentRunAgentId: sourceRun?.agentId ?? null,
        parentRunIssueId: sourceRun?.issueId ?? null,
        foreignOriginAllowed: Boolean(options.allowForeignOriginWithoutChatSource),
      });
    }
    if (options.allowLegacyWakeComment && sourceRun.responsibleUserId === run.responsibleUserId &&
        typeof sourceRun.wakeCommentId === "string") legacyMessageId ??= sourceRun.wakeCommentId;
    origin = parent;
  }
}
