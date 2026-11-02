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

import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
import { CHAT_QUESTION_ACTION_TOKEN_TTL_MS, createChatConfirmationActionToken } from "../chat-interaction-publications.js";
import type { EndpointRow } from "./runtime-types.js";
import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

export const BOARD_CARD_KIND = "board_card";
/** Single-use Slack button token for a decision on a board card (stage 2). */
export const BOARD_CARD_DECISION_KIND = "board_card_decision";

export type BoardCardDecisionToken = {
  version: 1;
  postProviderActionId: string;
  subjectKind: "interaction";
  subjectId: string;
  issueId: string;
  decision: "accept" | "reject";
  toolAction: boolean;
  actionRequestId: string | null;
  expiresAt: string;
};

/**
 * Which pending interactions can be decided with a Slack button. Everything else
 * stays link-only and is decided in Paperclip (plan table "Stage 2: act").
 */
export function boardCardDecisionLabels(row: {
  kind: string;
  addresseeUserId?: string | null;
  payload: Record<string, unknown>;
  issueVisibility: string;
}, formalApproval: boolean): { accept: string; reject: string; toolAction: boolean; actionRequestId: string | null; expiresAt: string | null } | null {
  if (row.kind !== "request_confirmation" || row.issueVisibility === "private") return null;
  // A prompt addressed to one person is theirs to answer, not the board channel's.
  if (row.addresseeUserId) return null;
  const p = row.payload ?? {};
  const toolAction = p.toolAction as Record<string, unknown> | undefined;
  if (toolAction) {
    if (formalApproval) return null; // two-step governance stays in Paperclip
    if (toolAction.risk !== "read" && toolAction.risk !== "write") return null; // destructive: full view in Paperclip
    if (typeof toolAction.actionRequestId !== "string") return null;
    return { accept: "Approve", reject: "Reject", toolAction: true, actionRequestId: toolAction.actionRequestId, expiresAt: typeof toolAction.expiresAt === "string" ? toolAction.expiresAt : null };
  }
  // Same predicate as native Telegram confirmations.
  if (p.rejectRequiresReason === true || p.secretProposal !== undefined || p.connectionAuthorization !== undefined) return null;
  if ((p.target as Record<string, unknown> | undefined)?.type === "issue_document") return null;
  return {
    accept: typeof p.acceptLabel === "string" ? p.acceptLabel : "Accept",
    reject: typeof p.rejectLabel === "string" ? p.rejectLabel : "Reject",
    toolAction: false, actionRequestId: null, expiresAt: null,
  };
}
/** How often pending decisions are re-read; the longest a card can lag or stay stale. */
export const BOARD_CARD_SWEEP_MS = 20_000;
/** A post still `processing` after this is treated as delivered-or-not-known, never re-sent. */
export const BOARD_CARD_PROCESSING_STALE_MS = 60_000;
/** Only decisions raised in this window are posted, so turning the channel on does not flood it with old items. */
export const BOARD_CARD_BACKFILL_MS = 14 * 24 * 60 * 60_000;
/** A dead card (cancelled or permanently failed) is retried no sooner than this, and only if the cause cleared. */
export const BOARD_CARD_DEAD_RETRY_MS = 60 * 60_000;
/** At most this many cards (revs) per decision, and this many settle revivals per card. */
export const BOARD_CARD_MAX_REVS = 5;
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
  addresseeUserId?: string | null;
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
  type ActionRow = typeof chatActions.$inferSelect;

  /** The single board destination of each company that has one, on a live, enabled Slack channel. */
  async function destinations() {
    return db
      .select({ resource: chatEndpointResources, endpoint: chatEndpoints, issuePrefix: companies.issuePrefix })
      .from(chatEndpointResources)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatEndpointResources.endpointId), eq(chatEndpoints.companyId, chatEndpointResources.companyId)))
      .innerJoin(companies, eq(companies.id, chatEndpointResources.companyId))
      .where(and(
        eq(chatEndpointResources.boardCards, true),
        eq(chatEndpointResources.enabled, true),
        eq(chatEndpointResources.availability, "available"),
        eq(chatEndpoints.provider, "slack"),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ));
  }

  /** Posts not yet settled, for one company (bounded by open cards, not history). */
  async function openPosts(companyId: string) {
    return db.select().from(chatActions).where(and(
      eq(chatActions.companyId, companyId),
      eq(chatActions.kind, BOARD_CARD_KIND),
      sql`${chatActions.payload}->>'op' = 'post'`,
      sql`not exists (select 1 from chat_actions s where s.endpoint_id = ${chatActions.endpointId}
        and s.provider_action_id = 'board-card-settle:' || ${chatActions.id}::text)`,
    ));
  }

  /** The newest post per subject among the given subject ids (for rev numbering). */
  async function latestPostsFor(companyId: string, subjectKind: SubjectKind, subjectIds: string[]) {
    const bySubject = new Map<string, ActionRow>();
    if (subjectIds.length === 0) return bySubject;
    const rows = await db.select().from(chatActions).where(and(
      eq(chatActions.companyId, companyId),
      eq(chatActions.kind, BOARD_CARD_KIND),
      sql`${chatActions.payload}->>'op' = 'post'`,
      sql`${chatActions.payload}->>'subjectKind' = ${subjectKind}`,
      sql`${chatActions.payload}->>'subjectId' in (${sql.join(subjectIds.map((id) => sql`${id}`), sql`, `)})`,
    )).orderBy(desc(chatActions.createdAt));
    for (const row of rows) {
      const id = String(row.payload.subjectId);
      if (!bySubject.has(id)) bySubject.set(id, row);
    }
    return bySubject;
  }

  /** A post that will never reach Slack: cancelled (unsafe channel, endpoint gone) or permanently failed. */
  function deadPost(row: ActionRow) {
    return row.status === "cancelled" || (row.status === "failed" && row.result?.retryable !== true);
  }

  async function stagePost(
    dest: Awaited<ReturnType<typeof destinations>>[number],
    input: Omit<BoardCardPost, "version" | "op" | "resourceId" | "channelId" | "actions">,
    decision?: ReturnType<typeof boardCardDecisionLabels>,
  ) {
    const channelId = dest.resource.providerResourceId.replace(/^slack:/, "");
    const postProviderActionId = `board-card:${input.subjectKind}:${input.subjectId}:${input.rev}`;
    const tokens = decision && input.issueId
      ? (["accept", "reject"] as const).map((choice) => ({ choice, actionId: createChatConfirmationActionToken() }))
      : [];
    const actions: SafeExternalChatCardAction[] = tokens.map(({ choice, actionId }) => ({
      type: "callback" as const,
      actionId,
      label: choice === "accept" ? decision!.accept : decision!.reject,
      style: choice === "accept" ? ("primary" as const) : ("danger" as const),
    }));
    const payload: BoardCardPost = { version: 1, op: "post", resourceId: dest.resource.id, channelId, ...input, ...(actions.length ? { actions } : {}) };
    const ttl = new Date(now() + CHAT_QUESTION_ACTION_TOKEN_TTL_MS).getTime();
    const subjectExpiry = decision?.expiresAt ? Date.parse(decision.expiresAt) : Number.NaN;
    const expiresAt = new Date(Number.isFinite(subjectExpiry) ? Math.min(ttl, subjectExpiry) : ttl).toISOString();
    await db.transaction(async (tx) => {
      const inserted = await tx.insert(chatActions).values({
        companyId: dest.resource.companyId,
        endpointId: dest.endpoint.id,
        kind: BOARD_CARD_KIND,
        providerActionId: postProviderActionId,
        payload,
        status: "received",
      }).onConflictDoNothing().returning({ id: chatActions.id });
      if (!inserted.length || !tokens.length) return;
      await tx.insert(chatActions).values(tokens.map(({ choice, actionId }) => ({
        companyId: dest.resource.companyId,
        endpointId: dest.endpoint.id,
        kind: BOARD_CARD_DECISION_KIND,
        providerActionId: actionId,
        payload: {
          version: 1, postProviderActionId, subjectKind: "interaction", subjectId: input.subjectId, issueId: input.issueId!,
          decision: choice, toolAction: decision!.toolAction, actionRequestId: decision!.actionRequestId, expiresAt,
        } satisfies BoardCardDecisionToken,
        status: "issued",
      })));
    });
  }

  async function stageSettle(post: ActionRow, outcome: string) {
    const p = post.payload as unknown as BoardCardPost;
    // The decision is made; no button on this card may act any more.
    await db.update(chatActions).set({ status: "expired", updatedAt: new Date() }).where(and(
      eq(chatActions.companyId, post.companyId),
      eq(chatActions.kind, BOARD_CARD_DECISION_KIND),
      inArray(chatActions.status, ["issued", "failed"]),
      sql`${chatActions.payload}->>'postProviderActionId' = ${post.providerActionId}`,
    ));
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

  async function logProblem(action: ActionRow, what: string, details: Record<string, unknown>) {
    await logActivity(db, {
      companyId: action.companyId, actorType: "system", actorId: "board-cards", action: what,
      entityType: "chat_endpoint", entityId: action.endpointId,
      details: { actionId: action.id, op: action.payload.op, subjectKind: action.payload.subjectKind, subjectId: action.payload.subjectId, ...details },
    });
  }

  /** Read pending decisions and card state; stage posts for new ones and settles for decided ones. */
  async function sweep() {
    const baseUrl = options.publicBaseUrl();
    const staleBefore = new Date(now() - BOARD_CARD_PROCESSING_STALE_MS);
    const backfillSince = new Date(now() - BOARD_CARD_BACKFILL_MS);
    // An uncertain delivery is never retried as a post; record it so it is visible.
    const unknown = await db.update(chatActions).set({ status: "delivery_unknown", updatedAt: new Date() }).where(and(
      eq(chatActions.kind, BOARD_CARD_KIND),
      eq(chatActions.status, "processing"),
      sql`${chatActions.payload}->>'op' = 'post'`,
      lt(chatActions.updatedAt, staleBefore),
    )).returning();
    for (const row of unknown) await logProblem(row, "chat.board_card_delivery_unknown", { reason: "the send did not finish; it is not repeated" });

    for (const dest of await destinations()) {
      const companyId = dest.resource.companyId;
      const issuePrefix = dest.issuePrefix;
      const channelId = dest.resource.providerResourceId.replace(/^slack:/, "");

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
          addresseeUserId: issueThreadInteractions.addresseeUserId,
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
          sql`greatest(${issueThreadInteractions.createdAt}, ${issueThreadInteractions.updatedAt}) >= ${backfillSince.toISOString()}::timestamptz`,
          // A task that already lives in the board channel shows its card in its own thread.
          sql`not exists (select 1 from chat_conversations c where c.company_id = ${issues.companyId}
            and c.issue_id = ${issues.id} and c.state in ('active', 'waiting')
            and c.external_conversation_id in (${`slack:${channelId}`}, ${channelId}))`,
        )) as unknown as InteractionRow[];
      const privateSourceIssues = new Set(pending.length
        ? (await db.select({ issueId: sql<string>`${chatActions.payload}->>'issueId'` }).from(chatActions).where(and(
            eq(chatActions.companyId, companyId),
            eq(chatActions.kind, "slack_private_source"),
            sql`${chatActions.payload}->>'issueId' in (${sql.join([...new Set(pending.map((r) => r.issueId))].map((id) => sql`${id}`), sql`, `)})`,
          ))).map((r) => r.issueId)
        : []);
      const actionRequestIds = pending
        .map((row) => (row.payload?.toolAction as Record<string, unknown> | undefined)?.actionRequestId)
        .filter((id): id is string => typeof id === "string");
      const formal = actionRequestIds.length
        ? new Set((await db.select({ id: sql<string>`${approvals.payload}->>'actionRequestId'` }).from(approvals).where(and(
            eq(approvals.companyId, companyId),
            sql`${approvals.payload}->>'actionRequestId' in (${sql.join(actionRequestIds.map((id) => sql`${id}`), sql`, `)})`,
          ))).map((row) => row.id))
        : new Set<string>();
      const interactionLatest = await latestPostsFor(companyId, "interaction", pending.map((r) => r.id));
      for (const row of pending) {
        const last = interactionLatest.get(row.id);
        // Live or uncertain card already exists: nothing to post. A dead post is re-staged.
        if (last && !(await mayRestage(last, dest.endpoint, channelId))) continue;
        const rev = last ? Number((last.payload as unknown as BoardCardPost).rev ?? 0) + 1 : 0;
        const actionRequestId = (row.payload?.toolAction as Record<string, unknown> | undefined)?.actionRequestId;
        const contentRow = privateSourceIssues.has(row.issueId) ? { ...row, issueVisibility: "private" } : row;
        const formalApproval = typeof actionRequestId === "string" && formal.has(actionRequestId);
        const content = interactionCardContent(contentRow, { baseUrl, issuePrefix, formalApproval });
        await stagePost(dest, { subjectKind: "interaction", subjectId: row.id, rev, issueId: row.issueId, content },
          boardCardDecisionLabels(contentRow, formalApproval));
      }

      // ---- approvals (link-only; gateway approvals are covered by their interaction card)
      const pendingApprovals = await db
        .select({
          id: approvals.id, type: approvals.type, status: approvals.status, payload: approvals.payload,
          requestedByAgentId: approvals.requestedByAgentId, agentName: agents.name,
          privateLinked: sql<boolean>`exists (select 1 from issue_approvals ia join issues i on i.id = ia.issue_id
            where ia.approval_id = ${approvals.id} and i.visibility = 'private')`,
        })
        .from(approvals)
        .leftJoin(agents, eq(agents.id, approvals.requestedByAgentId))
        .where(and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "pending"),
          sql`greatest(${approvals.createdAt}, ${approvals.updatedAt}) >= ${backfillSince.toISOString()}::timestamptz`,
          or(sql`${approvals.payload}->>'source' is null`, sql`${approvals.payload}->>'source' <> 'tool_gateway'`),
        ));
      const approvalLatest = await latestPostsFor(companyId, "approval", pendingApprovals.map((r) => r.id));
      for (const row of pendingApprovals) {
        const last = approvalLatest.get(row.id);
        if (last && !(await mayRestage(last, dest.endpoint, channelId))) continue;
        const rev = last ? Number((last.payload as unknown as BoardCardPost).rev ?? 0) + 1 : 0;
        const content = row.privateLinked
          ? { title: "An approval needs the board", body: `${row.agentName ?? "Someone"} requests a board approval on a private task. Decide in Paperclip.`, url: approvalCardContent(row, { baseUrl, issuePrefix }).url }
          : approvalCardContent(row, { baseUrl, issuePrefix });
        await stagePost(dest, { subjectKind: "approval", subjectId: row.id, rev, issueId: null, content });
      }

      // ---- settle open cards whose subject is no longer pending
      const pendingInteractionIds = new Set(pending.map((r) => r.id));
      const pendingApprovalIds = new Set(pendingApprovals.map((r) => r.id));
      for (const post of await openPosts(companyId)) {
        if (deadPost(post)) continue;
        const p = post.payload as unknown as BoardCardPost;
        if (p.subjectKind === "interaction") {
          if (pendingInteractionIds.has(p.subjectId)) continue;
          const [current] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.id, p.subjectId)));
          if (current?.status === "pending") continue; // still pending but filtered (e.g. older than the backfill window)
          await stageSettle(post, current ? (INTERACTION_OUTCOME[current.status] ?? "Closed") : "Removed");
        } else {
          if (pendingApprovalIds.has(p.subjectId)) continue;
          const [current] = await db.select({ status: approvals.status }).from(approvals).where(and(eq(approvals.companyId, companyId), eq(approvals.id, p.subjectId)));
          if (current?.status === "pending") continue;
          await stageSettle(post, current ? (APPROVAL_OUTCOME[current.status] ?? "Closed") : "Removed");
        }
      }
      await reviveSettles(companyId, dest.endpoint, channelId);
    }
    lastSweepAt = now();
  }

  /**
   * Whether a subject that still needs the board may get a new card. A live or
   * uncertain card blocks; a settled one allows (re-pended subject). A dead card
   * allows only after a cool-down, only when its cause has cleared, and only up
   * to a cap, so a broken bot or channel cannot turn the sweep into a loop.
   */
  async function mayRestage(last: ActionRow, endpoint: EndpointRow, channelId: string) {
    if (await isSettled(last.id)) return true;
    if (!deadPost(last)) return false;
    const rev = Number((last.payload as unknown as BoardCardPost).rev ?? 0);
    if (rev + 1 >= BOARD_CARD_MAX_REVS) return false;
    if (now() - last.updatedAt.getTime() < BOARD_CARD_DEAD_RETRY_MS) return false;
    if (last.result?.code === "board_endpoint_unavailable") return false; // the destination now uses another bot or none
    try {
      return (await channelStillPrivate(endpoint, channelId)).ok;
    } catch {
      return false;
    }
  }

  /** Revive settles that died on an unsafe channel or exhausted retries, once the channel is safe again. */
  async function reviveSettles(companyId: string, endpoint: EndpointRow, channelId: string) {
    const dead = await db.select().from(chatActions).where(and(
      eq(chatActions.companyId, companyId),
      eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.kind, BOARD_CARD_KIND),
      sql`${chatActions.payload}->>'op' = 'settle'`,
      or(eq(chatActions.status, "cancelled"), and(eq(chatActions.status, "failed"), sql`coalesce(${chatActions.result}->>'retryable', 'false') <> 'true'`)),
      lt(chatActions.updatedAt, new Date(now() - BOARD_CARD_DEAD_RETRY_MS)),
      sql`coalesce((${chatActions.result}->>'revivals')::int, 0) < ${BOARD_CARD_MAX_REVS}`,
    ));
    if (!dead.length) return;
    let safe = false;
    try { safe = (await channelStillPrivate(endpoint, channelId)).ok; } catch { safe = false; }
    if (!safe) return;
    for (const row of dead) {
      await db.update(chatActions).set({
        status: "received",
        result: { revivals: Number(row.result?.revivals ?? 0) + 1, previous: row.result ?? null },
        updatedAt: new Date(),
      }).where(and(eq(chatActions.id, row.id), eq(chatActions.status, row.status)));
    }
  }

  async function isSettled(postId: string) {
    const [row] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
      eq(chatActions.kind, BOARD_CARD_KIND),
      eq(chatActions.providerActionId, `board-card-settle:${postId}`),
    )).limit(1);
    return Boolean(row);
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

  /** A failure before anything was sent: always safe to retry. */
  async function retryLater(action: ActionRow, error: unknown) {
    const attempts = Number(action.result?.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    const retryable = attempts < 12;
    await db.update(chatActions).set({
      status: "failed",
      result: { ...(action.result ?? {}), attempts, retryable, retryAt: new Date(now() + Math.min(60 * 60_000, 15_000 * 2 ** attempts)).toISOString(), error: message, stage: "before_send" },
      updatedAt: new Date(),
    }).where(eq(chatActions.id, action.id));
    if (!retryable) await logProblem(action, "chat.board_card_failed", { error: message, stage: "before_send" });
  }

  /** A failure of the provider call itself. */
  async function sendFailed(action: ActionRow, error: unknown) {
    const attempts = Number(action.result?.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    const classified = classifyChatPublicationError(error, attempts);
    if (classified.kind === "delivery_unknown" && action.payload.op === "post") {
      // The provider may have shown the card. Never send it again; make it visible.
      await db.update(chatActions).set({ status: "delivery_unknown", result: { ...(action.result ?? {}), attempts, reason: classified.reason, error: message }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
      await logProblem(action, "chat.board_card_delivery_unknown", { error: message });
      return;
    }
    const retryable = (classified.kind === "retry" || classified.kind === "delivery_unknown") && attempts < 12;
    const retryAfterMs = classified.kind === "retry" ? (classified as { retryAfterMs?: number }).retryAfterMs ?? 0 : 0;
    const retryAt = new Date(now() + Math.min(60 * 60_000, retryAfterMs || 15_000 * 2 ** attempts)).toISOString();
    await db.update(chatActions).set({
      status: "failed",
      result: { ...(action.result ?? {}), attempts, retryable, retryAt, error: message },
      updatedAt: new Date(),
    }).where(eq(chatActions.id, action.id));
    if (!retryable) await logProblem(action, "chat.board_card_failed", { error: message });
  }

  async function processOne(action: ActionRow) {
    // Claim: only one worker sends a given row.
    const [claimed] = await db.update(chatActions).set({ status: "processing", updatedAt: new Date() }).where(and(
      eq(chatActions.id, action.id), inArray(chatActions.status, ["received", "failed"]),
    )).returning();
    if (!claimed) return;
    const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, action.endpointId), eq(chatEndpoints.companyId, action.companyId)));
    if (!endpoint || !["active", "verifying"].includes(endpoint.status)) {
      // Gone or archived: this card can never be sent from this bot. Paused bots are not dispatched at all.
      await db.update(chatActions).set({ status: "cancelled", result: { code: "board_endpoint_unavailable", endpointStatus: endpoint?.status ?? "missing" }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
      await logProblem(claimed, "chat.board_card_blocked", { reason: `the board bot is ${endpoint?.status ?? "missing"}` });
      return;
    }

    // ---- everything before the provider call is retryable and never counts as a send
    let runtime: ChatEndpointRuntime;
    let probe: { ok: boolean; reason?: string };
    let settlePost: ActionRow | undefined;
    const channelId = action.payload.op === "post"
      ? String((action.payload as unknown as BoardCardPost).channelId)
      : undefined;
    try {
      if (action.payload.op === "settle") {
        const settle = action.payload as unknown as BoardCardSettle;
        [settlePost] = await db.select().from(chatActions).where(eq(chatActions.id, settle.postActionId));
        if (!settlePost) {
          await db.update(chatActions).set({ status: "processed", result: { code: "post_missing" }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
          return;
        }
        if (settlePost.status === "received" || settlePost.status === "failed") {
          // Never sent: cancel the post instead of sending a dead card.
          const cancelled = await db.update(chatActions).set({ status: "cancelled", result: { code: "settled_before_post" }, updatedAt: new Date() })
            .where(and(eq(chatActions.id, settlePost.id), inArray(chatActions.status, ["received", "failed"]))).returning({ id: chatActions.id });
          if (cancelled.length) {
            await db.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
            return;
          }
        }
        if (settlePost.status === "processing") {
          await db.update(chatActions).set({ status: "received", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
          return;
        }
        if (settlePost.status === "cancelled") {
          // Nothing was ever shown; nothing to settle.
          await db.update(chatActions).set({ status: "processed", result: { code: "post_never_shown" }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
          return;
        }
      }
      runtime = await options.runtimeFor(endpoint);
      probe = await channelStillPrivate(endpoint, channelId ?? String((settlePost!.payload as unknown as BoardCardPost).channelId));
    } catch (error) {
      logger.warn({ actionId: action.id, error: error instanceof Error ? error.message : String(error) }, "board card: could not prepare the send; will retry");
      await retryLater(claimed, error);
      return;
    }
    if (!probe.ok) {
      await db.update(chatActions).set({ status: "cancelled", result: { code: "board_channel_unsafe", message: probe.reason }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
      await logProblem(claimed, "chat.board_card_blocked", { reason: probe.reason });
      return;
    }

    // ---- the provider call
    try {
      if (action.payload.op === "post") {
        const post = action.payload as unknown as BoardCardPost;
        const thread = runtime.thread(`slack:${post.channelId}:`);
        const payload = cardPayload(post.subjectId, post.content, post.actions ?? []);
        const card = safeCardForPublication(payload, "slack");
        const sent = await thread.post({ card: card!, fallbackText: payload.text });
        await db.update(chatActions).set({ status: "published", result: { providerMessageId: sent.id, threadId: thread.id }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
        return;
      }
      const settle = action.payload as unknown as BoardCardSettle;
      const postPayload = settlePost!.payload as unknown as BoardCardPost;
      const thread = runtime.thread(`slack:${postPayload.channelId}:`);
      const payload = cardPayload(settle.subjectId, settle.content);
      const card = safeCardForPublication(payload, "slack")!;
      const messageId = typeof settlePost!.result?.providerMessageId === "string" ? settlePost!.result.providerMessageId : null;
      if (settlePost!.status === "published" && messageId) {
        await thread.adapter.editMessage(thread.id, messageId, { card, fallbackText: payload.text });
      } else {
        // delivery_unknown: a plain follow-up, no buttons.
        await thread.post({ card, fallbackText: payload.text });
      }
      await db.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
    } catch (error) {
      logger.warn({ actionId: action.id, error: error instanceof Error ? error.message : String(error) }, "board card delivery failed");
      await sendFailed(claimed, error);
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
        and(eq(chatActions.status, "failed"), sql`${chatActions.result}->>'retryable' = 'true'`, sql`(${chatActions.result}->>'retryAt')::timestamptz <= ${new Date(now()).toISOString()}::timestamptz`),
      ),
      // Paused or needing-attention bots wait; archived or missing bots are cancelled by processOne.
      sql`not exists (select 1 from chat_endpoints e where e.id = ${chatActions.endpointId} and e.status in ('paused', 'attention'))`,
    )).orderBy(sql`case when ${chatActions.payload}->>'op' = 'post' then 0 else 1 end`, asc(chatActions.createdAt)).limit(limit);
    for (const action of due) await processOne(action);
  }

  /** Next time the worker should run: a due row now, else the next sweep; null when no company has a board channel. */
  async function nextBoardCardAt(): Promise<number | null> {
    const [any] = await db.select({ id: chatEndpointResources.id }).from(chatEndpointResources).where(eq(chatEndpointResources.boardCards, true)).limit(1);
    if (!any) return null;
    const [row] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
      eq(chatActions.kind, BOARD_CARD_KIND), eq(chatActions.status, "received"),
      sql`not exists (select 1 from chat_endpoints e where e.id = ${chatActions.endpointId} and e.status in ('paused', 'attention'))`,
    )).limit(1);
    return row ? now() : lastSweepAt + BOARD_CARD_SWEEP_MS;
  }

  return { processPendingBoardCards, nextBoardCardAt, sweep };
}
