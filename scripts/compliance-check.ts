// Pre-registration compliance check.
//
// Proves, against a running server, that every endpoint satisfies the OKX ASP
// review checklist BEFORE a human submits the listing:
//
//   1. endpoint online              -> GET /health, GET /, GET /brand/pfp.png
//   3. PFP served as a real PNG     -> GET /brand/pfp.png is image/png
//   5. 402 challenge network        -> accepts[0].network is the CAIP-2 value
//   6. payment token                -> accepts[0].price.asset is USDT0
//
// Every expected value is imported from ../src/config.js, never restated here,
// so this script cannot drift away from what the server actually serves.
//
// Usage:  npm run compliance -- [baseUrl]
// Exit:   0 = all checks passed, 1 = at least one failed.
import {
  SERVICES,
  SERVICE_IDS,
  paymentConfig,
  priceAtomic,
  type ServiceMeta,
} from "../src/config.js";

const BASE = (process.argv[2] || process.env.PUBLIC_URL || "http://localhost:8402").replace(/\/$/, "");
const TIMEOUT_MS = 20_000;

const cfg = paymentConfig();
const EXPECTED_NETWORK = cfg.network.caip2;
const EXPECTED_ASSET = cfg.network.asset;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ─── Result table ────────────────────────────────────────────────────

type Status = "pass" | "fail" | "warn";
interface Row {
  status: Status;
  group: string;
  check: string;
  detail: string;
  /** What the operator should actually do about it. */
  fix?: string;
}

const rows: Row[] = [];
const pass = (group: string, check: string, detail: string) =>
  rows.push({ status: "pass", group, check, detail });
const fail = (group: string, check: string, detail: string, fix: string) =>
  rows.push({ status: "fail", group, check, detail, fix });
const warn = (group: string, check: string, detail: string, fix: string) =>
  rows.push({ status: "warn", group, check, detail, fix });

// ─── HTTP ────────────────────────────────────────────────────────────

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

async function json(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text()) as unknown;
  } catch {
    return undefined;
  }
}

// ─── Checks: discovery, health, brand ────────────────────────────────

/** @returns false when the host is unreachable, so we can stop instead of
 *  repeating one root cause across every later check. */
async function checkHealth(): Promise<boolean> {
  const g = "health";
  let res: Response;
  try {
    res = await req("/health");
  } catch (err) {
    fail(g, "GET /health", `unreachable: ${msg(err)}`, `Nothing is answering at ${BASE}. Start the server (PAYMENT_MODE=mock PORT=8402 npx tsx src/index.ts) or pass the right base URL: npm run compliance -- https://your-host`);
    return false;
  }

  const body = asRecord(await json(res));
  if (res.status !== 200 || body?.ok !== true) {
    fail(g, "GET /health", `status ${res.status}, ok=${String(body?.ok)}`, "GET /health must return 200 with {\"ok\":true} — OKX checks the endpoint is online.");
    return true;
  }
  pass(g, "GET /health", `200, ok=true, payment=${String(body.payment)}`);

  // The server reports the network it actually booted with. If it disagrees
  // with this script's env, one of the two has the wrong X402_NETWORK and the
  // service-level comparisons below would be checking the wrong expectation.
  const served = String(body.network ?? "");
  if (served && served !== EXPECTED_NETWORK) {
    fail(
      g,
      "env agreement",
      `server reports ${served}, this check expects ${EXPECTED_NETWORK}`,
      `The server and this script were started with different X402_NETWORK values. Run both with the same environment (or the same .env) before trusting any result below.`,
    );
  } else if (served) {
    pass(g, "env agreement", `server and check both on ${served}`);
  }

  if (String(body.payment) === "mock") {
    warn(
      g,
      "payment mode",
      "server is running PAYMENT_MODE=mock",
      "Mock mode returns a 402 shaped like the real one but settles nothing. Deploy with PAYMENT_MODE=live before registering, then re-run this check against the public URL.",
    );
  } else if (String(body.payment) === "disabled") {
    warn(
      g,
      "payment mode",
      "server is running PAYMENT_MODE=disabled",
      "Disabled mode serves the endpoints for free, so there is no 402 to review. Set PAYMENT_MODE=live.",
    );
  }
  return true;
}

async function checkDiscovery(): Promise<void> {
  const g = "discovery";
  let res: Response;
  try {
    res = await req("/");
  } catch (err) {
    fail(g, "GET /", `unreachable: ${msg(err)}`, "GET / is the discovery document buyers read. It must be online.");
    return;
  }

  const body = asRecord(await json(res));
  if (res.status !== 200 || !body) {
    fail(g, "GET /", `status ${res.status}, not JSON`, "GET / must return 200 with the JSON discovery document.");
    return;
  }

  const listed = Array.isArray(body.services) ? body.services : [];
  const ids = new Set(listed.map((s) => asRecord(s)?.id).filter((v): v is string => typeof v === "string"));
  const missing = SERVICE_IDS.filter((id) => !ids.has(id));

  if (missing.length > 0) {
    fail(g, "lists 5 services", `${ids.size}/5 listed, missing: ${missing.join(", ")}`, `GET / must list every service. Check SERVICES in src/config.ts.`);
  } else {
    pass(g, "lists 5 services", `${SERVICE_IDS.join(", ")}`);
  }
}

async function checkPfp(): Promise<void> {
  const g = "brand";
  let res: Response;
  try {
    res = await req("/brand/pfp.png");
  } catch (err) {
    fail(g, "GET /brand/pfp.png", `unreachable: ${msg(err)}`, "Registration needs a public 1:1 avatar URL. Regenerate it with: npx tsx scripts/make-pfp.ts");
    return;
  }

  const type = res.headers.get("content-type") ?? "";
  const bytes = (await res.arrayBuffer()).byteLength;

  if (res.status !== 200 || !type.startsWith("image/png")) {
    fail(g, "GET /brand/pfp.png", `status ${res.status}, content-type "${type || "(none)"}"`, "The PFP must be served as image/png. Regenerate with: npx tsx scripts/make-pfp.ts");
    return;
  }
  pass(g, "GET /brand/pfp.png", `200, image/png, ${bytes.toLocaleString()} bytes`);
}

// ─── Checks: the 402 challenge, per service ──────────────────────────

async function checkService(service: ServiceMeta): Promise<void> {
  const g = service.id;
  const path = `/v1/${service.route}`;
  const expectedAmount = priceAtomic(service.priceUsdt, cfg.network.decimals);

  let res: Response;
  try {
    // Empty body on purpose: if the paywall is missing, the request falls
    // through to the handler and returns 400 for the missing parameter —
    // a clear signal that costs no LLM quota.
    res = await req(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (err) {
    fail(g, "402 challenge", `POST ${path} unreachable: ${msg(err)}`, `The route must be online at ${BASE}${path}.`);
    return;
  }

  const body = await json(res);

  if (res.status !== 402) {
    fail(g, "402 challenge", `POST ${path} returned ${res.status}, expected 402`, unpaidFix(res.status, path));
    return;
  }
  pass(g, "402 challenge", `POST ${path} -> 402 without payment`);

  const header = res.headers.get("payment-required");
  if (!header) {
    const hasChallengeBody = asRecord(body)?.x402Version !== undefined;
    fail(
      g,
      "PAYMENT-REQUIRED header",
      "header absent",
      hasChallengeBody
        ? "The challenge is in the response body but not in the PAYMENT-REQUIRED response header. Buyers read the header — emit it base64-encoded."
        : "The 402 must carry a base64 PAYMENT-REQUIRED response header. Check the payment middleware in src/payment/okx.ts.",
    );
    return;
  }
  pass(g, "PAYMENT-REQUIRED header", `present, ${header.length} chars of base64`);

  let challenge: Record<string, unknown> | undefined;
  try {
    challenge = asRecord(JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown);
  } catch {
    challenge = undefined;
  }
  if (!challenge) {
    fail(g, "header decodes", "not base64 of a JSON object", "PAYMENT-REQUIRED must be base64(JSON). Buyers cannot parse the challenge as it stands.");
    return;
  }

  if (challenge.x402Version !== 2) {
    fail(g, "x402Version", `got ${JSON.stringify(challenge.x402Version)}, expected 2`, "OKX A2MCP settles on x402 v2. Emit x402Version: 2 in the challenge.");
  } else {
    pass(g, "x402Version", "2");
  }

  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
  const option = asRecord(accepts[0]);
  if (!option) {
    fail(g, "accepts[0]", "missing or not an object", "The challenge must offer at least one payment option in accepts[].");
    return;
  }

  // network
  const network = String(option.network ?? "");
  if (network === EXPECTED_NETWORK) {
    pass(g, "accepts[0].network", network);
  } else {
    fail(g, "accepts[0].network", `got "${network}", expected "${EXPECTED_NETWORK}"`, `OKX validates the CAIP-2 network on the 402. Set X402_NETWORK so the server serves ${EXPECTED_NETWORK}.`);
  }

  // asset
  const price = asRecord(option.price);
  const asset = String(price?.asset ?? "");
  if (!EXPECTED_ASSET) {
    fail(g, "accepts[0].price.asset", `served "${asset || "(empty)"}", but no expected asset is configured`, `No settlement token is set for network ${cfg.network.key}. Set X402_ASSET to the USDT0 contract for that network before registering.`);
  } else if (asset.toLowerCase() === EXPECTED_ASSET.toLowerCase()) {
    pass(g, "accepts[0].price.asset", asset);
  } else {
    fail(g, "accepts[0].price.asset", `got "${asset || "(empty)"}", expected "${EXPECTED_ASSET}"`, "OKX requires settlement in USDT0. Set X402_ASSET (or leave it unset to use the built-in mainnet address).");
  }

  // amount
  const amount = price?.amount === undefined ? "" : String(price.amount);
  if (amount === expectedAmount) {
    pass(g, "accepts[0].price.amount", `${amount} (= ${service.priceUsdt} USDT)`);
  } else {
    fail(g, "accepts[0].price.amount", `got "${amount || "(empty)"}", expected "${expectedAmount}" (${service.priceUsdt} USDT at ${cfg.network.decimals} decimals)`, `The charged amount does not match the listed price. Check priceUsdt for ${service.id} in src/config.ts and X402_ASSET_DECIMALS.`);
  }

  // payTo
  const payTo = String(option.payTo ?? "");
  if (!payTo) {
    warn(g, "accepts[0].payTo", "EMPTY — nobody gets paid", "Set PAY_TO_ADDRESS to the wallet that should receive USDT0. Every sale settles to nowhere until you do.");
  } else if (!ADDRESS_RE.test(payTo)) {
    fail(g, "accepts[0].payTo", `"${payTo}" is not a 0x address`, "PAY_TO_ADDRESS must be a 20-byte 0x address on X Layer.");
  } else {
    pass(g, "accepts[0].payTo", payTo);
  }
}

function unpaidFix(status: number, path: string): string {
  if (status === 400) {
    return `The request reached the handler, so nothing is charging for ${path}. That happens when PAYMENT_MODE=disabled — set PAYMENT_MODE=live (or mock, for local checks).`;
  }
  if (status === 200) {
    return `${path} served a deliverable without payment. The paywall must run before the handler — check createPaymentLayer in src/payment/okx.ts.`;
  }
  if (status === 404) {
    return `No route at ${path}. Check the base URL (${BASE}) and the route in src/config.ts.`;
  }
  if (status >= 500) {
    return `${path} is erroring before the paywall. Check the server logs.`;
  }
  return `An unpaid call must answer 402 with a payment challenge.`;
}

// ─── Registration readiness (advisory) ───────────────────────────────

function checkReadiness(): void {
  const g = "readiness";
  if (cfg.network.isTestnet) {
    warn(g, "network", `${cfg.network.label} (${EXPECTED_NETWORK})`, "OKX reviews against X Layer mainnet. Set X402_NETWORK=xlayer before registering.");
  } else {
    pass(g, "network", `${cfg.network.label} (${EXPECTED_NETWORK})`);
  }

  if (!BASE.startsWith("https://")) {
    warn(g, "public url", `${BASE} is not https`, "Registration needs a public https:// endpoint URL. Deploy first, then re-run: npm run compliance -- https://your-host");
  } else {
    pass(g, "public url", BASE);
  }
}

// ─── Output ──────────────────────────────────────────────────────────

const tty = process.stdout.isTTY === true;
const color = (code: string, s: string) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const BADGE: Record<Status, string> = {
  pass: color("32", "PASS"),
  fail: color("31", "FAIL"),
  warn: color("33", "WARN"),
};

function print(): void {
  const gw = Math.max(...rows.map((r) => r.group.length));
  const cw = Math.max(...rows.map((r) => r.check.length));

  console.log("");
  for (const r of rows) {
    console.log(`  ${BADGE[r.status]}  ${r.group.padEnd(gw)}  ${r.check.padEnd(cw)}  ${r.detail}`);
  }

  const failed = rows.filter((r) => r.status === "fail");
  const warned = rows.filter((r) => r.status === "warn");
  const passed = rows.length - failed.length - warned.length;

  console.log("");
  console.log(`  ${passed} passed · ${warned.length} warned · ${failed.length} failed`);

  if (failed.length > 0 || warned.length > 0) {
    console.log("");
    console.log("  Fix before registering:");
    for (const r of [...failed, ...warned]) {
      console.log(`  ${BADGE[r.status]}  ${r.group} / ${r.check}`);
      console.log(`        ${r.fix}`);
    }
  }

  console.log("");
  if (failed.length > 0) {
    console.log(color("31", `  NOT READY — ${failed.length} check(s) failed.`));
  } else if (warned.length > 0) {
    console.log(color("33", "  Checks passed, with warnings above. Read them before you register."));
  } else {
    console.log(color("32", "  All checks passed. Safe to register this endpoint on OKX.AI."));
  }
  console.log("");
}

function msg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/\s+/g, " ").slice(0, 120);
}

// ─── Run ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("");
  console.log("PassIt — OKX ASP compliance check");
  console.log(`  base url : ${BASE}`);
  console.log(`  network  : ${EXPECTED_NETWORK} (${cfg.network.label})`);
  console.log(`  asset    : ${EXPECTED_ASSET || "(not set — set X402_ASSET)"} · ${cfg.network.decimals} decimals`);
  console.log(`  pay to   : ${cfg.payTo || "(not set — set PAY_TO_ADDRESS)"}`);
  console.log(`  mode     : PAYMENT_MODE=${cfg.mode} (this check's env)`);

  // If the host itself is unreachable, every later check would fail for the
  // same reason. Report the one real cause instead of nine copies of it.
  if (await checkHealth()) {
    await checkDiscovery();
    await checkPfp();
    for (const id of SERVICE_IDS) await checkService(SERVICES[id]);
    checkReadiness();
  }

  print();
  process.exit(rows.some((r) => r.status === "fail") ? 1 : 0);
}

await main();
