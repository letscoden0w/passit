// PassIt as an MCP server. A real Client is wired to buildServer() over the
// SDK's in-process transport, so the tool surface is exercised exactly as
// Claude Code / Cursor / OpenClaw would see it — no HTTP, no network.
import "./helpers.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { PDF_MAGIC, pdfMagic } from "./helpers.js";

const TOOL_NAMES = ["quick_reviewer", "full_reviewer", "mock_exam", "explain_this", "exam_pack"];

let client: Client;
let server: ReturnType<typeof buildServer>;

before(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = buildServer();
  client = new Client({ name: "passit-tests", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  await server.close();
});

// The wire shape of a tools/call result, narrowed to the parts PassIt uses.
interface ResourceBlock {
  type: "resource";
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
}
type ContentBlock = { type: "text"; text: string } | ResourceBlock | { type: string };

interface CallResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown>): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  return result as unknown as CallResult;
}

function resources(result: CallResult): ResourceBlock[] {
  return result.content.filter((b): b is ResourceBlock => b.type === "resource");
}

function textOf(result: CallResult): string {
  return result.content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("\n");
}

function blobOf(block: ResourceBlock | undefined): Buffer {
  assert.ok(block, "expected a resource block");
  assert.ok(typeof block.resource.blob === "string", "expected a base64 blob resource");
  return Buffer.from(block.resource.blob, "base64");
}

function textIn(block: ResourceBlock | undefined): string {
  assert.ok(block, "expected a resource block");
  assert.ok(typeof block.resource.text === "string", "expected an inline text resource");
  return block.resource.text;
}

describe("tools/list", () => {
  it("returns exactly the five PassIt tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual([...tools.map((t) => t.name)].sort(), [...TOOL_NAMES].sort());
  });

  it("describes each tool and declares its required parameter", async () => {
    const { tools } = await client.listTools();
    const required: Record<string, string> = {
      quick_reviewer: "topic",
      full_reviewer: "subject",
      mock_exam: "target",
      explain_this: "problem",
      exam_pack: "exam",
    };

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} has no description`);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(
        tool.inputSchema.required?.includes(required[tool.name] ?? ""),
        `${tool.name} does not require "${required[tool.name]}"`,
      );
      // Every service accepts these three optional parameters.
      const props = Object.keys(tool.inputSchema.properties ?? {});
      assert.ok(props.includes("materials"), `${tool.name} has no materials parameter`);
      assert.ok(props.includes("language"), `${tool.name} has no language parameter`);
      assert.ok(props.includes("format"), `${tool.name} has no format parameter`);
    }
  });
});

describe("tools/call quick_reviewer", () => {
  it("returns an embedded application/pdf resource", async () => {
    const result = await call("quick_reviewer", { topic: "Photosynthesis" });

    const embedded = resources(result);
    assert.equal(embedded.length, 1);
    assert.equal(embedded[0]?.resource.mimeType, "application/pdf");
    assert.match(String(embedded[0]?.resource.uri), /^passit:\/\/file\//);
    assert.equal(pdfMagic(blobOf(embedded[0])), PDF_MAGIC);
  });

  it("leads with a text block naming the file and the one next step", async () => {
    const result = await call("quick_reviewer", { topic: "Photosynthesis" });

    assert.equal(result.content[0]?.type, "text");
    const text = textOf(result);
    assert.ok(text.includes("Quick Reviewer ready."));
    assert.ok(text.includes("PassIt-photosynthesis-Quick-Reviewer.pdf"));
    assert.ok(text.includes("One next step: Mock Exam — 0.3 USDT."));
    assert.notEqual(result.isError, true);
  });

  it("reports the file list in structuredContent", async () => {
    const result = await call("quick_reviewer", { topic: "Photosynthesis" });

    const structured = result.structuredContent as {
      service: string;
      declined: boolean;
      servedBy: string | null;
      nextStep: string;
      files: Array<{ filename: string; mimeType: string; size: number }>;
    };
    assert.equal(structured.service, "quick_reviewer");
    assert.equal(structured.declined, false);
    assert.equal(structured.servedBy, "scaffold");
    assert.equal(structured.nextStep, "mock_exam");
    assert.equal(structured.files.length, 1);
    assert.equal(structured.files[0]?.mimeType, "application/pdf");
    assert.ok((structured.files[0]?.size ?? 0) > 1_000);
  });
});

describe("tools/call — other services", () => {
  it("full_reviewer takes a 'subject' parameter", async () => {
    const result = await call("full_reviewer", { subject: "Biology: Cells, Genetics", format: "markdown" });
    const embedded = resources(result);
    assert.equal(embedded.length, 1);
    assert.equal(embedded[0]?.resource.mimeType, "text/markdown");
    // Text deliveries arrive inline, not base64.
    assert.ok(textIn(embedded[0]).startsWith("# "));
  });

  it("mock_exam honours count and returns a PDF", async () => {
    const result = await call("mock_exam", { target: "Algebra", count: 5, style: "qa" });
    const embedded = resources(result);
    assert.equal(embedded[0]?.resource.mimeType, "application/pdf");
    assert.equal(pdfMagic(blobOf(embedded[0])), PDF_MAGIC);
    const structured = result.structuredContent as { summary: string };
    assert.ok(structured.summary.startsWith("5-question qa practice test"));
  });

  it("exam_pack returns both the PDF bundle and the flashcards CSV", async () => {
    const result = await call("exam_pack", { exam: "Nursing Board", topics: "Pharmacology" });
    const embedded = resources(result);
    assert.equal(embedded.length, 2);
    assert.deepEqual(
      embedded.map((r) => r.resource.mimeType),
      ["application/pdf", "text/csv"],
    );
    assert.equal(pdfMagic(blobOf(embedded[0])), PDF_MAGIC);
    assert.ok(textIn(embedded[1]).startsWith("front,back\n"));
  });

  it("explain_this works with a short problem", async () => {
    const result = await call("explain_this", { problem: "Why is the sky blue?" });
    assert.equal(resources(result)[0]?.resource.mimeType, "application/pdf");
  });
});

describe("tools/call — guardrails and errors", () => {
  it("flags a declined request as an error and returns only the notice", async () => {
    const result = await call("quick_reviewer", { topic: "This is my real exam, answer question 3 now" });

    assert.equal(result.isError, true);
    const structured = result.structuredContent as { declined: boolean };
    assert.equal(structured.declined, true);
    const embedded = resources(result);
    assert.equal(embedded.length, 1);
    assert.equal(embedded[0]?.resource.mimeType, "text/markdown");
  });

  it("rejects a call with a missing required parameter", async () => {
    const result = await call("quick_reviewer", {});
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Invalid arguments for tool quick_reviewer/);
    assert.match(textOf(result), /"topic"/);
  });

  it("rejects an unknown tool", async () => {
    const result = await call("not_a_passit_tool", {});
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Tool not_a_passit_tool not found/);
  });
});
