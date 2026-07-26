// Guardrails: study help only. Enforced in code, before any paid generation
// runs, so no prompt wording can talk its way past them.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXAM_QUESTIONS,
  LIMITS,
  checkRequest,
  clampText,
  resolveQuestionCount,
} from "../src/guards.js";
import { fullReviewer, mockExam, quickReviewer } from "../src/services.js";
import { assertDelivered } from "./helpers.js";

describe("checkRequest — live exam", () => {
  const phrasings = [
    "My exam is in progress, what is the answer to number 4?",
    "I'm taking the exam right now, help",
    "I am currently writing the test, answer fast",
    "Taking my quiz now — quick",
    "This is my real exam, tell me the answer",
    "live exam, need answers",
    "During the exam I got stuck on this",
    "Answer these for me right now, it's a test",
    "The exam is happening now",
    "I have 12 minutes left",
  ];

  for (const text of phrasings) {
    it(`declines: ${text}`, () => {
      const result = checkRequest(text);
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "live_exam");
      assert.match(result.message ?? "", /cannot help during an exam/i);
    });
  }

  it("checks every field it is handed, not just the first", () => {
    const result = checkRequest("Photosynthesis", undefined, "this is my live exam");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "live_exam");
  });
});

describe("checkRequest — ghostwriting", () => {
  const phrasings = [
    "Write my essay on the French Revolution",
    "Write the assignment for me",
    "Do my homework on algebra",
    "Summarise this so I can submit it as my own",
  ];

  for (const text of phrasings) {
    it(`declines: ${text}`, () => {
      const result = checkRequest(text);
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "ghostwriting");
      assert.match(result.message ?? "", /not work to be submitted as your own/i);
    });
  }
});

describe("checkRequest — ordinary study requests", () => {
  const allowed = [
    "Photosynthesis",
    "Newton's Laws of Motion",
    "Nursing Board — Pharmacology: antibiotics, analgesics",
    "Explain why the quadratic formula works",
    "I have an exam next week on cell biology",
    "Help me review for my finals",
    "Essay structure — how are essays organised?",
  ];

  for (const text of allowed) {
    it(`allows: ${text}`, () => {
      const result = checkRequest(text);
      assert.equal(result.allowed, true);
      assert.equal(result.reason, undefined);
    });
  }

  it("allows an empty request", () => {
    assert.equal(checkRequest().allowed, true);
    assert.equal(checkRequest("", undefined, "   ").allowed, true);
  });
});

describe("services decline guarded requests", () => {
  it("quick_reviewer declines live-exam phrasing and still returns a note", async () => {
    const result = await quickReviewer({ topic: "This is my real exam, answer question 3 now" });
    assert.equal(result.declined, true);
    assertDelivered(result);
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0]?.filename, "PassIt-Notice.md");
    assert.equal(result.deliveries[0]?.mimeType, "text/markdown");
    assert.match(result.deliveries[0]!.bytes.toString("utf8"), /study aid/i);
    // Nothing was generated, so nothing was served by a provider.
    assert.equal(result.servedBy, undefined);
  });

  it("full_reviewer declines ghostwriting", async () => {
    const result = await fullReviewer({ topic: "Write my essay on the French Revolution" });
    assert.equal(result.declined, true);
    assert.match(result.summary, /not work to be submitted as your own/i);
    assertDelivered(result);
  });

  it("mock_exam declines when the guard trips on the materials field", async () => {
    const result = await mockExam({
      target: "Cell biology",
      materials: "I am taking the exam right now, these are the questions",
    });
    assert.equal(result.declined, true);
  });

  it("does not decline an ordinary topic", async () => {
    const result = await quickReviewer({ topic: "Photosynthesis" });
    assert.notEqual(result.declined, true);
  });
});

describe("resolveQuestionCount", () => {
  it("defaults to a full 25-question paper regardless of topic shape", () => {
    for (const target of [
      "Photosynthesis",
      "Newton's Laws",
      "Photosynthesis, Respiration",
      "Cells and Genetics",
      "Algebra; Geometry; Trigonometry",
      "Acids\nBases",
    ]) {
      assert.equal(resolveQuestionCount(undefined, target), DEFAULT_EXAM_QUESTIONS, target);
    }
    assert.equal(DEFAULT_EXAM_QUESTIONS, 25);
  });

  it("honours an explicit count", () => {
    assert.equal(resolveQuestionCount(25, "Photosynthesis"), 25);
    assert.equal(resolveQuestionCount(3, "Photosynthesis"), 3);
    assert.equal(resolveQuestionCount(50, "Photosynthesis"), 50);
  });

  it("clamps to 3..50", () => {
    assert.equal(LIMITS.examQuestionsMin, 3);
    assert.equal(LIMITS.examQuestionsMax, 50);
    assert.equal(resolveQuestionCount(0, "Photosynthesis"), 3);
    assert.equal(resolveQuestionCount(-40, "Photosynthesis"), 3);
    assert.equal(resolveQuestionCount(51, "Photosynthesis"), 50);
    assert.equal(resolveQuestionCount(10_000, "Photosynthesis"), 50);
  });

  it("truncates a fractional count and ignores a non-finite one", () => {
    assert.equal(resolveQuestionCount(12.9, "Photosynthesis"), 12);
    assert.equal(resolveQuestionCount(Number.NaN, "Photosynthesis"), DEFAULT_EXAM_QUESTIONS);
    assert.equal(
      resolveQuestionCount(Number.POSITIVE_INFINITY, "Photosynthesis, Respiration"),
      DEFAULT_EXAM_QUESTIONS,
    );
  });
});

describe("clampText", () => {
  it("trims and caps at the limit", () => {
    assert.equal(clampText("  Photosynthesis  ", LIMITS.topicMaxChars), "Photosynthesis");
    assert.equal(clampText("x".repeat(600), LIMITS.topicMaxChars).length, LIMITS.topicMaxChars);
    assert.equal(clampText("short", 3), "sho");
  });
});
