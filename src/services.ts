// The five PassIt services.
//
// Each takes validated input, runs the guardrails, generates content through
// the provider chain, and renders real files. Kept in one module because all
// five share the same delivery plumbing.
import {
  generateReviewer,
  generateMockExam,
  generateFlashcards,
  generateMostLikely,
  type GenOptions,
} from "./engine/generate.js";
import { verifyExam } from "./engine/verify.js";
import {
  reviewerToBlocks,
  examToBlocks,
  flashcardsToBlocks,
  reviewerToFlashcards,
  cheatSheetBlocks,
  nextStepLine,
  DISCLAIMER,
  type Block,
} from "./render/blocks.js";
import { blocksToMarkdown, flashcardsToCsv } from "./render/markdown.js";
import { blocksToPdf } from "./render/pdf.js";
import { checkRequest, clampText, LIMITS, resolveQuestionCount } from "./guards.js";
import type {
  Delivery,
  Flashcard,
  OutputFormat,
  QuestionStyle,
  Reviewer,
  ServiceId,
  ServiceResult,
} from "./types.js";

// ─── Inputs ──────────────────────────────────────────────────────────

export interface ReviewerInput {
  topic: string;
  materials?: string;
  format?: OutputFormat;
  language?: string;
}

export interface MockExamInput {
  target: string;
  style?: QuestionStyle;
  count?: number;
  materials?: string;
  format?: "pdf" | "markdown";
  language?: string;
}

export interface ExplainInput {
  problem: string;
  materials?: string;
  format?: "pdf" | "markdown";
  language?: string;
}

export interface ExamPackInput {
  exam: string;
  topics?: string;
  materials?: string;
  format?: "pdf" | "markdown";
  language?: string;
}

// ─── Services ────────────────────────────────────────────────────────

export async function quickReviewer(input: ReviewerInput): Promise<ServiceResult> {
  const topic = clampText(input.topic, LIMITS.topicMaxChars);
  const guard = checkRequest(topic, input.materials);
  if (!guard.allowed) return declined(guard.message!);

  const opts = genOpts(input.materials, input.language, "quick_reviewer");
  const { value, servedBy } = await generateReviewer("quick", topic, opts);
  return deliverReviewer(value, "quick_reviewer", input.format ?? "pdf", topic, servedBy);
}

export async function fullReviewer(input: ReviewerInput): Promise<ServiceResult> {
  const subject = clampText(input.topic, LIMITS.topicMaxChars);
  const guard = checkRequest(subject, input.materials);
  if (!guard.allowed) return declined(guard.message!);

  const opts = genOpts(input.materials, input.language, "full_reviewer");
  const { value, servedBy } = await generateReviewer("full", subject, opts);
  return deliverReviewer(value, "full_reviewer", input.format ?? "pdf", subject, servedBy);
}

export async function explainThis(input: ExplainInput): Promise<ServiceResult> {
  const problem = clampText(input.problem, LIMITS.problemMaxChars);
  const guard = checkRequest(problem, input.materials);
  if (!guard.allowed) return declined(guard.message!);

  const opts = genOpts(input.materials, input.language, "explain_this");
  const { value, servedBy } = await generateReviewer("explain", problem, opts);
  const blocks = reviewerToBlocks(value, "explain_this");
  const deliveries = await renderDoc(blocks, input.format ?? "pdf", slug(problem) || "explain-this", "Explain-This");
  return { summary: oneLine(value.ataGlance), deliveries, servedBy };
}

export async function mockExam(input: MockExamInput): Promise<ServiceResult> {
  const target = clampText(input.target, LIMITS.topicMaxChars);
  const guard = checkRequest(target, input.materials);
  if (!guard.allowed) return declined(guard.message!);

  const style: QuestionStyle = input.style ?? "mixed";
  const count = resolveQuestionCount(input.count);
  const opts = genOpts(input.materials, input.language, "mock_exam");

  const generated = await generateMockExam(target, style, count, opts);
  const exam = await verifyExam(generated.value, opts.deadline);

  const blocks = examToBlocks(exam, { withKey: true, serviceId: "mock_exam" });
  const deliveries = await renderDoc(blocks, input.format ?? "pdf", slug(target) || "mock-exam", "Mock-Exam");
  return {
    summary: `${exam.questions.length}-question ${style.replace("_", " ")} practice test on "${target}", with a fully explained answer key.`,
    deliveries,
    servedBy: generated.servedBy,
  };
}

export async function examPack(input: ExamPackInput): Promise<ServiceResult> {
  const exam = clampText(input.exam, LIMITS.topicMaxChars);
  const topics = input.topics ? clampText(input.topics, LIMITS.topicMaxChars) : "";
  const guard = checkRequest(exam, topics, input.materials);
  if (!guard.allowed) return declined(guard.message!);

  const subject = topics ? `${exam}: ${topics}` : exam;
  const opts = genOpts(input.materials, input.language, "exam_pack");

  // All four are independent, so they go out together rather than one after
  // another. Sequentially this was by far the slowest thing PassIt does —
  // five to nine round trips stacked end to end with the buyer watching a
  // spinner. Concurrent calls do collide on a provider's per-minute limit,
  // but the chain fails those over, which spreads the burst across providers
  // instead of queueing it behind one.
  //
  // `chunk: false` holds the reviewer to a single call: here it is one part
  // of a bundle, not the standalone 6-10 page document Full Reviewer sells.
  const [reviewer, cardsGen, mostLikely, examGen] = await Promise.all([
    generateReviewer("full", subject, { ...opts, chunk: false }),
    generateFlashcards(subject, opts),
    generateMostLikely(exam, topics || exam, opts),
    // `subject`, not `exam`: passing the bare exam name left the questions
    // roaming the whole field instead of the topics the buyer paid for.
    generateMockExam(subject, "mixed", 20, opts),
  ]);
  // The one real dependency: an exam cannot be re-solved before it exists.
  const verified = await verifyExam(examGen.value, opts.deadline);

  const cards: Flashcard[] = cardsGen.value.length
    ? cardsGen.value
    : reviewerToFlashcards(reviewer.value);

  const blocks: Block[] = [];
  blocks.push({ t: "h1", text: `${titleCase(exam)} — Exam Pack` });
  blocks.push(...reviewerToBlocks(reviewer.value, "exam_pack").filter((b) => b.t !== "h1").slice(0, -3));

  blocks.push({ t: "divider" });
  blocks.push({ t: "h2", text: "Most likely on the exam" });
  blocks.push({
    t: "p",
    text: "Study suggestions based on the topics you gave — not predictions, and not a guarantee of what will appear. Focus here first if time is short.",
  });
  blocks.push({
    t: "bullets",
    items: mostLikely.value.length
      ? mostLikely.value
      : reviewer.value.studyFirst.length
        ? reviewer.value.studyFirst
        : ["Core definitions", "Most-used formulas and rules", "Common exam traps"],
  });

  blocks.push({ t: "divider" });
  blocks.push({ t: "h2", text: "Flashcards" });
  blocks.push({ t: "table", headers: ["Prompt", "Answer"], rows: cards.map((c) => [c.front, c.back]) });

  blocks.push({ t: "divider" });
  blocks.push({ t: "h2", text: "Mock exam" });
  blocks.push(...examToBlocks(verified, { withKey: true, includeHeading: false }));

  blocks.push({ t: "divider" });
  blocks.push({ t: "callout", label: "One next step", text: nextStepLine("exam_pack") });
  blocks.push({ t: "p", text: DISCLAIMER });

  const base = slug(exam) || "exam-pack";
  const deliveries = await renderDoc(blocks, input.format ?? "pdf", base, "Exam-Pack");
  // Flashcards ride along as an importable CSV — Anki/Quizlet ready.
  deliveries.push(textFile(`PassIt-${base}-Flashcards.csv`, "text/csv", flashcardsToCsv(cards)));

  return {
    summary: `Exam Pack for "${exam}": full reviewer, ${cards.length} flashcards, priority list, and a ${verified.questions.length}-question mock exam with explained answer key.`,
    deliveries,
    servedBy: reviewer.servedBy,
  };
}

// ─── Delivery plumbing ───────────────────────────────────────────────

async function deliverReviewer(
  reviewer: Reviewer,
  serviceId: ServiceId,
  format: OutputFormat,
  topic: string,
  servedBy: string,
): Promise<ServiceResult> {
  const base = slug(topic) || serviceId;
  const label = serviceId === "full_reviewer" ? "Full-Reviewer" : "Quick-Reviewer";
  let deliveries: Delivery[];

  if (format === "flashcards") {
    const cards = reviewerToFlashcards(reviewer);
    const blocks = flashcardsToBlocks(cards, `${reviewer.title} — Flashcards`);
    deliveries = await renderDoc(blocks, "pdf", base, "Flashcards");
    deliveries.push(textFile(`PassIt-${base}-Flashcards.csv`, "text/csv", flashcardsToCsv(cards)));
  } else if (format === "cheatsheet") {
    deliveries = await renderDoc(cheatSheetBlocks(reviewer), "pdf", base, "Cheat-Sheet");
  } else {
    deliveries = await renderDoc(reviewerToBlocks(reviewer, serviceId), format, base, label);
  }

  return { summary: oneLine(reviewer.ataGlance), deliveries, servedBy };
}

async function renderDoc(
  blocks: Block[],
  format: "pdf" | "markdown" | OutputFormat,
  base: string,
  label: string,
): Promise<Delivery[]> {
  if (format === "markdown") {
    return [textFile(`PassIt-${base}-${label}.md`, "text/markdown", blocksToMarkdown(blocks))];
  }
  const bytes = await blocksToPdf(blocks);
  return [{ filename: `PassIt-${base}-${label}.pdf`, mimeType: "application/pdf", bytes }];
}

function textFile(filename: string, mimeType: string, text: string): Delivery {
  return { filename, mimeType, bytes: Buffer.from(text, "utf8") };
}

function declined(message: string): ServiceResult {
  return {
    summary: message,
    declined: true,
    deliveries: [
      textFile(
        "PassIt-Notice.md",
        "text/markdown",
        `# PassIt — a quick note\n\n${message}\n\n_${DISCLAIMER}_\n`,
      ),
    ],
  };
}

/**
 * How long a service may spend talking to providers before it gives up and
 * delivers what it has.
 *
 * A buyer is holding an HTTP request open, and every hosting platform has a
 * gateway timeout — pass it and they get a 502 instead of the file they paid
 * for. Without a budget the provider chain can run for many minutes: five
 * providers, two attempts each, several generations per service. These caps
 * are what keep the worst case bounded and the request answerable.
 */
const TIME_BUDGET_MS: Record<ServiceId, number> = {
  explain_this: 30_000,
  quick_reviewer: 45_000,
  mock_exam: 60_000,
  // These two make several generations, but concurrently — so the budget
  // covers the slowest call plus a follow-up, not the sum of every call.
  full_reviewer: 60_000,
  exam_pack: 75_000,
};

function genOpts(
  materials: string | undefined,
  language: string | undefined,
  service: ServiceId,
): GenOptions {
  return {
    materials: materials ? clampText(materials, LIMITS.materialsMaxChars) : undefined,
    language,
    deadline: Date.now() + TIME_BUDGET_MS[service],
  };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 240);
}

function titleCase(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
}
