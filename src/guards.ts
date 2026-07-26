// Guardrails from the PassIt rules: study help only, no live-exam assistance,
// no ghostwritten assignments. Enforced in code so no prompt tweak can bypass
// them, and applied before any paid generation runs.

const LIVE_EXAM_PATTERNS: RegExp[] = [
  /\bexam (is )?in progress\b/i,
  /\b(i'?m|i am|we'?re) (currently )?(taking|writing|sitting) (the|my|an) (exam|test|quiz)\b/i,
  /\btaking (the|my|an) (exam|test|quiz) (right )?now\b/i,
  /\bthis is my (real|actual|live) (exam|test)\b/i,
  /\blive exam\b/i,
  /\bduring (the|my) exam\b/i,
  /\banswer (these|this|them) (for me )?(right )?now\b.*\b(exam|test|quiz)\b/i,
  /\b(exam|test) (is )?happening now\b/i,
  /\bi have \d+ minutes left\b/i,
];

const GHOSTWRITING_PATTERNS: RegExp[] = [
  /\bwrite (my|the) (essay|assignment|homework|thesis|paper)\b/i,
  /\bsubmit (this|it) as my own\b/i,
  /\bdo my (homework|assignment)\b/i,
];

export type RefusalReason = "live_exam" | "ghostwriting";

export interface GuardResult {
  allowed: boolean;
  reason?: RefusalReason;
  message?: string;
}

export function checkRequest(...fields: (string | undefined)[]): GuardResult {
  const haystack = fields.filter(Boolean).join(" \n ");
  if (!haystack.trim()) return { allowed: true };

  if (LIVE_EXAM_PATTERNS.some((re) => re.test(haystack))) {
    return {
      allowed: false,
      reason: "live_exam",
      message:
        "PassIt is a study aid and cannot help during an exam that is happening right now. " +
        "When your exam is over, come back and I'll build you a reviewer, a mock exam, or explain anything you found hard.",
    };
  }

  if (GHOSTWRITING_PATTERNS.some((re) => re.test(haystack))) {
    return {
      allowed: false,
      reason: "ghostwriting",
      message:
        "PassIt makes study material, not work to be submitted as your own. " +
        "I can build you a reviewer or a practice test on this topic instead.",
    };
  }

  return { allowed: true };
}

// ─── Input sizing ────────────────────────────────────────────────────

export const LIMITS = {
  topicMaxChars: 500,
  materialsMaxChars: 12_000,
  problemMaxChars: 8_000,
  examQuestionsMin: 3,
  // 40 rather than 50: past roughly this length the model is writing for long
  // enough that a paper has to be re-solved as well as written inside one HTTP
  // request, and 40 questions is already a full-length exam.
  examQuestionsMax: 40,
};

export function clampText(value: string, max: number): string {
  const s = value.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Default question count: 25 — a full practice paper, not a warm-up.
 * An explicit `count` always wins, clamped to the 3..50 range.
 */
export function resolveQuestionCount(requested: number | undefined, target: string): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.max(LIMITS.examQuestionsMin, Math.min(LIMITS.examQuestionsMax, Math.trunc(requested)));
  }
  return DEFAULT_EXAM_QUESTIONS;
}

export const DEFAULT_EXAM_QUESTIONS = 25;
