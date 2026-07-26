// Provider chain. Tests run with every API key stripped from the environment
// (see helpers.ts), which is the "all free tiers exhausted" state the scaffold
// fallback exists for — and it means no test ever touches the network.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { providerChain } from "../src/config.js";
import {
  NoProviderAvailable,
  complete,
  extractJson,
  hasProviders,
  providerHealth,
  resetProviderHealth,
} from "../src/engine/providers.js";

describe("providerChain", () => {
  it("is empty when no API key is configured", () => {
    assert.deepEqual(providerChain(), []);
    assert.equal(hasProviders(), false);
    assert.deepEqual(providerHealth(), []);
  });

  it("only lists providers whose key is actually present", () => {
    process.env.GROQ_API_KEY = "test-key";
    try {
      const chain = providerChain();
      assert.deepEqual(
        chain.map((p) => p.id),
        ["groq"],
      );
      assert.equal(chain[0]?.apiKey, "test-key");
      // Falls back to the built-in model when GROQ_MODEL is unset.
      assert.equal(chain[0]?.model, "llama-3.3-70b-versatile");
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });
});

describe("complete", () => {
  it("rejects with NoProviderAvailable when nothing is configured", async () => {
    await assert.rejects(
      () => complete({ system: "s", user: "u" }),
      (err: unknown) => {
        assert.ok(err instanceof NoProviderAvailable);
        assert.equal(err.name, "NoProviderAvailable");
        return true;
      },
    );
  });

  it("rejects with NoProviderAvailable for an explicitly empty chain", async () => {
    await assert.rejects(() => complete({ system: "s", user: "u" }, []), NoProviderAvailable);
  });

  it("resetProviderHealth clears the cooldown bench", () => {
    resetProviderHealth();
    assert.deepEqual(providerHealth(), []);
  });
});

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });

  it("parses a fenced ```json block", () => {
    assert.deepEqual(extractJson('```json\n{"a": {"b": 2}}\n```'), { a: { b: 2 } });
  });

  it("parses a fenced block with no language tag", () => {
    assert.deepEqual(extractJson('```\n{"ok": true}\n```'), { ok: true });
  });

  it("ignores prose either side of the object", () => {
    assert.deepEqual(extractJson('Sure! Here you go: {"title":"Photosynthesis"} Hope that helps.'), {
      title: "Photosynthesis",
    });
  });

  it("throws when there is no JSON object at all", () => {
    assert.throws(() => extractJson("I could not do that."), /no JSON object found/);
  });

  it("throws on a malformed object", () => {
    assert.throws(() => extractJson('{"a": }'));
  });
});

describe("a deadline we imposed must not stand a provider down", () => {
  const realFetch = globalThis.fetch;

  it("leaves providers available after our own timeout cuts a call short", async () => {
    process.env.GROQ_API_KEY = "k";
    process.env.GEMINI_API_KEY = "k";
    resetProviderHealth();
    // Never answers, so our AbortController is what ends every call.
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      })) as typeof fetch;

    try {
      await assert.rejects(() =>
        complete({ system: "s", user: "u", deadline: Date.now() + 800 }),
      );

      // The providers did nothing wrong — we ran out of time. Benching them
      // here made a single short budget poison every later request, which is
      // what sent healthy providers to the scaffold for minutes at a stretch.
      for (const p of providerHealth()) {
        assert.equal(p.available, true, `${p.id} was benched for our own deadline`);
      }
    } finally {
      globalThis.fetch = realFetch;
      for (const k of ["GROQ_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];
      resetProviderHealth();
    }
  });

  it("still benches a provider that genuinely rate-limits us", async () => {
    process.env.GROQ_API_KEY = "k";
    resetProviderHealth();
    globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;

    try {
      await assert.rejects(() => complete({ system: "s", user: "u" }));
      assert.equal(providerHealth()[0]?.available, false, "a 429 must still bench");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GROQ_API_KEY;
      resetProviderHealth();
    }
  });
});
