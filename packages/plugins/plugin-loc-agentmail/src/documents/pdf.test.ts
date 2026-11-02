import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { plainWords, renderDocument, unsupportedCharacters } from "./pdf.js";
import { TEMPLATES, TemplateError, getTemplate, loadTemplateBody, validateFields } from "./templates.js";

const template = TEMPLATES["reliora-dp-agreement-v1.0"];

const fields = {
  partnerLegalName: "Example Systems Ltd",
  signatoryName: "Ada Test",
  signatoryTitle: "Head of Platform",
  signatoryEmail: "Ada@Example.com",
  applicationReference: "DP-ABC12345",
  applicationSignedAt: "2026-11-02T09:29:19.000Z",
};

async function extractText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return { text: parts.join(" ").replace(/\s+/g, " "), pages: pdf.numPages };
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);

describe("agreement template", () => {
  it("pins the CLO-approved source file", () => {
    const bytes = readFileSync(new URL("./reliora-dp-agreement-v1.0.source.md", import.meta.url));
    // The same hash the CLO recorded for REL-5 partner-agreement-v1.md on REL-3325.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "76a5d7b29e3556dc58f3379afdcc07fd159e3cc2a6f7067c0c92ce6b130d3708",
    );
    expect(template.sourceSha256).toBe("76a5d7b29e3556dc58f3379afdcc07fd159e3cc2a6f7067c0c92ce6b130d3708");
  });

  it("refuses to render when the source no longer matches the pin", () => {
    expect(() => loadTemplateBody({ ...template, sourceSha256: "0".repeat(64) })).toThrow(/refusing to render changed legal text/);
  });

  it("takes the agreement section only, not the publishing checklist", () => {
    const body = loadTemplateBody(template);
    expect(body.startsWith("## Reliora Design Partner Programme Agreement")).toBe(true);
    expect(body).toContain("**Exhibit 1");
    expect(body).not.toContain("Publishing checklist");
  });

  it("validates fields strictly", () => {
    expect(validateFields(template, fields).signatoryEmail).toBe("ada@example.com");
    expect(() => validateFields(template, { ...fields, extra: "x" })).toThrow(/unknown fields/);
    expect(() => validateFields(template, { ...fields, signatoryTitle: "" })).toThrow(/signatoryTitle is required/);
    expect(() => validateFields(template, { ...fields, signatoryEmail: "nope" })).toThrow(/not an email/);
    expect(() => validateFields(template, { ...fields, applicationReference: "x" })).toThrow(/DP-ABC12345/);
    expect(validateFields(template, { ...fields, partnerLegalName: "Acme\r\nLtd" }).partnerLegalName).toBe("Acme Ltd");
    expect(() => getTemplate("nope")).toThrow(TemplateError);
  });
});

describe("renderDocument", () => {
  it("renders every word of the approved text, the fields and the signature block", async () => {
    const f = validateFields(template, fields);
    const doc = await renderDocument(template, f);
    expect(doc.filename).toBe("example-systems-ltd-dp-agreement-v1.0-DP-ABC12345.pdf");
    expect(Buffer.from(doc.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const { text, pages } = await extractText(doc.bytes);
    expect(pages).toBe(doc.pages);

    // Round trip: the approved body's words appear in order in the extracted text.
    const extracted = words(text);
    const expected = plainWords(loadTemplateBody(template));
    let at = 0;
    const missing: string[] = [];
    for (const word of expected) {
      const found = extracted.indexOf(word, at);
      if (found < 0) missing.push(word);
      else at = found + 1;
    }
    expect(missing).toEqual([]);

    for (const v of Object.values(f)) expect(text).toContain(v);
    expect(text).toContain("Signed for and on behalf of the Partner");
    expect(text).toContain(`Page 1 of ${doc.pages}`);
    expect(text).toContain(doc.textSha256);
  });

  it("prints names with brackets, backslashes and non-Latin-1 letters exactly", async () => {
    const tricky = {
      ...fields,
      partnerLegalName: "Łódź Ağaoğlu (UK) :) Ltd \\ Ω",
      signatoryName: "Zoë Ñúñez-Øster",
    };
    const doc = await renderDocument(template, validateFields(template, tricky));
    const { text } = await extractText(doc.bytes);
    expect(text).toContain("Łódź Ağaoğlu (UK) :) Ltd \\ Ω");
    expect(text).toContain("Zoë Ñúñez-Øster");
  });

  it("refuses characters the font cannot draw instead of dropping them", async () => {
    expect(unsupportedCharacters("株式会社")).toEqual(["株", "式", "会", "社"]);
    await expect(renderDocument(template, validateFields(template, { ...fields, partnerLegalName: "株式会社 Test" }))).rejects.toThrow(
      /cannot be printed/,
    );
  });

  it("keeps a very long unbroken value on the page", async () => {
    const long = { ...fields, partnerLegalName: "A".repeat(200) };
    const doc = await renderDocument(template, validateFields(template, long));
    const { text } = await extractText(doc.bytes);
    expect(text.replace(/\s+/g, "")).toContain("A".repeat(200));
  });
});
