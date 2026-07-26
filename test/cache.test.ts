// In-memory content cache: key normalization, round-trip, expiry, stats.
import "./helpers.js";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CACHE } from "../src/config.js";
import { cacheClear, cacheGet, cacheKey, cacheSet, cacheStats } from "../src/engine/cache.js";

beforeEach(() => cacheClear());

/** cacheKey joins its parts with NUL so two parts can never run together. */
const NUL = "\u0000";

describe("cacheKey", () => {
  it("lowercases and joins the parts with a NUL separator", () => {
    assert.equal(cacheKey(["Reviewer", "QUICK", "Photosynthesis"]), ["reviewer", "quick", "photosynthesis"].join(NUL));
  });

  it("collapses runs of whitespace", () => {
    assert.equal(cacheKey(["exam", "Algebra\t\tI"]), ["exam", "algebra i"].join(NUL));
    assert.equal(cacheKey(["exam", "Algebra\tI"]), cacheKey(["exam", "algebra i"]));
  });

  it("trims the key ends", () => {
    assert.equal(
      cacheKey(["reviewer", "quick", "Photosynthesis  "]),
      cacheKey(["reviewer", "quick", "Photosynthesis"]),
    );
  });

  it("keeps parts separate, so 'a','b' is not the same request as 'a b'", () => {
    assert.notEqual(cacheKey(["a", "b"]), cacheKey(["a b"]));
    assert.notEqual(cacheKey(["a", "b"]), cacheKey(["ab"]));
  });

  it("keeps genuinely different inputs apart", () => {
    assert.notEqual(cacheKey(["reviewer", "quick", "photosynthesis"]), cacheKey(["reviewer", "full", "photosynthesis"]));
    assert.notEqual(cacheKey(["exam", "algebra", "mixed", 10]), cacheKey(["exam", "algebra", "mixed", 20]));
    assert.notEqual(
      cacheKey(["reviewer", "quick", "photosynthesis", "English"]),
      cacheKey(["reviewer", "quick", "photosynthesis", "Filipino"]),
    );
  });

  it("renders numbers and treats undefined as an empty part", () => {
    assert.equal(cacheKey(["exam", "algebra", "mixed", 10, undefined]), ["exam", "algebra", "mixed", "10", ""].join(NUL));
    assert.equal(cacheKey(["exam", "algebra", "mixed", 10, undefined]), cacheKey(["exam", "algebra", "mixed", 10, ""]));
  });
});

describe("cacheGet / cacheSet", () => {
  it("round-trips a value", () => {
    const key = cacheKey(["reviewer", "quick", "Photosynthesis"]);
    assert.equal(cacheGet(key), undefined);
    cacheSet(key, { title: "Photosynthesis", sections: 3 });
    assert.deepEqual(cacheGet(key), { title: "Photosynthesis", sections: 3 });
  });

  it("misses on an unknown key", () => {
    cacheSet(cacheKey(["reviewer", "quick", "Photosynthesis"]), { a: 1 });
    assert.equal(cacheGet(cacheKey(["reviewer", "quick", "Respiration"])), undefined);
  });

  it("is reachable through the normalized key", () => {
    cacheSet(cacheKey(["Reviewer", "QUICK", "PHOTOSYNTHESIS  "]), "hit");
    assert.equal(cacheGet(cacheKey(["reviewer", "quick", "photosynthesis"])), "hit");
  });

  it("overwrites an existing key", () => {
    const key = cacheKey(["exam", "algebra"]);
    cacheSet(key, "first");
    cacheSet(key, "second");
    assert.equal(cacheGet(key), "second");
    assert.equal(cacheStats().size, 1);
  });

  it("expires an entry once its TTL has passed", () => {
    const key = cacheKey(["reviewer", "quick", "Photosynthesis"]);
    const now = 1_000_000;
    cacheSet(key, "value", now);
    assert.equal(cacheGet(key, now + CACHE.ttlMs - 1), "value");
    assert.equal(cacheGet(key, now + CACHE.ttlMs), undefined);
    // The expired entry is evicted, not just hidden.
    assert.equal(cacheStats().size, 0);
  });

  it("reports its size and enabled flag", () => {
    assert.deepEqual(cacheStats(), { size: 0, enabled: CACHE.enabled });
    cacheSet(cacheKey(["a"]), 1);
    cacheSet(cacheKey(["b"]), 2);
    assert.equal(cacheStats().size, 2);
    cacheClear();
    assert.equal(cacheStats().size, 0);
  });
});
