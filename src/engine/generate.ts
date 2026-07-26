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

  // Even the fallback has to honour what each service promises, and a Full
  // Reviewer must never come out thinner than a Quick Reviewer on the same
  // input. A Quick Reviewer covers ONE topic from every angle — given a list it
  // right-sizes rather than ballooning. A Full Reviewer expands per topic, so
  // it scales with the breadth of the subject.
  const sections =
    kind === "full" && topics.length > 1
      ? topics.flatMap((topic) =>
          STUDY_ANGLES.slice(0, 3).map((angle) => angle(titleCase(topic))),
        )
      : STUDY_ANGLES.map((angle) => angle(title));

  return {
    title: `${title} — ${kind === "full" ? "Full" : "Quick"} Reviewer`,
    language: opts.language ?? "English",
    ataGlance: `${note} This organizes "${title}" into clear, testable pieces.`,
    sections,
    studyFirst:
      topics.length > 1
        ? topics.slice(0, 6).map((t) => `Core idea of ${titleCase(t)}`)
        : [
            `The definition of ${title}, in your own words`,
            `Why ${title} matters — what depends on it`,
            `The steps or parts of ${title}, in order`,
            `One worked example of ${title}`,
            `The mistake you personally keep making with ${title}`,
          ],
    quickCheck: [
      { question: `In one line, what is ${title}?`, answer: "Write your answer, then check your notes." },
      { question: `Name the main parts or stages of ${title}.`, answer: "Write your answer, then check your notes." },
      { question: `Give one example of ${title} and say why it fits.`, answer: "Check your example against your material." },
      { question: `What is most often confused with ${title}? How do you tell them apart?`, answer: "Write both, side by side." },
    ],
  };
}

/**
 * The angles a single topic is studied from. Used when there is only one topic
 * to cover, so the scaffold still produces a multi-section document.
 */
const STUDY_ANGLES: ((t: string) => Reviewer["sections"][number])[] = [
  (t) => ({
    heading: `What ${t} is`,
    explanation:
      `Write a one-sentence definition of ${t} in your own words — no textbook phrasing. Then list ` +
      `the words in that sentence you could not explain to someone else, because those are the gaps ` +
      `that cost marks. Finish by naming the larger topic ${t} belongs to, so you know where it sits.`,
    memoryTrick: `If you cannot define ${t} in one breath, you do not know it yet.`,
    bullets: [
      "Write the definition from memory first, then compare it to your notes",
      "Underline any word in your definition you could not explain",
      "Name the broader topic this belongs to",
    ],
  }),
  (t) => ({
    heading: `Why ${t} matters`,
    explanation:
      `Say what ${t} is for, and what would break or change without it. Exam questions rarely ask ` +
      `you to recite a definition — they ask you to apply it, and applying it means knowing what ` +
      `job it does. Write down two situations where ${t} decides the outcome.`,
    memoryTrick: `Ask "what breaks without it?" — the answer is usually the exam question.`,
    bullets: [
      "Write two situations where this changes the result",
      "Note which other topics depend on this one",
    ],
  }),
  (t) => ({
    heading: `How ${t} works`,
    explanation:
      `Break ${t} into its parts, stages or steps and write them in order. For each step, write ` +
      `what goes in, what happens, and what comes out. If the order matters, say why — that is ` +
      `usually the part questions target. Draw it if a diagram is clearer than a sentence.`,
    memoryTrick: `Link the steps into one short story, in the order they happen.`,
    bullets: [
      "List the steps or parts in order",
      "For each: what goes in, what happens, what comes out",
      "Mark the step you are least sure about",
    ],
  }),
  (t) => ({
    heading: `A worked example of ${t}`,
    explanation:
      `Work one full example end to end, writing every step down rather than doing it in your head. ` +
      `Then change one detail and redo it — if the method survives the change, you understand it; if ` +
      `it does not, you had memorised one case rather than learned the idea.`,
    memoryTrick: `One example done twice beats ten examples read once.`,
    bullets: [
      "Do one example fully, writing every step",
      "Change one number or condition and redo it",
      "Check the answer is the type the question asked for",
    ],
  }),
  (t) => ({
    heading: `Common mistakes with ${t}`,
    explanation:
      `Write down the errors you actually make with ${t}, not generic ones — mixing it up with a ` +
      `similar topic, skipping a step, misreading the question, or using the wrong units. Then write ` +
      `the check that would have caught each one. Those checks are what you run in the exam.`,
    memoryTrick: `Every mistake you write down is one you are less likely to repeat.`,
    bullets: [
      "Name the topic this is most easily confused with, and the tell that separates them",
      "Write the check that catches your most common slip",
    ],
  }),
];

/** Study actions, rotated so consecutive scaffold sections don't read identically. */
const STUDY_ACTIONS: string[][] = [
  [
    "Write the definition in your own words, then compare it to your notes",
    "List its parts or stages in order",
    "Work through one example end to end",
  ],
  [
    "Say out loud how it works, as if teaching someone",
    "Note the one step you keep getting wrong",
    "Find a second example that looks different but follows the same rule",
  ],
  [
    "Draw or diagram it from memory, then check it",
    "Write down what must be true for it to apply",
    "Name the topic it is most easily confused with, and the tell that separates them",
  ],
  [
    "Turn the key facts into a three-column table",
    "Write one exam-style question on it, then answer it",
    "Mark anything you could not explain without looking",
  ],
];

function scaffoldSection(topic: string, index: number): Reviewer["sections"][number] {
  const t = titleCase(topic);
  return {
    heading: t,
    explanation:
      `Work through "${t}" in four passes: what it is, why it matters, how it works, and one ` +
      `worked example. Write each pass down — recalling it onto paper is what makes it stick, ` +
      `and the gaps you hit are exactly what to revise.`,
    memoryTrick: `Link the parts of ${t} into a single one-line story, in the order they happen.`,
    bullets: STUDY_ACTIONS[index % STUDY_ACTIONS.length]!,
  };
}

/**
 * Angles a learner can self-test from. Cycling these across the topics keeps the
 * fallback varied and genuinely usable — repeating one templated line twenty
 * times is worse than delivering nothing.
 */
const SELF_TEST_ANGLES: ((topic: string) => string)[] = [
  (t) => `Define ${t} in your own words, without looking at your notes.`,
  (t) => `Explain how ${t} works, step by step, as if teaching a classmate.`,
  (t) => `Give one real example of ${t} and say why it fits.`,
  (t) => `What is the most common mistake people make with ${t}, and why?`,
  (t) => `Which other topic is ${t} most easily confused with? How do you tell them apart?`,
  (t) => `List the parts or stages of ${t} in the correct order.`,
  (t) => `Why does ${t} matter — what breaks or changes if it is missing?`,
  (t) => `Write one exam-style question about ${t}, then answer it.`,
  (t) => `What must be true for ${t} to apply? Name the conditions or assumptions.`,
  (t) => `Sketch or describe ${t} from memory, then check it against your material.`,
];

function scaffoldExam(target: string, style: QuestionStyle, count: number, opts: GenOptions): MockExam {
  const t = titleCase(target);
  const n = Math.max(1, Math.min(count, 50));
  const useStyle = (style === "mixed" ? "qa" : style) as Exclude<QuestionStyle, "mixed">;
  const topics = splitTopics(target);
  const subjects = topics.length > 1 ? topics.map(titleCase) : [t];

  return {
    title: `${t} — Self-Test`,
    language: opts.language ?? "English",
    questions: Array.from({ length: n }, (_, i) => {
      // Walk angles and topics on different strides so neighbouring questions
      // differ in both what they ask and what they ask it about.
      const subject = subjects[i % subjects.length]!;
      const angle = SELF_TEST_ANGLES[i % SELF_TEST_ANGLES.length]!;
      return {
        n: i + 1,
        style: useStyle,
        prompt: angle(subject),
        ...(useStyle === "multiple_choice"
          ? { choices: ["A) …", "B) …", "C) …", "D) …"] }
          : useStyle === "true_false"
            ? { choices: ["True", "False"] }
            : {}),
        answer: "Open-ended — check your answer against your class material.",
        why: "Written prompts were unavailable, so this is a self-test question rather than a graded item.",
      };
    }),
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
