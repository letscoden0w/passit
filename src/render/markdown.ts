// Block[] -> Markdown, and flashcards -> CSV.
import type { Block } from "./blocks.js";
import type { Flashcard } from "../types.js";

export function blocksToMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case "h1":
        out.push(`# ${b.text}`);
        break;
      case "h2":
        out.push(`## ${b.text}`);
        break;
      case "h3":
        out.push(`### ${b.text}`);
        break;
      case "p":
        out.push(b.text);
        break;
      case "bullets":
        out.push(b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join("\n"));
        break;
      case "callout":
        out.push(`> **${b.label}:** ${b.text}`);
        break;
      case "table":
        out.push(tableToMarkdown(b.headers, b.rows, b.caption));
        break;
      case "divider":
        out.push("---");
        break;
    }
  }
  return `${out.join("\n\n")}\n`;
}

function tableToMarkdown(headers: string[], rows: string[][], caption?: string): string {
  const esc = (s: string) => (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = `| ${headers.map(esc).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${headers.map((_, i) => esc(r[i] ?? "")).join(" | ")} |`).join("\n");
  return [caption ? `**${caption}**` : "", head, sep, body].filter(Boolean).join("\n");
}

/** CSV that imports directly into Anki and Quizlet. */
export function flashcardsToCsv(cards: Flashcard[]): string {
  const esc = (s: string) => `"${(s ?? "").replace(/"/g, '""')}"`;
  return `front,back\n${cards.map((c) => `${esc(c.front)},${esc(c.back)}`).join("\n")}\n`;
}
