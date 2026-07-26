// Central configuration: services & pricing, x402 networks, LLM providers.
import "dotenv/config";
import type { ServiceId } from "./types.js";

// ─── Services ────────────────────────────────────────────────────────

export interface ServiceMeta {
  id: ServiceId;
  title: string;
  /** URL path segment: /v1/<route> */
  route: string;
  /** Price in USDT (human units). */
  priceUsdt: number;
  /** Marketplace description — factual, no hype (OKX rejects over-claiming). */
  description: string;
  /** Numbered input parameters, mirroring how OKX.AI lists services. */
  params: string[];
}

export const SERVICES: Record<ServiceId, ServiceMeta> = {
  quick_reviewer: {
    id: "quick_reviewer",
    title: "Quick Reviewer",
    route: "quick-reviewer",
    priceUsdt: 0.1,
    description:
      "Generates a printable 2-3 page PDF reviewer for one topic, broken into sections: a summary, simple explanations with worked examples, memory aids, key-facts tables, a priority list, and self-check questions. Study aid only - does not guarantee exam results.",
    params: [
      "topic",
      "optional notes/material",
      "optional format (pdf, markdown, flashcards, cheatsheet)",
      "optional language",
    ],
  },
  full_reviewer: {
    id: "full_reviewer",
    title: "Full Reviewer",
    route: "full-reviewer",
    priceUsdt: 0.5,
    description:
      "Generates a complete multi-topic study guide as one PDF: contents page, one section per topic with explanations, memory aids and tables, cross-topic comparison tables, a priority list, and a self-check. Study aid only - does not guarantee exam results.",
    params: [
      "subject or topic list",
      "optional notes/material",
      "optional format (pdf, markdown, flashcards, cheatsheet)",
      "optional language",
    ],
  },
  mock_exam: {
    id: "mock_exam",
    title: "Mock Exam",
    route: "mock-exam",
    priceUsdt: 0.3,
    description:
      "Generates a practice test as a printable PDF with an answer key that explains every answer. Answers are checked before delivery. Study aid only - does not guarantee exam results.",
    params: [
      "topic, subject or exam name",
      "optional style (multiple_choice, qa, true_false, mixed)",
      "optional question count",
      "optional language",
    ],
  },
  explain_this: {
    id: "explain_this",
    title: "Explain This",
    route: "explain-this",
    priceUsdt: 0.001,
    description:
      "Explains one confusing question or topic as a PDF: the correct answer, step-by-step reasoning in plain words, one memory aid, and 2-3 retry questions. Also checks an answered quiz and reports which items were wrong and why. Study aid only.",
    params: ["the question, topic, or answered quiz", "optional material", "optional language"],
  },
  exam_pack: {
    id: "exam_pack",
    title: "Exam Pack",
    route: "exam-pack",
    priceUsdt: 1.0,
    description:
      "Generates a complete exam-prep bundle: one organized PDF containing a full reviewer, flashcards, a priority topic list, and a 20-question mock exam with explained answer key, plus the flashcards as an importable CSV. Priority items are study suggestions, not predictions. Study aid only.",
    params: ["exam name", "topics or syllabus", "optional material", "optional language"],
  },
};

export const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];

/** The "one next step" rule — exactly one upsell after each delivery. */
export const NEXT_STEP: Record<ServiceId, ServiceId> = {
  quick_reviewer: "mock_exam",
  full_reviewer: "mock_exam",
  mock_exam: "explain_this",
  explain_this: "full_reviewer",
  exam_pack: "explain_this",
};

export function routeToService(route: string): ServiceMeta | undefined {
  return SERVICE_IDS.map((id) => SERVICES[id]).find((s) => s.route === route);
}

// ─── x402 networks ───────────────────────────────────────────────────

export interface NetworkMeta {
  key: "xlayer" | "xlayer-testnet";
  /** CAIP-2 identifier, exactly as OKX requires. */
  caip2: `${string}:${string}`;
  label: string;
  /** Settlement token contract (USDT0). */
  asset: string;
  decimals: number;
  isTestnet: boolean;
}

const NETWORKS: Record<"xlayer" | "xlayer-testnet", NetworkMeta> = {
  xlayer: {
    key: "xlayer",
    caip2: "eip155:196",
    label: "X Layer Mainnet",
    // Official settlement stablecoin on X Layer (USDT0), per OKX docs.
    asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    decimals: 6,
    isTestnet: false,
  },
  "xlayer-testnet": {
    key: "xlayer-testnet",
    caip2: "eip155:1952",
    label: "X Layer Testnet",
    // Testnet USDT0 differs from mainnet — set X402_ASSET before testing.
    // Claim funds: https://www.okx.com/xlayer/faucet/xlayerfaucet
    asset: "",
    decimals: 6,
    isTestnet: true,
  },
};

export type PaymentMode = "mock" | "live" | "disabled";

export interface PaymentConfig {
  mode: PaymentMode;
  network: NetworkMeta;
  payTo: string;
  okx: { apiKey: string; secretKey: string; passphrase: string; syncSettle: boolean };
}

export function paymentConfig(): PaymentConfig {
  const mode = (process.env.PAYMENT_MODE ?? "mock") as PaymentMode;
  const key = (process.env.X402_NETWORK ?? "xlayer") as "xlayer" | "xlayer-testnet";
  const base = NETWORKS[key] ?? NETWORKS.xlayer;
  const network: NetworkMeta = {
    ...base,
    asset: process.env.X402_ASSET || base.asset,
    decimals: intFromEnv("X402_ASSET_DECIMALS", base.decimals),
  };
  return {
    mode,
    network,
    payTo: process.env.PAY_TO_ADDRESS ?? "",
    okx: {
      apiKey: process.env.OKX_API_KEY ?? "",
      secretKey: process.env.OKX_SECRET_KEY ?? "",
      passphrase: process.env.OKX_PASSPHRASE ?? "",
      // Wait for on-chain confirmation before we hand over the file.
      syncSettle: (process.env.OKX_SYNC_SETTLE ?? "true") !== "false",
    },
  };
}

/**
 * Price in the token's smallest unit.
 *
 * We deliberately price in exact atomic units rather than a "$0.10" string:
 * it is deterministic, needs no currency conversion, and — critically —
 * expresses sub-cent amounts (Explain This at 0.001) without depending on
 * a USD parser that may round or reject three decimal places.
 */
export function priceAtomic(usdt: number, decimals: number): string {
  return BigInt(Math.round(usdt * 10 ** decimals)).toString();
}

/** Human-readable price for display: "0.1 USDT/use". */
export function priceLabel(usdt: number): string {
  return `${usdt} USDT/use`;
}

// ─── LLM providers ───────────────────────────────────────────────────

export type ProviderId = "groq" | "mistral" | "gemini" | "cerebras";

export interface ProviderConfig {
  id: ProviderId;
  apiKey: string;
  model: string;
}

const PROVIDER_ENV: Record<ProviderId, { key: string; model: string; fallbackModel: string }> = {
  groq: { key: "GROQ_API_KEY", model: "GROQ_MODEL", fallbackModel: "llama-3.3-70b-versatile" },
  mistral: { key: "MISTRAL_API_KEY", model: "MISTRAL_MODEL", fallbackModel: "mistral-large-latest" },
  gemini: { key: "GEMINI_API_KEY", model: "GEMINI_MODEL", fallbackModel: "gemini-2.5-flash" },
  cerebras: { key: "CEREBRAS_API_KEY", model: "CEREBRAS_MODEL", fallbackModel: "llama-3.3-70b" },
};

/** Providers in priority order, filtered to those that actually have a key. */
export function providerChain(): ProviderConfig[] {
  const order = (process.env.LLM_PROVIDERS ?? "groq,mistral,gemini,cerebras")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderId => s in PROVIDER_ENV);

  return order
    .map((id) => {
      const env = PROVIDER_ENV[id];
      return {
        id,
        apiKey: process.env[env.key] ?? "",
        model: process.env[env.model] || env.fallbackModel,
      };
    })
    .filter((p) => p.apiKey.length > 0);
}

export const PROVIDER_COOLDOWN_MS = intFromEnv("PROVIDER_COOLDOWN_MINUTES", 5) * 60_000;

// ─── Cache ───────────────────────────────────────────────────────────

export const CACHE = {
  enabled: (process.env.CACHE_ENABLED ?? "true") !== "false",
  maxEntries: intFromEnv("CACHE_MAX_ENTRIES", 500),
  ttlMs: intFromEnv("CACHE_TTL_MINUTES", 1440) * 60_000,
};

// ─── Server ──────────────────────────────────────────────────────────

export const SERVER = {
  port: intFromEnv("PORT", 8402),
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${intFromEnv("PORT", 8402)}`).replace(/\/$/, ""),
};

export const BRAND = {
  name: "PassIt",
  tagline: "Type your topic. Get your reviewer.",
  disclaimer:
    "PassIt is a study aid. It is not for use during exams and does not guarantee results.",
  /**
   * Deep blue rather than indigo. Blue is the shade most consistently
   * associated with focus and sustained concentration in study contexts, and
   * it measures 8.7:1 against white — WCAG AAA — where the previous indigo
   * managed only 6.3:1 (AA). These documents get printed and read for hours,
   * so readability wins over fashion.
   */
  accent: "#1e40af",
  /** Teal, used only to set memory aids apart — colour as a recall cue. */
  accentAlt: "#0f766e",
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
