import type { ChatProvider, SafeExternalChatCard } from "@paperclipai/shared";

/**
 * Hard text limits a provider enforces on native card elements. A card that
 * exceeds one is rejected outright (Slack answers `invalid_blocks`), so the
 * whole publication fails and the conversation keeps its "working" message.
 * Confirmation cards use the agent's full prompt as their title, which can be
 * several hundred characters, so these limits are applied at send time.
 *
 * Lengths are measured in UTF-16 code units, which never undercounts the
 * characters a provider counts.
 */
type CardLimits = { title: number; body: number; label: number };

const CARD_LIMITS: Partial<Record<ChatProvider, CardLimits>> = {
  // Block Kit: header plain_text 150, section text 3000, button text 75.
  slack: { title: 150, body: 3000, label: 75 },
  // Embeds: title 256, description 4096; component button label 80.
  discord: { title: 256, body: 4096, label: 80 },
};

const ELLIPSIS = "…";
function bodyTruncationNote(taskUrl: string | null | undefined): string {
  return taskUrl
    ? `\n\n… Shortened to fit this chat. Read the full text on the task: ${taskUrl}`
    : "\n\n… Shortened to fit this chat. The full text is on the Paperclip task.";
}

/** What had to be shortened to fit a provider; empty when nothing was lost. */
export type CardShortening = Array<"body" | "label">;

/** Shorten to at most `max` code units, preferring a word boundary. */
export function shortenText(value: string, max: number): string {
  if (value.length <= max) return value;
  const room = max - ELLIPSIS.length;
  let cut = value.slice(0, room);
  const space = cut.search(/\s\S*$/);
  if (space > room * 0.6) cut = cut.slice(0, space);
  return cut.trimEnd() + ELLIPSIS;
}

/** A short heading from the first sentence of a long text. */
export function headingFrom(text: string, max: number): string {
  const firstLine = text.split(/\n/, 1)[0]?.trim() || text.trim();
  const sentence = /^(.+?[.?!])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
  return shortenText(sentence, max);
}

/**
 * Title limit applied when a card is stored (chat-publication-projection's
 * MAX_TITLE_LENGTH, which cuts silently). A longer title would lose words, so
 * card builders move it into the body and use a short heading instead.
 */
export const STORED_CARD_TITLE_LIMIT = 160;

/** Keeps a long title's full wording by moving it into the body. */
export function cardTitleAndBody(
  title: string,
  heading: string | null | undefined,
  body: string | undefined,
): { title: string; body: string | undefined } {
  if (Array.from(title).length <= STORED_CARD_TITLE_LIMIT) return { title, body };
  const short = heading?.trim() && Array.from(heading.trim()).length <= STORED_CARD_TITLE_LIMIT
    ? heading.trim()
    : headingFrom(title, 150);
  return { title: short, body: body ? `${title}\n\n${body}` : title };
}

/**
 * Returns a card that fits the provider's native limits without losing text:
 * an over-long title becomes a short heading and its full wording moves to the
 * top of the body. Only the body is ever cut, with a note pointing to the task.
 */
export function fitCardToProviderLimits(
  card: SafeExternalChatCard,
  provider: ChatProvider,
  options: { taskUrl?: string | null; onShortened?: (parts: CardShortening) => void } = {},
): SafeExternalChatCard {
  const limits = CARD_LIMITS[provider];
  if (!limits) return card;
  let title = card.title;
  let body = card.body;
  if (title.length > limits.title) {
    body = body ? `${card.title}\n\n${body}` : card.title;
    title = headingFrom(card.title, limits.title);
  }
  const shortened: CardShortening = [];
  if (body && body.length > limits.body) {
    // Keep most of the limit for the text itself; a provider with a small
    // limit gets the short note rather than a link that crowds out the text.
    const linked = bodyTruncationNote(options.taskUrl);
    const note = limits.body - linked.length >= limits.body / 2 ? linked : bodyTruncationNote(null);
    body = shortenText(body, limits.body - note.length) + note;
    shortened.push("body");
  }
  const actions = card.actions?.map((action) => {
    if (action.label.length <= limits.label) return action;
    if (!shortened.includes("label")) shortened.push("label"); // once, however many labels
    return { ...action, label: shortenText(action.label, limits.label) };
  });
  if (shortened.length) options.onShortened?.(shortened);
  return {
    ...card,
    title,
    ...(body === undefined ? {} : { body }),
    ...(actions === undefined ? {} : { actions }),
  };
}

/** Provider error codes that prove a card was rejected and nothing was posted. */
const DEFINITE_CARD_REJECTIONS: Partial<Record<ChatProvider, ReadonlySet<string>>> = {
  slack: new Set(["invalid_blocks", "invalid_blocks_format"]),
};

/**
 * True only when the provider definitively refused the card's layout, so a
 * plain-text retry cannot duplicate a message. Follows the structured wrapper
 * properties adapters use; never inspects free-form error text.
 */
export function isDefiniteCardRejection(error: unknown, provider: ChatProvider): boolean {
  const codes = DEFINITE_CARD_REJECTIONS[provider];
  if (!codes) return false;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  while (pending.length) {
    const { value, depth } = pending.shift()!;
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) continue;
    seen.add(value);
    const record = value as { data?: { error?: unknown }; cause?: unknown; original?: unknown; originalError?: unknown };
    if (typeof record.data?.error === "string" && codes.has(record.data.error)) return true;
    for (const nested of [record.cause, record.original, record.originalError]) {
      pending.push({ value: nested, depth: depth + 1 });
    }
  }
  return false;
}

/** Plain-text rendering of a card, used when a provider rejects its layout. */
export function cardAsPlainText(card: SafeExternalChatCard, fallbackText: string): string {
  return [card.title, card.body, fallbackText]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
}
