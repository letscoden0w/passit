// Worst-case response time.
//
// This is the test that would have caught the 502s: when every provider hangs,
// a service must still answer well inside a gateway timeout. The budget is not
// "how long we may keep trying" — when providers are slow it IS the response
// time the buyer experiences.
import "./helpers.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { examPack, explainThis, fullReviewer, mockExam, quickReviewer } from "../src/services.js";
import { resetProviderHealth } from "../src/engine/providers.js";
import { cacheClear } from "../src/engine/cache.js";
import type { ServiceResult } from "../src/types.js";
import { assertDelivered } from "./helpers.js";

const realFetch = globalThis.fetch;

/** Every provider accepts the connection and then never answers. */
function stallAllProviders() {
  globalThis.fetch = ((_u: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["GROQ_API_KEY", "MISTRAL_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];
  cacheClear();
  resetProviderHealth();
});

/**
 * Ceiling for any single service. Hosts commonly cut a request off at 30s;
 * staying under this is what keeps a stalled provider from becoming a 502.
 */
const CEILING_MS = 26_000;

const services: Array<[string, () => Promise<ServiceResult>]> = [
  ["explain_this", () => explainThis({ problem: "Why flip and multiply?" })],
  ["quick_reviewer", () => quickReviewer({ topic: "Ohm's Law" })],
  ["mock_exam", () => mockExam({ target: "Circulatory System" })],
  ["full_reviewer", () => fullReviewer({ topic: "Chemistry: Atoms, Bonds, Moles" })],
  ["exam_pack", () => examPack({ exam: "CPA Board", topics: "Tax, Audit" })],
];

describe("worst-case latency with every provider hung", () => {
  for (const [name, call] of services) {
    it(`${name} still delivers inside the gateway window`, async () => {
      process.env.GROQ_API_KEY = "k";
      process.env.MISTRAL_API_KEY = "k";
      process.env.GEMINI_API_KEY = "k";
      resetProviderHealth();
      cacheClear();
      stallAllProviders();

      const started = Date.now();
      const result = await call();
      const elapsed = Date.now() - started;

      assert.ok(elapsed < CEILING_MS, `${name} took ${elapsed}ms, ceiling is ${CEILING_MS}ms`);
      // Slow must degrade to the scaffold, never to an empty response.
      assertDelivered(result);
      assert.equal(result.servedBy, "scaffold");
    });
  }
});
