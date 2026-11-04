import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { chatEndpoints } from "@paperclipai/db";

import type { DbOrTransaction, EndpointRow } from "../runtime-types.js";
import { slackRawTextMentionsUser } from "./messages.js";

/** Slack user ids in the raw text's mention tokens (`<@U123>` or `<@U123|label>`). */
export function slackRawMentionedUserIds(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const text = (raw as { text?: unknown }).text;
  if (typeof text !== "string") return [];
  return [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);
}

/**
 * Several of a company's agents can have their own Slack bot in one channel, and one of them may answer
 * unmentioned messages (requireAtMention off, e.g. the CEO as the board voice). A post that @mentions
 * another live (verifying or active) one of those bots, and not this one, is addressed to that agent: this bot must not pick it up. Only
 * bots of the same company in the same Slack workspace count; mentioning a person does not.
 */
export async function slackMessageAddressesAnotherBot(
  db: DbOrTransaction,
  endpoint: Pick<EndpointRow, "id" | "companyId" | "providerAccountId" | "botExternalId">,
  raw: unknown,
): Promise<boolean> {
  const mentioned = slackRawMentionedUserIds(raw);
  if (mentioned.length === 0 || slackRawTextMentionsUser(raw, endpoint.botExternalId)) return false;
  // Without this bot's own id a post that mentions it too cannot be told apart, so keep the old behaviour.
  if (!endpoint.providerAccountId || !endpoint.botExternalId) return false;
  const others = await db
    .select({ botExternalId: chatEndpoints.botExternalId })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, endpoint.companyId),
        eq(chatEndpoints.provider, "slack"),
        eq(chatEndpoints.providerAccountId, endpoint.providerAccountId),
        ne(chatEndpoints.id, endpoint.id),
        // Only a live bot answers; a post for a paused, draft or archived bot stays with this one.
        inArray(chatEndpoints.status, ["verifying", "active"]),
        isNotNull(chatEndpoints.botExternalId),
      ),
    );
  return others.some((other) => other.botExternalId !== null && mentioned.includes(other.botExternalId));
}
