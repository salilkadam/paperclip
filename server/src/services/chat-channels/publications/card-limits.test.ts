import { describe, expect, it } from "vitest";
import { cardToBlockKit } from "@chat-adapter/slack";
import { Actions, Button, Card, CardText } from "chat";
import type { SafeExternalChatCard } from "@paperclipai/shared";
import {
  cardAsPlainText,
  cardTitleAndBody,
  fitCardToProviderLimits,
  isDefiniteCardRejection,
  shortenText,
} from "./card-limits.js";

// The confirmation Slack rejected with `invalid_blocks` on 2026-10-30
// (REL-3210): its 684-character prompt became the card's header block.
const REJECTED_PROMPT =
  "You asked us to record contact details of community post authors in the CRM. Our lawyer (CLO) is reviewing the rules in task REL-3212. Confirm the scope we should aim for while we wait for the ruling.\n\nChoice A — Public details only: we save only contact details a person published in public themselves (for example a public email on their own profile), each tagged with where and when we found it, plus any conditions the CLO sets. We never guess emails from usernames.\n\nChoice B — Username only: no contact details go into the CRM. We keep the public username, link and date only.\n\nYour choice tells us what to build. We still change nothing until the CLO ruling says it is allowed.";

const card = (over: Partial<SafeExternalChatCard> = {}): SafeExternalChatCard => ({
  schema: "paperclip.chat.card.v1",
  kind: "confirmation",
  title: REJECTED_PROMPT,
  actions: [{ type: "link", label: "Open in Paperclip", url: "https://org.example/REL/issues/REL-3210" }],
  ...over,
});

// Mirrors safeCardForPublication, then renders with the real Slack converter.
function slackBlocks(fitted: SafeExternalChatCard) {
  const children = [];
  if (fitted.body) children.push(CardText(fitted.body));
  children.push(Actions((fitted.actions ?? []).map((a) => Button({ id: "x", label: a.label }))));
  return cardToBlockKit(Card({ title: fitted.title, children })) as Array<Record<string, any>>;
}

function slackViolations(blocks: Array<Record<string, any>>): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "header" && b.text.text.length > 150) out.push(`header ${b.text.text.length}`);
    if (b.type === "section" && b.text?.text?.length > 3000) out.push(`section ${b.text.text.length}`);
    if (b.type === "actions") for (const e of b.elements) if (e.text?.text?.length > 75) out.push(`button ${e.text.text.length}`);
  }
  return out;
}

describe("fitCardToProviderLimits", () => {
  it("reproduces the rejected card: unfitted, Slack's header limit is exceeded", () => {
    expect(slackViolations(slackBlocks(card()))).toEqual(["header 684"]);
  });

  it("fits the rejected card within Slack limits without losing any of the prompt", () => {
    const fitted = fitCardToProviderLimits(card(), "slack");
    expect(slackViolations(slackBlocks(fitted))).toEqual([]);
    expect(fitted.title).toBe("You asked us to record contact details of community post authors in the CRM.");
    expect(fitted.body).toBe(REJECTED_PROMPT);
  });

  it("keeps an existing body below the moved prompt", () => {
    const fitted = fitCardToProviderLimits(card({ body: "Details here." }), "slack");
    expect(fitted.body).toBe(`${REJECTED_PROMPT}\n\nDetails here.`);
  });

  it("leaves a card that already fits untouched", () => {
    const short = card({ title: "Publish the release now?", body: "Accepted" });
    expect(fitCardToProviderLimits(short, "slack")).toEqual(short);
  });

  it("shortens an over-long body and button label to Slack's limits", () => {
    const fitted = fitCardToProviderLimits(
      card({ title: "Approve?", body: "word ".repeat(1000), actions: [{ type: "callback", actionId: "a", label: "x".repeat(90) }] }),
      "slack",
    );
    expect(slackViolations(slackBlocks(fitted))).toEqual([]);
    expect(fitted.body).toMatch(/full text is on the Paperclip task\)$/);
    expect(fitted.actions?.[0]?.label.length).toBe(75);
  });

  it("uses a hard cut when the first sentence has no boundary in range", () => {
    const fitted = fitCardToProviderLimits(card({ title: "y".repeat(400) }), "slack");
    expect(fitted.title.length).toBe(150);
    expect(fitted.body).toBe("y".repeat(400));
  });

  it("applies Discord's larger limits and leaves providers without limits alone", () => {
    expect(fitCardToProviderLimits(card({ title: "z".repeat(200) }), "discord").title.length).toBe(200);
    expect(fitCardToProviderLimits(card({ title: "z".repeat(300) }), "discord").title.length).toBe(256);
    expect(fitCardToProviderLimits(card(), "microsoft-teams")).toEqual(card());
  });
});

describe("shortenText", () => {
  it("never exceeds the limit", () => {
    for (const n of [10, 75, 150]) expect(shortenText("lorem ipsum ".repeat(50), n).length).toBeLessThanOrEqual(n);
  });
});

describe("isDefiniteCardRejection", () => {
  const slackError = { code: "slack_webapi_platform_error", data: { ok: false, error: "invalid_blocks" } };
  it("recognises Slack's structured invalid_blocks, including when wrapped", () => {
    expect(isDefiniteCardRejection(slackError, "slack")).toBe(true);
    expect(isDefiniteCardRejection({ cause: { original: slackError } }, "slack")).toBe(true);
  });
  it("does not treat other failures, text-only matches or other providers as rejections", () => {
    expect(isDefiniteCardRejection({ data: { error: "ratelimited" } }, "slack")).toBe(false);
    expect(isDefiniteCardRejection(new Error("An API error occurred: invalid_blocks"), "slack")).toBe(false);
    expect(isDefiniteCardRejection(slackError, "discord")).toBe(false);
  });
});

describe("cardAsPlainText", () => {
  it("carries the card's words and the link text", () => {
    expect(cardAsPlainText(card({ title: "T", body: "B" }), "Open the task")).toBe("T\n\nB\n\nOpen the task");
  });
});

describe("cardTitleAndBody", () => {
  it("keeps a title that fits the stored limit", () => {
    expect(cardTitleAndBody("Publish the release now?", "Release check", "d")).toEqual({ title: "Publish the release now?", body: "d" });
  });
  it("moves a long prompt into the body under the interaction's own title", () => {
    expect(cardTitleAndBody(REJECTED_PROMPT, "Confirm contact scope", undefined)).toEqual({ title: "Confirm contact scope", body: REJECTED_PROMPT });
    expect(cardTitleAndBody(REJECTED_PROMPT, "Confirm contact scope", "More")).toEqual({ title: "Confirm contact scope", body: `${REJECTED_PROMPT}\n\nMore` });
  });
  it("derives a heading when there is no usable title", () => {
    const out = cardTitleAndBody(REJECTED_PROMPT, null, undefined);
    expect(out.title).toBe("You asked us to record contact details of community post authors in the CRM.");
    expect(out.body).toBe(REJECTED_PROMPT);
  });
});
