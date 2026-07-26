// The chunked Full Reviewer.
//
// Unlike the rest of the suite, these tests DO exercise the provider path —
// with `fetch` stubbed, so still no network. That is the point: the chunked
// path only runs when a provider is configured, so the scaffold-based tests
// elsewhere can never reach it.
import "./helpers.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateReviewer } from "../src/engine/generate.js";
import { examPack } from "../src/services.js";
import { cacheClear } from "../src/engine/cache.js";
import { resetProviderHealth } from "../src/engine/providers.js";

const realFetch = globalThis.fetch;

/** An OpenAI-shaped chat-completions response carrying `payload` as JSON. */
function reply(payload: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sectionsFor(topic: string, n: number) {
  return {
    sections: Array.from({ length: n }, (_, i) => ({
      heading: `${topic} — part ${i + 1}`,
      explanation: `A deliberately long explanation of ${topic}, part ${i + 1}. `.repeat(8),
      memoryTrick: `Remember ${topic} by its initials.`,
      bullets: [`${topic} fact A`, `${topic} fact B`, `${topic} fact C`],
    })),
  };
}

const SYNTHESIS = {
  title: "Biology",
  language: "English",
  ataGlance: "Cells, genetics and evolution, covered end to end.",
  comparisonTables: [
    { caption: "Across topics", headers: ["A", "B"], rows: [["1", "2"], ["3", "4"]] },
  ],
  studyFirst: ["Cell structure", "Inheritance", "Selection"],
  quickCheck: [{ question: "What is a cell?", answer: "The basic unit of life." }],
};

/**
 * Stub every provider call. The first `topicCount` calls return that topic's
 * sections; the next returns the cross-topic synthesis.
 */
function stubProvider(topicCount: number, opts: { failSynthesis?: boolean } = {}) {
  const prompts: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    prompts.push(body.messages[1]?.content ?? "");
    const i = call++;
    if (i < topicCount) return reply(sectionsFor(`Topic${i + 1}`, 3));
    if (opts.failSynthesis) return new Response("boom", { status: 500 });
    return reply(SYNTHESIS);
  }) as typeof fetch;
  return { prompts, calls: () => call };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
  cacheClear();
  resetProviderHealth();
});

describe("chunked full reviewer", () => {
  it("makes one call per topic plus a synthesis call, and merges every topic's sections", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const stub = stubProvider(3);

    const result = await generateReviewer("full", "Biology: Cells, Genetics, Evolution");

    // 3 topics + 1 synthesis.
    assert.equal(stub.calls(), 4);
    assert.equal(result.servedBy, "groq");
    // 3 topics x 3 sections each — far more than one call would have returned.
    assert.equal(result.value.sections.length, 9);
    assert.equal(result.value.ataGlance, SYNTHESIS.ataGlance);
    assert.deepEqual(result.value.studyFirst, SYNTHESIS.studyFirst);
    assert.equal(result.value.comparisonTables?.length, 1);

    // Each topic call must be scoped to its own topic, not the whole subject.
    for (const [i, topic] of ["Cells", "Genetics", "Evolution"].entries()) {
      assert.match(stub.prompts[i], new RegExp(`YOUR TOPIC \\(part ${i + 1} of 3\\): ${topic}`));
    }
    // The synthesis call is told what was already written.
    assert.match(stub.prompts[3], /SECTIONS ALREADY WRITTEN/);
  });

  it("still delivers the sections when the synthesis call fails", async () => {
    process.env.GROQ_API_KEY = "test-key";
    stubProvider(2, { failSynthesis: true });

    const result = await generateReviewer("full", "Chemistry: Acids, Bases");

    assert.equal(result.value.sections.length, 6);
    assert.notEqual(result.servedBy, "scaffold");
    // ataGlance is backfilled rather than left blank.
    assert.ok(result.value.ataGlance.trim().length > 0);
  });

  it("falls back to the scaffold only when every topic call fails", async () => {
    process.env.GROQ_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

    const result = await generateReviewer("full", "Physics: Motion, Energy");

    assert.equal(result.servedBy, "scaffold");
    assert.ok(result.value.sections.length > 0, "scaffold must still produce sections");
  });

  it("leaves a single-topic subject on the single-call path", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const stub = stubProvider(0); // first call returns the synthesis shape

    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      stub.prompts.push(body.messages[1]?.content ?? "");
      return reply({ ...SYNTHESIS, sections: sectionsFor("Photosynthesis", 4).sections });
    }) as typeof fetch;

    const result = await generateReviewer("full", "Photosynthesis");

    assert.equal(stub.prompts.length, 1, "a single topic must not fan out");
    assert.match(stub.prompts[0], /Make a FULL REVIEWER/);
    assert.equal(result.value.sections.length, 4);
  });
});

describe("time budget", () => {
  it("stops calling providers once the deadline has passed", async () => {
    process.env.GROQ_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // Slower than the deadline we allow below.
      await new Promise((r) => setTimeout(r, 60));
      return new Response("upstream stalled", { status: 504 });
    }) as typeof fetch;

    const started = Date.now();
    const result = await generateReviewer("full", "Biology: Cells, Genetics, Evolution", {
      deadline: Date.now() + 120,
    });
    const elapsed = Date.now() - started;

    // Without a deadline this would march through every provider and attempt.
    assert.ok(elapsed < 2_000, `took ${elapsed}ms — the deadline was not honoured`);
    assert.equal(result.servedBy, "scaffold");
    assert.ok(result.value.sections.length > 0, "buyer must still receive a document");
    assert.ok(calls >= 1, "should have tried at least once before giving up");
  });

  it("caps a single provider call at the time remaining", async () => {
    process.env.GROQ_API_KEY = "test-key";
    let aborted = false;
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as typeof fetch;

    const started = Date.now();
    const result = await generateReviewer("quick", "Photosynthesis", { deadline: Date.now() + 1_100 });
    const elapsed = Date.now() - started;

    assert.ok(aborted, "a hung provider call must be aborted, not waited on");
    assert.ok(elapsed < 4_000, `took ${elapsed}ms — a hung call was not cut off`);
    assert.equal(result.servedBy, "scaffold");
  });
});

describe("concurrency", () => {
  /** Stub that records how many calls are in flight at once. */
  function concurrencyProbe(payloadFor: (i: number) => unknown) {
    let inFlight = 0;
    let peak = 0;
    let total = 0;
    globalThis.fetch = (async () => {
      const i = total++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return reply(payloadFor(i));
    }) as typeof fetch;
    return { peak: () => peak, total: () => total };
  }

  it("fans a multi-topic full reviewer out concurrently, not one topic at a time", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const probe = concurrencyProbe((i) => (i < 3 ? sectionsFor(`T${i}`, 2) : SYNTHESIS));

    await generateReviewer("full", "Biology: Cells, Genetics, Evolution");

    // 3 topic calls overlap; the synthesis call follows them.
    assert.equal(probe.peak(), 3, `topics ran ${probe.peak()} at a time — expected all 3 at once`);
    assert.equal(probe.total(), 4);
  });

  it("runs the exam pack's generations together and keeps its reviewer to one call", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const probe = concurrencyProbe(() => ({
      // A payload that satisfies whichever schema asked for it.
      ...SYNTHESIS,
      sections: sectionsFor("Pharmacology", 3).sections,
      cards: [{ front: "Q", back: "A" }],
      items: ["Priority one"],
      questions: [
        { n: 1, style: "true_false", prompt: "P?", choices: ["True", "False"], answer: "True", why: "w" },
      ],
      answers: [{ n: 1, answer: "True", why: "w" }],
    }));

    await examPack({ exam: "Nursing Board Pharmacology", topics: "Antibiotics, Analgesics" });

    // reviewer + flashcards + mostLikely + mockExam all in flight together.
    assert.equal(probe.peak(), 4, `exam pack ran ${probe.peak()} at a time — expected 4`);
    // 4 concurrent + the dependent re-solve. If the reviewer were chunked this
    // would be 8, which is what made the Exam Pack time out.
    assert.equal(probe.total(), 5, `exam pack made ${probe.total()} calls — expected 5`);
  });
});
