# PassIt — Deploy Guide

Audience: the person who owns this project. You do not need to be a backend engineer.
Follow the steps in order. Every command and URL below is copy-pasteable.

What you are deploying: one Node web service that serves five paid endpoints
(`/v1/quick-reviewer`, `/v1/full-reviewer`, `/v1/mock-exam`, `/v1/explain-this`,
`/v1/exam-pack`), an MCP endpoint at `POST /mcp`, plus `/health`, `/`,
`/.well-known/x402` and `/brand/pfp.png`.

---

## 0. What you need before you start

| Thing | Where | Cost |
| --- | --- | --- |
| GitHub repo with this code | already pushed, branch `claude/okx-ai-agent-provider-6uj5lk` | free |
| Render account | https://render.com | free plan |
| Groq API key | https://console.groq.com/keys | free, **no credit card** |
| Mistral API key | https://console.mistral.ai | free, **no credit card** |
| Gemini API key | https://aistudio.google.com/apikey | free, **no credit card** |
| Cerebras API key | https://cloud.cerebras.ai | free, **no credit card** |
| OKX API key / secret / passphrase | https://web3.okx.com/onchainos/dev-portal | free |
| Receiving wallet address | your OKX Agentic Wallet (EVM `0x…` address) | free |
| Uptime pinger account | https://uptimerobot.com or https://cron-job.org | free |

### About the LLM keys

1. **No credit card is required for any of the four LLM providers.** Groq, Mistral,
   Google AI Studio and Cerebras all issue a usable key from a plain sign-up.
2. You do **not** need all four. Any subset works. With **zero** keys the server still
   returns real PDFs from the built-in deterministic scaffold — see
   [`"servedBy": "scaffold"`](#servedby-scaffold) below.
3. Recommended minimum: **Groq + one other**. Groq is first in the failover chain and
   has the widest free allowance (14,400 requests/day); a second key covers you when
   Groq rate-limits.
4. Order and failover are controlled by `LLM_PROVIDERS`. Default:
   `groq,mistral,gemini,cerebras`.

### Getting each key (click path)

1. **Groq** — https://console.groq.com/keys → sign in → *Create API Key* → copy.
   Set as `GROQ_API_KEY`.
2. **Mistral** — https://console.mistral.ai → sign in → *API Keys* → create key → copy.
   Set as `MISTRAL_API_KEY`. Free tier is 1B tokens/month.
3. **Google Gemini** — https://aistudio.google.com/apikey → sign in with a Google
   account → *Create API key* → copy. Set as `GEMINI_API_KEY`. Free tier is
   1,500 requests/day on `gemini-2.5-flash`.
4. **Cerebras** — https://cloud.cerebras.ai → sign in → API keys → create → copy.
   Set as `CEREBRAS_API_KEY`. Free tier is 1M tokens/day.
5. **OKX** — https://web3.okx.com/onchainos/dev-portal → create a project → you get
   three values. Set them as `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`.
   These are only used when `PAYMENT_MODE=live`; they let the server verify and settle
   x402 payments through the OKX facilitator.

> Keep every key out of git. Nothing secret is committed — `render.yaml` marks all
> secrets `sync: false`, which means Render asks you for them in the dashboard.

---

## 1. Run it once locally (5 minutes, optional but recommended)

```bash
cd /workspace/passit
cp .env.example .env          # fill in what you have; blanks are fine
npm ci
npm run build
npm test
npm run dev                   # http://localhost:8402
```

In a second terminal:

```bash
curl -s http://localhost:8402/health
curl -s http://localhost:8402/ | head -40
npm run compliance            # checks localhost:8402 by default
```

With the shipped default `PAYMENT_MODE=mock` you get a 402 on every `/v1/*` route,
and the header `x-passit-mock-payment: 1` bypasses it so you can see a real PDF:

```bash
curl -s -X POST http://localhost:8402/v1/quick-reviewer \
  -H 'content-type: application/json' \
  -H 'x-passit-mock-payment: 1' \
  -d '{"topic":"Photosynthesis"}' -o quick.pdf
```

`x-passit-mock-payment` only works in `PAYMENT_MODE=mock`. It is a dev/test tool.
It does nothing in `live` mode.

You can also generate one sample per service with no HTTP and no paywall:

```bash
npm run demo                  # writes into samples/
```

---

## 2. Deploy to Render

There are two paths. **Path A (Blueprint)** is fewer clicks because `render.yaml`
already pins the region, plan, build and start commands. **Path B (manual)** is there
if you prefer clicking.

### Path A — Blueprint (recommended)

1. Push your branch to GitHub.
2. Go to https://dashboard.render.com → **New +** → **Blueprint**.
3. Connect the GitHub repo and pick branch `claude/okx-ai-agent-provider-6uj5lk`.
4. Render reads `render.yaml` and shows one web service named `passit`, region
   **Singapore**, plan **Free**. Confirm those are what you see.
5. Render prompts for every value marked `sync: false`. Paste them (see the table in
   step 3 below). Leave `PUBLIC_URL` blank for now if it lets you — you will set it in
   step 4.
6. Click **Apply**. The first build runs `npm ci && npm run build`, then
   `node dist/index.js`.

### Path B — manual web service

1. https://dashboard.render.com → **New +** → **Web Service**.
2. Connect the GitHub repo, branch `claude/okx-ai-agent-provider-6uj5lk`.
3. Fill in:
   - **Name**: `passit`
   - **Region**: **Singapore** — *not Hong Kong*. AI API vendors refuse Hong Kong
     nodes, so a Hong Kong instance will get its LLM calls rejected.
   - **Runtime**: Node
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `node dist/index.js`
   - **Instance Type**: **Free**
4. Open **Advanced** → set **Health Check Path** to `/health`.
5. Add the environment variables (step 3), then **Create Web Service**.

### Step 3 — environment variables to paste

Non-secret values (safe to type in directly):

```
NODE_VERSION=22
NODE_ENV=production
PORT=8402
PAYMENT_MODE=mock
X402_NETWORK=xlayer
OKX_SYNC_SETTLE=true
LLM_PROVIDERS=groq,mistral,gemini,cerebras
GROQ_MODEL=llama-3.3-70b-versatile
MISTRAL_MODEL=mistral-large-latest
GEMINI_MODEL=gemini-2.5-flash
CEREBRAS_MODEL=llama-3.3-70b
PROVIDER_COOLDOWN_MINUTES=5
CACHE_ENABLED=true
CACHE_MAX_ENTRIES=500
CACHE_TTL_MINUTES=1440
```

Secrets — paste your own values:

```
PUBLIC_URL=            # set in step 4, after the first deploy
PAY_TO_ADDRESS=        # your OKX Agentic Wallet 0x… address
OKX_API_KEY=
OKX_SECRET_KEY=
OKX_PASSPHRASE=
X402_ASSET=            # leave BLANK on mainnet; required on testnet
X402_ASSET_DECIMALS=   # leave blank (defaults to 6)
GROQ_API_KEY=
MISTRAL_API_KEY=
GEMINI_API_KEY=
CEREBRAS_API_KEY=
```

Deploy with `PAYMENT_MODE=mock` first. It boots with anything missing, so you can
confirm the service is healthy before you turn on real money. You flip it to `live`
in step 5.

`X402_ASSET` stays **blank on mainnet**: the X Layer USDT0 address
`0x779ded0c9e1022225f8e0630b35a9b54be713736` (6 decimals) is built into
`src/config.ts`. You only set `X402_ASSET` on testnet, whose USDT0 address differs.

### Step 4 — set `PUBLIC_URL` (do not skip)

1. Wait for the first deploy to finish.
2. Render assigns a URL at the top of the service page, e.g.
   `https://passit.onrender.com`. Copy it exactly.
3. Go to **Environment** → set `PUBLIC_URL` to that **https** URL, with no trailing
   slash.
4. Save. Render redeploys automatically.

`PUBLIC_URL` is not cosmetic. It is what the server puts into the x402 challenge as
`resource.url`, and it is what OKX validates during review. If it is wrong, or is
`http://` instead of `https://`, live mode refuses to boot with
`PUBLIC_URL must be a public https:// address`.

### Step 5 — go live (after testnet, see section 6)

Once you have done one real end-to-end purchase on testnet:

1. **Environment** → `PAYMENT_MODE=live`, `X402_NETWORK=xlayer`, `X402_ASSET` blank.
2. Confirm `PAY_TO_ADDRESS`, `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` are
   all filled in — live mode fails at boot if any is missing.
3. Save, wait for the redeploy, then re-run the verification in section 5.

---

## 3. Keep the service awake (UptimeRobot or cron-job.org)

**Why.** A Render free web service **sleeps after about 15 minutes with no traffic**.
The next request has to wake it, which takes tens of seconds — long enough that a
buyer's agent may time out, and long enough that an OKX reviewer hitting a sleeping
endpoint sees a service that looks offline. Free plans also include **750 instance
hours per month**; a month is at most 744 hours, so a single service pinged 24/7 stays
inside the free allowance. Pinging every 10 minutes keeps you comfortably under the
~15-minute sleep threshold.

### UptimeRobot

1. Sign up at https://uptimerobot.com.
2. **+ New monitor**.
3. Monitor Type: **HTTP(s)**.
4. Friendly Name: `PassIt health`.
5. URL: `https://<your-render-host>/health`
6. Monitoring Interval: **10 minutes**.
7. Create. It should go green within a couple of minutes.

### cron-job.org (alternative)

1. Sign up at https://cron-job.org.
2. **Create cronjob**.
3. Title: `PassIt health`, URL: `https://<your-render-host>/health`.
4. Schedule: **every 10 minutes**.
5. Save and enable.

Run **one** pinger, not both. Two pingers do not make it more awake; they just use
more of your 750 hours if you ever add a second service.

---

## 4. What each endpoint is for

| Method + path | Paid? | Purpose |
| --- | --- | --- |
| `GET /health` | no | Liveness. Returns `{"ok":true, …}` plus payment mode, network, provider health, cache stats. This is what the pinger hits. |
| `GET /` | no | Discovery document: brand, protocols, and all five services with price, endpoint, description, parameters. |
| `GET /.well-known/x402` | no | Pricing manifest — the exact route/price/network/asset table the paywall enforces. |
| `GET /brand/pfp.png` | no | The 512×512 1:1 PNG profile picture for registration. |
| `POST /mcp` | no wrapper, paid tools | MCP Streamable HTTP. Each service is also an MCP tool of the same id. |
| `POST\|GET /v1/<route>` | **yes** | The five paid services. Both POST (JSON body) and GET (query params) are registered. |

---

## 5. Verify the deployment

Replace `<host>` with your Render host, e.g. `passit.onrender.com`.

### 5.1 Health

```bash
curl -s https://<host>/health
```

Expect HTTP 200 and JSON with `"ok": true`. The `providers` array tells you which LLM
keys the server actually picked up — an empty array means no keys were read.

### 5.2 Unpaid call must return 402 with a `PAYMENT-REQUIRED` header

```bash
curl -i -X POST https://<host>/v1/quick-reviewer \
  -H 'content-type: application/json' \
  -d '{}'
```

Expect:

- status line `HTTP/1.1 402 Payment Required`
- a response header `PAYMENT-REQUIRED: <long base64 string>`
- a JSON body containing `"x402Version": 2` and an `accepts` array

Decode the header to read the actual challenge:

```bash
curl -s -D - -o /dev/null -X POST https://<host>/v1/quick-reviewer \
  -H 'content-type: application/json' -d '{}' \
  | awk 'tolower($1)=="payment-required:"{print $2}' | tr -d '\r' | base64 -d
```

Check that `accepts[0].network` is `eip155:196`, `accepts[0].price.asset` is
`0x779ded0c9e1022225f8e0630b35a9b54be713736`, `accepts[0].price.amount` is `100000`
for Quick Reviewer, and `accepts[0].payTo` is your wallet.

The same table is served, un-encoded, at:

```bash
curl -s https://<host>/.well-known/x402
```

### 5.3 The compliance check

```bash
cd /workspace/passit
npm run compliance -- https://<host>
```

This is the single most useful command in this repo. It runs the OKX review checklist
against the *live* server: `/health`, `/`, `/brand/pfp.png`, then for each of the five
services it asserts 402, the `PAYMENT-REQUIRED` header, `x402Version: 2`, the CAIP-2
network, the USDT0 asset, the atomic amount, and a valid `payTo`. It exits `0` when
everything passes and `1` when anything fails, and prints a concrete fix for each
failure and warning.

Two things to know:

1. It compares its **own** environment against what the server reports. Run it from a
   directory whose `.env` has the same `X402_NETWORK`/`X402_ASSET` as Render, or it
   will (correctly) flag `env agreement`.
2. It **warns** — not fails — while `PAYMENT_MODE=mock` or while you are on testnet.
   Those warnings are expected during setup and must be gone before you register.

Expected pre-registration state: `All checks passed. Safe to register this endpoint on
OKX.AI.`

### 5.4 Expected atomic amounts

| Service | Route | Price | `price.amount` at 6 decimals |
| --- | --- | --- | --- |
| Quick Reviewer | `/v1/quick-reviewer` | 0.1 USDT | `100000` |
| Full Reviewer | `/v1/full-reviewer` | 0.5 USDT | `500000` |
| Mock Exam | `/v1/mock-exam` | 0.3 USDT | `300000` |
| Explain This | `/v1/explain-this` | 0.001 USDT | `1000` |
| Exam Pack | `/v1/exam-pack` | 1.0 USDT | `1000000` |

---

## 6. Testnet first, then mainnet

OKX review item 2 is *"tested as a user — deliverable received and payment made."* You
satisfy it by doing one **real** end-to-end purchase — a genuine x402 payment that
settles on chain and returns a PDF. Doing that first on **X Layer testnet** with faucet
funds proves the whole loop works without spending real money. Then you flip one
environment variable and the identical code path runs on mainnet.

### 6.1 Switch the deployment to testnet

In Render → **Environment**:

```
PAYMENT_MODE=live
X402_NETWORK=xlayer-testnet
X402_ASSET=<testnet USDT0 contract address>
PAY_TO_ADDRESS=<your 0x… wallet>
OKX_API_KEY=<…>
OKX_SECRET_KEY=<…>
OKX_PASSPHRASE=<…>
```

`X402_ASSET` is **mandatory on testnet**. The testnet USDT0 contract is a different
address from mainnet and is deliberately not hard-coded in `src/config.ts` — the
testnet entry ships with an empty `asset`. Take the address from the X Layer testnet
faucet page / X Layer testnet docs at
https://www.okx.com/xlayer/faucet/xlayerfaucet. If you leave it blank, live mode
refuses to boot with:

```
PAYMENT_MODE=live but configuration is incomplete:
  - settlement token address is not set for xlayer-testnet (set X402_ASSET)
```

Save and let Render redeploy.

### 6.2 Claim test funds

1. Open https://www.okx.com/xlayer/faucet/xlayerfaucet
2. Connect / paste the **buyer** wallet address (the wallet that will pay, not
   necessarily `PAY_TO_ADDRESS`).
3. Claim testnet OKB for gas and testnet USDT0 for the payment.

### 6.3 Do one real purchase

1. Confirm the challenge now advertises testnet:

   ```bash
   curl -s https://<host>/.well-known/x402 | head -40
   ```

   `network` must read `eip155:1952`, `asset` must be your `X402_ASSET`.

2. Buy the cheapest service, **Explain This** (0.001 USDT / `1000` atomic units), from
   an x402-capable buyer — your OKX Agentic Wallet agent, or any x402 client pointed
   at:

   ```
   POST https://<host>/v1/explain-this
   {"problem":"Why does dividing by a fraction flip the fraction?"}
   ```

3. The buyer receives the 402 challenge, signs the payment, retries with the payment
   header, and the server — because `OKX_SYNC_SETTLE=true` — waits for on-chain
   confirmation before handing over the file.
4. **Save the evidence**: the returned PDF and the transaction hash. That is your
   proof for review item 2.
5. Optionally repeat once with a larger service (e.g. Quick Reviewer) to confirm
   amounts scale correctly.

### 6.4 Switch back to mainnet

In Render → **Environment**:

```
PAYMENT_MODE=live
X402_NETWORK=xlayer
X402_ASSET=            # BLANK — the mainnet USDT0 address is built in
```

Save, wait for the redeploy, then:

```bash
npm run compliance -- https://<host>
```

Every service must report `accepts[0].network eip155:196` and
`accepts[0].price.asset 0x779ded0c9e1022225f8e0630b35a9b54be713736`, with no warnings
about mock mode or testnet. Only then go to `docs/REGISTRATION.md`.

---

## 7. Troubleshooting

### The endpoint returns 200 or 400 instead of 402

- **400 with `missing required parameter …`** — the request reached the handler, so
  nothing is charging. That is what `PAYMENT_MODE=disabled` does. Set `PAYMENT_MODE`
  to `live` (or `mock` for local checks).
- **200 with a PDF** — a deliverable went out without payment. Either
  `PAYMENT_MODE=disabled`, or in mock mode you sent the `x-passit-mock-payment`
  header. The paywall runs before the handlers (`src/index.ts` mounts
  `payment.middleware` first), so this is a configuration issue, not a code path.
- **404** — wrong path. The routes are `/v1/quick-reviewer`, `/v1/full-reviewer`,
  `/v1/mock-exam`, `/v1/explain-this`, `/v1/exam-pack`. Check for a typo or a trailing
  slash.
- **5xx** — the service is erroring before the paywall. Read the Render logs.

### 402 is returned but the `PAYMENT-REQUIRED` header is missing

Buyers read the **header**, not the body — a challenge that exists only in the JSON
body will fail review. Check in this order:

1. Is something in front of Render stripping headers (a proxy, a CDN, a URL
   shortener)? Test the raw Render host directly.
2. Are you reading the header case-sensitively? It is `PAYMENT-REQUIRED`; use
   `curl -i` or a case-insensitive match.
3. Both mock and live modes emit it (`src/payment/okx.ts`). If neither does, the
   middleware is not mounted — confirm `PAYMENT_MODE` is not `disabled`.

`npm run compliance` distinguishes these two cases explicitly and tells you which one
you have.

### Boot fails: `PAYMENT_MODE=live but configuration is incomplete`

Live mode refuses to start rather than failing at a buyer's first paid call. The error
lists exactly what is missing. Each line maps to one environment variable:

| Message | Fix |
| --- | --- |
| `PAY_TO_ADDRESS is not set` | Set `PAY_TO_ADDRESS` to your `0x…` wallet. |
| `settlement token address is not set for xlayer-testnet (set X402_ASSET)` | Set `X402_ASSET` to the testnet USDT0 contract. |
| `OKX_API_KEY is not set` | Paste from https://web3.okx.com/onchainos/dev-portal |
| `OKX_SECRET_KEY is not set` | Same source. |
| `OKX_PASSPHRASE is not set` | Same source. |
| `PUBLIC_URL must be a public https:// address` | Set `PUBLIC_URL` to the Render https URL (section 2, step 4). |

Fix them all, save, redeploy. To get the service back up immediately while you sort out
credentials, set `PAYMENT_MODE=mock` — it boots with anything missing.

### First request after idle is very slow (cold start)

Expected on the Render free plan: the instance sleeps after ~15 minutes idle and the
next request pays the wake-up cost. Fixes, in order of effort:

1. Set up the 10-minute `/health` pinger (section 3). This is the real fix.
2. Before any demo or review window, hit `https://<host>/health` yourself to warm it.
3. Note that the in-memory cache is **cleared on every restart**, so the first
   generation after a sleep also has no cache to hit.

### Provider rate limits (429) and what failover does

`src/engine/providers.ts` tries the configured providers in `LLM_PROVIDERS` order and
keeps only the ones with a key. On failure it records the error and moves to the next
provider in the same request, so a buyer usually never notices. If the error looks like
`429`, a `5xx`, `rate limit`, `quota`, `timeout`, `abort`, `ECONN` or `fetch failed`,
that provider is **benched** for `PROVIDER_COOLDOWN_MINUTES` (default 5) so subsequent
requests skip it instead of burning a call on it. Daily quotas recover on their own.

What to do:

1. `curl -s https://<host>/health` and read the `providers` array — each entry has
   `available: true|false`. All `false` means everything is benched right now.
2. Add another free key. Two providers is meaningfully more robust than one.
3. Raise `PROVIDER_COOLDOWN_MINUTES` if you are hitting a daily (not per-minute) cap;
   lower it if you are hitting short bursts.
4. Leave `CACHE_ENABLED=true`. Repeat topics are served from the in-memory cache with
   zero LLM calls.

<a id="servedby-scaffold"></a>
### `"servedBy": "scaffold"` in the response

`servedBy` reports which path produced the content: a provider id (`groq`, `mistral`,
`gemini`, `cerebras`), `cache`, or `scaffold`.

`scaffold` means **no LLM produced this** — every configured provider was unavailable
(or none is configured), so the built-in deterministic generator in
`src/engine/generate.ts` built the document instead. The buyer still receives a real,
correctly structured PDF; that is deliberate, so a paying customer is never left
empty-handed. But the content is generic rather than topic-researched, so seeing
`scaffold` in production is a signal to act:

1. Check `/health` → `providers`. Empty array means Render never received your keys.
2. Any keys present but `available: false`? You are rate-limited; wait out the cooldown
   or add another provider.
3. Check the Render logs — the boot line prints
   `providers  : groq, mistral, …` or `(none — scaffold only)`.

To see `servedBy` on a request, ask for the JSON form:

```bash
curl -s -X POST 'https://<host>/v1/quick-reviewer?format=json' \
  -H 'content-type: application/json' \
  -H 'x-passit-mock-payment: 1' \
  -d '{"topic":"Photosynthesis"}' | head -c 400
```

(The mock header only works when `PAYMENT_MODE=mock`.)

---

## 8. Pre-registration checklist

Tick every line before opening `docs/REGISTRATION.md`:

- [ ] Render service is deployed, region **Singapore**, plan **Free**
- [ ] `PUBLIC_URL` is set to the assigned `https://…` URL, no trailing slash
- [ ] `PAYMENT_MODE=live`, `X402_NETWORK=xlayer`, `X402_ASSET` blank
- [ ] `PAY_TO_ADDRESS` and all three `OKX_*` credentials are set
- [ ] At least one LLM key is set and `/health` shows it `available: true`
- [ ] `curl -s https://<host>/health` returns `"ok": true`
- [ ] An unpaid `POST /v1/quick-reviewer` returns 402 with a `PAYMENT-REQUIRED` header
- [ ] `https://<host>/brand/pfp.png` loads as a PNG
- [ ] One real end-to-end purchase completed (testnet is fine) — PDF and tx hash saved
- [ ] `npm run compliance -- https://<host>` prints
      `All checks passed. Safe to register this endpoint on OKX.AI.`
- [ ] The 10-minute `/health` pinger is running and green
