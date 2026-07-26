// Content generation: prompt a provider, validate the JSON, repair what can be
// repaired, and fall back to a deterministic scaffold so a paying buyer always
// receives a usable file even if every provider is down.
import { z } from "zod";
import { complete, extractJson, NoProviderAvailable } from "./providers.js";
import {
  SYSTEM,
  quickReviewerPrompt,
  fullReviewerPrompt,
  fullReviewerTopicPrompt,
  fullReviewerSynthesisPrompt,
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
  /**
   * Absolute epoch-ms cutoff for the whole service call. Threaded into every
   * provider request so a slow chain degrades to the scaffold instead of
   * holding the buyer's HTTP request open until the gateway gives up.
   */
  deadline?: number;
  /**
   * Whether a multi-topic Full Reviewer may fan out into a call per topic.
   * True for the standalone service, where depth is what the buyer bought.
   * False inside the Exam Pack, where the reviewer is one component of a
   * bundle and the extra round trips cost more than the depth is worth.
   */
  chunk?: boolean;
}

export interface Generated<T> {
  value: T;
  /** Provider id, "cache", or "scaffold". */
  servedBy: string;
  /** Set only when servedBy is "scaffold": what actually went wrong. */
  reason?: string;
}

/** Compress an error into one diagnostic line. */
function why(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  return msg.replace(/\s+/g, " ").slice(0, 300);
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

const SectionZ = z.object({
  heading: z.string().min(1),
  explanation: z.string().min(1),
  memoryTrick: z.string().optional(),
  table: TableZ.optional(),
  bullets: z.array(z.string()).optional(),
});

/** One topic's slice of a chunked Full Reviewer. */
const SectionsZ = z.object({ sections: z.array(SectionZ).min(1) });

/** The cross-topic pass over an already-written chunked Full Reviewer. */
const SynthesisZ = z.object({
  title: z.string().optional(),
  language: z.string().optional(),
  ataGlance: z.string().optional(),
  comparisonTables: z.array(TableZ).optional(),
  studyFirst: z.array(z.string()).optional(),
  quickCheck: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
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

  // Chunking a multi-topic Full Reviewer into a call per topic produced a
  // deeper document, but it turned one round trip into four or five and that
  // dominated the wall clock. Off unless explicitly asked for: a 5-page
  // reviewer delivered in seconds beats an 8-page one nobody waits for.
  if (kind === "full" && opts.chunk === true && splitTopics(input).length > 1) {
    const chunked = await generateFullReviewerChunked(input, opts);
    if (chunked) {
      if (cacheable) cacheSet(key, chunked.value);
      return chunked;
    }
    // Every topic call failed; fall through to the single-call path below.
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
    const res = await complete({ system: SYSTEM, user, json: true, maxTokens, deadline: opts.deadline });
    const value = repairReviewer(ReviewerZ.parse(extractJson(res.text)) as Reviewer, input, kind);
    if (cacheable) cacheSet(key, value);
    return { value, servedBy: res.servedBy };
  } catch (err) {
    if (!(err instanceof NoProviderAvailable)) {
      // Bad JSON / schema mismatch from an otherwise healthy provider.
      // Still better to deliver the scaffold than to fail the purchase.
      if (!(err instanceof z.ZodError) && !(err instanceof SyntaxError) && !isJsonError(err)) throw err;
    }
    return { value: scaffoldReviewer(kind, input, opts), servedBy: "scaffold", reason: why(err) };
  }
}

/**
 * Build a multi-topic Full Reviewer one topic at a time.
 *
 * A whole subject does not fit in one model response. Asking for it in a
 * single call fails two ways at once: the JSON runs past the token ceiling and
 * truncates mid-object (which lands the buyer on the scaffold), and even when
 * it does fit, the model rations its budget across every topic and returns a
 * thin section each. Per-topic calls fix both — each one is small enough for a
 * free tier's per-request ceiling and free to go to chapter depth.
 *
 * A short final call writes the cross-topic material, which is the one thing
 * the per-topic calls genuinely cannot see.
 *
 * Returns null only if every topic failed, so the caller can fall back.
 */
async function generateFullReviewerChunked(
  subject: string,
  opts: GenOptions,
): Promise<Generated<Reviewer> | null> {
  // Bounded so a pasted 12-topic syllabus cannot fan out into 12 paid calls.
  const topics = splitTopics(subject).slice(0, MAX_CHUNKED_TOPICS);

  // Topics are independent, so they go out together. Run one after another
  // they turn a Full Reviewer into four round trips of latency; run at once
  // the wall clock is the slowest single topic. Where they collide on one
  // provider's per-minute limit the chain fails them over, which spreads the
  // burst across providers instead of queueing it behind one.
  //
  // Reserve time for the synthesis call that follows.
  const topicDeadline =
    opts.deadline === undefined ? undefined : opts.deadline - SYNTHESIS_RESERVE_MS;

  const settled = await Promise.all(
    topics.map(async (topic, i) => {
      try {
        const res = await complete({
          system: SYSTEM,
          user: fullReviewerTopicPrompt(
            subject,
            topic,
            i + 1,
            topics.length,
            opts.materials,
            opts.language,
          ),
          json: true,
          maxTokens: 4_000,
          deadline: topicDeadline,
        });
        return { parsed: SectionsZ.parse(extractJson(res.text)), servedBy: res.servedBy };
      } catch (err) {
        // One weak topic must not sink the whole guide — keep the rest.
        if (!isRecoverable(err) && !(err instanceof NoProviderAvailable)) throw err;
        return null;
      }
    }),
  );

  // Keep the buyer's topic order regardless of which call finished first.
  const parts = settled.filter((r) => r !== null);
  const servedBy = parts[0]?.servedBy ?? "";
  const sections = parts.flatMap((p) => p.parsed.sections);
  if (sections.length === 0) return null;

  const reviewer: Reviewer = {
    title: titleCase(subject),
    language: opts.language || "English",
    ataGlance: "",
    sections,
    studyFirst: [],
    quickCheck: [],
  };

  // Cross-topic material. Its failure is survivable: repairReviewer fills the
  // gaps from the sections we already have rather than losing the document.
  try {
    const res = await complete({
      system: SYSTEM,
      user: fullReviewerSynthesisPrompt(
        subject,
        sections.map((s) => s.heading),
        opts.language,
      ),
      json: true,
      maxTokens: 2_500,
      deadline: opts.deadline,
    });
    const synth = SynthesisZ.parse(extractJson(res.text));
    reviewer.title = synth.title?.trim() || reviewer.title;
    reviewer.language = synth.language?.trim() || reviewer.language;
    reviewer.ataGlance = synth.ataGlance ?? "";
    reviewer.comparisonTables = synth.comparisonTables;
    reviewer.studyFirst = synth.studyFirst ?? [];
    reviewer.quickCheck = synth.quickCheck ?? [];
    reviewer.uncertainNotes = synth.uncertainNotes;
  } catch (err) {
    if (!isRecoverable(err) && !(err instanceof NoProviderAvailable)) throw err;
  }

  return { value: repairReviewer(reviewer, subject, "full"), servedBy: servedBy || "scaffold" };
}

/**
 * Upper bound on per-topic calls for one Full Reviewer. Each topic is a round
 * trip to a provider, so this is a latency budget as much as a cost one — a
 * pasted twelve-topic syllabus would otherwise take minutes to answer.
 */
const MAX_CHUNKED_TOPICS = 4;

/** Time held back from the topic calls so the cross-topic call can still run. */
const SYNTHESIS_RESERVE_MS = 15_000;

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
    const res = await complete({
      system: SYSTEM,
      user,
      json: true,
      maxTokens: 8_000,
      deadline: opts.deadline,
    });
    const parsed = MockExamZ.parse(extractJson(res.text)) as MockExam;
    parsed.questions = parsed.questions.slice(0, count).map((q, i) => ({ ...q, n: i + 1 }));
    if (cacheable) cacheSet(key, parsed);
    return { value: parsed, servedBy: res.servedBy };
  } catch (err) {
    if (!(err instanceof NoProviderAvailable) && !isRecoverable(err)) throw err;
    return { value: scaffoldExam(target, style, count, opts), servedBy: "scaffold", reason: why(err) };
  }
}

// ─── Exam Pack helpers ───────────────────────────────────────────────

export async function generateFlashcards(
  subject: string,
  opts: GenOptions = {},
): Promise<Generated<Flashcard[]>> {
  const user = flashcardsPrompt(subject, opts.materials, opts.language);
  try {
    const res = await complete({ system: SYSTEM, user, json: true, maxTokens: 4_000, deadline: opts.deadline });
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
    const res = await complete({ system: SYSTEM, user, json: true, maxTokens: 1_500, deadline: opts.deadline });
    const { items } = MostLikelyZ.parse(extractJson(res.text));
    return { value: items.slice(0, 12), servedBy: res.servedBy };
  } catch (err) {
    if (!(err instanceof NoProviderAvailable) && !isRecoverable(err)) throw err;
    return { value: [], servedBy: "scaffold" };
  }
}

// ─── Repair & fallbacks ──────────────────────────────────────────────

/** Fix up small model slips rather than failing a paid request. */
function repairReviewer(r: Reviewer, input: string, kind: ReviewerKind = "quick"): Reviewer {
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
  // A Full Reviewer spans a whole subject, so it is allowed a longer priority
  // list and self-check than a single-topic reviewer. Capping both at the
  // quick-reviewer size was silently trimming material the buyer paid for.
  const full = kind === "full";
  r.studyFirst = (r.studyFirst ?? []).filter((x) => x.trim()).slice(0, full ? 10 : 8);
  r.quickCheck = (r.quickCheck ?? []).filter((q) => q.question?.trim()).slice(0, full ? 8 : 5);
  // The chunked path writes sections first and the overview second, so an
  // overview that never arrived is backfilled rather than left blank.
  if (!r.ataGlance?.trim()) {
    r.ataGlance = `This reviewer covers ${titleCase(input)} across ${r.sections.length} sections.`;
  }
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

/**
 * Angles a learner can self-test from.
 *
 * There must be at least as many of these as the largest exam we will ever
 * scaffold, because the fallback indexes them directly: with ten angles and a
 * twenty-five question paper, questions 11-20 came out byte-identical to 1-10.
 * The scaffold is the safety net a paying buyer sees when everything else has
 * failed, so it cannot look broken.
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
  (t) => `What would a marker expect to see in a full-credit answer about ${t}?`,
  (t) => `Name a case where ${t} does NOT apply, and explain why not.`,
  (t) => `Which term inside ${t} could you not define right now? Look it up and write it down.`,
  (t) => `How would you explain ${t} to someone two years younger than you?`,
  (t) => `What comes immediately before and after ${t} in your syllabus, and how do they connect?`,
  (t) => `Turn ${t} into a diagram or flowchart, then describe it in one sentence.`,
  (t) => `What is the shortest correct answer you could give about ${t} in an exam?`,
  (t) => `Which single fact about ${t} would cost you the most marks to forget?`,
  (t) => `State ${t} as a rule, then give one exception to it.`,
  (t) => `What question about ${t} would you least like to be asked? Answer that one.`,
  (t) => `Compare ${t} with the topic you studied just before it.`,
  (t) => `Write three keywords for ${t} and a sentence linking all three.`,
  (t) => `What everyday situation does ${t} explain? Describe it.`,
  (t) => `If ${t} appeared as a 10-mark question, how would you structure the answer?`,
  (t) => `What is the single most common exam trap involving ${t}?`,
  (t) => `Where does ${t} come from — who or what established it, and why does that matter?`,
  (t) => `List everything you can recall about ${t} in two minutes, then check for gaps.`,
  (t) => `Which part of ${t} do you understand least well? Write down why.`,
  (t) => `How would you check that an answer about ${t} is actually correct?`,
  (t) => `Summarise ${t} in one sentence a marker would accept.`,
];

function scaffoldExam(target: string, style: QuestionStyle, count: number, opts: GenOptions): MockExam {
  const t = titleCase(target);
  // Never ask for more questions than there are distinct prompts to build
  // them from. A shorter paper of unique questions beats a longer one that
  // visibly repeats itself.
  // Always open-ended, whatever was asked for. The scaffold has no topic
  // knowledge, so it cannot write three plausible wrong answers — offering
  // "A) ... B) ... C) ..." placeholders would be a worse paper than an honest
  // open question, and it advertises multiple choice it cannot deliver.
  const useStyle: Exclude<QuestionStyle, "mixed"> = "qa";
  void style;
  const topics = splitTopics(target);
  const subjects = topics.length > 1 ? topics.map(titleCase) : [t];
  const n = Math.max(1, Math.min(count, SELF_TEST_ANGLES.length * subjects.length));

  return {
    title: `${t} — Self-Test`,
    language: opts.language ?? "English",
    questions: Array.from({ length: n }, (_, i) => {
      // Exhaust every angle against one subject before moving to the next, so
      // no two questions repeat until the whole cross-product is used up.
      const angle = SELF_TEST_ANGLES[i % SELF_TEST_ANGLES.length]!;
      const subject = subjects[Math.floor(i / SELF_TEST_ANGLES.length) % subjects.length]!;
      return {
        n: i + 1,
        style: useStyle,
        prompt: angle(subject),

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
  // "Biology: Cells, Genetics, Evolution" — what precedes the colon names the
  // whole subject, not the first topic. Without stripping it the first topic
  // comes back as "Biology: Cells" and every heading under it is mislabelled.
  // Only strip when the prefix is a clean label and a real list follows.
  const labelled = input.match(/^\s*([^:,;\n]{2,60}):\s*(\S[\s\S]*)$/);
  const body = labelled?.[2] ?? input;
  const topics = splitOnSeparators(body);
  return topics.length > 1 ? topics : splitOnSeparators(input);
}

function splitOnSeparators(s: string): string[] {
  return s
    .split(/[,;\n•]|\band\b/gi)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
    .slice(0, 12);
}
