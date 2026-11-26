import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setPriority } from "node:os";
import { logWarn } from "../core/logger";

/**
 * An account's logo may be any SVG an Intranet account uploaded
 * (docs/seating-plan.md, "Facts"). librsvg's work is bounded by neither the
 * byte cap nor sharp's `limitInputPixels`: a small file with many full
 * canvas filters takes minutes, renders as one tile (sharp's `timeout()`
 * fires only once it is done) and, run here, would hold libuv's thread pool
 * that serves files and opens database connections for the room. So an SVG
 * is drawn in a separate Node process, as PDFs are (renderPdf in
 * server/utils/export/pdfRender.ts), killed outright when it runs out of
 * time, one at a time. Rasters are bounded by their pixels and stay here.
 */

export interface SvgRenderLimits {
  /** Wall-clock time the drawing may take, in ms. */
  timeoutMs: number;
  /** V8 heap of the process, in MB (libvips' own memory is outside it). */
  heapMb: number;
  /** Bytes of WebP the process may return. */
  maxOutputBytes: number;
  /**
   * The process's niceness: 10 lets the room's requests come first. A test
   * running beside a full suite gives 0, or the runner's own workers starve
   * it past its timeout (Windows above all).
   */
  priority?: number;
}

/** A logo is 192 px of WebP, a few KB: ten seconds is plenty for one. */
export const SVG_RENDER_LIMITS: SvgRenderLimits = {
  timeoutMs: 10_000,
  heapMb: 96,
  maxOutputBytes: 2 * 1024 * 1024,
};

export interface SvgRenderOptions {
  /** Side of the square WebP, in pixels. */
  side: number;
  /** Pixels sharp agrees to decode. */
  maxInputPixels: number;
}

/**
 * The process (CommonJS, run with `node -e`): reads the SVG from stdin,
 * loads sharp from the path in argv, fits it on white in a `side` square
 * WebP and writes it to stdout. Any failure exits without output. On Linux
 * it asks to be the first process the kernel kills when memory runs out.
 */
const SVG_SCRIPT = `"use strict";
if (process.platform === "linux") {
  try {
    require("node:fs").writeFileSync("/proc/self/oom_score_adj", "1000");
  } catch {}
}
const [entry, side, maxPixels] = process.argv.slice(1);
const input = [];
process.stdin.on("data", (chunk) => input.push(chunk));
process.stdin.on("end", () => {
  let sharp;
  try {
    sharp = require(entry);
    sharp.concurrency(1);
    sharp.cache(false);
  } catch {
    process.exit(3);
  }
  const size = Number(side);
  sharp(Buffer.concat(input), {
    limitInputPixels: Number(maxPixels),
    failOn: "error",
    density: 144,
  })
    .resize(size, size, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .webp({ quality: 82 })
    .toBuffer()
    .then(
      (out) => process.stdout.write(out, () => process.exit(0)),
      () => process.exit(2),
    );
});
`;

/** Environment variables the process inherits; nothing else. */
const SVG_ENV_KEYS = ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "TZ"];

function svgEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SVG_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

let sharpEntry: string | undefined;

/** One SVG at a time: logos are few, and each one may take its whole time. */
let svgQueue: Promise<unknown> = Promise.resolve();

/**
 * Draws an SVG logo into a `side` square WebP on white in a separate
 * process limited to `limits`, after any SVG already being drawn. Null when
 * it cannot be drawn: broken, too large, out of time or out of memory (the
 * same logo would do it again, so the job is not retried).
 */
export function renderSvgInProcess(
  input: Buffer,
  options: SvgRenderOptions,
  limits: SvgRenderLimits = SVG_RENDER_LIMITS,
): Promise<Buffer | null> {
  const run = svgQueue.then(() => runSvgProcess(input, options, limits));
  svgQueue = run.catch(() => null);
  return run;
}

function runSvgProcess(
  input: Buffer,
  options: SvgRenderOptions,
  limits: SvgRenderLimits,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      sharpEntry ??= createRequire(import.meta.url).resolve("sharp");
      child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${limits.heapMb}`,
          "-e",
          SVG_SCRIPT,
          sharpEntry,
          String(options.side),
          String(options.maxInputPixels),
        ],
        {
          env: svgEnv(),
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch {
      logWarn("seating.images", { outcome: "svg_unavailable" });
      resolve(null);
      return;
    }
    // The room's requests come first.
    const priority = limits.priority ?? 10;
    if (child.pid !== undefined && priority !== 0) {
      try {
        setPriority(child.pid, priority);
      } catch {
        // Not allowed here: it runs at the app's priority.
      }
    }

    const output: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(() => kill("svg_timeout"), limits.timeoutMs);
    const finish = (result: Buffer | null, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) logWarn("seating.images", { outcome: reason, kind: "logo" });
      resolve(result);
    };
    const kill = (reason: string) => {
      finish(null, reason);
      child.kill("SIGKILL");
    };

    child.on("error", () => kill("svg_unavailable"));
    // The process may exit before reading all of stdin.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > limits.maxOutputBytes) {
        kill("svg_too_large");
        return;
      }
      output.push(chunk);
    });
    child.on("close", (code) => {
      const out = Buffer.concat(output);
      finish(code === 0 && out.length > 0 ? out : null);
    });

    child.stdin?.end(input);
  });
}
