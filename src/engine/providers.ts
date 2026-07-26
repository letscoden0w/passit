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
  /**
   * Absolute epoch-ms cutoff for this call. Past it we stop trying providers
   * and let the caller fall back, so a buyer waiting on an HTTP request always
   * gets an answer rather than a gateway timeout.
   */
  deadline?: number;
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

/** A provider refused this call. `retryAfterMs` is set when it told us how long to wait. */
class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Longest we will hold a request waiting for a rate limit to clear before
 * moving on. Free tiers meter per minute, so short waits are common and
 * usually cheaper than falling through to a weaker provider.
 */
const MAX_INLINE_WAIT_MS = 12_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    // Out of time: stop here and let the caller fall back. Marching through
    // the rest of the chain would only turn a slow response into no response.
    if (outOfTime(opts.deadline)) {
      throw new NoProviderAvailable(`Deadline reached — ${errors.join(" | ") || "no attempt completed"}`);
    }
    // One in-place retry: free tiers meter per minute, so a 429 with a short
    // retry-after is worth waiting out rather than benching the provider for
    // minutes. This is what kept multi-call services (Exam Pack fires four
    // generations back to back) from collapsing onto the scaffold.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callProvider(provider, opts);
        if (!text.trim()) throw new Error("empty response");
        return { text, servedBy: provider.id };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : undefined;
        errors.push(`${provider.id}: ${(err as Error).message}`);

        const waitable =
          pe?.status === 429 &&
          attempt === 0 &&
          pe.retryAfterMs !== undefined &&
          pe.retryAfterMs <= MAX_INLINE_WAIT_MS &&
          // Only worth waiting out if there is time left on the other side.
          !outOfTime(opts.deadline, pe.retryAfterMs + 5_000);

        if (waitable) {
          await sleep(pe!.retryAfterMs! + 250);
          continue; // same provider, second attempt
        }

        if (shouldBench(err)) bench(provider.id, Date.now(), benchFor(pe));
        break; // move to the next provider
      }
    }
  }
  throw new NoProviderAvailable(`All providers failed — ${errors.join(" | ")}`);
}

/**
 * Bench only for as long as the provider actually asked for. A flat multi-minute
 * cooldown turns one transient 429 into minutes of degraded output.
 */
function benchFor(pe: ProviderError | undefined): number {
  if (pe?.retryAfterMs !== undefined) {
    return Math.min(Math.max(pe.retryAfterMs, 1_000), PROVIDER_COOLDOWN_MS);
  }
  return PROVIDER_COOLDOWN_MS;
}

function shouldBench(err: unknown): boolean {
  const message = (err as Error)?.message ?? "";
  return /\b(429|5\d\d)\b|rate.?limit|quota|timeout|abort|ECONN|fetch failed/i.test(message);
}

/** Read a Retry-After header (seconds, or an HTTP date) into milliseconds. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset-tokens");
  if (!raw) return undefined;
  const trimmed = raw.trim();

  // Groq returns durations like "7.5s" or "2m59.56s" on x-ratelimit-reset-*.
  const duration = trimmed.match(/^(?:(\d+(?:\.\d+)?)m)?(\d+(?:\.\d+)?)s$/i);
  if (duration) {
    const mins = Number(duration[1] ?? 0);
    const secs = Number(duration[2] ?? 0);
    return Math.round((mins * 60 + secs) * 1000);
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

// ─── Provider implementations ────────────────────────────────────────

const OPENAI_COMPATIBLE: Partial<Record<ProviderId, string>> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

/** OpenRouter uses these for attribution and model-ranking; both are optional. */
const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/letscoden0w/passit",
  "X-Title": "PassIt",
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
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
        ...(provider.id === "openrouter" ? OPENROUTER_HEADERS : {}),
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
    },
    budgetFor(opts.deadline),
  );
  if (!res.ok) throw new ProviderError(`${res.status} ${await peek(res)}`, res.status, retryAfterMs(res));
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
  const res = await fetchWithTimeout(
    url,
    {
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
    },
    budgetFor(opts.deadline),
  );
  if (!res.ok) throw new ProviderError(`${res.status} ${await peek(res)}`, res.status, retryAfterMs(res));
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) throw new Error("no content in response");
  return text;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Ceiling on a single provider call. Free tiers answer in seconds; a call
 * still open after this is hung, not slow. It was 90s, which meant one stuck
 * connection could burn the entire request budget on its own.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** True when `deadline` has passed, optionally requiring `headroom` ms to spare. */
function outOfTime(deadline: number | undefined, headroom = 0): boolean {
  return deadline !== undefined && Date.now() + headroom >= deadline;
}

/** Time left before `deadline`, capped at the per-call ceiling. */
function budgetFor(deadline: number | undefined): number {
  if (deadline === undefined) return REQUEST_TIMEOUT_MS;
  return Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
