/**
 * Render a document template to PDF.
 *
 * pdf-lib writes the file, so string escaping and text measurement are a
 * library's job, not hand-written here. The font is embedded Noto Sans (SIL
 * OFL, see ../assets/fonts/OFL.txt), so names outside Latin-1 render. Any
 * character the font cannot draw is refused before rendering: a legal document
 * must never silently drop or substitute a character.
 *
 * Supported source markup is the subset the approved text uses: one `##`
 * heading, paragraphs, `- ` bullets, `**bold**` spans and `code` spans (shown
 * as plain text).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { TemplateError, loadTemplateBody, type DocumentTemplate } from "./templates.js";

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 70;
const BODY_SIZE = 10.5;
const LINE = 15;
const FIXED_DATE = new Date("2026-01-01T00:00:00Z");

function fontBytes(name: string): Uint8Array {
  return readFileSync(new URL(`../assets/fonts/${name}`, import.meta.url));
}

interface FontSet {
  regular: Uint8Array;
  bold: Uint8Array;
  symbols: Uint8Array;
  /** The main faces draw this code point. */
  primary: (cp: number) => boolean;
  /** Some face (main or the symbol fallback) draws it. */
  coverage: (cp: number) => boolean;
}
let fontCache: FontSet | null = null;
function fonts(): FontSet {
  if (!fontCache) {
    const regular = fontBytes("NotoSans-Regular.ttf");
    const bold = fontBytes("NotoSans-Bold.ttf");
    // Noto Sans Math covers arrows and symbols the main face lacks (the approved text uses "→").
    const symbols = fontBytes("NotoSansMath-Regular.ttf");
    const r = fontkit.create(regular as Buffer);
    const b = fontkit.create(bold as Buffer);
    const m = fontkit.create(symbols as Buffer);
    const primary = (cp: number) => r.hasGlyphForCodePoint(cp) && b.hasGlyphForCodePoint(cp);
    fontCache = { regular, bold, symbols, primary, coverage: (cp) => primary(cp) || m.hasGlyphForCodePoint(cp) };
  }
  return fontCache;
}

/** Characters in `text` the embedded font cannot draw. */
export function unsupportedCharacters(text: string): string[] {
  const { coverage } = fonts();
  const bad = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x20 || cp === 0x0a) continue;
    if (!coverage(cp)) bad.add(ch);
  }
  return [...bad];
}

/** A run of text in one weight. */
interface Run {
  text: string;
  bold: boolean;
}

/** A block of the body: heading, paragraph or bullet. */
interface Block {
  kind: "heading" | "paragraph" | "bullet";
  runs: Run[];
}

/** Split `**bold**` spans; drop code backticks. */
function inlineRuns(line: string): Run[] {
  const runs: Run[] = [];
  const parts = line.replace(/`([^`]*)`/g, "$1").split("**");
  parts.forEach((part, i) => {
    if (part) runs.push({ text: part, bold: i % 2 === 1 });
  });
  return runs;
}

/** Parse the supported markup into blocks. */
export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", runs: inlineRuns(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      blocks.push({ kind: "heading", runs: [{ text: line.slice(3).trim(), bold: true }] });
    } else if (line.startsWith("- ")) {
      flush();
      blocks.push({ kind: "bullet", runs: inlineRuns(line.slice(2)) });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** The plain words of the body, in order, as a reader would see them. */
export function plainWords(body: string): string[] {
  return parseBody(body)
    .flatMap((block) => block.runs.map((run) => run.text))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Result of a render. */
export interface RenderedDocument {
  filename: string;
  bytes: Uint8Array;
  sha256: string;
  pages: number;
  /** sha256 of the approved body text, printed in the PDF. */
  textSha256: string;
  template: string;
  version: string;
}

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly symbols: PDFFont,
    readonly primary: (cp: number) => boolean,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN_TOP;
  }
  ensure(height: number) {
    if (this.y - height < MARGIN_BOTTOM) this.newPage();
  }
  /** Lay out runs as wrapped lines starting at `x`, `indent` for continuation lines. */
  runs(runs: Run[], opts: { size?: number; x?: number; gapAfter?: number } = {}) {
    const size = opts.size ?? BODY_SIZE;
    const x0 = opts.x ?? MARGIN_X;
    const width = PAGE_W - MARGIN_X - x0;
    const words: { text: string; font: PDFFont; glue?: boolean }[] = [];
    for (const run of runs) {
      const font = run.bold ? this.bold : this.regular;
      for (const piece of run.text.split(/(\s+)/)) {
        if (!piece) continue;
        if (/^\s+$/.test(piece)) {
          words.push({ text: " ", font });
          continue;
        }
        // Split a word where it changes between the main face and the symbol fallback.
        let seg = "";
        let segFont = font;
        for (const ch of piece) {
          const chFont = this.primary(ch.codePointAt(0)!) ? font : this.symbols;
          if (seg && chFont !== segFont) {
            words.push({ text: seg, font: segFont, glue: true });
            seg = "";
          }
          segFont = chFont;
          seg += ch;
        }
        if (seg) words.push({ text: seg, font: segFont });
      }
    }
    let line: { text: string; font: PDFFont }[] = [];
    let lineWidth = 0;
    const emit = () => {
      while (line.length && line[line.length - 1].text === " ") line.pop();
      this.ensure(LINE);
      let x = x0;
      for (const w of line) {
        this.page.drawText(w.text, { x, y: this.y, size, font: w.font, color: rgb(0.1, 0.1, 0.12) });
        x += w.font.widthOfTextAtSize(w.text, size);
      }
      this.y -= size * 1.43;
      line = [];
      lineWidth = 0;
    };
    for (const w of words) {
      if (w.text === " " && line.length === 0) continue;
      const wWidth = w.font.widthOfTextAtSize(w.text, size);
      if (w.text !== " " && lineWidth + wWidth > width && line.length) emit();
      if (w.text === " " && line.length === 0) continue;
      if (w.text !== " " && wWidth > width) {
        // A single token wider than the line: break it by characters so nothing runs off the page.
        let chunk = "";
        for (const ch of w.text) {
          if (w.font.widthOfTextAtSize(chunk + ch, size) > width - lineWidth && (chunk || line.length)) {
            line.push({ text: chunk, font: w.font });
            emit();
            chunk = "";
          }
          chunk += ch;
        }
        line.push({ text: chunk, font: w.font });
        lineWidth += w.font.widthOfTextAtSize(chunk, size);
        continue;
      }
      line.push(w);
      lineWidth += wWidth;
    }
    if (line.length) emit();
    this.y -= opts.gapAfter ?? 6;
  }
  rule() {
    this.ensure(10);
    this.page.drawLine({
      start: { x: MARGIN_X, y: this.y + 4 },
      end: { x: PAGE_W - MARGIN_X, y: this.y + 4 },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.65),
    });
    this.y -= 10;
  }
}

/**
 * Render the template with validated fields. Fields must already have passed
 * `validateFields`.
 */
export async function renderDocument(template: DocumentTemplate, fields: Record<string, string>): Promise<RenderedDocument> {
  const body = loadTemplateBody(template);
  const textSha256 = createHash("sha256").update(body, "utf8").digest("hex");

  const fieldText = template.fields.map((f) => fields[f.key] ?? "").join(" ");
  const badInFields = unsupportedCharacters(fieldText);
  if (badInFields.length) {
    throw new TemplateError(
      `these characters in the fields cannot be printed in the agreement font: ${badInFields.join(" ")}. Ask the partner for the name in Latin, Greek or Cyrillic script`,
    );
  }
  const badInBody = unsupportedCharacters(body);
  if (badInBody.length) {
    throw new TemplateError(`template ${template.key} uses characters the font cannot print: ${badInBody.join(" ")}`);
  }

  const { regular, bold, symbols, primary } = fonts();
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fRegular = await doc.embedFont(regular, { subset: true });
  const fBold = await doc.embedFont(bold, { subset: true });
  const fSymbols = await doc.embedFont(symbols, { subset: true });
  doc.setTitle(`${template.title} ${template.version} — ${fields.partnerLegalName}`);
  doc.setAuthor("Reliora Inc.");
  doc.setSubject(`Design Partner agreement ${template.version}, application ${fields.applicationReference}`);
  doc.setProducer("Paperclip Loc-AgentMail document renderer");
  doc.setCreator("Paperclip");
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);

  const w = new Writer(doc, fRegular, fBold, fSymbols, primary);
  w.runs([{ text: `${template.title} — ${template.version}`, bold: true }], { size: 16, gapAfter: 10 });
  w.runs([{ text: "Between Reliora Inc. (\"Reliora\") and the Partner named below.", bold: false }], { gapAfter: 10 });

  w.runs([{ text: "Partner details", bold: true }], { size: 12, gapAfter: 4 });
  for (const f of template.fields) {
    w.runs([
      { text: `${f.label}: `, bold: true },
      { text: fields[f.key], bold: false },
    ]);
  }
  w.runs([{ text: `Agreement version: ${template.version}`, bold: false }], { gapAfter: 4 });
  w.runs([{ text: `Approved text: ${template.approval}. Approved source file sha256: ${template.sourceSha256}. Agreement text sha256: ${textSha256}`, bold: false }], {
    size: 8,
    gapAfter: 10,
  });
  w.rule();

  for (const block of parseBody(body)) {
    if (block.kind === "heading") continue; // the title above already names the agreement
    if (block.kind === "bullet") {
      w.ensure(LINE);
      w.page.drawText("•", { x: MARGIN_X + 6, y: w.y, size: BODY_SIZE, font: fRegular });
      w.runs(block.runs, { x: MARGIN_X + 20, gapAfter: 3 });
    } else {
      w.runs(block.runs, { gapAfter: 7 });
    }
  }

  w.rule();
  w.ensure(LINE * 12);
  w.runs([{ text: "Signed for and on behalf of the Partner", bold: true }], { size: 12, gapAfter: 14 });
  w.runs([{ text: "To be signed by a person authorised to sign for the Partner.", bold: false }], { size: 9.5, gapAfter: 12 });
  w.runs([{ text: "Organisation: ", bold: true }, { text: fields.partnerLegalName, bold: false }], { gapAfter: 12 });
  w.runs([{ text: "Signature: ________________________________________", bold: false }], { gapAfter: 12 });
  w.runs([{ text: "Name: ________________________________________", bold: false }], { gapAfter: 12 });
  w.runs([{ text: "Job title: ____________________________________", bold: false }], { gapAfter: 12 });
  w.runs([{ text: "Date: ________________________", bold: false }], { gapAfter: 14 });
  w.runs(
    [
      {
        text: `Please sign and date this agreement and return the signed PDF by replying to the email it came with, from any address at your organisation. Reference ${fields.applicationReference}.`,
        bold: false,
      },
    ],
    { size: 9.5, gapAfter: 4 },
  );

  const total = w.pages.length;
  w.pages.forEach((page, i) => {
    const footer = `${template.title} ${template.version} · ${fields.applicationReference} · Page ${i + 1} of ${total}`;
    const size = 8;
    page.drawText(footer, {
      x: (PAGE_W - fRegular.widthOfTextAtSize(footer, size)) / 2,
      y: 36,
      size,
      font: fRegular,
      color: rgb(0.4, 0.4, 0.45),
    });
  });

  const bytes = await doc.save({ useObjectStreams: false });
  return {
    filename: template.filename(fields),
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    pages: total,
    textSha256,
    template: template.key,
    version: template.version,
  };
}
