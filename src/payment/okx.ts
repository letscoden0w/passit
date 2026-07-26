// x402 payment layer, built on the official OKX Payment SDK.
//
// The SDK owns the protocol: it emits the compliant 402 with the
// base64 PAYMENT-REQUIRED header (which is what the marketplace validates),
// verifies the payment signature, and settles on chain. We only declare the
// routes and their prices.
//
// Modes:
//   live     — real payments through the OKX facilitator
//   mock     — 402 unless a test token is present; no chain. Dev + tests.
//   disabled — free endpoints (a valid ASP form: "free endpoints just return
//              the result"). Useful for a free teaser deployment.
import type { RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  SERVICES,
  SERVICE_IDS,
  SERVER,
  paymentConfig,
  priceAtomic,
  type PaymentConfig,
} from "../config.js";
import type { ServiceMeta } from "../config.js";

export const MOCK_PAYMENT_HEADER = "x-passit-mock-payment";

/** Public URL a buyer calls for a service. */
export function endpointUrl(service: ServiceMeta): string {
  return `${SERVER.publicUrl}/v1/${service.route}`;
}

/**
 * The x402 payment option for one service.
 *
 * Price is expressed in the token's smallest unit rather than a "$0.10"
 * string. That is deterministic (no currency conversion at request time) and
 * it expresses sub-cent pricing — Explain This is 0.001 USDT — without
 * depending on a USD parser accepting three decimal places.
 */
function paymentOption(service: ServiceMeta, cfg: PaymentConfig) {
  return {
    scheme: "exact",
    network: cfg.network.caip2,
    payTo: cfg.payTo,
    price: {
      asset: cfg.network.asset,
      amount: priceAtomic(service.priceUsdt, cfg.network.decimals),
      // EIP-712 domain for USD₮0, per the OKX challenge spec.
      extra: { name: "USD₮0", version: "1" },
    },
    maxTimeoutSeconds: 300,
  };
}

/** Route map in the SDK's "METHOD /path" form. */
export function buildRoutes(cfg: PaymentConfig) {
  const routes: Record<string, unknown> = {};
  for (const id of SERVICE_IDS) {
    const service = SERVICES[id];
    // Registered for POST (JSON body) and GET (query params) so a buyer's
    // agent can call whichever it prefers.
    for (const method of ["POST", "GET"]) {
      routes[`${method} /v1/${service.route}`] = {
        accepts: [paymentOption(service, cfg)],
        resource: endpointUrl(service),
        description: service.description,
        mimeType: "application/pdf",
      };
    }
  }
  return routes;
}

export interface PaymentLayer {
  middleware: RequestHandler | null;
  describe: string;
}

/** Fail fast at boot rather than at a buyer's first paid call. */
export function assertLiveConfig(cfg: PaymentConfig): string[] {
  const problems: string[] = [];
  if (!cfg.payTo) problems.push("PAY_TO_ADDRESS is not set");
  if (!cfg.network.asset) {
    problems.push(
      `settlement token address is not set for ${cfg.network.key} (set X402_ASSET)`,
    );
  }
  if (!cfg.okx.apiKey) problems.push("OKX_API_KEY is not set");
  if (!cfg.okx.secretKey) problems.push("OKX_SECRET_KEY is not set");
  if (!cfg.okx.passphrase) problems.push("OKX_PASSPHRASE is not set");
  if (!SERVER.publicUrl.startsWith("https://")) {
    problems.push("PUBLIC_URL must be a public https:// address");
  }
  return problems;
}

export function createPaymentLayer(cfg: PaymentConfig = paymentConfig()): PaymentLayer {
  if (cfg.mode === "disabled") {
    return { middleware: null, describe: "disabled (free endpoints)" };
  }

  if (cfg.mode === "mock") {
    return { middleware: mockMiddleware(cfg), describe: "mock (no chain)" };
  }

  const problems = assertLiveConfig(cfg);
  if (problems.length > 0) {
    throw new Error(
      `PAYMENT_MODE=live but configuration is incomplete:\n  - ${problems.join("\n  - ")}`,
    );
  }

  const facilitator = new OKXFacilitatorClient({
    apiKey: cfg.okx.apiKey,
    secretKey: cfg.okx.secretKey,
    passphrase: cfg.okx.passphrase,
    // Wait for on-chain confirmation before the handler runs, so we never
    // hand over a PDF for a payment that hasn't settled.
    syncSettle: cfg.okx.syncSettle,
  });

  const resourceServer = new x402ResourceServer(facilitator);
  resourceServer.register(cfg.network.caip2, new ExactEvmScheme());

  const middleware = paymentMiddleware(
    buildRoutes(cfg) as never,
    resourceServer,
  ) as unknown as RequestHandler;

  return {
    middleware,
    describe: `live · ${cfg.network.label} (${cfg.network.caip2}) · USDT0 · syncSettle=${cfg.okx.syncSettle}`,
  };
}

/**
 * Dev/test stand-in for the SDK middleware. Returns a 402 whose shape mirrors
 * the real challenge so client code can be exercised without a chain, and
 * lets a request through when the mock header is present.
 */
function mockMiddleware(cfg: PaymentConfig): RequestHandler {
  const routes = buildRoutes(cfg);
  return (req, res, next) => {
    const key = `${req.method.toUpperCase()} ${req.path}`;
    const route = routes[key] as { accepts: unknown[]; resource: string; description: string } | undefined;
    if (!route) return next();
    if (req.header(MOCK_PAYMENT_HEADER)) return next();

    const challenge = {
      x402Version: 2,
      resource: { url: route.resource, description: route.description, mimeType: "application/pdf" },
      accepts: route.accepts,
    };
    res
      .status(402)
      .set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"))
      .json(challenge);
  };
}
