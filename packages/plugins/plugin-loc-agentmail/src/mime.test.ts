import { describe, expect, it } from "vitest";

import {
  MimeError,
  base64Body,
  buildRawMessage,
  decodeBase64Body,
  decodeQuotedPrintableBody,
  decodeWords,
  encodeWord,
  formatAddress,
  newMessageId,
  parseAddressList,
  parseHeaderBlock,
  parseRawMail,
  requireAddress,
  requireAddressList,
} from "./mime.js";

const CRLF = "\r\n";
const FROM = { name: "Reliora Support", email: "support@reliora.ai" };

function headersOf(raw: string): Record<string, string> {
  const split = raw.indexOf(`${CRLF}${CRLF}`);
  return parseHeaderBlock(raw.slice(0, split));
}

function bodyOf(raw: string): string {
  return raw.slice(raw.indexOf(`${CRLF}${CRLF}`) + 2);
}

describe("address validation", () => {
  it("accepts ordinary addresses and rejects injected line breaks", () => {
    expect(requireAddress("support@reliora.ai")).toBe("support@reliora.ai");
    expect(() => requireAddress("a@b.example\r\nX-Forged: yes")).toThrow(MimeError);
    expect(() => requireAddress("not an address")).toThrow(MimeError);
  });

  it("accepts strings, arrays, and rejects the oversized", () => {
    expect(requireAddressList("a@b.example", "to")).toEqual(["a@b.example"]);
    expect(requireAddressList(["a@b.example", " c@d.example "], "to")).toEqual(["a@b.example", "c@d.example"]);
    expect(requireAddressList(undefined, "cc")).toEqual([]);
    expect(() => requireAddressList(["a@b.example", 42], "to")).toThrow(MimeError);
    expect(() => requireAddressList(new Array(3).fill("a@b.example"), "to", 2)).toThrow(/more than 2/);
  });
});

describe("buildRawMessage", () => {
  const base = {
    from: FROM,
    to: ["human@gmail.example"],
    subject: "Re: your invoice",
    text: "Thanks for writing in.",
    messageId: "2026abcd.1234@reliora.ai",
    date: new Date("2026-10-19T12:00:00.000Z"),
  };

  it("produces CRLF-only headers with a decodable body", () => {
    const raw = buildRawMessage(base);
    expect(raw.endsWith(CRLF)).toBe(true);
    // No bare LF anywhere: SMTP framing depends on it.
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");

    const headers = headersOf(raw);
    expect(headers.from).toBe("Reliora Support <support@reliora.ai>");
    expect(headers.to).toBe("human@gmail.example");
    expect(headers["message-id"]).toBe("<2026abcd.1234@reliora.ai>");
    expect(headers.date).toBe("Mon, 19 Oct 2026 12:00:00 GMT");
    expect(headers["mime-version"]).toBe("1.0");
    expect(headers["content-type"]).toContain("text/plain");
    expect(decodeBase64Body(bodyOf(raw))).toBe("Thanks for writing in.");
  });

  it("sends a multipart/alternative with the plain part first when html is given", () => {
    const raw = buildRawMessage({ ...base, text: "plain body", html: "<p>html body</p>" });
    const headers = headersOf(raw);
    expect(headers["content-type"]).toMatch(/^multipart\/alternative; boundary="paperclip-loc-agentmail-/);
    const parsed = parseRawMail(raw);
    expect(parsed.text).toBe("plain body");
    expect(parsed.html).toBe("<p>html body</p>");
    // text/plain must lead so plain clients never render markup.
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
  });

  it("never lets a caller set a routing or list header", () => {
    const raw = buildRawMessage({
      ...base,
      headers: {
        "List-Unsubscribe": "<mailto:unsubscribe@googlegroups.example>",
        "List-Id": "<support.reliora.ai>",
        "Return-Path": "attacker@evil.example",
        Sender: "attacker@evil.example",
        "X-Mailroom-Run": "run-1",
      },
    });
    const lowered = raw.toLowerCase();
    expect(lowered).not.toContain("list-unsubscribe");
    expect(lowered).not.toContain("list-id");
    expect(lowered).not.toContain("return-path");
    expect(lowered).not.toContain("sender:");
    expect(headersOf(raw)["x-mailroom-run"]).toBe("run-1");
    // Exactly one From and one Message-ID despite the attempt.
    expect(raw.match(/^from:/gim)).toHaveLength(1);
    expect(raw.match(/^message-id:/gim)).toHaveLength(1);
  });

  it("cannot produce a line that would terminate the SMTP transaction early", () => {
    const raw = buildRawMessage({ ...base, text: ".\n..\n.dot leading\ntrailing.\n" });
    expect(raw.split(CRLF)).not.toContain(".");
    expect(decodeBase64Body(bodyOf(raw))).toBe(".\n..\n.dot leading\ntrailing.\n");
  });

  it("keeps every header line inside the RFC 5322 limit and folds a long one", () => {
    const raw = buildRawMessage({ ...base, subject: "Réf. facture — été ☂" });
    for (const line of raw.split(CRLF)) expect(line.length).toBeLessThanOrEqual(998);
    expect(parseRawMail(raw).subject).toBe("Réf. facture — été ☂");

    const long = buildRawMessage({ ...base, subject: "word ".repeat(200) });
    const lines = long.split(CRLF);
    // A folded header continues on a whitespace-led line, never a new one.
    expect(lines.some((line) => /^[ \t]+\S/.test(line))).toBe(true);
    expect(headersOf(long).subject.startsWith("word")).toBe(true);
    expect(headersOf(long).subject).toBe("word ".repeat(200).trim());
  });

  it("threads with In-Reply-To and References, angle-bracketing bare ids", () => {
    const raw = buildRawMessage({
      ...base,
      inReplyTo: "abc123@gmail.example",
      references: ["<old@gmail.example>", "older@gmail.example"],
    });
    const headers = headersOf(raw);
    expect(headers["in-reply-to"]).toBe("<abc123@gmail.example>");
    expect(headers.references).toBe("<old@gmail.example> <older@gmail.example>");
  });

  it("rejects header injection through any field", () => {
    expect(() => buildRawMessage({ ...base, subject: "hi\r\nBcc: victim@x.example" })).toThrow(MimeError);
    expect(() => buildRawMessage({ ...base, inReplyTo: "a>\r\nX: y" })).toThrow(MimeError);
    expect(() => buildRawMessage({ ...base, messageId: "" })).toThrow(/message-id is required/);
    expect(() => buildRawMessage({ ...base, to: [] })).toThrow(/at least one recipient/);
  });

  it("adds Reply-To only when configured", () => {
    expect(headersOf(buildRawMessage(base))["reply-to"]).toBeUndefined();
    expect(headersOf(buildRawMessage({ ...base, replyTo: ["founders@reliora.ai"] }))["reply-to"]).toBe(
      "<founders@reliora.ai>",
    );
  });
});

describe("newMessageId", () => {
  it("sanitises the host part and never emits a line break", () => {
    const id = newMessageId("bad host! \r\n@evil.example");
    expect(id).toMatch(/^[\w.+-]+@[\w.-]+$/);
    expect(id).not.toMatch(/[\r\n\s]/);
    expect(new Set([newMessageId("a.example"), newMessageId("a.example")]).size).toBe(2);
  });
});

describe("base64Body", () => {
  it("folds at 76 columns", () => {
    const folded = base64Body("x".repeat(4000));
    for (const line of folded.split(CRLF)) expect(line.length).toBeLessThanOrEqual(76);
    expect(decodeBase64Body(folded)).toBe("x".repeat(4000));
  });
});

describe("inbound parsing", () => {
  const groupsRaw = [
    "Return-Path: <support+bncxyz@reliora.ai>",
    "Received: from mail.example ([203.0.113.9]) by stalwart with SMTP id ABC",
    "Delivered-To: support@agentmail.reliora.ai",
    "List-Id: <support.reliora.ai.groups.example>",
    "List-Unsubscribe: <mailto:googlegroups-manadd+1234567890+unsubscribe@googlegroups.example>",
    "From: Priya <priya@gmail.example>",
    "To: support@reliora.ai",
    "Cc: founders@reliora.ai, billing@reliora.ai",
    "Subject: =?UTF-8?B?U2l4IHBhaW50ZWQgZmxhZ3M=?=",
    "Date: Mon, 19 Oct 2026 09:14:22 +0000",
    "Message-ID: <mail-42@gmail.example>",
    "In-Reply-To: <ours-1@reliora.ai>",
    "References: <ours-1@reliora.ai> <mail-41@gmail.example>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hello=20there=2C",
    "this is =3F a quoted=2Dprintable body=2E",
    "--BOUND",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("<p>hi</p>", "utf8").toString("base64"),
    "--BOUND--",
    "",
  ].join(CRLF);

  it("reads a Google-Groups-distributed message without being fooled by it", () => {
    const parsed = parseRawMail(groupsRaw);
    // The human's address is preserved; the group's VERP envelope sender is not From.
    expect(parsed.from).toBe("priya@gmail.example");
    expect(parsed.fromName).toBe("Priya");
    expect(parsed.subject).toBe("Six painted flags");
    expect(parsed.to).toEqual(["support@reliora.ai"]);
    expect(parsed.cc).toEqual(["founders@reliora.ai", "billing@reliora.ai"]);
    expect(parsed.messageId).toBe("mail-42@gmail.example");
    expect(parsed.inReplyTo).toBe("ours-1@reliora.ai");
    expect(parsed.references).toEqual(["ours-1@reliora.ai", "mail-41@gmail.example"]);
    expect(parsed.date).toContain("2026");
    // Part bodies keep the line endings the sender used.
    expect(parsed.text).toBe("Hello there,\r\nthis is ? a quoted-printable body.");
    expect(parsed.html).toBe("<p>hi</p>");
    expect(parsed.snippet).toMatch(/^Hello there/);
  });

  it("keeps list headers out of the parsed result so no one obeys them", () => {
    const parsed = parseRawMail(groupsRaw) as unknown as Record<string, unknown>;
    const keys = Object.keys(parsed).map((key) => key.toLowerCase());
    expect(keys.some((key) => key.includes("list"))).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("unsubscribe");
  });

  it("handles a simple single-part message and a missing subject", () => {
    const raw = [
      "From: a@b.example",
      "To: support@reliora.ai",
      "Date: Mon, 19 Oct 2026 09:14:22 +0000",
      "Message-ID: <one@b.example>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body without a transfer encoding",
    ].join(CRLF);
    const parsed = parseRawMail(raw);
    expect(parsed.subject).toBe("");
    expect(parsed.text).toBe("body without a transfer encoding");
    expect(parsed.html).toBe("");
  });

  it("tolerates bare-LF servers and headerless input", () => {
    const lfOnly = "From: a@b.example\nTo: x@y.example\nSubject: bare lf\n\nbody";
    const parsed = parseRawMail(lfOnly);
    expect(parsed.subject).toBe("bare lf");
    expect(parsed.text).toBe("body");
    expect(parseRawMail("total garbage with no headers").text).toBe("total garbage with no headers");
  });
});

describe("header helpers", () => {
  it("unfolds continuation lines", () => {
    const headers = parseHeaderBlock(["Subject: one", " two", "To: a@b.example"].join(CRLF));
    expect(headers.subject).toBe("one two");
    expect(headers.to).toBe("a@b.example");
  });

  it("round-trips encoded words", () => {
    expect(encodeWord("plain ascii")).toBe("plain ascii");
    expect(decodeWords("=?UTF-8?Q?caf=C3=A9?=")).toBe("café");
    expect(decodeWords("Re: =?UTF-8?B?5oCB?=")).toBe("Re: 态");
    expect(decodeWords("leave =?bogus?X?what?= alone")).toContain("=?bogus?X?what?=");
  });

  it("parses display names with commas and quotes", () => {
    expect(parseAddressList('"Doe, John" <j@d.example>, k@e.example')).toEqual([
      { name: "Doe, John", email: "j@d.example" },
      { email: "k@e.example" },
    ]);
  });

  it("decodes quoted-printable soft line breaks and =3D itself", () => {
    expect(decodeQuotedPrintableBody("a=3Db\r\nli=\r\nne")).toBe("a=b\r\nline");
  });

  it("quotes or encodes a display name that cannot travel bare", () => {
    expect(formatAddress({ email: "a@b.example" })).toBe("a@b.example");
    expect(formatAddress({ name: "Reliora Support", email: "a@b.example" })).toBe("Reliora Support <a@b.example>");
    expect(formatAddress({ name: "Acme, Inc.", email: "a@b.example" })).toBe('"Acme, Inc." <a@b.example>');
    expect(formatAddress({ name: 'Say "hi"', email: "a@b.example" })).toBe('"Say \\"hi\\"" <a@b.example>');
    expect(formatAddress({ name: "日本語サポート", email: "a@b.example" })).toMatch(/^=\?UTF-8\?B\?.+\?= <a@b\.example>$/);
    // The quoting round-trips back through the parser.
    expect(parseAddressList('"Acme, Inc." <a@b.example>')).toEqual([{ name: "Acme, Inc.", email: "a@b.example" }]);
  });
});
