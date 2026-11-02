/**
 * Stage 2 of board-channel cards: a click on a board card's Approve/Reject
 * button decides the item through the same service or gateway path the
 * Paperclip UI uses.
 *
 * Authority is strictly narrower than the UI (plan table, review B3): the
 * Slack user must be linked on the board bot to a Paperclip user who is an
 * active owner/admin of the company and can read the task; all of it is
 * re-checked under lock in the resolving transaction. Tokens are single-use,
 * bound to the exact card message and expire with the card. Anyone else is
 * refused and nothing changes.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatActions,
  chatEndpointResources,
  chatIdentityLinks,
  companyMemberships,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { issueReadSqlCondition, type AuthorizationActor } from "../authorization.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { notifyBoardCardWork } from "../chat-work-notifications.js";
import { userHoldsBoardTrustRole } from "./board-trust.js";
import { BOARD_CARD_DECISION_KIND, BOARD_CARD_KIND, type BoardCardDecisionToken, type BoardCardPost } from "./board-cards.js";
import type { DbOrTransaction, EndpointRow } from "./runtime-types.js";

export type ToolActionDecisionInput = {
  companyId: string;
  issueId: string;
  interactionId: string;
  actionRequestId: string;
  actor: { agentId: string | null; userId: string | null };
};

export type BoardCardDecisionDeps = {
  approveToolAction?: (input: ToolActionDecisionInput) => Promise<unknown>;
  declineToolAction?: (input: ToolActionDecisionInput) => Promise<unknown>;
};

export type BoardCardClick = {
  endpoint: EndpointRow;
  principalId: string;
  userId: string;
  actionId: string;
  messageId: string | null | undefined;
  threadId: string | null | undefined;
};

export type BoardCardClickResult =
  | { outcome: "decided"; status: string }
  | { outcome: "already_decided" }
  | { outcome: "refused"; reason: string };

class Refused extends Error {}

/** The clicking user must hold board authority now; checked under lock inside the resolving transaction. */
async function assertBoardAuthority(tx: DbOrTransaction, click: BoardCardClick, issueId: string) {
  const [link] = await tx.select({ id: chatIdentityLinks.id }).from(chatIdentityLinks).where(and(
    eq(chatIdentityLinks.companyId, click.endpoint.companyId),
    eq(chatIdentityLinks.endpointId, click.endpoint.id),
    eq(chatIdentityLinks.principalId, click.principalId),
    eq(chatIdentityLinks.paperclipUserId, click.userId),
    eq(chatIdentityLinks.status, "linked"),
  )).for("update");
  if (!link) throw new Refused("your Slack account is not linked to Paperclip on this bot");
  if (!(await userHoldsBoardTrustRole(tx, click.endpoint.companyId, click.userId, { lock: true }))) {
    throw new Refused("only Paperclip board members (owner or admin) can decide here");
  }
  const [resource] = await tx.select({ id: chatEndpointResources.id }).from(chatEndpointResources).where(and(
    eq(chatEndpointResources.companyId, click.endpoint.companyId),
    eq(chatEndpointResources.endpointId, click.endpoint.id),
    eq(chatEndpointResources.boardCards, true),
    eq(chatEndpointResources.enabled, true),
  )).for("update");
  if (!resource) throw new Refused("this channel is no longer the board channel");
  const memberships = await tx.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships).where(and(
      eq(companyMemberships.companyId, click.endpoint.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, click.userId),
    ));
  const actor: AuthorizationActor = {
    type: "board", userId: click.userId, companyIds: [click.endpoint.companyId],
    memberships, isInstanceAdmin: false, ignoreInstanceAdmin: true,
  };
  const readable = await issueReadSqlCondition(tx as Db, actor);
  const [visible] = await tx.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, click.endpoint.companyId), eq(issues.id, issueId), readable));
  if (!visible) throw new Refused("you cannot see this task in Paperclip");
}

export function createBoardCardDecisions(db: Db, deps: BoardCardDecisionDeps) {
  async function handleClick(click: BoardCardClick): Promise<BoardCardClickResult> {
    const [token] = await db.select().from(chatActions).where(and(
      eq(chatActions.companyId, click.endpoint.companyId),
      eq(chatActions.endpointId, click.endpoint.id),
      eq(chatActions.kind, BOARD_CARD_DECISION_KIND),
      eq(chatActions.providerActionId, click.actionId),
    ));
    if (!token) return { outcome: "refused", reason: "this button is not a current Paperclip decision" };
    const payload = token.payload as unknown as BoardCardDecisionToken;
    if (token.status === "processed") return { outcome: "already_decided" };
    if (token.status !== "issued" || payload.version !== 1 || !(Date.parse(payload.expiresAt) > Date.now())) {
      return { outcome: "refused", reason: "this decision has expired; open it in Paperclip" };
    }
    // The button must belong to the exact card message it was clicked on.
    const [post] = await db.select().from(chatActions).where(and(
      eq(chatActions.companyId, click.endpoint.companyId),
      eq(chatActions.endpointId, click.endpoint.id),
      eq(chatActions.kind, BOARD_CARD_KIND),
      eq(chatActions.providerActionId, payload.postProviderActionId),
    ));
    const postPayload = post?.payload as unknown as BoardCardPost | undefined;
    if (!post || post.status !== "published" || !click.messageId || post.result?.providerMessageId !== click.messageId
      || !postPayload || !String(click.threadId ?? "").includes(postPayload.channelId)) {
      return { outcome: "refused", reason: "this button does not match a current board card" };
    }
    const [interaction] = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, click.endpoint.companyId),
      eq(issueThreadInteractions.id, payload.subjectId),
    ));
    const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, click.endpoint.companyId), eq(issues.id, payload.issueId)));
    if (!interaction || !issue || interaction.issueId !== issue.id) return { outcome: "refused", reason: "the task for this decision no longer exists" };
    if (interaction.status !== "pending") {
      await expireToken(token.id);
      return { outcome: "already_decided" };
    }

    let claimedByThisCall = false;
    let gatewayCalled = false;
    try {
      if (payload.toolAction) {
        // The gateway path the UI uses. Claim the token first; only the call
        // that made the claim may ever hand it back.
        await db.transaction(async (tx) => {
          await assertBoardAuthority(tx, click, issue.id);
          const [claimed] = await tx.update(chatActions).set({ status: "processing", principalId: click.principalId, updatedAt: new Date() })
            .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "issued"))).returning({ id: chatActions.id });
          if (!claimed) throw new Refused("this button was already used");
        });
        claimedByThisCall = true;
        const decide = payload.decision === "accept" ? deps.approveToolAction : deps.declineToolAction;
        if (!decide || !payload.actionRequestId) throw new Refused("tool decisions are unavailable here; open it in Paperclip");
        gatewayCalled = true;
        await decide({
          companyId: issue.companyId, issueId: issue.id, interactionId: interaction.id,
          actionRequestId: payload.actionRequestId, actor: { agentId: null, userId: click.userId },
        });
        await db.update(chatActions).set({ status: "processed", result: { decidedByUserId: click.userId }, updatedAt: new Date() })
          .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "processing")));
      } else {
        const svc = issueThreadInteractionService(db);
        const hooks = {
          beforeResolveInTransaction: async (tx: DbOrTransaction) => { await assertBoardAuthority(tx, click, issue.id); },
          afterResolveInTransaction: async (tx: DbOrTransaction, resolved: { id: string; status: string; kind: string }) => {
            const [owned] = await tx.update(chatActions).set({ status: "processed", principalId: click.principalId, result: { decidedByUserId: click.userId, interactionStatus: resolved.status }, updatedAt: new Date() })
              .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "issued"))).returning({ id: chatActions.id });
            if (!owned) throw new Refused("this button was already used");
            // The same activity the UI writes, so the timeline, wake throttle and participation see it.
            await logActivity(tx as unknown as Db, {
              companyId: issue.companyId, actorType: "user", actorId: click.userId,
              action: resolved.status === "accepted" ? "issue.thread_interaction_accepted" : "issue.thread_interaction_rejected",
              entityType: "issue", entityId: issue.id,
              details: { interactionId: resolved.id, interactionKind: interaction.kind, interactionStatus: resolved.status, resolutionActorKind: "user", source: "slack_board_card" },
            });
          },
        };
        if (payload.decision === "accept") {
          await svc.acceptInteraction(issue, interaction.id, {}, { userId: click.userId }, hooks as never);
        } else {
          await svc.rejectInteraction(issue, interaction.id, {}, { userId: click.userId }, hooks as never);
        }
        // Wake after the service returns: accepting can hand the task back to the
        // creating agent, which happens after the in-transaction hook (as in the UI,
        // which wakes the continuation issue's assignee after the transaction).
        const [resolvedRow] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
        const [current] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issue.id));
        const resolvedStatus = resolvedRow?.status ?? "unknown";
        const policy = interaction.continuationPolicy;
        const shouldWake = policy !== "none" && !(policy === "wake_assignee_on_accept" && resolvedStatus !== "accepted");
        if (current?.assigneeAgentId && shouldWake && ["accepted", "rejected"].includes(resolvedStatus)) {
          await db.transaction(async (tx) => {
            await tx.insert(chatActions).values({
              companyId: issue.companyId, endpointId: click.endpoint.id, conversationId: null, principalId: click.principalId,
              kind: "interaction_wakeup", providerActionId: `interaction_wakeup:${interaction.id}`,
              payload: {
                version: 1, interactionId: interaction.id, interactionKind: interaction.kind, interactionStatus: resolvedStatus,
                issueId: issue.id, agentId: current.assigneeAgentId, sourceCommentId: interaction.sourceCommentId ?? null,
                sourceRunId: interaction.sourceRunId ?? null, requestedByUserId: click.userId,
                requestedByActorType: "user", requestedByActorId: click.userId,
              },
              status: "issued",
            }).onConflictDoNothing();
          });
        }
      }
    } catch (error) {
      if (claimedByThisCall && !gatewayCalled) {
        // This call claimed the token and never reached the gateway: hand it back.
        await db.update(chatActions).set({ status: "issued", updatedAt: new Date() })
          .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "processing")));
      }
      const [current] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
      if (claimedByThisCall && gatewayCalled) {
        // The gateway was asked and failed. Never leave the button stuck: record the
        // failure and make it visible; the board can decide in Paperclip.
        const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        await db.update(chatActions).set({ status: current && current.status !== "pending" ? "processed" : "failed", result: { error: message, decidedByUserId: click.userId }, updatedAt: new Date() })
          .where(and(eq(chatActions.id, token.id), eq(chatActions.status, "processing")));
        if (!current || current.status === "pending") {
          await logActivity(db, {
            companyId: issue.companyId, actorType: "user", actorId: click.userId, action: "chat.board_card_decision_failed",
            entityType: "issue", entityId: issue.id,
            details: { interactionId: interaction.id, decision: payload.decision, error: message },
          });
          return { outcome: "refused", reason: "the decision could not be carried out; open it in Paperclip" };
        }
      }
      if (current && current.status !== "pending") {
        await expireToken(token.id);
        if (!(error instanceof Refused)) return { outcome: "already_decided" };
      }
      if (error instanceof Refused) {
        await logRefusal(click, payload, error.message);
        return { outcome: "refused", reason: error.message };
      }
      if (error instanceof HttpError && [403, 404, 409, 422].includes(error.status)) {
        // The service refused this person (e.g. a prompt addressed to someone else).
        await logRefusal(click, payload, error.message);
        return { outcome: "refused", reason: error.message };
      }
      throw error;
    }

    await logActivity(db, {
      companyId: issue.companyId, actorType: "user", actorId: click.userId, action: "chat.board_card_decided",
      entityType: "issue", entityId: issue.id,
      details: { interactionId: interaction.id, decision: payload.decision, toolAction: payload.toolAction, endpointId: click.endpoint.id, via: "slack_board_card" },
    });
    await db.transaction((tx) => notifyBoardCardWork(tx));
    const [after] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id));
    return { outcome: "decided", status: after?.status ?? "unknown" };
  }

  async function expireToken(id: string) {
    await db.update(chatActions).set({ status: "expired", updatedAt: new Date() }).where(and(eq(chatActions.id, id), eq(chatActions.status, "issued")));
  }

  async function logRefusal(click: BoardCardClick, payload: BoardCardDecisionToken, reason: string) {
    await logActivity(db, {
      companyId: click.endpoint.companyId, actorType: "system", actorId: "board-cards", action: "chat.board_card_decision_refused",
      entityType: "issue", entityId: payload.issueId,
      details: { interactionId: payload.subjectId, decision: payload.decision, principalId: click.principalId, userId: click.userId, reason },
    });
  }

  return { handleClick };
}
