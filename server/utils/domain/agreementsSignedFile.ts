import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type {
  AgreementsRecordSignedFileDto,
  AgreementsRecordSigningDto,
  DocumentSigningDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import {
  annexStart,
  isClosingFormula,
} from "~~/shared/utils/content/writtenClosing";
import { db } from "../../db";
import {
  agreementRecordSignings,
  type documentVersions,
  members,
} from "../../db/schema";
import {
  ACTA_CLOSING_FORMULA,
  DEFAULT_SECRETARY_TITLE,
  SIGNED_CLOSING_FORMULA,
} from "~~/shared/utils/agreementsRecord";
import { STORED_PDF_NAME, type DocumentRow } from "./documents";
import { logError } from "../core/logger";
import { getUploadDir } from "../core/uploadPaths";
import { actsFor, canManageDocuments, type Actor } from "./actor";
import { recordEvent, type Executor } from "./events";
import { signedTextVersionId } from "./signedText";

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

export { signedTextVersionId };

/** The signed PDF of a document for its text in force, or null. */
export async function loadSignedRecordFile(
  document: Pick<
    DocumentRow,
    "id" | "consolidatedVersionId" | "baseVersionId" | "voted"
  >,
  executor: Executor = db,
): Promise<AgreementsRecordSignedFileDto | null> {
  const inForce = signedTextVersionId(document);
  if (!inForce) return null;
  const [row] = await executor
    .select({
      url: agreementRecordSignings.signedFileUrl,
      name: agreementRecordSignings.signedFileName,
      versionId: agreementRecordSignings.signedVersionId,
      signedAt: agreementRecordSignings.signedAt,
    })
    .from(agreementRecordSignings)
    .where(eq(agreementRecordSignings.documentId, document.id));
  if (!row?.url || !row.signedAt || row.versionId !== inForce) {
    return null;
  }
  return {
    url: row.url,
    name: row.name ?? "documento-firmado.pdf",
    signedAt: row.signedAt.toISOString(),
  };
}

/**
 * A document signed in the platform (documentSigning.ts; user's decisions
 * of 2026-11-26 and 2026-11-28): one marked so (`signed`, by default the
 * actas, budgets and reports), as text, the platform did not write. The
 * acta de acuerdos signs on its own page.
 */
export function isSignedDocument(
  document: Pick<DocumentRow, "generated" | "format" | "signed">,
): boolean {
  return (
    document.signed === true &&
    document.generated === null &&
    document.format === "structured"
  );
}

/**
 * Whether the actor signs this document (documentSigning.ts): an acta, its
 * managers; anything else, its main presenter's accounts.
 */
export function canSignDocument(
  actor: Actor,
  document: Pick<DocumentRow, "kind" | "proponentMemberId">,
): boolean {
  return document.kind === "minutes"
    ? canManageDocuments(actor)
    : actsFor(actor, [document.proponentMemberId]);
}

/** Whether a document may carry a signed PDF that leads it. */
export function hasSigning(
  document: Pick<DocumentRow, "generated" | "format" | "signed">,
): boolean {
  return (
    document.generated === "agreements_record" || isSignedDocument(document)
  );
}

type SigningRow = typeof agreementRecordSignings.$inferSelect;

/** A signing as its signers' panel reads it, against the text in force. */
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
            name: row.signedFileName ?? "documento-firmado.pdf",
            signedAt: row.signedAt.toISOString(),
            current: inForce !== null && row.signedVersionId === inForce,
          }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Who signs a document and how its PDF closes (user's decisions of
 * 2026-11-28): an acta, the Secretaría Ejecutiva of the roster; any other,
 * its main presenter. A CEA office signs as whoever holds it, under the
 * office's name as the roster has it («Tesorería de la Coordinadora…»);
 * a council or a sectorial, whose Intranet account is no person's, under
 * its own name and with no office line. `intranetId` is the Intranet
 * account whose signature image goes above the name, when it has one.
 * Null when nobody can sign: an acta with nobody in the Secretaría, a
 * document with no presenter.
 */
export interface SigningCloser {
  name: string;
  office: string | null;
  formula: string;
  intranetId: number | null;
  /** The acta's: the Secretaría Ejecutiva's signature, as before. */
  secretary: boolean;
}

export async function loadSigningCloser(
  document: Pick<DocumentRow, "kind" | "proponentMemberId">,
  executor: Executor = db,
): Promise<SigningCloser | null> {
  const columns = {
    kind: members.kind,
    name: members.name,
    holderName: members.holderName,
    intranetId: members.intranetId,
  };
  if (document.kind === "minutes") {
    const [office] = await executor
      .select(columns)
      .from(members)
      .where(and(eq(members.kind, "executive"), eq(members.acronym, "SE")));
    const name = office?.holderName?.trim();
    if (!name) return null;
    return {
      name,
      office: DEFAULT_SECRETARY_TITLE,
      formula: ACTA_CLOSING_FORMULA,
      intranetId: office!.intranetId ?? null,
      secretary: true,
    };
  }
  if (!document.proponentMemberId) return null;
  const [member] = await executor
    .select(columns)
    .from(members)
    .where(eq(members.id, document.proponentMemberId));
  if (!member) return null;
  const holder =
    member.kind === "executive" ? member.holderName?.trim() || null : null;
  return {
    name: holder ?? member.name,
    office: holder ? member.name : null,
    formula: SIGNED_CLOSING_FORMULA,
    // Only a person signs with an image: a CEA office's holder.
    intranetId: holder ? (member.intranetId ?? null) : null,
    secretary: false,
  };
}

/** How far from its end a text is read for a closing of its own. */
const CLOSING_TAIL = 12;

/**
 * Whether a text already ends with a signing formula of its own (the ones
 * a Word import takes out, isClosingFormula): one written before the
 * platform signed it (an acta of 2026-11-26, say), which a correction of
 * form takes out, as the PDF made to be signed adds it.
 */
export function endsWithClosing(blocks: readonly Block[]): boolean {
  // The annexes come after the signature: the text ends before them.
  return blocks
    .slice(0, annexStart(blocks))
    .slice(-CLOSING_TAIL)
    .some((block) => !block.cell && isClosingFormula(block.text));
}

/**
 * A document's signing for whoever may sign it: whether it can be prepared
 * (its text in force exists: approved by its final vote, or published when
 * nothing votes it; no passage pending conciliation; somebody to sign it),
 * who signs, whether its text has a closing of its own, and the signing so
 * far.
 */
export async function loadDocumentSigning(
  document: Pick<
    DocumentRow,
    | "id"
    | "kind"
    | "status"
    | "voted"
    | "proponentMemberId"
    | "consolidatedVersionId"
    | "baseVersionId"
  >,
  /** The version in force (signedTextVersionId), when loaded. */
  text: Pick<VersionRow, "blocks" | "pendingPassages"> | null,
  finalVote: { result: string | null; voidedAt?: Date | null } | null,
  executor: Executor = db,
): Promise<DocumentSigningDto> {
  const [rows, closer] = await Promise.all([
    executor
      .select()
      .from(agreementRecordSignings)
      .where(eq(agreementRecordSignings.documentId, document.id)),
    loadSigningCloser(document, executor),
  ]);
  const inForce = signedTextVersionId(document);
  const textReady = document.voted
    ? inForce !== null &&
      finalVote?.result === "approved" &&
      !finalVote.voidedAt
    : inForce !== null;
  return {
    // What preparing it checks (documentSigning.ts), so the panel never
    // offers a step that is refused.
    ready:
      textReady &&
      text !== null &&
      document.status === "published" &&
      closer !== null &&
      !(text.pendingPassages?.length ?? 0),
    closingInText: text ? endsWithClosing(text.blocks) : false,
    signer: closer?.name ?? null,
    image: closer ? closer.secretary || closer.intranetId !== null : false,
    state: rows[0] ? toSigningDto(rows[0], inForce) : null,
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
