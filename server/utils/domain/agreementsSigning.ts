import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../core/http";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import type {
  AgreementsRecordDto,
  AgreementsRecordSigningDto,
} from "~~/shared/types/api";
import { db } from "../../db";
import { agreementRecordSignings } from "../../db/schema";
import { logError, logWarn } from "../core/logger";
import { getUploadDir } from "../core/uploadPaths";
import { loadBrand, loadPdfFonts } from "../export/assets";
import { buildDocumentExportData } from "../export/buildData";
import type { ExportImage } from "../export/content";
import { buildDocumentPdf } from "../export/pdfBuilder";
import { renderPdf } from "../export/pdfRender";
import {
  INTRANET_TIMEOUT_MS,
  getIntranetApiBaseUrl,
  intranetAuthHeaders,
  intranetUrl,
} from "../members/intranet";
import { isTooLarge, readCapped } from "../seating/intranet";
import { sniffImageFormat } from "../seating/images";
import { assertOptimisticLock } from "../optimisticLock";
import type { Actor } from "./actor";
import {
  findAgreementsRecord,
  isApproved,
  isFrozen,
  loadAgreementsRecordDto,
  requireRecordManager,
} from "./agreementsRecord";
import {
  AGREEMENTS_URL_PREFIX,
  signedRecordStoredName,
} from "./agreementsSignedFile";
import type { AssemblyRow } from "./assemblies";
import {
  lockDocument,
  STORED_PDF_NAME,
  storePdf,
  type DocumentRow,
  type UploadedFile,
} from "./documents";
import { recordEvent, type Executor } from "./events";

/**
 * Signing the acta de acuerdos (user's decisions of 2026-11-23), as the
 * Intranet signs its attendance certificates:
 *
 * 1. Once its own final vote approved it (and froze it), the Secretaría
 *    prepares it: the platform renders the clean consolidated text, Spanish
 *    and justified, with the visible signature of whoever certifies above
 *    their name. The image is read from the Intranet then
 *    (`GET {base}/firma-secretaria`, the account its administration marks as
 *    the Secretaría Ejecutiva's) and kept nowhere but in that PDF: it is
 *    that person's data, and it goes in the Intranet with the rest of it.
 *    Without it (none uploaded, no Intranet), the space stays blank.
 * 2. The Secretaría signs that PDF with AutoFirma from the page (PAdES, an
 *    incremental revision) or outside the platform, and uploads it. It must
 *    be a PDF carrying a digital signature; nothing else is checked of it,
 *    as in the Intranet.
 * 3. The signed PDF is published: it leads the document's page and stands
 *    for the generated PDF in the documentation package.
 *
 * A record regenerated with a correction (regenerateApprovedRecord) loses
 * both PDFs: it is prepared and signed again. Files live in the upload
 * directory under random names; the prepared one is served only to the
 * Secretaría, the signed one by /api/uploads/agreements/[filename].
 */

const SIGNATURE_PATH = "firma-secretaria";
/** The largest image read from the Intranet. */
const SIGNATURE_MAX_BYTES = 3_000_000;
const SIGNATURE_MAX_INPUT_PIXELS = 25_000_000;
/** The signature is drawn at most 200 × 72 pt: twice that is plenty. */
const SIGNATURE_BOX = { width: 800, height: 320 };
/** What a PDF needs to carry a digital signature. */
const SIGNATURE_DICTIONARY = /\/ByteRange\s*\[/;
const STALE_MESSAGE =
  "El acta ha cambiado mientras tanto. Recarga e inténtalo de nuevo";

type SigningRow = typeof agreementRecordSignings.$inferSelect;

/**
 * The visible signature of the Secretaría Ejecutiva, from the Intranet, as
 * a PNG for the PDF (pdfmake draws PNG and JPEG only), or null when there
 * is none or it cannot be read: the PDF then keeps the space blank. Never
 * follows a redirect, never logs the image.
 */
export async function fetchSecretarySignature(): Promise<ExportImage | null> {
  const base = getIntranetApiBaseUrl();
  if (!base) return null;
  let response: Response;
  try {
    response = await fetch(intranetUrl(base, SIGNATURE_PATH), {
      headers: { Accept: "image/*", ...intranetAuthHeaders() },
      redirect: "manual",
      signal: AbortSignal.timeout(INTRANET_TIMEOUT_MS),
    });
  } catch (error) {
    logWarn("agreementsSigning.signature", {
      reason: error instanceof Error ? error.name : "network",
    });
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    // 404: no account marked or no signature uploaded; anything else, an
    // Intranet without the route (deployed before it) or failing.
    if (response.status !== 404) {
      logWarn("agreementsSigning.signature", {
        reason: `status ${response.status}`,
      });
    }
    return null;
  }
  let data: Awaited<ReturnType<typeof readCapped>>;
  try {
    data = await readCapped(response, SIGNATURE_MAX_BYTES);
  } catch (error) {
    logWarn("agreementsSigning.signature", {
      reason: error instanceof Error ? error.name : "network",
    });
    return null;
  }
  if (isTooLarge(data)) {
    logWarn("agreementsSigning.signature", { reason: "too large" });
    return null;
  }
  const format = sniffImageFormat(data);
  if (format !== "png" && format !== "jpeg" && format !== "webp") {
    logWarn("agreementsSigning.signature", { reason: "not an image" });
    return null;
  }
  try {
    const { data: png, info } = await sharp(data, {
      limitInputPixels: SIGNATURE_MAX_INPUT_PIXELS,
      failOn: "error",
      animated: false,
    })
      .rotate()
      .resize(SIGNATURE_BOX.width, SIGNATURE_BOX.height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    logWarn("agreementsSigning.signature", {
      reason: error instanceof Error ? error.name : "decode",
    });
    return null;
  }
}

async function loadSigningRow(
  documentId: string,
  executor: Executor = db,
): Promise<SigningRow | null> {
  const [row] = await executor
    .select()
    .from(agreementRecordSignings)
    .where(eq(agreementRecordSignings.documentId, documentId));
  return row ?? null;
}

/** The signing as the Secretaría's panel reads it. */
export async function loadSigningDto(
  document: DocumentRow,
): Promise<AgreementsRecordSigningDto | null> {
  const row = await loadSigningRow(document.id);
  if (!row) return null;
  const inForce = document.consolidatedVersionId;
  return {
    prepared:
      row.preparedFile && row.preparedAt
        ? {
            at: row.preparedAt.toISOString(),
            withImage: row.preparedWithImage,
            current: inForce !== null && row.versionId === inForce,
          }
        : null,
    signed:
      row.signedFileUrl && row.signedAt
        ? {
            url: row.signedFileUrl,
            name: row.signedFileName ?? "acta-de-acuerdos.pdf",
            signedAt: row.signedAt.toISOString(),
            current: inForce !== null && row.signedVersionId === inForce,
          }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Files a cleared signing leaves behind, removed once that commits. */
export interface SigningFiles {
  prepared: string | null;
  signed: string | null;
}

/**
 * Takes both PDFs away from the record's signing (a new version of the
 * record), inside the caller's transaction. Answers the files to remove.
 */
export async function clearSigning(
  tx: Executor,
  documentId: string,
): Promise<SigningFiles> {
  const row = await loadSigningRow(documentId, tx);
  if (!row) return { prepared: null, signed: null };
  await tx
    .update(agreementRecordSignings)
    .set({
      versionId: null,
      preparedFile: null,
      preparedAt: null,
      preparedByUserId: null,
      preparedWithImage: false,
      signedFileUrl: null,
      signedFileName: null,
      signedVersionId: null,
      signedAt: null,
      signedByUserId: null,
      updatedAt: sql`now()`,
    })
    .where(eq(agreementRecordSignings.documentId, documentId));
  return {
    prepared: row.preparedFile,
    signed: signedRecordStoredName(row.signedFileUrl),
  };
}

async function removeStored(name: string | null): Promise<void> {
  if (!name || !STORED_PDF_NAME.test(name)) return;
  try {
    await unlink(join(getUploadDir(), name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logError("agreementsSigning.remove", error);
    }
  }
}

/** Best-effort removal of the files a cleared signing left. */
export async function removeSigningFiles(files: SigningFiles): Promise<void> {
  await removeStored(files.prepared);
  await removeStored(files.signed);
}

/** The approved, frozen record of the assembly, or a refusal. */
async function signableRecord(assembly: AssemblyRow): Promise<DocumentRow> {
  const document = await findAgreementsRecord(assembly.id);
  if (!document) fail(404, "La asamblea no tiene acta de acuerdos");
  if (
    !(await isApproved(db, document)) ||
    !(await isFrozen(db, document)) ||
    !document.consolidatedVersionId
  ) {
    fail(409, "El acta se firma una vez aprobada en su votación final");
  }
  return document;
}

/**
 * Makes the PDF to sign from the text in force, with the visible signature
 * when the Intranet has one, and keeps it for the Secretaría to download.
 * The one prepared before goes.
 */
export async function prepareRecordForSigning(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  const document = await signableRecord(assembly);
  const versionId = document.consolidatedVersionId!;
  const [data, signature, brand, fonts] = await Promise.all([
    buildDocumentExportData({
      assemblyId: assembly.id,
      documentId: document.id,
      requestedBy: actor.user.id,
      impersonationId: actor.impersonation?.id ?? null,
      locale: "es",
      justified: true,
      variant: "clean",
    }),
    fetchSecretarySignature(),
    loadBrand(),
    loadPdfFonts(),
  ]);
  const { pdf } = await renderPdf(
    buildDocumentPdf({ ...data, signature }, "es", brand, { justified: true }),
    fonts,
  );
  const name = `${randomUUID()}.pdf`;
  await mkdir(getUploadDir(), { recursive: true });
  await writeFile(join(getUploadDir(), name), pdf);

  let previous: string | null;
  try {
    previous = await db.transaction(async (tx) => {
      const current = await lockDocument(tx, document.id, "update");
      if (current.consolidatedVersionId !== versionId) fail(409, STALE_MESSAGE);
      const row = await loadSigningRow(document.id, tx);
      const values = {
        versionId,
        preparedFile: name,
        preparedAt: new Date(),
        preparedByUserId: actor.user.id,
        preparedWithImage: signature !== null,
      };
      if (row) {
        await tx
          .update(agreementRecordSignings)
          .set({ ...values, updatedAt: sql`now()` })
          .where(eq(agreementRecordSignings.documentId, document.id));
      } else {
        await tx
          .insert(agreementRecordSignings)
          .values({ documentId: document.id, ...values });
      }
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "document",
        entityId: document.id,
        documentId: document.id,
        type: "agreements_record_prepared",
        payload: { withImage: signature !== null },
        actor,
      });
      return row?.preparedFile ?? null;
    });
  } catch (error) {
    await removeStored(name);
    throw error;
  }
  if (previous && previous !== name) await removeStored(previous);
  return loadAgreementsRecordDto(assembly);
}

/** The PDF prepared to sign, for the Secretaría to download or sign. */
export async function preparedRecordFile(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<{ path: string; filename: string }> {
  requireRecordManager(actor);
  const document = await findAgreementsRecord(assembly.id);
  const row = document ? await loadSigningRow(document.id) : null;
  if (
    !document ||
    !row?.preparedFile ||
    !STORED_PDF_NAME.test(row.preparedFile) ||
    row.versionId !== document.consolidatedVersionId
  ) {
    fail(404, "No hay ningún acta preparada para firmar");
  }
  return {
    path: join(getUploadDir(), row.preparedFile),
    filename: `${document.title} (para firmar).pdf`,
  };
}

/** Whether a PDF carries a digital signature (a signature dictionary). */
export function hasDigitalSignature(pdf: Buffer): boolean {
  return SIGNATURE_DICTIONARY.test(pdf.toString("latin1"));
}

function readUpdatedAt(value: string | undefined): string | null {
  const updatedAt = value?.trim() || null;
  if (updatedAt && Number.isNaN(new Date(updatedAt).getTime())) {
    fail(400, "Datos no válidos");
  }
  return updatedAt;
}

/**
 * Publishes the signed record: a PDF with a digital signature, uploaded for
 * the version prepared (it must still be the one in force). Replaces the
 * signed one before, whose file goes once this commits. `updatedAt` is the
 * signing's lock.
 */
export async function attachSignedRecord(
  actor: Actor,
  assembly: AssemblyRow,
  file: UploadedFile,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  const updatedAt = readUpdatedAt(file.fields.updatedAt);
  const document = await signableRecord(assembly);
  // A PDF without a signature is refused before it is stored; anything that
  // is not a PDF, by storePdf.
  const isPdf = file.data.subarray(0, 5).toString("ascii") === "%PDF-";
  if (isPdf && !hasDigitalSignature(file.data)) {
    fail(422, "El PDF no lleva ninguna firma digital");
  }
  const stored = await storePdf(file);
  const storedName = stored.fileUrl.split("/").pop()!;
  const fileUrl = `${AGREEMENTS_URL_PREFIX}${storedName}`;
  let previous: string | null;
  try {
    previous = await db.transaction(async (tx) => {
      const current = await lockDocument(tx, document.id, "update");
      const [row] = await tx
        .select()
        .from(agreementRecordSignings)
        .where(eq(agreementRecordSignings.documentId, document.id))
        .for("update");
      if (!row?.preparedFile) fail(409, "Prepara primero el acta para firmar");
      if (row.versionId !== current.consolidatedVersionId) {
        fail(409, STALE_MESSAGE);
      }
      assertOptimisticLock(updatedAt, row.updatedAt, STALE_MESSAGE);
      await tx
        .update(agreementRecordSignings)
        .set({
          signedFileUrl: fileUrl,
          signedFileName: stored.fileName,
          signedVersionId: current.consolidatedVersionId,
          signedAt: sql`now()`,
          signedByUserId: actor.user.id,
          updatedAt: sql`now()`,
        })
        .where(eq(agreementRecordSignings.documentId, document.id));
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "document",
        entityId: document.id,
        documentId: document.id,
        type: "agreements_record_signed",
        payload: {
          fileName: stored.fileName,
          replaced: row.signedFileUrl !== null,
        },
        actor,
      });
      return signedRecordStoredName(row.signedFileUrl);
    });
  } catch (error) {
    await removeStored(storedName);
    throw error;
  }
  if (previous && previous !== storedName) await removeStored(previous);
  return loadAgreementsRecordDto(assembly);
}

/**
 * Takes the signed PDF away (the generated one stands again), and removes
 * its file once that commits.
 */
export async function removeSignedRecord(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  const document = await findAgreementsRecord(assembly.id);
  if (!document) fail(404, "La asamblea no tiene acta de acuerdos");
  const removed = await db.transaction(async (tx) => {
    const row = await loadSigningRow(document.id, tx);
    if (!row?.signedFileUrl) return null;
    await tx
      .update(agreementRecordSignings)
      .set({
        signedFileUrl: null,
        signedFileName: null,
        signedVersionId: null,
        signedAt: null,
        signedByUserId: null,
        updatedAt: sql`now()`,
      })
      .where(eq(agreementRecordSignings.documentId, document.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: document.id,
      documentId: document.id,
      type: "agreements_record_signature_removed",
      payload: { fileName: row.signedFileName },
      actor,
    });
    return signedRecordStoredName(row.signedFileUrl);
  });
  await removeStored(removed);
  return loadAgreementsRecordDto(assembly);
}
