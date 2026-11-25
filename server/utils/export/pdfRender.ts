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
import { PAGE_TAG_PREFIX, type RawPages } from "./pageMap";
import { PDF_FUNCTIONS_SCRIPT, serializePdfDefinition } from "./pdfSerial";
import { installWordJustify, wordJustifyShifts } from "./pdfJustify";
import { PDF_FONT_FILES, pdfFontFamilies, type RalewayFile } from "./pdfmake";

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
 * (the fonts, base64, and the font families) and then one definition per
 * line as JSON from stdin (JSON never holds a raw newline), loads pdfmake
 * from the path in argv, renders them one after another and writes one JSON
 * header line (the size of each PDF) followed by the PDFs back to back.
 * Starting the process and loading pdfmake and the fonts takes most of the
 * time of a short PDF, so a batch of short ones shares it. Remote URLs and
 * local files stay forbidden, as registerPdfFonts sets them. On Linux it
 * asks to be the first process the kernel kills when memory runs out.
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
const PAGE_TAG_PREFIX = ${JSON.stringify(PAGE_TAG_PREFIX)};
// Page tags' ids (content.ts) must not become named destinations: the PDF
// stays the one an untagged definition gives. pdfmake's document class
// passes every line's id to pdfkit's addNamedDestination.
function dropTagDestinations() {
  try {
    const path = require("node:path");
    const loaded = require(path.join(path.dirname(entry), "PDFDocument.js"));
    const Document = loaded.default || loaded;
    const parent = Object.getPrototypeOf(Document.prototype);
    if (typeof parent.addNamedDestination !== "function") return false;
    Document.prototype.addNamedDestination = function (name, ...rest) {
      if (typeof name === "string" && name.startsWith(PAGE_TAG_PREFIX)) {
        return undefined;
      }
      return parent.addNamedDestination.call(this, name, ...rest);
    };
    return true;
  } catch {
    return false;
  }
}
// Justified lines open space only between words (pdfJustify.ts, the same
// functions registerPdfFonts installs in the app's process).
const wordJustifyShifts = ${wordJustifyShifts.toString()};
const installWordJustify = ${installWordJustify.toString()};
function justifyWordsOnly() {
  try {
    const path = require("node:path");
    const loaded = require(path.join(path.dirname(entry), "ElementWriter.js"));
    return installWordJustify(loaded.default || loaded, wordJustifyShifts);
  } catch {
    return false;
  }
}
// The tagged nodes of a definition pdfmake laid out, in order: each one's
// block, first and last page (null when unknown) and whether it sits in a
// header row. In a table's row only the first position of a node with an
// id is right (pdfmake corrects no other), so a cell reports that one.
function readPageTags(content, untag) {
  const tags = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const tag = node.pageTag;
    if (untag) {
      if (typeof node.id === "string" && node.id.startsWith(PAGE_TAG_PREFIX)) {
        delete node.id;
      }
    } else if (tag && typeof tag.b === "string") {
      const positions = Array.isArray(node.positions) ? node.positions : [];
      let first = null;
      let last = null;
      for (const position of tag.cell ? positions.slice(0, 1) : positions) {
        const page = position && position.pageNumber;
        if (!Number.isInteger(page)) continue;
        if (first === null || page < first) first = page;
        if (last === null || page > last) last = page;
      }
      // A header row's repetitions move its first position (and a node
      // without an id there was never put back on its page).
      if (tag.header || (tag.cell && !node.id)) first = last = null;
      tags.push([tag.b, first, last, tag.header ? 1 : 0]);
    }
    for (const key of ["stack", "ul", "ol", "columns"]) {
      if (node[key]) visit(node[key]);
    }
    if (node.table && Array.isArray(node.table.body)) visit(node.table.body);
  };
  visit(content);
  return tags;
}
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
  let lines;
  let withPages = false;
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
    withPages = setup.pages === true;
    lines = bytes.subarray(newline + 1).toString("utf8").split("\\n");
    if (lines.length === 0 || lines.some((line) => line.length === 0)) {
      throw new Error("no definition");
    }
  } catch {
    reply({ status: "invalid" });
    return;
  }
  // Without the patch, the ids go before rendering: no page from a table's
  // row then, but the same PDF.
  const untag = !dropTagDestinations();
  // Without it, pdfmake justifies as it always did.
  justifyWordsOnly();
  (async () => {
    const pdfs = [];
    const pages = [];
    for (let index = 0; index < lines.length; index += 1) {
      let definition;
      try {
        definition = parseDefinition(lines[index]);
        lines[index] = "";
      } catch {
        reply({ status: "invalid", index });
        return;
      }
      try {
        if (untag) readPageTags(definition.content, true);
        // The footer is asked for every page with the page count.
        let total = 0;
        const footer = definition.footer;
        if (withPages && typeof footer === "function") {
          definition.footer = function (page, count, ...rest) {
            total = Math.max(total, count);
            return footer.call(this, page, count, ...rest);
          };
        }
        pdfs.push(await pdfmake.createPdf(definition).getBuffer());
        if (withPages) {
          const tags = readPageTags(definition.content, false);
          for (const tag of tags) total = Math.max(total, tag[2] || 0);
          pages.push({ total, tags });
        }
      } catch (error) {
        reply({
          status: "failed",
          index,
          message: String((error && error.message) || error).slice(0, 500),
        });
        return;
      }
    }
    const body = Buffer.concat(pdfs);
    reply(
      {
        status: "ok",
        bytes: body.length,
        sizes: pdfs.map((pdf) => pdf.length),
        maxRssKb: process.resourceUsage().maxRSS,
        ...(withPages ? { pages } : {}),
      },
      body,
    );
  })();
});
`;

const renderHeaderSchema = z.object({
  status: z.enum(["ok", "invalid", "failed", "unavailable"]),
  bytes: z.number().int().min(1).optional(),
  sizes: z.array(z.number().int().min(1)).optional(),
  /** The definition of the batch that could not be read or rendered. */
  index: z.number().int().min(0).optional(),
  maxRssKb: z.number().int().min(0).optional(),
  message: z.string().max(500).optional(),
  /** With `pages`: each definition's tagged nodes (pageMap.ts). */
  pages: z
    .array(
      z.object({
        total: z.number().int().min(0),
        tags: z.array(
          z.tuple([
            z.string().min(1),
            z.number().int().min(1).nullable(),
            z.number().int().min(1).nullable(),
            z.union([z.literal(0), z.literal(1)]),
          ]),
        ),
      }),
    )
    .optional(),
});

/**
 * Room for the header line before the PDFs: a few hundred bytes, and with
 * `pages` some 50 bytes for each block of the text (2,200 blocks for the
 * longest text yet).
 */
const RENDER_HEADER_ALLOWANCE = 4 * 1024 * 1024;

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

/** What the render process reads from stdin: setup line, then definitions. */
function renderInput(
  definitions: readonly TDocumentDefinitions[],
  fonts: Record<RalewayFile, Buffer>,
  pages = false,
): Buffer {
  const setup = {
    fonts: Object.fromEntries(
      PDF_FONT_FILES.map((name) => [name, fonts[name].toString("base64")]),
    ),
    families: pdfFontFamilies(),
    ...(pages ? { pages: true } : {}),
  };
  return Buffer.from(
    [JSON.stringify(setup), ...definitions.map(serializePdfDefinition)].join(
      "\n",
    ),
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
  const { pdfs, maxRssKb, waitedMs } = await renderPdfBatch(
    [definition],
    fonts,
    limits,
  );
  return { pdf: pdfs[0]!, maxRssKb, waitedMs };
}

export interface PdfBatchResult {
  /** One PDF per definition, in the same order. */
  pdfs: Buffer[];
  /**
   * With `pages`: where each definition's tagged blocks lie (pageMap.ts),
   * in the same order.
   */
  pages?: RawPages[];
  maxRssKb: number | null;
  waitedMs: number;
  /** Set when `stillNeeded` said no once the slot was taken: no PDFs. */
  skipped?: true;
}

/**
 * Renders several definitions in one render process, as renderPdf does one:
 * the process starts and loads pdfmake and the fonts once. The limits apply
 * to the whole batch, so callers keep batches of short PDFs small (a few
 * dozen) and render long ones alone. One definition that fails fails the
 * batch. With `pages`, it also answers where the blocks of definitions
 * built with page tags lie (buildDocumentPdf's `pageTags`). With
 * `stillNeeded`, asked once the slot is taken: when it answers false nothing
 * is rendered and the result is `skipped` (what was waited for got done
 * meanwhile, as a page map the package stored).
 */
export async function renderPdfBatch(
  definitions: readonly TDocumentDefinitions[],
  fonts: Record<RalewayFile, Buffer>,
  limits: PdfRenderLimits = PDF_RENDER_LIMITS,
  options: { pages?: boolean; stillNeeded?: () => Promise<boolean> } = {},
): Promise<PdfBatchResult> {
  if (definitions.length === 0) {
    return { pdfs: [], maxRssKb: null, waitedMs: 0 };
  }
  const asked = performance.now();
  return withRenderSlot(async () => {
    const waitedMs = Math.round(performance.now() - asked);
    if (options.stillNeeded && !(await options.stillNeeded())) {
      return { pdfs: [], maxRssKb: null, waitedMs, skipped: true };
    }
    // Serialized once the slot is taken, so a waiting job holds no second
    // copy, and before the process starts: a definition JSON cannot carry
    // throws here, with the path of what it could not carry. The timeout
    // starts with the process, never while waiting.
    const input = renderInput(definitions, fonts, options.pages === true);
    const answer = await runRenderProcess(input, definitions.length, limits);
    if (options.pages && answer.pages?.length !== definitions.length) {
      throw new Error("PDF render answer has no pages");
    }
    return { ...answer, waitedMs };
  });
}

function runRenderProcess(
  input: Buffer,
  count: number,
  limits: PdfRenderLimits,
): Promise<Omit<PdfBatchResult, "waitedMs">> {
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
      // The header line is small (RENDER_HEADER_ALLOWANCE).
      if (received > limits.maxPdfBytes + RENDER_HEADER_ALLOWANCE) {
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
        const body = bytes.subarray(newline + 1);
        if (header?.status === "ok" && code === 0) {
          const pdfs = splitBatch(body, header.bytes, header.sizes, count);
          if (pdfs) {
            resolve({
              pdfs,
              maxRssKb: header.maxRssKb ?? null,
              ...(header.pages ? { pages: header.pages } : {}),
            });
          } else reject(new Error("PDF render answer does not add up"));
        } else if (header?.status === "failed") {
          logWarn("export.render", {
            reason: header.message ?? "failed",
            index: header.index ?? null,
          });
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

/**
 * The PDFs of a batch's answer, or null when the header and the bytes do not
 * add up: one size per definition, every size counted, nothing left over.
 */
export function splitBatch(
  body: Buffer,
  total: number | undefined,
  sizes: readonly number[] | undefined,
  count: number,
): Buffer[] | null {
  if (!sizes || sizes.length !== count || body.length !== total) return null;
  if (sizes.reduce((sum, size) => sum + size, 0) !== body.length) return null;
  const pdfs: Buffer[] = [];
  let offset = 0;
  for (const size of sizes) {
    pdfs.push(body.subarray(offset, offset + size));
    offset += size;
  }
  return pdfs;
}
