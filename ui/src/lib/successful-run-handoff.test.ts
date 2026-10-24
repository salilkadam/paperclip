import { describe, expect, it } from "vitest";
import {
  SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION,
  isSuccessfulRunHandoffComment,
  isSuccessfulRunHandoffEscalationComment,
  successfulRunHandoffActivityTone,
} from "./successful-run-handoff";

describe("successful run handoff UI helpers", () => {
  it("matches both required and escalated production comments", () => {
    expect(isSuccessfulRunHandoffComment(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toBe(true);
    expect(isSuccessfulRunHandoffComment("## This issue still needs a next step\n\n- Source run: abc")).toBe(true);
    expect(isSuccessfulRunHandoffComment("## Successful run missing issue disposition\n\n- Source run: abc")).toBe(true);
    expect(isSuccessfulRunHandoffComment(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY)).toBe(true);
    expect(
      isSuccessfulRunHandoffComment(
        "Paperclip exhausted the bounded successful-run handoff correction for this issue, but it still has no clear next-step disposition.",
      ),
    ).toBe(true);
    expect(
      isSuccessfulRunHandoffEscalationComment(
        "Paperclip exhausted the bounded successful-run handoff correction for this issue, but it still has no clear next-step disposition.",
      ),
    ).toBe(true);
    expect(isSuccessfulRunHandoffComment("Ordinary issue comment")).toBe(false);
  });

  it("returns shared tones for required, escalated, and neutral activity", () => {
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION).className).toContain("amber");
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION).className).toContain("red");
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION).className).toContain("border");
  });
});

describe("successful-run handoff comment matching across brands", () => {
  // The server writes these bodies; the UI must recognise them whether they
  // carry the server's "Paperclip" prefix or a rebranded "Bionic" prefix.
  it.each([
    "Paperclip needs a disposition before this issue can continue.",
    "Bionic needs a disposition before this issue can continue.",
  ])("recognises the required notice %s", (body) => {
    expect(isSuccessfulRunHandoffComment(body)).toBe(true);
  });
  it.each([
    "Paperclip exhausted the bounded successful-run handoff correction after 3 attempts.",
    "Bionic exhausted the bounded successful-run handoff correction after 3 attempts.",
  ])("recognises the escalation %s", (body) => {
    expect(isSuccessfulRunHandoffEscalationComment(body)).toBe(true);
  });
});
