import { createError } from "h3";
import JSZip from "jszip";
import mammoth from "mammoth";
import { parseHTML } from "linkedom";
import { createId } from "@paralleldrive/cuid2";
import type { DocxImportDto } from "~~/shared/types/api";
import { htmlElementToBlocks } from "~~/shared/utils/content/editor";
import { blocksSchema } from "~~/shared/utils/schemas/content";

/**
 * DOCX import: Word file -> sanitized blocks. The file is never stored. Only
 * text, headings, lists, quotes and inline emphasis survive the conversion;
 * htmlElementToBlocks drops everything else and blocksSchema removes unsafe
 * links.
 */

export const DOCX_MAX_BYTES = 15 * 1024 * 1024;

/** Ceiling for the declared uncompressed size of the archive (zip bombs). */
const DOCX_MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

type DocxWarning = DocxImportDto["warnings"][number];

/** Headings beyond mammoth's defaults (which already map Heading 1-6). */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  // Spanish Word stores built-in heading ids without the accent.
  "p.Ttulo => h1:fresh",
  "p.Ttulo1 => h1:fresh",
  "p.Ttulo2 => h2:fresh",
  "p.Ttulo3 => h3:fresh",
  "p.Ttulo4 => h4:fresh",
  "p.Subttulo => h2:fresh",
];

// <w:ins>, <w:del>, <w:moveFrom>, <w:moveTo>, but not <w:instrText> or <w:delText>.
const TRACKED_CHANGE_PATTERN = /<w:(ins|del|moveFrom|moveTo)[\s>/]/;
const COMMENT_PATTERN = /<w:comment[\s>]/;

export function hasZipSignature(data: Uint8Array): boolean {
  return ZIP_SIGNATURE.every((byte, index) => data[index] === byte);
}

function invalidFile(): never {
  throw createError({
    statusCode: 415,
    message: "El archivo no parece ser un documento de Word (.docx) válido",
  });
}

function declaredUncompressedSize(zip: JSZip): number {
  let total = 0;
  for (const file of Object.values(zip.files)) {
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof size === "number" && size > 0) total += size;
  }
  return total;
}

async function inspectArchive(data: Buffer): Promise<{ warnings: Set<DocxWarning> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    invalidFile();
  }
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) invalidFile();
  if (declaredUncompressedSize(zip) > DOCX_MAX_UNCOMPRESSED_BYTES) {
    throw createError({
      statusCode: 413,
      message: "El documento es demasiado grande para importarlo",
    });
  }

  const warnings = new Set<DocxWarning>();
  const body = await documentXml.async("string");
  if (TRACKED_CHANGE_PATTERN.test(body)) warnings.add("tracked_changes");
  const comments = zip.file("word/comments.xml");
  if (comments && COMMENT_PATTERN.test(await comments.async("string"))) {
    warnings.add("comments");
  }
  return { warnings };
}

/**
 * Converts a DOCX file to blocks with fresh ids. Throws 415 when the file is
 * not a DOCX, 413 when it is too large and 422 when it holds no usable text
 * or exceeds the content limits.
 */
export async function convertDocx(data: Buffer): Promise<DocxImportDto> {
  if (!hasZipSignature(data)) invalidFile();
  const { warnings } = await inspectArchive(data);

  let imagesDropped = false;
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: data },
      {
        styleMap: STYLE_MAP,
        externalFileAccess: false,
        // Images are dropped, so never inline them as base64.
        convertImage: mammoth.images.imgElement(async () => {
          imagesDropped = true;
          return { src: "" };
        }),
      },
    );
    html = result.value;
  } catch {
    invalidFile();
  }
  if (imagesDropped) warnings.add("images_dropped");

  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const blocks = htmlElementToBlocks(document.body as unknown as Element, () => createId());

  if (blocks.length === 0) {
    throw createError({
      statusCode: 422,
      message: "El documento no contiene texto que se pueda importar",
    });
  }
  const parsed = blocksSchema.safeParse(blocks);
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      message: "El documento es demasiado extenso o tiene párrafos demasiado largos",
    });
  }

  const order: DocxWarning[] = ["tracked_changes", "comments", "images_dropped"];
  return {
    blocks: parsed.data,
    warnings: order.filter((warning) => warnings.has(warning)),
  };
}
