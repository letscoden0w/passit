// Block[] -> a real, printable PDF.
//
// Uses pdfkit with the built-in standard fonts only: no font files to ship,
// no native dependencies, so it runs unchanged on any free host.
import PDFDocument from "pdfkit";
import { BRAND } from "../config.js";
import type { Block } from "./blocks.js";

const INK = "#111827";
const MUTED = "#6b7280";
const ACCENT = BRAND.accent; // deep blue — headings, table headers
const ACCENT_ALT = BRAND.accentAlt; // teal — memory aids only
const CALLOUT_BG = "#eff6ff"; // blue tint
const CALLOUT_ALT_BG = "#f0fdfa"; // teal tint
const RULE = "#e5e7eb";

export async function blocksToPdf(blocks: Block[], title?: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    // Generous top margin: the brand band and its rule live above it, and the
    // title needs clear air beneath the rule or the page reads as cluttered.
    margins: { top: 92, bottom: 68, left: 56, right: 56 },
    bufferPages: true,
    info: { Title: title ?? firstHeading(blocks) ?? "PassIt", Author: BRAND.name },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  // Brand band on page 1 and on every page pdfkit adds automatically.
  const header = () => drawHeader(doc);
  doc.on("pageAdded", header);
  header();

  const ensure = (needed: number) => {
    if (doc.y + needed > bottom()) doc.addPage();
  };

  for (const b of blocks) {
    switch (b.t) {
      case "h1":
        ensure(44);
        doc.moveDown(0.35);
        doc.font("Helvetica-Bold").fontSize(19).fillColor(INK)
          .text(clean(b.text), left, doc.y, { width });
        accentRule(doc, left);
        doc.moveDown(0.75);
        break;

      case "h2":
        ensure(32);
        doc.moveDown(0.85);
        doc.font("Helvetica-Bold").fontSize(13.5).fillColor(ACCENT)
          .text(clean(b.text), left, doc.y, { width });
        doc.moveDown(0.35);
        break;

      case "h3":
        ensure(26);
        doc.moveDown(0.3);
        doc.font("Helvetica-Bold").fontSize(11.5).fillColor(INK)
          .text(clean(b.text), left, doc.y, { width });
        doc.moveDown(0.15);
        break;

      case "p":
        paragraph(doc, clean(b.text), left, width, ensure);
        break;

      case "bullets":
        bullets(doc, b.items.map(clean), Boolean(b.ordered), left, width, ensure);
        break;

      case "callout":
        callout(doc, clean(b.label), clean(b.text), left, width, ensure, b.tone === "recall");
        break;

      case "table":
        table(
          doc,
          b.headers.map(clean),
          b.rows.map((r) => r.map(clean)),
          b.caption ? clean(b.caption) : undefined,
          left,
          width,
          ensure,
        );
        break;

      case "divider":
        ensure(18);
        doc.moveDown(0.3);
        doc.strokeColor(RULE).lineWidth(1)
          .moveTo(left, doc.y).lineTo(left + width, doc.y).stroke();
        doc.moveDown(0.4);
        break;
    }
  }

  drawFooters(doc);
  doc.end();
  return done;
}

// ─── block renderers ─────────────────────────────────────────────────

function paragraph(
  doc: PDFKit.PDFDocument,
  text: string,
  left: number,
  width: number,
  ensure: (n: number) => void,
) {
  if (!text) return;
  doc.font("Helvetica").fontSize(10.5).fillColor(INK);
  ensure(Math.min(doc.heightOfString(text, { width }), 110));
  doc.text(text, left, doc.y, { width, align: "left" });
  doc.moveDown(0.5);
}

function bullets(
  doc: PDFKit.PDFDocument,
  items: string[],
  ordered: boolean,
  left: number,
  width: number,
  ensure: (n: number) => void,
) {
  doc.font("Helvetica").fontSize(10.5);
  const indent = 17;
  const textWidth = width - indent;

  items.forEach((item, i) => {
    if (!item) return;
    const marker = ordered ? `${i + 1}.` : "•";
    ensure(doc.heightOfString(item, { width: textWidth }) + 4);
    const y = doc.y;
    doc.font("Helvetica-Bold").fillColor(ACCENT).text(marker, left, y, { width: indent - 4 });
    doc.font("Helvetica").fillColor(INK).text(item, left + indent, y, { width: textWidth });
    doc.moveDown(0.2);
  });
  doc.moveDown(0.35);
}

function callout(
  doc: PDFKit.PDFDocument,
  label: string,
  text: string,
  left: number,
  width: number,
  ensure: (n: number) => void,
  recall = false,
) {
  const padX = 10;
  const padY = 8;
  const inner = width - padX * 2;
  const tint = recall ? CALLOUT_ALT_BG : CALLOUT_BG;
  const ink = recall ? ACCENT_ALT : ACCENT;

  doc.font("Helvetica-Bold").fontSize(9.5);
  const labelH = doc.heightOfString(label, { width: inner });
  doc.font("Helvetica").fontSize(10.5);
  const textH = doc.heightOfString(text, { width: inner });
  const boxH = labelH + textH + padY * 2 + 2;

  ensure(boxH + 6);
  const y = doc.y;
  doc.save().roundedRect(left, y, width, boxH, 6).fill(tint).restore();
  // A left rule in the accent colour makes the block scannable even when the
  // page is printed in greyscale, where the tint all but disappears.
  doc.save().rect(left, y, 3, boxH).fill(ink).restore();
  doc.fillColor(ink).font("Helvetica-Bold").fontSize(9.5)
    .text(label, left + padX, y + padY, { width: inner });
  doc.fillColor(INK).font("Helvetica").fontSize(10.5)
    .text(text, left + padX, doc.y + 1, { width: inner });
  doc.y = y + boxH;
  doc.moveDown(0.6);
}

function table(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  caption: string | undefined,
  left: number,
  width: number,
  ensure: (n: number) => void,
) {
  const cols = headers.length;
  if (cols === 0) return;
  const colW = width / cols;
  const padX = 6;
  const padY = 5;

  if (caption) {
    ensure(20);
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(MUTED)
      .text(caption, left, doc.y, { width });
    doc.moveDown(0.15);
  }

  const rowHeight = (cells: string[], bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
    let max = 0;
    for (const c of cells) {
      const h = doc.heightOfString(c ?? "", { width: colW - padX * 2 });
      if (h > max) max = h;
    }
    return max + padY * 2;
  };

  const drawRow = (cells: string[], y: number, head: boolean): number => {
    const h = rowHeight(cells, head);
    if (head) doc.save().rect(left, y, width, h).fill(ACCENT).restore();
    doc.font(head ? "Helvetica-Bold" : "Helvetica").fontSize(9.5)
      .fillColor(head ? "#ffffff" : INK);
    cells.forEach((c, i) => {
      doc.text(c ?? "", left + i * colW + padX, y + padY, { width: colW - padX * 2 });
    });
    doc.strokeColor(RULE).lineWidth(0.5);
    doc.rect(left, y, width, h).stroke();
    for (let i = 1; i < cols; i++) {
      doc.moveTo(left + i * colW, y).lineTo(left + i * colW, y + h).stroke();
    }
    return h;
  };

  ensure(rowHeight(headers, true) + 6);
  let y = doc.y;
  y += drawRow(headers, y, true);

  for (const r of rows) {
    const cells = headers.map((_, i) => r[i] ?? "");
    const h = rowHeight(cells, false);
    // Repeat the header when a long table spills onto the next page.
    if (y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.y;
      y += drawRow(headers, y, true);
    }
    y += drawRow(cells, y, false);
  }
  doc.y = y;
  doc.moveDown(0.5);
}

// ─── chrome ──────────────────────────────────────────────────────────

function accentRule(doc: PDFKit.PDFDocument, left: number) {
  const y = doc.y + 2;
  doc.strokeColor(ACCENT).lineWidth(2).moveTo(left, y).lineTo(left + 46, y).stroke();
  doc.moveDown(0.2);
}

function drawHeader(doc: PDFKit.PDFDocument) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font("Helvetica-Bold").fontSize(12.5).fillColor(ACCENT)
    .text(BRAND.name, left, 34, { continued: true });
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`    ${BRAND.tagline}`);
  doc.strokeColor(RULE).lineWidth(1).moveTo(left, 60).lineTo(left + width, 60).stroke();
  doc.y = doc.page.margins.top;
}

function drawFooters(doc: PDFKit.PDFDocument) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const y = doc.page.height - 40;
    doc.font("Helvetica").fontSize(8).fillColor(MUTED);
    // No `align`/`width` here: pdfkit routes aligned text through the line
    // wrapper, which sees the footer sitting below the bottom margin and adds
    // a blank page for it. Position manually instead.
    doc.text("PassIt • study aid — not for use during exams", left, y, { lineBreak: false });
    const label = `Page ${i - range.start + 1} of ${range.count}`;
    doc.text(label, left + width - doc.widthOfString(label), y, { lineBreak: false });
  }
}

function firstHeading(blocks: Block[]): string | undefined {
  const h = blocks.find((b) => b.t === "h1") as { text: string } | undefined;
  return h?.text ? clean(h.text) : undefined;
}

/**
 * Strip markdown emphasis and emoji. The standard PDF fonts have no emoji
 * glyphs, and leaving them in renders as tofu boxes.
 */
function clean(s: string): string {
  return (s ?? "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu,
      "",
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
