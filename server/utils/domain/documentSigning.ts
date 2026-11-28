import { eq } from "drizzle-orm";
import { fail } from "../core/http";
import type { DocumentDto } from "~~/shared/types/api";
import { db } from "../../db";
import { documentVersions } from "../../db/schema";
import { canManageDocuments } from "./actor";
import { isApproved } from "./agreementsRecord";
import {
  canSignDocument,
  isSignedDocument,
  loadSigningCloser,
  signedTextVersionId,
  type SigningCloser,
} from "./agreementsSignedFile";
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
  type DocumentRow,
  type UploadedFile,
} from "./documents";

/**
 * Signing a document in the platform (user's decisions of 2026-11-26 and
 * 2026-11-28), as the acta de acuerdos is signed (agreementsSigning.ts).
 * A document is signed when marked so (`signed`: by default the actas, the
 * budgets and the reports written as text), and once its text is in force:
 * the approved one when the assembly votes it, the published one when it
 * does not (a report). Whoever signs prepares a PDF of that text followed
 * by the closing (the formula, the visible signature from the Intranet,
 * the name and the office), signs it with AutoFirma or outside the
 * platform and uploads it; the signed PDF then leads the document and
 * stands for the generated one in the package.
 *
 * An acta is certified by the Secretaría Ejecutiva of the roster («Para
 * que conste…»), and its managers sign it; any other document by its main
 * presenter («Y por tanto firmo…»), whose accounts sign it: a CEA office as
 * whoever holds it, with their signature; a council or a sectorial under
 * its own name, with none. Co-presenters do not sign. The closing is never
 * stored in the text: one written in it is taken out (on import, or with a
 * correction of form). A correction of form, or anything else that changes
 * the text in force or its approval, takes both PDFs away (voidSigning),
 * and whoever signs is told in «Avisos» to sign it again, never by email.
 */

const SIGNING_EVENTS: SigningSubject["events"] = {
  prepared: "document_signing_prepared",
  signed: "document_signed",
  removed: "document_signature_removed",
};

/**
 * Refused before anything is read: a document that is not signed, or an
 * actor who does not sign it. A signed PDF may also be taken away by the
 * document managers.
 */
export function requireDocumentSigner(
  ctx: DocumentRouteContext,
  removing = false,
): void {
  const { actor, document } = ctx;
  if (
    !canSignDocument(actor, document) &&
    !(removing && canManageDocuments(actor))
  ) {
    fail(403, "No tienes permiso para firmar este documento");
  }
  if (!isSignedDocument(document)) {
    fail(404, "Este documento no se firma");
  }
}

/** Its text in force, with no passage pending, and its signer: or a refusal. */
async function signableDocument(
  ctx: DocumentRouteContext,
): Promise<SigningCloser> {
  requireDocumentSigner(ctx);
  const { document } = ctx;
  const inForce = signedTextVersionId(document);
  if (document.status !== "published" || !inForce) {
    fail(
      409,
      document.voted
        ? "El documento se firma una vez aprobado en su votación final"
        : "El documento se firma una vez publicado",
    );
  }
  if (document.voted && !(await isApproved(db, document))) {
    fail(409, "El documento se firma una vez aprobado en su votación final");
  }
  const [version] = await db
    .select({ pending: documentVersions.pendingPassages })
    .from(documentVersions)
    .where(eq(documentVersions.id, inForce));
  if (version?.pending?.length) {
    fail(409, "Concilia antes los pasajes pendientes del documento");
  }
  const closer = await loadSigningCloser(document);
  if (!closer) {
    fail(
      409,
      document.kind === "minutes"
        ? "El censo no tiene a nadie en la Secretaría Ejecutiva: sin su nombre no se puede preparar el acta"
        : "El documento no tiene presentador que lo firme",
    );
  }
  return closer;
}

function subjectOf(
  document: DocumentRow,
  closer: SigningCloser | null,
): SigningSubject {
  return {
    document,
    closing: closer
      ? { name: closer.name, office: closer.office, formula: closer.formula }
      : null,
    signature: closer?.secretary ? "secretary" : (closer?.intranetId ?? null),
    events: SIGNING_EVENTS,
  };
}

export async function prepareDocumentForSigning(
  ctx: DocumentRouteContext,
): Promise<DocumentDto> {
  const closer = await signableDocument(ctx);
  await prepareForSigning(
    ctx.actor,
    ctx.assembly,
    subjectOf(ctx.document, closer),
  );
  return loadDocumentDto(ctx.assembly, ctx.document.id, ctx.actor);
}

/** The document prepared to sign, for whoever signs it to download. */
export async function preparedDocumentFile(
  ctx: DocumentRouteContext,
): Promise<{ path: string; filename: string }> {
  requireDocumentSigner(ctx);
  return preparedSigningFile(ctx.document);
}

export async function attachSignedDocument(
  ctx: DocumentRouteContext,
  file: UploadedFile,
): Promise<DocumentDto> {
  await signableDocument(ctx);
  await attachSigned(
    ctx.actor,
    ctx.assembly,
    subjectOf(ctx.document, null),
    file,
  );
  return loadDocumentDto(ctx.assembly, ctx.document.id, ctx.actor);
}

export async function removeSignedDocument(
  ctx: DocumentRouteContext,
): Promise<DocumentDto> {
  requireDocumentSigner(ctx, true);
  await removeSigned(
    ctx.actor,
    ctx.assembly,
    ctx.document,
    SIGNING_EVENTS.removed,
  );
  return loadDocumentDto(ctx.assembly, ctx.document.id, ctx.actor);
}
