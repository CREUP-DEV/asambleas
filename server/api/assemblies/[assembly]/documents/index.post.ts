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
  UNLINKED_ACCOUNT_MESSAGE,
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
  requireMembers,
  uniqueDocumentSlug,
} from "../../../../utils/domain/documents";
import {
  planPresenters,
  PRESENTERS_MESSAGES,
  saveCoProponents,
} from "../../../../utils/domain/presenters";
import { DOCUMENT_KIND_DEFAULTS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { DocumentDto } from "~~/shared/types/api";
import { documentCreateSchema } from "~~/shared/utils/schemas/document";

/**
 * Managers create documents anywhere, for any members, and may set an
 * internal deadline (`dueAt`): an expected document starts as an empty draft
 * that its member fills in and presents. Members with document:create present
 * them under agenda items that accept submissions, until documents_close,
 * with the kind defaults, always among its presenters: they may add
 * co-presenters and name the main presenter, their own member or another
 * one (planPresenters).
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
    if (body.dueAt) {
      throw createError({
        statusCode: 403,
        message: "Solo la Secretaría puede fijar la fecha límite interna",
      });
    }
    if (!actor.can(PERMISSION_KEYS.DOCUMENT_CREATE)) {
      throw createError({
        statusCode: 403,
        message: "No tienes permiso para presentar documentos",
      });
    }
    if (!actor.memberId) {
      throw createError({
        statusCode: 403,
        message: UNLINKED_ACCOUNT_MESSAGE,
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

  // Members always present it, alone or with co-presenters. Managers pick
  // the presenters; the main one defaults to their own member and an
  // explicit null leaves it empty (with no co-presenters).
  const presenters = planPresenters({
    manager,
    actorMemberId: actor.memberId,
    current: null,
    proponentMemberId: body.proponentMemberId,
    coProponentMemberIds: body.coProponentMemberIds,
  });
  if (typeof presenters === "string") {
    throw createError({
      statusCode: 422,
      message: PRESENTERS_MESSAGES[presenters],
    });
  }
  const { proponentMemberId, coProponentMemberIds } = presenters;
  if (proponentMemberId && proponentMemberId !== actor.memberId) {
    await requireMember(proponentMemberId);
  }
  await requireMembers(
    coProponentMemberIds.filter((id) => id !== actor.memberId),
  );
  const amendable = isFile
    ? false
    : manager
      ? (body.amendable ?? defaults.amendable)
      : defaults.amendable;
  const voted = manager ? (body.voted ?? defaults.voted) : defaults.voted;
  const majority = manager
    ? (body.majority ?? defaults.majority)
    : defaults.majority;
  const acceptedAmendments = manager
    ? (body.acceptedAmendments ?? defaults.acceptedAmendments)
    : defaults.acceptedAmendments;
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
        acceptedAmendments,
        voted,
        majority,
        dueAt: manager && body.dueAt ? new Date(body.dueAt) : null,
      })
      .returning({ id: documents.id });
    if (!created) {
      throw createError({
        statusCode: 500,
        message: "No se pudo crear el documento",
      });
    }

    await saveCoProponents(tx, created.id, coProponentMemberIds);

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
        ...(coProponentMemberIds.length > 0 ? { coProponentMemberIds } : {}),
        acceptedAmendments,
        ...(manager && body.dueAt ? { dueAt: body.dueAt } : {}),
      },
      actor,
    });
    return created.id;
  });

  setResponseStatus(event, 201);
  return loadDocumentDto(assembly, documentId, actor);
});
