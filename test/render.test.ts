// Renderers: the same Block[] becomes Markdown or PDF, and flashcards become
// an Anki/Quizlet-importable CSV.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DISCLAIMER,
  cheatSheetBlocks,
  examToBlocks,
  flashcardsToBlocks,
  reviewerToBlocks,
  reviewerToFlashcards,
  type Block,
} from "../src/render/blocks.js";
import { blocksToMarkdown, flashcardsToCsv } from "../src/render/markdown.js";
import { blocksToPdf } from "../src/render/pdf.js";
import type { MockExam, Reviewer } from "../src/types.js";
import { PDF_MAGIC, pdfMagic } from "./helpers.js";

const REVIEWER: Reviewer = {
  title: "Photosynthesis",
  language: "English",
  ataGlance: "Plants turn light, water and CO2 into sugar and oxygen.",
  sections: [
    {
      heading: "Light-dependent reactions",
      explanation: "Happen in the thylakoid membrane and produce ATP and NADPH.",
      memoryTrick: "Light hits the THYLAKOID first.",
      table: { caption: "Stages", headers: ["Stage", "Where"], rows: [["Light", "Thylakoid"], ["Calvin", "Stroma"]] },
      bullets: ["Needs light", "Splits water"],
    },
    {
      heading: "Calvin cycle",
      explanation: "Happens in the stroma and fixes carbon into sugar.",
    },
  ],
  comparisonTables: [{ caption: "Compare", headers: ["A", "B"], rows: [["one", "two"]] }],
  studyFirst: ["Where each stage happens", "What each stage produces"],
  quickCheck: [{ question: "Where does the Calvin cycle happen?", answer: "The stroma." }],
  uncertainNotes: ["Exact ATP yields vary by textbook."],
};

const EXAM: MockExam = {
  title: "Photosynthesis — Mock Exam",
  language: "English",
  questions: [
    {
      n: 1,
      style: "multiple_choice",
      prompt: "Where do the light reactions happen?",
      choices: ["A) Stroma", "B) Thylakoid"],
      answer: "B",
      why: "The thylakoid membrane holds the photosystems.",
    },
    { n: 2, style: "qa", prompt: "Name one product of the Calvin cycle.", answer: "Glucose", why: "Carbon is fixed into sugar." },
  ],
};

describe("blocksToMarkdown", () => {
  const md = blocksToMarkdown([
    { t: "h1", text: "Photosynthesis" },
    { t: "h2", text: "Key facts" },
    { t: "h3", text: "Detail" },
    { t: "p", text: "Plants make food from light." },
    { t: "callout", label: "Memory trick", text: "Light hits the thylakoid first." },
    { t: "bullets", items: ["needs light", "splits water"] },
    { t: "bullets", items: ["first", "second"], ordered: true },
    {
      t: "table",
      caption: "Stages",
      headers: ["Stage", "Where"],
      rows: [["Light", "Thylakoid"], ["Calvin", "Stroma"]],
    },
    { t: "divider" },
  ]);

  it("emits headings at the right level", () => {
    assert.ok(md.startsWith("# Photosynthesis\n"));
    assert.ok(md.includes("\n## Key facts\n"));
    assert.ok(md.includes("\n### Detail\n"));
  });

  it("emits paragraphs, callouts, bullets and ordered lists", () => {
    assert.ok(md.includes("Plants make food from light."));
    assert.ok(md.includes("> **Memory trick:** Light hits the thylakoid first."));
    assert.ok(md.includes("- needs light\n- splits water"));
    assert.ok(md.includes("1. first\n2. second"));
    assert.ok(md.includes("\n---\n"));
  });

  it("emits a GitHub-style table with caption, header row and separator", () => {
    assert.ok(md.includes("**Stages**"));
    assert.ok(md.includes("| Stage | Where |"));
    assert.ok(md.includes("| --- | --- |"));
    assert.ok(md.includes("| Light | Thylakoid |"));
    assert.ok(md.includes("| Calvin | Stroma |"));
  });

  it("ends with a newline", () => {
    assert.ok(md.endsWith("\n"));
  });

  it("escapes pipes and flattens newlines inside table cells", () => {
    const out = blocksToMarkdown([
      { t: "table", headers: ["Sym", "Note"], rows: [["a|b", "line one\nline two"]] },
    ]);
    assert.ok(out.includes("| a\\|b | line one line two |"));
  });

  it("pads ragged rows out to the header width", () => {
    const out = blocksToMarkdown([{ t: "table", headers: ["A", "B", "C"], rows: [["only"]] }]);
    assert.ok(out.includes("| only |  |  |"));
  });

  it("handles an empty block list", () => {
    assert.equal(blocksToMarkdown([]), "\n");
  });
});

describe("flashcardsToCsv", () => {
  it("emits a front,back header", () => {
    const csv = flashcardsToCsv([{ front: "Stroma", back: "Where the Calvin cycle runs." }]);
    assert.ok(csv.startsWith("front,back\n"));
    assert.ok(csv.endsWith("\n"));
    assert.equal(csv.split("\n")[1], '"Stroma","Where the Calvin cycle runs."');
  });

  it("escapes embedded double quotes by doubling them", () => {
    const csv = flashcardsToCsv([{ front: 'He said "hi"', back: 'She said "bye"' }]);
    assert.ok(csv.includes('"He said ""hi""","She said ""bye"""'));
  });

  it("quotes cells containing commas and newlines", () => {
    const csv = flashcardsToCsv([{ front: "one, two", back: "line one\nline two" }]);
    assert.ok(csv.includes('"one, two","line one\nline two"'));
  });

  it("still emits the header for an empty deck", () => {
    assert.ok(flashcardsToCsv([]).startsWith("front,back\n"));
  });
});

describe("reviewerToBlocks", () => {
  const blocks = reviewerToBlocks(REVIEWER, "quick_reviewer");

  it("opens with the title and the at-a-glance callout", () => {
    assert.deepEqual(blocks[0], { t: "h1", text: "Photosynthesis" });
    assert.deepEqual(blocks[1], { t: "callout", label: "At a glance", text: REVIEWER.ataGlance });
  });

  it("carries every section, table, trick and the study/quick-check sections", () => {
    const md = blocksToMarkdown(blocks);
    assert.ok(md.includes("## Light-dependent reactions"));
    assert.ok(md.includes("## Calvin cycle"));
    assert.ok(md.includes("> **Memory trick:** Light hits the THYLAKOID first."));
    assert.ok(md.includes("| Stage | Where |"));
    assert.ok(md.includes("## Compare and contrast"));
    assert.ok(md.includes("## Study this first"));
    assert.ok(md.includes("## Quick check"));
    assert.ok(md.includes("Exact ATP yields vary by textbook."));
  });

  it("closes with exactly one next step and the disclaimer", () => {
    const md = blocksToMarkdown(blocks);
    assert.equal(md.split("**One next step:**").length - 1, 1);
    assert.ok(md.includes("Mock Exam — 0.3 USDT"));
    assert.ok(md.trimEnd().endsWith(DISCLAIMER));
  });
});

describe("examToBlocks", () => {
  it("prints every question, its choices and the answer key", () => {
    const md = blocksToMarkdown(examToBlocks(EXAM, { withKey: true, serviceId: "mock_exam" }));
    assert.ok(md.startsWith("# Photosynthesis — Mock Exam\n"));
    assert.ok(md.includes("Answer all 2 questions."));
    assert.ok(md.includes("1. Where do the light reactions happen?"));
    assert.ok(md.includes("- A) Stroma\n- B) Thylakoid"));
    assert.ok(md.includes("## Answer key"));
    assert.ok(md.includes("1. B — The thylakoid membrane holds the photosystems."));
    assert.ok(md.includes("2. Glucose — Carbon is fixed into sugar."));
  });

  it("omits the answer key and the heading when asked to", () => {
    const md = blocksToMarkdown(examToBlocks(EXAM, { withKey: false, includeHeading: false }));
    assert.ok(!md.includes("Answer key"));
    assert.ok(!md.includes("# Photosynthesis — Mock Exam"));
  });
});

describe("flashcards from a reviewer", () => {
  const cards = reviewerToFlashcards(REVIEWER);

  it("makes one card per section, study-first item and quick check", () => {
    assert.equal(cards.length, REVIEWER.sections.length + REVIEWER.studyFirst.length + REVIEWER.quickCheck.length);
    assert.equal(cards[0]?.front, "Light-dependent reactions");
    assert.ok(cards[0]?.back.includes("Memory trick:"));
  });

  it("renders as a two-column table", () => {
    const md = blocksToMarkdown(flashcardsToBlocks(cards, "Photosynthesis — Flashcards"));
    assert.ok(md.startsWith("# Photosynthesis — Flashcards\n"));
    assert.ok(md.includes(`${cards.length} cards.`));
    assert.ok(md.includes("| Prompt | Answer |"));
  });
});

describe("cheatSheetBlocks", () => {
  it("keeps only the must-know list and the memory tricks", () => {
    const md = blocksToMarkdown(cheatSheetBlocks(REVIEWER));
    assert.ok(md.startsWith("# Photosynthesis — Cheat Sheet\n"));
    assert.ok(md.includes("## Must know"));
    assert.ok(md.includes("## Memory tricks"));
    assert.ok(md.includes("- Where each stage happens"));
    assert.ok(!md.includes("## Quick check"));
  });
});

describe("blocksToPdf", () => {
  it("produces a real PDF from every block type", async () => {
    const blocks: Block[] = [
      { t: "h1", text: "Photosynthesis" },
      { t: "h2", text: "Stages" },
      { t: "h3", text: "Detail" },
      { t: "p", text: "Plants make food from light." },
      { t: "callout", label: "Memory trick", text: "Light hits the thylakoid first." },
      { t: "bullets", items: ["needs light", "splits water"] },
      { t: "bullets", items: ["first", "second"], ordered: true },
      { t: "table", caption: "Stages", headers: ["Stage", "Where"], rows: [["Light", "Thylakoid"]] },
      { t: "divider" },
    ];
    const bytes = await blocksToPdf(blocks);
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(pdfMagic(bytes), PDF_MAGIC);
    assert.ok(bytes.length > 1_000);
    assert.ok(bytes.subarray(-1024).toString("latin1").includes("%%EOF"));
  });

  it("survives a long table that spills onto more pages", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => [`Row ${i + 1}`, "Some reasonably long cell text here."]);
    const bytes = await blocksToPdf([
      { t: "h1", text: "Long table" },
      { t: "table", headers: ["Item", "Detail"], rows },
    ]);
    assert.equal(pdfMagic(bytes), PDF_MAGIC);
  });

  it("produces a valid PDF from no blocks at all", async () => {
    const bytes = await blocksToPdf([]);
    assert.equal(pdfMagic(bytes), PDF_MAGIC);
  });
});
