// Generates one real sample per service into samples/.
//
// Calls the service functions directly — no HTTP, no paywall, no payment — so
// you can see exactly what a buyer receives. With no provider keys configured
// the content engine falls back to its deterministic scaffold, so this always
// produces real files (servedBy tells you which path was taken).
//
// Usage:  npm run demo
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quickReviewer, fullReviewer, mockExam, explainThis, examPack } from "../src/services.js";
import { SERVICES } from "../src/config.js";
import type { ServiceId, ServiceResult } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "samples");

interface Job {
  id: ServiceId;
  /** Echoed in the log so the sample is traceable to its input. */
  input: string;
  run: () => Promise<ServiceResult>;
}

// Generated in sequence, not in parallel: the free provider tiers have tight
// per-minute limits and five concurrent runs would trip them.
const JOBS: Job[] = [
  {
    id: "quick_reviewer",
    input: "Photosynthesis",
    run: () => quickReviewer({ topic: "Photosynthesis" }),
  },
  {
    id: "full_reviewer",
    input: "General Biology: cell structure, photosynthesis, genetics",
    run: () => fullReviewer({ topic: "General Biology: cell structure, photosynthesis, genetics" }),
  },
  {
    id: "mock_exam",
    input: "Basic Algebra",
    run: () => mockExam({ target: "Basic Algebra", style: "mixed", count: 10 }),
  },
  {
    id: "explain_this",
    input: "Why does dividing by a fraction flip the fraction?",
    run: () => explainThis({ problem: "Why does dividing by a fraction flip the fraction?" }),
  },
  {
    id: "exam_pack",
    input: "Nursing Licensure Exam — pharmacology basics, fluids and electrolytes",
    run: () =>
      examPack({
        exam: "Nursing Licensure Exam",
        topics: "pharmacology basics, fluids and electrolytes",
      }),
  },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  console.log("");
  console.log("PassIt — sample generation");
  console.log(`  output : ${OUT}`);
  console.log("");

  let files = 0;
  let bytes = 0;
  let failures = 0;

  for (const job of JOBS) {
    const service = SERVICES[job.id];
    const started = Date.now();
    console.log(`${service.title}  (${job.id}, ${service.priceUsdt} USDT)`);
    console.log(`  input     : ${job.input}`);

    let result: ServiceResult;
    try {
      result = await job.run();
    } catch (err) {
      failures++;
      console.log(`  ERROR     : ${err instanceof Error ? err.message : String(err)}`);
      console.log("");
      continue;
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  servedBy  : ${result.servedBy ?? "(not reported)"}  ·  ${secs}s`);
    if (result.declined) console.log(`  DECLINED  : the guardrails refused this request`);
    console.log(`  summary   : ${result.summary}`);

    for (const file of result.deliveries) {
      writeFileSync(resolve(OUT, file.filename), file.bytes);
      files++;
      bytes += file.bytes.length;
      console.log(
        `  file      : ${relative(ROOT, resolve(OUT, file.filename))}  ` +
          `${file.bytes.length.toLocaleString()} bytes  ${file.mimeType}`,
      );
    }
    console.log("");
  }

  console.log(`${files} file(s), ${bytes.toLocaleString()} bytes total, in ${OUT}`);
  if (failures > 0) {
    console.log(`${failures} service(s) threw — see the errors above.`);
    process.exit(1);
  }
  console.log("");
}

await main();
