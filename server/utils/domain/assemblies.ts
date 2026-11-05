import type { H3Event } from "h3";
import { createError, getQuery, readBody } from "h3";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { z } from "zod/v4";
import { db } from "../../db";
import {
  agendaItems,
  amendments,
  assemblies,
  assemblyMilestones,
  decisions,
  documents,
  liveState,
  votes,
} from "../../db/schema";
import { isUniqueConstraintViolation, throwMutationError } from "../errors";
import { recordEvent, type LiveMessage } from "./events";
import {
  canManageAssemblies,
  canManageDocuments,
  canModerate,
  type Actor,
} from "./actor";
import {
  assemblySettings,
  loadDocumentSummaries,
  toVoteDto,
} from "./documents";
import { coPresentedBy } from "./presenters";
import {
  MILESTONE_KEYS,
  type AssemblyStatus,
} from "~~/shared/constants/domain";
import type { AssemblyType } from "~~/shared/constants/assemblyTypes";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AgendaDto,
  AgendaItemDto,
  AssemblyCapabilities,
  AssemblyDto,
  AssemblyListDto,
  AssemblySummaryDto,
  DecisionDto,
  LiveEventDto,
  LiveStateBody,
  LiveStateDto,
  MilestoneDto,
} from "~~/shared/types/api";
import { checkCalendar, type Milestones } from "~~/shared/utils/calendar";
import { ASSEMBLY_LIST_PAGE_SIZE } from "~~/shared/utils/schemas/assembly";
import { buildAssemblySlug, formatAssemblyLabel } from "~~/shared/utils/slug";

/**
 * Assembly, calendar, agenda, decisions and live-state helpers shared by the
 * handlers under server/api/assemblies (docs/api.md). Handlers stay small:
 * permission check, route resolution, body validation, then one call here.
 */

export type AssemblyRow = typeof assemblies.$inferSelect;
export type AgendaItemRow = typeof agendaItems.$inferSelect;
export type Executor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Document statuses that keep an agenda item from being deleted. A document
 * whose text is frozen (see isTextFrozen) also keeps it, whatever its status.
 */
export const AGENDA_PROTECTED_DOCUMENT_STATUSES = [
  "submitted",
  "published",
  "postponed",
] as const;

const VISIBLE_DOCUMENT_STATUSES = ["published", "postponed"] as const;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function fail(statusCode: number, message: string, data?: unknown): never {
  throw createError({ statusCode, message, ...(data ? { data } : {}) });
}

// Request parsing -------------------------------------------------------------

/** Reads and validates a JSON body, answering 400 with the issues on failure. */
export async function readAssemblyBody<S extends z.ZodType>(
  event: H3Event,
  schema: S,
): Promise<z.output<S>> {
  const parsed = schema.safeParse(await readBody(event));
  if (!parsed.success) {
    fail(400, "Datos no válidos", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** Validates the query string, answering 400 on failure. */
export function readAssemblyQuery<S extends z.ZodType>(
  event: H3Event,
  schema: S,
): z.output<S> {
  const parsed = schema.safeParse(getQuery(event));
  if (!parsed.success) fail(400, "Parámetros no válidos");
  return parsed.data;
}

/**
 * Like throwMutationError, but a unique violation gets a specific message:
 * `uniqueMessage` describes the only unique index the write can hit.
 */
export function throwAssemblyMutationError(
  scope: string,
  error: unknown,
  event: H3Event,
  uniqueMessage = "Ya existe una asamblea de ese tipo con ese número",
): never {
  if (error && typeof error === "object" && "statusCode" in error) throw error;
  if (isUniqueConstraintViolation(error)) fail(409, uniqueMessage);
  throwMutationError(scope, error, event);
}

/**
 * Serializes concurrent writes on the same assembly (agenda, calendar, live
 * state). The lock is the first one its transaction takes; the order and
 * strengths every transaction follows are under "Row locks" in documents.ts
 * (shareLockAssembly). NO KEY UPDATE conflicts with itself and with the share
 * lock of the vote, projection and document move paths (so an agenda delete
 * and a document moving into its items serialize), but not with the FOR KEY
 * SHARE that every event, vote or document insert takes on the assembly, so
 * those never wait here. None of the callers deletes the row or changes its key (id,
 * type, number).
 */
export async function lockAssembly(
  tx: Executor,
  assemblyId: string,
): Promise<AssemblyRow> {
  const [row] = await tx
    .select()
    .from(assemblies)
    .where(eq(assemblies.id, assemblyId))
    .for("no key update");
  if (!row) fail(404, "Asamblea no encontrada");
  return row;
}

export async function findAssemblyByTypeNumber(
  type: AssemblyType,
  number: number,
  executor: Executor = db,
  excludeId?: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ id: assemblies.id })
    .from(assemblies)
    .where(
      and(
        eq(assemblies.type, type),
        eq(assemblies.number, number),
        excludeId ? ne(assemblies.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

// Capabilities and visibility ---------------------------------------------------

export function assemblyCapabilities(actor: Actor): AssemblyCapabilities {
  return {
    manage: canManageAssemblies(actor),
    moderate: canModerate(actor),
    createDocuments:
      actor.can(PERMISSION_KEYS.DOCUMENT_CREATE) || canManageDocuments(actor),
  };
}

/** Same rule as canSeeAssembly: drafts only for managers and the Mesa. */
export function canSeeDraftAssemblies(actor: Actor): boolean {
  return canManageAssemblies(actor) || canModerate(actor);
}

/**
 * SQL mirror of canSeeDocument, used to count the documents of several
 * assemblies at once: the Mesa sees every presented document, not drafts.
 * Undefined means every document is visible.
 */
export function visibleDocumentsCondition(actor: Actor): SQL | undefined {
  if (canManageDocuments(actor)) return undefined;
  return or(
    inArray(documents.status, [...VISIBLE_DOCUMENT_STATUSES]),
    canModerate(actor) ? ne(documents.status, "draft") : undefined,
    eq(documents.submittedByUserId, actor.user.id),
    actor.memberId
      ? eq(documents.proponentMemberId, actor.memberId)
      : undefined,
    actor.memberId ? coPresentedBy(actor.memberId) : undefined,
  );
}

export async function countVisibleDocuments(
  actor: Actor,
  assemblyIds: string[],
  executor: Executor = db,
): Promise<Map<string, number>> {
  if (assemblyIds.length === 0) return new Map();
  const rows = await executor
    .select({ assemblyId: documents.assemblyId, total: count() })
    .from(documents)
    .where(
      and(
        inArray(documents.assemblyId, assemblyIds),
        visibleDocumentsCondition(actor),
      ),
    )
    .groupBy(documents.assemblyId);
  return new Map(rows.map((row) => [row.assemblyId, Number(row.total)]));
}

// Milestones --------------------------------------------------------------------

const MILESTONE_RANK = new Map(
  MILESTONE_KEYS.map((key, index) => [key, index]),
);

function compareMilestones(a: MilestoneDto, b: MilestoneDto): number {
  return (
    a.at.localeCompare(b.at) ||
    (MILESTONE_RANK.get(a.key) ?? 0) - (MILESTONE_RANK.get(b.key) ?? 0)
  );
}

/** Milestones of several assemblies, each list sorted by date. */
export async function loadMilestoneDtos(
  assemblyIds: string[],
  executor: Executor = db,
): Promise<Map<string, MilestoneDto[]>> {
  const result = new Map<string, MilestoneDto[]>(
    assemblyIds.map((id) => [id, []]),
  );
  if (assemblyIds.length === 0) return result;
  const rows = await executor
    .select({
      assemblyId: assemblyMilestones.assemblyId,
      key: assemblyMilestones.key,
      at: assemblyMilestones.at,
      note: assemblyMilestones.note,
    })
    .from(assemblyMilestones)
    .where(inArray(assemblyMilestones.assemblyId, assemblyIds));
  for (const row of rows) {
    result
      .get(row.assemblyId)
      ?.push({ key: row.key, at: row.at.toISOString(), note: row.note });
  }
  for (const list of result.values()) list.sort(compareMilestones);
  return result;
}

export function milestonesToMap(list: MilestoneDto[]): Milestones {
  const map: Milestones = {};
  for (const milestone of list) map[milestone.key] = new Date(milestone.at);
  return map;
}

/** The first milestone still to come, for countdowns. Expects a sorted list. */
export function nextMilestone(
  list: MilestoneDto[],
  now = new Date(),
): MilestoneDto | null {
  const time = now.getTime();
  return (
    list.find((milestone) => new Date(milestone.at).getTime() > time) ?? null
  );
}

/** Inserts the default calendar of a new assembly. */
export async function insertMilestones(
  executor: Executor,
  assemblyId: string,
  milestones: Milestones,
): Promise<void> {
  const values = MILESTONE_KEYS.flatMap((key) => {
    const at = milestones[key];
    return at ? [{ assemblyId, key, at }] : [];
  });
  if (values.length > 0)
    await executor.insert(assemblyMilestones).values(values);
}

// Assembly DTOs -----------------------------------------------------------------

export function toAssemblySummaryDto(
  row: AssemblyRow,
  extra: { documentCount: number; milestones: MilestoneDto[]; now?: Date },
): AssemblySummaryDto {
  return {
    id: row.id,
    slug: buildAssemblySlug(row),
    label: formatAssemblyLabel(row),
    number: row.number,
    type: row.type,
    status: row.status,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate.toISOString(),
    location: row.location,
    agendaFinalizedAt: iso(row.agendaFinalizedAt),
    documentCount: extra.documentCount,
    nextMilestone: nextMilestone(extra.milestones, extra.now),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAssemblyDto(
  actor: Actor,
  row: AssemblyRow,
  extra: { documentCount: number; milestones: MilestoneDto[]; now?: Date },
): AssemblyDto {
  return {
    ...toAssemblySummaryDto(row, extra),
    convocationIntro: row.convocationIntro,
    settings: assemblySettings(row),
    milestones: extra.milestones,
    calendarWarnings: checkCalendar(
      row.type,
      row.startDate,
      milestonesToMap(extra.milestones),
    ),
    can: assemblyCapabilities(actor),
  };
}

/**
 * Builds the DTO of an assembly. Pass the id to reload the row (after a
 * write), or the row itself when it is fresh.
 */
export async function loadAssemblyDto(
  actor: Actor,
  assembly: AssemblyRow | string,
  executor: Executor = db,
): Promise<AssemblyDto> {
  const row =
    typeof assembly === "string"
      ? (
          await executor
            .select()
            .from(assemblies)
            .where(eq(assemblies.id, assembly))
        )[0]
      : assembly;
  if (!row) fail(404, "Asamblea no encontrada");
  const [milestones, counts] = await Promise.all([
    loadMilestoneDtos([row.id], executor),
    countVisibleDocuments(actor, [row.id], executor),
  ]);
  return toAssemblyDto(actor, row, {
    documentCount: counts.get(row.id) ?? 0,
    milestones: milestones.get(row.id) ?? [],
  });
}

export async function listAssemblies(
  actor: Actor,
  query: { status?: AssemblyStatus; type?: AssemblyType; page: number },
): Promise<AssemblyListDto> {
  const pageSize = ASSEMBLY_LIST_PAGE_SIZE;
  const where = and(
    query.status ? eq(assemblies.status, query.status) : undefined,
    query.type ? eq(assemblies.type, query.type) : undefined,
    canSeeDraftAssemblies(actor) ? undefined : ne(assemblies.status, "draft"),
  );

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(assemblies)
      .where(where)
      .orderBy(
        desc(assemblies.startDate),
        desc(assemblies.number),
        asc(assemblies.id),
      )
      .limit(pageSize)
      .offset((query.page - 1) * pageSize),
    db.select({ total: count() }).from(assemblies).where(where),
  ]);

  const ids = rows.map((row) => row.id);
  const [milestones, counts] = await Promise.all([
    loadMilestoneDtos(ids),
    countVisibleDocuments(actor, ids),
  ]);
  const now = new Date();

  return {
    items: rows.map((row) =>
      toAssemblySummaryDto(row, {
        documentCount: counts.get(row.id) ?? 0,
        milestones: milestones.get(row.id) ?? [],
        now,
      }),
    ),
    page: query.page,
    pageSize,
    total: Number(totalRow?.total ?? 0),
  };
}

/** Validates a date range where either end may come from the stored row. */
export function assertDateRange(start: Date, end: Date): void {
  if (end.getTime() < start.getTime()) {
    fail(422, "La fecha de fin no puede ser anterior a la de inicio");
  }
}

// Agenda ------------------------------------------------------------------------

export function toAgendaItemDto(row: AgendaItemRow): AgendaItemDto {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    description: row.description,
    order: row.order,
    acceptsSubmissions: row.acceptsSubmissions,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every item of the assembly, flat, in display order within each parent. */
export function loadAgendaItems(
  assemblyId: string,
  executor: Executor = db,
): Promise<AgendaItemRow[]> {
  return executor
    .select()
    .from(agendaItems)
    .where(eq(agendaItems.assemblyId, assemblyId))
    .orderBy(
      asc(agendaItems.order),
      asc(agendaItems.createdAt),
      asc(agendaItems.id),
    );
}

export async function loadAgendaDto(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<AgendaDto> {
  const [items, documentSummaries] = await Promise.all([
    loadAgendaItems(assembly.id),
    loadDocumentSummaries(assembly, actor),
  ]);
  return { items: items.map(toAgendaItemDto), documents: documentSummaries };
}

/** Once the agenda is final (ODD definitivo), root items are locked. */
export function isAgendaFinal(
  assembly: Pick<AssemblyRow, "agendaFinalizedAt">,
): boolean {
  return assembly.agendaFinalizedAt !== null;
}

export function assertRootsUnlocked(
  assembly: Pick<AssemblyRow, "agendaFinalizedAt">,
): void {
  if (isAgendaFinal(assembly)) {
    fail(
      409,
      "El orden del día es definitivo: no se pueden crear, eliminar ni mover puntos principales",
    );
  }
}

/** Next `order` among the children of `parentId` (null = root items). */
export async function nextSiblingOrder(
  executor: Executor,
  assemblyId: string,
  parentId: string | null,
): Promise<number> {
  const [row] = await executor
    .select({ last: sql<number | null>`max(${agendaItems.order})` })
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.assemblyId, assemblyId),
        parentId
          ? eq(agendaItems.parentId, parentId)
          : isNull(agendaItems.parentId),
      ),
    );
  const last = row?.last;
  return last === null || last === undefined ? 0 : Number(last) + 1;
}

/**
 * Whether the parent map contains a cycle. Every value must be a key of the
 * map or null; a parent that is missing from the map ends the walk.
 */
export function hasAgendaCycle(
  parentById: ReadonlyMap<string, string | null>,
): boolean {
  const settled = new Set<string>();
  for (const start of parentById.keys()) {
    const path = new Set<string>();
    let current: string | null | undefined = start;
    while (current && !settled.has(current)) {
      if (path.has(current)) return true;
      path.add(current);
      current = parentById.get(current);
    }
    for (const id of path) settled.add(id);
  }
  return false;
}

/** The item and all its descendants. */
export function agendaSubtree(
  items: Pick<AgendaItemRow, "id" | "parentId">[],
  rootId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const list = children.get(item.parentId) ?? [];
    list.push(item.id);
    children.set(item.parentId, list);
  }
  const result = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const child of children.get(id) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

type OrderedItem = Pick<
  AgendaItemRow,
  "id" | "parentId" | "order" | "createdAt"
>;

/** Root item ids in display order: by order, then creation, then id. */
export function rootSequence(items: OrderedItem[]): string[] {
  return items
    .filter((item) => item.parentId === null)
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map((item) => item.id);
}

/**
 * Whether any document under these items blocks deleting them: one that is
 * submitted, published or postponed, or one that was ever published (it has a
 * base version or a publication date). Deleting the item would cascade to
 * such a document with its versions, reference and amendments, which
 * deleteDocument refuses for the same reason (isTextFrozen).
 */
export async function hasProtectedDocuments(
  executor: Executor,
  agendaItemIds: string[],
): Promise<boolean> {
  if (agendaItemIds.length === 0) return false;
  // Locks every document under the items, after the assembly ("Row locks" in
  // documents.ts): the cascade deletes the unprotected ones, and a draft
  // submitted meanwhile is read with its new status once that commits. A
  // document moved into these items is not matched here; the move holds the
  // assembly share lock (updateDocument), so it commits before lockAssembly
  // returns or starts after this transaction ends.
  const rows = await executor
    .select({
      status: documents.status,
      publishedAt: documents.publishedAt,
      baseVersionId: documents.baseVersionId,
    })
    .from(documents)
    .where(inArray(documents.agendaItemId, agendaItemIds))
    .for("update");
  const protectedStatuses: readonly string[] =
    AGENDA_PROTECTED_DOCUMENT_STATUSES;
  return rows.some(
    (row) =>
      protectedStatuses.includes(row.status) ||
      row.publishedAt !== null ||
      row.baseVersionId !== null,
  );
}

// Decisions ---------------------------------------------------------------------

/** Procedural decisions of the assembly, in the order they were taken. */
export async function loadDecisionDtos(
  assemblyId: string,
): Promise<DecisionDto[]> {
  const rows = await db
    .select({ decision: decisions, vote: votes })
    .from(decisions)
    .leftJoin(votes, eq(votes.id, decisions.voteId))
    .where(eq(decisions.assemblyId, assemblyId))
    .orderBy(asc(decisions.decidedAt), asc(decisions.id));
  return rows.map(({ decision, vote }) => ({
    id: decision.id,
    kind: decision.kind,
    method: decision.method,
    subjectIds: decision.subjectIds ?? [],
    note: decision.note,
    vote: vote ? toVoteDto(vote) : null,
    decidedAt: decision.decidedAt.toISOString(),
  }));
}

// Live state --------------------------------------------------------------------

const EMPTY_LIVE_STATE: LiveStateDto = {
  agendaItemId: null,
  documentId: null,
  amendmentId: null,
  vote: null,
  message: null,
  speakersVisible: false,
  updatedAt: null,
};

export async function loadLiveStateDto(
  assemblyId: string,
  executor: Executor = db,
): Promise<LiveStateDto> {
  const [row] = await executor
    .select({ state: liveState, vote: votes })
    .from(liveState)
    .leftJoin(
      votes,
      and(
        eq(votes.id, liveState.voteId),
        eq(votes.assemblyId, liveState.assemblyId),
      ),
    )
    .where(eq(liveState.assemblyId, assemblyId));
  if (!row) return { ...EMPTY_LIVE_STATE };
  return {
    agendaItemId: row.state.agendaItemId,
    documentId: row.state.documentId,
    amendmentId: row.state.amendmentId,
    vote: row.vote ? toVoteDto(row.vote) : null,
    message: row.state.message,
    speakersVisible: row.state.speakersVisible,
    updatedAt: row.state.updatedAt.toISOString(),
  };
}

/** Creates the live_state row when the session starts. Keeps an existing one. */
export async function ensureLiveState(
  executor: Executor,
  assemblyId: string,
  userId: string | null,
): Promise<void> {
  await executor
    .insert(liveState)
    .values({ assemblyId, updatedByUserId: userId })
    .onConflictDoNothing({ target: liveState.assemblyId });
}

type LiveStateFields = {
  [
    K in "agendaItemId" | "documentId" | "amendmentId" | "voteId" | "message"
  ]-?: Exclude<LiveStateBody[K], undefined>;
} & { speakersVisible: boolean };

/**
 * Applies a partial live-state change: `undefined` keeps a field, `null`
 * clears it. Every id must belong to the assembly, and an amendment must be
 * published (everyone follows the projection). Choosing an amendment also
 * selects its document, choosing a document also selects its agenda item,
 * and switching documents clears an amendment of the previous one.
 * `speakersVisible` shows attendees who has the floor and who is next; a
 * change of it also records `speakers_visibility_changed` (entityType
 * "speakers"), so clients that follow the speakers refetch them.
 */
export async function updateLiveState(
  actor: Actor,
  assemblyId: string,
  body: LiveStateBody,
): Promise<LiveStateDto> {
  await db.transaction(async (tx) => {
    await lockAssembly(tx, assemblyId);
    const [current] = await tx
      .select()
      .from(liveState)
      .where(eq(liveState.assemblyId, assemblyId));
    const previous: LiveStateFields = {
      agendaItemId: current?.agendaItemId ?? null,
      documentId: current?.documentId ?? null,
      amendmentId: current?.amendmentId ?? null,
      voteId: current?.voteId ?? null,
      message: current?.message ?? null,
      speakersVisible: current?.speakersVisible ?? false,
    };
    const next: LiveStateFields = { ...previous };
    for (const key of [
      "agendaItemId",
      "documentId",
      "amendmentId",
      "voteId",
      "message",
    ] as const) {
      if (body[key] !== undefined) next[key] = body[key] ?? null;
    }
    if (body.speakersVisible !== undefined) {
      next.speakersVisible = body.speakersVisible;
    }

    if (body.amendmentId) {
      const [amendment] = await tx
        .select({
          documentId: amendments.documentId,
          publishedAt: amendments.publishedAt,
        })
        .from(amendments)
        .innerJoin(documents, eq(documents.id, amendments.documentId))
        .where(
          and(
            eq(amendments.id, body.amendmentId),
            eq(documents.assemblyId, assemblyId),
          ),
        );
      if (!amendment) fail(422, "La enmienda no pertenece a esta asamblea");
      // Every delegate follows the projection: it never points at an
      // amendment they cannot read. Publication is never undone.
      if (!amendment.publishedAt) {
        fail(
          409,
          "La Secretaría tiene que publicar esta enmienda antes de proyectarla",
        );
      }
      if (body.documentId === undefined) next.documentId = amendment.documentId;
      else if (next.documentId !== amendment.documentId) {
        fail(422, "La enmienda no pertenece al documento indicado");
      }
    } else if (
      body.amendmentId === undefined &&
      next.documentId !== previous.documentId
    ) {
      next.amendmentId = null;
    }

    if (next.documentId && next.documentId !== previous.documentId) {
      const [document] = await tx
        .select({ agendaItemId: documents.agendaItemId })
        .from(documents)
        .where(
          and(
            eq(documents.id, next.documentId),
            eq(documents.assemblyId, assemblyId),
          ),
        );
      if (!document) fail(422, "El documento no pertenece a esta asamblea");
      if (body.agendaItemId === undefined)
        next.agendaItemId = document.agendaItemId;
    }

    if (body.agendaItemId) {
      const [item] = await tx
        .select({ id: agendaItems.id })
        .from(agendaItems)
        .where(
          and(
            eq(agendaItems.id, body.agendaItemId),
            eq(agendaItems.assemblyId, assemblyId),
          ),
        );
      if (!item) fail(422, "El punto no pertenece a esta asamblea");
    }

    if (body.voteId) {
      const [vote] = await tx
        .select({ id: votes.id })
        .from(votes)
        .where(
          and(eq(votes.id, body.voteId), eq(votes.assemblyId, assemblyId)),
        );
      if (!vote) fail(422, "La votación no pertenece a esta asamblea");
    }

    const changed = (Object.keys(next) as (keyof LiveStateFields)[]).filter(
      (key) => next[key] !== previous[key],
    );
    const values = {
      ...next,
      updatedByUserId: actor.user.id,
      updatedAt: sql`now()`,
    };
    await tx
      .insert(liveState)
      .values({ assemblyId, ...values })
      .onConflictDoUpdate({ target: liveState.assemblyId, set: values });

    await recordEvent(tx, {
      assemblyId,
      entityType: "live",
      entityId: assemblyId,
      type: "live_changed",
      // Ids only: the message itself is fetched through the live-state endpoint.
      payload: {
        changed,
        agendaItemId: next.agendaItemId,
        documentId: next.documentId,
        amendmentId: next.amendmentId,
        voteId: next.voteId,
        speakersVisible: next.speakersVisible,
      },
      actor,
    });
    if (next.speakersVisible !== previous.speakersVisible) {
      await recordEvent(tx, {
        assemblyId,
        entityType: "speakers",
        entityId: assemblyId,
        type: "speakers_visibility_changed",
        payload: { visible: next.speakersVisible },
        actor,
      });
    }
  });

  return loadLiveStateDto(assemblyId);
}

/** The SSE payload: ids only, without the assembly id the stream already scopes. */
export function toLiveEventDto(message: LiveMessage): LiveEventDto {
  return {
    entityType: message.entityType,
    entityId: message.entityId,
    type: message.type,
    ...(message.documentId ? { documentId: message.documentId } : {}),
  };
}
