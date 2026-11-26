import { eq } from "drizzle-orm";
import { fail } from "../core/http";
import type { DocumentDto } from "~~/shared/types/api";
import { DEFAULT_SECRETARY_TITLE } from "~~/shared/utils/agreementsRecord";
import { db } from "../../db";
import { documentVersions } from "../../db/schema";
import { canManageDocuments, type Actor } from "./actor";
import { isApproved } from "./agreementsRecord";
import { isSignableActa, loadSecretaryName } from "./agreementsSignedFile";
import {
  attachSigned,
  prepareForSigning,
  preparedSigningFile,
  removeSigned,
  type SigningSubject,
} from "./agreementsSigning";
import {
  loadDocumentDto,
  type DocumentRouteContext,
  type UploadedFile,
} from "./documents";

/**
 * Signing an approved acta (user's decisions of 2026-11-26), as the acta de
 * acuerdos is signed (agreementsSigning.ts): once its final vote approved
 * it, the Secretaría prepares a PDF of the text in force followed by the
 * acuerdos' closing («Para que conste…», the visible signature from the
 * Intranet, the name of whoever holds the Secretaría Ejecutiva in the
 * roster and the office), signs it with AutoFirma or outside the platform
 * and uploads it; the signed PDF then leads the document and stands for
 * the generated one in the package. The closing is never stored in the
 * text: an acta written with one of its own has it taken out with a
 * correction of form first. A correction of form, or anything else that
 * changes the text in force or its approval, takes both PDFs away
 * (voidSigning), and the document's managers are told in «Avisos» to sign
 * it again, never by email.
 */

const ACTA_EVENTS: SigningSubject["events"] = {
  prepared: "document_signing_prepared",
  signed: "document_signed",
  removed: "document_signature_removed",
};

/** Refused before anything is read: only the document managers sign. */
export function requireActaManager(actor: Actor): void {
  if (!canManageDocuments(actor)) {
    fail(403, "No tienes permiso para firmar las actas");
  }
}

function requireActa(ctx: DocumentRouteContext): void {
  requireActaManager(ctx.actor);
  if (!isSignableActa(ctx.document)) {
    fail(404, "Este documento no es un acta que se firme");
  }
}

/** The acta approved, with no passage pending: or a refusal. */
async function signableActa(ctx: DocumentRouteContext): Promise<void> {
  requireActa(ctx);
  const { document } = ctx;
  if (
    document.status !== "published" ||
    !(await isApproved(db, document)) ||
    !document.consolidatedVersionId
  ) {
    fail(409, "El acta se firma una vez aprobada en su votación final");
  }
  const [version] = await db
    .select({ pending: documentVersions.pendingPassages })
    .from(documentVersions)
    .where(eq(documentVersions.id, document.consolidatedVersionId));
  if (version?.pending?.length) {
    fail(409, "Concilia antes los pasajes pendientes del acta");
  }
}

/** Who certifies the acta: the Secretaría Ejecutiva of the roster. */
async function actaClosing(): Promise<{ name: string; office: string }> {
  const name = await loadSecretaryName();
  if (!name) {
    fail(
      409,
      "El censo no tiene a nadie en la Secretaría Ejecutiva: sin su nombre no se puede preparar el acta",
    );
  }
  return { name, office: DEFAULT_SECRETARY_TITLE };
}

export async function prepareActaForSigning(
  ctx: DocumentRouteContext,
): Promise<DocumentDto> {
  await signableActa(ctx);
  await prepareForSigning(ctx.actor, ctx.assembly, {
    document: ctx.document,
    closing: await actaClosing(),
    events: ACTA_EVENTS,
  });
  return loadDocumentDto(ctx.assembly, ctx.document.id, ctx.actor);
}

/** The acta prepared to sign, for the Secretaría to download or sign. */
export async function preparedActaFile(
  ctx: DocumentRouteContext,
): Promise<{ path: string; filename: string }> {
  requireActa(ctx);
  return preparedSigningFile(ctx.document);
}

export async function attachSignedActa(
  ctx: DocumentRouteContext,
  file: UploadedFile,
): Promise<DocumentDto> {
  await signableActa(ctx);
  await attachSigned(
    ctx.actor,
    ctx.assembly,
    { document: ctx.document, closing: null, events: ACTA_EVENTS },
    file,
  );
  return loadDocumentDto(ctx.assembly, ctx.document.id, ctx.actor);
}

export async function removeSignedActa(
  ctx: DocumentRouteContext,
): Promise<DocumentDto> {
  requireActa(ctx);
  await removeSigned(
    ctx.actor,
    ctx.assembly,
    ctx.document,
    ACTA_EVENTS.removed,
  );
  return loadDocumentDto(ctx.assembly, ctx.document.id, ctx.actor);
}
