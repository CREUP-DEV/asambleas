import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import sharp from "sharp";
import { z } from "zod/v4";
import { intranetIdSchema } from "~~/shared/utils/schemas/member";
import { entityIdSchema } from "~~/shared/utils/schemas/primitives";
import { db } from "../../db";
import { keepUpdatedAt } from "../optimisticLock";
import { seatingGroups, seatingPeople, seatingPlans } from "../../db/schema";
import { logError, logInfo, logWarn } from "../core/logger";
import { notifyLive, type Executor } from "../domain/events";
import { getExportQueue } from "../export/queue";
import { IntranetUnavailableError } from "../members/intranet";
import {
  rememberFailedSeatingImage,
  seatingImageKey,
  withoutFailedSeatingImages,
} from "./failedImages";
import {
  SEATING_IMAGE_VERSION_PATTERN,
  parseSeatingImageFileName,
  seatingImageDir,
  seatingImageFileName,
} from "./files";
import { fetchSeatingImage, type SeatingImageKind } from "./intranet";
import {
  SVG_RENDER_LIMITS,
  renderSvgInProcess,
  type SvgRenderLimits,
} from "./svgRender";

/**
 * The images of the seating view (docs/seating-plan.md, section 6): each
 * sync queues the account logos and attendee photos whose version changed
 * (pg-boss queue `seating-images`, on the export queue's instance). A job
 * fetches the image from the Intranet with the token (never a browser), at
 * most SEATING_IMAGE_CONCURRENCY at a time and SEATING_IMAGE_MAX_BYTES each,
 * and writes a 192 × 192 WebP drawn by sharp: a photo cropped to a square,
 * a logo fitted on white. The row then names the file, but only if its
 * version is still the one fetched; otherwise the file goes again.
 */

export const SEATING_IMAGES_QUEUE = "seating-images";
/** Side of every cached image, in pixels. */
export const SEATING_IMAGE_SIDE = 192;
/** Images fetched at once by this process. */
export const SEATING_IMAGE_CONCURRENCY = 4;
/** Pixels sharp agrees to decode: a 3000 px photo has 9 million. */
const SEATING_IMAGE_MAX_INPUT_PIXELS = 40_000_000;
/** Retries of a fetch the Intranet could not answer. */
const SEATING_IMAGE_RETRY_LIMIT = 3;

export const seatingImageJobSchema = z.object({
  assemblyId: z.string().min(1),
  planId: entityIdSchema,
  kind: z.enum(["logo", "photo"]),
  /** The group (logo) or the person (photo). */
  id: entityIdSchema,
  intranetId: intranetIdSchema,
  version: z.string().regex(SEATING_IMAGE_VERSION_PATTERN),
});
export type SeatingImageJob = z.infer<typeof seatingImageJobSchema>;

// Drawing --------------------------------------------------------------------

type SourceFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "svg";

/** The image's format by its first bytes, never by a name or a header. */
export function sniffImageFormat(input: Buffer): SourceFormat | null {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8) {
    return input[2] === 0xff ? "jpeg" : null;
  }
  const head = input.subarray(0, 16).toString("latin1");
  if (head.startsWith("\u0089PNG\r\n\u001a\n")) return "png";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  if (head.slice(4, 8) === "ftyp" && /^(avif|avis)$/.test(head.slice(8, 12))) {
    return "avif";
  }
  const text = input
    .subarray(0, 1024)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (
    /^<svg[\s>]/i.test(text) ||
    (/^<\?xml/i.test(text) && /<svg[\s>]/i.test(text))
  ) {
    return "svg";
  }
  return null;
}

/** A photo is a raster the Intranet accepts; a logo may also be a GIF or SVG. */
const ACCEPTED: Record<SeatingImageKind, ReadonlySet<SourceFormat>> = {
  photo: new Set(["jpeg", "png", "webp", "avif"]),
  logo: new Set(["jpeg", "png", "webp", "avif", "gif", "svg"]),
};

/**
 * The cached picture: SEATING_IMAGE_SIDE square WebP, without metadata. A
 * photo is turned upright and cropped to the square; a logo is fitted
 * inside it on white. An SVG is rasterised in a process of its own, killed
 * when it runs out of `svgLimits` (renderSvgInProcess). Null for anything
 * that is not an accepted image or that cannot be drawn.
 */
export async function renderSeatingImage(
  input: Buffer,
  kind: SeatingImageKind,
  svgLimits: SvgRenderLimits = SVG_RENDER_LIMITS,
): Promise<Buffer | null> {
  const format = sniffImageFormat(input);
  if (!format || !ACCEPTED[kind].has(format)) return null;
  if (format === "svg") {
    const drawn = await renderSvgInProcess(
      input,
      {
        side: SEATING_IMAGE_SIDE,
        maxInputPixels: SEATING_IMAGE_MAX_INPUT_PIXELS,
      },
      svgLimits,
    );
    // What came back must be the WebP asked for, nothing else.
    return drawn && sniffImageFormat(drawn) === "webp" ? drawn : null;
  }
  try {
    const image = sharp(input, {
      limitInputPixels: SEATING_IMAGE_MAX_INPUT_PIXELS,
      failOn: "error",
      animated: false,
    });
    const fitted =
      kind === "photo"
        ? image.rotate().resize(SEATING_IMAGE_SIDE, SEATING_IMAGE_SIDE, {
            fit: "cover",
            position: "centre",
          })
        : image.resize(SEATING_IMAGE_SIDE, SEATING_IMAGE_SIDE, {
            fit: "contain",
            background: "#ffffff",
          });
    return await fitted
      .flatten({ background: "#ffffff" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    return null;
  }
}

// Files ----------------------------------------------------------------------

/** Writes a cached image whole: a reader never sees half of it. */
async function writeImageFile(
  planId: string,
  name: string,
  data: Buffer,
): Promise<void> {
  const dir = seatingImageDir(planId);
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, `.${name}.${randomBytes(6).toString("hex")}`);
  await writeFile(temporary, data);
  try {
    await rename(temporary, join(dir, name));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Removes cached images of a plan; names that are not one are skipped. */
export async function removeSeatingImageFiles(
  planId: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    if (!parseSeatingImageFileName(name)) continue;
    try {
      await unlink(join(seatingImageDir(planId), name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logError("seating.images", error, { action: "remove" });
      }
    }
  }
}

/** Removes every cached image of a plan (its assembly was deleted). */
export async function removeSeatingPlanImages(planId: string): Promise<void> {
  try {
    await rm(seatingImageDir(planId), { recursive: true, force: true });
  } catch (error) {
    logError("seating.images", error, { action: "remove_plan" });
  }
}

// Queue ----------------------------------------------------------------------

/**
 * Queues image fetches once a sync has committed. One job per image and
 * version (singletonKey): the same version queued twice runs once. Never
 * throws: a missing queue only means the images come with a later sync.
 */
export async function enqueueSeatingImages(
  images: readonly SeatingImageJob[],
): Promise<void> {
  // An image that failed for good at this version is not fetched again.
  const jobs = withoutFailedSeatingImages(images);
  if (jobs.length === 0) return;
  try {
    const boss = await getExportQueue();
    await boss.insert(
      SEATING_IMAGES_QUEUE,
      jobs.map((data) => ({
        data,
        singletonKey: seatingImageKey(data),
      })),
    );
  } catch (error) {
    logError("seating.images", error, { action: "enqueue", jobs: jobs.length });
  }
}

/** Live notices of new images, at most one per assembly every few seconds. */
const NOTIFY_DELAY_MS = 3_000;
const pendingNotices = new Map<string, ReturnType<typeof setTimeout>>();

function noticeImages(assemblyId: string, planId: string): void {
  if (pendingNotices.has(assemblyId)) return;
  pendingNotices.set(
    assemblyId,
    setTimeout(() => {
      pendingNotices.delete(assemblyId);
      notifyLive(db, {
        assemblyId,
        entityType: "seating",
        entityId: planId,
        type: "seating_images_ready",
      }).catch((error) =>
        logError("seating.images", error, { action: "notify" }),
      );
    }, NOTIFY_DELAY_MS),
  );
}

/** The row an image belongs to, with its version, file and whether it is gone. */
async function loadImageRow(job: SeatingImageJob) {
  if (job.kind === "logo") {
    const [row] = await db
      .select({
        version: seatingGroups.logoVersion,
        file: seatingGroups.logoFile,
        goneAt: seatingGroups.goneAt,
      })
      .from(seatingGroups)
      .where(
        and(eq(seatingGroups.id, job.id), eq(seatingGroups.planId, job.planId)),
      );
    return row ?? null;
  }
  const [row] = await db
    .select({
      version: seatingPeople.photoVersion,
      file: seatingPeople.photoFile,
      goneAt: seatingPeople.goneAt,
    })
    .from(seatingPeople)
    .where(
      and(eq(seatingPeople.id, job.id), eq(seatingPeople.planId, job.planId)),
    );
  return row ?? null;
}

/**
 * Names the file on its row if the row still has that version and is not
 * gone (compare-and-set), keeping the row's lock token: a photo arriving is
 * no edit anyone made. Whether it did.
 *
 * Under the plan's row FOR SHARE, as every writer of these rows takes the
 * plan first: a sync holds it FOR UPDATE while it reads the rows and writes
 * them, so a claim lands either before (the sync reads the file and removes
 * it with its version) or after (and finds the version changed). Unlocked,
 * a claim between the sync's read and its write would leave a file named on
 * a row whose image the Intranet no longer gives.
 */
async function claimImageFile(
  job: SeatingImageJob,
  name: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .select({ id: seatingPlans.id })
      .from(seatingPlans)
      .where(eq(seatingPlans.id, job.planId))
      .for("share");
    if (!plan) return false;
    return claimImageRow(tx, job, name);
  });
}

async function claimImageRow(
  tx: Executor,
  job: SeatingImageJob,
  name: string,
): Promise<boolean> {
  if (job.kind === "logo") {
    const rows = await tx
      .update(seatingGroups)
      .set({
        logoFile: name,
        updatedAt: keepUpdatedAt(seatingGroups.updatedAt),
      })
      .where(
        and(
          eq(seatingGroups.id, job.id),
          eq(seatingGroups.planId, job.planId),
          eq(seatingGroups.logoVersion, job.version),
          isNull(seatingGroups.goneAt),
        ),
      )
      .returning({ id: seatingGroups.id });
    return rows.length > 0;
  }
  const rows = await tx
    .update(seatingPeople)
    .set({
      photoFile: name,
      updatedAt: keepUpdatedAt(seatingPeople.updatedAt),
    })
    .where(
      and(
        eq(seatingPeople.id, job.id),
        eq(seatingPeople.planId, job.planId),
        eq(seatingPeople.photoVersion, job.version),
        isNull(seatingPeople.goneAt),
      ),
    )
    .returning({ id: seatingPeople.id });
  return rows.length > 0;
}

export type SeatingImageOutcome =
  "cached" | "skipped" | "missing" | "unreadable" | "stale";

/**
 * One job: skips a row that moved on, fetches, draws, writes and names the
 * file. Throws only what a retry may mend (the Intranet unreachable).
 */
export async function processSeatingImageJob(
  data: unknown,
): Promise<SeatingImageOutcome> {
  const parsed = seatingImageJobSchema.safeParse(data);
  if (!parsed.success) {
    logWarn("seating.images", { outcome: "invalid_job" });
    return "skipped";
  }
  const job = parsed.data;
  const name = seatingImageFileName(job);
  const row = await loadImageRow(job);
  if (!row || row.goneAt || row.version !== job.version || row.file === name) {
    return "skipped";
  }

  const fetched = await fetchSeatingImage(job.kind, job.intranetId);
  if (fetched.outcome === "missing") {
    logWarn("seating.images", {
      outcome: "missing",
      kind: job.kind,
      reason: fetched.reason,
    });
    rememberFailedSeatingImage(job);
    return "missing";
  }
  const picture = await renderSeatingImage(fetched.data, job.kind);
  if (!picture) {
    logWarn("seating.images", { outcome: "unreadable", kind: job.kind });
    rememberFailedSeatingImage(job);
    return "unreadable";
  }

  await writeImageFile(job.planId, name, picture);
  if (!(await claimImageFile(job, name))) {
    // A sync changed the version (or the person left) meanwhile.
    await removeSeatingImageFiles(job.planId, [name]);
    return "stale";
  }
  noticeImages(job.assemblyId, job.planId);
  return "cached";
}

/**
 * Creates the queue (idempotent) and starts its worker on the export
 * queue's pg-boss instance. Started by server/plugins/seating-images.ts.
 */
export async function startSeatingImages(boss: PgBoss): Promise<void> {
  await boss.createQueue(SEATING_IMAGES_QUEUE, {
    // One queued job per image and version (singletonKey).
    policy: "short",
    retryLimit: SEATING_IMAGE_RETRY_LIMIT,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 300,
    deleteAfterSeconds: 24 * 3600,
  });
  await boss.work<unknown>(
    SEATING_IMAGES_QUEUE,
    { batchSize: 1, localConcurrency: SEATING_IMAGE_CONCURRENCY },
    async (jobs: Job<unknown>[]) => {
      for (const job of jobs) {
        try {
          await processSeatingImageJob(job.data);
        } catch (error) {
          if (error instanceof IntranetUnavailableError) {
            logWarn("seating.images", {
              outcome: "retry",
              reason: error.message,
            });
          } else {
            logError("seating.images", error, { jobId: job.id });
          }
          throw error;
        }
      }
    },
  );
  logInfo("seating.images", { message: "worker started" });
}

/** Drops the pending live notices (the process is stopping). */
export function stopSeatingImages(): void {
  for (const timer of pendingNotices.values()) clearTimeout(timer);
  pendingNotices.clear();
}
