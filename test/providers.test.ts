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
