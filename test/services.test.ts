// The five paid services, end to end.
//
// No LLM key is configured (helpers.ts strips them), so every call takes the
// scaffold path — the guarantee that a paying buyer always receives a real
// file even when every free tier is down. That is what these tests pin down.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BRAND } from "../src/config.js";
import { DEFAULT_EXAM_QUESTIONS } from "../src/guards.js";
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
  it("defaults to a full 25-question paper", async () => {
    const result = await mockExam({ target: "Newton's Laws" });
    assertPdf(result.deliveries[0], "PassIt-newtons-laws-Mock-Exam.pdf");
    assert.ok(
      result.summary.startsWith(`${DEFAULT_EXAM_QUESTIONS}-question mixed practice test`),
      `unexpected summary: ${result.summary}`,
    );
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

  it("clamps an absurd count to the 3..50 range", async () => {
    const result = await mockExam({ target: "Algebra", count: 500, format: "markdown" });
    const md = assertTextFile(result.deliveries[0], "text/markdown");
    assert.ok(md.includes("Answer all 50 questions."));
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
