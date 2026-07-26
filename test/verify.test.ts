// Answer-key verification. structuralFix is the pass that always runs — pure
// code, no network — so it is the one an offline test can pin down exactly.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { structuralFix, verifyExam } from "../src/engine/verify.js";
import type { ExamQuestion, MockExam } from "../src/types.js";

function exam(questions: ExamQuestion[]): MockExam {
  return { title: "Cell Biology — Mock Exam", language: "English", questions };
}

const CHOICES = ["A) Nucleus", "B) Mitochondria", "C) Ribosome", "D) Golgi body"];

function mc(n: number, answer: string, choices: string[] = CHOICES): ExamQuestion {
  return { n, style: "multiple_choice", prompt: `Q${n}: which organelle?`, choices, answer, why: "because" };
}

describe("structuralFix — multiple choice answers", () => {
  it("normalizes a bare letter, a lowercase letter, a 'B) text' form and the full option text", () => {
    const fixed = structuralFix(
      exam([
        mc(1, "B"),
        mc(2, "b"),
        mc(3, "B) Mitochondria"),
        mc(4, "Mitochondria"),
      ]),
    );
    assert.equal(fixed.questions.length, 4);
    assert.deepEqual(
      fixed.questions.map((q) => q.answer),
      ["B", "B", "B", "B"],
    );
  });

  it("accepts the '(C)' and 'C.' letter forms", () => {
    const fixed = structuralFix(exam([mc(1, "(C)"), mc(2, "C. Ribosome")]));
    assert.deepEqual(
      fixed.questions.map((q) => q.answer),
      ["C", "C"],
    );
  });

  it("matches option text without its letter prefix", () => {
    const plain = ["Nucleus", "Mitochondria", "Ribosome"];
    const fixed = structuralFix(exam([mc(1, "ribosome", plain)]));
    assert.equal(fixed.questions[0]?.answer, "C");
  });

  it("falls back to the first option rather than emitting an ungradeable key", () => {
    // Neither a valid letter nor any option's text.
    const fixed = structuralFix(exam([mc(1, "Zebra"), mc(2, "F", ["A) x", "B) y", "C) z"])]));
    assert.deepEqual(
      fixed.questions.map((q) => q.answer),
      ["A", "A"],
    );
  });

  it("keeps the trimmed choice list on the question", () => {
    const fixed = structuralFix(exam([mc(1, "A", ["  A) Nucleus  ", "B) Mitochondria", "  "])]));
    assert.deepEqual(fixed.questions[0]?.choices, ["A) Nucleus", "B) Mitochondria"]);
  });
});

describe("structuralFix — unusable questions are dropped", () => {
  it("drops a multiple_choice question with fewer than 2 choices", () => {
    const fixed = structuralFix(
      exam([
        mc(1, "A", ["A) the only option"]),
        { n: 2, style: "multiple_choice", prompt: "No choices at all", answer: "A", why: "w" },
        mc(3, "B"),
      ]),
    );
    assert.equal(fixed.questions.length, 1);
    assert.equal(fixed.questions[0]?.prompt, "Q3: which organelle?");
  });

  it("drops questions with an empty prompt or an empty answer", () => {
    const fixed = structuralFix(
      exam([
        { n: 1, style: "qa", prompt: "   ", answer: "Something", why: "w" },
        { n: 2, style: "qa", prompt: "A real question", answer: "  ", why: "w" },
        { n: 3, style: "qa", prompt: "Another real question", answer: "Yes", why: "w" },
      ]),
    );
    assert.equal(fixed.questions.length, 1);
    assert.equal(fixed.questions[0]?.prompt, "Another real question");
  });

  it("returns an empty exam rather than throwing when nothing is gradeable", () => {
    const fixed = structuralFix(exam([mc(1, "A", [])]));
    assert.deepEqual(fixed.questions, []);
    assert.equal(fixed.title, "Cell Biology — Mock Exam");
  });
});

describe("structuralFix — true/false", () => {
  const cases: Array<[string, string]> = [
    ["true", "True"],
    ["True", "True"],
    ["  TRUE ", "True"],
    ["T", "True"],
    ["false", "False"],
    ["F", "False"],
    ["no", "False"],
    ["not sure", "False"],
  ];

  for (const [given, expected] of cases) {
    it(`forces ${JSON.stringify(given)} to ${expected}`, () => {
      const fixed = structuralFix(
        exam([{ n: 1, style: "true_false", prompt: "Mitochondria make ATP.", answer: given, why: "w" }]),
      );
      assert.equal(fixed.questions[0]?.answer, expected);
    });
  }

  it("always supplies the True/False choice pair", () => {
    const fixed = structuralFix(
      exam([
        { n: 1, style: "true_false", prompt: "P", choices: ["Yes", "No", "Maybe"], answer: "true", why: "w" },
        { n: 2, style: "true_false", prompt: "Q", answer: "false", why: "w" },
      ]),
    );
    assert.deepEqual(fixed.questions[0]?.choices, ["True", "False"]);
    assert.deepEqual(fixed.questions[1]?.choices, ["True", "False"]);
  });
});

describe("structuralFix — short answer and defaults", () => {
  it("strips stray choices from a qa question", () => {
    const fixed = structuralFix(
      exam([{ n: 1, style: "qa", prompt: "Define osmosis.", choices: ["A) x", "B) y"], answer: "Water moves", why: "w" }]),
    );
    assert.equal(fixed.questions[0]?.choices, undefined);
  });

  it("fills in a missing explanation", () => {
    const fixed = structuralFix(
      exam([{ n: 1, style: "qa", prompt: "Define osmosis.", answer: "Water moves", why: "   " }]),
    );
    assert.equal(fixed.questions[0]?.why, "See your class material.");
  });

  it("keeps a real explanation untouched", () => {
    const fixed = structuralFix(
      exam([{ n: 1, style: "qa", prompt: "Define osmosis.", answer: "Water moves", why: "Down the gradient." }]),
    );
    assert.equal(fixed.questions[0]?.why, "Down the gradient.");
  });
});

describe("structuralFix — numbering", () => {
  it("renumbers questions sequentially from 1", () => {
    const fixed = structuralFix(
      exam([
        { n: 7, style: "qa", prompt: "First", answer: "a", why: "w" },
        { n: 3, style: "qa", prompt: "Second", answer: "b", why: "w" },
        { n: 99, style: "qa", prompt: "Third", answer: "c", why: "w" },
      ]),
    );
    assert.deepEqual(
      fixed.questions.map((q) => q.n),
      [1, 2, 3],
    );
    assert.deepEqual(
      fixed.questions.map((q) => q.prompt),
      ["First", "Second", "Third"],
    );
  });

  it("closes the gap left by a dropped question", () => {
    const fixed = structuralFix(
      exam([
        { n: 1, style: "qa", prompt: "Keep me", answer: "a", why: "w" },
        mc(2, "A", ["A) lonely"]),
        { n: 3, style: "qa", prompt: "Keep me too", answer: "c", why: "w" },
      ]),
    );
    assert.deepEqual(
      fixed.questions.map((q) => q.n),
      [1, 2],
    );
  });

  it("is idempotent", () => {
    const once = structuralFix(exam([mc(1, "b"), { n: 2, style: "true_false", prompt: "P", answer: "yes", why: "" }]));
    const twice = structuralFix(once);
    assert.deepEqual(twice, once);
  });
});

describe("verifyExam", () => {
  it("returns a structurally valid exam with no provider available", async () => {
    const out = await verifyExam(
      exam([
        mc(4, "b"),
        { n: 9, style: "true_false", prompt: "ATP is energy currency.", answer: "t", why: "" },
        mc(11, "A", ["A) only one"]),
      ]),
    );
    assert.equal(out.questions.length, 2);
    assert.deepEqual(
      out.questions.map((q) => q.n),
      [1, 2],
    );
    assert.equal(out.questions[0]?.answer, "B");
    assert.equal(out.questions[1]?.answer, "True");
    assert.equal(out.questions[1]?.why, "See your class material.");
  });

  it("handles an exam with no questions", async () => {
    const out = await verifyExam(exam([]));
    assert.deepEqual(out.questions, []);
  });
});
