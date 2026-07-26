# PassIt — OKX.AI ASP Registration Guide

Audience: the person who owns this project. This is the "how do I actually get listed"
document. Deploy first (`docs/DEPLOY.md`), then work through this top to bottom.

Registration mode: **A2MCP (pay-per-call)**. Fully automatic — billed and settled per
call, no escrow, no negotiation, no arbitration.

---

## 1. Who does what

This is the part people get wrong. Three separate actors, and they never overlap.

### You (the human), in Claude Code

You run four prompts, once, by hand. Registration is a **human action in a Claude Code
conversation**, not something the server does and not something you can automate from
the codebase. You need a Claude Pro / Max / Team / Enterprise subscription (or a Google
account) to run them.

You also paste the service names, descriptions, prices and endpoint URLs when the agent
asks for them. Those exact strings are in section 4 below.

### The Render server, automatically, forever after

Once you are listed, the deployed service handles every customer with no human in the
loop:

1. A buyer's agent calls `POST https://<your-host>/v1/<route>`.
2. The x402 middleware returns **402** with a base64 `PAYMENT-REQUIRED` header.
3. The buyer's agent signs a USDT0 payment on X Layer and retries.
4. The OKX facilitator verifies and settles it. With `OKX_SYNC_SETTLE=true` the server
   waits for on-chain confirmation **before** the handler runs.
5. The handler generates the study material and returns the PDF.

You do not approve anything. You do not touch anything. Money lands at
`PAY_TO_ADDRESS`.

### The LLM providers, in a corner, doing one job

Groq, Mistral, Gemini, Cerebras and OpenRouter **write the study content and nothing
else**. They:

- never see a payment,
- never talk to OKX,
- never know a purchase happened,
- are interchangeable — the server fails over between them and falls back to a built-in
  deterministic scaffold if all five are down, so a paying buyer always receives a file.

If an LLM key expires, sales still complete. If OKX credentials are wrong, nothing
sells. They are unrelated systems.

| Question | Answer |
| --- | --- |
| Who registers the ASP? | You, in Claude Code, once |
| Who serves buyers? | The Render service, automatically |
| Who handles payment? | The OKX Payment SDK + OKX facilitator, inside the server |
| Who writes the content? | The LLM providers (or the scaffold) |
| Who touches OKX credentials? | Only the server, only in `PAYMENT_MODE=live` |

---

## 2. Before you run the prompts

From `docs/DEPLOY.md` section 8 — all of these must already be true:

- [ ] `https://<your-host>/health` returns `{"ok": true, …}`
- [ ] `PAYMENT_MODE=live`, `X402_NETWORK=xlayer`, `X402_ASSET` blank
- [ ] Unpaid `POST /v1/quick-reviewer` → 402 + `PAYMENT-REQUIRED` header
- [ ] `https://<your-host>/brand/pfp.png` loads as a PNG
- [ ] One real end-to-end purchase done (testnet counts) — PDF + tx hash saved
- [ ] `npm run compliance -- https://<your-host>` prints
      `All checks passed. Safe to register this endpoint on OKX.AI.`

Have these to hand while the agent asks questions:

- your public host, e.g. `https://passit.onrender.com`
- the email you use for the Agentic Wallet
- section 3 (agent name/description) and section 4 (the five services) of this file

---

## 3. The agent-level listing

This is PassIt as one ASP, before the individual services.

```
Name:      PassIt

Tagline:   Type your topic. Get your reviewer.

Category:  Lifestyle

Description:
PassIt turns a topic into printable PDF study material. Five pay-per-call
services: a 1-2 page quick reviewer, a multi-topic study guide, a mock exam
with an explained answer key, a single-question explainer, and a full exam
pack. Every call returns a ready-to-print PDF. Pay-per-call over x402 on
X Layer, settled in USDT0. PassIt is a study aid. It is not for use during
exams and does not guarantee results.

Endpoint (A2MCP / MCP):  https://<your-host>/mcp
Discovery:               https://<your-host>/
Pricing manifest:        https://<your-host>/.well-known/x402
Health:                  https://<your-host>/health
Profile picture:         https://<your-host>/brand/pfp.png
Payment network:         eip155:196  (X Layer mainnet)
Settlement token:        USDT0  0x779ded0c9e1022225f8e0630b35a9b54be713736
Price range:             0.001 – 1.0 USDT per call
```

Do not embellish this description. OKX rejects listings that over-hype. Everything
above is verifiable by calling the endpoints. The last sentence is the disclaimer the
server itself returns in every JSON response.

---

## 4. The five services — fill-in blocks

Descriptions below are copied **verbatim** from the `description` fields in
`src/config.ts`. Do not rewrite them. They are the same strings the server puts in the
402 challenge and in `GET /`, so a reviewer comparing the listing against the live
endpoint sees an exact match.

Replace `<your-host>` with your Render host (e.g. `passit.onrender.com`) everywhere.

### 4.1 Quick Reviewer

```
Service name:  Quick Reviewer
Service id:    quick_reviewer
Price:         0.1 USDT per call
Endpoint:      https://<your-host>/v1/quick-reviewer
MCP tool:      quick_reviewer   (POST https://<your-host>/mcp)
Required parameter: topic

Description:
Generates a printable 2-3 page PDF reviewer for one topic, broken into sections: a summary, simple explanations with worked examples, memory aids, key-facts tables, a priority list, and self-check questions. Study aid only - does not guarantee exam results.

Parameters:
  1. topic
  2. optional notes/material
  3. optional format (pdf, markdown, flashcards, cheatsheet)
  4. optional language
```

### 4.2 Full Reviewer

```
Service name:  Full Reviewer
Service id:    full_reviewer
Price:         0.5 USDT per call
Endpoint:      https://<your-host>/v1/full-reviewer
MCP tool:      full_reviewer   (POST https://<your-host>/mcp)
Required parameter: subject

Description:
Generates a complete multi-topic study guide as one PDF: contents page, one section per topic with explanations, memory aids and tables, cross-topic comparison tables, a priority list, and a self-check. Study aid only - does not guarantee exam results.

Parameters:
  1. subject or topic list
  2. optional notes/material
  3. optional format (pdf, markdown, flashcards, cheatsheet)
  4. optional language
```

### 4.3 Mock Exam

```
Service name:  Mock Exam
Service id:    mock_exam
Price:         0.3 USDT per call
Endpoint:      https://<your-host>/v1/mock-exam
MCP tool:      mock_exam   (POST https://<your-host>/mcp)
Required parameter: target

Description:
Generates a practice test as a printable PDF with an answer key that explains every answer. Answers are checked before delivery. Study aid only - does not guarantee exam results.

Parameters:
  1. topic, subject or exam name
  2. optional style (multiple_choice, qa, true_false, mixed)
  3. optional question count
  4. optional language
```

### 4.4 Explain This

```
Service name:  Explain This
Service id:    explain_this
Price:         0.001 USDT per call
Endpoint:      https://<your-host>/v1/explain-this
MCP tool:      explain_this   (POST https://<your-host>/mcp)
Required parameter: problem

Description:
Explains one confusing question or topic as a PDF: the correct answer, step-by-step reasoning in plain words, one memory aid, and 2-3 retry questions. Also checks an answered quiz and reports which items were wrong and why. Study aid only.

Parameters:
  1. the question, topic, or answered quiz
  2. optional material
  3. optional language
```

### 4.5 Exam Pack

```
Service name:  Exam Pack
Service id:    exam_pack
Price:         1.0 USDT per call
Endpoint:      https://<your-host>/v1/exam-pack
MCP tool:      exam_pack   (POST https://<your-host>/mcp)
Required parameter: exam

Description:
Generates a complete exam-prep bundle: one organized PDF containing a full reviewer, flashcards, a priority topic list, and a 20-question mock exam with explained answer key, plus the flashcards as an importable CSV. Priority items are study suggestions, not predictions. Study aid only.

Parameters:
  1. exam name
  2. topics or syllabus
  3. optional material
  4. optional language
```

### 4.6 Price cross-check

If the form asks for an on-chain amount rather than a decimal, use the atomic value
(USDT0 has 6 decimals). These are the exact numbers your 402 challenge advertises:

| Service | Price | Atomic amount |
| --- | --- | --- |
| Quick Reviewer | 0.1 USDT | `100000` |
| Full Reviewer | 0.5 USDT | `500000` |
| Mock Exam | 0.3 USDT | `300000` |
| Explain This | 0.001 USDT | `1000` |
| Exam Pack | 1.0 USDT | `1000000` |

Verify against the live server before you submit:

```bash
curl -s https://<your-host>/.well-known/x402
```

---

## 5. The four prompts

Run these in Claude Code, in this order, one at a time. Type them verbatim.

### Prompt 1 — install the OKX skills

```
npx skills add okx/onchainos-skills --yes -g
```

**Expect:** the OKX Onchain OS skill pack installs globally. After this, Claude Code
knows the OKX registration workflow. Run it once per machine.

### Prompt 2 — log in to the Agentic Wallet

```
Log in to Agentic Wallet on Onchain OS with my email
```

**Expect:** you are asked for your email address and then to confirm a login (check
your inbox). On success you have an OKX Agent Identity and an Agentic Wallet address.

**Do this now:** if that wallet address differs from the `PAY_TO_ADDRESS` you deployed
with, update `PAY_TO_ADDRESS` in Render, redeploy, and re-run
`npm run compliance -- https://<your-host>`. Payments settle to whatever address the
402 challenge advertises — the compliance check prints it as `accepts[0].payTo`.

**Remember which email you used.** The review result is sent there.

### Prompt 3 — register the ASP

```
Help me register an A2MCP ASP on OKX.AI using OKX Agent Identity from Onchain OS
```

**Expect:** a guided conversation that creates the ASP under your Agent Identity in
A2MCP mode. You will be asked for the agent-level details — paste from section 3:
name, description, category, and the endpoint. Have the PFP URL ready
(`https://<your-host>/brand/pfp.png`).

At the end you receive an **Agent ID**. Save it somewhere you will not lose it.

### Prompt 4 — list the services

```
Help me list my ASP on OKX.AI using Onchain OS
```

**Expect:** for each service you are asked for **service name, description, price per
call, and endpoint URL**. Paste them from section 4 — one block per service, five times.
Then you submit for review.

**Expect after submitting:** a confirmation in the agent conversation window that the
listing is under review.

---

## 6. OKX review checklist — how PassIt satisfies each item

Walk this list before you submit. Every item is checkable from your laptop.

### ☐ 1. Endpoint online

- **How it is satisfied:** the Render service answers `GET /health` with
  `{"ok": true, …}`, and Render itself is configured with `healthCheckPath: /health`.
  An UptimeRobot / cron-job.org ping every 10 minutes stops the free instance sleeping
  after ~15 minutes idle, so a reviewer never lands on a cold or dead host.
- **Verify:** `curl -s https://<your-host>/health`
- **Also covered by:** `npm run compliance` → group `health`.

### ☐ 2. Tested as a user — deliverable received and payment made

- **How it is satisfied:** you complete one real end-to-end purchase before
  registering, following `docs/DEPLOY.md` section 6. Do it on X Layer testnet with
  faucet funds so it costs nothing; the code path is identical to mainnet. The buyer
  gets a 402, signs a USDT0 payment, the OKX facilitator settles it, and — because
  `OKX_SYNC_SETTLE=true` — the PDF is only released after on-chain confirmation.
- **Verify:** you are holding the returned PDF and the transaction hash.
- **Keep both.** If review asks for evidence, that is the evidence.

### ☐ 3. PFP is 1:1 with no curved corners

- **How it is satisfied:** `scripts/make-pfp.ts` renders a **512×512** PNG — exactly
  1:1, hard square edges, no rounded corners, no transparency — and the server serves
  it at `GET /brand/pfp.png` as `image/png`. Use that URL (or download the file and
  upload it) during registration.
- **Verify:** `curl -sI https://<your-host>/brand/pfp.png` → `content-type: image/png`,
  then open it and confirm the square corners.
- **Regenerate if needed:** `npx tsx scripts/make-pfp.ts`
- **Also covered by:** `npm run compliance` → group `brand`.

### ☐ 4. Description accurately represents output — rejected if it over-hypes

- **How it is satisfied:** every description in section 4 is copied verbatim from
  `src/config.ts`, so the marketplace listing, the discovery document at `GET /`, and
  the `description` inside the 402 challenge are the same string. Each one states what
  the PDF actually contains and carries the study-aid disclaimer. There is no claim
  about passing, scores, or exam prediction anywhere — Exam Pack explicitly says
  "Priority items are study suggestions, not predictions."
- **Verify:** `curl -s https://<your-host>/ | grep -o '"description":[^,]*'` and compare
  against what you pasted.
- **Do not** add "guaranteed pass", "ace your exam", "AI-powered exam predictor" or
  anything similar. That is the fastest way to get rejected.

### ☐ 5. 402 challenge network is the CAIP-2 value `eip155:196`

- **How it is satisfied:** `X402_NETWORK=xlayer` maps to `caip2: "eip155:196"` in
  `src/config.ts`, and that value is what the middleware puts in
  `accepts[0].network` of every challenge.
- **Verify:**
  ```bash
  curl -s -D - -o /dev/null -X POST https://<your-host>/v1/quick-reviewer \
    -H 'content-type: application/json' -d '{}' \
    | awk 'tolower($1)=="payment-required:"{print $2}' | tr -d '\r' | base64 -d
  ```
  `"network":"eip155:196"` must be present.
- **Also covered by:** `npm run compliance` → `accepts[0].network` for all five
  services. It also **warns** if you are still on testnet (`eip155:1952`).

### ☐ 6. Payment token is USDT0 `0x779ded0c9e1022225f8e0630b35a9b54be713736`

- **How it is satisfied:** the mainnet USDT0 contract and its 6 decimals are baked into
  `src/config.ts`. Leave `X402_ASSET` **blank** in production so the built-in value is
  used; the EIP-712 domain `{ name: "USD₮0", version: "1" }` is sent with it, per the
  OKX challenge spec.
- **Verify:** the same decoded challenge above must show
  `"asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736"`.
- **Also covered by:** `npm run compliance` → `accepts[0].price.asset`, plus
  `accepts[0].price.amount` (the atomic price) and `accepts[0].payTo` (your wallet — it
  warns loudly if empty, because every sale would settle to nowhere).

### One command that checks 1, 3, 5 and 6 at once

```bash
npm run compliance -- https://<your-host>
```

Green output ends with `All checks passed. Safe to register this endpoint on OKX.AI.`
Items 2 and 4 are the two a script cannot check for you — the real purchase and the
honesty of the copy. Do those yourself.

---

## 7. After you submit

1. **Review completes within 24 hours.**
2. **The result arrives in two places:** the email registered with your Agentic Wallet
   (prompt 2), and the Claude Code agent conversation window where you registered.
3. **Your ASP is usable before approval.** Even while review is pending, it can be
   found and called via its **Agent ID**. You can hand that ID to a buyer's agent and
   take real payments immediately.
4. **Do not change anything while under review.** In particular do not change
   `PUBLIC_URL`, `PAY_TO_ADDRESS`, prices, or the service descriptions — a reviewer
   comparing the listing against a live endpoint that no longer matches will fail it.
5. **Keep the pinger running.** A sleeping free instance during the review window looks
   like an offline endpoint (review item 1).
6. **If it is rejected**, the message says why. The two common causes map to the
   checklist: description over-claims (item 4 — trim it back to the verbatim strings in
   section 4), or the endpoint was unreachable / wrong network at review time (items 1
   and 5 — re-run the compliance check and resubmit).

### After approval — day-to-day

- **Monitor:** `https://<your-host>/health` shows payment mode, network, per-provider
  availability and cache stats. Your uptime pinger already hits it.
- **Money:** settles per call to `PAY_TO_ADDRESS`. A2MCP has no escrow and no invoices —
  each call is billed and settled on its own.
- **Changing a price or description:** edit `SERVICES` in `src/config.ts`, redeploy,
  re-run `npm run compliance -- https://<your-host>`, then update the OKX listing so it
  still matches the live endpoint. Listing and endpoint must never disagree.
