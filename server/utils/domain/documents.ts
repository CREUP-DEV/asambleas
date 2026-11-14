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
  documentFiles,
  documentImages,
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
  canManageAssemblies,
  canManageDocuments,
  canModerate,
  requireActor,
  type Actor,
} from "./actor";
import { applyAcceptedAmendmentsRule } from "./acceptedRule";
import {
  bindAutoItem,
  findRemovableAutoItem,
  insertAutoItem,
  lockAssembly,
  removeAutoItem,
  syncAutoItemTitle,
  unbindAutoItem,
  withholdItemTitles,
} from "./agendaWrites";
import { diffChanges, sortedIds } from "./changes";
import { recordEvent } from "./events";
import { loadExecutiveMask, resolveBodyMembers } from "./executiveMembers";
import { withHeadcount } from "./headcounts";
import {
  impersonatedByFor,
  loadImpersonators,
  seesImpersonator,
} from "./impersonators";
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
  redactDocumentChanges,
  redactEventActor,
  redactPayloadMembers,
  redactPresenters,
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
import {
  AUTO_ITEM_REFUSED_REASON,
  isAutoItem,
  itemAcceptsKind,
  SUBMISSION_KIND_REFUSED_REASON,
} from "~~/shared/utils/agendaSubmissions";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { hashContent } from "~~/shared/utils/diff";
import {
  FILE_FORMAT_REFUSED_REASON,
  fileFormatRefused,
} from "~~/shared/utils/documentFormat";
import { barredPresenters } from "~~/shared/utils/presenterKinds";
import { pickDocumentSlug, slugify } from "~~/shared/utils/slug";
import { computeVoteOutcome } from "~~/shared/utils/votes";

/**
 * The document API (docs/api.md, "Documents"). Handlers resolve the route
 * with `resolveDocumentRoute`, parse the body and call one function of this
 * module. Never import from ./amendments here: it imports this module.
 */

type AssemblyRow = typeof assemblies.$inferSelect;
type AgendaItemRow = typeof agendaItems.$inferSelect;
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

/** What the presentation rules read of the agenda item a document hangs from. */
export interface PresentationItem {
  acceptsSubmissions: boolean;
  /** Set on an automatic sub-item (isAutoItem). */
  generatedForDocumentId: string | null;
}

/**
 * Whether the Secretaría expects this document from its member rather than
 * the member choosing to present it: it has an internal deadline (`dueAt`),
 * or it hangs from an agenda item that does not accept submissions, where
 * only a manager could have created it (a CEA report, say). An automatic
 * sub-item takes no submissions itself but exists because a document was
 * presented under an item that does, so it never makes a document expected.
 */
export function isExpectedDocument(
  document: Pick<DocumentRow, "dueAt">,
  item: PresentationItem,
): boolean {
  if (document.dueAt !== null) return true;
  return !item.acceptsSubmissions && !isAutoItem(item);
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
  item: PresentationItem,
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

/**
 * Why a document cannot be deleted, or null when it can. A final vote settled
 * it (annul the vote first). Once published, its amendments are other
 * members' work that would go with it, so a published document with any
 * amendment (drafts included) is withdrawn instead; one without them, and
 * any document never published, can go.
 */
export function deleteBlocker(
  document: Pick<
    DocumentRow,
    "status" | "baseVersionId" | "publishedAt" | "finalVoteId"
  >,
  hasAmendments: boolean,
): string | null {
  if (document.finalVoteId) {
    return "El documento ya se ha votado: anula la votación final antes de eliminarlo";
  }
  if (isTextFrozen(document) && hasAmendments) {
    return "No se puede eliminar un documento publicado que tiene enmiendas: retíralo en su lugar";
  }
  return null;
}

export function documentCapabilities(
  actor: Actor,
  assembly: Pick<AssemblyRow, "status">,
  document: PresentedDocumentRow,
  window: AmendmentWindow,
  /** Any amendment row at all, drafts and other members' included. */
  hasAmendments: boolean,
  now = new Date(),
): DocumentCapabilities {
  return {
    edit: canEditDocument(actor, document) && !isTextFrozen(document),
    manage: canManageDocuments(actor),
    publish: canManageDocuments(actor) && isPublishable(document),
    delete:
      canManageDocuments(actor) &&
      deleteBlocker(document, hasAmendments) === null,
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
    /**
     * Any amendment row at all, drafts included; null for an actor who is
     * not told (see DocumentSummaryDto.hasAmendments).
     */
    hasAmendments: boolean | null;
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
    hasAmendments: extra.hasAmendments,
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
  /** Any amendment row, visible to the actor or not (deleteBlocker). */
  hasAmendments: boolean;
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
      hasAmendments: seesAmendmentExistence(actor) ? input.hasAmendments : null,
      window: documentWindow(document, milestones, now),
      hasContent: input.hasContent,
      showCorrection: canSeeDocumentCorrection(actor, document),
    }),
    summary: document.summary,
    // A PDF left behind by a switch to text is not the document's.
    fileUrl: document.format === "file" ? document.fileUrl : null,
    fileName: document.format === "file" ? document.fileName : null,
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
    can: documentCapabilities(
      actor,
      assembly,
      document,
      window,
      input.hasAmendments,
      now,
    ),
  };
}

// Loaders -------------------------------------------------------------------

/** An amendment with what `canSeeAmendment` needs to judge it. */
interface AmendmentVisibilityRow extends AmendmentVisibilityContext {
  id: string;
  documentId: string;
}

/**
 * Loads the amendments matching `where` with their authors and parties, and
 * the presenters of their documents.
 */
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
      validatedAt: amendments.validatedAt,
      createdByUserId: amendments.createdByUserId,
      proponentMemberId: documents.proponentMemberId,
    })
    .from(amendments)
    .innerJoin(documents, eq(documents.id, amendments.documentId))
    .where(where);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [authorRows, partyRows, sourceAuthors, coProponents] =
    await Promise.all([
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
      loadCoProponentIds(
        [...new Set(rows.map((row) => row.documentId))],
        executor,
      ),
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
  return rows.map(({ proponentMemberId, ...row }) => ({
    ...row,
    documentPresenters: {
      proponentMemberId,
      coProponentMemberIds: coProponents.get(row.documentId) ?? [],
    },
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

/**
 * Who is told whether a document has any amendment at all, unpublished
 * drafts included (DocumentSummaryDto.hasAmendments): those who delete
 * documents or agenda items, which is what it blocks.
 */
export function seesAmendmentExistence(actor: Actor): boolean {
  return canManageDocuments(actor) || canManageAssemblies(actor);
}

/** The documents with any amendment row, of any status. */
export async function loadAmendedDocumentIds(
  executor: Executor,
  documentIds: string[],
): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const rows = await executor
    .selectDistinct({ documentId: amendments.documentId })
    .from(amendments)
    .where(inArray(amendments.documentId, documentIds));
  return new Set(rows.map((row) => row.documentId));
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
  const [counts, content, coProponents, amended] = await Promise.all([
    countVisibleAmendments(actor, ids, executor),
    loadContentFlags(executor, rows),
    loadCoProponents(ids, executor),
    seesAmendmentExistence(actor)
      ? loadAmendedDocumentIds(executor, ids)
      : Promise.resolve(null),
  ]);
  return rows.map(({ proponent, ...document }) => {
    const co = coProponents.get(document.id) ?? [];
    return toDocumentSummaryDto(document, {
      // An executive area reads as "CEA" to whoever may not see the areas.
      ...redactPresenters(actor, memberRefOrNull(proponent), co),
      amendmentCount: counts.get(document.id) ?? 0,
      hasAmendments: amended ? amended.has(document.id) : null,
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
  const [counts, content, anyAmendment] = await Promise.all([
    countVisibleAmendments(actor, [document.id], executor),
    loadContentFlags(executor, [document]),
    hasAnyAmendment(executor, document.id),
  ]);
  return toDocumentDto({
    actor,
    assembly,
    document,
    milestones,
    ...redactPresenters(actor, memberRefOrNull(proponent), coProponents),
    amendmentCount: counts.get(document.id) ?? 0,
    hasAmendments: anyAmendment,
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
/**
 * A member given a document as its new main presenter: it must exist and be
 * active. A member the roster sync deactivated has no account acting for it,
 * so nobody could prepare or send the document (the same rule as linking an
 * account, PUT /api/admin/users/[id]/member). Presenters that were already
 * set are never checked again.
 */
export async function requireMember(memberId: string, executor: Executor = db) {
  const [member] = await executor
    .select({ id: members.id, active: members.active })
    .from(members)
    .where(eq(members.id, memberId));
  if (!member) fail(422, "El miembro indicado no existe");
  if (!member.active) fail(422, "El miembro indicado está dado de baja");
  return member;
}

/** Every new co-presenter must exist and be active (see requireMember). */
export async function requireMembers(
  memberIds: readonly string[],
  executor: Executor = db,
): Promise<void> {
  if (memberIds.length === 0) return;
  const rows = await executor
    .select({ id: members.id, active: members.active })
    .from(members)
    .where(inArray(members.id, [...memberIds]));
  if (rows.length !== new Set(memberIds).size) {
    fail(422, "Algún miembro indicado no existe");
  }
  if (rows.some((row) => !row.active)) {
    fail(422, "Algún miembro indicado está dado de baja");
  }
}

/**
 * Every presenter (main or co-presenter) may present a document of this kind
 * (memberMayPresent): a sectorial never presents an internal motion. Applies
 * to managers too, since the rule is the member's, not the account's.
 */
export async function requirePresentersMayPresent(
  kind: DocumentKind,
  memberIds: readonly (string | null)[],
  executor: Executor = db,
): Promise<void> {
  const ids = [...new Set(memberIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  const rows = await executor
    .select({ acronym: members.acronym, kind: members.kind })
    .from(members)
    .where(inArray(members.id, ids));
  const barred = barredPresenters(kind, rows);
  if (barred.length > 0) {
    fail(
      422,
      `Las sectoriales no pueden presentar mociones internas: ${barred
        .map((member) => member.acronym)
        .sort()
        .join(", ")} no puede estar entre quienes la presentan`,
      { reason: "presenter_kind" },
    );
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

/**
 * slugify(title), unique within the assembly (pickDocumentSlug). Serialized
 * per assembly with an advisory lock held until the transaction ends; the
 * slug recalculation (`drizzle/reslug-documents.ts`) takes the same one.
 */
export async function uniqueDocumentSlug(
  executor: Executor,
  assemblyId: string,
  title: string,
): Promise<string> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`document_slug:${assemblyId}`}))`,
  );
  // Only the slugs pickDocumentSlug may compare with: the title's and its -n.
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
  return pickDocumentSlug(title, new Set(rows.map((row) => row.slug)));
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
    "format",
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

/** What a member reads when the item does not take the kind (itemAcceptsKind). */
export const SUBMISSION_KIND_REFUSED_MESSAGE =
  "Este punto del orden del día no admite documentos de este tipo";

/** A member presents under an item only what the item takes. */
export function requireSubmissionTarget(
  item: Pick<AgendaItemRow, "acceptsSubmissions" | "submissionKinds">,
  kind: DocumentKind,
): void {
  if (!item.acceptsSubmissions) {
    fail(
      403,
      "Este punto del orden del día no admite documentos de los miembros",
    );
  }
  if (!itemAcceptsKind(item, kind)) {
    fail(422, SUBMISSION_KIND_REFUSED_MESSAGE, {
      reason: SUBMISSION_KIND_REFUSED_REASON,
    });
  }
}

/** What anyone reads when the item chosen is another document's sub-item. */
export const AUTO_ITEM_REFUSED_MESSAGE =
  "Este subpunto es el de otro documento. Elige otro punto";

/**
 * Nobody, managers included, puts a document in the automatic sub-item of
 * another one: that item carries the other document's title, which may be
 * a draft's, and would show to everyone who sees the newcomer.
 * `documentId` is the document being moved (null when creating one).
 */
export function requireNotOthersAutoItem(
  item: Pick<AgendaItemRow, "generatedForDocumentId">,
  documentId: string | null,
): void {
  if (isAutoItem(item) && item.generatedForDocumentId !== documentId) {
    fail(422, AUTO_ITEM_REFUSED_MESSAGE, { reason: AUTO_ITEM_REFUSED_REASON });
  }
}

/**
 * The agenda item a document moves to, read under the assembly lock so
 * neither an agenda delete nor a change of what the item accepts (both
 * under lockAssembly) can happen between this check and the commit. A
 * member moves a document only to an item that takes its kind.
 */
async function requireAgendaTarget(
  executor: Executor,
  assemblyId: string,
  agendaItemId: string,
  manager: boolean,
  kind: DocumentKind,
  documentId: string,
): Promise<AgendaItemRow> {
  const [item] = await executor
    .select()
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.id, agendaItemId),
        eq(agendaItems.assemblyId, assemblyId),
      ),
    );
  if (!item) fail(404, "Punto no encontrado");
  requireNotOthersAutoItem(item, documentId);
  if (!manager) requireSubmissionTarget(item, kind);
  return item;
}

/**
 * The item whose submission rules bind a document where it hangs now: the
 * item itself, or its parent when the item is the document's automatic
 * sub-item. Null when no such item exists.
 */
async function loadSubmissionContainer(
  executor: Executor,
  document: Pick<DocumentRow, "id" | "agendaItemId">,
): Promise<AgendaItemRow | null> {
  const [item] = await executor
    .select()
    .from(agendaItems)
    .where(eq(agendaItems.id, document.agendaItemId));
  if (!item) return null;
  if (item.generatedForDocumentId !== document.id || !item.parentId) {
    return item;
  }
  const [parent] = await executor
    .select()
    .from(agendaItems)
    .where(eq(agendaItems.id, item.parentId));
  return parent ?? null;
}

/** What a presenter reads when a PDF is refused (fileFormatRefused). */
export const FILE_FORMAT_REFUSED_MESSAGE =
  "Este tipo de documento admite enmiendas y se presenta como texto en la plataforma. Solo Secretaría puede subirlo en PDF.";

/**
 * Updates the metadata of a document. Presenters may change title, summary,
 * kind, format (text or PDF, until it is published; a PDF only for the types
 * that take no amendments), agenda item and
 * presenters (planPresenters) of their draft;
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

  // An account that does not see the executive areas neither adds nor
  // removes one, and the generic "CEA" id is never a member.
  const named = await resolveBodyMembers(actor, {
    listed: body.coProponentMemberIds,
    named: body.proponentMemberId,
    current: [
      ...(ctx.document.proponentMemberId
        ? [ctx.document.proponentMemberId]
        : []),
      ...ctx.document.coProponentMemberIds,
    ],
    currentMain: ctx.document.proponentMemberId,
    listedCurrent: ctx.document.coProponentMemberIds,
  });
  body = {
    ...body,
    ...(named.listed !== undefined
      ? { coProponentMemberIds: named.listed }
      : {}),
    ...(body.proponentMemberId !== undefined
      ? { proponentMemberId: named.named }
      : {}),
  };

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

  // A move or a new title may write agenda rows: the automatic sub-item of
  // the document is created, removed or renamed with it.
  const writesAgenda =
    (body.agendaItemId !== undefined &&
      body.agendaItemId !== ctx.document.agendaItemId) ||
    (body.title !== undefined && body.title !== ctx.document.title);

  await db.transaction(async (tx) => {
    // Agenda writes take the assembly before the document ("Row locks"), as
    // the agenda endpoints do, so the two serialize: an agenda delete then
    // finds the document under its new item and takes it into account, or
    // the move finds its target gone (requireAgendaTarget).
    if (writesAgenda) await lockAssembly(tx, assembly.id);
    const current = await lockDocument(tx, ctx.document.id);
    assertOptimisticLock(
      body.updatedAt,
      current.updatedAt,
      STALE_DOCUMENT_MESSAGE,
    );
    requireDocumentEditor(actor, current);

    let changed = changedFields(current, body);
    if (changed.length === 0) return;
    // The row changed since it was resolved in a way the optimistic lock
    // did not catch: never write the agenda without the assembly lock.
    if (
      !writesAgenda &&
      (changed.includes("title") || changed.includes("agendaItemId"))
    ) {
      fail(409, STALE_DOCUMENT_MESSAGE);
    }
    // Published text (or PDF) is what amendments and the vote refer to.
    if (changed.includes("format") && isTextFrozen(current)) {
      fail(
        409,
        "El documento ya está publicado: ya no se puede cambiar entre texto y PDF",
      );
    }
    const format = body.format ?? current.format;
    // A presenter never ends with a PDF of a type that takes amendments,
    // by switching the format or by changing the type of a PDF.
    if (
      fileFormatRefused({
        manager,
        current: { kind: current.kind, format: current.format },
        next: {
          kind: changed.includes("kind") ? body.kind! : current.kind,
          format,
        },
      })
    ) {
      fail(422, FILE_FORMAT_REFUSED_MESSAGE, {
        reason: FILE_FORMAT_REFUSED_REASON,
      });
    }
    const nextKind = changed.includes("kind") ? body.kind! : current.kind;
    const patch: Partial<typeof documents.$inferInsert> = {};
    if (changed.includes("title")) patch.title = body.title;
    if (changed.includes("summary")) patch.summary = body.summary ?? null;

    // The automatic sub-item the document leaves behind (removed once it is
    // empty) and the one it gets under an item that accepts submissions.
    // `keptItem` is its automatic sub-item when that one stays because it
    // holds something else: it stops being the document's.
    let leftItem: AgendaItemRow | null = null;
    let keptItem: AgendaItemRow | null = null;
    let newItem: AgendaItemRow | null = null;
    if (changed.includes("agendaItemId")) {
      const target = await requireAgendaTarget(
        tx,
        assembly.id,
        body.agendaItemId!,
        manager,
        nextKind,
        current.id,
      );
      const [here] = await tx
        .select()
        .from(agendaItems)
        .where(eq(agendaItems.id, current.agendaItemId));
      const ownItem =
        here && here.generatedForDocumentId === current.id ? here : null;
      if (
        ownItem &&
        ownItem.parentId === target.id &&
        target.acceptsSubmissions
      ) {
        // Picking the item its own sub-item hangs from moves nothing,
        // whatever else that sub-item holds. Once that item takes no
        // submissions, picking it moves the document up to it, and the
        // sub-item goes as after any move away.
        changed = changed.filter((key) => key !== "agendaItemId");
        if (changed.length === 0) return;
      } else {
        leftItem = await findRemovableAutoItem(tx, current);
        if (!leftItem) keptItem = ownItem;
      }
      if (!changed.includes("agendaItemId")) {
        // Nothing moves.
      } else if (target.acceptsSubmissions) {
        newItem = await insertAutoItem(tx, {
          assemblyId: assembly.id,
          parentId: target.id,
          title: patch.title ?? current.title,
        });
        patch.agendaItemId = newItem.id;
      } else {
        patch.agendaItemId = target.id;
      }
    } else if (!manager && changed.includes("kind")) {
      // A member's document stays of a kind its item takes.
      const container = await loadSubmissionContainer(tx, current);
      if (
        container?.acceptsSubmissions &&
        !itemAcceptsKind(container, nextKind)
      ) {
        fail(422, SUBMISSION_KIND_REFUSED_MESSAGE, {
          reason: SUBMISSION_KIND_REFUSED_REASON,
        });
      }
    }
    if (changed.includes("kind")) {
      patch.kind = body.kind;
      if (!manager) {
        // Presenters always get the defaults of the kind they pick.
        const defaults = DOCUMENT_KIND_DEFAULTS[body.kind!];
        patch.amendable = format === "file" ? false : defaults.amendable;
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
    // The kind and the presenters it ends with: a sectorial never presents
    // an internal motion, whichever of the two changed.
    if (presenters || changed.includes("kind")) {
      const final = presenters ?? current;
      await requirePresentersMayPresent(
        patch.kind ?? current.kind,
        [final.proponentMemberId, ...final.coProponentMemberIds],
        tx,
      );
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

    if (changed.includes("format")) {
      // The draft text and the PDF both stay where they are, so switching
      // back loses nothing; the format says which one the document uses.
      patch.format = format;
      if (format === "file") {
        patch.amendable = false;
      } else if (patch.amendable === undefined) {
        patch.amendable =
          DOCUMENT_KIND_DEFAULTS[patch.kind ?? current.kind].amendable;
      }
      if (format === "structured" && !current.workingVersionId) {
        const [version] = await tx
          .insert(documentVersions)
          .values({
            documentId: current.id,
            number: await nextVersionNumber(tx, current.id),
            kind: "draft",
            blocks: [],
            contentHash: await hashBlocks([]),
            createdByUserId: actor.user.id,
          })
          .returning({ id: documentVersions.id });
        patch.workingVersionId = version!.id;
      }
    }

    if (format === "file" && (patch.amendable ?? current.amendable)) {
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
    if (newItem) {
      await bindAutoItem(tx, {
        assemblyId: assembly.id,
        item: newItem,
        documentId: current.id,
        actor,
      });
    }
    if (leftItem) {
      await removeAutoItem(tx, {
        assemblyId: assembly.id,
        item: leftItem,
        documentId: current.id,
        actor,
      });
    }
    if (keptItem) {
      await unbindAutoItem(tx, {
        assemblyId: assembly.id,
        item: keptItem,
        documentId: current.id,
        actor,
      });
    }
    if (patch.title !== undefined && patch.agendaItemId === undefined) {
      await syncAutoItemTitle(tx, {
        assemblyId: assembly.id,
        document: current,
        title: patch.title,
        actor,
      });
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
          // What was written, kind defaults included; the status has its own
          // event below.
          changes: {
            ...diffChanges(current, {
              ...patch,
              status: undefined,
              workingVersionId: undefined,
            }),
            ...(presenters
              ? diffChanges(
                  {
                    coProponentMemberIds: sortedIds(
                      current.coProponentMemberIds,
                    ),
                  },
                  {
                    coProponentMemberIds: sortedIds(
                      presenters.coProponentMemberIds,
                    ),
                  },
                )
              : {}),
          },
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
        .select({
          acceptsSubmissions: agendaItems.acceptsSubmissions,
          generatedForDocumentId: agendaItems.generatedForDocumentId,
        })
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

/** Whether the document has any amendment row, drafts included. */
export async function hasAnyAmendment(
  executor: Executor,
  documentId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: amendments.id })
    .from(amendments)
    .where(eq(amendments.documentId, documentId))
    .limit(1);
  return row !== undefined;
}

/** What a deleted document leaves on disk, removed once the delete commits. */
export interface DeletedDocumentFiles {
  /** Its PDFs: the current one and the ones it replaced once published. */
  fileUrls: string[];
  images: { id: string; mimeType: string }[];
}

/**
 * Removes a document inside a transaction, whoever asked for it: the
 * projection stops showing it (clearLiveDocument), the votes of its final
 * vote go (their subject would point at nothing), the row goes with its
 * versions, co-presenters, PDFs and images (cascade), and `document_deleted`
 * closes its history. Its automatic sub-item, if it has one left empty,
 * goes too unless `keepAgendaItem` (the agenda delete removes the items
 * itself). An item that carries its title and stays keeps it withheld
 * unless the document was public (withholdItemTitles).
 *
 * The caller checks whether the document may go (deleteBlocker, or the
 * amendments rule of the agenda delete) and holds the assembly lock
 * (lockAssembly) and the document FOR UPDATE, in that order. Returns what
 * to remove from disk after the commit (removeStoredPdf, removeImageFiles).
 */
export async function removeDocument(
  tx: Executor,
  input: {
    assemblyId: string;
    document: PresentedDocumentRow;
    actor: Actor;
    keepAgendaItem?: boolean;
  },
): Promise<DeletedDocumentFiles> {
  const { assemblyId, document, actor } = input;
  const autoItem = input.keepAgendaItem
    ? null
    : await findRemovableAutoItem(tx, document);
  const images = await tx
    .select({ id: documentImages.id, mimeType: documentImages.mimeType })
    .from(documentImages)
    .where(eq(documentImages.documentId, document.id));
  const files = await tx
    .select({ storedName: documentFiles.storedName })
    .from(documentFiles)
    .where(eq(documentFiles.documentId, document.id));
  const fileUrls = [
    ...new Set([
      ...(document.fileUrl ? [document.fileUrl] : []),
      ...files.map((file) => `${PDF_URL_PREFIX}${file.storedName}`),
    ]),
  ];
  await clearLiveDocument(tx, {
    assemblyId,
    documentId: document.id,
    actor,
  });
  await tx
    .delete(votes)
    .where(
      and(eq(votes.subjectType, "document"), eq(votes.subjectId, document.id)),
    );
  // Before the row goes and its foreign keys clear the links.
  await withholdItemTitles(tx, {
    assemblyId,
    document,
    // With keepAgendaItem the caller deletes the item it hangs from.
    exceptItemId: input.keepAgendaItem
      ? document.agendaItemId
      : (autoItem?.id ?? null),
    actor,
  });
  await tx.delete(documents).where(eq(documents.id, document.id));
  await recordEvent(tx, {
    assemblyId,
    entityType: "document",
    entityId: document.id,
    documentId: document.id,
    type: "document_deleted",
    // An explicit allowlist (never the correction note): enough to say
    // what was deleted and to tell its presenters once the row is gone.
    payload: {
      title: document.title,
      kind: document.kind,
      format: document.format,
      reference: document.reference,
      status: document.status,
      agendaItemId: document.agendaItemId,
      proponentMemberId: document.proponentMemberId,
      coProponentMemberIds: document.coProponentMemberIds,
      submittedByUserId: document.submittedByUserId,
    },
    actor,
  });
  if (autoItem) {
    await removeAutoItem(tx, {
      assemblyId,
      item: autoItem,
      documentId: document.id,
      actor,
    });
  }
  return { fileUrls, images };
}

/**
 * The documents under these agenda items, locked FOR UPDATE in id order
 * (after the assembly, "Row locks"), with their co-presenters and how many
 * amendment rows of any status each one has. For the agenda delete, which
 * removes them all or none.
 */
export async function lockDocumentsUnder(
  tx: Executor,
  agendaItemIds: string[],
): Promise<{ document: PresentedDocumentRow; amendments: number }[]> {
  if (agendaItemIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(documents)
    .where(inArray(documents.agendaItemId, agendaItemIds))
    .orderBy(asc(documents.id))
    .for("update");
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [coProponents, totals] = await Promise.all([
    loadCoProponentIds(ids, tx),
    tx
      .select({ documentId: amendments.documentId, total: count() })
      .from(amendments)
      .where(inArray(amendments.documentId, ids))
      .groupBy(amendments.documentId),
  ]);
  const amendmentTotals = new Map(
    totals.map((row) => [row.documentId, Number(row.total)]),
  );
  return rows.map((row) => ({
    document: {
      ...row,
      coProponentMemberIds: coProponents.get(row.id) ?? [],
    },
    amendments: amendmentTotals.get(row.id) ?? 0,
  }));
}

/**
 * Deletes a document (document:manage) unless deleteBlocker refuses it: a
 * final vote, or a published text with amendments. What goes with it is in
 * removeDocument; the events stay in the history, closed by
 * `document_deleted`.
 *
 * The assembly is locked first: the delete may clear the live projection
 * and remove the document's automatic sub-item, an agenda write. The
 * document is locked FOR UPDATE before counting its amendments: an
 * amendment insert takes FOR KEY SHARE on it, so one in flight finishes
 * first and is counted, and one that starts later fails its foreign key.
 * Returns the image files to remove (removeImageFiles); the PDF is already
 * removed.
 */
export async function deleteDocument(
  ctx: DocumentRouteContext,
): Promise<{ success: true; images: DeletedDocumentFiles["images"] }> {
  const { actor, assembly } = ctx;
  if (!canManageDocuments(actor)) {
    fail(403, "No tienes permiso para eliminar documentos");
  }

  const files = await db.transaction(async (tx) => {
    await lockAssembly(tx, assembly.id);
    const current = await lockDocument(tx, ctx.document.id, "update");
    const blocker = deleteBlocker(
      current,
      await hasAnyAmendment(tx, current.id),
    );
    if (blocker) fail(409, blocker);
    return removeDocument(tx, {
      assemblyId: assembly.id,
      document: current,
      actor,
    });
  });

  for (const fileUrl of files.fileUrls) await removeStoredPdf(fileUrl);
  return { success: true, images: files.images };
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
 *    move the live projection from a document or amendment path, NO KEY
 *    UPDATE in lockAssembly (agenda, calendar, PUT .../live-state, and the
 *    document paths that may write agenda rows: creating a document,
 *    deleting one, and updateDocument when it moves or renames one, so they
 *    serialize with an agenda delete);
 * 2. the document: NO KEY UPDATE, or FOR SHARE in the amendment paths
 *    (lockDocument here and in amendments.ts);
 * 3. amendment rows, in id order (lockAmendments in amendments.ts);
 * 4. acceptance rows;
 * 5. the live_state row (lockLiveState, the PUT .../live-state upsert).
 *
 * Explicit locks are NO KEY UPDATE or FOR SHARE, never FOR UPDATE, except on
 * a row the transaction deletes (deleteDocument, and the agenda delete, which
 * locks the documents it removes after the assembly, in id order). The foreign
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

/**
 * Stops projecting a document that is being deleted, keeping its agenda item
 * on screen. Without it the foreign key would clear the pointer silently and
 * the live views would keep showing the document. Records `live_changed`.
 */
async function clearLiveDocument(
  tx: Executor,
  input: { assemblyId: string; documentId: string; actor: Actor },
): Promise<void> {
  const previous = await lockLiveState(tx, input.assemblyId);
  if (!previous || previous.documentId !== input.documentId) return;
  await writeLiveState(
    tx,
    input.assemblyId,
    previous,
    { ...previous, documentId: null, amendmentId: null, voteId: null },
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
 *   nothing left to vote, 409 `{ totalityReturn: id }`.
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
  // The members present come from the Mesa's latest headcount unless typed.
  const based = await withHeadcount(
    assembly.id,
    body.vote,
    assemblySettings(assembly),
  );
  const vote = based.vote;

  await db.transaction(async (tx) => {
    // The projection shows the vote: assembly before document ("Row locks").
    await shareLockAssembly(tx, assembly.id);
    const document = await lockDocument(tx, ctx.document.id);
    if (document.status !== "published")
      fail(409, "El documento no está publicado");
    if (!document.voted) fail(409, "Este documento no se somete a votación");
    if (document.finalVoteId) fail(409, "El documento ya se ha votado");

    const majority = vote.majority ?? document.majority;
    const result = evaluateFinalVote(
      vote,
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

    const [voteRow] = await tx
      .insert(votes)
      .values({
        assemblyId: assembly.id,
        subjectType: "document",
        subjectId: document.id,
        method: vote.method,
        inFavor: vote.inFavor ?? 0,
        against: vote.against ?? 0,
        abstentions: vote.abstentions ?? 0,
        blank: vote.blank ?? 0,
        invalid: vote.invalid ?? 0,
        present: vote.present ?? null,
        headcountId: based.headcountId,
        majority,
        result,
        note: vote.note ?? null,
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
        finalVoteId: voteRow!.id,
        ...(consolidatedVersionId ? { consolidatedVersionId } : {}),
      })
      .where(eq(documents.id, document.id));

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "vote",
      entityId: voteRow!.id,
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
        voteId: voteRow!.id,
        result,
        method: voteRow!.method,
        majority,
        inFavor: voteRow!.inFavor,
        against: voteRow!.against,
        abstentions: voteRow!.abstentions,
        blank: voteRow!.blank,
        invalid: voteRow!.invalid,
        present: voteRow!.present,
        consolidatedVersionId,
        appliedAmendmentIds:
          result === "approved" ? (consolidated?.applied ?? []) : [],
      },
      actor,
    });
    await pointLiveVote(tx, {
      assemblyId: assembly.id,
      voteId: voteRow!.id,
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
 * first. Correction notes, and the field values of document edits, are
 * removed for those who may not read them (redactCorrectionNote,
 * redactDocumentChanges). Amendment payloads are otherwise returned as
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
  // Payloads name members by id: the areas read as one for those who may
  // not see them.
  const mask = await loadExecutiveMask(actor);

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
      actorUserId: events.actorUserId,
      impersonationId: events.impersonationId,
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

  const shown = rows.filter(
    (row) => row.entityType !== "amendment" || visible.has(row.entityId),
  );
  const impersonators = await loadImpersonators(
    shown
      .filter((row) => seesImpersonator(actor, row.actorUserId))
      .map((row) => row.impersonationId),
  );
  return shown.map((row) => ({
    id: row.id,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: redactPayloadMembers(
      mask,
      redactCorrectionNote(
        row.type,
        row.entityType === "amendment"
          ? (row.payload ?? {})
          : redactDocumentChanges(row.type, row.payload ?? {}, documentNotes),
        row.entityType === "amendment"
          ? notes.has(row.entityId)
          : documentNotes,
      ),
    ),
    // Neither the area nor the person who acted for it, for those who may
    // not see the areas.
    ...redactEventActor(actor, {
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
    }),
    impersonatedBy: impersonatedByFor(actor, row, impersonators),
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

/** The name on disk of a stored PDF's URL; null for anything else. */
export function storedPdfName(
  fileUrl: string | null | undefined,
): string | null {
  if (!fileUrl?.startsWith(PDF_URL_PREFIX)) return null;
  const name = fileUrl.slice(PDF_URL_PREFIX.length);
  return STORED_PDF_NAME.test(name) ? name : null;
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
 * presenters while it is a draft. Every PDF gets its `document_files` row.
 * Before publication the previous file goes with its row once the change
 * commits. Once published, the previous file is kept on disk and its row
 * marked replaced (`replacedAt`), since delegates may have read it: document
 * managers still read it (listDocumentFiles), and the event names it
 * (`previousFileId`, `previousFileName`). An optional multipart field
 * `updatedAt` enables the optimistic lock.
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
      await tx.insert(documentFiles).values({
        documentId: current.id,
        storedName: storedPdfName(stored.fileUrl)!,
        fileName: stored.fileName,
        uploadedByUserId: actor.user.id,
      });
      const previousName = storedPdfName(current.fileUrl);
      let previousFileId: string | null = null;
      if (previousName && keep) {
        // A file stored before its row existed gets one now.
        const [row] = await tx
          .insert(documentFiles)
          .values({
            documentId: current.id,
            storedName: previousName,
            fileName: current.fileName ?? previousName,
            replacedAt: new Date(),
            replacedByUserId: actor.user.id,
          })
          .onConflictDoUpdate({
            target: documentFiles.storedName,
            set: { replacedAt: new Date(), replacedByUserId: actor.user.id },
            setWhere: eq(documentFiles.documentId, current.id),
          })
          .returning({ id: documentFiles.id });
        previousFileId = row?.id ?? null;
      } else if (previousName) {
        await tx
          .delete(documentFiles)
          .where(
            and(
              eq(documentFiles.documentId, current.id),
              eq(documentFiles.storedName, previousName),
            ),
          );
      }
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
            ? { previousFileId, previousFileName: current.fileName }
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
