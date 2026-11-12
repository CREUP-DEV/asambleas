import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setPriority } from "node:os";
import { performance } from "node:perf_hooks";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
// pdfmake only runs in the render process, which loads it by path (see
// renderPdf). This import keeps it among the server's traced dependencies.
import "pdfmake";
import { z } from "zod/v4";
import { logError, logWarn } from "../core/logger";
import { PDF_FUNCTIONS_SCRIPT, serializePdfDefinition } from "./pdfSerial";
import { RALEWAY_FILES, type RalewayFile } from "./pdfmake";

/**
 * pdfmake lays a PDF out synchronously: about 1.5 s plus 0.15 s a page, 20 s
 * for a whole assembly's dossier. Run in the app's only process, that froze
 * the live stream, the Mesa's console and the projection for the whole
 * room. So pdfmake runs in a separate Node process, as mammoth does for DOCX
 * imports (server/utils/content/docx.ts), with its own heap ceiling and a
 * wall-clock timeout. A worker thread is not enough: past its resourceLimits
 * V8 can abort the whole process instead of the worker.
 *
 * The definition is built here (pdfBuilder.ts, milliseconds) and crosses as
 * JSON (pdfSerial.ts). The fonts cross too: server assets are bundled into
 * the build, so the process cannot read them from disk.
 */

export interface PdfRenderLimits {
  /** V8 heap of the render process, in MB. */
  heapMb: number;
  /**
   * Wall-clock time the render may take, in ms. Below the three minutes the
   * client polls for (ExportButton), so a job that runs out fails first.
   */
  timeoutMs: number;
  /** Bytes of PDF the process may return. */
  maxPdfBytes: number;
}

/**
 * Sized for the production container (docker-compose.production.example.yml:
 * 640 MB for everything, a 448 MB heap for the app): the render runs next to
 * the app, and only one at a time (withRenderSlot). The heap ceiling should
 * trip before the container's limit does, so a render too big fails cleanly
 * instead of the kernel killing it, and a lower ceiling also makes V8
 * collect sooner, which keeps the process smaller. It bounds only the heap:
 * images and the PDF being written live outside it.
 *
 * Measured on a development machine (Windows, peak resident memory): a
 * 212-page dossier of text renders within 64 MB of heap (183 MB resident;
 * 276 MB with a 128 MB ceiling, 360 MB with 320 MB); a 222-page one with ten
 * 2400 x 1600 photographs (27 MB of PDF) needs between 64 and 128 MB of heap
 * and stays at 351 MB resident with 128 MB, 388 MB with 192 MB and 450 MB
 * with 320 MB. Measure again on the 1 vCPU, 640 MB box with the largest real
 * dossier (export-worker.timing logs maxRssKb) before raising it. The PDF is
 * held twice in the app while it is checked, hence maxPdfBytes.
 */
export const PDF_RENDER_LIMITS: PdfRenderLimits = {
  heapMb: 192,
  timeoutMs: 150_000,
  maxPdfBytes: 64 * 1024 * 1024,
};

/** Renders running at once, for both export queues together. */
const MAX_RUNNING_RENDERS = 1;
let runningRenders = 0;
const waitingRenders: (() => void)[] = [];

/**
 * Runs `task` once fewer than MAX_RUNNING_RENDERS are running, in the order
 * asked, so the assembly and document queues (two pg-boss workers) never
 * multiply the render's memory. Nobody is refused: an export job waits.
 */
export async function withRenderSlot<T>(task: () => Promise<T>): Promise<T> {
  if (runningRenders < MAX_RUNNING_RENDERS) runningRenders++;
  // The slot is handed over by the task that releases it.
  else await new Promise<void>((resolve) => waitingRenders.push(resolve));
  try {
    return await task();
  } finally {
    const next = waitingRenders.shift();
    if (next) next();
    else runningRenders--;
  }
}

/**
 * The render process (CommonJS, run with `node -e`). It reads one JSON line
 * (the fonts, base64, and the font families) and then the definition as JSON
 * from stdin, loads pdfmake from the path in argv, and writes one JSON header
 * line followed by the PDF. Remote URLs and local files stay forbidden, as
 * registerPdfFonts sets them. On Linux it asks to be the first process the
 * kernel kills when memory runs out.
 */
const RENDER_SCRIPT = `"use strict";
if (process.platform === "linux") {
  try {
    require("node:fs").writeFileSync("/proc/self/oom_score_adj", "1000");
  } catch {}
}
const [entry] = process.argv.slice(1);
const input = [];
function reply(header, body) {
  const head = Buffer.from(JSON.stringify(header) + "\\n", "utf8");
  process.stdout.write(body ? Buffer.concat([head, body]) : head);
}
${PDF_FUNCTIONS_SCRIPT}
process.stdin.on("data", (chunk) => input.push(chunk));
process.stdin.on("end", () => {
  let pdfmake;
  try {
    pdfmake = require(entry);
    if (typeof pdfmake.createPdf !== "function") throw new Error("no pdfmake");
  } catch {
    reply({ status: "unavailable" });
    return;
  }
  let definition;
  try {
    const bytes = Buffer.concat(input.splice(0));
    const newline = bytes.indexOf(10);
    const setup = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
    for (const [name, data] of Object.entries(setup.fonts)) {
      pdfmake.virtualfs.writeFileSync(name, Buffer.from(data, "base64"));
    }
    pdfmake.setFonts(setup.families);
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy(() => false);
    definition = parseDefinition(bytes.subarray(newline + 1).toString("utf8"));
  } catch {
    reply({ status: "invalid" });
    return;
  }
  Promise.resolve()
    .then(() => pdfmake.createPdf(definition).getBuffer())
    .then(
      (pdf) =>
        reply(
          {
            status: "ok",
            bytes: pdf.length,
            maxRssKb: process.resourceUsage().maxRSS,
          },
          pdf,
        ),
      (error) =>
        reply({
          status: "failed",
          message: String((error && error.message) || error).slice(0, 500),
        }),
    );
});
`;

const renderHeaderSchema = z.object({
  status: z.enum(["ok", "invalid", "failed", "unavailable"]),
  bytes: z.number().int().min(1).optional(),
  maxRssKb: z.number().int().min(0).optional(),
  message: z.string().max(500).optional(),
});

/**
 * The render process ran out of heap, time or room for its answer: the same
 * export would do it again, so the job is not retried (ExportRejectedError
 * in the worker).
 */
export class PdfRenderLimitError extends Error {
  override name = "PdfRenderLimitError";
}

/**
 * The error for a render process that ended without an answer. Past its
 * heap ceiling V8 aborts it (SIGABRT, or a nonzero code): the same export
 * would do it again. SIGKILL is never ours here (a timeout or an answer too
 * large settle first), so it comes from the kernel, out of memory in the
 * container, which may be another process's doing: a plain Error, so
 * pg-boss retries the job (EXPORT_RETRY_LIMIT bounds it).
 */
export function unansweredRenderError(signal: NodeJS.Signals | null): Error {
  return signal === "SIGKILL"
    ? new Error("PDF render process was killed")
    : new PdfRenderLimitError("PDF render ran out of memory");
}

export interface PdfRenderResult {
  pdf: Buffer;
  /** Peak resident memory of the render process, in KB, when it said. */
  maxRssKb: number | null;
  /** Time spent waiting for the render slot, in ms. */
  waitedMs: number;
}

/** Environment variables the render process inherits; nothing else. */
const RENDER_ENV_KEYS = ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "TZ"];

function renderEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of RENDER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

let pdfmakeEntry: string | undefined;

/** What the render process reads from stdin: setup line, then definition. */
function renderInput(
  definition: TDocumentDefinitions,
  fonts: Record<RalewayFile, Buffer>,
): Buffer {
  const setup = {
    fonts: Object.fromEntries(
      Object.values(RALEWAY_FILES).map((name) => [
        name,
        fonts[name].toString("base64"),
      ]),
    ),
    families: { Raleway: { ...RALEWAY_FILES } },
  };
  return Buffer.from(
    `${JSON.stringify(setup)}\n${serializePdfDefinition(definition)}`,
    "utf8",
  );
}

/**
 * Lays `definition` out and renders it with pdfmake in a separate Node
 * process limited to `heapMb` of heap and `timeoutMs` of wall clock, at a
 * lower CPU priority than the app, once the render slot is free
 * (withRenderSlot), and answers the PDF's bytes. The process gets neither
 * NODE_OPTIONS nor this process's flags or secrets. Throws
 * PdfRenderLimitError when it runs out of heap, time or room, and a plain
 * Error when it cannot run, is killed from outside or pdfmake fails.
 */
export async function renderPdf(
  definition: TDocumentDefinitions,
  fonts: Record<RalewayFile, Buffer>,
  limits: PdfRenderLimits = PDF_RENDER_LIMITS,
): Promise<PdfRenderResult> {
  const asked = performance.now();
  return withRenderSlot(async () => {
    const waitedMs = Math.round(performance.now() - asked);
    // Serialized once the slot is taken, so a waiting job holds no second
    // copy, and before the process starts: a definition JSON cannot carry
    // throws here, with the path of what it could not carry. The timeout
    // starts with the process, never while waiting.
    const input = renderInput(definition, fonts);
    const answer = await runRenderProcess(input, limits);
    return { ...answer, waitedMs };
  });
}

function runRenderProcess(
  input: Buffer,
  limits: PdfRenderLimits,
): Promise<Omit<PdfRenderResult, "waitedMs">> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      pdfmakeEntry ??= createRequire(import.meta.url).resolve("pdfmake");
      child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${limits.heapMb}`,
          "-e",
          RENDER_SCRIPT,
          pdfmakeEntry,
        ],
        {
          env: renderEnv(),
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // The room's requests come first; the render takes what CPU is left.
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // Not allowed here: it runs at the app's priority.
      }
    }

    const output: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(
      () => abort(new PdfRenderLimitError("PDF render timed out")),
      limits.timeoutMs,
    );
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const abort = (error: Error) => {
      settle(() => reject(error));
      child.kill("SIGKILL");
    };
    child.on("error", (error) => {
      logError("export.render", error);
      abort(new Error("PDF render process failed to run"));
    });
    // The process may exit before reading all of stdin (out of heap, say);
    // its exit decides the outcome, so a broken pipe is not an error here.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      // The header line is a few hundred bytes at most.
      if (received > limits.maxPdfBytes + 16_384) {
        abort(new PdfRenderLimitError("PDF too large"));
        return;
      }
      output.push(chunk);
    });
    child.on("close", (code, signal) => {
      settle(() => {
        const bytes = Buffer.concat(output);
        const newline = bytes.indexOf(0x0a);
        let header: z.infer<typeof renderHeaderSchema> | null = null;
        if (newline !== -1) {
          try {
            const parsed = renderHeaderSchema.safeParse(
              JSON.parse(bytes.subarray(0, newline).toString("utf8")),
            );
            if (parsed.success) header = parsed.data;
          } catch {
            header = null;
          }
        }
        const pdf = bytes.subarray(newline + 1);
        if (header?.status === "ok" && code === 0) {
          if (pdf.length === header.bytes) {
            resolve({ pdf, maxRssKb: header.maxRssKb ?? null });
          } else reject(new Error("PDF render answer does not add up"));
        } else if (header?.status === "failed") {
          logWarn("export.render", { reason: header.message ?? "failed" });
          reject(new Error("PDF render failed"));
        } else if (header) {
          reject(new Error(`PDF render ${header.status}`));
        } else {
          // No answer: the heap ceiling, or the kernel out of memory.
          logWarn("export.render", { code, signal });
          reject(unansweredRenderError(signal));
        }
      });
    });

    child.stdin?.end(input);
  });
}
