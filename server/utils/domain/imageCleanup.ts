import { inArray, sql } from "drizzle-orm";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { db } from "../../db";
import { documentImages, documents } from "../../db/schema";
import { AUDIT_ACTIONS } from "../../../shared/constants/activity";
import { IMAGE_ASSET_PATTERN } from "../../../shared/types/content";
import { logError, logInfo } from "../core/logger";
import { recordAudit } from "./audit";
import { getImageDir, imageFileName } from "./documentImages";

/**
 * The daily clean-up of document images nothing uses: uploaded or imported
 * for a text never saved with them. An image stays while any version of its
 * document (the working draft, the base, the consolidated text) or any of
 * its amendments shows it, and for IMAGE_GRACE_DAYS after it was stored,
 * however unused (an editor may still hold unsaved text with it). Files
 * with no row (left when a whole assembly was deleted) go too, once as old.
 */

export const IMAGE_CLEANUP_QUEUE = "document-images-cleanup";
/** 04:45 Madrid time, before the intranet jobs. */
const IMAGE_CLEANUP_CRON = "45 4 * * *";
const IMAGE_CLEANUP_TIMEZONE = "Europe/Madrid";
export const IMAGE_GRACE_DAYS = 14;

/** Whether any version or amendment of the image's document shows it. */
const IN_USE = sql`(
  exists (
    select 1 from document_versions v
    where v.document_id = document_images.document_id
      and v.blocks @> jsonb_build_array(
        jsonb_build_object('image', jsonb_build_object('asset', document_images.id))
      )
  )
  or exists (
    select 1 from amendments a
    where a.document_id = document_images.document_id
      and a.ops @> jsonb_build_array(
        jsonb_build_object('blocks', jsonb_build_array(
          jsonb_build_object('image', jsonb_build_object('asset', document_images.id))
        ))
      )
  )
)`;

export interface ImageCleanupResult {
  rows: number;
  files: number;
}

export async function cleanupUnusedImages(
  now = new Date(),
): Promise<ImageCleanupResult> {
  const cutoff = new Date(now.getTime() - IMAGE_GRACE_DAYS * 86_400_000);

  // One statement: an image a save points to meanwhile is no longer unused.
  const removed = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(documentImages)
      .where(sql`${documentImages.createdAt} < ${cutoff} and not ${IN_USE}`)
      .returning({
        id: documentImages.id,
        mimeType: documentImages.mimeType,
        documentId: documentImages.documentId,
      });
    if (rows.length === 0) return rows;
    const owners = await tx
      .select({ id: documents.id, assemblyId: documents.assemblyId })
      .from(documents)
      .where(
        inArray(documents.id, [...new Set(rows.map((row) => row.documentId))]),
      );
    const assemblyOf = new Map(owners.map((row) => [row.id, row.assemblyId]));
    const byDocument = new Map<string, number>();
    for (const row of rows) {
      byDocument.set(row.documentId, (byDocument.get(row.documentId) ?? 0) + 1);
    }
    for (const [documentId, count] of byDocument) {
      await recordAudit(tx, {
        actor: null,
        source: "system",
        action: AUDIT_ACTIONS.DOCUMENT_IMAGES_CLEANUP,
        targetType: "document",
        targetId: documentId,
        assemblyId: assemblyOf.get(documentId) ?? null,
        after: { count },
      });
    }
    return rows;
  });

  let files = 0;
  // Once committed; an id stored again since (the same picture given back
  // to the same document) keeps its file.
  const stored = new Set(
    removed.length === 0
      ? []
      : (
          await db
            .select({ id: documentImages.id })
            .from(documentImages)
            .where(
              inArray(
                documentImages.id,
                removed.map((row) => row.id),
              ),
            )
        ).map((row) => row.id),
  );
  for (const row of removed) {
    if (stored.has(row.id)) continue;
    const name = imageFileName(row.id, row.mimeType);
    if (name && (await removeFile(join(getImageDir(), name)))) files += 1;
  }

  files += await sweepLooseFiles(cutoff);
  return { rows: removed.length, files };
}

/** Files of images with no row, as old as the grace period. */
async function sweepLooseFiles(cutoff: Date): Promise<number> {
  let names: string[];
  try {
    names = await readdir(getImageDir());
  } catch {
    return 0;
  }
  const candidates = names
    .map((name) => ({ name, id: name.split(".")[0] ?? "" }))
    .filter(({ id }) => IMAGE_ASSET_PATTERN.test(id));
  if (candidates.length === 0) return 0;
  const known = new Set(
    (
      await db
        .select({ id: documentImages.id })
        .from(documentImages)
        .where(
          inArray(
            documentImages.id,
            candidates.map(({ id }) => id),
          ),
        )
    ).map((row) => row.id),
  );
  let removed = 0;
  for (const { name, id } of candidates) {
    if (known.has(id)) continue;
    const path = join(getImageDir(), name);
    try {
      if ((await stat(path)).mtime >= cutoff) continue;
    } catch {
      continue;
    }
    if (await removeFile(path)) removed += 1;
  }
  return removed;
}

async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logError("imageCleanup.removeFile", error);
    }
    return false;
  }
}

/**
 * Creates the queue (idempotent, on every boot), schedules the clean-up
 * daily and starts its worker.
 */
export async function setupImageCleanupSchedule(
  boss: Pick<PgBoss, "createQueue" | "schedule" | "work">,
): Promise<void> {
  await boss.createQueue(IMAGE_CLEANUP_QUEUE, {
    retryLimit: 2,
    retryDelay: 600,
    expireInSeconds: 30 * 60,
    deleteAfterSeconds: 30 * 24 * 3600,
  });
  await boss.schedule(IMAGE_CLEANUP_QUEUE, IMAGE_CLEANUP_CRON, null, {
    tz: IMAGE_CLEANUP_TIMEZONE,
    // A server that was down at 04:45 runs it once when it comes back.
    missed: "once",
  });
  await boss.work<unknown>(
    IMAGE_CLEANUP_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 60 },
    async () => {
      const result = await cleanupUnusedImages();
      logInfo("imageCleanup.done", { ...result });
    },
  );
}
