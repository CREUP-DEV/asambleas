import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../core/http";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import type {
  AgreementsRecordDto,
  AgreementsRecordSigningDto,
} from "~~/shared/types/api";
import { db } from "../../db";
import { agreementRecordSignings, votes } from "../../db/schema";
import { logWarn } from "../core/logger";
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
import { assertOptimisticLock, STALE_WRITE_DATA } from "../optimisticLock";
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
  removeStoredSigningFile as removeStored,
  signedRecordStoredName,
  signedTextVersionId,
  toSigningDto,
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

/** The Secretaría Ejecutiva's signature: the account the Intranet marks. */
const SECRETARY_SIGNATURE_PATH = "firma-secretaria";
/** Any individual account's signature, by its Intranet id (2026-11-28). */
const signaturePathOf = (intranetId: number) => `firma/${intranetId}`;
/** The largest image read from the Intranet. */
const SIGNATURE_MAX_BYTES = 3_000_000;
const SIGNATURE_MAX_INPUT_PIXELS = 25_000_000;
/** The signature is drawn at most 200 × 72 pt: twice that is plenty. */
const SIGNATURE_BOX = { width: 800, height: 320 };
/** What a PDF needs to carry a digital signature. */
const SIGNATURE_DICTIONARY = /\/ByteRange\s*\[/;
const STALE_MESSAGE =
  "El documento ha cambiado mientras tanto. Recarga e inténtalo de nuevo";

type SigningRow = typeof agreementRecordSignings.$inferSelect;

/**
 * Whose visible signature a signing's PDF carries: the Secretaría
 * Ejecutiva's (the acta de acuerdos, an acta), an individual Intranet
 * account's (a CEA office's holder), or none (a council, a sectorial).
 */
export type SignatureSource = "secretary" | number | null;

function fetchSignatureOf(
  source: SignatureSource,
): Promise<ExportImage | null> {
  if (source === null) return Promise.resolve(null);
  return fetchSignature(
    source === "secretary" ? SECRETARY_SIGNATURE_PATH : signaturePathOf(source),
  );
}

/**
 * A visible signature from the Intranet, as a PNG for the PDF (pdfmake
 * draws PNG and JPEG only), or null when there is none or it cannot be
 * read: the PDF then keeps the space blank. Never follows a redirect, never
 * logs the image.
 */
async function fetchSignature(path: string): Promise<ExportImage | null> {
  const base = getIntranetApiBaseUrl();
  if (!base) return null;
  let response: Response;
  try {
    response = await fetch(intranetUrl(base, path), {
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
  return row ? toSigningDto(row, document.consolidatedVersionId) : null;
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
 * What a signing is about: the acta de acuerdos, whose text ends with its
 * own closing, or a signed document (documentSigning.ts), whose PDF gets
 * that closing for whoever signs it (user's decisions of 2026-11-26 and
 * 2026-11-28). Whose visible signature it carries, and the events each one
 * records.
 */
export interface SigningSubject {
  /** The document, already checked as signable by the caller. */
  document: DocumentRow;
  /** The closing the PDF adds after the text; null when it has its own. */
  closing: { name: string; office: string | null; formula: string } | null;
  signature: SignatureSource;
  events: { prepared: string; signed: string; removed: string };
}

const RECORD_EVENTS: SigningSubject["events"] = {
  prepared: "agreements_record_prepared",
  signed: "agreements_record_signed",
  removed: "agreements_record_signature_removed",
};

/**
 * Makes the PDF to sign from the text in force, with the visible signature
 * when the Intranet has one, and keeps it for the Secretaría to download.
 * The one prepared before goes.
 */
export async function prepareForSigning(
  actor: Actor,
  assembly: AssemblyRow,
  subject: SigningSubject,
): Promise<void> {
  const { document } = subject;
  const versionId = signedTextVersionId(document)!;
  // The PDF words its approval from the final vote (by assent, unanimous):
  // a change to it while this renders makes the PDF stale.
  const voteStamp = await finalVoteStamp(db, document.finalVoteId);
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
    fetchSignatureOf(subject.signature),
    loadBrand(),
    loadPdfFonts(),
  ]);
  const { pdf } = await renderPdf(
    buildDocumentPdf(
      { ...data, signature, signingClosing: subject.closing },
      "es",
      brand,
      { justified: true },
    ),
    fonts,
  );
  const name = `${randomUUID()}.pdf`;
  await mkdir(getUploadDir(), { recursive: true });
  await writeFile(join(getUploadDir(), name), pdf);

  let previous: string | null;
  try {
    previous = await db.transaction(async (tx) => {
      const current = await lockDocument(tx, document.id);
      if (
        signedTextVersionId(current) !== versionId ||
        current.finalVoteId !== document.finalVoteId ||
        (await finalVoteStamp(tx, current.finalVoteId, true)) !== voteStamp
      ) {
        fail(409, STALE_MESSAGE, STALE_WRITE_DATA);
      }
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
        type: subject.events.prepared,
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
}

/**
 * When the final vote was last written (null without one), read FOR SHARE
 * inside a transaction so a change to it waits for this one.
 */
async function finalVoteStamp(
  executor: Executor,
  voteId: string | null,
  lock = false,
): Promise<number | null> {
  if (!voteId) return null;
  const query = executor
    .select({ updatedAt: votes.updatedAt })
    .from(votes)
    .where(eq(votes.id, voteId));
  const [row] = await (lock ? query.for("share") : query);
  return row?.updatedAt.getTime() ?? null;
}

export async function prepareRecordForSigning(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  const document = await signableRecord(assembly);
  await prepareForSigning(actor, assembly, {
    document,
    closing: null,
    signature: "secretary",
    events: RECORD_EVENTS,
  });
  return loadAgreementsRecordDto(assembly);
}

/**
 * The PDF prepared to sign a document, for whoever signs it to download or
 * sign; a refusal when there is none for its text in force.
 */
export async function preparedSigningFile(
  document: DocumentRow | null,
): Promise<{ path: string; filename: string }> {
  const row = document ? await loadSigningRow(document.id) : null;
  if (
    !document ||
    !row?.preparedFile ||
    !STORED_PDF_NAME.test(row.preparedFile) ||
    row.versionId !== signedTextVersionId(document)
  ) {
    fail(404, "No hay nada preparado para firmar");
  }
  return {
    path: join(getUploadDir(), row.preparedFile),
    filename: `${document.title} (para firmar).pdf`,
  };
}

/** The record's PDF prepared to sign (preparedSigningFile). */
export async function preparedRecordFile(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<{ path: string; filename: string }> {
  requireRecordManager(actor);
  return preparedSigningFile(await findAgreementsRecord(assembly.id));
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
 * Publishes the signed PDF: one with a digital signature, uploaded for the
 * version prepared (it must still be the one in force). Replaces the
 * signed one before, whose file goes once this commits. `updatedAt` is the
 * signing's lock.
 */
export async function attachSigned(
  actor: Actor,
  assembly: AssemblyRow,
  subject: SigningSubject,
  file: UploadedFile,
): Promise<void> {
  const { document } = subject;
  const updatedAt = readUpdatedAt(file.fields.updatedAt);
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
      const current = await lockDocument(tx, document.id);
      const [row] = await tx
        .select()
        .from(agreementRecordSignings)
        .where(eq(agreementRecordSignings.documentId, document.id))
        .for("update");
      if (!row?.preparedFile) {
        fail(409, "Prepara primero el documento para firmar");
      }
      const inForce = signedTextVersionId(current);
      if (!inForce || row.versionId !== inForce) {
        fail(409, STALE_MESSAGE, STALE_WRITE_DATA);
      }
      // The multipart `updatedAt` field may come empty: the page sends ""
      // while it read no signing.
      assertOptimisticLock(updatedAt, row.updatedAt, STALE_MESSAGE, {
        optional: true,
      });
      await tx
        .update(agreementRecordSignings)
        .set({
          signedFileUrl: fileUrl,
          signedFileName: stored.fileName,
          signedVersionId: inForce,
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
        type: subject.events.signed,
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
}

export async function attachSignedRecord(
  actor: Actor,
  assembly: AssemblyRow,
  file: UploadedFile,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  const document = await signableRecord(assembly);
  await attachSigned(
    actor,
    assembly,
    { document, closing: null, signature: "secretary", events: RECORD_EVENTS },
    file,
  );
  return loadAgreementsRecordDto(assembly);
}

/**
 * Takes a document's signed PDF away (the generated one stands again), and
 * removes its file once that commits.
 */
export async function removeSigned(
  actor: Actor,
  assembly: AssemblyRow,
  document: DocumentRow,
  eventType: string,
): Promise<void> {
  const removed = await db.transaction(async (tx) => {
    // As attachSigned: the document, then the signing row.
    await lockDocument(tx, document.id);
    const [row] = await tx
      .select()
      .from(agreementRecordSignings)
      .where(eq(agreementRecordSignings.documentId, document.id))
      .for("update");
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
      type: eventType,
      payload: { fileName: row.signedFileName },
      actor,
    });
    return signedRecordStoredName(row.signedFileUrl);
  });
  await removeStored(removed);
}

export async function removeSignedRecord(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<AgreementsRecordDto> {
  requireRecordManager(actor);
  const document = await findAgreementsRecord(assembly.id);
  if (!document) fail(404, "La asamblea no tiene acta de acuerdos");
  await removeSigned(actor, assembly, document, RECORD_EVENTS.removed);
  return loadAgreementsRecordDto(assembly);
}
