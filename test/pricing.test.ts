// Pricing and the service catalogue.
//
// The atomic amounts here are what the x402 402-challenge advertises, so a
// wrong value means the buyer is charged the wrong price. They are asserted
// literally rather than recomputed.
import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NEXT_STEP,
  SERVICES,
  SERVICE_IDS,
  paymentConfig,
  priceAtomic,
  priceLabel,
  routeToService,
} from "../src/config.js";
import { nextStepLine } from "../src/render/blocks.js";
import type { ServiceId } from "../src/types.js";

const USDT0_DECIMALS = 6;

/** id -> [route, price in USDT, price in atomic units]. */
const TABLE: Array<[ServiceId, string, number, string]> = [
  ["quick_reviewer", "quick-reviewer", 0.1, "100000"],
  ["full_reviewer", "full-reviewer", 0.5, "500000"],
  ["mock_exam", "mock-exam", 0.3, "300000"],
  ["explain_this", "explain-this", 0.001, "1000"],
  ["exam_pack", "exam-pack", 1.0, "1000000"],
];

describe("priceAtomic", () => {
  for (const [id, , usdt, atomic] of TABLE) {
    it(`${id}: ${usdt} USDT -> ${atomic}`, () => {
      assert.equal(priceAtomic(usdt, USDT0_DECIMALS), atomic);
    });
  }

  it("expresses the sub-cent Explain This price without rounding it away", () => {
    assert.equal(priceAtomic(0.001, 6), "1000");
    assert.notEqual(priceAtomic(0.001, 6), "0");
  });

  it("returns a decimal integer string, never scientific notation", () => {
    for (const [, , usdt] of TABLE) {
      assert.match(priceAtomic(usdt, USDT0_DECIMALS), /^\d+$/);
    }
  });

  it("respects the decimals argument", () => {
    assert.equal(priceAtomic(1, 6), "1000000");
    assert.equal(priceAtomic(1, 18), "1000000000000000000");
  });
});

describe("service catalogue", () => {
  it("has exactly the five services", () => {
    assert.deepEqual([...SERVICE_IDS].sort(), [
      "exam_pack",
      "explain_this",
      "full_reviewer",
      "mock_exam",
      "quick_reviewer",
    ]);
  });

  for (const [id, route, usdt] of TABLE) {
    it(`${id} is /v1/${route} at ${usdt} USDT`, () => {
      const service = SERVICES[id];
      assert.equal(service.id, id);
      assert.equal(service.route, route);
      assert.equal(service.priceUsdt, usdt);
      assert.equal(routeToService(route)?.id, id);
    });
  }

  it("has no route collisions and no unknown routes", () => {
    const routes = SERVICE_IDS.map((id) => SERVICES[id].route);
    assert.equal(new Set(routes).size, routes.length);
    assert.equal(routeToService("not-a-service"), undefined);
  });

  it("labels prices in USDT per use", () => {
    assert.equal(priceLabel(0.1), "0.1 USDT/use");
    assert.equal(priceLabel(0.001), "0.001 USDT/use");
  });

  it("never promises a passing result — OKX rejects over-claiming copy", () => {
    const hype = [/\bguaranteed\b/, /\bwill pass\b/, /\b100% pass\b/, /\bensures? (you )?pass/];
    for (const id of SERVICE_IDS) {
      const text = `${SERVICES[id].title} ${SERVICES[id].description}`.toLowerCase();
      for (const re of hype) assert.doesNotMatch(text, re, `${id} description over-claims`);
    }
  });
});

describe("one next step", () => {
  it("points every service at exactly one other service", () => {
    for (const id of SERVICE_IDS) {
      const next = NEXT_STEP[id];
      assert.ok(SERVICE_IDS.includes(next), `${id} points at unknown service ${next}`);
      assert.notEqual(next, id, `${id} points at itself`);
    }
  });

  it("renders the upsell with the next service's real price", () => {
    // Derived from config rather than hardcoded: the description text is
    // load-bearing (it must stay byte-identical to the OKX listing), so a
    // literal copy here would silently rot the moment the listing is reworded.
    for (const id of SERVICE_IDS) {
      const next = SERVICES[NEXT_STEP[id]];
      const line = nextStepLine(id);
      assert.ok(line.startsWith(`${next.title} — ${next.priceUsdt} USDT.`), line);
      // Exactly one sentence of the description, so the upsell stays short.
      const tail = line.slice(`${next.title} — ${next.priceUsdt} USDT. `.length);
      assert.ok(next.description.startsWith(tail), `upsell tail not from description: ${tail}`);
      assert.ok(tail.endsWith("."), `upsell should end on a sentence: ${tail}`);
    }
  });
});

describe("payment config", () => {
  it("defaults to X Layer mainnet with the USDT0 settlement token", () => {
    const cfg = paymentConfig();
    assert.equal(cfg.network.caip2, "eip155:196");
    assert.equal(cfg.network.decimals, 6);
    assert.equal(cfg.network.asset, "0x779ded0c9e1022225f8e0630b35a9b54be713736");
  });
});
