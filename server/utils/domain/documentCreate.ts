import { createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { agendaItems, documents, documentVersions } from "../../db/schema";
import {
  canManageDocuments,
  UNLINKED_ACCOUNT_MESSAGE,
  type Actor,
} from "./actor";
import { bindAutoItem, insertAutoItem, lockAssembly } from "./agendaWrites";
import {
  documentsDeadlinePassed,
  FILE_FORMAT_REFUSED_MESSAGE,
  hashBlocks,
  loadMilestones,
  requireMember,
  requireMembers,
  requireNotOthersAutoItem,
  requirePresentersMayPresent,
  requireSubmissionTarget,
  uniqueDocumentSlug,
} from "./documents";
import { recordEvent } from "./events";
import {
  planPresenters,
  PRESENTERS_MESSAGES,
  saveCoProponents,
} from "./presenters";
import {
  DOCUMENT_KIND_DEFAULTS,
  type AcceptedAmendmentRule,
  type DocumentFormat,
  type DocumentKind,
  type Majority,
} from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { DocumentCreateBody } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import {
  FILE_FORMAT_REFUSED_REASON,
  fileFormatRefused,
} from "~~/shared/utils/documentFormat";

/**
 * Creating documents (POST .../documents and the bulk POST
 * .../agenda/[item]/documents). Both go through createDocuments, so the
 * rules and the records are the same for one document and for several.
 */

/** A document to create under an agenda item. */
export type NewDocumentInput = Omit<DocumentCreateBody, "agendaItemId">;

/** What createDocuments returns for each document, in the order given. */
export interface CreatedDocument {
  id: string;
  slug: string;
  title: string;
  kind: DocumentKind;
  format: DocumentFormat;
  /** The item it hangs from: its automatic sub-item, when it got one. */
  agendaItemId: string;
}

interface PlannedDocument {
  input: NewDocumentInput;
  proponentMemberId: string | null;
  coProponentMemberIds: string[];
  amendable: boolean;
  voted: boolean;
  majority: Majority;
  acceptedAmendments: AcceptedAmendmentRule;
  blocks: Block[];
  contentHash: string;
  dueAt: Date | null;
}

function fail(statusCode: number, message: string, data?: unknown): never {
  throw createError({
    statusCode,
    message,
    ...(data === undefined ? {} : { data }),
  });
}

/** What every member (not a manager) needs to present a document at all. */
async function requireMemberMayCreate(
  actor: Actor,
  assembly: { id: string; status: string },
  inputs: readonly NewDocumentInput[],
): Promise<void> {
  if (inputs.some((input) => input.dueAt)) {
    fail(403, "Solo la Secretaría puede fijar la fecha límite interna");
  }
  if (!actor.can(PERMISSION_KEYS.DOCUMENT_CREATE)) {
    fail(403, "No tienes permiso para presentar documentos");
  }
  if (!actor.memberId) fail(403, UNLINKED_ACCOUNT_MESSAGE);
  if (assembly.status === "closed") fail(409, "La asamblea ya está cerrada");
  if (documentsDeadlinePassed(await loadMilestones(assembly.id))) {
    fail(409, "El plazo de presentación de documentos ha terminado");
  }
}

/** The rules of one document that need no lock: format, presenters, defaults. */
async function planDocument(
  actor: Actor,
  manager: boolean,
  input: NewDocumentInput,
): Promise<PlannedDocument> {
  // Images are stored for a document once it exists: none can come with it.
  if (input.blocks?.some((block) => block.type === "image")) {
    fail(400, "El texto incluye una imagen que no es de este documento");
  }
  const defaults = DOCUMENT_KIND_DEFAULTS[input.kind];
  const isFile = input.format === "file";
  if (isFile && input.amendable) {
    fail(422, "Un documento en PDF no puede ser enmendable");
  }
  // A type that takes amendments is presented as text: only the Secretaría
  // stores one as a PDF.
  if (
    fileFormatRefused({
      manager,
      current: null,
      next: { kind: input.kind, format: input.format },
    })
  ) {
    fail(422, FILE_FORMAT_REFUSED_MESSAGE, {
      reason: FILE_FORMAT_REFUSED_REASON,
    });
  }

  // Members always present it, alone or with co-presenters. Managers pick
  // the presenters; the main one defaults to their own member and an
  // explicit null leaves it empty (with no co-presenters).
  const presenters = planPresenters({
    manager,
    actorMemberId: actor.memberId,
    current: null,
    proponentMemberId: input.proponentMemberId,
    coProponentMemberIds: input.coProponentMemberIds,
  });
  if (typeof presenters === "string") {
    fail(422, PRESENTERS_MESSAGES[presenters]);
  }
  const { proponentMemberId, coProponentMemberIds } = presenters;
  if (proponentMemberId && proponentMemberId !== actor.memberId) {
    await requireMember(proponentMemberId);
  }
  await requireMembers(
    coProponentMemberIds.filter((id) => id !== actor.memberId),
  );
  await requirePresentersMayPresent(input.kind, [
    proponentMemberId,
    ...coProponentMemberIds,
  ]);

  const blocks = isFile ? [] : (input.blocks ?? []);
  return {
    input,
    proponentMemberId,
    coProponentMemberIds,
    amendable: isFile
      ? false
      : manager
        ? (input.amendable ?? defaults.amendable)
        : defaults.amendable,
    voted: manager ? (input.voted ?? defaults.voted) : defaults.voted,
    majority: manager
      ? (input.majority ?? defaults.majority)
      : defaults.majority,
    acceptedAmendments: manager
      ? (input.acceptedAmendments ?? defaults.acceptedAmendments)
      : defaults.acceptedAmendments,
    blocks,
    contentHash: await hashBlocks(blocks),
    dueAt: manager && input.dueAt ? new Date(input.dueAt) : null,
  };
}

/**
 * Creates the documents under one agenda item, all or none, in one
 * transaction.
 *
 * Managers (document:manage) create documents anywhere, for any members,
 * and may set an internal deadline (`dueAt`): an expected document starts
 * as an empty draft that its member fills in and presents. Members with
 * document:create present them under agenda items that accept submissions,
 * of a kind the item takes (422 `submission_kind` otherwise), until
 * documents_close, with the kind defaults, always among its presenters:
 * they may add co-presenters and name the main presenter, their own member
 * or another one (planPresenters). For everyone, no presenter may be barred
 * from the kind (a sectorial never presents an internal motion). Members
 * present the types that take amendments as text, never as a PDF
 * (fileFormatRefused).
 *
 * Under an item that accepts submissions each document gets its own
 * automatic sub-item (insertAutoItem, bindAutoItem), whoever creates it;
 * elsewhere it hangs from the item itself. Each sub-item records
 * `agenda_item_created` (`auto: true`) and each document
 * `document_created`.
 *
 * A rule one of several documents breaks answers with `data.index`, its
 * position in `inputs`.
 */
export async function createDocuments(
  ctx: {
    actor: Actor;
    assembly: { id: string; status: string };
    agendaItemId: string;
  },
  inputs: readonly NewDocumentInput[],
): Promise<CreatedDocument[]> {
  const { actor, assembly } = ctx;
  const manager = canManageDocuments(actor);
  if (!manager) await requireMemberMayCreate(actor, assembly, inputs);

  const planned: PlannedDocument[] = [];
  for (const [index, input] of inputs.entries()) {
    planned.push(
      await withIndex(inputs.length > 1 ? index : null, () =>
        planDocument(actor, manager, input),
      ),
    );
  }

  return db.transaction(async (tx) => {
    // The agenda may be written (automatic sub-items), and an agenda delete
    // must not run between reading the item and inserting under it.
    await lockAssembly(tx, assembly.id);
    const [item] = await tx
      .select()
      .from(agendaItems)
      .where(
        and(
          eq(agendaItems.id, ctx.agendaItemId),
          eq(agendaItems.assemblyId, assembly.id),
        ),
      );
    if (!item) fail(404, "Punto no encontrado");
    requireNotOthersAutoItem(item, null);
    if (!manager) {
      for (const [index, plan] of planned.entries()) {
        await withIndex(inputs.length > 1 ? index : null, () =>
          requireSubmissionTarget(item, plan.input.kind),
        );
      }
    }

    const created: CreatedDocument[] = [];
    for (const plan of planned) {
      const { input } = plan;
      const autoItem = item.acceptsSubmissions
        ? await insertAutoItem(tx, {
            assemblyId: assembly.id,
            parentId: item.id,
            title: input.title,
          })
        : null;
      const agendaItemId = autoItem?.id ?? item.id;
      const slug = await uniqueDocumentSlug(tx, assembly.id, input.title);
      const [row] = await tx
        .insert(documents)
        .values({
          assemblyId: assembly.id,
          agendaItemId,
          slug,
          kind: input.kind,
          format: input.format,
          title: input.title,
          summary: input.summary ?? null,
          status: "draft",
          proponentMemberId: plan.proponentMemberId,
          submittedByUserId: actor.user.id,
          amendable: plan.amendable,
          acceptedAmendments: plan.acceptedAmendments,
          voted: plan.voted,
          majority: plan.majority,
          dueAt: plan.dueAt,
        })
        .returning({ id: documents.id });
      if (!row) fail(500, "No se pudo crear el documento");

      await saveCoProponents(tx, row.id, plan.coProponentMemberIds);

      if (input.format !== "file") {
        const [version] = await tx
          .insert(documentVersions)
          .values({
            documentId: row.id,
            number: 1,
            kind: "draft",
            blocks: plan.blocks,
            contentHash: plan.contentHash,
            createdByUserId: actor.user.id,
          })
          .returning({ id: documentVersions.id });
        await tx
          .update(documents)
          .set({ workingVersionId: version!.id })
          .where(eq(documents.id, row.id));
      }

      if (autoItem) {
        await bindAutoItem(tx, {
          assemblyId: assembly.id,
          item: autoItem,
          documentId: row.id,
          actor,
        });
      }
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "document",
        entityId: row.id,
        documentId: row.id,
        type: "document_created",
        payload: {
          documentId: row.id,
          title: input.title,
          kind: input.kind,
          format: input.format,
          agendaItemId,
          proponentMemberId: plan.proponentMemberId,
          ...(plan.coProponentMemberIds.length > 0
            ? { coProponentMemberIds: plan.coProponentMemberIds }
            : {}),
          acceptedAmendments: plan.acceptedAmendments,
          ...(plan.dueAt ? { dueAt: plan.dueAt.toISOString() } : {}),
        },
        actor,
      });
      created.push({
        id: row.id,
        slug,
        title: input.title,
        kind: input.kind,
        format: input.format,
        agendaItemId,
      });
    }
    return created;
  });
}

/**
 * Runs a check of one of several documents: an error it answers with gains
 * `data.index`, so the client marks the row. With `index` null (a single
 * document) the error goes through untouched.
 */
async function withIndex<T>(
  index: number | null,
  check: () => T | Promise<T>,
): Promise<T> {
  try {
    return await check();
  } catch (error) {
    if (
      index === null ||
      !error ||
      typeof error !== "object" ||
      !("statusCode" in error)
    ) {
      throw error;
    }
    const failure = error as {
      statusCode: number;
      message: string;
      data?: unknown;
    };
    const data =
      failure.data && typeof failure.data === "object" ? failure.data : {};
    throw createError({
      statusCode: failure.statusCode,
      message: failure.message,
      data: { ...data, index },
    });
  }
}
