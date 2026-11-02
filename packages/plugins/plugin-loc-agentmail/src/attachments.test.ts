import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildRawMessage, parseAttachments, parseRawMail } from "./mime.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
// Every byte value, so a lossy decode cannot pass.
const allBytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) % 256);

describe("outbound attachments", () => {
  it("builds multipart/mixed that parses back to the same bytes and body", () => {
    const raw = buildRawMessage({
      from: { name: "Reliora", email: "info@reliora.ai" },
      to: ["ada@example.com"],
      subject: "Your agreement",
      text: "Please sign the attached agreement.",
      messageId: "abc.123@reliora.ai",
      attachments: [{ filename: "acme-dp-agreement-v1.0-DP-ABC12345.pdf", contentType: "application/pdf", bytes: allBytes }],
    });
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="paperclip-loc-agentmail-mixed-/);
    const parsed = parseRawMail(raw);
    expect(parsed.text).toBe("Please sign the attached agreement.");
    const [att, ...rest] = parseAttachments(Buffer.from(raw, "latin1"));
    expect(rest).toEqual([]);
    expect(att.filename).toBe("acme-dp-agreement-v1.0-DP-ABC12345.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(att.sha256).toBe(sha(allBytes));
    expect(att.size).toBe(allBytes.length);
  });

  it("keeps html alternatives inside the mixed message", () => {
    const raw = buildRawMessage({
      from: { email: "info@reliora.ai" },
      to: ["ada@example.com"],
      subject: "s",
      text: "plain",
      html: "<p>rich</p>",
      messageId: "x@reliora.ai",
      attachments: [{ filename: "a.pdf", contentType: "application/pdf", bytes: allBytes }],
    });
    const parsed = parseRawMail(raw);
    expect(parsed.text).toBe("plain");
    expect(parsed.html).toBe("<p>rich</p>");
    expect(parseAttachments(raw)).toHaveLength(1);
  });

  it("refuses unsafe attachment filenames and types", () => {
    const base = { from: { email: "info@reliora.ai" }, to: ["a@example.com"], subject: "s", text: "t", messageId: "m@x.io" };
    for (const filename of ["../etc/passwd", "a\r\nBcc: x@y.z.pdf", "", ".hidden.pdf"]) {
      expect(() => buildRawMessage({ ...base, attachments: [{ filename, contentType: "application/pdf", bytes: allBytes }] })).toThrow();
    }
    expect(() =>
      buildRawMessage({ ...base, attachments: [{ filename: "a.pdf", contentType: "application/pdf\r\nX: 1", bytes: allBytes }] }),
    ).toThrow();
  });
});

describe("inbound attachments", () => {
  const b64 = Buffer.from(allBytes).toString("base64").replace(/(.{76})/g, "$1\r\n");

  it("reads a Gmail-style signed reply with a PDF", () => {
    const raw = [
      "From: Ada Test <ada@example.com>",
      "To: info@reliora.ai",
      "Subject: Re: Your agreement",
      "In-Reply-To: <abc.123@reliora.ai>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="000000000000a1b2c3"',
      "",
      "--000000000000a1b2c3",
      'Content-Type: multipart/alternative; boundary="000000000000d4e5f6"',
      "",
      "--000000000000d4e5f6",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "Signed copy attached.",
      "",
      "--000000000000d4e5f6",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      "<div>Signed copy attached.</div>",
      "",
      "--000000000000d4e5f6--",
      "--000000000000a1b2c3",
      'Content-Type: application/pdf; name="acme-signed.pdf"',
      'Content-Disposition: attachment; filename="acme-signed.pdf"',
      "Content-Transfer-Encoding: base64",
      'X-Attachment-Id: f_abc',
      "",
      b64,
      "--000000000000a1b2c3--",
      "",
    ].join("\r\n");
    const parsed = parseRawMail(raw);
    expect(parsed.text.trim()).toBe("Signed copy attached.");
    expect(parsed.inReplyTo).toBe("abc.123@reliora.ai");
    const atts = parseAttachments(Buffer.from(raw, "latin1"));
    expect(atts.map((a) => [a.index, a.filename, a.contentType, a.sha256])).toEqual([
      [0, "acme-signed.pdf", "application/pdf", sha(allBytes)],
    ]);
  });

  it("decodes RFC 2231 and RFC 2047 filenames, binary and quoted-printable parts", () => {
    const binary = Buffer.from(allBytes).toString("latin1");
    const raw = [
      "From: a@example.com",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "preamble is ignored",
      "--b1",
      "Content-Type: text/plain",
      "",
      "hello",
      "--b1",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename*=utf-8''%C5%81%C3%B3d%C5%BA%20signed.pdf",
      "Content-Transfer-Encoding: binary",
      "",
      binary,
      "--b1",
      'Content-Type: application/octet-stream; name="=?UTF-8?B?w5x0ZS5wZGY=?="',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "A=3DB=\r\nC",
      "--b1--",
      "epilogue",
    ].join("\r\n");
    const atts = parseAttachments(Buffer.from(raw, "latin1"));
    expect(atts).toHaveLength(2);
    expect(atts[0].filename).toBe("Łódź signed.pdf");
    expect(atts[0].sha256).toBe(sha(allBytes));
    expect(atts[1].filename).toBe("Üte.pdf");
    expect(atts[1].bytes.toString("latin1")).toBe("A=BC");
  });

  it("finds no attachments in a plain message", () => {
    expect(parseAttachments("From: a@b.co\r\nContent-Type: text/plain\r\n\r\nhi\r\n")).toEqual([]);
  });
});
