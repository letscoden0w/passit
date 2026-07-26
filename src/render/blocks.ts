// A small document model. Content maps to Block[] once, then renders to both
// PDF and Markdown from the same structure — so the two never drift apart.
import { BRAND, NEXT_STEP, SERVICES } from "../config.js";
import type { Flashcard, MockExam, Reviewer, ServiceId } from "../types.js";

export type Block =
  | { t: "h1"; text: string }
  | { t: "h2"; text: string }
  | { t: "h3"; text: string }
  | { t: "p"; text: string }
  | { t: "bullets"; items: string[]; ordered?: boolean }
  | { t: "table"; headers: string[]; rows: string[][]; caption?: string }
  | { t: "callout"; label: string; text: string }
  | { t: "divider" };

export const DISCLAIMER = BRAND.disclaimer;

/** The "one next step" rule — exactly one upsell, never more. */
export function nextStepLine(id: ServiceId): string {
  const next = SERVICES[NEXT_STEP[id]];
  return `${next.title} — ${next.priceUsdt} USDT. ${firstSentence(next.description)}`;
}

export function reviewerToBlocks(r: Reviewer, serviceId: ServiceId): Block[] {
  const b: Block[] = [];
  b.push({ t: "h1", text: r.title });
  b.push({ t: "callout", label: "At a glance", text: r.ataGlance });

  for (const s of r.sections) {
    b.push({ t: "h2", text: s.heading });
    if (s.explanation) b.push({ t: "p", text: s.explanation });
    if (s.memoryTrick) b.push({ t: "callout", label: "Memory trick", text: s.memoryTrick });
    if (s.table?.headers?.length) {
      b.push({ t: "table", headers: s.table.headers, rows: s.table.rows, caption: s.table.caption });
    }
    if (s.bullets?.length) b.push({ t: "bullets", items: s.bullets });
  }

  if (r.comparisonTables?.length) {
    b.push({ t: "h2", text: "Compare and contrast" });
    for (const t of r.comparisonTables) {
      b.push({ t: "table", headers: t.headers, rows: t.rows, caption: t.caption });
    }
  }

  if (r.studyFirst.length) {
    b.push({ t: "h2", text: "Study this first" });
    b.push({ t: "bullets", items: r.studyFirst });
  }

  if (r.quickCheck.length) {
    b.push({ t: "h2", text: "Quick check" });
    b.push({ t: "bullets", items: r.quickCheck.map((q) => q.question), ordered: true });
    b.push({
      t: "callout",
      label: "Answers",
      text: r.quickCheck.map((q, i) => `${i + 1}. ${q.answer}`).join("   "),
    });
  }

  if (r.uncertainNotes?.length) {
    b.push({
      t: "callout",
      label: "Double-check these in your class material",
      text: r.uncertainNotes.join("  •  "),
    });
  }

  b.push({ t: "divider" });
  b.push({ t: "callout", label: "One next step", text: nextStepLine(serviceId) });
  b.push({ t: "p", text: DISCLAIMER });
  return b;
}

export function examToBlocks(
  e: MockExam,
  opts: { withKey: boolean; includeHeading?: boolean; serviceId?: ServiceId },
): Block[] {
  const b: Block[] = [];
  if (opts.includeHeading !== false) b.push({ t: "h1", text: e.title });
  b.push({
    t: "p",
    text: `Answer all ${e.questions.length} questions. Do not look at the answer key until you are done — it is at the end.`,
  });
  b.push({ t: "divider" });

  for (const q of e.questions) {
    b.push({ t: "p", text: `${q.n}. ${q.prompt}` });
    if (q.choices?.length) b.push({ t: "bullets", items: q.choices });
  }

  if (opts.withKey) {
    b.push({ t: "divider" });
    b.push({ t: "h2", text: "Answer key" });
    b.push({ t: "bullets", items: e.questions.map((q) => `${q.n}. ${q.answer} — ${q.why}`) });
  }

  if (opts.serviceId) {
    b.push({ t: "divider" });
    b.push({ t: "callout", label: "One next step", text: nextStepLine(opts.serviceId) });
    b.push({ t: "p", text: DISCLAIMER });
  }
  return b;
}

export function flashcardsToBlocks(cards: Flashcard[], title: string): Block[] {
  return [
    { t: "h1", text: title },
    { t: "p", text: `${cards.length} cards. Cover the right column and test yourself.` },
    { t: "table", headers: ["Prompt", "Answer"], rows: cards.map((c) => [c.front, c.back]) },
    { t: "p", text: DISCLAIMER },
  ];
}

/** Derive flashcards from a reviewer when none were generated separately. */
export function reviewerToFlashcards(r: Reviewer): Flashcard[] {
  const cards: Flashcard[] = [];
  for (const s of r.sections) {
    const back = [s.explanation, s.memoryTrick ? `Memory trick: ${s.memoryTrick}` : ""]
      .filter(Boolean)
      .join("  ");
    if (s.heading && back) cards.push({ front: s.heading, back });
  }
  for (const item of r.studyFirst) {
    cards.push({ front: `Key point: ${item}`, back: "Recall the detail from your reviewer." });
  }
  for (const q of r.quickCheck) cards.push({ front: q.question, back: q.answer });
  return cards;
}

/** One phone-screen summary per topic. */
export function cheatSheetBlocks(r: Reviewer): Block[] {
  const b: Block[] = [
    { t: "h1", text: `${r.title} — Cheat Sheet` },
    { t: "callout", label: "At a glance", text: r.ataGlance },
  ];
  const mustKnow = r.studyFirst.length ? r.studyFirst : r.sections.map((s) => s.heading);
  b.push({ t: "h2", text: "Must know" });
  b.push({ t: "bullets", items: mustKnow });

  const tricks = r.sections.filter((s) => s.memoryTrick);
  if (tricks.length) {
    b.push({ t: "h2", text: "Memory tricks" });
    b.push({ t: "bullets", items: tricks.map((s) => `${s.heading}: ${s.memoryTrick}`) });
  }
  b.push({ t: "p", text: DISCLAIMER });
  return b;
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.]+\./);
  return (m?.[0] ?? s).trim();
}
