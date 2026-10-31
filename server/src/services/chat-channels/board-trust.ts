import type { Message, Thread } from "chat";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { chatConversations, chatEndpoints, companyMemberships } from "@paperclipai/db";
import type { DbOrTransaction, EndpointRow } from "./runtime-types.js";
import { slackPlainHumanTopLevelPost } from "./slack/messages.js";

/**
 * Board-channel trust (doc/plans/2026-10-31-board-channel-trust.md, Change 1).
 *
 * A Slack message is board-trusted only when every rule holds:
 *   1. its channel resource is `board_trusted` on an `active` endpoint;
 *   2. the sender resolves to a linked Paperclip user that is not denied;
 *   3. that user is an active company owner or admin (`ensurePrincipal`
 *      only excludes viewers, so this is a separate role check);
 *   4. the raw event is a plain human post (no bot_id/app_id/subtype, not the bot);
 *   5. it is a top-level channel message (thread replies keep today's rule);
 *   6. the endpoint does not require an @mention.
 */
export const BOARD_TRUST_ROLES = ["owner", "admin"] as const;

export async function userHoldsBoardTrustRole(
  database: DbOrTransaction,
  companyId: string,
  userId: string | null,
  options: { lock?: boolean } = {},
): Promise<boolean> {
  if (!userId) return false;
  const query = database
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
        inArray(companyMemberships.membershipRole, [...BOARD_TRUST_ROLES]),
      ),
    )
    .limit(1);
  const rows = options.lock ? await query.for("update") : await query;
  return rows.length > 0;
}

export type BoardTrustInput = {
  endpoint: Pick<EndpointRow, "provider" | "status" | "requireAtMention" | "botExternalId">;
  resource: { boardTrusted: boolean } | null | undefined;
  thread: Pick<Thread, "id" | "isDM">;
  message: Pick<Message, "id" | "raw"> & { author?: Pick<Message["author"], "userId" | "isBot" | "isMe" | "isSystem"> };
  principal: { userId: string | null; linkedDenied: boolean };
  /** Result of userHoldsBoardTrustRole for principal.userId. */
  boardRole: boolean;
};

/** Rules 1, 2, 4, 5 and 6 without the role query; callers pass rule 3 as boardRole. */
export function boardTrustedChannel(input: Pick<BoardTrustInput, "endpoint" | "resource" | "thread">): boolean {
  return (
    input.endpoint.provider === "slack" &&
    input.endpoint.status === "active" &&
    !input.thread.isDM &&
    input.resource?.boardTrusted === true
  );
}

export function isBoardTrustedMessage(input: BoardTrustInput): boolean {
  return (
    boardTrustedChannel(input) &&
    !input.endpoint.requireAtMention &&
    input.principal.userId !== null &&
    !input.principal.linkedDenied &&
    input.boardRole &&
    slackPlainHumanTopLevelPost(input.thread, input.message, input.endpoint.botExternalId)
  );
}

/**
 * The external execution restriction for a task's chat conversation. A
 * conversation is restricted unless its endpoint policy is `agent` AND either
 * the endpoint is AgentMail (whose policy the database forces to `agent`) or
 * the conversation was admitted from a board-trusted message. Linked members,
 * guests and other channels on an `agent` endpoint therefore stay restricted.
 */
export function chatConversationExecutionRestricted(): SQL {
  return or(
    eq(chatEndpoints.externalExecutionPolicy, "restricted"),
    and(sql`${chatEndpoints.provider} <> 'agentmail'`, eq(chatConversations.boardTrusted, false)),
  )!;
}

/** Static notice texts; never echo message content. */
export const BOARD_NOTICE_NOT_LINKED =
  "This message was not sent to the agent: your Slack account is not linked to Paperclip. Ask a Paperclip admin for a link.";
export const BOARD_NOTICE_NOT_PICKED_UP =
  "This message was not picked up. Only board members' top-level messages start work here; @mention the agent to ask it for something.";
