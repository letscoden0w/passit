# PassIt — 90-Second Demo Script

One take, 90 seconds hard maximum. The video has to prove five things in order:
a topic goes in → a 402 challenge comes back → a USDT0 payment settles → a real PDF opens
→ the price ladder runs 0.001 to 1.0 USDT. Everything else is cut.

Nothing in the narration claims PassIt makes anyone pass. It is a study aid; say what it
does, show the file, stop.

---

## Pre-recording checklist

Do all of this **before** you hit record. Every item here is something that ruins a take
if it is missing.

### The service

- [ ] Deployed and on `PAYMENT_MODE=live`, `X402_NETWORK=xlayer` (or `xlayer-testnet` if
      you are demoing with faucet funds — say so in the caption if you do).
- [ ] `npm run compliance -- https://<host>` prints
      `All checks passed. Safe to register this endpoint on OKX.AI.`
- [ ] **Warm the instance.** Render free sleeps after ~15 min idle and a cold start is
      long enough to kill a 90-second video. Hit `https://<host>/health` about a minute
      before recording, and confirm `"ok": true`.
- [ ] `curl -s https://<host>/health` shows at least one provider `available: true`. You
      do not want `"servedBy": "scaffold"` in the take.
- [ ] **Warm the cache** by running the exact demo topic once before recording. The second
      call is served from the in-memory cache, which makes generation near-instant on
      camera. Do it after the last redeploy — a restart clears the cache.

### The wallet

- [ ] Buyer wallet funded with USDT0 on the network you are demoing, plus a little OKB if
      you are on testnet (https://www.okx.com/xlayer/faucet/xlayerfaucet).
- [ ] Do one full rehearsal purchase end to end. Confirm the tx lands and the PDF opens.
- [ ] Fund enough for at least three attempts — you will not nail it first take.
- [ ] Balances on screen should be boring. No six-figure portfolio in the corner.

### Windows to have open (and nothing else)

1. **Terminal** — dark theme, font 18–20pt, window sized so a 402 body fits without
   scrolling. Prompt shortened to something like `passit ~ $`.
2. **PDF viewer** — already pointed at the folder the download lands in, zoom preset to
   "fit width" so page 1 fills the frame the moment it opens.
3. **Wallet / explorer tab** — the X Layer transaction view, so the settled transfer is
   one click away.
4. Close everything else. No Slack, no email, no notifications. Do Not Disturb on.

### Screen and audio

- [ ] Record at 1920×1080, 30fps minimum.
- [ ] Desktop cleared, no personal filenames visible.
- [ ] `.env`, API keys, secret keys and passphrases are **not** on screen at any point.
      Re-check the terminal scrollback before you record.
- [ ] Wallet address on screen is fine and actually helps — it matches the `payTo` in the
      challenge. Just make sure it is the one you meant to show.
- [ ] Pre-type the long commands into shell history so you can recall them with ↑ instead
      of typing them live. Type only the topic.

### The topic

Use a topic that is instantly legible at a glance, needs no setup, and produces a PDF with
a visible table.

- **Primary: `Photosynthesis`** — universally understood, one word, and the generated
  reviewer reliably has a key-facts table that reads well when scrolled.
- Backups: `Newton's Laws of Motion`, `Basic Algebra`, `Cell Structure`.
- Avoid: anything niche, anything long enough to be a typing shot, and anything where a
  viewer might argue with the content instead of watching the mechanism.

Run `npm run demo` first — it writes `samples/` (git-ignored, so a fresh clone has none).
Have `samples/PassIt-photosynthesis-Quick-Reviewer.pdf` ready as a fallback B-roll clip in
case the live PDF shot goes wrong — but the payment shot must be real.

---

## Shot list

Total 90 seconds. Timings are cumulative.

### 0:00 – 0:07 · Hook

**On screen:** Terminal, empty. A single line of large text overlaid: **PassIt — type your
topic, get your reviewer.**

**Say:** "This is an AI agent that sells study material. It takes a topic and returns a
printable PDF. It gets paid per call, on chain, with no invoice and no subscription."

---

### 0:07 – 0:18 · Type the topic

**On screen:** Type the request live. Type only the topic — the rest is recalled from
history.

```bash
curl -s -X POST https://<host>/v1/quick-reviewer \
  -H 'content-type: application/json' \
  -d '{"topic":"Photosynthesis"}' -i
```

Hit enter. Do not cut away.

**Say:** "One topic — photosynthesis. That's the whole input. Watch what comes back before
the file does."

---

### 0:18 – 0:33 · The 402 challenge

**On screen:** The response. Let it sit long enough to read. Highlight or zoom on three
lines:

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoi…
```

```json
{"x402Version":2,
 "accepts":[{"scheme":"exact",
   "network":"eip155:196",
   "price":{"asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736",
            "amount":"100000"}}]}
```

**Optional overlay** decoding the numbers for anyone who doesn't read hex:
`eip155:196 = X Layer` · `USDT0` · `100000 = 0.1 USDT`

**Say:** "402 — payment required. That's the x402 protocol. The challenge names the chain,
X Layer, the token, USDT0, and the exact amount: a hundred thousand units, which is one
tenth of a USDT."

---

### 0:33 – 0:48 · The payment settles

**On screen:** Cut to the buyer side paying — the agent signing and retrying, then the
wallet or X Layer explorer showing the USDT0 transfer **confirmed**. Hold on the confirmed
state and the amount for a beat. Then cut back to the terminal, which is now writing the
PDF.

**Say:** "The buyer's agent signs the payment and retries. It settles on X Layer, and the
server waits for on-chain confirmation before it hands anything over. No escrow, no
negotiation, no human in the loop."

---

### 0:48 – 1:10 · The PDF

**On screen:** The PDF opens. Page 1 fills the frame — the PassIt header band, the title,
the "At a glance" callout. Then scroll, steadily and slowly, through:

- the explanation sections
- the **memory trick** callout
- the **key-facts table** — pause half a second here, it's the shot that proves this is a
  laid-out document and not a wall of chat text
- "Study this first"
- the Quick check questions and the answers callout
- the footer: *PassIt • study aid — not for use during exams · Page 1 of 2*

**Say:** "And that's the deliverable. A real PDF — laid out, printable, with tables, a
memory trick, a priority list and self-check questions. The model writes structured
content. The layout is generated by code, because a language model can't emit a binary
file. That split is the entire product."

---

### 1:10 – 1:22 · The price ladder

**On screen:** Five rows appearing one at a time, cheapest first, with the price on the
left:

```
  0.001 USDT    Explain This     one confusing question, explained
  0.1   USDT    Quick Reviewer   one topic, 1–2 pages
  0.3   USDT    Mock Exam        practice test + explained answer key
  0.5   USDT    Full Reviewer    multi-topic study guide
  1.0   USDT    Exam Pack        reviewer + flashcards + 20-question mock exam
```

Use a clean overlay card for legibility. If you would rather show it as live data, this
one-liner returns the same list from the running server — have it pre-typed in history:

```bash
curl -s https://<host>/ | jq -r '.services | sort_by(.price|split(" ")[0]|tonumber)
  | .[] | "\(.price)\t\(.title)"'
```

(The server prints Exam Pack as `1 USDT/use`, not `1.0` — same price, just JSON number
formatting. Match your overlay to whichever you show.)

**Say:** "Five services, priced from a tenth of a cent to one USDT. Pay for one
explanation, or a whole exam pack. Each call is billed and settled on its own."

---

### 1:22 – 1:30 · Close

**On screen:** The PassIt mark, the endpoint URL, and the hashtag. Nothing else.

**Say:** "Agent to agent. Machine-priced, machine-paid, and what comes back is a file you
can actually print. Study aid — it won't sit your exam for you."

**End card:**

```
PassIt — type your topic, get your reviewer.
Live on OKX.AI · x402 · X Layer

#OKXAI
```

---

## Timing sheet

| Segment | In | Out | Length |
| --- | --- | --- | --- |
| Hook | 0:00 | 0:07 | 7s |
| Type the topic | 0:07 | 0:18 | 11s |
| 402 challenge | 0:18 | 0:33 | 15s |
| Payment settles | 0:33 | 0:48 | 15s |
| The PDF | 0:48 | 1:10 | 22s |
| Price ladder | 1:10 | 1:22 | 12s |
| Close + #OKXAI | 1:22 | 1:30 | 8s |

Narration is roughly 195 words. If you run long, cut from the hook and the close — never
from the 402 shot or the PDF scroll, which are the two things people are watching for.

---

## Editing notes

- **Do not speed-ramp the payment shot.** A sped-up settlement reads as faked. If it takes
  eight seconds, show eight seconds and talk over them.
- Speed-ramping the *PDF scroll* is fine, up to about 1.5×.
- Keep the terminal legible at phone size. If you cannot read the `amount` field on a
  6-inch screen, zoom in.
- Subtitles throughout. Most of this gets watched muted.
- One number on screen at a time. The 402 shot has three values worth reading; give each
  its own beat rather than highlighting all three at once.

---

## Caption options

All of these are factual and verifiable against the running endpoint. None of them claim
PassIt improves anyone's results.

**1 — mechanism first**

> Typed one topic. Got a 402, paid 0.1 USDT on X Layer, got back a printable PDF reviewer.
> No account, no invoice, no subscription — agent pays agent, per call.
> PassIt is live on OKX.AI. #OKXAI

**2 — the build insight**

> A language model can't emit a binary file. So PassIt has the model write structured JSON
> and lets code render the PDF. Model does content, pdfkit does layout — which is why the
> tables line up and why a paying buyer always gets a file. #OKXAI

**3 — the price point**

> 0.001 USDT to have one confusing question explained. 1.0 USDT for a full exam pack —
> reviewer, flashcards, and a 20-question mock exam with an explained answer key.
> Billed and settled per call over x402 on X Layer. #OKXAI

**4 — short**

> Type your topic. Get your reviewer.
> Study PDFs, paid per call in USDT0 on X Layer. Live on OKX.AI. #OKXAI

**5 — for the builder audience**

> Shipped an x402 Agent Service Provider on OKX.AI: five endpoints, 0.001–1.0 USDT,
> settling in USDT0 on X Layer. Free LLM tiers with failover, and a deterministic fallback
> so a paid call never returns empty-handed. #OKXAI

### Good pinned reply / thread continuation

> Verify it yourself — an unpaid call returns the challenge:
> `curl -i -X POST https://<host>/v1/quick-reviewer -H 'content-type: application/json' -d '{}'`
> `network: eip155:196` · `asset: 0x779ded0c9e1022225f8e0630b35a9b54be713736` (USDT0) ·
> `amount: 100000`

### Wording to avoid

Not stylistic preferences — these are claims PassIt does not make, and OKX rejects
over-hyped descriptions:

- "guaranteed pass", "pass your exam", "ace your exam", "get an A"
- "predicts what's on the exam" — the priority list is a study suggestion derived from the
  topics the buyer supplied, nothing more
- "replaces studying", "no studying needed"
- "the smartest / best / #1 study tool"
- Anything implying it can be used *during* an exam. It refuses those requests in code.
