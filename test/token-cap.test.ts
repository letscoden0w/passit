// Requests stay within each provider's configured ceiling.
//
// The ceiling is a guard against a caller asking for something absurd, not a
// throttle: a tighter cap was once applied on the theory that free tiers
// refuse oversized requests outright, which proved wrong — the original code
// asked Groq for 8,000 and was served normally — and the tight cap only
// truncated replies.
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

  it("keeps the longest possible exam within the cap", async () => {
    process.env.GROQ_API_KEY = "k";
    const cap = providerChain().find((p) => p.id === "groq")!.maxTokensCap;
    const asks = recordAsks();

    await generateMockExam("Genetics", "multiple_choice", LIMITS.examQuestionsMax, {
      deadline: Date.now() + 5_000,
    });

    assert.ok(asks.length > 0, "no request was made");
    for (const ask of asks) {
      assert.ok(ask <= cap, `exam asked for ${ask} tokens against a ${cap} cap`);
    }
  });
});
