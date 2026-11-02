/**
 * Document templates the connector can render and attach.
 *
 * The legal text is committed source, never a tool argument: an agent passes a
 * template key and a handful of fields, and the connector renders the approved
 * text around them. Each template pins the sha256 of its source file, so an
 * edit to the text fails at load time (and in the test suite) until the pin and
 * the approval record change together.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** One field the caller supplies. */
export interface TemplateField {
  key: string;
  label: string;
  /** Hard cap after whitespace is collapsed. */
  maxLength: number;
  kind: "text" | "email" | "reference" | "timestamp";
}

/** A renderable document. */
export interface DocumentTemplate {
  key: string;
  version: string;
  title: string;
  /** Source file next to this module. */
  sourceFile: string;
  /** sha256 of the source file as approved. */
  sourceSha256: string;
  /** The section of the source that is the document body. */
  bodyStart: string;
  bodyEnd: string;
  /** Approval record for the text, printed in the PDF metadata block. */
  approval: string;
  fields: TemplateField[];
  /** The field whose value must be the one and only recipient of the email. */
  recipientField: string;
  /** Attachment filename, built from validated fields. */
  filename: (fields: Record<string, string>) => string;
}

export const TEMPLATES: Record<string, DocumentTemplate> = {
  "reliora-dp-agreement-v1.0": {
    key: "reliora-dp-agreement-v1.0",
    version: "v1.0",
    title: "Reliora Design Partner Programme Agreement",
    sourceFile: "reliora-dp-agreement-v1.0.source.md",
    sourceSha256: "76a5d7b29e3556dc58f3379afdcc07fd159e3cc2a6f7067c0c92ce6b130d3708",
    bodyStart: "## Reliora Design Partner Programme Agreement",
    bodyEnd: "\n---\n",
    approval: "CEO sign-off, Paperclip REL-5 card 26edd8da, accepted 2026-10-06; text confirmed by the CLO on REL-3326",
    fields: [
      { key: "partnerLegalName", label: "Partner (organisation legal name)", maxLength: 200, kind: "text" },
      { key: "signatoryName", label: "Signatory name", maxLength: 120, kind: "text" },
      { key: "signatoryTitle", label: "Signatory job title", maxLength: 120, kind: "text" },
      { key: "signatoryEmail", label: "Signatory email", maxLength: 254, kind: "email" },
      { key: "applicationReference", label: "Application reference", maxLength: 32, kind: "reference" },
      { key: "applicationSignedAt", label: "Application sign-off (UTC)", maxLength: 40, kind: "timestamp" },
    ],
    recipientField: "signatoryEmail",
    filename: (f) => `${slug(f.partnerLegalName)}-dp-agreement-v1.0-${f.applicationReference}.pdf`,
  },
};

/** Lower-case ASCII slug for filenames; never empty. */
export function slug(value: string): string {
  const s = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "partner";
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const EMAIL_RE = /^[^\s@"\\,]+(?:\.[^\s@"\\,]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const REFERENCE_RE = /^[A-Z]{2}-[A-Z0-9]{4,24}$/;
const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/;
/**
 * Characters that print as nothing or change how text around them reads:
 * format characters (zero-width space and joiners, word joiner, soft hyphen,
 * bidi embeddings and isolates, BOM), the combining grapheme joiner, Hangul
 * fillers and variation selectors. None belongs in a party's name on a contract.
 */
const INVISIBLE_RE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

/** Look up a template, or say which ones exist. */
export function getTemplate(key: unknown): DocumentTemplate {
  const template = typeof key === "string" ? TEMPLATES[key.trim()] : undefined;
  if (!template) {
    throw new TemplateError(`unknown document template "${String(key)}". Known: ${Object.keys(TEMPLATES).join(", ")}`);
  }
  return template;
}

/** The approved body text, verified against the pinned hash on every load. */
export function loadTemplateBody(template: DocumentTemplate): string {
  const bytes = readFileSync(new URL(`./${template.sourceFile}`, import.meta.url));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== template.sourceSha256) {
    throw new TemplateError(
      `template ${template.key}: source file hash ${sha} does not match the approved ${template.sourceSha256}; refusing to render changed legal text`,
    );
  }
  const text = bytes.toString("utf8");
  const start = text.indexOf(template.bodyStart);
  const end = start < 0 ? -1 : text.indexOf(template.bodyEnd, start);
  if (start < 0 || end < 0) throw new TemplateError(`template ${template.key}: body markers not found in the source`);
  return text.slice(start, end).trim();
}

/**
 * Validate caller fields: every field present, forced onto one line, within its
 * cap, and of the right shape. Unknown fields are refused, not ignored.
 */
export function validateFields(template: DocumentTemplate, raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TemplateError("`fields` must be an object");
  const input = raw as Record<string, unknown>;
  const known = new Set(template.fields.map((f) => f.key));
  const extra = Object.keys(input).filter((k) => !known.has(k));
  if (extra.length) throw new TemplateError(`unknown fields for ${template.key}: ${extra.join(", ")}`);
  const out: Record<string, string> = {};
  const problems: string[] = [];
  for (const field of template.fields) {
    const value = typeof input[field.key] === "string" ? (input[field.key] as string) : "";
    const invisible = [...value].find((ch) => INVISIBLE_RE.test(ch));
    if (invisible) {
      problems.push(`${field.key} contains an invisible or text-direction character (U+${invisible.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
      continue;
    }
    const oneLine = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
    if (!oneLine) {
      problems.push(`${field.key} is required`);
      continue;
    }
    if (oneLine.length > field.maxLength) {
      problems.push(`${field.key} is longer than ${field.maxLength} characters`);
      continue;
    }
    if (field.kind === "email" && !EMAIL_RE.test(oneLine)) problems.push(`${field.key} is not an email address`);
    if (field.kind === "reference" && !REFERENCE_RE.test(oneLine)) problems.push(`${field.key} must look like DP-ABC12345`);
    if (field.kind === "timestamp" && (!UTC_TIMESTAMP_RE.test(oneLine) || Number.isNaN(Date.parse(oneLine)))) {
      problems.push(`${field.key} must be a UTC ISO timestamp like 2026-11-02T09:29:19Z`);
    }
    out[field.key] = field.kind === "email" ? oneLine.toLowerCase() : oneLine;
  }
  if (problems.length) throw new TemplateError(`invalid fields for ${template.key}: ${problems.join("; ")}`);
  return out;
}
