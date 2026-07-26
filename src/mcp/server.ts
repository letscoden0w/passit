// PassIt as an MCP server.
//
// The same five services exposed as MCP tools, so anyone on Claude Code,
// Cursor or OpenClaw can use PassIt directly — alongside the x402 HTTP
// endpoints that OKX.AI registers.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NEXT_STEP, SERVICES } from "../config.js";
import { quickReviewer, fullReviewer, mockExam, explainThis, examPack } from "../services.js";
import type { Delivery, ServiceId, ServiceResult } from "../types.js";

const materials = z
  .string()
  .optional()
  .describe("Optional: paste your own notes, PDF text or book pages. The output will follow them exactly.");
const language = z.string().optional().describe("Output language. Defaults to the language of your request.");
const reviewerFormat = z
  .enum(["pdf", "markdown", "flashcards", "cheatsheet"])
  .optional()
  .describe("Output format. Default: pdf.");
const docFormat = z.enum(["pdf", "markdown"]).optional().describe("Output format. Default: pdf.");

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "passit", version: "1.0.0" },
    {
      instructions:
        "PassIt turns any topic into a printable study reviewer, mock exam, or fix-it explanation, " +
        "delivered as a real PDF. Study aid only — not for use during live exams, and it does not " +
        "guarantee exam results.",
    },
  );

  server.registerTool(
    "quick_reviewer",
    {
      title: `Quick Reviewer — ${SERVICES.quick_reviewer.priceUsdt} USDT`,
      description: SERVICES.quick_reviewer.description,
      inputSchema: {
        topic: z.string().min(2).describe("The single topic, e.g. 'Photosynthesis'."),
        materials,
        format: reviewerFormat,
        language,
      },
    },
    async (a) =>
      toolResult("quick_reviewer", await quickReviewer({
        topic: a.topic, materials: a.materials, format: a.format, language: a.language,
      })),
  );

  server.registerTool(
    "full_reviewer",
    {
      title: `Full Reviewer — ${SERVICES.full_reviewer.priceUsdt} USDT`,
      description: SERVICES.full_reviewer.description,
      inputSchema: {
        subject: z.string().min(2).describe("A subject, or a comma-separated list of topics."),
        materials,
        format: reviewerFormat,
        language,
      },
    },
    async (a) =>
      toolResult("full_reviewer", await fullReviewer({
        topic: a.subject, materials: a.materials, format: a.format, language: a.language,
      })),
  );

  server.registerTool(
    "mock_exam",
    {
      title: `Mock Exam — ${SERVICES.mock_exam.priceUsdt} USDT`,
      description: SERVICES.mock_exam.description,
      inputSchema: {
        target: z.string().min(2).describe("Topic, subject, or exam name."),
        style: z.enum(["multiple_choice", "qa", "true_false", "mixed"]).optional().describe("Default: mixed."),
        count: z.number().int().min(3).max(50).optional().describe("Default 20; 10 for a single small topic."),
        materials,
        format: docFormat,
        language,
      },
    },
    async (a) =>
      toolResult("mock_exam", await mockExam({
        target: a.target, style: a.style, count: a.count,
        materials: a.materials, format: a.format, language: a.language,
      })),
  );

  server.registerTool(
    "explain_this",
    {
      title: `Explain This — ${SERVICES.explain_this.priceUsdt} USDT`,
      description: SERVICES.explain_this.description,
      inputSchema: {
        problem: z
          .string()
          .min(2)
          .describe("A confusing question or topic, or an answered quiz to check (paste the text)."),
        materials,
        format: docFormat,
        language,
      },
    },
    async (a) =>
      toolResult("explain_this", await explainThis({
        problem: a.problem, materials: a.materials, format: a.format, language: a.language,
      })),
  );

  server.registerTool(
    "exam_pack",
    {
      title: `Exam Pack — ${SERVICES.exam_pack.priceUsdt} USDT`,
      description: SERVICES.exam_pack.description,
      inputSchema: {
        exam: z.string().min(2).describe("The exam name, e.g. 'Nursing Board — Pharmacology'."),
        topics: z.string().optional().describe("Topics or syllabus to cover."),
        materials,
        format: docFormat,
        language,
      },
    },
    async (a) =>
      toolResult("exam_pack", await examPack({
        exam: a.exam, topics: a.topics, materials: a.materials,
        format: a.format, language: a.language,
      })),
  );

  return server;
}

// ─── result mapping ──────────────────────────────────────────────────

function toolResult(serviceId: ServiceId, result: ServiceResult) {
  const next = SERVICES[NEXT_STEP[serviceId]];
  const files = result.deliveries
    .map((d) => `• ${d.filename} (${d.mimeType}, ${d.bytes.length.toLocaleString()} bytes)`)
    .join("\n");

  const header = result.declined
    ? result.summary
    : `${SERVICES[serviceId].title} ready.\n${result.summary}\n\nFiles:\n${files}\n\n` +
      `One next step: ${next.title} — ${next.priceUsdt} USDT.`;

  const content: Array<Record<string, unknown>> = [{ type: "text", text: header }];
  for (const d of result.deliveries) content.push(toResource(d));

  return {
    ...(result.declined ? { isError: true } : {}),
    content: content as never,
    structuredContent: {
      service: serviceId,
      summary: result.summary,
      declined: result.declined ?? false,
      servedBy: result.servedBy ?? null,
      nextStep: next.id,
      files: result.deliveries.map((d) => ({
        filename: d.filename,
        mimeType: d.mimeType,
        size: d.bytes.length,
      })),
    },
  };
}

function toResource(d: Delivery) {
  const uri = `passit://file/${encodeURIComponent(d.filename)}`;
  const isText = d.mimeType.startsWith("text/") || d.mimeType === "application/json";
  return {
    type: "resource" as const,
    resource: isText
      ? { uri, name: d.filename, mimeType: d.mimeType, text: d.bytes.toString("utf8") }
      : { uri, name: d.filename, mimeType: d.mimeType, blob: d.bytes.toString("base64") },
  };
}
