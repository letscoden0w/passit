// PassIt HTTP server.
//
// Two surfaces from one process:
//   /v1/<service>  — x402 pay-per-call endpoints, what OKX.AI registers
//   /mcp           — MCP Streamable HTTP, for Claude Code / Cursor / OpenClaw
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp/server.js";
import {
  BRAND,
  SERVER,
  SERVICES,
  SERVICE_IDS,
  paymentConfig,
  priceAtomic,
  priceLabel,
  routeToService,
} from "./config.js";
import { buildRoutes, createPaymentLayer, endpointUrl } from "./payment/okx.js";
import { providerHealth } from "./engine/providers.js";
import { cacheStats } from "./engine/cache.js";
import { quickReviewer, fullReviewer, mockExam, explainThis, examPack } from "./services.js";
import { PASSIT_PFP_PNG } from "./brand.js";
import type { ServiceId, ServiceResult } from "./types.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));

const cfg = paymentConfig();
const payment = createPaymentLayer(cfg);

// The paywall must sit in front of the /v1 handlers.
if (payment.middleware) app.use(payment.middleware);

// ─── Paid service endpoints ──────────────────────────────────────────

type Handler = (input: Record<string, unknown>) => Promise<ServiceResult>;

const HANDLERS: Record<ServiceId, Handler> = {
  quick_reviewer: (i) =>
    quickReviewer({
      topic: str(i.topic) ?? "",
      materials: str(i.materials),
      format: str(i.format) as never,
      language: str(i.language),
    }),
  full_reviewer: (i) =>
    fullReviewer({
      topic: str(i.subject) ?? str(i.topic) ?? "",
      materials: str(i.materials),
      format: str(i.format) as never,
      language: str(i.language),
    }),
  mock_exam: (i) =>
    mockExam({
      target: str(i.target) ?? str(i.topic) ?? "",
      style: str(i.style) as never,
      count: num(i.count),
      materials: str(i.materials),
      format: str(i.format) as never,
      language: str(i.language),
    }),
  explain_this: (i) =>
    explainThis({
      problem: str(i.problem) ?? str(i.question) ?? "",
      materials: str(i.materials),
      format: str(i.format) as never,
      language: str(i.language),
    }),
  exam_pack: (i) =>
    examPack({
      exam: str(i.exam) ?? "",
      topics: str(i.topics),
      materials: str(i.materials),
      format: str(i.format) as never,
      language: str(i.language),
    }),
};

/** Required field per service, so a missing parameter fails clearly. */
const REQUIRED: Record<ServiceId, string> = {
  quick_reviewer: "topic",
  full_reviewer: "subject",
  mock_exam: "target",
  explain_this: "problem",
  exam_pack: "exam",
};

for (const id of SERVICE_IDS) {
  const service = SERVICES[id];
  const path = `/v1/${service.route}`;
  const handle = async (req: Request, res: Response) => {
    const input = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };
    const required = REQUIRED[id];
    if (!str(input[required]) && !(id === "full_reviewer" && str(input.topic)) &&
        !(id === "mock_exam" && str(input.topic)) && !(id === "explain_this" && str(input.question))) {
      res.status(400).json({
        error: `missing required parameter "${required}"`,
        service: id,
        parameters: service.params,
      });
      return;
    }

    try {
      const result = await HANDLERS[id](input);
      sendResult(req, res, id, result);
    } catch (err) {
      console.error(`[${id}]`, err);
      res.status(500).json({ error: "generation failed", service: id });
    }
  };

  app.post(path, handle);
  app.get(path, handle);
}

/**
 * Deliver the result. A single file is returned as the raw body so a buyer's
 * agent gets a real PDF; JSON (all files base64) is available for callers that
 * prefer it, and is used automatically when there is more than one file.
 *
 * `?download=1` forces the raw body even for multi-file results, returning just
 * the primary document — handy for opening a result straight in a browser, and
 * for callers that only want the PDF and would rather not decode base64.
 */
function sendResult(req: Request, res: Response, id: ServiceId, result: ServiceResult) {
  const forceDownload = truthy(req.query.download);
  const wantsJson =
    !forceDownload &&
    (String(req.query.format ?? "") === "json" ||
      /application\/json/.test(req.header("accept") ?? "") ||
      result.deliveries.length > 1);

  if (result.declined) res.status(422);

  if (wantsJson) {
    res.json({
      service: id,
      summary: result.summary,
      declined: result.declined ?? false,
      servedBy: result.servedBy ?? null,
      files: result.deliveries.map((d) => ({
        filename: d.filename,
        mimeType: d.mimeType,
        size: d.bytes.length,
        base64: d.bytes.toString("base64"),
      })),
      disclaimer: BRAND.disclaimer,
    });
    return;
  }

  const file = result.deliveries[0]!;
  res.set("Content-Type", file.mimeType);
  res.set("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.set("X-PassIt-Summary", encodeURIComponent(result.summary).slice(0, 900));
  // Tell the caller what they didn't get, so a dropped companion file (e.g. the
  // Exam Pack flashcards CSV) is discoverable rather than silently missing.
  if (result.deliveries.length > 1) {
    res.set(
      "X-PassIt-Other-Files",
      result.deliveries.slice(1).map((d) => d.filename).join(", "),
    );
  }
  res.send(file.bytes);
}

// ─── MCP endpoint (stateless) ────────────────────────────────────────

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp]", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const noStream = (_req: Request, res: Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)." },
    id: null,
  });
app.get("/mcp", noStream);
app.delete("/mcp", noStream);

// ─── Discovery, health, brand ────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: BRAND.name,
    tagline: BRAND.tagline,
    category: "Lifestyle",
    protocol: ["x402", "mcp"],
    mcp_endpoint: `${SERVER.publicUrl}/mcp`,
    payment: {
      protocol: "x402",
      version: 2,
      mode: cfg.mode,
      network: cfg.network.caip2,
      network_label: cfg.network.label,
      asset: cfg.network.asset || null,
      asset_symbol: "USDT0",
    },
    services: SERVICE_IDS.map((id) => {
      const s = SERVICES[id];
      return {
        id: s.id,
        title: s.title,
        price: priceLabel(s.priceUsdt),
        endpoint: endpointUrl(s),
        description: s.description,
        parameters: s.params,
      };
    }),
    disclaimer: BRAND.disclaimer,
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    payment: cfg.mode,
    network: cfg.network.caip2,
    providers: providerHealth(),
    cache: cacheStats(),
  });
});

/** x402 pricing manifest — handy for buyers and for our own compliance check. */
app.get("/.well-known/x402", (_req, res) => {
  res.json({ x402Version: 2, routes: buildRoutes(cfg) });
});

/** Served so registration always has a public 1:1 avatar URL available. */
app.get("/brand/pfp.png", (_req, res) => {
  res
    .set("Content-Type", "image/png")
    .set("Cache-Control", "public, max-age=86400")
    .send(PASSIT_PFP_PNG);
});

// ─── boot ────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v;
  return undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function truthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  // A bare `?download` arrives as "", which express treats as present.
  return s === "" || s === "1" || s === "true" || s === "yes" || s === "pdf";
}

if (process.env.NODE_ENV !== "test") {
  app.listen(SERVER.port, () => {
    console.log(`${BRAND.name} listening on :${SERVER.port}`);
    console.log(`  public url : ${SERVER.publicUrl}`);
    console.log(`  payment    : ${payment.describe}`);
    console.log(`  pay to     : ${cfg.payTo || "(not set)"}`);
    console.log(`  providers  : ${providerHealth().map((p) => p.id).join(", ") || "(none — scaffold only)"}`);
    for (const id of SERVICE_IDS) {
      const s = SERVICES[id];
      console.log(`  ${priceAtomic(s.priceUsdt, cfg.network.decimals).padStart(8)}  ${endpointUrl(s)}`);
    }
  });
}

export { app };
