// Free-tier LLM providers with automatic failover.
//
// Providers are tried in priority order. When one rate-limits (429) or errors,
// it is benched for a cooldown window so we don't burn a call on it every
// request, and the next provider takes over. Daily quotas recover on their own.
//
// Groq / Mistral / Cerebras all speak the OpenAI chat-completions shape;
// Gemini has its own. Adding a provider is a case in `callProvider`.
import { providerChain, PROVIDER_COOLDOWN_MS, type ProviderConfig, type ProviderId } from "../config.js";

export interface CompleteOptions {
  system: string;
  user: string;
  /** Ask the provider for a strict JSON object. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface CompleteResult {
  text: string;
  /** Which provider actually served it. */
  servedBy: ProviderId;
}

/** No provider could serve the request (none configured, or all exhausted). */
export class NoProviderAvailable extends Error {
  constructor(message = "No LLM provider available") {
    super(message);
    this.name = "NoProviderAvailable";
  }
}

// ─── Cooldown bookkeeping ────────────────────────────────────────────

const benchedUntil = new Map<ProviderId, number>();

function isBenched(id: ProviderId, now: number): boolean {
  const until = benchedUntil.get(id);
  if (until === undefined) return false;
  if (now >= until) {
    benchedUntil.delete(id);
    return false;
  }
  return true;
}

function bench(id: ProviderId, now: number, ms = PROVIDER_COOLDOWN_MS): void {
  benchedUntil.set(id, now + ms);
}

/** Exposed for tests/diagnostics. */
export function providerHealth(now = Date.now()): Array<{ id: ProviderId; available: boolean }> {
  return providerChain().map((p) => ({ id: p.id, available: !isBenched(p.id, now) }));
}

export function resetProviderHealth(): void {
  benchedUntil.clear();
}

// ─── Public entry point ──────────────────────────────────────────────

/**
 * Try each configured provider in order until one succeeds.
 * Throws NoProviderAvailable when every provider is unavailable — callers
 * fall back to the built-in scaffold so the buyer still receives a file.
 */
export async function complete(
  opts: CompleteOptions,
  chain: ProviderConfig[] = providerChain(),
): Promise<CompleteResult> {
  const now = Date.now();
  const candidates = chain.filter((p) => !isBenched(p.id, now));
  if (candidates.length === 0) throw new NoProviderAvailable();

  const errors: string[] = [];
  for (const provider of candidates) {
    try {
      const text = await callProvider(provider, opts);
      if (!text.trim()) throw new Error("empty response");
      return { text, servedBy: provider.id };
    } catch (err) {
      const message = (err as Error).message;
      errors.push(`${provider.id}: ${message}`);
      // Bench on rate limit / server error / timeout; a malformed single
      // response shouldn't sideline an otherwise healthy provider.
      if (shouldBench(message)) bench(provider.id, Date.now());
    }
  }
  throw new NoProviderAvailable(`All providers failed — ${errors.join(" | ")}`);
}

function shouldBench(message: string): boolean {
  return /\b(429|5\d\d)\b|rate.?limit|quota|timeout|abort|ECONN|fetch failed/i.test(message);
}

// ─── Provider implementations ────────────────────────────────────────

const OPENAI_COMPATIBLE: Partial<Record<ProviderId, string>> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
};

async function callProvider(provider: ProviderConfig, opts: CompleteOptions): Promise<string> {
  if (provider.id === "gemini") return callGemini(provider, opts);
  const url = OPENAI_COMPATIBLE[provider.id];
  if (!url) throw new Error(`unknown provider ${provider.id}`);
  return callOpenAiCompatible(url, provider, opts);
}

async function callOpenAiCompatible(
  url: string,
  provider: ProviderConfig,
  opts: CompleteOptions,
): Promise<string> {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await peek(res)}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("no content in response");
  return text;
}

async function callGemini(provider: ProviderConfig, opts: CompleteOptions): Promise<string> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model)}` +
    `:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [{ text: opts.user }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 4096,
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await peek(res)}`);
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) throw new Error("no content in response");
  return text;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 90_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "AbortError" ? "timeout" : e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function peek(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * Pull a JSON object out of a model response, tolerating code fences and
 * stray prose around it.
 */
export function extractJson<T = unknown>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model output");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

export function hasProviders(): boolean {
  return providerChain().length > 0;
}
