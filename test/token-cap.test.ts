// No request may ask a provider for more tokens than its tier allows.
//
// This is the defect that made every large service return the scaffold. Free
// tiers reserve against the max_tokens you ASK for, not what you use, so a
// request whose ceiling exceeds the per-minute allowance is refused before a
// single token is generated. Groq's free allowance is ~6,000 tokens/minute:
// Explain This asked 2,000 and always worked, a 25-question Mock Exam asked
// 6,700 and always failed. The symptom tracked max_tokens exactly.
import "./helpers.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { providerChain } from "../src/config.js";
import { generateMockExam, generateReviewer } from "../src/engine/generate.js";
import { resetProviderHealth } from "../src/engine/providers.js";
import { cacheClear } from "../src/engine/cache.js";
import { LIMITS } from "../src/guards.js";

const realFetch = globalThis.fetch;

/** Record the max_tokens of every outbound request. */
function recordAsks() {
  const asks: number[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      max_tokens?: number;
      generationConfig?: { maxOutputTokens?: number };
    };
    asks.push(body.max_tokens ?? body.generationConfig?.maxOutputTokens ?? 0);
    // Fail the call; we only care what was asked for.
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  return asks;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
  cacheClear();
  resetProviderHealth();
});

describe("no request exceeds the provider's token cap", () => {
  it("caps a Groq request even when the caller asks for far more", async () => {
    process.env.GROQ_API_KEY = "k";
    const cap = providerChain().find((p) => p.id === "groq")!.maxTokensCap;
    const asks = recordAsks();

    await generateReviewer("full", "Chemistry", { deadline: Date.now() + 5_000 });

    assert.ok(asks.length > 0, "no request was made");
    for (const ask of asks) {
      assert.ok(ask <= cap, `asked for ${ask} tokens against a ${cap} cap`);
    }
  });

  it("keeps every batch of the longest possible exam under the cap", async () => {
    process.env.GROQ_API_KEY = "k";
    const cap = providerChain().find((p) => p.id === "groq")!.maxTokensCap;
    const asks = recordAsks();

    await generateMockExam("Genetics", "mixed", LIMITS.examQuestionsMax, {
      deadline: Date.now() + 5_000,
    });

    assert.ok(asks.length > 1, `a ${LIMITS.examQuestionsMax}-question paper should be batched`);
    for (const ask of asks) {
      assert.ok(ask <= cap, `exam batch asked for ${ask} tokens against a ${cap} cap`);
    }
  });

  it("holds the cap below a free tier's per-minute allowance", () => {
    process.env.GROQ_API_KEY = "k";
    const groq = providerChain().find((p) => p.id === "groq")!;
    // 6,000 TPM, and the prompt counts toward it too — so the output ceiling
    // has to leave real room, not merely squeak under the number.
    assert.ok(groq.maxTokensCap <= 4_000, `Groq cap of ${groq.maxTokensCap} is too close to 6,000 TPM`);
  });
});
