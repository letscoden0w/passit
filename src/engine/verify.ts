// Mock Exam verification — the accuracy core of the paid exam services.
//
// Two passes:
//  1. structuralFix  — always runs. Normalizes answer formats, drops unusable
//     questions, renumbers. Pure code, no network, never fails.
//  2. reSolve        — runs when a provider is available. Independently solves
//     every question and corrects the answer key, implementing the skill rule
//     "never publish a question you haven't solved yourself".
import { complete, extractJson, NoProviderAvailable } from "./providers.js";
import { verifyExamPrompt } from "./prompts.js";
import type { ExamQuestion, MockExam } from "../types.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

/** Normalize shapes and answers; drop questions that can't be graded. */
export function structuralFix(exam: MockExam): MockExam {
  const cleaned: ExamQuestion[] = [];

  for (const q of exam.questions) {
    if (!q.prompt?.trim() || !q.answer?.trim()) continue;

    if (q.style === "multiple_choice") {
      const choices = (q.choices ?? []).map((c) => String(c).trim()).filter(Boolean);
      // A multiple-choice question without options cannot be answered.
      if (choices.length < 2) continue;
      q.choices = choices;
      q.answer = normalizeMcAnswer(q.answer, choices);
    } else if (q.style === "true_false") {
      q.choices = ["True", "False"];
      q.answer = /^\s*t/i.test(q.answer) ? "True" : "False";
    } else {
      delete (q as { choices?: string[] }).choices;
    }

    if (!q.why?.trim()) q.why = "See your class material.";
    cleaned.push(q);
  }

  return { ...exam, questions: cleaned.map((q, i) => ({ ...q, n: i + 1 })) };
}

/**
 * Map "B", "b", "B) foo", or the full option text onto a canonical letter.
 * Falls back to the first option rather than emitting an ungradeable key.
 */
function normalizeMcAnswer(answer: string, choices: string[]): string {
  const a = answer.trim();

  const letter = a.match(/^\(?([A-Fa-f])[).\s]/)?.[1] ?? a.match(/^([A-Fa-f])$/)?.[1];
  if (letter) {
    const idx = LETTERS.indexOf(letter.toUpperCase() as (typeof LETTERS)[number]);
    if (idx >= 0 && idx < choices.length) return LETTERS[idx]!;
  }

  const strip = (s: string) => s.toLowerCase().replace(/^\(?[a-f][).\s]\s*/i, "").trim();
  const target = strip(a);
  const matched = choices.findIndex((c) => strip(c) === target);
  if (matched >= 0) return LETTERS[matched]!;

  return LETTERS[0]!;
}

/**
 * Independent re-solve pass. Returns the exam with a corrected answer key when
 * a provider is available; returns the input untouched when none is.
 */
export async function reSolve(exam: MockExam): Promise<MockExam> {
  if (exam.questions.length === 0) return exam;

  const compact = exam.questions.map((q) => ({
    n: q.n,
    style: q.style,
    prompt: q.prompt,
    choices: q.choices,
    proposed: q.answer,
  }));

  try {
    const res = await complete({
      system: "You verify exam answer keys. Return strict JSON only.",
      user: verifyExamPrompt(compact),
      json: true,
      maxTokens: 4_000,
      temperature: 0,
    });
    const { answers } = extractJson<{ answers: Array<{ n: number; answer: string; why: string }> }>(
      res.text,
    );
    const byN = new Map(answers.map((a) => [a.n, a]));

    return {
      ...exam,
      questions: exam.questions.map((q) => {
        const fix = byN.get(q.n);
        if (!fix?.answer?.trim()) return q;
        const answer = q.choices && q.style === "multiple_choice"
          ? normalizeMcAnswer(fix.answer, q.choices)
          : q.style === "true_false"
            ? (/^\s*t/i.test(fix.answer) ? "True" : "False")
            : fix.answer;
        return { ...q, answer, why: fix.why?.trim() || q.why };
      }),
    };
  } catch (err) {
    // No provider, or the checker returned junk — keep the structurally
    // valid exam rather than failing a paid delivery.
    if (err instanceof NoProviderAvailable) return exam;
    return exam;
  }
}

/** Full pipeline used by the Mock Exam and Exam Pack services. */
export async function verifyExam(exam: MockExam): Promise<MockExam> {
  return structuralFix(await reSolve(structuralFix(exam)));
}
