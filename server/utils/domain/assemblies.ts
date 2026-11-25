import type { H3Event } from "h3";
import { fail } from "../core/http";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
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
import { recordEvent, type Executor, type LiveMessage } from "./events";
import { assertControlsProjection, assertSessionOpen } from "./sessionOpen";
import {
  canManageAssemblies,
  canManageDocuments,
  canModerate,
  type Actor,
} from "./actor";
import {
  assemblySettings,
  countVisibleAmendments,
  loadDocumentSummaries,
} from "./documents";
import { lockAssembly } from "./agendaWrites";
import { stampDebateStarted } from "./positionsPublication";
import { applyOnScreenMarks } from "./sessionProgress";
import { coPresentedBy, withCoProponentIds } from "./presenters";
import { canSeeDocument } from "./visibility";
import { toVoteDto, VOTE_MESSAGE_KEYS } from "./votes";
import {
  MILESTONE_KEYS,
  REGULATION_DOCUMENT_KINDS,
  type AssemblyStatus,
} from "~~/shared/constants/domain";
import type { AssemblyType } from "~~/shared/constants/assemblyTypes";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { seesDraftAssemblies } from "~~/shared/utils/permissionRules";
import type {
  AgendaDto,
  AgendaItemDto,
  AssemblyCapabilities,
  AssemblyDto,
  AssemblyListDto,
  AssemblySummaryDto,
  CalendarDocumentDto,
  DecisionDto,
  LiveEventDto,
  LiveStateBody,
  LiveStateDto,
  MilestoneDto,
} from "~~/shared/types/api";
import {
  agendaFinalSince,
  checkCalendar,
  type CalendarRules,
  type Milestones,
} from "~~/shared/utils/calendar";
import {
  liveStateClearsOnly,
  liveStateMovesScreen,
} from "~~/shared/utils/sessionGate";
import {
  changedLiveFields,
  isLiveAdmissionProposable,
  nextLivePointer,
  normalizeBloc,
  normalizeBlocOptions,
  normalizeBlocPurpose,
  type LivePointerFields,
} from "~~/shared/utils/liveBloc";
import { loadCalendarRules } from "./calendarRules";
import {
  publicTitleHiddenItemIds,
  unlistedAgendaItemIds,
} from "~~/shared/utils/agendaNumbering";
import {
  hiddenTitleItemIds,
  isAutoItem,
  isPublicDocumentStatus,
  PUBLIC_DOCUMENT_STATUSES,
  titleDocumentId,
  visibleAgendaItems,
} from "~~/shared/utils/agendaSubmissions";
import {
  AGENDA_FINAL_CONFLICT_CODE,
  ASSEMBLY_LIST_PAGE_SIZE,
  DEFAULT_SPEAKING_LIMIT_SECONDS,
} from "~~/shared/utils/schemas/assembly";
import {
  agendaItemSlugs,
  buildAssemblySlug,
  formatAssemblyLabel,
} from "~~/shared/utils/slug";

/**
 * Assembly, calendar, agenda, decisions and live-state helpers shared by the
 * handlers under server/api/assemblies (docs/api.md). Handlers stay small:
 * permission check, route resolution, body validation, then one call here.
 */

export type AssemblyRow = typeof assemblies.$inferSelect;
export type AgendaItemRow = typeof agendaItems.$inferSelect;

const VISIBLE_DOCUMENT_STATUSES = PUBLIC_DOCUMENT_STATUSES;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
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
  return seesDraftAssemblies(actor.can);
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

/**
 * The documents the actor can see in each assembly and the amendments it
 * can see on them (user's decision of 2026-11-20, for the assembly card):
 * each document's own rule (countVisibleAmendments, its amendmentCount),
 * added up, so the card says what the agenda's documents add up to.
 */
export async function countVisibleContent(
  actor: Actor,
  assemblyIds: string[],
  executor: Executor = db,
): Promise<{
  documents: Map<string, number>;
  amendments: Map<string, number>;
}> {
  const result = {
    documents: new Map<string, number>(),
    amendments: new Map<string, number>(),
  };
  if (assemblyIds.length === 0) return result;
  const rows = await executor
    .select({ id: documents.id, assemblyId: documents.assemblyId })
    .from(documents)
    .where(
      and(
        inArray(documents.assemblyId, assemblyIds),
        visibleDocumentsCondition(actor),
      ),
    );
  const assemblyOf = new Map(rows.map((row) => [row.id, row.assemblyId]));
  for (const row of rows) {
    result.documents.set(
      row.assemblyId,
      (result.documents.get(row.assemblyId) ?? 0) + 1,
    );
  }
  const perDocument = await countVisibleAmendments(
    actor,
    rows.map((row) => row.id),
    executor,
  );
  for (const [documentId, total] of perDocument) {
    const assemblyId = assemblyOf.get(documentId);
    if (!assemblyId) continue;
    result.amendments.set(
      assemblyId,
      (result.amendments.get(assemblyId) ?? 0) + total,
    );
  }
  return result;
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

/**
 * The first milestone still to come, for countdowns. Expects a sorted list.
 * Once the assembly is convened its convocation date is no longer a deadline
 * (the Secretaría may convene earlier than planned), and once the agenda is
 * final neither is the date planned for it.
 */
export function nextMilestone(
  list: MilestoneDto[],
  now = new Date(),
  done: { convened?: boolean; agendaFinal?: boolean } = {},
): MilestoneDto | null {
  const time = now.getTime();
  return (
    list.find(
      (milestone) =>
        new Date(milestone.at).getTime() > time &&
        !(done.convened && milestone.key === "convocation") &&
        !(done.agendaFinal && milestone.key === "agenda_final"),
    ) ?? null
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
  extra: {
    documentCount: number;
    amendmentCount: number;
    milestones: MilestoneDto[];
    now?: Date;
  },
): AssemblySummaryDto {
  const finalSince = agendaFinalSince(extra.milestones, extra.now);
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
    agendaFinalizedAt: iso(finalSince),
    documentCount: extra.documentCount,
    amendmentCount: extra.amendmentCount,
    nextMilestone: nextMilestone(extra.milestones, extra.now, {
      convened: row.status !== "draft",
      agendaFinal: finalSince !== null,
    }),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAssemblyDto(
  actor: Actor,
  row: AssemblyRow,
  extra: {
    documentCount: number;
    amendmentCount: number;
    milestones: MilestoneDto[];
    calendarRules: CalendarRules;
    calendarDocuments: CalendarDocumentDto[];
    now?: Date;
  },
): AssemblyDto {
  return {
    ...toAssemblySummaryDto(row, extra),
    convocationIntro: row.convocationIntro,
    convocationFile:
      row.convocationFileUrl && row.convocationUploadedAt
        ? {
            url: row.convocationFileUrl,
            name: row.convocationFileName ?? "convocatoria.pdf",
            uploadedAt: row.convocationUploadedAt.toISOString(),
          }
        : null,
    settings: assemblySettings(row),
    milestones: extra.milestones,
    calendarWarnings: checkCalendar(
      extra.calendarRules,
      row.startDate,
      milestonesToMap(extra.milestones),
      extra.calendarDocuments,
    ),
    calendarRules: extra.calendarRules,
    calendarDocuments: extra.calendarDocuments,
    can: assemblyCapabilities(actor),
  };
}

/**
 * The documents the reform window check reads (checkCalendar): the
 * amendable regulation and statutes documents still on the table, with
 * their own windows. Managers only; an empty list for everyone else.
 */
export async function loadCalendarDocuments(
  actor: Actor,
  assemblyId: string,
  executor: Executor = db,
): Promise<CalendarDocumentDto[]> {
  if (!canManageAssemblies(actor)) return [];
  const rows = await executor
    .select({
      id: documents.id,
      title: documents.title,
      kind: documents.kind,
      amendable: documents.amendable,
      amendmentsOpenAt: documents.amendmentsOpenAt,
      amendmentsCloseAt: documents.amendmentsCloseAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.assemblyId, assemblyId),
        eq(documents.amendable, true),
        inArray(documents.kind, [...REGULATION_DOCUMENT_KINDS]),
        notInArray(documents.status, ["withdrawn", "postponed"]),
      ),
    )
    .orderBy(asc(documents.createdAt), asc(documents.id));
  return rows.map((row) => ({
    ...row,
    amendmentsOpenAt: iso(row.amendmentsOpenAt),
    amendmentsCloseAt: iso(row.amendmentsCloseAt),
  }));
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
  const [milestones, counts, calendarRules, calendarDocuments] =
    await Promise.all([
      loadMilestoneDtos([row.id], executor),
      countVisibleContent(actor, [row.id], executor),
      loadCalendarRules(row.type, executor),
      loadCalendarDocuments(actor, row.id, executor),
    ]);
  return toAssemblyDto(actor, row, {
    documentCount: counts.documents.get(row.id) ?? 0,
    amendmentCount: counts.amendments.get(row.id) ?? 0,
    milestones: milestones.get(row.id) ?? [],
    calendarRules,
    calendarDocuments,
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
    countVisibleContent(actor, ids),
  ]);
  const now = new Date();

  return {
    items: rows.map((row) =>
      toAssemblySummaryDto(row, {
        documentCount: counts.documents.get(row.id) ?? 0,
        amendmentCount: counts.amendments.get(row.id) ?? 0,
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

/** What a viewer, and someone who sees only what is public, miss of an item. */
export interface AgendaItemMarks {
  /**
   * The viewer must not read the item's title (hiddenTitleItemIds): it is
   * sent without it, without its description and without the document it
   * was created for. Document managers always get them.
   */
  titleHidden: boolean;
  /**
   * Someone who sees only what is public does not receive the item
   * (unlistedAgendaItemIds), so it has no number for anyone.
   */
  unlisted: boolean;
  /**
   * That same viewer does not read its title (publicTitleHiddenItemIds),
   * whoever asks.
   */
  publicTitleHidden: boolean;
  /** From agendaItemSlugs over every item of the assembly; the id otherwise. */
  slug?: string;
}

export function toAgendaItemDto(
  row: AgendaItemRow,
  { titleHidden, unlisted, publicTitleHidden, slug = row.id }: AgendaItemMarks,
): AgendaItemDto {
  return {
    id: row.id,
    // A hidden title leaves no trace in the link either.
    slug: titleHidden ? row.id : slug,
    parentId: row.parentId,
    title: titleHidden ? "" : row.title,
    titleHidden,
    unlisted,
    // Never false while the item is unlisted.
    publicTitleHidden: publicTitleHidden || unlisted,
    description: titleHidden ? null : row.description,
    order: row.order,
    acceptsSubmissions: row.acceptsSubmissions,
    submissionKinds: row.submissionKinds,
    // A switch, never masked: it says nothing of the title.
    voted: row.voted,
    auto: isAutoItem(row),
    generatedForDocumentId: titleHidden ? null : row.generatedForDocumentId,
    titleCustom: row.titleCustom,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Whether the actor may read the title and the description of one item, as
 * loadAgendaDto decides it for the list: the item carries no document's
 * title, or the actor sees that document; a withheld title is the document
 * managers'.
 */
export async function canReadItemTitle(
  actor: Actor,
  item: AgendaItemRow,
  executor: Executor = db,
): Promise<boolean> {
  if (canManageDocuments(actor)) return true;
  if (item.titleWithheld) return false;
  const documentId = titleDocumentId(item);
  if (documentId === null) return true;
  const [row] = await executor
    .select()
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!row) return true;
  const [document] = await withCoProponentIds([row], executor);
  return document !== undefined && canSeeDocument(actor, document);
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

/**
 * The items of the agenda as a viewer gets them. `documents` are the ones
 * the viewer sees, with their status; `seesWithheld`: the viewer manages
 * documents.
 */
export function agendaItemDtos(
  items: readonly AgendaItemRow[],
  documentSummaries: readonly {
    id: string;
    agendaItemId: string;
    status: string;
  }[],
  seesWithheld: boolean,
): AgendaItemDto[] {
  // Without the items that carry the title of a document the actor cannot
  // see (an automatic sub-item, or one kept after its document moved away);
  // one that stays because of what it holds goes without its title.
  // A title withheld after its document was deleted is the managers'.
  const visible = visibleAgendaItems(items, documentSummaries, seesWithheld);
  const hiddenTitles = hiddenTitleItemIds(
    visible,
    documentSummaries,
    seesWithheld,
  );
  // The items someone who sees only the public documents would not get,
  // and those whose title it would not read: the same rules, asked for that
  // viewer. Everyone reads every public document, so the actor's own list
  // holds them all.
  const publicDocuments = documentSummaries.filter((document) =>
    isPublicDocumentStatus(document.status),
  );
  const unlisted = unlistedAgendaItemIds(items, publicDocuments);
  const publicTitleHidden = publicTitleHiddenItemIds(items, publicDocuments);
  const slugs = agendaItemSlugs(items);
  return visible.map((item) =>
    toAgendaItemDto(item, {
      titleHidden: hiddenTitles.has(item.id),
      unlisted: unlisted.has(item.id),
      publicTitleHidden: publicTitleHidden.has(item.id),
      slug: slugs.get(item.id),
    }),
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
  return {
    items: agendaItemDtos(items, documentSummaries, canManageDocuments(actor)),
    documents: documentSummaries,
  };
}

/**
 * The items of the assembly that someone who sees only the public documents
 * does not receive (`unlisted`, unlistedAgendaItemIds) and those whose title
 * it does not read (`titleHidden`, publicTitleHiddenItemIds), for an answer
 * that carries one item and not the whole agenda.
 */
export async function loadPublicItemMarks(
  assemblyId: string,
  executor: Executor = db,
): Promise<{ unlisted: Set<string>; titleHidden: Set<string> }> {
  const [items, publicDocuments] = await Promise.all([
    loadAgendaItems(assemblyId, executor),
    executor
      .select({ id: documents.id, agendaItemId: documents.agendaItemId })
      .from(documents)
      .where(
        and(
          eq(documents.assemblyId, assemblyId),
          inArray(documents.status, VISIBLE_DOCUMENT_STATUSES),
        ),
      ),
  ]);
  return {
    unlisted: unlistedAgendaItemIds(items, publicDocuments),
    titleHidden: publicTitleHiddenItemIds(items, publicDocuments),
  };
}

/** The link slug of one item (agendaItemSlugs), for a mutation's answer. */
export async function loadAgendaItemSlug(
  assemblyId: string,
  itemId: string,
  executor: Executor = db,
): Promise<string | undefined> {
  return agendaItemSlugs(await loadAgendaItems(assemblyId, executor)).get(
    itemId,
  );
}

/**
 * Whether the agenda is final (ODD definitivo): the calendar's
 * `agenda_final` date has come (agendaFinalSince).
 */
export async function isAgendaFinal(
  executor: Executor,
  assemblyId: string,
  now = new Date(),
): Promise<boolean> {
  const planned = await executor
    .select({ key: assemblyMilestones.key, at: assemblyMilestones.at })
    .from(assemblyMilestones)
    .where(
      and(
        eq(assemblyMilestones.assemblyId, assemblyId),
        eq(assemblyMilestones.key, "agenda_final"),
      ),
    );
  return agendaFinalSince(planned, now) !== null;
}

/**
 * Gate of every change to the root items (create, move, rename, delete).
 * While the agenda is provisional the change just goes ahead (false). Once
 * it is final the request must say `confirmFinal: true`: without it the
 * answer is 409 with `data.code` "agenda_final", so the client asks and
 * retries; with it the change goes ahead and the result is true, which the
 * caller writes into its event as `afterFinal`. Sub-items never come here.
 * Callers hold the assembly lock, so the calendar cannot move meanwhile.
 */
export async function confirmFinalRootChange(
  executor: Executor,
  assemblyId: string,
  confirmFinal: boolean | undefined,
): Promise<boolean> {
  return finalRootChange(
    await isAgendaFinal(executor, assemblyId),
    confirmFinal,
  );
}

/** The rule of confirmFinalRootChange, once it knows whether it is final. */
export function finalRootChange(
  final: boolean,
  confirmFinal: boolean | undefined,
): boolean {
  if (!final) return false;
  if (confirmFinal !== true) {
    fail(
      409,
      "El orden del día ya es definitivo: confirma el cambio de puntos principales",
      { code: AGENDA_FINAL_CONFLICT_CODE },
    );
  }
  return true;
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
  amendmentBloc: [],
  amendmentBlocOptions: null,
  amendmentBlocPurpose: null,
  vote: null,
  voteDecision: null,
  message: null,
  speakersVisible: false,
  recess: null,
  speakingLimitSeconds: DEFAULT_SPEAKING_LIMIT_SECONDS,
  updatedAt: null,
};

export async function loadLiveStateDto(
  assemblyId: string,
  executor: Executor = db,
): Promise<LiveStateDto> {
  const [row] = await executor
    .select({
      state: liveState,
      vote: votes,
      // What a decision vote decided (user's decision of 2026-11-21): the
      // room names it instead of «una decisión de la Mesa».
      decision: { kind: decisions.kind, subjectIds: decisions.subjectIds },
    })
    .from(liveState)
    .leftJoin(
      votes,
      and(
        eq(votes.id, liveState.voteId),
        eq(votes.assemblyId, liveState.assemblyId),
      ),
    )
    .leftJoin(
      decisions,
      and(
        eq(votes.subjectType, "decision"),
        eq(decisions.id, votes.subjectId),
        eq(decisions.assemblyId, liveState.assemblyId),
      ),
    )
    .where(eq(liveState.assemblyId, assemblyId));
  if (!row) return { ...EMPTY_LIVE_STATE };
  const bloc = normalizeBloc(row.state.amendmentBloc);
  const options = normalizeBlocOptions(row.state.amendmentBlocOptions, bloc);
  return {
    agendaItemId: row.state.agendaItemId,
    documentId: row.state.documentId,
    amendmentId: row.state.amendmentId,
    amendmentBloc: row.state.amendmentBloc ?? [],
    amendmentBlocOptions: options,
    amendmentBlocPurpose: normalizeBlocPurpose(
      row.state.amendmentBlocPurpose,
      bloc,
      options,
    ),
    vote: row.vote ? toVoteDto(row.vote) : null,
    voteDecision:
      row.vote && row.decision?.kind
        ? {
            kind: row.decision.kind,
            subjectIds: [...(row.decision.subjectIds ?? [])],
          }
        : null,
    message: row.state.message,
    speakersVisible: row.state.speakersVisible,
    recess: row.state.recessStartedAt
      ? {
          startedAt: row.state.recessStartedAt.toISOString(),
          until: row.state.recessUntil?.toISOString() ?? null,
        }
      : null,
    speakingLimitSeconds: row.state.speakingLimitSeconds,
    updatedAt: row.state.updatedAt.toISOString(),
  };
}

/**
 * Ends a recess when the session stops (it is adjourned or the assembly
 * closes), in that transaction: a session reopened the next day never
 * starts in the recess of the day before. Records `live_changed` when there
 * was one.
 */
export async function endRecess(
  tx: Executor,
  assemblyId: string,
  actor: Actor,
): Promise<void> {
  const ended = await tx
    .update(liveState)
    .set({ recessStartedAt: null, recessUntil: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(liveState.assemblyId, assemblyId),
        isNotNull(liveState.recessStartedAt),
      ),
    )
    .returning({ assemblyId: liveState.assemblyId });
  if (ended.length === 0) return;
  await recordEvent(tx, {
    assemblyId,
    entityType: "live",
    entityId: assemblyId,
    type: "live_changed",
    payload: { changed: ["recess"], recess: false },
    actor,
  });
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

type LiveStateFields = LivePointerFields & {
  message: string | null;
  speakersVisible: boolean;
};

/** Whether two instants are the same (both null counts). */
function sameMoment(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/**
 * Applies a partial live-state change: `undefined` keeps a field, `null`
 * clears it. Every id must belong to the assembly, and an amendment must be
 * published (everyone follows the projection). Choosing an amendment also
 * selects its document, choosing a document also selects its agenda item,
 * and switching documents clears an amendment of the previous one. A bloc
 * (`amendmentBloc`, user's decision of 2026-11-19) is published amendments
 * of one document, which it selects like an amendment; the bloc and the
 * amendment or the vote on screen take each other's place
 * (nextLivePointer in shared/utils/liveBloc.ts). With a purpose
 * (`amendmentBlocPurpose`, user's decision of 2026-11-21) the bloc proposes
 * to admit late amendments or not, and each must still be pending
 * admission (isLiveAdmissionProposable).
 * `speakersVisible` shows attendees who has the floor and who is next; a
 * change of it also records `speakers_visibility_changed` (entityType
 * "speakers"), so clients that follow the speakers refetch them.
 * Moving what is on screen (liveStateMovesScreen) needs the console that
 * controls the projection (`controlsProjection`); the message, the recess,
 * the speakers' visibility and the default limit do not.
 */
export async function updateLiveState(
  actor: Actor,
  assemblyId: string,
  body: LiveStateBody,
  options: { controlsProjection: boolean },
): Promise<LiveStateDto> {
  if (liveStateMovesScreen(body)) {
    assertControlsProjection(options.controlsProjection);
  }
  await db.transaction(async (tx) => {
    const locked = await lockAssembly(tx, assemblyId);
    // Nothing goes on screen before the session opens, nor while it is
    // suspended; taking things off it and the message always may.
    if (!liveStateClearsOnly(body)) assertSessionOpen(locked.status);
    const [current] = await tx
      .select()
      .from(liveState)
      .where(eq(liveState.assemblyId, assemblyId));
    const previous: LiveStateFields = {
      agendaItemId: current?.agendaItemId ?? null,
      documentId: current?.documentId ?? null,
      amendmentId: current?.amendmentId ?? null,
      amendmentBloc: normalizeBloc(current?.amendmentBloc),
      amendmentBlocOptions: normalizeBlocOptions(
        current?.amendmentBlocOptions,
        normalizeBloc(current?.amendmentBloc),
      ),
      amendmentBlocPurpose: normalizeBlocPurpose(
        current?.amendmentBlocPurpose,
        normalizeBloc(current?.amendmentBloc),
        normalizeBlocOptions(
          current?.amendmentBlocOptions,
          normalizeBloc(current?.amendmentBloc),
        ),
      ),
      voteId: current?.voteId ?? null,
      message: current?.message ?? null,
      speakersVisible: current?.speakersVisible ?? false,
    };
    // A recess keeps when it started while the Mesa changes when it ends.
    const recessStartedAt =
      body.recess === undefined
        ? (current?.recessStartedAt ?? null)
        : body.recess === null
          ? null
          : (current?.recessStartedAt ?? new Date());
    const recessUntil =
      body.recess === undefined
        ? (current?.recessUntil ?? null)
        : body.recess?.until
          ? new Date(body.recess.until)
          : null;
    const recessChanged =
      !sameMoment(recessStartedAt, current?.recessStartedAt ?? null) ||
      !sameMoment(recessUntil, current?.recessUntil ?? null);
    const speakingLimitSeconds =
      body.speakingLimitSeconds ??
      current?.speakingLimitSeconds ??
      DEFAULT_SPEAKING_LIMIT_SECONDS;
    const limitChanged =
      speakingLimitSeconds !==
      (current?.speakingLimitSeconds ?? DEFAULT_SPEAKING_LIMIT_SECONDS);

    // The document of the amendment or the bloc the body puts on screen.
    let owner: string | null = null;
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
      // amendment they cannot read. Taking a validation back unpublishes one,
      // but only under shareLockAssembly, which waits for this lock.
      if (!amendment.publishedAt) {
        fail(
          409,
          "La Secretaría tiene que publicar esta enmienda antes de proyectarla",
        );
      }
      owner = amendment.documentId;
    }
    const bloc = normalizeBloc(body.amendmentBloc);
    if (bloc) {
      // Each amendment of a bloc as one alone: of this assembly and public;
      // and all of them of one document.
      const rows = await tx
        .select({
          documentId: amendments.documentId,
          publishedAt: amendments.publishedAt,
          late: amendments.late,
          status: amendments.status,
          admission: amendments.admission,
          validatedAt: amendments.validatedAt,
        })
        .from(amendments)
        .innerJoin(documents, eq(documents.id, amendments.documentId))
        .where(
          and(
            inArray(amendments.id, bloc),
            eq(documents.assemblyId, assemblyId),
          ),
        );
      if (rows.length !== bloc.length) {
        fail(422, "Alguna enmienda del bloque no pertenece a esta asamblea");
      }
      if (new Set(rows.map((row) => row.documentId)).size > 1) {
        fail(422, "Las enmiendas del bloque son de documentos distintos");
      }
      if (rows.some((row) => !row.publishedAt)) {
        fail(
          409,
          "La Secretaría tiene que publicar cada enmienda del bloque antes de proyectarlo",
        );
      }
      // A proposal to admit them or not (user's decision of 2026-11-21):
      // late amendments still waiting for that decision.
      if (
        body.amendmentBlocPurpose &&
        !rows.every((row) => isLiveAdmissionProposable(row))
      ) {
        fail(
          409,
          "Solo se proyecta la admisión de enmiendas fuera de plazo pendientes de decidir",
          { messageKey: "session.admissionProposal.errors.notPending" },
        );
      }
      const blocDocument = rows[0]!.documentId;
      if (owner !== null && owner !== blocDocument) {
        fail(422, "La enmienda no pertenece al documento indicado");
      }
      owner = blocDocument;
    }
    const pointer = nextLivePointer(previous, body, owner);
    if ("error" in pointer) {
      fail(
        422,
        pointer.error === "bloc_with_pointer"
          ? "Un bloque no se proyecta junto a una enmienda o una votación"
          : pointer.error === "bloc_options"
            ? "Las opciones tienen que repartir exactamente las enmiendas del bloque"
            : pointer.error === "bloc_purpose"
              ? "Una propuesta de admisión se proyecta con sus enmiendas y sin opciones"
              : "La enmienda no pertenece al documento indicado",
      );
    }
    const next: LiveStateFields = {
      ...pointer.next,
      message:
        body.message === undefined ? previous.message : (body.message ?? null),
      speakersVisible: body.speakersVisible ?? previous.speakersVisible,
    };

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
        .select({ id: votes.id, voidedAt: votes.voidedAt })
        .from(votes)
        .where(
          and(eq(votes.id, body.voteId), eq(votes.assemblyId, assemblyId)),
        );
      if (!vote) fail(422, "La votación no pertenece a esta asamblea");
      // A voided vote is not put back on screen by hand. Voiding takes the
      // assembly FOR SHARE, which waits for this lock.
      if (vote.voidedAt) {
        fail(409, "Esta votación está anulada", {
          messageKey: VOTE_MESSAGE_KEYS.voided,
        });
      }
    }

    const changed: string[] = [
      ...changedLiveFields(previous, next),
      ...(["message", "speakersVisible"] as const).filter(
        (key) => next[key] !== previous[key],
      ),
    ];
    if (recessChanged) changed.push("recess");
    if (limitChanged) changed.push("speakingLimitSeconds");
    // A PUT that changes nothing (the document already on screen, the same
    // message, a retry) writes nothing and tells nobody: every live_changed
    // makes the whole room refetch. Without a row it still creates one,
    // since pointLiveVote only projects onto an existing row.
    if (current && changed.length === 0) return;
    const values = {
      ...next,
      recessStartedAt,
      recessUntil,
      speakingLimitSeconds,
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
        amendmentBloc: next.amendmentBloc,
        ...(next.amendmentBlocOptions
          ? { amendmentBlocOptions: next.amendmentBlocOptions }
          : {}),
        ...(next.amendmentBlocPurpose
          ? { amendmentBlocPurpose: next.amendmentBlocPurpose }
          : {}),
        voteId: next.voteId,
        speakersVisible: next.speakersVisible,
        recess: recessStartedAt !== null,
        ...(limitChanged ? { speakingLimitSeconds } : {}),
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
    // In session, a document on screen is marked projected, and what is
    // presented (the item, the document's own item) is marked treated at
    // once (sessionProgress.ts), as a vote that moves the projection and the
    // session opening do.
    await applyOnScreenMarks(tx, {
      assemblyId,
      status: locked.status,
      previous,
      next,
      actor,
    });
    // What goes into debate makes its presenters' answers public for good.
    if (
      next.agendaItemId !== previous.agendaItemId ||
      next.documentId !== previous.documentId
    ) {
      await stampDebateStarted(tx, {
        assemblyId,
        agendaItemId: next.agendaItemId,
        documentId: next.documentId,
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
