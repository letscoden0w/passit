# PassIt

**Type your topic. Get your reviewer.**

PassIt is an Agent Service Provider (ASP) on [OKX.AI](https://okx.ai) running in **A2MCP**
mode: it takes a topic — a subject, an exam name, one confusing question — and returns
printable study material as a real PDF. It earns per call. Every request to a `/v1/*`
route hits an [x402](https://x402.org) paywall first: an unpaid call gets HTTP 402 with a
base64 `PAYMENT-REQUIRED` challenge, the buyer's agent signs a USDT0 payment on X Layer,
the OKX facilitator settles it on chain, and only then does the handler run and hand over
the file. Prices run from 0.001 USDT for a single explanation to 1.0 USDT for a full exam
pack. There is no escrow, no negotiation and no invoicing — A2MCP bills and settles each
call automatically.

PassIt is a **study aid**. It does not guarantee passing, and it will not help during a
live exam.

---

## The five services

| Service | Price | Endpoint | What the buyer gets |
| --- | --- | --- | --- |
| **Quick Reviewer** | 0.1 USDT | `/v1/quick-reviewer` | A 1–2 page PDF on one topic: at-a-glance summary, plain-words explanations, a memory trick, a key-facts table, a "study this first" list, and 2–3 self-check questions with answers. |
| **Full Reviewer** | 0.5 USDT | `/v1/full-reviewer` | A multi-topic study guide as one PDF: a section per topic with explanations, memory tricks and tables, cross-topic comparison tables, a priority list, and a quick check. |
| **Mock Exam** | 0.3 USDT | `/v1/mock-exam` | A practice test as a printable PDF with a fully explained answer key. Every answer key is structurally checked, and independently re-solved whenever a provider is available. Default 10 questions for one small topic, 20 otherwise; 3–50 on request. |
| **Explain This** | 0.001 USDT | `/v1/explain-this` | One confusing question or topic explained as a PDF: the answer, step-by-step reasoning, a memory trick, and 2–3 retry questions. Also checks an answered quiz and says which items were wrong and why. |
| **Exam Pack** | 1.0 USDT | `/v1/exam-pack` | Two files. A single organized PDF — full reviewer + priority topic list + flashcards + a 20-question mock exam with explained key — plus the flashcards again as an importable CSV (Anki / Quizlet). |

Required parameter per service: `topic` (Quick Reviewer), `subject` (Full Reviewer),
`target` (Mock Exam), `problem` (Explain This), `exam` (Exam Pack). Optional on every
service: `materials`, `format`, `language`. Full parameter list in
[Endpoint reference](#endpoint-reference).

All five are also MCP tools of the same id at `POST /mcp`.

---

## Architecture

```
 ┌─ buyer's agent ─────────────────────────────────────────────────┐
 │ OKX.AI A2MCP · an MCP client · any x402 client                  │
 └───────────────┬─────────────────────────────────────────────────┘
                 │ 1. POST /v1/quick-reviewer {"topic":"Photosynthesis"}
                 ▼
 ┌─ x402 paywall — @okxweb3/x402-express ──────────────────────────┐
 │ 2. no payment → HTTP 402 + base64 PAYMENT-REQUIRED header       │
 │      network  eip155:196                                        │
 │      asset    USDT0 0x779ded0c9e1022225f8e0630b35a9b54be713736  │
 │      amount   "100000"  (= 0.1 USDT at 6 decimals)              │
 │      payTo    your PAY_TO_ADDRESS                               │
 │ 3. buyer signs → OKX facilitator settles on X Layer             │
 │      OKX_SYNC_SETTLE=true → the handler runs only after the     │
 │      payment is confirmed on chain                              │
 └───────────────┬─────────────────────────────────────────────────┘
                 ▼
 ┌─ PassIt server ─────────────────────────────────────────────────┐
 │ 4. guards.ts   live-exam and ghostwriting requests refused here  │
 │ 5. cache.ts    key = service + topic + language                  │
 │                a hit skips the LLM entirely                      │
 └───────────────┬─────────────────────────────────────────────────┘
                 ▼
 ┌─ 6. content engine — free tiers, first healthy provider wins ───┐
 │      Groq ─429→ Mistral ─5xx→ Gemini ─timeout→ Cerebras ─429→   │
 │        OpenRouter — auto-routes across ~20 free models          │
 │        └── all unavailable ──→ deterministic scaffold           │
 │                                (pure code, no network)          │
 │      a failing provider is benched for PROVIDER_COOLDOWN_MINUTES│
 │                                                                 │
 │      RETURNS STRUCTURED JSON ONLY — never a file                │
 └───────────────┬─────────────────────────────────────────────────┘
                 ▼
 ┌─ 7. validation / verification ──────────────────────────────────┐
 │      zod schema parse, then repair: ragged table rows padded,    │
 │      empty sections dropped, missing titles filled               │
 │      mock exams additionally go through verify.ts —              │
 │      structuralFix → independent re-solve of every question →    │
 │      structuralFix, so no question ships unsolved                │
 └───────────────┬─────────────────────────────────────────────────┘
                 ▼
 ┌─ 8. renderer — written in code, not by a model ─────────────────┐
 │      blocks.ts    validated JSON → Block[] document model        │
 │      pdf.ts       Block[] → PDF bytes            (pdfkit)        │
 │      markdown.ts  Block[] → .md · flashcards → .csv              │
 └───────────────┬─────────────────────────────────────────────────┘
                 ▼
 9. HTTP 200 · Content-Type: application/pdf · the file as the body
```

### The core insight: the LLM never makes the file

**An LLM cannot emit a binary file.** It can only emit text. So PassIt splits the job in
two, and the split is the product:

- The **model** produces structured JSON and nothing else — sections, tables, memory
  tricks, questions, answers. It is validated against a zod schema
  (`src/engine/generate.ts`) and repaired before anything downstream sees it.
- The **code** produces the PDF. `src/render/pdf.ts` walks the validated `Block[]` through
  pdfkit — A4, brand band on every page, repeating table headers across page breaks,
  numbered footers. Deterministic and testable — the same input always produces the
  same layout, differing only in the PDF's embedded creation date and document ID.

Three consequences that a "just ask the model for a PDF" approach cannot have:

1. **A paying buyer always gets a real file.** If every free provider is rate-limited or
   down, the deterministic scaffold produces the JSON instead and the renderer runs
   unchanged. The response says `"servedBy": "scaffold"` so you know, but the buyer is
   never left empty-handed. This is what `test/services.test.ts` pins down — the whole
   suite runs with the provider keys stripped.
2. **Layout is never a model failure mode.** Broken tables, tofu boxes from emoji, missing
   page numbers — none of those are possible, because no model touches the layout.
3. **One content model, two outputs.** The same `Block[]` renders to PDF and to Markdown,
   so `format=markdown` can never drift away from `format=pdf`.

---

## Quickstart

Node 20+. Nothing else — no database, no native dependencies, no API key needed to start.

```bash
npm install
cp .env.example .env
npm test          # 156 tests, fully offline
npm run demo      # writes one real sample per service into samples/
npm run dev       # http://localhost:8402
```

**With no LLM keys set, everything above still works.** `providerChain()` returns an empty
list, the engine falls back to its built-in deterministic scaffold, and you get real,
correctly structured PDFs offline. Add keys to `.env` when you want researched content —
any subset of the four providers is fine.

The shipped default is `PAYMENT_MODE=mock`, so every `/v1/*` route returns a 402 shaped
like the real one and the header `x-passit-mock-payment: 1` bypasses it. That header is a
dev/test tool and does nothing in `live` mode.

Other scripts: `npm run build` (tsc → `dist/`), `npm start` (run the build),
`npm run typecheck`, `npm run compliance -- <url>` (runs the OKX review checklist against
a live server).

---

## Endpoint reference

### Paid routes

Both `POST` (JSON body) and `GET` (query params) are registered for every service, so a
buyer's agent can use whichever it prefers.

| Route | Required | Optional |
| --- | --- | --- |
| `POST\|GET /v1/quick-reviewer` | `topic` | `materials`, `format` (`pdf`\|`markdown`\|`flashcards`\|`cheatsheet`), `language` |
| `POST\|GET /v1/full-reviewer` | `subject` (or `topic`) | `materials`, `format` (`pdf`\|`markdown`\|`flashcards`\|`cheatsheet`), `language` |
| `POST\|GET /v1/mock-exam` | `target` (or `topic`) | `style` (`multiple_choice`\|`qa`\|`true_false`\|`mixed`), `count` (3–50), `materials`, `format` (`pdf`\|`markdown`), `language` |
| `POST\|GET /v1/explain-this` | `problem` (or `question`) | `materials`, `format` (`pdf`\|`markdown`), `language` |
| `POST\|GET /v1/exam-pack` | `exam` | `topics`, `materials`, `format` (`pdf`\|`markdown`), `language` |

A missing required parameter returns `400` with the parameter list, before any generation
runs. Requests carrying `materials` are never cached — that content belongs to the buyer
who paid for it.

### Free routes

| Route | Purpose |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP, stateless. All five services as tools of the same id. `GET`/`DELETE` return 405 by design. |
| `GET /health` | `{"ok":true, …}` plus payment mode, CAIP-2 network, per-provider availability, cache size. This is what the uptime pinger hits. |
| `GET /` | Discovery document: brand, protocols, MCP endpoint, and all five services with price, endpoint, description and parameters. |
| `GET /.well-known/x402` | Pricing manifest — the exact route/price/network/asset table the paywall enforces. |
| `GET /brand/pfp.png` | 512×512 1:1 PNG, square corners. The avatar URL for ASP registration. |

### Getting a PDF

```bash
curl -s -X POST http://localhost:8402/v1/quick-reviewer \
  -H 'content-type: application/json' \
  -H 'x-passit-mock-payment: 1' \
  -d '{"topic":"Photosynthesis"}' \
  -o reviewer.pdf
```

```
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename="PassIt-photosynthesis-Quick-Reviewer.pdf"
X-PassIt-Summary: ...
```

The response body **is** the PDF. Nothing to unwrap.

### Getting JSON instead

Send `accept: application/json` (or add `?format=json`). Files come back base64-encoded.
This is also what you get automatically when a service returns more than one file — Exam
Pack, and any reviewer requested as `format=flashcards`.

```bash
curl -s -X POST http://localhost:8402/v1/explain-this \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -H 'x-passit-mock-payment: 1' \
  -d '{"problem":"Why does dividing by a fraction flip the fraction?"}'
```

```json
{
  "service": "explain_this",
  "summary": "…",
  "declined": false,
  "servedBy": "groq",
  "files": [
    {
      "filename": "PassIt-why-does-dividing-by-a-fraction-flip-the-Explain-This.pdf",
      "mimeType": "application/pdf",
      "size": 3366,
      "base64": "JVBERi0xLjMK…"
    }
  ],
  "disclaimer": "PassIt is a study aid. It is not for use during exams and does not guarantee results."
}
```

`servedBy` tells you which path produced the content: a provider id (`groq`, `mistral`,
`gemini`, `cerebras`, `openrouter`), `cache`, or `scaffold`.

---

## Using PassIt from an MCP client

The same five services are MCP tools at `POST /mcp` — Streamable HTTP, stateless, so no
session handling is required. Any MCP client that speaks Streamable HTTP works.

**Claude Code**

```bash
claude mcp add --transport http passit https://<your-host>/mcp
```

**Cursor / OpenClaw / anything reading an `mcpServers` config**

```json
{
  "mcpServers": {
    "passit": {
      "url": "https://<your-host>/mcp"
    }
  }
}
```

Then just ask: *"Make me a mock exam on Newton's Laws, 15 questions, multiple choice."*
The tool returns a text summary plus the file itself as an MCP resource — PDFs as a base64
blob, Markdown and CSV as text. Each result also carries one — and only one — suggested
next step (`src/config.ts` → `NEXT_STEP`).

Note that the x402 paywall is mounted on the `/v1/*` routes only, so the MCP endpoint is
not itself metered. Paid, settled calls are the `/v1/*` routes — that is what OKX.AI
registers and bills.

---

## Cost model

| Line item | Cost |
| --- | --- |
| Hosting | Render free web service (Singapore region). 750 instance-hours/month covers one service running 24/7. |
| Content generation | Free tiers only, no credit card: Groq 14,400 req/day → Mistral 1B tokens/month → Gemini 2.5 Flash 1,500 req/day → Cerebras 1M tokens/day → OpenRouter ~50 req/day. |
| Repeat topics | Served from the in-memory cache. Zero LLM calls. |
| All providers down | Deterministic scaffold. Zero LLM calls, and the buyer still gets a file. |
| Uptime pinger | UptimeRobot or cron-job.org, free tier. |
| Payment gas | None to PassIt. The buyer signs; the OKX facilitator submits and settles on X Layer. |
| Payment fees | None charged by this server. Settlement is USDT0, direct to `PAY_TO_ADDRESS`. |

**Marginal cost per call is effectively zero**, which is what makes a 0.001 USDT price
point coherent rather than a loss leader. The failover chain exists so that running out of
one free tier degrades to the next one instead of degrading to an outage — and the
scaffold exists so that running out of all four still returns a deliverable.

Render's free instance sleeps after ~15 minutes idle; a pinger on `/health` every ~10
minutes keeps it awake. See [`docs/DEPLOY.md`](docs/DEPLOY.md) §3.

---

## Project layout

```
passit/
├── src/
│   ├── index.ts            express app: /v1 routes, /mcp, /health, /, discovery
│   ├── config.ts           services, prices, networks, providers, cache, brand
│   ├── services.ts         the five services + delivery plumbing
│   ├── guards.ts           live-exam / ghostwriting refusals, input limits
│   ├── types.ts            shared content and delivery types
│   ├── brand.ts            generated 512×512 PFP bytes
│   ├── payment/okx.ts      x402 layer (live / mock / disabled), route manifest
│   ├── engine/
│   │   ├── providers.ts    provider chain, failover, cooldown bench
│   │   ├── generate.ts     prompts → zod-validated JSON → repair → scaffold
│   │   ├── prompts.ts      the prompt set
│   │   ├── verify.ts       answer-key re-solve for mock exams
│   │   └── cache.ts        in-memory LRU, keyed by service+topic+language
│   ├── mcp/server.ts       the same five services as MCP tools
│   └── render/
│       ├── blocks.ts       content → Block[] document model
│       ├── pdf.ts          Block[] → PDF (pdfkit)
│       └── markdown.ts     Block[] → Markdown, flashcards → CSV
├── scripts/
│   ├── demo.ts             npm run demo — one real sample per service
│   ├── compliance-check.ts npm run compliance — the OKX review checklist, live
│   └── make-pfp.ts         regenerates brand/passit-pfp.png and src/brand.ts
├── test/                   156 tests, no network, no keys
├── samples/                `npm run demo` output — what a buyer actually receives (git-ignored)
├── docs/
│   ├── DEPLOY.md           Render deploy, testnet→mainnet, troubleshooting
│   └── REGISTRATION.md     registering and listing the ASP on OKX.AI
├── render.yaml             Render Blueprint (region singapore, plan free)
└── .env.example            every environment variable, annotated
```

- **[`docs/DEPLOY.md`](docs/DEPLOY.md)** — get it online: keys, Render, `PUBLIC_URL`, the
  uptime pinger, a testnet purchase, then mainnet. Includes the pre-registration
  checklist.
- **[`docs/REGISTRATION.md`](docs/REGISTRATION.md)** — register and list the ASP on OKX.AI.
- **[`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md)** — shot-by-shot script for the 90-second
  demo video.

---

## Rules

These are enforced in `src/guards.ts`, before any paid generation runs — not in a prompt,
so no phrasing gets around them.

1. **Study aid only.** PassIt makes material you study *from*. That is the whole product.
2. **No live-exam help.** A request that reads as an exam in progress is refused, with a
   note to come back afterwards. No file is generated.
3. **No ghostwriting.** PassIt does not write essays, assignments or homework to be
   submitted as someone's own work. It offers a reviewer or a practice test instead.
4. **No guarantee of results.** Nothing in this repo, in the delivered PDFs, or in the
   marketplace listing claims PassIt makes you pass. "Study this first" and "most likely
   on the exam" are study suggestions derived from the topics you supplied — not
   predictions, and never a guarantee. Every delivered file carries the disclaimer.

---

## License

See [LICENSE](LICENSE).
