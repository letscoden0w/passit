// Shared test setup and assertions.
//
// Every test file imports this first. It strips the LLM API keys from the
// environment so `providerChain()` comes back empty, `complete()` throws
// NoProviderAvailable, and the engine falls back to its built-in deterministic
// scaffold. That is exactly the path we want under test: no network, no
// randomness, no dependency on a free-tier quota.
import assert from "node:assert/strict";
import type { Delivery, ServiceResult } from "../src/types.js";

const PROVIDER_KEYS = ["GROQ_API_KEY", "MISTRAL_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY"];

// Network overrides too: a developer's local .env must not change what the
// pricing assertions see.
const OVERRIDES = [
  "LLM_PROVIDERS",
  "X402_NETWORK",
  "X402_ASSET",
  "X402_ASSET_DECIMALS",
  "CACHE_ENABLED",
  "CACHE_TTL_MINUTES",
  "CACHE_MAX_ENTRIES",
];

for (const key of [...PROVIDER_KEYS, ...OVERRIDES]) delete process.env[key];
process.env.NODE_ENV = "test";

/** The five bytes every PDF file starts with. */
export const PDF_MAGIC = "%PDF-";

export function pdfMagic(bytes: Buffer): string {
  return bytes.subarray(0, 5).toString("latin1");
}

/** Assert a delivery is a real PDF — right mime type, right magic bytes. */
export function assertPdf(delivery: Delivery | undefined, filename?: string): void {
  assert.ok(delivery, "expected a delivery");
  assert.equal(delivery.mimeType, "application/pdf");
  assert.match(delivery.filename, /^PassIt-.+\.pdf$/);
  if (filename !== undefined) assert.equal(delivery.filename, filename);
  assert.equal(pdfMagic(delivery.bytes), PDF_MAGIC, "bytes do not start with %PDF-");
  // A one-page pdfkit document is comfortably over 1 KB; anything smaller
  // means we handed the buyer an empty file.
  assert.ok(delivery.bytes.length > 1_000, `PDF is only ${delivery.bytes.length} bytes`);
}

export function assertTextFile(
  delivery: Delivery | undefined,
  mimeType: string,
  filename?: string,
): string {
  assert.ok(delivery, "expected a delivery");
  assert.equal(delivery.mimeType, mimeType);
  if (filename !== undefined) assert.equal(delivery.filename, filename);
  const text = delivery.bytes.toString("utf8");
  assert.ok(text.length > 0, "text delivery is empty");
  return text;
}

/** Every paid call must hand back at least one file, declined or not. */
export function assertDelivered(result: ServiceResult): void {
  assert.ok(result.deliveries.length >= 1, "no deliveries returned");
  for (const d of result.deliveries) {
    assert.ok(d.filename.length > 0, "delivery has no filename");
    assert.ok(d.bytes.length > 0, `delivery ${d.filename} is empty`);
  }
  assert.ok(result.summary.trim().length > 0, "no summary returned");
}

export function byExtension(result: ServiceResult, ext: string): Delivery | undefined {
  return result.deliveries.find((d) => d.filename.toLowerCase().endsWith(ext));
}
