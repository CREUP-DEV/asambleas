import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { documents, documentVersions } from "../../../../db/schema";
import {
  canManageDocuments,
  requireActor,
} from "../../../../utils/domain/actor";
import {
  resolveAgendaItem,
  resolveAssembly,
} from "../../../../utils/domain/resolvers";
import { recordEvent } from "../../../../utils/domain/events";
import {
  documentsDeadlinePassed,
  hashBlocks,
  loadDocumentDto,
  loadMilestones,
  parseDocumentBody,
  requireMember,
  uniqueDocumentSlug,
} from "../../../../utils/domain/documents";
import { DOCUMENT_KIND_DEFAULTS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { DocumentDto } from "~~/shared/types/api";
import { documentCreateSchema } from "~~/shared/utils/schemas/document";

/**
 * Managers create documents anywhere. Members with document:create present
 * them under agenda items that accept submissions, until documents_close,
 * always as their own member and with the kind defaults.
 */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = parseDocumentBody(documentCreateSchema, await readBody(event));
  const item = await resolveAgendaItem(assembly.id, body.agendaItemId);
  const manager = canManageDocuments(actor);

  if (!manager) {
    if (!actor.can(PERMISSION_KEYS.DOCUMENT_CREATE)) {
      throw createError({
        statusCode: 403,
        message: "No tienes permiso para presentar documentos",
      });
    }
    if (!actor.memberId) {
      throw createError({
        statusCode: 403,
        message: "Tu cuenta no está vinculada a ningún miembro",
      });
    }
    if (!item.acceptsSubmissions) {
      throw createError({
        statusCode: 403,
        message:
          "Este punto del orden del día no admite documentos de los miembros",
      });
    }
    if (assembly.status === "closed") {
      throw createError({
        statusCode: 409,
        message: "La asamblea ya está cerrada",
      });
    }
    if (documentsDeadlinePassed(await loadMilestones(assembly.id))) {
      throw createError({
        statusCode: 409,
        message: "El plazo de presentación de documentos ha terminado",
      });
    }
  }

  const defaults = DOCUMENT_KIND_DEFAULTS[body.kind];
  const isFile = body.format === "file";
  if (isFile && body.amendable) {
    throw createError({
      statusCode: 422,
      message: "Un documento en PDF no puede ser enmendable",
    });
  }

  // Members always present as themselves. Managers pick the proponent, which
  // defaults to their own member; an explicit null leaves it empty.
  let proponentMemberId: string | null = actor.memberId;
  if (manager && body.proponentMemberId !== undefined) {
    proponentMemberId = body.proponentMemberId;
    if (proponentMemberId) await requireMember(proponentMemberId);
  }
  const amendable = isFile
    ? false
    : manager
      ? (body.amendable ?? defaults.amendable)
      : defaults.amendable;
  const voted = manager ? (body.voted ?? defaults.voted) : defaults.voted;
  const majority = manager
    ? (body.majority ?? defaults.majority)
    : defaults.majority;
  const blocks = isFile ? [] : (body.blocks ?? []);
  const contentHash = await hashBlocks(blocks);

  const documentId = await db.transaction(async (tx) => {
    const slug = await uniqueDocumentSlug(tx, assembly.id, body.title);
    const [created] = await tx
      .insert(documents)
      .values({
        assemblyId: assembly.id,
        agendaItemId: item.id,
        slug,
        kind: body.kind,
        format: body.format,
        title: body.title,
        summary: body.summary ?? null,
        status: "draft",
        proponentMemberId,
        submittedByUserId: actor.user.id,
        amendable,
        voted,
        majority,
      })
      .returning({ id: documents.id });
    if (!created) {
      throw createError({
        statusCode: 500,
        message: "No se pudo crear el documento",
      });
    }

    if (!isFile) {
      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId: created.id,
          number: 1,
          kind: "draft",
          blocks,
          contentHash,
          createdByUserId: actor.user.id,
        })
        .returning({ id: documentVersions.id });
      await tx
        .update(documents)
        .set({ workingVersionId: version!.id })
        .where(eq(documents.id, created.id));
    }

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: created.id,
      documentId: created.id,
      type: "document_created",
      payload: {
        documentId: created.id,
        title: body.title,
        kind: body.kind,
        format: body.format,
        agendaItemId: item.id,
        proponentMemberId,
      },
      actor,
    });
    return created.id;
  });

  setResponseStatus(event, 201);
  return loadDocumentDto(assembly, documentId, actor);
});
