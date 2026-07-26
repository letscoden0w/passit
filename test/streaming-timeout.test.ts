// Slow-streaming responses must respect the deadline.
//
// This is the gap that made every service except Explain This feel slow.
// `fetch` resolves as soon as the response HEADERS arrive; a language model
// sends those immediately and then streams tokens for as long as generation
// takes. Timing only the fetch left the slow part of the call unbounded, and
// the effect scaled with max_tokens — which is exactly why the smallest
// service looked fine while the rest did not.
//
// latency.test.ts cannot catch this: its stub never resolves the fetch at all,
// so it only exercises the header phase.
import "./helpers.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateReviewer } from "../src/engine/generate.js";
import { resetProviderHealth } from "../src/engine/providers.js";
import { cacheClear } from "../src/engine/cache.js";

const realFetch = globalThis.fetch;

const REVIEWER_JSON = JSON.stringify({
  choices: [
    {
      message: {
        content: JSON.stringify({
          title: "T",
          language: "English",
          ataGlance: "x",
          sections: [{ heading: "H", explanation: "E" }],
          studyFirst: [],
          quickCheck: [],
        }),
      },
    },
  ],
});

/** Headers land immediately; the body dribbles out over `seconds`. */
function stubSlowBody(seconds: number) {
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const chunks = REVIEWER_JSON.match(/.{1,20}/gs) ?? [REVIEWER_JSON];
    const stream = new ReadableStream({
      async start(ctrl) {
        const enc = new TextEncoder();
        // Real undici errors the body stream the moment the signal fires.
        init.signal?.addEventListener("abort", () => {
          try {
            ctrl.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          } catch {
            /* already closed */
          }
        });
        for (const c of chunks) {
          if (init.signal?.aborted) return;
          await new Promise((r) => setTimeout(r, (seconds * 1000) / chunks.length));
          if (init.signal?.aborted) return;
          try {
            ctrl.enqueue(enc.encode(c));
          } catch {
            return;
          }
        }
        try {
          ctrl.close();
        } catch {
          /* already closed */
        }
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
  cacheClear();
  resetProviderHealth();
});

describe("a slow-streaming provider cannot outrun the deadline", () => {
  it("cuts off a body that streams past the budget", async () => {
    process.env.GROQ_API_KEY = "k";
    stubSlowBody(10);

    const started = Date.now();
    const result = await generateReviewer("quick", "Ohm's Law", { deadline: Date.now() + 2_000 });
    const elapsed = Date.now() - started;

    // Before the fix this measured the full 10s regardless of the deadline.
    assert.ok(elapsed < 3_000, `took ${elapsed}ms against a 2000ms deadline`);
    assert.equal(result.servedBy, "scaffold");
  });

  it("still accepts a body that finishes inside the budget", async () => {
    process.env.GROQ_API_KEY = "k";
    stubSlowBody(0.3);

    const result = await generateReviewer("quick", "Ohm's Law", { deadline: Date.now() + 5_000 });

    // The cut-off must not be so eager that healthy generations are discarded.
    assert.equal(result.servedBy, "groq");
    assert.equal(result.value.sections.length, 1);
  });
});
