import { createError } from "h3";
import { and, count, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { db } from "../../db";
import { documentImages } from "../../db/schema";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { IMAGE_ASSET_PATTERN } from "../../../shared/types/content";
import { getUploadDir } from "../core/uploadPaths";
import { logError } from "../core/logger";
import type { DocumentRouteContext, UploadedFile } from "./documents";
import { isTextFrozen, requireDocumentEditor } from "./documents";
import { recordEvent, type Executor } from "./events";

/**
 * Images of a document's text. An upload is checked by its signature, then
 * decoded and written again by sharp: what is stored is a picture sharp
 * produced (no file passing for an image), turned upright as the camera
 * said, without its metadata (no location or camera details) and at most
 * IMAGE_MAX_SIDE pixels a side. PNGs stay PNG (they may be transparent),
 * the rest becomes JPEG.
 */

/** The largest upload accepted, before it is made smaller. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Pixels sharp agrees to decode: a 64-megapixel photo, not a bomb. */
const IMAGE_MAX_INPUT_PIXELS = 64_000_000;
/** The longest side kept: enough for print, light enough for the web. */
const IMAGE_MAX_SIDE = 2400;
/** Images one document may hold, drafts and published versions together. */
export const DOCUMENT_MAX_IMAGES = 200;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg" } as const;
type ImageMime = keyof typeof EXTENSIONS;

function fail(statusCode: number, message: string): never {
  throw createError({ statusCode, message });
}

/** Where image files are stored: images/ inside the upload directory. */
export function getImageDir(): string {
  return join(getUploadDir(), "images");
}

/** The file of a stored image: its id and the extension of its type. */
export function imageFileName(id: string, mimeType: string): string | null {
  const extension = EXTENSIONS[mimeType as ImageMime];
  return extension && IMAGE_ASSET_PATTERN.test(id)
    ? `${id}.${extension}`
    : null;
}

export interface ProcessedImage {
  data: Buffer;
  mimeType: ImageMime;
  width: number;
  height: number;
}

/**
 * Where a picture comes from: an upload takes PNG and JPEG only; a Word
 * file's pictures may also be GIF, WebP or TIFF, which become PNG. Never
 * SVG, nor Office's EMF and WMF, which sharp cannot read.
 */
export type ImageSource = "upload" | "import";

type ImageKind = "png" | "jpeg" | "gif" | "webp" | "tiff";

/** The picture's format, by its first bytes (its signature). */
function kindOf(input: Buffer): ImageKind | null {
  if (input.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (input.subarray(0, 3).equals(JPEG_SIGNATURE)) return "jpeg";
  const head = input.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  if (head.startsWith("II*\u0000") || head.startsWith("MM\u0000*")) {
    return "tiff";
  }
  return null;
}

/**
 * Checks a picture and writes it again (see the module comment). Anything
 * sharp cannot read, or not of a format `source` takes, is refused.
 */
export async function processImage(
  input: Buffer,
  source: ImageSource = "upload",
): Promise<ProcessedImage> {
  const kind = kindOf(input);
  const accepted =
    kind === "png" || kind === "jpeg" || (source === "import" && kind !== null);
  if (!accepted) fail(415, "Solo se admiten imágenes PNG o JPEG");
  // A JPEG stays JPEG; the rest, which may be transparent, becomes PNG.
  const jpeg = kind === "jpeg";
  try {
    const pipeline = sharp(input, {
      limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
      failOn: "error",
    })
      .rotate()
      .resize({
        width: IMAGE_MAX_SIDE,
        height: IMAGE_MAX_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      });
    const { data, info } = jpeg
      ? await pipeline
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer({ resolveWithObject: true })
      : await pipeline
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true });
    return {
      data,
      mimeType: jpeg ? "image/jpeg" : "image/png",
      width: info.width,
      height: info.height,
    };
  } catch {
    fail(415, "No se ha podido leer la imagen");
  }
}

/**
 * An image's id, from its document and the bytes received: the same
 * picture given twice to one document (a Word file imported again) is the
 * same stored image, never a copy. 24 hex characters (IMAGE_ASSET_PATTERN).
 */
export function imageAssetId(documentId: string, input: Buffer): string {
  return createHash("sha256")
    .update(documentId)
    .update("\u0000")
    .update(input)
    .digest("hex")
    .slice(0, 24);
}

export interface StoredImageDto {
  asset: string;
  width: number;
  height: number;
}

/** Images go only into the text of a structured draft not yet frozen. */
function assertTextEditable(ctx: DocumentRouteContext): void {
  requireDocumentEditor(ctx.actor, ctx.document);
  if (ctx.document.format !== "structured" || isTextFrozen(ctx.document)) {
    fail(409, "El texto de este documento ya no se puede cambiar");
  }
}

interface ImageSize {
  width: number;
  height: number;
}

/**
 * Stores a picture for a document, or finds it already stored (same id,
 * imageAssetId). A new one counts against DOCUMENT_MAX_IMAGES, and
 * `onCreated` runs with its size in the transaction that adds its row (to
 * record it).
 */
async function saveImage(
  ctx: DocumentRouteContext,
  input: Buffer,
  source: ImageSource,
  onCreated?: (tx: Executor, size: ImageSize) => Promise<void>,
): Promise<StoredImageDto & { created: boolean }> {
  const { actor, document } = ctx;
  const id = imageAssetId(document.id, input);
  const [existing] = await db
    .select({ width: documentImages.width, height: documentImages.height })
    .from(documentImages)
    .where(eq(documentImages.id, id))
    .limit(1);
  if (existing) return { asset: id, ...existing, created: false };

  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(documentImages)
    .where(eq(documentImages.documentId, document.id));
  if (total >= DOCUMENT_MAX_IMAGES) {
    fail(409, `El documento ya tiene ${DOCUMENT_MAX_IMAGES} imágenes`);
  }

  const image = await processImage(input, source);
  const name = imageFileName(id, image.mimeType)!;
  const directory = getImageDir();
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, image.data);
  let created = false;
  try {
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(documentImages)
        .values({
          id,
          documentId: document.id,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          bytes: image.data.length,
          uploadedByUserId: actor.user.id,
        })
        .onConflictDoNothing()
        .returning({ id: documentImages.id });
      // Stored at the same moment by another request: the same picture.
      created = rows.length > 0;
      if (created && onCreated) {
        await onCreated(tx, { width: image.width, height: image.height });
      }
    });
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
  return {
    asset: id,
    width: image.width,
    height: image.height,
    created,
  };
}

/**
 * Stores an image for the text of a document its actor can edit: a
 * structured draft, before the text is frozen. Records
 * `document_image_uploaded` when it is new; the image shows in the text
 * once a saved version points to it.
 */
export async function storeDocumentImage(
  ctx: DocumentRouteContext,
  file: UploadedFile,
): Promise<StoredImageDto> {
  assertTextEditable(ctx);
  const { asset, width, height } = await saveImage(
    ctx,
    file.data,
    "upload",
    (tx, size) =>
      recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        entityType: "document",
        entityId: ctx.document.id,
        documentId: ctx.document.id,
        type: "document_image_uploaded",
        payload: { ...size },
        actor: ctx.actor,
      }),
  );
  return { asset, width, height };
}

/**
 * Stores a Word file's pictures for a document while it is imported: each
 * one it can (`store` gives null for one it cannot: a format sharp cannot
 * read, or past the document's limit), and `finish` records one
 * `document_images_imported` for those new to the document.
 */
export function documentImageImporter(ctx: DocumentRouteContext): {
  store: (data: Buffer) => Promise<StoredImageDto | null>;
  finish: () => Promise<void>;
} {
  assertTextEditable(ctx);
  let created = 0;
  return {
    async store(data) {
      try {
        const stored = await saveImage(ctx, data, "import");
        if (stored.created) created += 1;
        return {
          asset: stored.asset,
          width: stored.width,
          height: stored.height,
        };
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === undefined) {
          logError("documentImages.import", error);
        }
        return null;
      }
    },
    async finish() {
      if (created === 0) return;
      await recordEvent(db, {
        assemblyId: ctx.assembly.id,
        entityType: "document",
        entityId: ctx.document.id,
        documentId: ctx.document.id,
        type: "document_images_imported",
        payload: { count: created },
        actor: ctx.actor,
      });
    },
  };
}

/**
 * Every image in `blocks` must be one stored for this document: content
 * never points to another document's pictures, nor to ones never stored.
 */
export async function assertImagesBelong(
  documentId: string,
  blocks: Block[],
): Promise<void> {
  const assets = [
    ...new Set(
      blocks
        .filter((block) => block.type === "image" && block.image)
        .map((block) => block.image!.asset),
    ),
  ];
  if (assets.length === 0) return;
  const rows = await db
    .select({ id: documentImages.id })
    .from(documentImages)
    .where(
      and(
        eq(documentImages.documentId, documentId),
        inArray(documentImages.id, assets),
      ),
    );
  // Pasted from another document's editor, most likely.
  if (rows.length !== assets.length) {
    throw createError({
      statusCode: 400,
      message: "El texto incluye una imagen que no es de este documento",
      data: { messageKey: "common.editor.image.notThisDocument" },
    });
  }
}

/** The same, for the blocks amendment operations insert. */
export async function assertOpImagesBelong(
  documentId: string,
  ops: AmendmentOp[],
): Promise<void> {
  await assertImagesBelong(
    documentId,
    ops.flatMap((op) => (op.op === "insert" ? op.blocks : [])),
  );
}

/** Best-effort removal of a document's image files (after it is deleted). */
export async function removeImageFiles(
  images: { id: string; mimeType: string }[],
): Promise<void> {
  for (const image of images) {
    const name = imageFileName(image.id, image.mimeType);
    if (!name) continue;
    try {
      await unlink(join(getImageDir(), name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logError("documentImages.removeImageFiles", error);
      }
    }
  }
}
