import type { H3Event } from "h3";
import {
  createError,
  getRequestHeader,
  getRouterParam,
  readMultipartFormData,
} from "h3";
import { and, count, eq, inArray, like, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../db";
import {
  amendmentAcceptances,
  amendmentAuthors,
  amendments,
  assemblies,
  assemblyMilestones,
  documents,
  documentVersions,
  members,
  votes,
} from "../../db/schema";
import { getUploadDir } from "../core/uploadPaths";
import {
  actsFor,
  canManageDocuments,
  canModerate,
  requireActor,
  type Actor,
} from "./actor";
import { resolveAssembly, resolveDocument } from "./resolvers";
import {
  canSeeAmendment,
  canSeeDocument,
  canSeePositions,
  isDocumentProponent,
} from "./visibility";
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  DOCUMENT_KIND_DEFAULTS,
  type AssemblySettings,
  type DocumentKind,
  type DocumentStatus,
} from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AmendmentWindowDto,
  DocumentCapabilities,
  DocumentDto,
  DocumentSummaryDto,
  MemberRef,
  VersionDto,
  VoteDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import {
  amendmentWindow,
  isWindowOpen,
  type AmendmentWindow,
  type Milestones,
} from "~~/shared/utils/calendar";
import { hashContent } from "~~/shared/utils/diff";
import { slugify } from "~~/shared/utils/slug";

type AssemblyRow = typeof assemblies.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
type VersionRow = typeof documentVersions.$inferSelect;
type VoteRow = typeof votes.$inferSelect;
type MemberRow = typeof members.$inferSelect;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Statuses from which a document can still be published. */
export const PUBLISHABLE_STATUSES: DocumentStatus[] = ["draft", "submitted"];

// Small helpers -----------------------------------------------------------

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Stored settings merged over the defaults, as every reader must do. */
export function assemblySettings(
  assembly: Pick<AssemblyRow, "settings">,
): AssemblySettings {
  return {
    ...DEFAULT_ASSEMBLY_SETTINGS,
    ...((assembly.settings ?? {}) as Partial<AssemblySettings>),
  };
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
    ): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
  },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos no válidos",
      data: { issues: parsed.error.issues },
    });
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

/** Whether submitted amendments may already be shown to everyone. */
export function isWindowClosed(window: AmendmentWindow, now = new Date()): boolean {
  return Boolean(window.closesAt && now > window.closesAt);
}

/** Whether members may still present documents (documents_close milestone). */
export function documentsDeadlinePassed(milestones: Milestones, now = new Date()): boolean {
  const close = milestones.documents_close;
  return Boolean(close && now > close);
}

// Capabilities --------------------------------------------------------------

/** The actor presents the document: acts for its proponent or created it. */
export function isProponentSide(
  actor: Actor,
  document: Pick<DocumentRow, "proponentMemberId" | "submittedByUserId">,
): boolean {
  return (
    actsFor(actor, [document.proponentMemberId]) ||
    (document.submittedByUserId !== null && document.submittedByUserId === actor.user.id)
  );
}

/**
 * Editors hold document:manage, or present the document while it is still a
 * draft. Managers keep editing metadata after publication (windows, status);
 * the text itself is frozen once a base version exists.
 */
export function canEditDocument(
  actor: Actor,
  document: Pick<DocumentRow, "status" | "proponentMemberId" | "submittedByUserId">,
): boolean {
  if (canManageDocuments(actor)) return true;
  return document.status === "draft" && isProponentSide(actor, document);
}

export function requireDocumentEditor(
  actor: Actor,
  document: Pick<DocumentRow, "status" | "proponentMemberId" | "submittedByUserId">,
): void {
  if (!canEditDocument(actor, document)) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para editar este documento",
    });
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
  document: DocumentRow,
  window: AmendmentWindow,
  now = new Date(),
): DocumentCapabilities {
  return {
    edit: canEditDocument(actor, document) && !isTextFrozen(document),
    publish:
      canManageDocuments(actor) && PUBLISHABLE_STATUSES.includes(document.status),
    amend: canAmendDocument(actor, assembly, document, window, now),
    position:
      document.status === "published" &&
      (isDocumentProponent(actor, document) || canModerate(actor)),
    moderate: canModerate(actor),
  };
}

// Mappers -------------------------------------------------------------------

export function toMemberRef(
  member: Pick<MemberRow, "id" | "acronym" | "name" | "kind"> | null | undefined,
): MemberRef | null {
  if (!member) return null;
  return { id: member.id, acronym: member.acronym, name: member.name, kind: member.kind };
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
    amendmentCount: number;
    window: AmendmentWindowDto;
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
    amendable: document.amendable,
    voted: document.voted,
    majority: document.majority,
    amendmentCount: extra.amendmentCount,
    window: extra.window,
    publishedAt: toIso(document.publishedAt),
    consolidated: document.consolidatedVersionId !== null,
    updatedAt: document.updatedAt.toISOString(),
  };
}

export interface DocumentDtoInput {
  actor: Actor;
  assembly: AssemblyRow;
  document: DocumentRow;
  milestones: Milestones;
  proponent: MemberRef | null;
  amendmentCount: number;
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
      amendmentCount: input.amendmentCount,
      window: documentWindow(document, milestones, now),
    }),
    summary: document.summary,
    fileUrl: document.fileUrl,
    fileName: document.fileName,
    submittedAt: toIso(document.submittedAt),
    // Everyone who can see an unpublished document (its presenters, managers
    // and the Mesa) needs to read its text; editing is governed by can.edit.
    workingVersion:
      !frozen && input.workingVersion ? toVersionDto(input.workingVersion) : null,
    baseVersion: input.baseVersion ? toVersionDto(input.baseVersion) : null,
    consolidatedVersion: input.consolidatedVersion
      ? toVersionDto(input.consolidatedVersion)
      : null,
    finalVote: input.finalVote ? toVoteDto(input.finalVote) : null,
    positionsVisible: canSeePositions(actor, {
      settings: assemblySettings(assembly),
      assemblyStatus: assembly.status,
      isProponent: isDocumentProponent(actor, document),
    }),
    can: documentCapabilities(actor, assembly, document, window, now),
  };
}

// Loaders -------------------------------------------------------------------

async function countSubmittedAmendments(
  documentIds: string[],
  executor: Executor = db,
): Promise<Map<string, number>> {
  if (documentIds.length === 0) return new Map();
  const rows = await executor
    .select({ documentId: amendments.documentId, total: count() })
    .from(amendments)
    .where(and(inArray(amendments.documentId, documentIds), ne(amendments.status, "draft")))
    .groupBy(amendments.documentId);
  return new Map(rows.map((row) => [row.documentId, Number(row.total)]));
}

/**
 * Summaries of the documents of an assembly that the actor can see, in
 * creation order. `amendmentCount` counts every amendment past draft.
 */
export async function loadDocumentSummaries(
  assembly: typeof assemblies.$inferSelect,
  actor: Actor,
): Promise<DocumentSummaryDto[]> {
  const [rows, milestones] = await Promise.all([
    db.query.documents.findMany({
      where: eq(documents.assemblyId, assembly.id),
      with: { proponent: true },
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    }),
    loadMilestones(assembly.id),
  ]);
  const visible = rows.filter((row) => canSeeDocument(actor, row));
  const counts = await countSubmittedAmendments(visible.map((row) => row.id));
  const now = new Date();
  return visible.map(({ proponent, ...document }) =>
    toDocumentSummaryDto(document, {
      proponent: toMemberRef(proponent),
      amendmentCount: counts.get(document.id) ?? 0,
      window: documentWindow(document, milestones, now),
    }),
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
  const [document] = await executor
    .select()
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!document) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }
  const [milestones, proponent, counts, workingVersion, baseVersion, consolidatedVersion, finalVote] =
    await Promise.all([
      loadMilestones(assembly.id, executor),
      document.proponentMemberId
        ? executor
            .select()
            .from(members)
            .where(eq(members.id, document.proponentMemberId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      countSubmittedAmendments([document.id], executor),
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
  return toDocumentDto({
    actor,
    assembly,
    document,
    milestones,
    proponent: toMemberRef(proponent),
    amendmentCount: counts.get(document.id) ?? 0,
    workingVersion,
    baseVersion,
    consolidatedVersion,
    finalVote,
  });
}

/** requireActor + resolveAssembly + resolveDocument for document routes. */
export async function resolveDocumentRoute(event: H3Event) {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(actor, getRouterParam(event, "assembly"));
  const document = await resolveDocument(actor, assembly.id, getRouterParam(event, "document"));
  return { actor, assembly, document };
}

/** Members referenced by documents must exist. */
export async function requireMember(memberId: string, executor: Executor = db) {
  const [member] = await executor
    .select({ id: members.id })
    .from(members)
    .where(eq(members.id, memberId));
  if (!member) {
    throw createError({ statusCode: 422, message: "El miembro indicado no existe" });
  }
  return member;
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
    .where(and(eq(documents.assemblyId, assemblyId), like(documents.slug, `${base}%`)));
  const taken = new Set(rows.map((row) => row.slug));
  const isFree = (slug: string) => !taken.has(slug) && !RESERVED_SLUGS.has(slug);
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

// Amendment visibility (history) -------------------------------------------

/**
 * Ids of the document's amendments, split by whether the actor can see them,
 * using the same rules as the amendment endpoints.
 */
export async function loadAmendmentVisibility(
  actor: Actor,
  assembly: AssemblyRow,
  document: DocumentRow,
  milestones: Milestones,
  now = new Date(),
): Promise<{ all: Set<string>; visible: Set<string> }> {
  const rows = await db
    .select({
      id: amendments.id,
      status: amendments.status,
      late: amendments.late,
      createdByUserId: amendments.createdByUserId,
    })
    .from(amendments)
    .where(eq(amendments.documentId, document.id));
  const all = new Set(rows.map((row) => row.id));
  if (rows.length === 0) return { all, visible: new Set() };

  const ids = [...all];
  const [authorRows, partyRows] = await Promise.all([
    db
      .select({ amendmentId: amendmentAuthors.amendmentId, memberId: amendmentAuthors.memberId })
      .from(amendmentAuthors)
      .where(inArray(amendmentAuthors.amendmentId, ids)),
    db
      .select({
        amendmentId: amendmentAcceptances.amendmentId,
        memberId: amendmentAcceptances.memberId,
      })
      .from(amendmentAcceptances)
      .where(inArray(amendmentAcceptances.amendmentId, ids)),
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
  const options = {
    settings: assemblySettings(assembly),
    windowClosed: isWindowClosed(amendmentWindow(document, milestones), now),
  };
  const visible = new Set(
    rows
      .filter((row) =>
        canSeeAmendment(
          actor,
          {
            status: row.status,
            late: row.late,
            createdByUserId: row.createdByUserId,
            authorMemberIds: authors.get(row.id) ?? [],
            partyMemberIds: parties.get(row.id) ?? [],
          },
          options,
        ),
      )
      .map((row) => row.id),
  );
  return { all, visible };
}

// Uploads -------------------------------------------------------------------

export interface UploadedFile {
  data: Buffer;
  filename: string;
  type: string;
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
  if (declared > maxBytes + 64 * 1024) {
    throw createError({ statusCode: 413, message: tooLargeMessage });
  }
  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === "file");
  if (!file || !file.data || file.data.length === 0) {
    throw createError({ statusCode: 400, message: "Campo 'file' requerido" });
  }
  if (file.data.length > maxBytes) {
    throw createError({ statusCode: 413, message: tooLargeMessage });
  }
  return { data: file.data, filename: file.filename ?? "", type: file.type ?? "" };
}

export const PDF_MAX_BYTES = 20 * 1024 * 1024;
const PDF_MIME_TYPES = ["application/pdf"];

/** Display name of an uploaded file: no path, no control characters. */
export function cleanFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001F\u007F"]/g, "").trim().slice(0, 200);
  return cleaned || fallback;
}

/** Validates type and signature of a PDF and stores it under a random name. */
export async function storePdf(file: UploadedFile): Promise<{ fileUrl: string; fileName: string }> {
  if (!PDF_MIME_TYPES.includes(file.type)) {
    throw createError({ statusCode: 415, message: "Solo se admiten archivos PDF" });
  }
  if (file.data.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw createError({
      statusCode: 415,
      message: "El archivo no parece ser un PDF válido",
    });
  }
  const storedName = `${randomUUID()}.pdf`;
  const directory = getUploadDir();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, storedName), file.data);
  return {
    fileUrl: `/api/uploads/documents/${storedName}`,
    fileName: cleanFileName(file.filename, "documento.pdf"),
  };
}
