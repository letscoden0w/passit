// Worst-case response time.
//
// This is the test that would have caught the 502s: when every provider hangs,
// a service must still answer well inside a gateway timeout. The budget is not
// "how long we may keep trying" — when providers are slow it IS the response
// time the buyer experiences.
import "./helpers.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  examPack,
  explainThis,
  fullReviewer,
  mockExam,
  quickReviewer,
  serviceBudgetMs,
} from "../src/services.js";
import { resetProviderHealth } from "../src/engine/providers.js";
import { cacheClear } from "../src/engine/cache.js";
import type { ServiceId, ServiceResult } from "../src/types.js";
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
 * Rendering and PDF assembly on top of the provider budget. Anything beyond
 * this is time nobody accounted for.
 */
const OVERHEAD_MS = 4_000;

/**
 * Assert against the service's own configured budget rather than a magic
 * number. The budget itself is a product decision — too low cuts off healthy
 * generations and everything returns the scaffold, too high and the request
 * outlives the gateway — but whatever it is set to, a stalled provider must
 * not be able to push a response past it.
 */
const services: Array<[ServiceId, () => Promise<ServiceResult>]> = [
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

      const ceiling = serviceBudgetMs(name) + OVERHEAD_MS;
      assert.ok(elapsed < ceiling, `${name} took ${elapsed}ms, its budget allows ${ceiling}ms`);
      // Slow must degrade to the scaffold, never to an empty response.
      assertDelivered(result);
      assert.equal(result.servedBy, "scaffold");
    });
  }
});
