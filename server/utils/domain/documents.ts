import type { H3Event } from "h3";
import {
  createError,
  getRequestHeader,
  getRouterParam,
  readMultipartFormData,
} from "h3";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../db";
import {
  agendaItems,
  amendmentAcceptances,
  amendmentAuthors,
  amendments,
  assemblies,
  assemblyMilestones,
  documents,
  documentVersions,
  events,
  liveState,
  members,
  users,
  votes,
} from "../../db/schema";
import { getUploadDir } from "../core/uploadPaths";
import { logError } from "../core/logger";
import { assertOptimisticLock } from "../optimisticLock";
import {
  canManageDocuments,
  canModerate,
  requireActor,
  type Actor,
} from "./actor";
import { applyAcceptedAmendmentsRule } from "./acceptedRule";
import { recordEvent } from "./events";
import {
  loadCoProponentIds,
  loadCoProponents,
  loadSourceAuthorIds,
  planPresenters,
  presentersChanged,
  PRESENTERS_MESSAGES,
  saveCoProponents,
  withCoProponentIds,
} from "./presenters";
import { resolveAssembly, resolveDocument } from "./resolvers";
import {
  canSeeAmendment,
  canSeeDocument,
  canSeePositions,
  decisionAmendmentIds,
  filterDecisionsByAmendment,
  isAmendmentInsider,
  isDocumentPresenter,
  isDocumentProponent,
  redactCorrectionNote,
  seesAllPresentedAmendments,
  type AmendmentVisibilityContext,
  type DocumentPresenters,
} from "./visibility";
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  DOCUMENT_KIND_DEFAULTS,
  type AssemblySettings,
  type DocumentKind,
  type DocumentStatus,
  type Majority,
  type VoteResult,
} from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AmendmentWindowDto,
  CorrectionBody,
  DecisionDto,
  DocumentCapabilities,
  DocumentContentBody,
  DocumentDto,
  DocumentSummaryDto,
  DocumentUpdateBody,
  EventDto,
  FinalVoteAnnulBody,
  FinalVoteBody,
  MemberRef,
  VersionDto,
  VoteDto,
  VoteInput,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import {
  amendmentWindow,
  isWindowOpen,
  type AmendmentWindow,
  type Milestones,
} from "~~/shared/utils/calendar";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { hashContent } from "~~/shared/utils/diff";
import { slugify } from "~~/shared/utils/slug";
import { computeVoteOutcome } from "~~/shared/utils/votes";

/**
 * The document API (docs/api.md, "Documents"). Handlers resolve the route
 * with `resolveDocumentRoute`, parse the body and call one function of this
 * module. Never import from ./amendments here: it imports this module.
 */

type AssemblyRow = typeof assemblies.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
/** A document row with its co-presenters, as resolveDocument returns it. */
export type PresentedDocumentRow = DocumentRow & {
  coProponentMemberIds: string[];
};
type VersionRow = typeof documentVersions.$inferSelect;
type VoteRow = typeof votes.$inferSelect;
type MemberRow = typeof members.$inferSelect;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface DocumentRouteContext {
  actor: Actor;
  assembly: AssemblyRow;
  document: PresentedDocumentRow;
}

/** Statuses from which a never-published document can be published. */
export const PUBLISHABLE_STATUSES: DocumentStatus[] = ["draft", "submitted"];

const STALE_DOCUMENT_MESSAGE = "El documento ha cambiado. Recarga la página";

// Small helpers -----------------------------------------------------------

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function fail(statusCode: number, message: string, data?: unknown): never {
  throw createError({
    statusCode,
    message,
    ...(data === undefined ? {} : { data }),
  });
}

/**
 * Stored settings merged over the defaults, as every reader must do. Only the
 * known keys are read: settings stored before a policy was removed (such as
 * `amendmentVisibility`) neither reach clients nor survive the next update,
 * which writes this result back.
 */
export function assemblySettings(
  assembly: Pick<AssemblyRow, "settings">,
): AssemblySettings {
  const stored = (assembly.settings ?? {}) as Partial<AssemblySettings>;
  const settings: AssemblySettings = { ...DEFAULT_ASSEMBLY_SETTINGS };
  for (const key of Object.keys(settings) as (keyof AssemblySettings)[]) {
    if (Object.hasOwn(stored, key) && stored[key] !== undefined) {
      Object.assign(settings, { [key]: stored[key] });
    }
  }
  return settings;
}

/**
 * Hash of a block list, stored as `contentHash`. Treat it as opaque: jsonb
 * reorders object keys, so blocks read back from the database may hash
 * differently. Always compare against the stored column.
 */
export function hashBlocks(blocks: Block[]): Promise<string> {
  return hashContent(JSON.stringify(blocks));
}

/** Validates a request body with a Zod schema, answering 400 on failure. */
export function parseDocumentBody<T>(
  schema: {
    safeParse(
      value: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: unknown[] } };
  },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    fail(400, "Datos no válidos", { issues: parsed.error.issues });
  }
  return parsed.data;
}

// Calendar ------------------------------------------------------------------

export async function loadMilestones(
  assemblyId: string,
  executor: Executor = db,
): Promise<Milestones> {
  const rows = await executor
    .select({ key: assemblyMilestones.key, at: assemblyMilestones.at })
    .from(assemblyMilestones)
    .where(eq(assemblyMilestones.assemblyId, assemblyId));
  const milestones: Milestones = {};
  for (const row of rows) milestones[row.key] = row.at;
  return milestones;
}

/**
 * The amendment window of a document. `open` only holds for published,
 * amendable, structured documents, since `isWindowOpen` treats an empty
 * calendar as open.
 */
export function documentWindow(
  document: Pick<
    DocumentRow,
    "status" | "format" | "amendable" | "amendmentsOpenAt" | "amendmentsCloseAt"
  >,
  milestones: Milestones,
  now = new Date(),
): AmendmentWindowDto {
  const window = amendmentWindow(document, milestones);
  return {
    opensAt: toIso(window.opensAt),
    closesAt: toIso(window.closesAt),
    open:
      document.status === "published" &&
      document.amendable &&
      document.format === "structured" &&
      isWindowOpen(window, now),
  };
}

/** Whether members may still present documents (documents_close milestone). */
export function documentsDeadlinePassed(
  milestones: Milestones,
  now = new Date(),
): boolean {
  const close = milestones.documents_close;
  return Boolean(close && now > close);
}

/**
 * Whether the Secretaría expects this document from its member rather than
 * the member choosing to present it: it has an internal deadline (`dueAt`),
 * or it hangs from an agenda item that does not accept submissions, where
 * only a manager could have created it (a CEA report, say).
 */
export function isExpectedDocument(
  document: Pick<DocumentRow, "dueAt">,
  item: { acceptsSubmissions: boolean },
): boolean {
  return document.dueAt !== null || !item.acceptsSubmissions;
}

/**
 * Whether a presenter (not a manager) can no longer present this document.
 * The documents_close milestone applies, except to the documents the
 * Secretaría expects (isExpectedDocument): their internal deadline, if any,
 * governs, and an overdue one can still be presented (the tracking panel
 * flags it).
 */
export function presentationClosed(
  document: Pick<DocumentRow, "dueAt" | "correctionRequestedAt">,
  item: { acceptsSubmissions: boolean },
  milestones: Milestones,
  now = new Date(),
): boolean {
  // A correction the Secretaría asked for reopens presentation for that
  // document, whatever the deadline: it was presented in time once.
  if (document.correctionRequestedAt !== null) return false;
  return (
    !isExpectedDocument(document, item) &&
    documentsDeadlinePassed(milestones, now)
  );
}

/** Presenters and managers read the correction the Secretaría asked for. */
export function canSeeDocumentCorrection(
  actor: Actor,
  document: DocumentPresenters & Pick<DocumentRow, "submittedByUserId">,
): boolean {
  return canManageDocuments(actor) || isProponentSide(actor, document);
}

// Capabilities --------------------------------------------------------------

/**
 * The actor presents the document: acts for its main presenter or a
 * co-presenter, or created it.
 */
export function isProponentSide(
  actor: Actor,
  document: DocumentPresenters & Pick<DocumentRow, "submittedByUserId">,
): boolean {
  return (
    isDocumentPresenter(actor, document) ||
    (document.submittedByUserId !== null &&
      document.submittedByUserId === actor.user.id)
  );
}

/**
 * Editors hold document:manage, or present the document while it is still a
 * draft. Managers keep editing metadata after publication (windows, status);
 * the text itself is frozen once a base version exists.
 */
export function canEditDocument(
  actor: Actor,
  document: DocumentPresenters &
    Pick<DocumentRow, "status" | "submittedByUserId">,
): boolean {
  if (canManageDocuments(actor)) return true;
  return document.status === "draft" && isProponentSide(actor, document);
}

export function requireDocumentEditor(
  actor: Actor,
  document: DocumentPresenters &
    Pick<DocumentRow, "status" | "submittedByUserId">,
): void {
  if (!canEditDocument(actor, document)) {
    fail(403, "No tienes permiso para editar este documento");
  }
}

/** The text can no longer change: it was published and frozen as a base. */
export function isTextFrozen(
  document: Pick<DocumentRow, "status" | "baseVersionId" | "publishedAt">,
): boolean {
  return (
    document.status === "published" ||
    document.baseVersionId !== null ||
    document.publishedAt !== null
  );
}

/**
 * Drafts and submissions can be published. A withdrawn or postponed document
 * that was already published can be published again: it keeps its base
 * version, its reference and its amendments.
 */
export function isPublishable(
  document: Pick<DocumentRow, "status" | "publishedAt">,
): boolean {
  if (PUBLISHABLE_STATUSES.includes(document.status))
    return document.publishedAt === null;
  return (
    (document.status === "withdrawn" || document.status === "postponed") &&
    document.publishedAt !== null
  );
}

export function canAmendDocument(
  actor: Actor,
  assembly: Pick<AssemblyRow, "status">,
  document: Pick<
    DocumentRow,
    "status" | "format" | "amendable" | "baseVersionId" | "finalVoteId"
  >,
  window: AmendmentWindow,
  now = new Date(),
): boolean {
  if (
    document.status !== "published" ||
    document.format !== "structured" ||
    !document.amendable ||
    !document.baseVersionId ||
    document.finalVoteId ||
    assembly.status === "closed"
  ) {
    return false;
  }
  const moderator = canModerate(actor);
  if (!actor.can(PERMISSION_KEYS.AMENDMENT_CREATE) && !moderator) return false;
  if (!actor.memberId && !moderator) return false;
  // Late amendments are allowed (they wait for admission); early ones are not.
  return moderator || !window.opensAt || now >= window.opensAt;
}

export function documentCapabilities(
  actor: Actor,
  assembly: Pick<AssemblyRow, "status">,
  document: PresentedDocumentRow,
  window: AmendmentWindow,
  now = new Date(),
): DocumentCapabilities {
  return {
    edit: canEditDocument(actor, document) && !isTextFrozen(document),
    manage: canManageDocuments(actor),
    publish: canManageDocuments(actor) && isPublishable(document),
    amend: canAmendDocument(actor, assembly, document, window, now),
    // Only the main presenter answers the amendments (or the Mesa for it).
    position:
      document.status === "published" &&
      (isDocumentProponent(actor, document) || canModerate(actor)),
    moderate: canModerate(actor),
  };
}

// Mappers -------------------------------------------------------------------

function memberRefOrNull(
  member:
    Pick<MemberRow, "id" | "acronym" | "name" | "kind"> | null | undefined,
): MemberRef | null {
  if (!member) return null;
  return {
    id: member.id,
    acronym: member.acronym,
    name: member.name,
    kind: member.kind,
  };
}

export function toVersionDto(version: VersionRow): VersionDto {
  return {
    id: version.id,
    number: version.number,
    kind: version.kind,
    blocks: version.blocks,
    contentHash: version.contentHash,
    createdAt: version.createdAt.toISOString(),
  };
}

export function toVoteDto(vote: VoteRow): VoteDto {
  return {
    id: vote.id,
    subjectType: vote.subjectType,
    subjectId: vote.subjectId,
    method: vote.method,
    inFavor: vote.inFavor,
    against: vote.against,
    abstentions: vote.abstentions,
    blank: vote.blank,
    invalid: vote.invalid,
    present: vote.present,
    majority: vote.majority,
    result: vote.result,
    note: vote.note,
    recordedAt: vote.recordedAt.toISOString(),
  };
}

export function toDocumentSummaryDto(
  document: DocumentRow,
  extra: {
    proponent: MemberRef | null;
    coProponents: MemberRef[];
    amendmentCount: number;
    window: AmendmentWindowDto;
    hasContent: boolean;
    /** The actor may read the correction note (canSeeDocumentCorrection). */
    showCorrection: boolean;
  },
): DocumentSummaryDto {
  return {
    id: document.id,
    slug: document.slug,
    agendaItemId: document.agendaItemId,
    kind: document.kind,
    format: document.format,
    title: document.title,
    reference: document.reference,
    status: document.status,
    proponent: extra.proponent,
    coProponents: extra.coProponents,
    amendable: document.amendable,
    acceptedAmendments: document.acceptedAmendments,
    voted: document.voted,
    majority: document.majority,
    amendmentCount: extra.amendmentCount,
    window: extra.window,
    publishedAt: toIso(document.publishedAt),
    submittedAt: toIso(document.submittedAt),
    dueAt: toIso(document.dueAt),
    hasContent: extra.hasContent,
    correctionNote: extra.showCorrection ? document.correctionNote : null,
    correctionRequestedAt: extra.showCorrection
      ? toIso(document.correctionRequestedAt)
      : null,
    consolidated: document.consolidatedVersionId !== null,
    updatedAt: document.updatedAt.toISOString(),
  };
}

export interface DocumentDtoInput {
  actor: Actor;
  assembly: AssemblyRow;
  document: PresentedDocumentRow;
  milestones: Milestones;
  proponent: MemberRef | null;
  coProponents: MemberRef[];
  amendmentCount: number;
  hasContent: boolean;
  workingVersion: VersionRow | null;
  baseVersion: VersionRow | null;
  consolidatedVersion: VersionRow | null;
  finalVote: VoteRow | null;
  now?: Date;
}

/** Pure mapper. Use loadDocumentDto to fetch everything it needs. */
export function toDocumentDto(input: DocumentDtoInput): DocumentDto {
  const { actor, assembly, document, milestones } = input;
  const now = input.now ?? new Date();
  const window = amendmentWindow(document, milestones);
  const frozen = isTextFrozen(document);
  return {
    ...toDocumentSummaryDto(document, {
      proponent: input.proponent,
      coProponents: input.coProponents,
      amendmentCount: input.amendmentCount,
      window: documentWindow(document, milestones, now),
      hasContent: input.hasContent,
      showCorrection: canSeeDocumentCorrection(actor, document),
    }),
    summary: document.summary,
    fileUrl: document.fileUrl,
    fileName: document.fileName,
    amendmentsOpenAt: toIso(document.amendmentsOpenAt),
    amendmentsCloseAt: toIso(document.amendmentsCloseAt),
    // Everyone who can see an unpublished document (its presenters, managers
    // and the Mesa) needs to read its text; editing is governed by can.edit.
    workingVersion:
      !frozen && input.workingVersion
        ? toVersionDto(input.workingVersion)
        : null,
    baseVersion: input.baseVersion ? toVersionDto(input.baseVersion) : null,
    consolidatedVersion: input.consolidatedVersion
      ? toVersionDto(input.consolidatedVersion)
      : null,
    finalVote: input.finalVote ? toVoteDto(input.finalVote) : null,
    positionsVisible: canSeePositions(actor, {
      settings: assemblySettings(assembly),
      assemblyStatus: assembly.status,
      isPresenter: isDocumentPresenter(actor, document),
    }),
    can: documentCapabilities(actor, assembly, document, window, now),
  };
}

// Loaders -------------------------------------------------------------------

/** An amendment with what `canSeeAmendment` needs to judge it. */
interface AmendmentVisibilityRow extends AmendmentVisibilityContext {
  id: string;
  documentId: string;
}

/** Loads the amendments matching `where` with their authors and parties. */
async function loadAmendmentVisibilityRows(
  executor: Executor,
  where: SQL | undefined,
): Promise<AmendmentVisibilityRow[]> {
  const rows = await executor
    .select({
      id: amendments.id,
      documentId: amendments.documentId,
      status: amendments.status,
      publishedAt: amendments.publishedAt,
      createdByUserId: amendments.createdByUserId,
    })
    .from(amendments)
    .where(where);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [authorRows, partyRows, sourceAuthors] = await Promise.all([
    executor
      .select({
        amendmentId: amendmentAuthors.amendmentId,
        memberId: amendmentAuthors.memberId,
      })
      .from(amendmentAuthors)
      .where(inArray(amendmentAuthors.amendmentId, ids)),
    executor
      .select({
        amendmentId: amendmentAcceptances.amendmentId,
        memberId: amendmentAcceptances.memberId,
      })
      .from(amendmentAcceptances)
      .where(inArray(amendmentAcceptances.amendmentId, ids)),
    loadSourceAuthorIds(ids, executor),
  ]);
  const group = (list: { amendmentId: string; memberId: string }[]) => {
    const map = new Map<string, string[]>();
    for (const row of list) {
      const entry = map.get(row.amendmentId) ?? [];
      entry.push(row.memberId);
      map.set(row.amendmentId, entry);
    }
    return map;
  };
  const authors = group(authorRows);
  const parties = group(partyRows);
  return rows.map((row) => ({
    ...row,
    authorMemberIds: authors.get(row.id) ?? [],
    partyMemberIds: [
      ...(parties.get(row.id) ?? []),
      ...(sourceAuthors.get(row.id) ?? []),
    ],
  }));
}

/**
 * Amendments past draft that the actor can see, per document. The Secretaría
 * and the Mesa see all of them, counted in SQL. Everyone else sees the
 * published ones, also counted in SQL, plus the unpublished ones they wrote,
 * created or are a party to, as `canSeeAmendment` decides.
 */
async function countVisibleAmendments(
  actor: Actor,
  documentIds: string[],
  executor: Executor = db,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (documentIds.length === 0) return counts;
  const seesAll = seesAllPresentedAmendments(actor);
  const presented = and(
    inArray(amendments.documentId, documentIds),
    ne(amendments.status, "draft"),
  );
  const [totals, unpublished] = await Promise.all([
    executor
      .select({ documentId: amendments.documentId, total: count() })
      .from(amendments)
      .where(
        and(presented, seesAll ? undefined : isNotNull(amendments.publishedAt)),
      )
      .groupBy(amendments.documentId),
    seesAll
      ? Promise.resolve([])
      : loadAmendmentVisibilityRows(
          executor,
          and(presented, isNull(amendments.publishedAt)),
        ),
  ]);
  for (const row of totals) counts.set(row.documentId, Number(row.total));
  for (const row of unpublished) {
    if (!canSeeAmendment(actor, row)) continue;
    counts.set(row.documentId, (counts.get(row.documentId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Documents with text or a PDF (`hasContent`): a placeholder the Secretaría
 * created for an expected document has neither. One query reads the size of
 * the working versions of the structured ones.
 */
async function loadContentFlags(
  executor: Executor,
  rows: Pick<DocumentRow, "id" | "format" | "fileUrl" | "workingVersionId">[],
): Promise<Set<string>> {
  const withContent = new Set<string>();
  const versionIds: string[] = [];
  for (const row of rows) {
    if (row.format === "file") {
      if (row.fileUrl) withContent.add(row.id);
    } else if (row.workingVersionId) {
      versionIds.push(row.workingVersionId);
    }
  }
  if (versionIds.length === 0) return withContent;
  const versions = await executor
    .select({
      documentId: documentVersions.documentId,
      size: sql<number>`jsonb_array_length(${documentVersions.blocks})`,
    })
    .from(documentVersions)
    .where(inArray(documentVersions.id, versionIds));
  for (const version of versions) {
    if (Number(version.size) > 0) withContent.add(version.documentId);
  }
  return withContent;
}

/** The calendar of several assemblies in one query. */
export async function loadMilestonesByAssembly(
  assemblyIds: string[],
  executor: Executor = db,
): Promise<Map<string, Milestones>> {
  const result = new Map<string, Milestones>(assemblyIds.map((id) => [id, {}]));
  if (assemblyIds.length === 0) return result;
  const rows = await executor
    .select({
      assemblyId: assemblyMilestones.assemblyId,
      key: assemblyMilestones.key,
      at: assemblyMilestones.at,
    })
    .from(assemblyMilestones)
    .where(inArray(assemblyMilestones.assemblyId, assemblyIds));
  for (const row of rows) {
    const milestones = result.get(row.assemblyId) ?? {};
    milestones[row.key] = row.at;
    result.set(row.assemblyId, milestones);
  }
  return result;
}

export type DocumentWithProponent = DocumentRow & {
  proponent: MemberRow | null;
};

/**
 * Summaries of document rows the caller already checked with canSeeDocument,
 * from any assembly: `milestones` holds the calendar of each one.
 * `amendmentCount` counts the amendments past draft that the actor can see
 * (see countVisibleAmendments).
 */
export async function buildDocumentSummaries(
  actor: Actor,
  rows: DocumentWithProponent[],
  milestones: Map<string, Milestones>,
  now = new Date(),
  executor: Executor = db,
): Promise<DocumentSummaryDto[]> {
  const ids = rows.map((row) => row.id);
  const [counts, content, coProponents] = await Promise.all([
    countVisibleAmendments(actor, ids, executor),
    loadContentFlags(executor, rows),
    loadCoProponents(ids, executor),
  ]);
  return rows.map(({ proponent, ...document }) => {
    const co = coProponents.get(document.id) ?? [];
    return toDocumentSummaryDto(document, {
      proponent: memberRefOrNull(proponent),
      coProponents: co,
      amendmentCount: counts.get(document.id) ?? 0,
      window: documentWindow(
        document,
        milestones.get(document.assemblyId) ?? {},
        now,
      ),
      hasContent: content.has(document.id),
      showCorrection: canSeeDocumentCorrection(actor, {
        ...document,
        coProponentMemberIds: co.map((member) => member.id),
      }),
    });
  });
}

/** Summaries of the documents of an assembly that the actor can see, in creation order. */
export async function loadDocumentSummaries(
  assembly: typeof assemblies.$inferSelect,
  actor: Actor,
): Promise<DocumentSummaryDto[]> {
  const [rows, milestones] = await Promise.all([
    db.query.documents.findMany({
      where: eq(documents.assemblyId, assembly.id),
      with: { proponent: true },
      orderBy: (table, { asc: ascending }) => [
        ascending(table.createdAt),
        ascending(table.id),
      ],
    }),
    loadMilestones(assembly.id),
  ]);
  return buildDocumentSummaries(
    actor,
    (await withCoProponentIds(rows)).filter((row) =>
      canSeeDocument(actor, row),
    ),
    new Map([[assembly.id, milestones]]),
  );
}

async function loadVersion(id: string | null, executor: Executor) {
  if (!id) return null;
  const [version] = await executor
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.id, id));
  return version ?? null;
}

/** Loads the current row (by id) and everything DocumentDto needs. */
export async function loadDocumentDto(
  assembly: AssemblyRow,
  documentId: string,
  actor: Actor,
  executor: Executor = db,
): Promise<DocumentDto> {
  const [row] = await executor
    .select()
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!row) fail(404, "Documento no encontrado");
  const now = new Date();
  const coProponents =
    (await loadCoProponents([row.id], executor)).get(row.id) ?? [];
  const document: PresentedDocumentRow = {
    ...row,
    coProponentMemberIds: coProponents.map((member) => member.id),
  };
  const [
    milestones,
    proponent,
    workingVersion,
    baseVersion,
    consolidatedVersion,
    finalVote,
  ] = await Promise.all([
    loadMilestones(assembly.id, executor),
    document.proponentMemberId
      ? executor
          .select()
          .from(members)
          .where(eq(members.id, document.proponentMemberId))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    loadVersion(document.workingVersionId, executor),
    loadVersion(document.baseVersionId, executor),
    loadVersion(document.consolidatedVersionId, executor),
    document.finalVoteId
      ? executor
          .select()
          .from(votes)
          .where(eq(votes.id, document.finalVoteId))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  const [counts, content] = await Promise.all([
    countVisibleAmendments(actor, [document.id], executor),
    loadContentFlags(executor, [document]),
  ]);
  return toDocumentDto({
    actor,
    assembly,
    document,
    milestones,
    proponent: memberRefOrNull(proponent),
    coProponents,
    amendmentCount: counts.get(document.id) ?? 0,
    hasContent: content.has(document.id),
    workingVersion,
    baseVersion,
    consolidatedVersion,
    finalVote,
    now,
  });
}

/** requireActor + resolveAssembly + resolveDocument for document routes. */
export async function resolveDocumentRoute(
  event: H3Event,
): Promise<DocumentRouteContext> {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const document = await resolveDocument(
    actor,
    assembly.id,
    getRouterParam(event, "document"),
  );
  return { actor, assembly, document };
}

/** Members referenced by documents must exist. */
export async function requireMember(memberId: string, executor: Executor = db) {
  const [member] = await executor
    .select({ id: members.id })
    .from(members)
    .where(eq(members.id, memberId));
  if (!member) fail(422, "El miembro indicado no existe");
  return member;
}

/** Every member of the list must exist (co-presenters). */
export async function requireMembers(
  memberIds: readonly string[],
  executor: Executor = db,
): Promise<void> {
  if (memberIds.length === 0) return;
  const rows = await executor
    .select({ id: members.id })
    .from(members)
    .where(inArray(members.id, [...memberIds]));
  if (rows.length !== new Set(memberIds).size) {
    fail(422, "Algún miembro indicado no existe");
  }
}

/**
 * Reads and locks the current row until the transaction ends, with its
 * co-presenters (they change only under this lock). `no key update`
 * serializes every change of the document and still lets other transactions
 * insert rows that reference it (see "Row locks" by shareLockAssembly); only
 * a transaction that deletes the row takes `update`.
 */
async function lockDocument(
  executor: Executor,
  documentId: string,
  strength: "no key update" | "update" = "no key update",
): Promise<PresentedDocumentRow> {
  const [row] = await executor
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .for(strength);
  if (!row) fail(404, "Documento no encontrado");
  return {
    ...row,
    coProponentMemberIds:
      (await loadCoProponentIds([row.id], executor)).get(row.id) ?? [],
  };
}

/** Whether the document has something to submit or publish. */
async function hasContent(
  executor: Executor,
  document: DocumentRow,
): Promise<boolean> {
  if (document.format === "file") return Boolean(document.fileUrl);
  if (!document.workingVersionId) return false;
  const [row] = await executor
    .select({
      size: sql<number>`jsonb_array_length(${documentVersions.blocks})`,
    })
    .from(documentVersions)
    .where(eq(documentVersions.id, document.workingVersionId));
  return Number(row?.size ?? 0) > 0;
}

function emptyDocumentError(document: Pick<DocumentRow, "format">): never {
  fail(
    422,
    document.format === "file"
      ? "Falta subir el PDF del documento"
      : "El documento no tiene texto",
  );
}

// Slugs, versions and references ------------------------------------------

/** Words used by the document routes themselves. */
const RESERVED_SLUGS = new Set(["nuevo", "new", "documentos", "documents"]);

/**
 * slugify(title), unique within the assembly (-2, -3...). Serialized per
 * assembly with an advisory lock held until the transaction ends.
 */
export async function uniqueDocumentSlug(
  executor: Executor,
  assemblyId: string,
  title: string,
): Promise<string> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`document_slug:${assemblyId}`}))`,
  );
  const base = slugify(title) || "documento";
  const rows = await executor
    .select({ slug: documents.slug })
    .from(documents)
    .where(
      and(
        eq(documents.assemblyId, assemblyId),
        like(documents.slug, `${base}%`),
      ),
    );
  const taken = new Set(rows.map((row) => row.slug));
  const isFree = (slug: string) =>
    !taken.has(slug) && !RESERVED_SLUGS.has(slug);
  if (isFree(base)) return base;
  let suffix = 2;
  while (!isFree(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export async function nextVersionNumber(
  executor: Executor,
  documentId: string,
): Promise<number> {
  const [row] = await executor
    .select({ last: sql<number>`coalesce(max(${documentVersions.number}), 0)` })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId));
  return Number(row?.last ?? 0) + 1;
}

const REFERENCE_TIME_ZONE = "Europe/Madrid";

function referenceYear(at: Date): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: REFERENCE_TIME_ZONE,
    year: "numeric",
  }).format(at);
}

/**
 * Next official reference for kinds that use one: "{PREFIX} {NNN}/{YYYY}",
 * numbered per prefix and year (of `at`, in Madrid time) across every
 * assembly. Returns null for kinds without a prefix.
 */
export async function assignReference(
  executor: Executor,
  kind: DocumentKind,
  at: Date,
): Promise<string | null> {
  const prefix = DOCUMENT_KIND_DEFAULTS[kind].referencePrefix;
  if (!prefix) return null;
  const year = referenceYear(at);
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`document_reference:${prefix}:${year}`}))`,
  );
  const rows = await executor
    .select({ reference: documents.reference })
    .from(documents)
    .where(like(documents.reference, `${prefix} %/${year}`));
  const pattern = new RegExp(`^${prefix} (\\d+)/${year}$`);
  let last = 0;
  for (const row of rows) {
    const match = row.reference?.match(pattern);
    if (match) last = Math.max(last, Number(match[1]));
  }
  return `${prefix} ${String(last + 1).padStart(3, "0")}/${year}`;
}

// Metadata (PUT) ----------------------------------------------------------

/**
 * Fields only managers may change; the presenters get the kind defaults.
 * The presenters themselves (proponentMemberId, coProponentMemberIds) follow
 * planPresenters.
 */
const MANAGER_FIELDS = [
  "amendable",
  "voted",
  "majority",
  "acceptedAmendments",
  "amendmentsOpenAt",
  "amendmentsCloseAt",
  "dueAt",
  "status",
] as const satisfies readonly (keyof DocumentUpdateBody)[];

function sameDate(a: Date | null, b: string | null): boolean {
  if (a === null || b === null) return a === null && b === null;
  return a.getTime() === new Date(b).getTime();
}

/** Body fields that differ from the stored row. */
function changedFields(
  document: PresentedDocumentRow,
  body: DocumentUpdateBody,
): (keyof DocumentUpdateBody)[] {
  const changed: (keyof DocumentUpdateBody)[] = [];
  const plain = [
    "title",
    "summary",
    "kind",
    "agendaItemId",
    "proponentMemberId",
    "amendable",
    "voted",
    "majority",
    "acceptedAmendments",
    "status",
  ] as const;
  for (const key of plain) {
    if (body[key] !== undefined && body[key] !== document[key])
      changed.push(key);
  }
  if (
    body.coProponentMemberIds !== undefined &&
    presentersChanged(
      {
        proponentMemberId: null,
        coProponentMemberIds: document.coProponentMemberIds,
      },
      {
        proponentMemberId: null,
        coProponentMemberIds: body.coProponentMemberIds,
      },
    )
  ) {
    changed.push("coProponentMemberIds");
  }
  if (
    body.amendmentsOpenAt !== undefined &&
    !sameDate(document.amendmentsOpenAt, body.amendmentsOpenAt)
  ) {
    changed.push("amendmentsOpenAt");
  }
  if (
    body.amendmentsCloseAt !== undefined &&
    !sameDate(document.amendmentsCloseAt, body.amendmentsCloseAt)
  ) {
    changed.push("amendmentsCloseAt");
  }
  if (body.dueAt !== undefined && !sameDate(document.dueAt, body.dueAt)) {
    changed.push("dueAt");
  }
  return changed;
}

/** Statuses a document can be withdrawn from: it was presented. */
const WITHDRAWABLE_STATUSES: readonly DocumentStatus[] = [
  "submitted",
  "published",
  "postponed",
];

/**
 * Status changes allowed through PUT (managers only):
 * - `withdrawn`: only a presented document (submitted, published or
 *   postponed). A draft is still private to its proponent and may be
 *   unfinished; an unwanted one is deleted instead.
 * - `postponed`: only a published text, since postponed documents are public.
 * - `submitted`: only to restore a withdrawn submission, back to the status it
 *   had: submitted (submittedAt is set) and never published. A text that was
 *   published is restored by publishing it again, and a draft is presented
 *   through POST .../submit, which checks its content.
 */
export function assertStatusChange(
  document: Pick<
    DocumentRow,
    "status" | "finalVoteId" | "publishedAt" | "baseVersionId" | "submittedAt"
  >,
  next: DocumentStatus,
): void {
  if (next === document.status) return;
  // The final vote settled the text: annul it first to change the status.
  if (document.finalVoteId) {
    fail(
      409,
      "El documento ya se ha votado: anula la votación final antes de cambiar su estado",
    );
  }
  if (next === "withdrawn") {
    if (!WITHDRAWABLE_STATUSES.includes(document.status)) {
      fail(
        409,
        "Un borrador no se puede retirar: si ya no hace falta, elimínalo",
      );
    }
    return;
  }
  if (next === "postponed") {
    if (document.publishedAt === null) {
      fail(409, "Solo se pueden aplazar documentos ya publicados");
    }
    return;
  }
  if (next === "submitted") {
    if (isTextFrozen(document)) {
      fail(
        409,
        "Este documento ya se publicó: vuelve a publicarlo en lugar de presentarlo",
      );
    }
    if (document.status !== "withdrawn") {
      fail(409, "Solo se puede recuperar un documento retirado");
    }
    if (document.submittedAt === null) {
      fail(
        409,
        "El documento se retiró sin llegar a presentarse y no se puede recuperar como presentado",
      );
    }
    return;
  }
  fail(422, "Cambio de estado no válido");
}

/**
 * The agenda item a document moves to, read under the assembly share lock so
 * neither an agenda delete nor a change of acceptsSubmissions (both under
 * lockAssembly) can happen between this check and the commit.
 */
async function requireAgendaTarget(
  executor: Executor,
  assemblyId: string,
  agendaItemId: string,
  manager: boolean,
): Promise<void> {
  const [item] = await executor
    .select({ acceptsSubmissions: agendaItems.acceptsSubmissions })
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.id, agendaItemId),
        eq(agendaItems.assemblyId, assemblyId),
      ),
    );
  if (!item) fail(404, "Punto no encontrado");
  if (!manager && !item.acceptsSubmissions) {
    fail(
      403,
      "Este punto del orden del día no admite documentos de los miembros",
    );
  }
}

/**
 * Updates the metadata of a document. Presenters may change title, summary,
 * kind, agenda item and presenters (planPresenters) of their draft;
 * everything else needs document:manage. The slug never changes, since it is
 * part of the URLs already shared.
 */
export async function updateDocument(
  ctx: DocumentRouteContext,
  body: DocumentUpdateBody,
): Promise<DocumentDto> {
  const { actor, assembly } = ctx;
  requireDocumentEditor(actor, ctx.document);
  const manager = canManageDocuments(actor);

  const pending = changedFields(ctx.document, body);
  if (
    !manager &&
    pending.some((key) => (MANAGER_FIELDS as readonly string[]).includes(key))
  ) {
    fail(403, "No tienes permiso para cambiar estos datos del documento");
  }
  if (
    body.proponentMemberId &&
    body.proponentMemberId !== ctx.document.proponentMemberId
  ) {
    await requireMember(body.proponentMemberId);
  }
  const added = (body.coProponentMemberIds ?? []).filter(
    (id) => !ctx.document.coProponentMemberIds.includes(id),
  );
  await requireMembers(added);

  await db.transaction(async (tx) => {
    // A move takes the assembly before the document ("Row locks"). The share
    // lock conflicts with the NO KEY UPDATE of an agenda delete, so the two
    // serialize: the delete then finds the document under its new item and
    // refuses (hasProtectedDocuments) instead of cascading to it, or the move
    // finds its target gone (requireAgendaTarget).
    if (body.agendaItemId !== undefined) {
      await shareLockAssembly(tx, assembly.id);
    }
    const current = await lockDocument(tx, ctx.document.id);
    assertOptimisticLock(
      body.updatedAt,
      current.updatedAt,
      STALE_DOCUMENT_MESSAGE,
    );
    requireDocumentEditor(actor, current);

    const changed = changedFields(current, body);
    if (changed.length === 0) return;
    if (changed.includes("agendaItemId")) {
      await requireAgendaTarget(tx, assembly.id, body.agendaItemId!, manager);
    }

    const patch: Partial<typeof documents.$inferInsert> = {};
    if (changed.includes("title")) patch.title = body.title;
    if (changed.includes("summary")) patch.summary = body.summary ?? null;
    if (changed.includes("agendaItemId"))
      patch.agendaItemId = body.agendaItemId;
    if (changed.includes("kind")) {
      patch.kind = body.kind;
      if (!manager) {
        // Presenters always get the defaults of the kind they pick.
        const defaults = DOCUMENT_KIND_DEFAULTS[body.kind!];
        patch.amendable =
          current.format === "file" ? false : defaults.amendable;
        patch.voted = defaults.voted;
        patch.majority = defaults.majority;
        patch.acceptedAmendments = defaults.acceptedAmendments;
      }
    }
    let presenters: ReturnType<typeof planPresenters> | null = null;
    if (
      changed.includes("proponentMemberId") ||
      changed.includes("coProponentMemberIds")
    ) {
      presenters = planPresenters({
        manager,
        actorMemberId: actor.memberId,
        current: {
          proponentMemberId: current.proponentMemberId,
          coProponentMemberIds: current.coProponentMemberIds,
        },
        proponentMemberId: body.proponentMemberId,
        coProponentMemberIds: body.coProponentMemberIds,
      });
      if (typeof presenters === "string") {
        // Only the main presenter or the Secretaría choose who it is.
        if (presenters === "main_only") {
          fail(403, PRESENTERS_MESSAGES.main_only, { reason: "main_only" });
        }
        fail(422, PRESENTERS_MESSAGES[presenters]);
      }
      patch.proponentMemberId = presenters.proponentMemberId;
    }
    if (manager) {
      if (changed.includes("amendable")) patch.amendable = body.amendable;
      if (changed.includes("acceptedAmendments")) {
        // The final vote settled what each amendment became.
        if (current.finalVoteId || current.consolidatedVersionId) {
          fail(
            409,
            "El documento ya se ha votado: ya no se puede cambiar qué pasa con las enmiendas aceptadas",
          );
        }
        patch.acceptedAmendments = body.acceptedAmendments;
      }
      if (changed.includes("voted")) patch.voted = body.voted;
      if (changed.includes("majority")) patch.majority = body.majority;
      if (changed.includes("amendmentsOpenAt")) {
        patch.amendmentsOpenAt = body.amendmentsOpenAt
          ? new Date(body.amendmentsOpenAt)
          : null;
      }
      if (changed.includes("amendmentsCloseAt")) {
        patch.amendmentsCloseAt = body.amendmentsCloseAt
          ? new Date(body.amendmentsCloseAt)
          : null;
      }
      if (changed.includes("dueAt")) {
        patch.dueAt = body.dueAt ? new Date(body.dueAt) : null;
      }
      if (changed.includes("status")) {
        // Restoring keeps the original submittedAt (assertStatusChange).
        assertStatusChange(current, body.status!);
        patch.status = body.status;
      }
    }

    if (current.format === "file" && (patch.amendable ?? current.amendable)) {
      fail(422, "Un documento en PDF no puede ser enmendable");
    }
    const opensAt =
      patch.amendmentsOpenAt !== undefined
        ? patch.amendmentsOpenAt
        : current.amendmentsOpenAt;
    const closesAt =
      patch.amendmentsCloseAt !== undefined
        ? patch.amendmentsCloseAt
        : current.amendmentsCloseAt;
    if (opensAt && closesAt && closesAt <= opensAt) {
      fail(422, "El cierre de enmiendas debe ser posterior a la apertura");
    }

    await tx.update(documents).set(patch).where(eq(documents.id, current.id));
    if (presenters) {
      await saveCoProponents(tx, current.id, presenters.coProponentMemberIds);
    }
    // The amendments already answered follow the new rule: accepted ones
    // are incorporated, or the incorporated ones go back to the vote.
    if (
      patch.acceptedAmendments !== undefined &&
      patch.acceptedAmendments !== current.acceptedAmendments
    ) {
      await applyAcceptedAmendmentsRule(tx, {
        assemblyId: assembly.id,
        documentId: current.id,
        rule: patch.acceptedAmendments,
        mainPresenterId:
          patch.proponentMemberId !== undefined
            ? patch.proponentMemberId
            : current.proponentMemberId,
        actor,
        now: new Date(),
      });
    }

    const fields = changed.filter((key) => key !== "status");
    if (fields.length > 0) {
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "document",
        entityId: current.id,
        documentId: current.id,
        type: "document_updated",
        payload: {
          fields,
          ...(presenters
            ? {
                proponentMemberId: presenters.proponentMemberId,
                coProponentMemberIds: presenters.coProponentMemberIds,
              }
            : {}),
        },
        actor,
      });
    }
    if (patch.status) {
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "document",
        entityId: current.id,
        documentId: current.id,
        type: "document_status_changed",
        payload: { from: current.status, to: patch.status },
        actor,
      });
    }
  });

  return loadDocumentDto(assembly, ctx.document.id, actor);
}

// Working draft -----------------------------------------------------------

/** The actor may replace the working text: structured, editable, not frozen. */
export function requireTextEditor(
  actor: Actor,
  document: PresentedDocumentRow,
): void {
  requireDocumentEditor(actor, document);
  if (document.format !== "structured") {
    fail(409, "Este documento es un PDF y no tiene texto editable");
  }
  if (isTextFrozen(document)) {
    fail(409, "El documento ya está publicado y su texto no se puede editar");
  }
}

/**
 * Replaces the blocks of the working draft in place. `baseHash` must be the
 * stored contentHash the client edited; a stale hash answers 409 with
 * `{ stale: true }`. The document's updatedAt is left alone, so saving the
 * text never invalidates a metadata form open at the same time.
 */
export async function updateDocumentContent(
  ctx: DocumentRouteContext,
  body: DocumentContentBody,
): Promise<DocumentDto> {
  const { actor, assembly } = ctx;
  requireTextEditor(actor, ctx.document);
  const contentHash = await hashBlocks(body.blocks);

  await db.transaction(async (tx) => {
    const current = await lockDocument(tx, ctx.document.id);
    requireTextEditor(actor, current);
    if (!current.workingVersionId) fail(409, "El documento no tiene borrador");

    const [updated] = await tx
      .update(documentVersions)
      .set({ blocks: body.blocks, contentHash })
      .where(
        and(
          eq(documentVersions.id, current.workingVersionId),
          eq(documentVersions.kind, "draft"),
          eq(documentVersions.contentHash, body.baseHash),
        ),
      )
      .returning({ id: documentVersions.id });
    if (!updated) {
      fail(
        409,
        "El texto ha cambiado desde que lo abriste. Recarga la página",
        {
          stale: true,
        },
      );
    }
    if (contentHash === body.baseHash) return;

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: current.id,
      documentId: current.id,
      type: "document_content_updated",
      payload: { contentHash, blockCount: body.blocks.length },
      actor,
    });
  });

  return loadDocumentDto(assembly, ctx.document.id, actor);
}

// Submission and publication ------------------------------------------------

/**
 * A presenter sends a draft to the Secretaría (`submitted`), which then
 * validates it (publishes it) or asks for a correction. Members must do it
 * before the documents_close milestone, unless the Secretaría expects the
 * document (see presentationClosed); managers are not bound by it.
 * Presenting it again after a correction clears the correction note.
 */
export async function submitDocument(
  ctx: DocumentRouteContext,
  body: { updatedAt?: string },
): Promise<DocumentDto> {
  const { actor, assembly } = ctx;
  const manager = canManageDocuments(actor);
  if (!manager && !isProponentSide(actor, ctx.document)) {
    fail(403, "Solo quien presenta el documento puede enviarlo");
  }
  if (assembly.status === "closed") fail(409, "La asamblea ya está cerrada");
  const milestones = manager ? {} : await loadMilestones(assembly.id);

  await db.transaction(async (tx) => {
    const current = await lockDocument(tx, ctx.document.id);
    assertOptimisticLock(
      body.updatedAt,
      current.updatedAt,
      STALE_DOCUMENT_MESSAGE,
    );
    if (current.status !== "draft")
      fail(409, "Solo se pueden presentar borradores");
    if (!manager) {
      const [item] = await tx
        .select({ acceptsSubmissions: agendaItems.acceptsSubmissions })
        .from(agendaItems)
        .where(eq(agendaItems.id, current.agendaItemId));
      if (item && presentationClosed(current, item, milestones)) {
        fail(409, "El plazo de presentación de documentos ha terminado");
      }
    }
    if (!(await hasContent(tx, current))) emptyDocumentError(current);

    const submittedAt = new Date();
    await tx
      .update(documents)
      .set({
        status: "submitted",
        submittedAt,
        correctionNote: null,
        correctionRequestedAt: null,
      })
      .where(eq(documents.id, current.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: current.id,
      documentId: current.id,
      type: "document_submitted",
      payload: {
        submittedAt: submittedAt.toISOString(),
        ...(current.correctionRequestedAt ? { afterCorrection: true } : {}),
      },
      actor,
    });
  });

  return loadDocumentDto(assembly, ctx.document.id, actor);
}

/**
 * The Secretaría (document:manage) sends a presented document back to its
 * presenters with a note: it returns to draft, loses its submittedAt and
 * keeps the note (correctionNote, correctionRequestedAt) until it is
 * presented again. Optimistic lock on the document.
 */
export async function requestDocumentCorrection(
  ctx: DocumentRouteContext,
  body: CorrectionBody,
): Promise<DocumentDto> {
  const { actor, assembly } = ctx;
  if (!canManageDocuments(actor)) {
    fail(403, "No tienes permiso para revisar documentos");
  }

  await db.transaction(async (tx) => {
    const current = await lockDocument(tx, ctx.document.id);
    assertOptimisticLock(
      body.updatedAt,
      current.updatedAt,
      STALE_DOCUMENT_MESSAGE,
    );
    // A submitted document was never published (assertStatusChange), so it
    // can go back to an editable draft.
    if (current.status !== "submitted" || isTextFrozen(current)) {
      fail(
        409,
        "Solo se puede pedir una corrección de un documento enviado y pendiente de revisión",
      );
    }
    const requestedAt = new Date();
    await tx
      .update(documents)
      .set({
        status: "draft",
        submittedAt: null,
        correctionNote: body.note,
        correctionRequestedAt: requestedAt,
      })
      .where(eq(documents.id, current.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: current.id,
      documentId: current.id,
      type: "document_correction_requested",
      payload: { note: body.note },
      actor,
    });
  });

  return loadDocumentDto(assembly, ctx.document.id, actor);
}

/**
 * Publishes a document (document:manage). A structured text is frozen as an
 * immutable `base` version, which amendments anchor to. Kinds with a
 * reference prefix get "{PREFIX} {NNN}/{YYYY}". Publishing again a withdrawn
 * or postponed document restores it with the same base and reference.
 */
export async function publishDocument(
  ctx: DocumentRouteContext,
  body: { updatedAt?: string },
): Promise<DocumentDto> {
  const { actor, assembly } = ctx;
  if (!canManageDocuments(actor)) {
    fail(403, "No tienes permiso para publicar documentos");
  }

  await db.transaction(async (tx) => {
    const current = await lockDocument(tx, ctx.document.id);
    assertOptimisticLock(
      body.updatedAt,
      current.updatedAt,
      STALE_DOCUMENT_MESSAGE,
    );
    if (!isPublishable(current)) {
      fail(409, "El documento no se puede publicar en su estado actual");
    }

    const now = new Date();
    let baseVersionId = current.baseVersionId;
    if (current.format === "structured" && !baseVersionId) {
      const working = await loadVersion(current.workingVersionId, tx);
      if (!working || working.blocks.length === 0) emptyDocumentError(current);
      const [base] = await tx
        .insert(documentVersions)
        .values({
          documentId: current.id,
          number: await nextVersionNumber(tx, current.id),
          kind: "base",
          blocks: working.blocks,
          // Copied, not recomputed: jsonb may have reordered the keys.
          contentHash: working.contentHash,
          createdByUserId: actor.user.id,
        })
        .returning({ id: documentVersions.id });
      baseVersionId = base!.id;
    } else if (current.format === "file" && !current.fileUrl) {
      emptyDocumentError(current);
    }

    const reference =
      current.reference ?? (await assignReference(tx, current.kind, now));
    const republished = current.publishedAt !== null;
    await tx
      .update(documents)
      .set({
        status: "published",
        publishedAt: current.publishedAt ?? now,
        baseVersionId,
        reference,
        // Publishing is the validation: a pending correction is settled.
        correctionNote: null,
        correctionRequestedAt: null,
      })
      .where(eq(documents.id, current.id));

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: current.id,
      documentId: current.id,
      type: "document_published",
      payload: { reference, baseVersionId, republished, from: current.status },
      actor,
    });
  });

  return loadDocumentDto(assembly, ctx.document.id, actor);
}

// Deletion ------------------------------------------------------------------

/** Deletes a document that was never published (document:manage). */
export async function deleteDocument(
  ctx: DocumentRouteContext,
): Promise<{ success: true }> {
  const { actor, assembly } = ctx;
  if (!canManageDocuments(actor)) {
    fail(403, "No tienes permiso para eliminar documentos");
  }

  const fileUrl = await db.transaction(async (tx) => {
    const current = await lockDocument(tx, ctx.document.id, "update");
    if (isTextFrozen(current)) {
      fail(409, "No se puede eliminar un documento ya publicado");
    }
    await tx.delete(documents).where(eq(documents.id, current.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: current.id,
      documentId: current.id,
      type: "document_deleted",
      payload: {
        title: current.title,
        kind: current.kind,
        format: current.format,
      },
      actor,
    });
    return current.fileUrl;
  });

  await removeStoredPdf(fileUrl);
  return { success: true };
}

// Live projection -----------------------------------------------------------

const LIVE_FIELDS = [
  "agendaItemId",
  "documentId",
  "amendmentId",
  "voteId",
] as const;

type LivePointer = Record<(typeof LIVE_FIELDS)[number], string | null>;

/**
 * Row locks. Every transaction that locks more than one of these rows takes
 * them in this order, so two transactions never wait on each other:
 *
 * 1. the assembly: FOR SHARE (shareLockAssembly) in the transactions that
 *    move the live projection from a document or amendment path and in
 *    updateDocument when the body sets an agenda item (so a move serializes
 *    with an agenda delete of its target), NO KEY UPDATE in lockAssembly
 *    (agenda, calendar, PUT .../live-state);
 * 2. the document: NO KEY UPDATE, or FOR SHARE in the amendment paths
 *    (lockDocument here and in amendments.ts);
 * 3. amendment rows, in id order (lockAmendments in amendments.ts);
 * 4. acceptance rows;
 * 5. the live_state row (lockLiveState, the PUT .../live-state upsert).
 *
 * Explicit locks are NO KEY UPDATE or FOR SHARE, never FOR UPDATE, except on
 * a row the transaction deletes (deleteDocument, and the agenda delete, which
 * locks the documents its cascade removes after the assembly). The foreign
 * key checks of an insert or update take FOR KEY SHARE on the rows they
 * reference: the assembly for events, votes and decisions, the document for
 * versions, amendments and live_state, the amendment for relations, sources
 * and positions. Only FOR UPDATE conflicts with FOR KEY SHARE, so those
 * checks never wait on a lock of this list and may come in any order.
 *
 * Known exception: deleting a draft assembly takes FOR UPDATE on it before
 * its cascade reaches the documents, so it can deadlock with a draft being
 * saved in that assembly at the same instant. Only managers see a draft
 * assembly, and Postgres aborts one of the two, so it is accepted.
 */
export async function shareLockAssembly(
  tx: Executor,
  assemblyId: string,
): Promise<void> {
  await tx
    .select({ id: assemblies.id })
    .from(assemblies)
    .where(eq(assemblies.id, assemblyId))
    .for("share");
}

/**
 * Locks the live_state row of a session, or returns null when the session has
 * not started (no row). The assembly is share-locked first: updateLiveState
 * locks it (lockAssembly) and then writes a full row read earlier, so without
 * it a concurrent PUT .../live-state could overwrite this change. Callers
 * take that share lock before any document lock (see "Row locks" above);
 * taking it again here is a no-op that keeps the helper safe on its own.
 */
async function lockLiveState(
  tx: Executor,
  assemblyId: string,
): Promise<LivePointer | null> {
  await shareLockAssembly(tx, assemblyId);
  const [row] = await tx
    .select({
      agendaItemId: liveState.agendaItemId,
      documentId: liveState.documentId,
      amendmentId: liveState.amendmentId,
      voteId: liveState.voteId,
    })
    .from(liveState)
    .where(eq(liveState.assemblyId, assemblyId))
    .for("no key update");
  return row ?? null;
}

async function writeLiveState(
  tx: Executor,
  assemblyId: string,
  previous: LivePointer,
  next: LivePointer,
  actor: Actor,
): Promise<void> {
  const changed = LIVE_FIELDS.filter((key) => next[key] !== previous[key]);
  if (changed.length === 0) return;
  await tx
    .update(liveState)
    .set({ ...next, updatedByUserId: actor.user.id, updatedAt: sql`now()` })
    .where(eq(liveState.assemblyId, assemblyId));
  await recordEvent(tx, {
    assemblyId,
    entityType: "live",
    entityId: assemblyId,
    type: "live_changed",
    // Same shape as updateLiveState: ids only.
    payload: { changed, ...next },
    actor,
  });
}

/**
 * Projects a vote the server has just recorded, inside the transaction that
 * recorded it, when the session has a live_state row. An amendment or
 * document vote also points the projection at what was voted (choosing a new
 * document selects its agenda item, as PUT .../live-state does); a decision
 * vote only replaces the vote. Records `live_changed`.
 */
export async function pointLiveVote(
  tx: Executor,
  input: {
    assemblyId: string;
    voteId: string;
    actor: Actor;
    subject?: {
      documentId: string;
      agendaItemId: string | null;
      amendmentId: string | null;
    };
  },
): Promise<void> {
  const previous = await lockLiveState(tx, input.assemblyId);
  if (!previous) return;
  const next: LivePointer = { ...previous, voteId: input.voteId };
  if (input.subject) {
    if (input.subject.documentId !== previous.documentId) {
      next.agendaItemId = input.subject.agendaItemId;
    }
    next.documentId = input.subject.documentId;
    next.amendmentId = input.subject.amendmentId;
  }
  await writeLiveState(tx, input.assemblyId, previous, next, input.actor);
}

/**
 * Stops projecting a vote that has just been voided (amendment reopened,
 * final vote annulled). Leaves the projection alone when it shows anything
 * else. Records `live_changed` when it clears it.
 */
export async function clearLiveVote(
  tx: Executor,
  input: { assemblyId: string; voteId: string | null; actor: Actor },
): Promise<void> {
  if (!input.voteId) return;
  const previous = await lockLiveState(tx, input.assemblyId);
  if (!previous || previous.voteId !== input.voteId) return;
  await writeLiveState(
    tx,
    input.assemblyId,
    previous,
    { ...previous, voteId: null },
    input.actor,
  );
}

// Final vote ----------------------------------------------------------------

/**
 * Result of a final vote. Assent approves without counts; a tie under
 * tieRule "repeat" answers 409 with `{ tie: true }` and stores nothing.
 */
export function evaluateFinalVote(
  vote: VoteInput,
  majority: Majority,
  settings: Pick<AssemblySettings, "denominator" | "tieRule">,
): VoteResult {
  if (vote.method === "assent") return "approved";
  const outcome = computeVoteOutcome(
    {
      inFavor: vote.inFavor ?? 0,
      against: vote.against ?? 0,
      abstentions: vote.abstentions ?? 0,
      blank: vote.blank ?? 0,
      invalid: vote.invalid ?? 0,
      present: vote.present ?? null,
    },
    majority,
    settings,
  );
  if (outcome.inconsistent) {
    fail(422, "Los votos emitidos superan a los miembros presentes", {
      // Same shape as the amendment votes (evaluateVoteInput).
      reasons: [{ index: -1, reason: "inconsistent_counts" }],
    });
  }
  if (outcome.result === "tie") {
    fail(409, "Empate: hay que repetir la votación", { tie: true });
  }
  return outcome.result;
}

/**
 * The final vote on the whole text (session:moderate).
 *
 * - An approved totality return (devolución) sends the text back: there is
 *   nothing left to vote, 409 `{ totalityReturn: id }` (RFAG 2026 art. 23ter).
 * - Every amendment must be decided first: 409 `{ undecided: ids }`.
 * - Approved amendments are consolidated over the base in approval order, or
 *   in `body.order`, which must list exactly those amendments. Conflicts
 *   answer 409 `{ conflicts }` and nothing is stored.
 * - The vote is stored and linked as `finalVoteId` whatever its result, which
 *   closes the amendments of the document. When approved, a structured text
 *   gets its `consolidated` version. The live projection shows the vote.
 * - DELETE .../final-vote annuls it (annulFinalVote).
 */
export async function recordFinalVote(
  ctx: DocumentRouteContext,
  body: FinalVoteBody,
): Promise<DocumentDto> {
  const { actor, assembly } = ctx;
  if (!canModerate(actor))
    fail(403, "No tienes permiso para registrar votaciones");
  if (assembly.status === "draft" || assembly.status === "closed") {
    fail(409, "La asamblea no está en curso");
  }

  await db.transaction(async (tx) => {
    // The projection shows the vote: assembly before document ("Row locks").
    await shareLockAssembly(tx, assembly.id);
    const document = await lockDocument(tx, ctx.document.id);
    if (document.status !== "published")
      fail(409, "El documento no está publicado");
    if (!document.voted) fail(409, "Este documento no se somete a votación");
    if (document.finalVoteId) fail(409, "El documento ya se ha votado");

    const majority = body.vote.majority ?? document.majority;
    const result = evaluateFinalVote(
      body.vote,
      majority,
      assemblySettings(assembly),
    );

    const rows = await tx
      .select({
        id: amendments.id,
        kind: amendments.kind,
        status: amendments.status,
        ops: amendments.ops,
        number: amendments.number,
        decidedAt: amendments.decidedAt,
        createdAt: amendments.createdAt,
      })
      .from(amendments)
      .where(eq(amendments.documentId, document.id));
    const totalityReturn = rows.find(
      (row) => row.status === "approved" && row.kind === "totality_return",
    );
    if (totalityReturn) {
      fail(409, "Se ha aprobado la devolución del texto", {
        totalityReturn: totalityReturn.id,
      });
    }
    const undecided = rows
      .filter((row) => row.status === "submitted")
      .map((row) => row.id);
    if (undecided.length > 0) {
      fail(409, "Quedan enmiendas sin decidir", { undecided });
    }

    const approved = rows
      .filter((row) => row.status === "approved")
      .sort(
        (a, b) =>
          (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0) ||
          (a.number ?? Number.MAX_SAFE_INTEGER) -
            (b.number ?? Number.MAX_SAFE_INTEGER) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
    let ordered = approved;
    if (body.order) {
      const byId = new Map(approved.map((row) => [row.id, row]));
      if (
        body.order.length !== approved.length ||
        body.order.some((id) => !byId.has(id))
      ) {
        fail(422, "El orden debe incluir exactamente las enmiendas aprobadas", {
          approvedIds: approved.map((row) => row.id),
        });
      }
      ordered = body.order.map((id) => byId.get(id)!);
    }

    let consolidated: { blocks: Block[]; applied: string[] } | null = null;
    if (document.format === "structured") {
      const base = await loadVersion(document.baseVersionId, tx);
      if (!base) fail(409, "El documento no tiene texto base");
      const outcome = consolidate(
        base.blocks,
        ordered.map((row) => ({ id: row.id, ops: row.ops })),
      );
      if (outcome.conflicts.length > 0) {
        fail(409, "Las enmiendas aprobadas no se pueden aplicar juntas", {
          conflicts: outcome.conflicts,
        });
      }
      consolidated = { blocks: outcome.blocks, applied: outcome.applied };
    }

    const [vote] = await tx
      .insert(votes)
      .values({
        assemblyId: assembly.id,
        subjectType: "document",
        subjectId: document.id,
        method: body.vote.method,
        inFavor: body.vote.inFavor ?? 0,
        against: body.vote.against ?? 0,
        abstentions: body.vote.abstentions ?? 0,
        blank: body.vote.blank ?? 0,
        invalid: body.vote.invalid ?? 0,
        present: body.vote.present ?? null,
        majority,
        result,
        note: body.vote.note ?? null,
        recordedByUserId: actor.user.id,
      })
      .returning();

    let consolidatedVersionId: string | null = null;
    if (result === "approved" && consolidated) {
      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId: document.id,
          number: await nextVersionNumber(tx, document.id),
          kind: "consolidated",
          blocks: consolidated.blocks,
          contentHash: await hashBlocks(consolidated.blocks),
          createdByUserId: actor.user.id,
        })
        .returning({ id: documentVersions.id });
      consolidatedVersionId = version!.id;
    }

    await tx
      .update(documents)
      .set({
        finalVoteId: vote!.id,
        ...(consolidatedVersionId ? { consolidatedVersionId } : {}),
      })
      .where(eq(documents.id, document.id));

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "vote",
      entityId: vote!.id,
      documentId: document.id,
      type: "vote_recorded",
      payload: { subjectType: "document", subjectId: document.id, result },
      actor,
    });
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: document.id,
      documentId: document.id,
      type: "document_voted",
      payload: {
        voteId: vote!.id,
        result,
        method: vote!.method,
        majority,
        inFavor: vote!.inFavor,
        against: vote!.against,
        abstentions: vote!.abstentions,
        blank: vote!.blank,
        invalid: vote!.invalid,
        present: vote!.present,
        consolidatedVersionId,
        appliedAmendmentIds:
          result === "approved" ? (consolidated?.applied ?? []) : [],
      },
      actor,
    });
    await pointLiveVote(tx, {
      assemblyId: assembly.id,
      voteId: vote!.id,
      actor,
      subject: {
        documentId: document.id,
        agendaItemId: document.agendaItemId,
        amendmentId: null,
      },
    });
  });

  return loadDocumentDto(assembly, ctx.document.id, actor);
}

/**
 * Annuls a wrongly recorded final vote (session:moderate, assembly not
 * closed), with the optimistic lock on the document. The vote row and the
 * consolidated version stay for the record; the document loses `finalVoteId`
 * and `consolidatedVersionId`, so its amendments can be decided (or
 * reopened) and the final vote taken again. Records `final_vote_annulled` and
 * stops projecting the vote.
 */
export async function annulFinalVote(
  ctx: DocumentRouteContext,
  body: FinalVoteAnnulBody,
): Promise<DocumentDto> {
  const { actor, assembly } = ctx;
  if (!canModerate(actor))
    fail(403, "No tienes permiso para anular votaciones");
  if (assembly.status === "closed") fail(409, "La asamblea ya está cerrada");

  await db.transaction(async (tx) => {
    // The projection may stop showing the vote: assembly before document.
    await shareLockAssembly(tx, assembly.id);
    const document = await lockDocument(tx, ctx.document.id);
    assertOptimisticLock(
      body.updatedAt,
      document.updatedAt,
      STALE_DOCUMENT_MESSAGE,
    );
    if (!document.finalVoteId) {
      fail(409, "El documento no tiene votación final");
    }
    const [vote] = await tx
      .select({ id: votes.id, result: votes.result })
      .from(votes)
      .where(eq(votes.id, document.finalVoteId));

    await tx
      .update(documents)
      .set({ finalVoteId: null, consolidatedVersionId: null })
      .where(eq(documents.id, document.id));

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: document.id,
      documentId: document.id,
      type: "final_vote_annulled",
      payload: {
        voteId: document.finalVoteId,
        result: vote?.result ?? null,
        consolidatedVersionId: document.consolidatedVersionId,
        note: body.note ?? null,
      },
      actor,
    });
    await clearLiveVote(tx, {
      assemblyId: assembly.id,
      voteId: document.finalVoteId,
      actor,
    });
  });

  return loadDocumentDto(assembly, ctx.document.id, actor);
}

// History -------------------------------------------------------------------

/**
 * Ids of the document's amendments, split by whether the actor can see them,
 * using the same rules as the amendment endpoints. `notes` holds the ones
 * whose correction notes the actor may read: their authors, creator and
 * parties, the Secretaría and the Mesa.
 */
export async function loadAmendmentVisibility(
  actor: Actor,
  document: Pick<DocumentRow, "id">,
  executor: Executor = db,
): Promise<{ all: Set<string>; visible: Set<string>; notes: Set<string> }> {
  const rows = await loadAmendmentVisibilityRows(
    executor,
    eq(amendments.documentId, document.id),
  );
  const privileged = seesAllPresentedAmendments(actor);
  const all = new Set<string>();
  const visible = new Set<string>();
  const notes = new Set<string>();
  for (const row of rows) {
    all.add(row.id);
    if (canSeeAmendment(actor, row)) visible.add(row.id);
    if (privileged || isAmendmentInsider(actor, row)) notes.add(row.id);
  }
  return { all, visible, notes };
}

/**
 * Procedural decisions as the actor may read them (filterDecisionsByAmendment):
 * an admission decision only names the amendments the actor can see, with the
 * same rules as the amendment endpoints (the document must be visible too),
 * and is left out when it names none. The decisions themselves come from
 * loadDecisionDtos.
 */
export async function filterVisibleDecisions(
  actor: Actor,
  assembly: AssemblyRow,
  list: DecisionDto[],
  executor: Executor = db,
): Promise<DecisionDto[]> {
  const subjectIds = decisionAmendmentIds(list);
  if (subjectIds.length === 0) return list;

  const [documentRows, rows] = await Promise.all([
    executor
      .select({
        id: documents.id,
        status: documents.status,
        proponentMemberId: documents.proponentMemberId,
        submittedByUserId: documents.submittedByUserId,
      })
      .from(documents)
      .where(eq(documents.assemblyId, assembly.id))
      .then((list) => withCoProponentIds(list, executor)),
    loadAmendmentVisibilityRows(executor, inArray(amendments.id, subjectIds)),
  ]);
  const visibleDocuments = new Set(
    documentRows
      .filter((row) => canSeeDocument(actor, row))
      .map((row) => row.id),
  );
  const visible = new Set(
    rows
      .filter(
        (row) =>
          visibleDocuments.has(row.documentId) && canSeeAmendment(actor, row),
      )
      .map((row) => row.id),
  );
  return filterDecisionsByAmendment(list, (id) => visible.has(id));
}

/** Whether the actor sees proponent positions on this document's amendments. */
export function documentPositionsVisible(ctx: DocumentRouteContext): boolean {
  return canSeePositions(ctx.actor, {
    settings: assemblySettings(ctx.assembly),
    assemblyStatus: ctx.assembly.status,
    isPresenter: isDocumentPresenter(ctx.actor, ctx.document),
  });
}

/**
 * History of the document and of the amendments the actor can see, oldest
 * first. Correction notes are removed for those who may not read them
 * (redactCorrectionNote). Amendment payloads are otherwise returned as
 * stored: the caller redacts positions (see redactAmendmentEventPayload) when
 * they are hidden.
 */
export async function loadDocumentHistory(
  ctx: DocumentRouteContext,
): Promise<EventDto[]> {
  const { actor, assembly, document } = ctx;
  const { all, visible, notes } = await loadAmendmentVisibility(
    actor,
    document,
  );
  const documentNotes = canSeeDocumentCorrection(actor, document);

  const scope = [
    and(eq(events.entityType, "document"), eq(events.entityId, document.id)),
  ];
  if (all.size > 0) {
    scope.push(
      and(
        eq(events.entityType, "amendment"),
        inArray(events.entityId, [...all]),
      ),
    );
  }

  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      entityType: events.entityType,
      entityId: events.entityId,
      payload: events.payload,
      createdAt: events.createdAt,
      // The intranet's name (role sync), not the Google display name.
      actorName: sql<
        string | null
      >`coalesce(${users.externalName}, ${users.name})`,
      memberId: members.id,
      memberAcronym: members.acronym,
      memberName: members.name,
      memberKind: members.kind,
    })
    .from(events)
    .leftJoin(users, eq(users.id, events.actorUserId))
    .leftJoin(members, eq(members.id, events.actorMemberId))
    .where(and(eq(events.assemblyId, assembly.id), or(...scope)))
    .orderBy(asc(events.createdAt), asc(events.id));

  return rows
    .filter(
      (row) => row.entityType !== "amendment" || visible.has(row.entityId),
    )
    .map((row) => ({
      id: row.id,
      type: row.type,
      entityType: row.entityType,
      entityId: row.entityId,
      payload: redactCorrectionNote(
        row.type,
        row.payload ?? {},
        row.entityType === "amendment"
          ? notes.has(row.entityId)
          : documentNotes,
      ),
      actorName: row.actorName,
      actorMember:
        row.memberId && row.memberAcronym && row.memberName && row.memberKind
          ? {
              id: row.memberId,
              acronym: row.memberAcronym,
              name: row.memberName,
              kind: row.memberKind,
            }
          : null,
      createdAt: row.createdAt.toISOString(),
    }));
}

// Uploads -------------------------------------------------------------------

export interface UploadedFile {
  data: Buffer;
  filename: string;
  type: string;
  /** Plain (non-file) multipart fields, such as `updatedAt`. */
  fields: Record<string, string>;
}

/**
 * Reads the multipart field `file`, rejecting bodies over `maxBytes` before
 * buffering them when the client declares a length.
 */
export async function readUploadedFile(
  event: H3Event,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<UploadedFile> {
  const declared = Number(getRequestHeader(event, "content-length") ?? 0);
  // Multipart framing adds a few hundred bytes around the file.
  if (declared > maxBytes + 64 * 1024) fail(413, tooLargeMessage);
  const parts = await readMultipartFormData(event);
  const file = parts?.find(
    (part) => part.name === "file" && part.filename !== undefined,
  );
  if (!file || !file.data || file.data.length === 0) {
    fail(400, "Campo 'file' requerido");
  }
  if (file.data.length > maxBytes) fail(413, tooLargeMessage);

  const fields: Record<string, string> = {};
  for (const part of parts ?? []) {
    if (part.name && part.filename === undefined && part.data.length <= 1_000) {
      fields[part.name] = part.data.toString("utf8");
    }
  }
  return {
    data: file.data,
    filename: file.filename ?? "",
    type: file.type ?? "",
    fields,
  };
}

export const PDF_MAX_BYTES = 20 * 1024 * 1024;
const PDF_MIME_TYPES = ["application/pdf"];

/** Public path of stored PDFs, served by /api/uploads/documents/[filename]. */
export const PDF_URL_PREFIX = "/api/uploads/documents/";
export const STORED_PDF_NAME =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.pdf$/;

/** Display name of an uploaded file: no path, no control characters. */
export function cleanFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F"]/g, "")
    .trim()
    .slice(0, 200);
  return cleaned || fallback;
}

/** Validates type and signature of a PDF and stores it under a random name. */
export async function storePdf(
  file: UploadedFile,
): Promise<{ fileUrl: string; fileName: string }> {
  if (!PDF_MIME_TYPES.includes(file.type)) {
    fail(415, "Solo se admiten archivos PDF");
  }
  if (file.data.subarray(0, 5).toString("ascii") !== "%PDF-") {
    fail(415, "El archivo no parece ser un PDF válido");
  }
  const storedName = `${randomUUID()}.pdf`;
  const directory = getUploadDir();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, storedName), file.data);
  return {
    fileUrl: `${PDF_URL_PREFIX}${storedName}`,
    fileName: cleanFileName(file.filename, "documento.pdf"),
  };
}

/** Best-effort removal of a stored PDF that no document points to any more. */
export async function removeStoredPdf(
  fileUrl: string | null | undefined,
): Promise<void> {
  if (!fileUrl?.startsWith(PDF_URL_PREFIX)) return;
  const name = fileUrl.slice(PDF_URL_PREFIX.length);
  if (!STORED_PDF_NAME.test(name)) return;
  try {
    await unlink(join(getUploadDir(), name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logError("documents.removeStoredPdf", error);
    }
  }
}

/** The PDF that was voted cannot be replaced. */
export function assertFileReplaceable(
  document: Pick<DocumentRow, "finalVoteId">,
): void {
  if (document.finalVoteId) {
    fail(409, "El documento ya se ha votado y su PDF no se puede sustituir");
  }
}

/**
 * Attaches the PDF of a `file` document: managers until the final vote,
 * presenters while it is a draft. Before publication the previous file is
 * removed once the change commits. Once published, the previous file is kept
 * on disk and recorded in the event (`previousFileUrl`, `previousFileName`),
 * since delegates may have read it. An optional multipart field `updatedAt`
 * enables the optimistic lock.
 */
export async function attachDocumentFile(
  ctx: DocumentRouteContext,
  file: UploadedFile,
): Promise<DocumentDto> {
  const { actor, assembly } = ctx;
  requireDocumentEditor(actor, ctx.document);
  if (ctx.document.format !== "file") {
    fail(409, "Este documento no es de tipo PDF");
  }
  assertFileReplaceable(ctx.document);
  const updatedAt = file.fields.updatedAt?.trim() || undefined;
  if (updatedAt && Number.isNaN(new Date(updatedAt).getTime())) {
    fail(400, "Datos no válidos");
  }

  const stored = await storePdf(file);
  let previous: { fileUrl: string | null; keep: boolean };
  try {
    previous = await db.transaction(async (tx) => {
      const current = await lockDocument(tx, ctx.document.id);
      assertOptimisticLock(
        updatedAt,
        current.updatedAt,
        STALE_DOCUMENT_MESSAGE,
      );
      requireDocumentEditor(actor, current);
      assertFileReplaceable(current);
      const keep = current.publishedAt !== null && current.fileUrl !== null;
      await tx
        .update(documents)
        .set({ fileUrl: stored.fileUrl, fileName: stored.fileName })
        .where(eq(documents.id, current.id));
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "document",
        entityId: current.id,
        documentId: current.id,
        type: "document_file_uploaded",
        payload: {
          fileName: stored.fileName,
          replaced: current.fileUrl !== null,
          ...(keep
            ? {
                previousFileUrl: current.fileUrl,
                previousFileName: current.fileName,
              }
            : {}),
        },
        actor,
      });
      return { fileUrl: current.fileUrl, keep };
    });
  } catch (error) {
    await removeStoredPdf(stored.fileUrl);
    throw error;
  }

  if (
    previous.fileUrl &&
    !previous.keep &&
    previous.fileUrl !== stored.fileUrl
  ) {
    await removeStoredPdf(previous.fileUrl);
  }
  return loadDocumentDto(assembly, ctx.document.id, actor);
}
