// Shared types for PassIt.

export type ServiceId =
  | "quick_reviewer"
  | "full_reviewer"
  | "mock_exam"
  | "explain_this"
  | "exam_pack";

/** Output formats a buyer can request. */
export type OutputFormat = "pdf" | "markdown" | "flashcards" | "cheatsheet";

export type QuestionStyle = "multiple_choice" | "qa" | "true_false" | "mixed";

/** One delivered file. */
export interface Delivery {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

// ─── Reviewer content model ──────────────────────────────────────────
// Mirrors the PassIt structure:
// ⚡ At a glance → 📖 Simple explanations → 🧠 Memory trick
// → 📊 Tables → ⭐ Study this first → 📝 Quick check

export interface KeyTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface QuickCheckItem {
  question: string;
  answer: string;
}

export interface ReviewerSection {
  heading: string;
  /** Simple explanation in everyday words. */
  explanation: string;
  /** Mnemonic or analogy. */
  memoryTrick?: string;
  table?: KeyTable;
  bullets?: string[];
}

export interface Reviewer {
  title: string;
  language: string;
  /** The whole topic in 2–4 plain lines. */
  ataGlance: string;
  sections: ReviewerSection[];
  /** Cross-topic comparison tables (Full Reviewer / Exam Pack). */
  comparisonTables?: KeyTable[];
  /** Most exam-likely items — study suggestions, never guarantees. */
  studyFirst: string[];
  quickCheck: QuickCheckItem[];
  /** Set when the model flagged something it wasn't certain about. */
  uncertainNotes?: string[];
}

// ─── Exam model ──────────────────────────────────────────────────────

export interface ExamQuestion {
  n: number;
  style: Exclude<QuestionStyle, "mixed">;
  prompt: string;
  /** Present for multiple_choice / true_false. */
  choices?: string[];
  /** MC: letter ("A"). true_false: "True"/"False". qa: short answer. */
  answer: string;
  /** One simple line explaining the answer. */
  why: string;
}

export interface MockExam {
  title: string;
  language: string;
  questions: ExamQuestion[];
}

export interface Flashcard {
  front: string;
  back: string;
}

/** What a service hands back to the transport layer. */
export interface ServiceResult {
  /** One-line human summary of what was produced. */
  summary: string;
  deliveries: Delivery[];
  /** True when the live-exam guard refused the request. */
  declined?: boolean;
  /** Which provider produced the content ("cache" / "scaffold" / provider id). */
  servedBy?: string;
  /**
   * Why the scaffold was used, when it was. Operational diagnostics only —
   * never rendered into a buyer's file, but without it a fallback is
   * indistinguishable from a timeout, a rate limit, or malformed model
   * output, and tuning the budgets becomes guesswork.
   */
  fallbackReason?: string;
}
