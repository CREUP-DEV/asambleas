import { createError } from "h3";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { z } from "zod/v4";
import { db } from "../../db";
import {
  agendaItems,
  controlSheetAmendments,
  controlSheetItems,
  controlSheetObservationRevisions,
  documents,
  events,
  users,
  votes,
} from "../../db/schema";
import type {
  ControlSheetAmendmentRowDto,
  ControlSheetDocumentDto,
  ControlSheetDocumentObservationsDto,
  ControlSheetDto,
  ControlSheetEditDto,
  ControlSheetHistoryDto,
  ControlSheetHistoryEntryDto,
  ControlSheetItemRowDto,
  ControlSheetPositionDto,
} from "~~/shared/types/api";
import type { ControlSheetManualResult } from "~~/shared/constants/domain";
import {
  hiddenTitleItemIds,
  visibleAgendaItems,
} from "~~/shared/utils/agendaSubmissions";
import {
  appendObservations,
  CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH,
  type controlSheetAmendmentBodySchema,
  type controlSheetItemBodySchema,
} from "~~/shared/utils/schemas/controlSheet";
import { getOptimisticLockTimestampMs } from "../optimisticLock";
import { validateCuid } from "../validation";
import {
  canEditControlSheet,
  canManageDocuments,
  canModerate,
  canViewControlSheet,
  type Actor,
} from "./actor";
import {
  loadAgendaItems,
  type AgendaItemRow,
  type AssemblyRow,
} from "./assemblies";
import {
  canSeeLoadedAmendment,
  findAmendmentsByIds,
  findPresentedAmendments,
  loadPositionRecorders,
  type LoadedAmendment,
  type PositionRecorders,
} from "./amendments";
import { titleDocumentPayload } from "./agendaWrites";
import { shareLockAssembly, type DocumentRow } from "./documents";
import { recordEvent, type Executor } from "./events";
import { impersonatedByFor, loadImpersonators } from "./impersonators";
import { withCoProponentIds } from "./presenters";
import { positionRecordedBy } from "./reviewState";
import { loadSpokenTurns } from "./speakers";
import { canSeeDocument, type DocumentPresenters } from "./visibility";
import { loadItemVoteRows, toItemVoteDto, toVoteDto } from "./votes";

/**
 * The control sheet of an assembly (hoja de control): what the Mesa, the
 * CEA and the Secretaría follow during the session and use for the minutes
 * (docs/control-sheet-plan.md). It adds to the agenda, which the client
 * already holds, only what the agenda lacks; every piece goes through the
 * visibility rules the rest of the platform uses, so two readers with
 * different rights read different sheets, and the sheet's own data (the CEA
 * position, observations, marks) never leaves it: no shared DTO carries it.
 *
 * Writes lock the assembly FOR SHARE (it waits for agenda writes), then
 * create the sheet row if it is missing and lock it (NO KEY UPDATE), then
 * check each field's own token: a field changed by someone else since it was
 * read answers 409 with the row as it is now.
 */

type ItemSheetRow = typeof controlSheetItems.$inferSelect;
type AmendmentSheetRow = typeof controlSheetAmendments.$inferSelect;
type ItemBody = z.output<typeof controlSheetItemBodySchema>;
type AmendmentBody = z.output<typeof controlSheetAmendmentBodySchema>;

/** Reason of the 409 a stale field answers (useApi's REASON_KEYS). */
export const CONTROL_SHEET_STALE_REASON = "control_sheet_stale";

function fail(statusCode: number, message: string, data?: unknown): never {
  throw createError({ statusCode, message, ...(data ? { data } : {}) });
}

export function requireControlSheetReader(actor: Actor): void {
  if (!canViewControlSheet(actor)) {
    fail(403, "No tienes permiso para ver la hoja de control");
  }
}

const userName = sql<string>`coalesce(${users.externalName}, ${users.name})`;

async function loadUserNames(
  ids: Iterable<string | null>,
  executor: Executor = db,
): Promise<Map<string, string>> {
  const list = [...new Set([...ids].filter((id): id is string => !!id))];
  if (list.length === 0) return new Map();
  const rows = await executor
    .select({ id: users.id, name: userName })
    .from(users)
    .where(inArray(users.id, list));
  return new Map(rows.map((row) => [row.id, row.name]));
}

function editOf(
  at: Date | null,
  userId: string | null,
  names: ReadonlyMap<string, string>,
): ControlSheetEditDto | null {
  if (!at) return null;
  return {
    by: userId ? (names.get(userId) ?? null) : null,
    at: at.toISOString(),
  };
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toItemRowDto(
  row: ItemSheetRow,
  names: ReadonlyMap<string, string>,
): ControlSheetItemRowDto {
  return {
    id: row.id,
    agendaItemId: row.agendaItemId,
    listed: row.listed,
    listedUpdatedAt: iso(row.listedUpdatedAt),
    manualResult: row.manualResult,
    resultUpdatedAt: iso(row.resultUpdatedAt),
    treated: editOf(row.treatedAt, row.treatedByUserId, names),
    progressUpdatedAt: iso(row.progressUpdatedAt),
    observations: row.observations,
    observationsEdited: editOf(
      row.observationsUpdatedAt,
      row.observationsUpdatedByUserId,
      names,
    ),
    observationsUpdatedAt: iso(row.observationsUpdatedAt),
  };
}

function toAmendmentRowDto(
  row: AmendmentSheetRow,
  documentId: string,
  names: ReadonlyMap<string, string>,
): ControlSheetAmendmentRowDto {
  return {
    id: row.id,
    amendmentId: row.amendmentId,
    documentId,
    treated: editOf(row.treatedAt, row.treatedByUserId, names),
    treatedUpdatedAt: iso(row.treatedUpdatedAt),
    observations: row.observations,
    observationsEdited: editOf(
      row.observationsUpdatedAt,
      row.observationsUpdatedByUserId,
      names,
    ),
    observationsUpdatedAt: iso(row.observationsUpdatedAt),
  };
}

const itemRowUsers = (row: ItemSheetRow) => [
  row.treatedByUserId,
  row.observationsUpdatedByUserId,
];
const amendmentRowUsers = (row: AmendmentSheetRow) => [
  row.treatedByUserId,
  row.observationsUpdatedByUserId,
];

/** The documents of the assembly the actor sees, with their co-presenters. */
async function loadVisibleDocuments(actor: Actor, assemblyId: string) {
  const rows = await db.query.documents
    .findMany({
      where: eq(documents.assemblyId, assemblyId),
      orderBy: (table, { asc: ascending }) => [
        ascending(table.createdAt),
        ascending(table.id),
      ],
    })
    .then((list) => withCoProponentIds(list));
  return rows.filter((row) => canSeeDocument(actor, row));
}

/**
 * The agenda items the actor gets (visibleAgendaItems), by id, and those it
 * gets without their title (hiddenTitleItemIds), as its agenda sends them:
 * what the sheet lists, the items whose votes it may read or record, and
 * the votes it reads without their question (toItemVoteDto).
 */
export async function loadReaderItems(
  actor: Actor,
  assemblyId: string,
  visibleDocuments?: Awaited<ReturnType<typeof loadVisibleDocuments>>,
): Promise<{ items: Map<string, AgendaItemRow>; titleHidden: Set<string> }> {
  const [items, seen] = await Promise.all([
    loadAgendaItems(assemblyId),
    visibleDocuments ?? loadVisibleDocuments(actor, assemblyId),
  ]);
  const seesWithheld = canManageDocuments(actor);
  const visible = visibleAgendaItems(items, seen, seesWithheld);
  return {
    items: new Map(visible.map((item) => [item.id, item])),
    titleHidden: hiddenTitleItemIds(visible, seen, seesWithheld),
  };
}

/**
 * The agenda items the actor gets (visibleAgendaItems), by id: what the
 * sheet lists, and the items whose votes it may read or record.
 */
export async function loadVisibleItems(
  actor: Actor,
  assemblyId: string,
  visibleDocuments?: Awaited<ReturnType<typeof loadVisibleDocuments>>,
): Promise<Map<string, AgendaItemRow>> {
  return (await loadReaderItems(actor, assemblyId, visibleDocuments)).items;
}

/** When the assembly first went into session (its status event), or null. */
async function loadSessionStartedAt(assemblyId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.assemblyId, assemblyId),
        eq(events.type, "assembly_status_changed"),
        sql`${events.payload}->>'to' = 'in_session'`,
      ),
    )
    .orderBy(asc(events.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/**
 * The amendments among `rows` the actor sees (canSeeLoadedAmendment, with
 * the presenters of their document), dropping those of a document it does
 * not see (absent from `documentById`).
 */
export function visibleSheetAmendments(
  actor: Actor,
  rows: readonly LoadedAmendment[],
  documentById: ReadonlyMap<string, DocumentPresenters>,
): LoadedAmendment[] {
  return rows.filter((row) => {
    const document = documentById.get(row.documentId);
    return !!document && canSeeLoadedAmendment(actor, row, document);
  });
}

/**
 * The main presenter's answer to each of `rows` that has one
 * (ControlSheetDto.positions), mapped as AmendmentDto.position is
 * (positionRecordedBy against the document's current main presenter).
 * `rows` are only amendments the reader sees (visibleSheetAmendments): the
 * sheet gives their answer to every one of its readers as soon as it is
 * given, whatever canSeePositions says, which still rules
 * AmendmentDto.position everywhere else. PositionDto carries no member
 * (recordedBy says only "presenter" or "mesa"; the comment is the
 * presenter's own text), so there is nothing to redact.
 */
export function sheetPositions(
  rows: readonly LoadedAmendment[],
  documentById: ReadonlyMap<
    string,
    Pick<DocumentPresenters, "proponentMemberId">
  >,
  recorders: PositionRecorders,
): ControlSheetPositionDto[] {
  const result: ControlSheetPositionDto[] = [];
  for (const row of rows) {
    const document = documentById.get(row.documentId);
    if (!row.position || !document) continue;
    const decidedBy = row.position.decidedByUserId;
    result.push({
      amendmentId: row.id,
      position: {
        position: row.position.position,
        comment: row.position.comment,
        recordedBy: positionRecordedBy({
          decidedByUserId: decidedBy,
          recordedAs: recorders.recordedAs.get(row.id),
          recorderMemberId: decidedBy
            ? recorders.memberOf.get(decidedBy)
            : null,
          mainPresenterId: document.proponentMemberId,
        }),
        updatedAt: row.position.updatedAt.toISOString(),
      },
    });
  }
  return result;
}

export async function loadControlSheet(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<ControlSheetDto> {
  requireControlSheetReader(actor);

  const [visibleDocuments, sessionStartedAt] = await Promise.all([
    loadVisibleDocuments(actor, assembly.id),
    loadSessionStartedAt(assembly.id),
  ]);
  const finalVoteIds = visibleDocuments
    .map((row) => row.finalVoteId)
    .filter((id): id is string => id !== null);

  const [
    readerItems,
    amendmentRows,
    finalVoteRows,
    turns,
    itemSheet,
    itemVoteRows,
  ] = await Promise.all([
    loadReaderItems(actor, assembly.id, visibleDocuments),
    findPresentedAmendments(visibleDocuments.map((row) => row.id)),
    finalVoteIds.length > 0
      ? db.select().from(votes).where(inArray(votes.id, finalVoteIds))
      : Promise.resolve([]),
    loadSpokenTurns(actor, assembly.id),
    db
      .select()
      .from(controlSheetItems)
      .where(eq(controlSheetItems.assemblyId, assembly.id)),
    loadItemVoteRows(assembly.id),
  ]);

  const itemsById = readerItems.items;
  const documentById = new Map(visibleDocuments.map((row) => [row.id, row]));
  const counts = new Map<string, { amendments: number; undecided: number }>();
  const visibleAmendments = new Map<string, string>();
  const visibleRows = visibleSheetAmendments(
    actor,
    amendmentRows,
    documentById,
  );
  for (const row of visibleRows) {
    visibleAmendments.set(row.id, row.documentId);
    const count = counts.get(row.documentId) ?? { amendments: 0, undecided: 0 };
    count.amendments += 1;
    if (row.status === "submitted") count.undecided += 1;
    counts.set(row.documentId, count);
  }
  const voteById = new Map(finalVoteRows.map((row) => [row.id, row]));

  const documentDtos: ControlSheetDocumentDto[] = visibleDocuments.map(
    (row) => {
      const vote = row.finalVoteId ? voteById.get(row.finalVoteId) : undefined;
      const count = counts.get(row.id);
      return {
        id: row.id,
        finalVote: vote ? toVoteDto(vote) : null,
        amendments: count?.amendments ?? 0,
        undecided: count?.undecided ?? 0,
      };
    },
  );

  const [amendmentSheet, recorders] = await Promise.all([
    visibleAmendments.size > 0
      ? db
          .select()
          .from(controlSheetAmendments)
          .where(
            inArray(controlSheetAmendments.amendmentId, [
              ...visibleAmendments.keys(),
            ]),
          )
      : Promise.resolve([]),
    loadPositionRecorders(visibleRows),
  ]);
  // Rows of items the reader does not get stay out, as the items do.
  const itemRows = itemSheet.filter((row) => itemsById.has(row.agendaItemId));
  const names = await loadUserNames([
    ...itemRows.flatMap(itemRowUsers),
    ...amendmentSheet.flatMap(amendmentRowUsers),
  ]);

  return {
    sessionStartedAt: sessionStartedAt?.toISOString() ?? null,
    documents: documentDtos,
    turns: turns.filter(
      (turn) => turn.agendaItemId === null || itemsById.has(turn.agendaItemId),
    ),
    itemRows: itemRows.map((row) => toItemRowDto(row, names)),
    amendmentRows: amendmentSheet.map((row) =>
      toAmendmentRowDto(row, visibleAmendments.get(row.amendmentId)!, names),
    ),
    positions: sheetPositions(visibleRows, documentById, recorders),
    // Votes of items the reader does not get stay out, as the items do, and
    // those it gets without their title come without their question.
    itemVotes: itemVoteRows
      .filter((row) => itemsById.has(row.subjectId))
      .map((row) => toItemVoteDto(row, readerItems.titleHidden)),
    can: { edit: canEditControlSheet(actor), moderate: canModerate(actor) },
  };
}

/**
 * The sheet's observations about one document, for its page (user's
 * decision of 2026-11-17: whoever reads the sheet reads them there too):
 * those of its agenda item, when the reader gets that item, and those of
 * each of its amendments the reader sees (visibleSheetAmendments). Only
 * rows with something written. Same reader and visibility rules as
 * loadControlSheet; the caller resolved the document for the actor.
 */
export async function loadDocumentSheetObservations(
  actor: Actor,
  assembly: AssemblyRow,
  document: DocumentRow & DocumentPresenters,
): Promise<ControlSheetDocumentObservationsDto> {
  requireControlSheetReader(actor);
  const [items, amendmentRows] = await Promise.all([
    loadVisibleItems(actor, assembly.id),
    findPresentedAmendments([document.id]),
  ]);
  const visible = visibleSheetAmendments(
    actor,
    amendmentRows,
    new Map([[document.id, document]]),
  );
  const itemId =
    document.agendaItemId && items.has(document.agendaItemId)
      ? document.agendaItemId
      : null;
  const [itemRows, amendmentSheet] = await Promise.all([
    itemId
      ? db
          .select()
          .from(controlSheetItems)
          .where(eq(controlSheetItems.agendaItemId, itemId))
      : Promise.resolve([]),
    visible.length > 0
      ? db
          .select()
          .from(controlSheetAmendments)
          .where(
            inArray(
              controlSheetAmendments.amendmentId,
              visible.map((row) => row.id),
            ),
          )
      : Promise.resolve([]),
  ]);
  const itemRow = itemRows.find((row) => row.observations.trim() !== "");
  const codeOf = new Map(visible.map((row) => [row.id, row.code]));
  const order = new Map(
    [...visible]
      .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
      .map((row, index) => [row.id, index]),
  );
  const written = amendmentSheet
    .filter((row) => row.observations.trim() !== "")
    .sort(
      (a, b) =>
        (order.get(a.amendmentId) ?? 0) - (order.get(b.amendmentId) ?? 0),
    );
  const names = await loadUserNames([
    itemRow?.observationsUpdatedByUserId ?? null,
    ...written.map((row) => row.observationsUpdatedByUserId),
  ]);
  return {
    item: itemRow
      ? {
          text: itemRow.observations,
          edited: editOf(
            itemRow.observationsUpdatedAt,
            itemRow.observationsUpdatedByUserId,
            names,
          ),
        }
      : null,
    amendments: written.map((row) => ({
      amendmentId: row.amendmentId,
      code: codeOf.get(row.amendmentId) ?? null,
      text: row.observations,
      edited: editOf(
        row.observationsUpdatedAt,
        row.observationsUpdatedByUserId,
        names,
      ),
    })),
  };
}

// Subjects ----------------------------------------------------------------

/** An agenda item of the assembly the actor gets, or 404. */
export async function resolveSheetItem(
  actor: Actor,
  assembly: AssemblyRow,
  param: string | undefined,
): Promise<AgendaItemRow> {
  const id = validateCuid(param, "Punto");
  const item = (await loadVisibleItems(actor, assembly.id)).get(id);
  if (!item) fail(404, "Punto no encontrado");
  return item;
}

/** An amendment past draft of the assembly the actor sees, or 404. */
export async function resolveSheetAmendment(
  actor: Actor,
  assembly: AssemblyRow,
  param: string | undefined,
): Promise<{ id: string; documentId: string }> {
  const id = validateCuid(param, "Enmienda");
  const [row] = await findAmendmentsByIds([id]);
  if (!row || row.status === "draft") fail(404, "Enmienda no encontrada");
  const [document] = await db.query.documents
    .findMany({
      where: and(
        eq(documents.id, row.documentId),
        eq(documents.assemblyId, assembly.id),
      ),
    })
    .then((list) => withCoProponentIds(list));
  if (
    !document ||
    !canSeeDocument(actor, document) ||
    !canSeeLoadedAmendment(actor, row, document)
  ) {
    fail(404, "Enmienda no encontrada");
  }
  return { id: row.id, documentId: row.documentId };
}

// Writes ------------------------------------------------------------------

function sameToken(stored: Date | null, sent: string | null): boolean {
  return (
    getOptimisticLockTimestampMs(stored) === getOptimisticLockTimestampMs(sent)
  );
}

function requireEdit(actor: Actor): void {
  if (!canEditControlSheet(actor)) {
    fail(403, "No tienes permiso para editar la hoja de control");
  }
}

function requireModerate(actor: Actor): void {
  if (!canModerate(actor)) {
    fail(403, "Solo la Mesa marca lo que se ha tratado");
  }
}

async function insertRevision(
  tx: Executor,
  actor: Actor,
  assemblyId: string,
  row: { itemRowId: string } | { amendmentRowId: string },
  text: string,
): Promise<string> {
  const [revision] = await tx
    .insert(controlSheetObservationRevisions)
    .values({
      assemblyId,
      ...row,
      text,
      authorUserId: actor.user.id,
      impersonationId: actor.impersonation?.id ?? null,
    })
    .returning({ id: controlSheetObservationRevisions.id });
  return revision!.id;
}

interface SheetEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** Reason of the 422 an addition to observations already near full gets. */
export const CONTROL_SHEET_OBSERVATIONS_TOO_LONG_REASON =
  "control_sheet_observations_too_long";

/** Reason of the 422 a «Retirado» by hand gets on an item with documents. */
export const CONTROL_SHEET_WITHDRAWN_REASON =
  "control_sheet_withdrawn_document";

/**
 * Changes what the sheet notes about an agenda item. Observations and
 * `listed` are the sheet's editors'; the result by hand and `treated` the
 * Mesa's, since a «Retirado» or «Decaído» counts as treated. A «Retirado» by
 * hand is only for an item without documents: a document is withdrawn for
 * real. Every field changed records its own event (entity `control_sheet`,
 * the row's id), never the observations' text.
 */
export async function updateSheetItem(
  actor: Actor,
  assembly: AssemblyRow,
  item: AgendaItemRow,
  body: ItemBody,
): Promise<ControlSheetItemRowDto> {
  if (body.observations || body.listed) requireEdit(actor);
  if (body.result || body.treated) requireModerate(actor);

  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const [present] = await tx
      .select({ id: agendaItems.id })
      .from(agendaItems)
      .where(
        and(
          eq(agendaItems.id, item.id),
          eq(agendaItems.assemblyId, assembly.id),
        ),
      );
    if (!present) fail(404, "Punto no encontrado");
    if (body.result?.value === "withdrawn") {
      const [held] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.agendaItemId, item.id),
            ne(documents.status, "draft"),
          ),
        )
        .limit(1);
      if (held) {
        fail(422, "Para retirar un documento, cambia su estado", {
          reason: CONTROL_SHEET_WITHDRAWN_REASON,
        });
      }
    }
    await tx
      .insert(controlSheetItems)
      .values({ assemblyId: assembly.id, agendaItemId: item.id })
      .onConflictDoNothing({ target: controlSheetItems.agendaItemId });
    const [row] = await tx
      .select()
      .from(controlSheetItems)
      .where(eq(controlSheetItems.agendaItemId, item.id))
      .for("no key update");
    if (!row) fail(404, "Punto no encontrado");

    const stale: string[] = [];
    if (
      body.observations &&
      !sameToken(row.observationsUpdatedAt, body.observations.updatedAt)
    ) {
      stale.push("observations");
    }
    if (body.listed && !sameToken(row.listedUpdatedAt, body.listed.updatedAt)) {
      stale.push("listed");
    }
    if (body.result && !sameToken(row.resultUpdatedAt, body.result.updatedAt)) {
      stale.push("result");
    }
    if (
      body.treated &&
      !sameToken(row.progressUpdatedAt, body.treated.updatedAt)
    ) {
      stale.push("treated");
    }
    if (stale.length > 0) {
      const names = await loadUserNames(itemRowUsers(row), tx);
      fail(
        409,
        "Alguien ha cambiado este punto de la hoja mientras lo editabas",
        {
          reason: CONTROL_SHEET_STALE_REASON,
          fields: stale,
          row: toItemRowDto(row, names),
        },
      );
    }

    const now = new Date();
    const set: Partial<typeof controlSheetItems.$inferInsert> = {};
    const changes: SheetEvent[] = [];
    if (body.observations && body.observations.value !== row.observations) {
      const text = body.observations.value;
      set.observations = text;
      set.observationsUpdatedAt = now;
      set.observationsUpdatedByUserId = actor.user.id;
      const revisionId = await insertRevision(
        tx,
        actor,
        assembly.id,
        { itemRowId: row.id },
        text,
      );
      changes.push({
        type: "control_sheet_observations_updated",
        payload: { revisionId, cleared: text === "" },
      });
    }
    if (body.listed && body.listed.value !== row.listed) {
      set.listed = body.listed.value;
      set.listedUpdatedAt = now;
      changes.push({
        type: "control_sheet_listed_changed",
        payload: { listed: body.listed.value },
      });
    }
    if (body.result && body.result.value !== row.manualResult) {
      set.manualResult = body.result.value;
      set.resultUpdatedAt = now;
      changes.push({
        type: "control_sheet_result_changed",
        payload: {
          changes: {
            result: { from: row.manualResult, to: body.result.value },
          },
        },
      });
    }
    if (body.treated && body.treated.value !== (row.treatedAt !== null)) {
      set.treatedAt = body.treated.value ? now : null;
      set.treatedByUserId = body.treated.value ? actor.user.id : null;
      set.progressUpdatedAt = now;
      changes.push({
        type: "control_sheet_treated_changed",
        payload: { treated: body.treated.value },
      });
    }

    let current = row;
    if (changes.length > 0) {
      const [updated] = await tx
        .update(controlSheetItems)
        .set(set)
        .where(eq(controlSheetItems.id, row.id))
        .returning();
      current = updated!;
      for (const change of changes) {
        await recordEvent(tx, {
          assemblyId: assembly.id,
          entityType: "control_sheet",
          entityId: row.id,
          type: change.type,
          payload: {
            subjectType: "agenda_item",
            subjectId: item.id,
            ...titleDocumentPayload(item),
            ...change.payload,
          },
          actor,
        });
      }
    }
    const names = await loadUserNames(itemRowUsers(current), tx);
    return toItemRowDto(current, names);
  });
}

/**
 * Changes what the sheet notes about an amendment: the observations (the
 * sheet's editors) and the treated mark (the Mesa), as updateSheetItem.
 * `observationsAppend` adds a text after the observations, whatever they
 * are now (a note an editor sends from the amendment, which never sees the
 * sheet's lock token): nothing is replaced, so it takes no token, and the
 * earlier text stays in the row's history. 422 when the result would be
 * longer than CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH.
 */
export async function updateSheetAmendment(
  actor: Actor,
  assembly: AssemblyRow,
  amendment: { id: string; documentId: string },
  body: AmendmentBody,
): Promise<ControlSheetAmendmentRowDto> {
  if (body.observations || body.observationsAppend) requireEdit(actor);
  if (body.treated) requireModerate(actor);

  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    await tx
      .insert(controlSheetAmendments)
      .values({ assemblyId: assembly.id, amendmentId: amendment.id })
      .onConflictDoNothing({ target: controlSheetAmendments.amendmentId });
    const [row] = await tx
      .select()
      .from(controlSheetAmendments)
      .where(eq(controlSheetAmendments.amendmentId, amendment.id))
      .for("no key update");
    if (!row) fail(404, "Enmienda no encontrada");

    const stale: string[] = [];
    if (
      body.observations &&
      !sameToken(row.observationsUpdatedAt, body.observations.updatedAt)
    ) {
      stale.push("observations");
    }
    if (
      body.treated &&
      !sameToken(row.treatedUpdatedAt, body.treated.updatedAt)
    ) {
      stale.push("treated");
    }
    if (stale.length > 0) {
      const names = await loadUserNames(amendmentRowUsers(row), tx);
      fail(
        409,
        "Alguien ha cambiado esta enmienda de la hoja mientras la editabas",
        {
          reason: CONTROL_SHEET_STALE_REASON,
          fields: stale,
          row: toAmendmentRowDto(row, amendment.documentId, names),
        },
      );
    }

    const now = new Date();
    const set: Partial<typeof controlSheetAmendments.$inferInsert> = {};
    const changes: SheetEvent[] = [];
    const observationsText = body.observationsAppend
      ? appendObservations(row.observations, body.observationsAppend)
      : body.observations?.value;
    if (
      observationsText !== undefined &&
      observationsText.length > CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH
    ) {
      fail(
        422,
        "Las observaciones de esta enmienda en la hoja ya son demasiado largas para añadir este texto",
        { reason: CONTROL_SHEET_OBSERVATIONS_TOO_LONG_REASON },
      );
    }
    if (
      observationsText !== undefined &&
      observationsText !== row.observations
    ) {
      const text = observationsText;
      set.observations = text;
      set.observationsUpdatedAt = now;
      set.observationsUpdatedByUserId = actor.user.id;
      const revisionId = await insertRevision(
        tx,
        actor,
        assembly.id,
        { amendmentRowId: row.id },
        text,
      );
      changes.push({
        type: "control_sheet_observations_updated",
        payload: { revisionId, cleared: text === "" },
      });
    }
    if (body.treated && body.treated.value !== (row.treatedAt !== null)) {
      set.treatedAt = body.treated.value ? now : null;
      set.treatedByUserId = body.treated.value ? actor.user.id : null;
      set.treatedUpdatedAt = now;
      changes.push({
        type: "control_sheet_treated_changed",
        payload: { treated: body.treated.value },
      });
    }

    let current = row;
    if (changes.length > 0) {
      const [updated] = await tx
        .update(controlSheetAmendments)
        .set(set)
        .where(eq(controlSheetAmendments.id, row.id))
        .returning();
      current = updated!;
      for (const change of changes) {
        await recordEvent(tx, {
          assemblyId: assembly.id,
          entityType: "control_sheet",
          entityId: row.id,
          type: change.type,
          payload: {
            subjectType: "amendment",
            subjectId: amendment.id,
            ...change.payload,
          },
          actor,
        });
      }
    }
    const names = await loadUserNames(amendmentRowUsers(current), tx);
    return toAmendmentRowDto(current, amendment.documentId, names);
  });
}

// History ---------------------------------------------------------------

const asResult = (value: unknown): ControlSheetManualResult | null =>
  typeof value === "string" ? (value as ControlSheetManualResult) : null;

/**
 * The history of one sheet row: every change, newest first, with who made
 * it and, for observations, the text saved. The row's item or amendment
 * must be one the actor reads.
 */
export async function loadSheetHistory(
  actor: Actor,
  assembly: AssemblyRow,
  rowId: string,
): Promise<ControlSheetHistoryDto> {
  requireControlSheetReader(actor);
  const [itemRow] = await db
    .select({ agendaItemId: controlSheetItems.agendaItemId })
    .from(controlSheetItems)
    .where(
      and(
        eq(controlSheetItems.id, rowId),
        eq(controlSheetItems.assemblyId, assembly.id),
      ),
    );
  const isItemRow = Boolean(itemRow);
  if (itemRow) {
    await resolveSheetItem(actor, assembly, itemRow.agendaItemId);
  } else {
    const [amendmentRow] = await db
      .select({ amendmentId: controlSheetAmendments.amendmentId })
      .from(controlSheetAmendments)
      .where(
        and(
          eq(controlSheetAmendments.id, rowId),
          eq(controlSheetAmendments.assemblyId, assembly.id),
        ),
      );
    if (!amendmentRow) fail(404, "No hay historial de esta fila");
    await resolveSheetAmendment(actor, assembly, amendmentRow.amendmentId);
  }

  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      payload: events.payload,
      createdAt: events.createdAt,
      actorUserId: events.actorUserId,
      impersonationId: events.impersonationId,
      actorName: userName,
    })
    .from(events)
    .leftJoin(users, eq(users.id, events.actorUserId))
    .where(
      and(
        eq(events.assemblyId, assembly.id),
        eq(events.entityType, "control_sheet"),
        eq(events.entityId, rowId),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(200);

  const revisionIds = rows
    .map((row) => row.payload.revisionId)
    .filter((id): id is string => typeof id === "string");
  const revisions =
    revisionIds.length > 0
      ? await db
          .select({
            id: controlSheetObservationRevisions.id,
            text: controlSheetObservationRevisions.text,
          })
          .from(controlSheetObservationRevisions)
          .where(
            and(
              isItemRow
                ? eq(controlSheetObservationRevisions.itemRowId, rowId)
                : eq(controlSheetObservationRevisions.amendmentRowId, rowId),
              inArray(controlSheetObservationRevisions.id, revisionIds),
            ),
          )
      : [];
  const textById = new Map(revisions.map((row) => [row.id, row.text]));
  const impersonators = await loadImpersonators(
    rows.map((row) => row.impersonationId),
  );

  const entries = rows.map((row): ControlSheetHistoryEntryDto => {
    const payload = row.payload;
    const changes = (payload.changes ?? {}) as Record<
      string,
      { from?: unknown; to?: unknown }
    >;
    const entry: ControlSheetHistoryEntryDto = {
      id: row.id,
      type: row.type,
      at: row.createdAt.toISOString(),
      actorName: row.actorName ?? null,
      impersonatedBy: impersonatedByFor(actor, row, impersonators),
    };
    if (typeof payload.revisionId === "string") {
      entry.text = textById.get(payload.revisionId) ?? "";
    }
    if (changes.result) {
      entry.result = {
        from: asResult(changes.result.from),
        to: asResult(changes.result.to),
      };
    }
    if (typeof payload.listed === "boolean") entry.listed = payload.listed;
    if (typeof payload.treated === "boolean") entry.treated = payload.treated;
    return entry;
  });
  return { entries };
}
