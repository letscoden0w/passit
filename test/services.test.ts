// The five paid services, end to end.
//
// No LLM key is configured (helpers.ts strips them), so every call takes the
// scaffold path — the guarantee that a paying buyer always receives a real
// file even when every free tier is down. That is what these tests pin down.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BRAND } from "../src/config.js";
import { DEFAULT_EXAM_QUESTIONS, LIMITS } from "../src/guards.js";
import { examPack, explainThis, fullReviewer, mockExam, quickReviewer } from "../src/services.js";
import type { ServiceResult } from "../src/types.js";
import { assertDelivered, assertPdf, assertTextFile } from "./helpers.js";

describe("every service delivers a real PDF by default", () => {
  const calls: Array<[string, () => Promise<ServiceResult>]> = [
    ["quick_reviewer", () => quickReviewer({ topic: "Photosynthesis" })],
    ["full_reviewer", () => fullReviewer({ topic: "Biology: Cells, Genetics, Evolution" })],
    ["mock_exam", () => mockExam({ target: "Newton's Laws" })],
    ["explain_this", () => explainThis({ problem: "Why does the quadratic formula work?" })],
    ["exam_pack", () => examPack({ exam: "Nursing Board Pharmacology", topics: "Antibiotics, Analgesics" })],
  ];

  for (const [id, call] of calls) {
    it(id, async () => {
      const result = await call();
      assertDelivered(result);
      assert.notEqual(result.declined, true);
      // Every provider is unavailable, so the deterministic scaffold serves it.
      assert.equal(result.servedBy, "scaffold");
      assertPdf(result.deliveries[0]);
      for (const d of result.deliveries) assert.ok(d.filename.startsWith("PassIt-"));
    });
  }
});

describe("quick_reviewer", () => {
  it("names the PDF after the topic", async () => {
    const result = await quickReviewer({ topic: "Photosynthesis" });
    assert.equal(result.deliveries.length, 1);
    assertPdf(result.deliveries[0], "PassIt-photosynthesis-Quick-Reviewer.pdf");
  });

  it("renders markdown on request", async () => {
    const result = await quickReviewer({ topic: "Newton's Laws", format: "markdown" });
    assert.equal(result.deliveries.length, 1);
    const md = assertTextFile(result.deliveries[0], "text/markdown", "PassIt-newtons-laws-Quick-Reviewer.md");
    assert.ok(md.startsWith("# "));
    assert.ok(md.includes("> **At a glance:**"));
    assert.ok(md.includes("> **One next step:** Mock Exam — 0.3 USDT"));
    assert.ok(md.trimEnd().endsWith(BRAND.disclaimer));
  });

  it("renders flashcards as a PDF plus an importable CSV", async () => {
    const result = await quickReviewer({ topic: "Cell Biology", format: "flashcards" });
    assert.equal(result.deliveries.length, 2);
    assertPdf(result.deliveries[0], "PassIt-cell-biology-Flashcards.pdf");
    const csv = assertTextFile(result.deliveries[1], "text/csv", "PassIt-cell-biology-Flashcards.csv");
    assert.ok(csv.startsWith("front,back\n"));
    assert.ok(csv.split("\n").length > 2);
  });

  it("renders a cheat sheet as a single PDF", async () => {
    const result = await quickReviewer({ topic: "Trigonometry", format: "cheatsheet" });
    assert.equal(result.deliveries.length, 1);
    assertPdf(result.deliveries[0], "PassIt-trigonometry-Cheat-Sheet.pdf");
  });

  it("falls back to the service id when the topic has no sluggable characters", async () => {
    const result = await quickReviewer({ topic: "???!!!" });
    assertPdf(result.deliveries[0], "PassIt-quick_reviewer-Quick-Reviewer.pdf");
  });

  it("accepts pasted materials", async () => {
    const result = await quickReviewer({
      topic: "Osmosis",
      materials: "Water moves from low solute to high solute across a semi-permeable membrane.",
    });
    assertDelivered(result);
    assertPdf(result.deliveries[0]);
  });
});

describe("full_reviewer", () => {
  it("names the PDF after the subject", async () => {
    const result = await fullReviewer({ topic: "Biology: Cells, Genetics, Evolution" });
    assertPdf(result.deliveries[0], "PassIt-biology-cells-genetics-evolution-Full-Reviewer.pdf");
  });

  it("covers every topic in a multi-topic subject", async () => {
    const result = await fullReviewer({ topic: "Biology: Cells, Genetics, Evolution", format: "markdown" });
    const md = assertTextFile(result.deliveries[0], "text/markdown");
    // Assert coverage, not section titles: how a topic is broken down is a
    // content decision, but every topic the buyer named must appear.
    for (const topic of ["Cells", "Genetics", "Evolution"]) {
      assert.ok(md.includes(topic), `missing topic: ${topic}`);
    }
    assert.ok(md.includes("> **One next step:** Mock Exam — 0.3 USDT"));
  });

  it("goes deeper than a quick reviewer on the same subject", async () => {
    const subject = "Biology: Cells, Genetics, Evolution";
    const [full, quick] = await Promise.all([
      fullReviewer({ topic: subject, format: "markdown" }),
      quickReviewer({ topic: subject, format: "markdown" }),
    ]);
    const fullMd = assertTextFile(full.deliveries[0], "text/markdown");
    const quickMd = assertTextFile(quick.deliveries[0], "text/markdown");
    const sections = (md: string) => (md.match(/^## /gm) ?? []).length;

    assert.ok(
      sections(fullMd) > sections(quickMd),
      `full reviewer should have more sections than quick (${sections(fullMd)} vs ${sections(quickMd)})`,
    );
    assert.ok(fullMd.length > quickMd.length, "full reviewer should be longer than quick");
  });
});

describe("mock_exam", () => {
  it("defaults to a full 25-question multiple-choice paper", async () => {
    const result = await mockExam({ target: "Newton's Laws" });
    assertPdf(result.deliveries[0], "PassIt-newtons-laws-Mock-Exam.pdf");
    // Multiple choice by default: a paper the buyer can sit and mark, not a
    // list of open prompts with nothing to choose between.
    assert.ok(
      result.summary.startsWith(`${DEFAULT_EXAM_QUESTIONS}-question multiple choice practice test`),
      `unexpected summary: ${result.summary}`,
    );
  });

  it("never offers empty placeholder options", async () => {
    // Everything here is scaffold (helpers.ts strips the keys), and the
    // scaffold has no topic knowledge, so it cannot invent three plausible
    // wrong answers. It used to emit "A) ... B) ... C) ... D) ..." anyway,
    // which advertises a multiple-choice paper that cannot be answered.
    const result = await mockExam({
      target: "Newton's Laws",
      style: "multiple_choice",
      count: 8,
      format: "markdown",
    });
    const md = assertTextFile(result.deliveries[0], "text/markdown");
    assert.equal(result.servedBy, "scaffold");
    assert.ok(!/^- [A-D]\)\s*(…|\.\.\.)?\s*$/m.test(md), "placeholder options in the paper");
    assert.ok(!md.includes("A) …"), "empty A) option rendered");
  });

  it("honours an explicit count and style, and always ships the answer key", async () => {
    const result = await mockExam({
      target: "Algebra",
      style: "multiple_choice",
      count: 5,
      format: "markdown",
    });
    const md = assertTextFile(result.deliveries[0], "text/markdown", "PassIt-algebra-Mock-Exam.md");
    assert.ok(md.includes("Answer all 5 questions."));
    assert.ok(md.includes("## Answer key"));
    assert.ok(result.summary.startsWith("5-question multiple choice practice test"));
    assert.ok(md.includes("> **One next step:** Explain This — 0.001 USDT"));
  });

  it("clamps an absurd count, and never pads the paper with repeats", async () => {
    const result = await mockExam({ target: "Algebra", count: 500, format: "markdown" });
    const md = assertTextFile(result.deliveries[0], "text/markdown");

    const asked = /Answer all (\d+) questions\./.exec(md);
    const delivered = Number(asked?.[1]);
    assert.ok(Number.isInteger(delivered), `no question count in: ${md.slice(0, 200)}`);

    // Two separate limits. The request is clamped to examQuestionsMax; the
    // scaffold is additionally capped at however many distinct prompts it can
    // build, because a shorter paper of unique questions beats a longer one
    // that repeats itself. A live provider is bound only by the first.
    assert.ok(
      delivered <= LIMITS.examQuestionsMax,
      `delivered ${delivered}, above the ${LIMITS.examQuestionsMax} maximum`,
    );
    assert.ok(delivered >= 20, `scaffold delivered only ${delivered} questions`);
    assert.equal(result.summary.startsWith(`${delivered}-question`), true);
  });
});

describe("explain_this", () => {
  it("delivers a PDF named after the problem", async () => {
    const result = await explainThis({ problem: "Why does the quadratic formula work?" });
    assert.equal(result.deliveries.length, 1);
    assertPdf(result.deliveries[0], "PassIt-why-does-the-quadratic-formula-work-Explain-This.pdf");
  });

  it("points at the Full Reviewer as its one next step", async () => {
    const result = await explainThis({ problem: "I keep mixing up mitosis and meiosis", format: "markdown" });
    const md = assertTextFile(result.deliveries[0], "text/markdown");
    assert.ok(md.includes("> **One next step:** Full Reviewer — 0.5 USDT"));
  });
});

describe("exam_pack", () => {
  it("delivers a PDF bundle plus a flashcards CSV", async () => {
    const result = await examPack({
      exam: "Nursing Board Pharmacology",
      topics: "Antibiotics, Analgesics",
    });

    assert.equal(result.deliveries.length, 2);
    assertPdf(result.deliveries[0], "PassIt-nursing-board-pharmacology-Exam-Pack.pdf");
    const csv = assertTextFile(
      result.deliveries[1],
      "text/csv",
      "PassIt-nursing-board-pharmacology-Flashcards.csv",
    );
    assert.ok(csv.startsWith("front,back\n"));

    // The CSV row count must match the flashcard count the summary advertises.
    const claimed = Number(/(\d+) flashcards/.exec(result.summary)?.[1]);
    assert.ok(Number.isInteger(claimed) && claimed > 0, `no flashcard count in: ${result.summary}`);
    assert.equal(csv.trimEnd().split("\n").length - 1, claimed);

    assert.ok(result.summary.includes("20-question mock exam with explained answer key"));
  });

  it("works without a topics list", async () => {
    const result = await examPack({ exam: "CPA Board — Taxation" });
    assert.equal(result.deliveries.length, 2);
    assertPdf(result.deliveries[0]);
    assertTextFile(result.deliveries[1], "text/csv");
  });

  it("labels priority items as suggestions, never predictions", async () => {
    const result = await examPack({ exam: "Nursing Board", topics: "Pharmacology", format: "markdown" });
    const md = assertTextFile(result.deliveries[0], "text/markdown");
    assert.ok(md.includes("## Most likely on the exam"));
    assert.ok(md.includes("not predictions"));
    assert.ok(md.includes("## Flashcards"));
    assert.ok(md.includes("## Mock exam"));
    assert.ok(md.trimEnd().endsWith(BRAND.disclaimer));
  });
});

describe("the scaffold must never look broken", () => {
  it("produces no duplicate questions, even at the maximum paper length", async () => {
    const result = await mockExam({
      target: "Microbiology: Bacteria & Viruses",
      count: LIMITS.examQuestionsMax,
      format: "markdown",
    });
    const md = assertTextFile(result.deliveries[0], "text/markdown");
    // Everything is scaffold here — helpers.ts strips the provider keys.
    assert.equal(result.servedBy, "scaffold");

    const questions = (md.match(/^\d+\.\s+(.+)$/gm) ?? []).map((q) =>
      q.replace(/^\d+\.\s+/, "").trim(),
    );
    assert.ok(questions.length >= 10, `only found ${questions.length} questions`);
    const unique = new Set(questions);
    assert.equal(
      unique.size,
      questions.length,
      `${questions.length - unique.size} duplicate question(s) in a ${questions.length}-question paper`,
    );
  });

  it("explains why it fell back, so a scaffold is diagnosable", async () => {
    const result = await quickReviewer({ topic: "Le Chatelier's Principle" });
    assert.equal(result.servedBy, "scaffold");
    assert.ok(result.fallbackReason, "a scaffold result must say what went wrong");
  });
});
