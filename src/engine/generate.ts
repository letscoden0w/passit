// Content generation: prompt a provider, validate the JSON, repair what can be
// repaired, and fall back to a deterministic scaffold so a paying buyer always
// receives a usable file even if every provider is down.
import { z } from "zod";
import { complete, extractJson, NoProviderAvailable } from "./providers.js";
import {
  SYSTEM,
  quickReviewerPrompt,
  fullReviewerPrompt,
  explainThisPrompt,
  mockExamPrompt,
  flashcardsPrompt,
  mostLikelyPrompt,
} from "./prompts.js";
import { cacheGet, cacheKey, cacheSet } from "./cache.js";
import type { Flashcard, MockExam, QuestionStyle, Reviewer } from "../types.js";

export interface GenOptions {
  materials?: string;
  language?: string;
}

export interface Generated<T> {
  value: T;
  /** Provider id, "cache", or "scaffold". */
  servedBy: string;
}

// ─── Schemas ─────────────────────────────────────────────────────────

const TableZ = z.object({
  caption: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

const ReviewerZ = z.object({
  title: z.string().min(1),
  language: z.string().default("English"),
  ataGlance: z.string().min(1),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1),
        explanation: z.string().min(1),
        memoryTrick: z.string().optional(),
        table: TableZ.optional(),
        bullets: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  comparisonTables: z.array(TableZ).optional(),
  studyFirst: z.array(z.string()).default([]),
  quickCheck: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  uncertainNotes: z.array(z.string()).optional(),
});

const MockExamZ = z.object({
  title: z.string().min(1),
  language: z.string().default("English"),
  questions: z
    .array(
      z.object({
        n: z.number(),
        style: z.enum(["multiple_choice", "qa", "true_false"]),
        prompt: z.string().min(1),
        choices: z.array(z.string()).optional(),
        answer: z.string().min(1),
        why: z.string().default(""),
      }),
    )
    .min(1),
});

const FlashcardsZ = z.object({
  cards: z.array(z.object({ front: z.string().min(1), back: z.string().min(1) })).min(1),
});

const MostLikelyZ = z.object({ items: z.array(z.string()).min(1) });

// ─── Reviewer-shaped generation ──────────────────────────────────────

export type ReviewerKind = "quick" | "full" | "explain";

export async function generateReviewer(
  kind: ReviewerKind,
  input: string,
  opts: GenOptions = {},
): Promise<Generated<Reviewer>> {
  const key = cacheKey(["reviewer", kind, input, opts.language, opts.materials ? "m" : ""]);
  // Requests carrying buyer material are never cached — the content is
  // specific to their notes and must not leak to another buyer.
  const cacheable = !opts.materials;
  if (cacheable) {
    const hit = cacheGet<Reviewer>(key);
    if (hit) return { value: hit, servedBy: "cache" };
  }

  const user =
    kind === "quick"
      ? quickReviewerPrompt(input, opts.materials, opts.language)
      : kind === "full"
        ? fullReviewerPrompt(input, opts.materials, opts.language)
        : explainThisPrompt(input, opts.materials, opts.language);

  // Explain This is priced at 0.001 USDT, so its generation is capped
  // tighter than the others — enough for a real fix, not an essay.
  const maxTokens = kind === "explain" ? 2_000 : kind === "full" ? 8_000 : 4_000;

  try {
    const res = await complete({ system: SYSTEM, user, json: true, maxTokens });
    const value = repairReviewer(ReviewerZ.parse(extractJson(res.text)) as Reviewer, input);
    if (cacheable) cacheSet(key, value);
    return { value, servedBy: res.servedBy };
  } catch (err) {
    if (!(err instanceof NoProviderAvailable)) {
      // Bad JSON / schema mismatch from an otherwise healthy provider.
      // Still better to deliver the scaffold than to fail the purchase.
      if (!(err instanceof z.ZodError) && !(err instanceof SyntaxError) && !isJsonError(err)) throw err;
    }
    return { value: scaffoldReviewer(kind, input, opts), servedBy: "scaffold" };
  }
}

// ─── Mock exam ───────────────────────────────────────────────────────

export async function generateMockExam(
  target: string,
  style: QuestionStyle,
  count: number,
  opts: GenOptions = {},
): Promise<Generated<MockExam>> {
  const key = cacheKey(["exam", target, style, count, opts.language]);
  const cacheable = !opts.materials;
  if (cacheable) {
    const hit = cacheGet<MockExam>(key);
    if (hit) return { value: hit, servedBy: "cache" };
  }

  const user = mockExamPrompt(target, style, count, opts.materials, opts.language);
  try {
    const res = await complete({ system: SYSTEM, user, json: true, maxTokens: 8_000 });
    const parsed = MockExamZ.parse(extractJson(res.text)) as MockExam;
    parsed.questions = parsed.questions.slice(0, count).map((q, i) => ({ ...q, n: i + 1 }));
    if (cacheable) cacheSet(key, parsed);
    return { value: parsed, servedBy: res.servedBy };
  } catch (err) {
    if (!(err instanceof NoProviderAvailable) && !isRecoverable(err)) throw err;
    return { value: scaffoldExam(target, style, count, opts), servedBy: "scaffold" };
  }
}

// ─── Exam Pack helpers ───────────────────────────────────────────────

export async function generateFlashcards(
  subject: string,
  opts: GenOptions = {},
): Promise<Generated<Flashcard[]>> {
  const user = flashcardsPrompt(subject, opts.materials, opts.language);
  try {
    const res = await complete({ system: SYSTEM, user, json: true, maxTokens: 4_000 });
    const { cards } = FlashcardsZ.parse(extractJson(res.text));
    return { value: cards.slice(0, 40), servedBy: res.servedBy };
  } catch (err) {
    if (!(err instanceof NoProviderAvailable) && !isRecoverable(err)) throw err;
    return { value: [], servedBy: "scaffold" };
  }
}

export async function generateMostLikely(
  exam: string,
  topics: string,
  opts: GenOptions = {},
): Promise<Generated<string[]>> {
  const user = mostLikelyPrompt(exam, topics, opts.language);
  try {
    const res = await complete({ system: SYSTEM, user, json: true, maxTokens: 1_500 });
    const { items } = MostLikelyZ.parse(extractJson(res.text));
    return { value: items.slice(0, 12), servedBy: res.servedBy };
  } catch (err) {
    if (!(err instanceof NoProviderAvailable) && !isRecoverable(err)) throw err;
    return { value: [], servedBy: "scaffold" };
  }
}

// ─── Repair & fallbacks ──────────────────────────────────────────────

/** Fix up small model slips rather than failing a paid request. */
function repairReviewer(r: Reviewer, input: string): Reviewer {
  if (!r.title.trim()) r.title = titleCase(input);
  r.sections = r.sections.filter((s) => s.heading?.trim() && s.explanation?.trim());
  if (r.sections.length === 0) {
    r.sections = [{ heading: titleCase(input), explanation: r.ataGlance }];
  }
  for (const s of r.sections) {
    if (s.table) s.table = repairTable(s.table);
  }
  if (r.comparisonTables) {
    r.comparisonTables = r.comparisonTables.map(repairTable).filter((t) => t.rows.length > 0);
  }
  r.studyFirst = (r.studyFirst ?? []).filter((x) => x.trim()).slice(0, 8);
  r.quickCheck = (r.quickCheck ?? []).filter((q) => q.question?.trim()).slice(0, 5);
  return r;
}

/** Pad/trim ragged rows so the PDF table renderer never mis-aligns cells. */
function repairTable<T extends { headers: string[]; rows: string[][] }>(t: T): T {
  const width = t.headers.length;
  t.rows = (t.rows ?? [])
    .filter((row) => Array.isArray(row) && row.some((c) => String(c ?? "").trim()))
    .map((row) => Array.from({ length: width }, (_, i) => String(row[i] ?? "")));
  return t;
}

function scaffoldReviewer(kind: ReviewerKind, input: string, opts: GenOptions): Reviewer {
  const title = titleCase(input);
  const topics = splitTopics(input);
  const note =
    "Automatic writing is temporarily unavailable, so this is a study framework built from your request rather than written content. Work through it with your class material.";

  if (kind === "explain") {
    return {
      title: "Explain This",
      language: opts.language ?? "English",
      ataGlance: `${note} Question: "${truncate(input, 160)}"`,
      sections: [
        {
          heading: "Work it through, step by step",
          explanation:
            "1) Restate the question in your own plain words. 2) List everything you are given. " +
            "3) Name the rule or formula it tests. 4) Solve one step at a time, writing each step down. " +
            "5) Check the answer against what the question actually asked.",
          memoryTrick: "RGRSC — Restate, Given, Rule, Solve, Check.",
        },
      ],
      studyFirst: ["The rule or formula this question tests", "The exact step where you got stuck"],
      quickCheck: [
        { question: "Redo it with one number changed.", answer: "Apply the same five steps." },
        { question: "Explain the rule to someone in one sentence.", answer: "If you can teach it, you know it." },
      ],
    };
  }

  const sections =
    kind === "full" && topics.length > 1
      ? topics.map(scaffoldSection)
      : [scaffoldSection(input)];

  return {
    title: `${title} — ${kind === "full" ? "Full" : "Quick"} Reviewer`,
    language: opts.language ?? "English",
    ataGlance: `${note} This organizes "${title}" into clear, testable pieces.`,
    sections,
    studyFirst: topics.slice(0, 5).map((t) => `Core idea of ${t}`),
    quickCheck: [
      { question: `In one line, what is ${title}?`, answer: "Write your answer, then check your notes." },
      { question: `Name two key parts of ${title}.`, answer: "Write your answer, then check your notes." },
    ],
  };
}

function scaffoldSection(topic: string): Reviewer["sections"][number] {
  const t = titleCase(topic);
  return {
    heading: t,
    explanation: `Break "${t}" into four parts: (1) what it is, (2) why it matters, (3) how it works, (4) one worked example.`,
    memoryTrick: `Build a one-line story that links the parts of ${t} in order.`,
    bullets: [
      "Define it in your own words",
      "List its parts",
      "Write one worked example",
      "Note the mistake you make most often",
    ],
  };
}

function scaffoldExam(target: string, style: QuestionStyle, count: number, opts: GenOptions): MockExam {
  const t = titleCase(target);
  const n = Math.max(1, Math.min(count, 50));
  const useStyle = (style === "mixed" ? "qa" : style) as Exclude<QuestionStyle, "mixed">;
  return {
    title: `${t} — Mock Exam`,
    language: opts.language ?? "English",
    questions: Array.from({ length: n }, (_, i) => ({
      n: i + 1,
      style: useStyle,
      prompt: `(${t}) Self-test #${i + 1}: state a key fact about ${t} and explain why it matters.`,
      ...(useStyle === "multiple_choice"
        ? { choices: ["A) …", "B) …", "C) …", "D) …"] }
        : useStyle === "true_false"
          ? { choices: ["True", "False"] }
          : {}),
      answer: "Check against your class material.",
      why: "Automatic writing was unavailable — this is a self-test prompt, not a graded item.",
    })),
  };
}

// ─── small helpers ───────────────────────────────────────────────────

function isJsonError(err: unknown): boolean {
  const m = (err as Error)?.message ?? "";
  return /json/i.test(m);
}

function isRecoverable(err: unknown): boolean {
  return err instanceof z.ZodError || err instanceof SyntaxError || isJsonError(err);
}

function titleCase(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80);
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

function splitTopics(input: string): string[] {
  return input
    .split(/[,;\n•]|\band\b/gi)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .slice(0, 12);
}
