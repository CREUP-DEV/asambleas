import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type {
  AgreementsRecordSignedFileDto,
  AgreementsRecordSigningDto,
  DocumentSigningDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { db } from "../../db";
import {
  agreementRecordSignings,
  type documentVersions,
  members,
} from "../../db/schema";
import { STORED_PDF_NAME, type DocumentRow } from "./documents";
import { logError } from "../core/logger";
import { getUploadDir } from "../core/uploadPaths";
import type { Actor } from "./actor";
import { recordEvent, type Executor } from "./events";

type VersionRow = typeof documentVersions.$inferSelect;

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

/**
 * An acta Secretaría may sign once approved (user's decision of
 * 2026-11-26; documentSigning.ts): a text of kind `minutes` the platform
 * did not write. The acta de acuerdos signs on its own page.
 */
export function isSignableActa(
  document: Pick<DocumentRow, "kind" | "generated" | "format">,
): boolean {
  return (
    document.kind === "minutes" &&
    document.generated === null &&
    document.format === "structured"
  );
}

/** Whether a document may carry a signed PDF that leads it. */
export function hasSigning(
  document: Pick<DocumentRow, "kind" | "generated" | "format">,
): boolean {
  return document.generated === "agreements_record" || isSignableActa(document);
}

type SigningRow = typeof agreementRecordSignings.$inferSelect;

/** A signing as the Secretaría's panel reads it, against the text in force. */
export function toSigningDto(
  row: SigningRow,
  inForce: string | null,
): AgreementsRecordSigningDto {
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

/** The name of whoever holds the Secretaría Ejecutiva, as the roster has it. */
export async function loadSecretaryName(
  executor: Executor = db,
): Promise<string | null> {
  const [row] = await executor
    .select({ holderName: members.holderName })
    .from(members)
    .where(and(eq(members.kind, "executive"), eq(members.acronym, "SE")));
  return row?.holderName?.trim() || null;
}

/** «Para que conste…», the formula a signed text closes with. */
const CLOSING_FORMULA = /para\s+que\s+conste/i;
/** How far from its end a text is read for a closing of its own. */
const CLOSING_TAIL = 12;

/**
 * Whether a text already ends with a signing formula of its own: an acta
 * written before 2026-11-26 closes with it and its signer's name, which the
 * Secretaría takes out with a correction of form, as the PDF made to be
 * signed adds them (user's decision of 2026-11-26).
 */
export function endsWithClosing(blocks: readonly Block[]): boolean {
  return blocks
    .slice(-CLOSING_TAIL)
    .some((block) => CLOSING_FORMULA.test(block.text));
}

/**
 * The signing of an acta for the document's managers: whether it can be
 * prepared (approved by its final vote, no passage pending conciliation),
 * who will certify it, whether its text has a closing of its own, and the
 * signing so far.
 */
export async function loadActaSigning(
  document: Pick<DocumentRow, "id" | "consolidatedVersionId" | "status">,
  consolidated: Pick<VersionRow, "blocks" | "pendingPassages"> | null,
  finalVote: { result: string | null; voidedAt?: Date | null } | null,
  executor: Executor = db,
): Promise<DocumentSigningDto> {
  const [rows, signer] = await Promise.all([
    executor
      .select()
      .from(agreementRecordSignings)
      .where(eq(agreementRecordSignings.documentId, document.id)),
    loadSecretaryName(executor),
  ]);
  const approved =
    consolidated !== null &&
    finalVote?.result === "approved" &&
    !finalVote.voidedAt;
  return {
    // What preparing it checks (documentSigning.ts), so the panel never
    // offers a step that is refused.
    ready:
      approved &&
      document.status === "published" &&
      signer !== null &&
      !(consolidated.pendingPassages?.length ?? 0),
    closingInText: consolidated ? endsWithClosing(consolidated.blocks) : false,
    signer,
    state: rows[0]
      ? toSigningDto(rows[0], document.consolidatedVersionId)
      : null,
  };
}

// Clearing a signing ------------------------------------------------------

/** Files a cleared signing leaves behind, removed once that commits. */
export interface SigningFiles {
  prepared: string | null;
  signed: string | null;
}

/**
 * Takes both PDFs away from a signing (a new version of the text, or of
 * its approval), inside the caller's transaction. Answers the files to
 * remove once that commits.
 */
export async function clearSigning(
  tx: Executor,
  documentId: string,
): Promise<SigningFiles> {
  const [row] = await tx
    .select()
    .from(agreementRecordSignings)
    .where(eq(agreementRecordSignings.documentId, documentId));
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

/** Removes one stored signing PDF, best effort. */
export async function removeStoredSigningFile(
  name: string | null,
): Promise<void> {
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
  await removeStoredSigningFile(files.prepared);
  await removeStoredSigningFile(files.signed);
}

/** The event that tells the managers a signed acta must be signed again. */
export const SIGNATURE_VOIDED_EVENT = "document_signature_voided";

/** Why a signed text lost its signature (SIGNATURE_VOIDED_EVENT). */
export type SignatureVoidReason =
  "form_correction" | "final_vote_annulled" | "unanimity_changed";

/**
 * Takes both PDFs away from a document's signing, inside the caller's
 * transaction, when what they were made of changed: its text in force or
 * its approval. A published signature leaves an event
 * (SIGNATURE_VOIDED_EVENT) the managers read in «Avisos». Answers the
 * files to remove once that commits (removeSigningFiles), or null when the
 * document had no signing.
 */
export async function voidSigning(
  tx: Executor,
  target: { assemblyId: string; documentId: string },
  actor: Actor,
  reason: SignatureVoidReason,
): Promise<SigningFiles | null> {
  const [row] = await tx
    .select({
      prepared: agreementRecordSignings.preparedFile,
      signed: agreementRecordSignings.signedFileUrl,
      signedName: agreementRecordSignings.signedFileName,
    })
    .from(agreementRecordSignings)
    .where(eq(agreementRecordSignings.documentId, target.documentId))
    .for("update");
  if (!row || (!row.prepared && !row.signed)) return null;
  const files = await clearSigning(tx, target.documentId);
  if (row.signed) {
    await recordEvent(tx, {
      assemblyId: target.assemblyId,
      entityType: "document",
      entityId: target.documentId,
      documentId: target.documentId,
      type: SIGNATURE_VOIDED_EVENT,
      payload: { reason, fileName: row.signedName },
      actor,
    });
  }
  return files;
}

/** Removes the files voidSigning left, once the transaction committed. */
export async function removeAllSigningFiles(
  list: readonly (SigningFiles | null)[],
): Promise<void> {
  for (const files of list) if (files) await removeSigningFiles(files);
}
