/**
 * Board-channel cards: every pending board decision reaches the company's
 * board channel in Slack, whatever started the task.
 *
 * Design (doc/plans/2026-11-02-board-channel-cards.md):
 * - The destination is the one `chat_endpoint_resources` row per company with
 *   `board_cards` (a private, non-shared Slack channel); its endpoint's bot posts.
 * - Cards are an outbox in `chat_actions` (kind `board_card`), never a task
 *   conversation: the task is not bound to the channel, so its progress and
 *   thread replies do not flow there.
 * - A sweep is the primary mechanism for both posting and settling. Many code
 *   paths create or resolve interactions and approvals; reading their state
 *   on a short interval cannot miss one. The maximum stale window is one sweep.
 * - A post whose delivery is uncertain (`processing` too long) becomes
 *   `delivery_unknown` and is never re-sent: a duplicate live card is worse
 *   than a missing one. A settle against it posts a plain follow-up instead.
 * - Content is built here, per subject type, never from raw payloads: tool
 *   actions show the server-built preview only, never the argument JSON;
 *   approvals show title and summary only; private issues get a content-free
 *   card. Text passes through the external-chat projection (credential and
 *   hidden-block redaction) and the provider card limits.
 */

import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  chatActions,
  chatEndpointResources,
  chatEndpoints,
  companies,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { SafeChatPublicationPayload, SafeExternalChatCardAction } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { projectSafeChatPublicationText, sanitizeExternalChatUrl } from "../chat-publication-projection.js";
import { classifyChatPublicationError } from "../chat-publication-errors.js";
import { Actions, Button, Card, CardText, LinkButton } from "chat";
import { fitCardToProviderLimits } from "./publications/card-limits.js";
import type { EndpointRow } from "./runtime-types.js";
import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

export const BOARD_CARD_KIND = "board_card";
/** How often pending decisions are re-read; the longest a card can lag or stay stale. */
export const BOARD_CARD_SWEEP_MS = 20_000;
/** A post still `processing` after this is treated as delivered-or-not-known, never re-sent. */
export const BOARD_CARD_PROCESSING_STALE_MS = 60_000;
/** Re-check that the board channel is still private and not shared at most this often. */
const CHANNEL_PROBE_TTL_MS = 10 * 60_000;
const MAX_BODY = 1500;

type SubjectKind = "interaction" | "approval";
type CardContent = { title: string; body: string; url: string | null };
export type BoardCardPost = {
  version: 1;
  op: "post";
  subjectKind: SubjectKind;
  subjectId: string;
  rev: number;
  issueId: string | null;
  resourceId: string;
  channelId: string;
  content: CardContent;
  /** Stage 2 fills these with single-use decision tokens. */
  actions?: SafeExternalChatCardAction[];
};
export type BoardCardSettle = {
  version: 1;
  op: "settle";
  postActionId: string;
  subjectKind: SubjectKind;
  subjectId: string;
  outcome: string;
  content: CardContent;
};

export type BoardCardOptions = {
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  inspectSlackBoardChannel: (endpoint: EndpointRow, channelId: string) => Promise<Record<string, unknown> | null>;
  publicBaseUrl: () => string | null | undefined;
  now?: () => number;
};

function clip(text: string, max = MAX_BODY): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeText(text: string): string {
  return projectSafeChatPublicationText(text);
}

function boardUrl(base: string | null | undefined, path: string): string | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return sanitizeExternalChatUrl(url.toString());
  } catch {
    return null;
  }
}

const INTERACTION_OUTCOME: Record<string, string> = {
  accepted: "Approved",
  rejected: "Rejected",
  answered: "Answered",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Failed",
};
const APPROVAL_OUTCOME: Record<string, string> = {
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  revision_requested: "Revision requested",
};

type InteractionRow = {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  title: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  createdByAgentId: string | null;
  addresseeAgentId: string | null;
  issueIdentifier: string | null;
  issueTitle: string;
  issueVisibility: string;
  conversationAgentId: string | null;
  agentName: string | null;
};

type ApprovalRow = {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
  agentName: string | null;
};

/** What the board reads for one pending interaction. Never the raw arguments. */
export function interactionCardContent(row: InteractionRow, input: {
  baseUrl: string | null | undefined;
  issuePrefix: string;
  formalApproval: boolean;
}): CardContent {
  const url = boardUrl(input.baseUrl, `/issues/${encodeURIComponent(row.issueId)}`);
  const who = row.agentName ? `${row.agentName}` : "An agent";
  const task = row.issueIdentifier ? `${row.issueIdentifier}` : "a task";
  if (row.issueVisibility === "private") {
    return { title: "A task needs board attention", body: `${who} is waiting for a board decision on ${task} (private task). Open it in Paperclip.`, url };
  }
  const payload = row.payload ?? {};
  const toolAction = payload.toolAction as Record<string, unknown> | undefined;
  const lines: string[] = [`${who} asks on ${task}: ${row.issueTitle}`];
  let title: string;
  if (row.kind === "request_confirmation") {
    title = String(payload.prompt ?? row.title ?? "Confirmation needed");
    if (toolAction) {
      // Server-built plain-language preview. The argument JSON (detailsMarkdown,
      // argumentsSummaryJson) is board-only and never leaves Paperclip.
      const preview = typeof toolAction.previewMarkdown === "string" ? toolAction.previewMarkdown : "";
      if (preview.trim()) lines.push(preview.trim());
      const risk = typeof toolAction.risk === "string" ? toolAction.risk : null;
      if (risk) lines.push(`Risk: ${risk}.`);
      if (input.formalApproval) lines.push("This needs two decisions in Paperclip: the formal approval and this confirmation.");
    } else {
      if (row.summary?.trim()) lines.push(row.summary.trim());
      const details = typeof payload.detailsMarkdown === "string" ? payload.detailsMarkdown.trim() : "";
      if (details) lines.push(details);
    }
  } else {
    title = String(payload.title ?? row.title ?? "Input needed");
    if (row.summary?.trim()) lines.push(row.summary.trim());
    const questions = Array.isArray(payload.questions) ? payload.questions as Array<Record<string, unknown>> : [];
    for (const q of questions.slice(0, 5)) {
      lines.push(String(q.prompt ?? ""));
      const options = Array.isArray(q.options) ? q.options as Array<Record<string, unknown>> : [];
      for (const o of options.slice(0, 8)) lines.push(`• ${String(o.label ?? "")}`);
    }
  }
  return { title: clip(safeText(title), 140), body: clip(safeText(lines.filter(Boolean).join("\n\n"))), url };
}

/** What the board reads for one pending approval: title and summary only, never the payload. */
export function approvalCardContent(row: ApprovalRow, input: { baseUrl: string | null | undefined; issuePrefix: string }): CardContent {
  const url = boardUrl(input.baseUrl, `/${input.issuePrefix}/approvals/${row.id}`);
  const title = typeof row.payload.title === "string" && row.payload.title.trim()
    ? row.payload.title
    : `Approval needed: ${row.type.replace(/_/g, " ")}`;
  const lines = [
    `${row.agentName ?? "Someone"} requests a board approval (${row.type.replace(/_/g, " ")}).`,
    typeof row.payload.summary === "string" ? row.payload.summary : "",
    "Decide in Paperclip.",
  ];
  return { title: clip(safeText(title), 140), body: clip(safeText(lines.filter(Boolean).join("\n\n"))), url };
}

function settledContent(content: CardContent, outcome: string): CardContent {
  return { title: clip(`${outcome}: ${content.title}`, 140), body: `${outcome} in Paperclip. Nothing more is needed here.`, url: content.url };
}

/** The same Block Kit shape and provider limits as task publications. */
function safeCardForPublication(payload: SafeChatPublicationPayload, provider: "slack") {
  if (!payload.card) return null;
  const fitted = fitCardToProviderLimits(payload.card, provider, {});
  const children = [];
  if (fitted.body) children.push(CardText(fitted.body));
  const actions = (fitted.actions ?? []).map((action) =>
    action.type === "callback"
      ? Button({ id: action.actionId, label: action.label, style: action.style ?? "default", value: payload.interactionId })
      : LinkButton({ label: action.label, url: action.url }),
  );
  if (actions.length) children.push(Actions(actions));
  return Card({ title: fitted.title, children });
}

function cardPayload(id: string, content: CardContent, actions: SafeExternalChatCardAction[] = []): SafeChatPublicationPayload {
  return {
    text: `${content.title}\n\n${content.body}${content.url ? `\n\n${content.url}` : ""}`,
    interactionId: id,
    card: {
      schema: "paperclip.chat.card.v1",
      kind: "confirmation",
      title: content.title,
      body: content.body,
      actions: [
        ...actions,
        ...(content.url ? [{ type: "link" as const, label: "Open in Paperclip", url: content.url }] : []),
      ],
    },
  } as SafeChatPublicationPayload;
}

export function createBoardCards(db: Db, options: BoardCardOptions) {
  const now = options.now ?? Date.now;
  const probeCache = new Map<string, { at: number; ok: boolean; reason?: string }>();
  let lastSweepAt = 0;

  /** The single board destination of each company that has one, on a live Slack bot. */
  async function destinations() {
    return db
      .select({ resource: chatEndpointResources, endpoint: chatEndpoints, issuePrefix: companies.issuePrefix })
      .from(chatEndpointResources)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatEndpointResources.endpointId), eq(chatEndpoints.companyId, chatEndpointResources.companyId)))
      .innerJoin(companies, eq(companies.id, chatEndpointResources.companyId))
      .where(and(
        eq(chatEndpointResources.boardCards, true),
        eq(chatEndpointResources.availability, "available"),
        eq(chatEndpoints.provider, "slack"),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ));
  }

  async function latestPosts(companyId: string, subjectKind: SubjectKind) {
    const rows = await db.select().from(chatActions).where(and(
      eq(chatActions.companyId, companyId),
      eq(chatActions.kind, BOARD_CARD_KIND),
      sql`${chatActions.payload}->>'op' = 'post'`,
      sql`${chatActions.payload}->>'subjectKind' = ${subjectKind}`,
    )).orderBy(desc(chatActions.createdAt));
    const bySubject = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const id = String(row.payload.subjectId);
      if (!bySubject.has(id)) bySubject.set(id, row);
    }
    return bySubject;
  }

  async function settled(postId: string) {
    const [row] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
      eq(chatActions.kind, BOARD_CARD_KIND),
      eq(chatActions.providerActionId, `board-card-settle:${postId}`),
    )).limit(1);
    return Boolean(row);
  }

  async function stagePost(dest: Awaited<ReturnType<typeof destinations>>[number], input: Omit<BoardCardPost, "version" | "op" | "resourceId" | "channelId">) {
    const channelId = dest.resource.providerResourceId.replace(/^slack:/, "");
    const payload: BoardCardPost = { version: 1, op: "post", resourceId: dest.resource.id, channelId, ...input };
    await db.insert(chatActions).values({
      companyId: dest.resource.companyId,
      endpointId: dest.endpoint.id,
      kind: BOARD_CARD_KIND,
      providerActionId: `board-card:${input.subjectKind}:${input.subjectId}:${input.rev}`,
      payload,
      status: "received",
    }).onConflictDoNothing();
  }

  async function stageSettle(post: typeof chatActions.$inferSelect, outcome: string) {
    const p = post.payload as unknown as BoardCardPost;
    const payload: BoardCardSettle = {
      version: 1, op: "settle", postActionId: post.id, subjectKind: p.subjectKind, subjectId: p.subjectId,
      outcome, content: settledContent(p.content, outcome),
    };
    await db.insert(chatActions).values({
      companyId: post.companyId,
      endpointId: post.endpointId,
      kind: BOARD_CARD_KIND,
      providerActionId: `board-card-settle:${post.id}`,
      payload: payload as unknown as Record<string, unknown>,
      status: "received",
    }).onConflictDoNothing();
  }

  /** Read pending decisions and card state; stage posts for new ones and settles for decided ones. */
  async function sweep() {
    const baseUrl = options.publicBaseUrl();
    const staleBefore = new Date(now() - BOARD_CARD_PROCESSING_STALE_MS);
    // An uncertain delivery is never retried as a post.
    await db.update(chatActions).set({ status: "delivery_unknown", updatedAt: new Date() }).where(and(
      eq(chatActions.kind, BOARD_CARD_KIND),
      eq(chatActions.status, "processing"),
      sql`${chatActions.payload}->>'op' = 'post'`,
      lt(chatActions.updatedAt, staleBefore),
    ));
    for (const dest of await destinations()) {
      const companyId = dest.resource.companyId;
      const issuePrefix = dest.issuePrefix;

      // ---- interactions
      const pending: InteractionRow[] = await db
        .select({
          id: issueThreadInteractions.id,
          issueId: issueThreadInteractions.issueId,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
          title: issueThreadInteractions.title,
          summary: issueThreadInteractions.summary,
          payload: issueThreadInteractions.payload,
          createdByAgentId: issueThreadInteractions.createdByAgentId,
          addresseeAgentId: issueThreadInteractions.addresseeAgentId,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueVisibility: issues.visibility,
          conversationAgentId: issues.conversationAgentId,
          agentName: agents.name,
        })
        .from(issueThreadInteractions)
        .innerJoin(issues, and(eq(issues.id, issueThreadInteractions.issueId), eq(issues.companyId, issueThreadInteractions.companyId)))
        .leftJoin(agents, eq(agents.id, issueThreadInteractions.createdByAgentId))
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.status, "pending"),
          inArray(issueThreadInteractions.kind, ["request_confirmation", "ask_user_questions"]),
          sql`${issueThreadInteractions.createdByAgentId} is not null`,
          isNull(issueThreadInteractions.addresseeAgentId),
          isNull(issues.conversationAgentId),
        )) as unknown as InteractionRow[];
      const pendingIds = new Set(pending.map((row) => row.id));
      const interactionPosts = await latestPosts(companyId, "interaction");
      const actionRequestIds = pending
        .map((row) => (row.payload?.toolAction as Record<string, unknown> | undefined)?.actionRequestId)
        .filter((id): id is string => typeof id === "string");
      const formal = actionRequestIds.length
        ? new Set((await db.select({ id: sql<string>`${approvals.payload}->>'actionRequestId'` }).from(approvals).where(and(
            eq(approvals.companyId, companyId),
            sql`${approvals.payload}->>'actionRequestId' in (${sql.join(actionRequestIds.map((id) => sql`${id}`), sql`, `)})`,
          ))).map((row) => row.id))
        : new Set<string>();
      for (const row of pending) {
        const last = interactionPosts.get(row.id);
        if (last && !(await settled(last.id))) continue;
        const rev = last ? Number((last.payload as unknown as BoardCardPost).rev ?? 0) + 1 : 0;
        const actionRequestId = (row.payload?.toolAction as Record<string, unknown> | undefined)?.actionRequestId;
        const content = interactionCardContent(row, { baseUrl, issuePrefix, formalApproval: typeof actionRequestId === "string" && formal.has(actionRequestId) });
        await stagePost(dest, { subjectKind: "interaction", subjectId: row.id, rev, issueId: row.issueId, content });
      }
      for (const [subjectId, post] of interactionPosts) {
        if (pendingIds.has(subjectId) || ["cancelled"].includes(post.status) || (await settled(post.id))) continue;
        const [current] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.id, subjectId)));
        await stageSettle(post, current ? (INTERACTION_OUTCOME[current.status] ?? "Closed") : "Removed");
      }

      // ---- approvals (link-only; gateway approvals are covered by their interaction card)
      const pendingApprovals: ApprovalRow[] = await db
        .select({
          id: approvals.id, type: approvals.type, status: approvals.status, payload: approvals.payload,
          requestedByAgentId: approvals.requestedByAgentId, agentName: agents.name,
        })
        .from(approvals)
        .leftJoin(agents, eq(agents.id, approvals.requestedByAgentId))
        .where(and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "pending"),
          or(sql`${approvals.payload}->>'source' is null`, sql`${approvals.payload}->>'source' <> 'tool_gateway'`),
        ));
      const pendingApprovalIds = new Set(pendingApprovals.map((row) => row.id));
      const approvalPosts = await latestPosts(companyId, "approval");
      for (const row of pendingApprovals) {
        const last = approvalPosts.get(row.id);
        if (last && !(await settled(last.id))) continue;
        const rev = last ? Number((last.payload as unknown as BoardCardPost).rev ?? 0) + 1 : 0;
        await stagePost(dest, { subjectKind: "approval", subjectId: row.id, rev, issueId: null, content: approvalCardContent(row, { baseUrl, issuePrefix }) });
      }
      for (const [subjectId, post] of approvalPosts) {
        if (pendingApprovalIds.has(subjectId) || ["cancelled"].includes(post.status) || (await settled(post.id))) continue;
        const [current] = await db.select({ status: approvals.status }).from(approvals).where(and(eq(approvals.companyId, companyId), eq(approvals.id, subjectId)));
        await stageSettle(post, current ? (APPROVAL_OUTCOME[current.status] ?? "Closed") : "Removed");
      }
    }
    lastSweepAt = now();
  }

  /** Slack's current view of the channel must still be private, not shared, not archived. */
  async function channelStillPrivate(endpoint: EndpointRow, channelId: string): Promise<{ ok: boolean; reason?: string }> {
    const key = `${endpoint.id}:${channelId}`;
    const cached = probeCache.get(key);
    if (cached && now() - cached.at < CHANNEL_PROBE_TTL_MS) return cached;
    const channel = await options.inspectSlackBoardChannel(endpoint, channelId);
    const reason = !channel
      ? "the bot cannot see the board channel"
      : channel.private !== true
        ? "the board channel is no longer private"
        : channel.extShared === true || channel.pendingExtShared === true
          ? "the board channel is shared through Slack Connect"
          : channel.archived === true || channel.isArchived === true
            ? "the board channel is archived"
            : undefined;
    const result = { at: now(), ok: !reason, reason };
    probeCache.set(key, result);
    return result;
  }

  async function markFailed(action: typeof chatActions.$inferSelect, error: unknown) {
    const attempts = Number(action.result?.attempts ?? 0) + 1;
    const classified = classifyChatPublicationError(error, attempts);
    if (classified.kind === "delivery_unknown" && action.payload.op === "post") {
      // The provider may have shown the card. Never send it again.
      await db.update(chatActions).set({ status: "delivery_unknown", result: { ...(action.result ?? {}), attempts, reason: classified.reason }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
      return;
    }
    const retryable = classified.kind === "retry" && attempts < 8;
    const retryAfterMs = classified.kind === "retry" ? (classified as { retryAfterMs?: number }).retryAfterMs ?? 0 : 0;
    const retryAt = new Date(now() + Math.min(60 * 60_000, retryAfterMs || 15_000 * 2 ** attempts)).toISOString();
    await db.update(chatActions).set({
      status: "failed",
      result: { ...(action.result ?? {}), attempts, retryable, retryAt, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
      updatedAt: new Date(),
    }).where(eq(chatActions.id, action.id));
    if (!retryable) {
      await logActivity(db, {
        companyId: action.companyId, actorType: "system", actorId: "board-cards", action: "chat.board_card_failed",
        entityType: "chat_endpoint", entityId: action.endpointId,
        details: { actionId: action.id, op: action.payload.op, subjectKind: action.payload.subjectKind, subjectId: action.payload.subjectId, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
      });
    }
  }

  async function processOne(action: typeof chatActions.$inferSelect) {
    // Claim: only one worker sends a given row.
    const [claimed] = await db.update(chatActions).set({ status: "processing", updatedAt: new Date() }).where(and(
      eq(chatActions.id, action.id), inArray(chatActions.status, ["received", "failed"]),
    )).returning();
    if (!claimed) return;
    const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, action.endpointId), eq(chatEndpoints.companyId, action.companyId)));
    if (!endpoint || !["active", "verifying"].includes(endpoint.status)) {
      await db.update(chatActions).set({ status: "received", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
      return;
    }
    try {
      const runtime = await options.runtimeFor(endpoint);
      if (action.payload.op === "post") {
        const post = action.payload as unknown as BoardCardPost;
        const probe = await channelStillPrivate(endpoint, post.channelId);
        if (!probe.ok) {
          await db.update(chatActions).set({ status: "cancelled", result: { code: "board_channel_unsafe", message: probe.reason }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
          await logActivity(db, {
            companyId: action.companyId, actorType: "system", actorId: "board-cards", action: "chat.board_card_blocked",
            entityType: "chat_endpoint", entityId: action.endpointId, details: { reason: probe.reason, subjectKind: post.subjectKind, subjectId: post.subjectId },
          });
          return;
        }
        const thread = runtime.thread(`slack:${post.channelId}:`);
        const card = safeCardForPublication(cardPayload(post.subjectId, post.content, post.actions ?? []), "slack");
        const sent = await thread.post({ card: card!, fallbackText: cardPayload(post.subjectId, post.content).text });
        await db.update(chatActions).set({ status: "published", result: { providerMessageId: sent.id, threadId: thread.id }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
        return;
      }
      const settle = action.payload as unknown as BoardCardSettle;
      const [post] = await db.select().from(chatActions).where(eq(chatActions.id, settle.postActionId));
      if (!post) {
        await db.update(chatActions).set({ status: "processed", result: { code: "post_missing" }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
        return;
      }
      if (post.status === "received" || post.status === "failed") {
        // Never sent: cancel the post instead of sending a dead card.
        const cancelled = await db.update(chatActions).set({ status: "cancelled", result: { code: "settled_before_post" }, updatedAt: new Date() })
          .where(and(eq(chatActions.id, post.id), inArray(chatActions.status, ["received", "failed"]))).returning({ id: chatActions.id });
        if (cancelled.length) {
          await db.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
          return;
        }
      }
      if (post.status === "processing") {
        // The post is in flight; try again after it settles.
        await db.update(chatActions).set({ status: "received", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
        return;
      }
      const postPayload = post.payload as unknown as BoardCardPost;
      const thread = runtime.thread(`slack:${postPayload.channelId}:`);
      const card = safeCardForPublication(cardPayload(settle.subjectId, settle.content), "slack")!;
      const fallbackText = cardPayload(settle.subjectId, settle.content).text;
      const messageId = typeof post.result?.providerMessageId === "string" ? post.result.providerMessageId : null;
      if (post.status === "published" && messageId) {
        await thread.adapter.editMessage(thread.id, messageId, { card, fallbackText });
      } else {
        // delivery_unknown or cancelled-after-send: a plain follow-up, no buttons.
        await thread.post({ card, fallbackText });
      }
      await db.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
    } catch (error) {
      logger.warn({ actionId: action.id, error: error instanceof Error ? error.message : String(error) }, "board card delivery failed");
      await markFailed(action, error);
    }
  }

  /** One worker pass: sweep when due, then send due posts and settles (posts first). */
  async function processPendingBoardCards(limit = 10) {
    if (now() - lastSweepAt >= BOARD_CARD_SWEEP_MS) {
      try {
        await sweep();
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "board card sweep failed");
      }
    }
    const due = await db.select().from(chatActions).where(and(
      eq(chatActions.kind, BOARD_CARD_KIND),
      or(
        eq(chatActions.status, "received"),
        and(eq(chatActions.status, "failed"), sql`${chatActions.result}->>'retryable' = 'true'`, sql`(${chatActions.result}->>'retryAt')::timestamptz <= now()`),
      ),
      notInArray(chatActions.endpointId, sql`(select id from chat_endpoints where status in ('paused', 'attention'))`),
    )).orderBy(sql`case when ${chatActions.payload}->>'op' = 'post' then 0 else 1 end`, asc(chatActions.createdAt)).limit(limit);
    for (const action of due) await processOne(action);
  }

  /** Next time the worker should run: a due row now, else the next sweep. */
  async function nextBoardCardAt(): Promise<number | null> {
    const [any] = await db.select({ id: chatEndpointResources.id }).from(chatEndpointResources).where(eq(chatEndpointResources.boardCards, true)).limit(1);
    if (!any) return null;
    const [row] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
      eq(chatActions.kind, BOARD_CARD_KIND), eq(chatActions.status, "received"))).limit(1);
    return row ? now() : lastSweepAt + BOARD_CARD_SWEEP_MS;
  }

  return { processPendingBoardCards, nextBoardCardAt, sweep };
}
