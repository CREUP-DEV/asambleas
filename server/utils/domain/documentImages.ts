import { createError } from "h3";
import { and, count, eq, inArray } from "drizzle-orm";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { db } from "../../db";
import { cuid, documentImages } from "../../db/schema";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { IMAGE_ASSET_PATTERN } from "../../../shared/types/content";
import { getUploadDir } from "../core/uploadPaths";
import { logError } from "../core/logger";
import type { DocumentRouteContext, UploadedFile } from "./documents";
import { isTextFrozen, requireDocumentEditor } from "./documents";
import { recordEvent } from "./events";

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
 * Checks an uploaded picture and writes it again (see the module comment).
 * Anything that is not a PNG or a JPEG sharp can read is refused.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const png = input.subarray(0, 8).equals(PNG_SIGNATURE);
  const jpeg = input.subarray(0, 3).equals(JPEG_SIGNATURE);
  if (!png && !jpeg) fail(415, "Solo se admiten imágenes PNG o JPEG");
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
    const { data, info } = png
      ? await pipeline
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true })
      : await pipeline
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
    return {
      data,
      mimeType: png ? "image/png" : "image/jpeg",
      width: info.width,
      height: info.height,
    };
  } catch {
    fail(415, "No se ha podido leer la imagen");
  }
}

export interface StoredImageDto {
  asset: string;
  width: number;
  height: number;
}

/**
 * Stores an image for the text of a document its actor can edit: a
 * structured draft, before the text is frozen. Records
 * `document_image_uploaded`; the image shows in the text once a saved
 * version points to it.
 */
export async function storeDocumentImage(
  ctx: DocumentRouteContext,
  file: UploadedFile,
): Promise<StoredImageDto> {
  const { actor, assembly, document } = ctx;
  requireDocumentEditor(actor, document);
  if (document.format !== "structured" || isTextFrozen(document)) {
    fail(409, "El texto de este documento ya no se puede cambiar");
  }
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(documentImages)
    .where(eq(documentImages.documentId, document.id));
  if (total >= DOCUMENT_MAX_IMAGES) {
    fail(409, `El documento ya tiene ${DOCUMENT_MAX_IMAGES} imágenes`);
  }

  const image = await processImage(file.data);
  const id = cuid();
  const name = imageFileName(id, image.mimeType)!;
  const directory = getImageDir();
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, image.data);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(documentImages).values({
        id,
        documentId: document.id,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        bytes: image.data.length,
        uploadedByUserId: actor.user.id,
      });
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "document",
        entityId: document.id,
        documentId: document.id,
        type: "document_image_uploaded",
        payload: { width: image.width, height: image.height },
        actor,
      });
    });
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
  return { asset: id, width: image.width, height: image.height };
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
  if (rows.length !== assets.length) {
    fail(400, "El texto incluye una imagen que no es de este documento");
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
