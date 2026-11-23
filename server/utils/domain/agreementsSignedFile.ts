import { eq } from "drizzle-orm";
import type { AgreementsRecordSignedFileDto } from "~~/shared/types/api";
import { db } from "../../db";
import { agreementRecordSignings } from "../../db/schema";
import { STORED_PDF_NAME } from "./documents";
import type { Executor } from "./events";

/**
 * The signed acta de acuerdos as everyone who sees the document reads it
 * (agreementsSigning.ts): served by /api/uploads/agreements/[filename], and
 * only while it signs the text in force (`consolidatedVersionId`).
 */
export const AGREEMENTS_URL_PREFIX = "/api/uploads/agreements/";

/** The stored name of a signed record's URL, or null if it is not one. */
export function signedRecordStoredName(
  fileUrl: string | null | undefined,
): string | null {
  if (!fileUrl?.startsWith(AGREEMENTS_URL_PREFIX)) return null;
  const name = fileUrl.slice(AGREEMENTS_URL_PREFIX.length);
  return STORED_PDF_NAME.test(name) ? name : null;
}

/** The record's signed PDF for the text in force, or null. */
export async function loadSignedRecordFile(
  document: { id: string; consolidatedVersionId: string | null },
  executor: Executor = db,
): Promise<AgreementsRecordSignedFileDto | null> {
  if (!document.consolidatedVersionId) return null;
  const [row] = await executor
    .select({
      url: agreementRecordSignings.signedFileUrl,
      name: agreementRecordSignings.signedFileName,
      versionId: agreementRecordSignings.signedVersionId,
      signedAt: agreementRecordSignings.signedAt,
    })
    .from(agreementRecordSignings)
    .where(eq(agreementRecordSignings.documentId, document.id));
  if (
    !row?.url ||
    !row.signedAt ||
    row.versionId !== document.consolidatedVersionId
  ) {
    return null;
  }
  return {
    url: row.url,
    name: row.name ?? "acta-de-acuerdos.pdf",
    signedAt: row.signedAt.toISOString(),
  };
}
