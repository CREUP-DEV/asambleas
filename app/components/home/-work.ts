/**
 * Pure helpers that turn GET /api/me/work into what the home page and the
 * assembly overview show: the things a user has to do (present an expected
 * document, fix what the Secretaría sent back, send a draft), where the rest
 * of their documents and amendments stand, and the Secretaría's pending
 * review per assembly. No Vue or Nuxt here.
 *
 * The "-" prefix keeps Nuxt from registering this module (and its test) as
 * a component; import it explicitly.
 */
import type {
  MeWorkAmendmentDto,
  MeWorkAssemblyRef,
  MeWorkDocumentDto,
  MeWorkDto,
  MeWorkReviewDto,
} from "~~/shared/types/api";

/** Something the user has to do, in the order it is most urgent. */
export type HomeWorkTaskKind =
  /** The Secretaría sent the document back with a note. */
  | "document_correction"
  /** An expected (or new) document with no text or PDF yet. */
  | "document_prepare"
  /** A draft with content that was never sent to the Secretaría. */
  | "document_send"
  /** The Secretaría sent the amendment back with a note. */
  | "amendment_correction"
  /** An amendment draft never presented. */
  | "amendment_draft";

/**
 * Where something the user does not have to act on stands. GET /api/me/work
 * only returns drafts, presented and published documents, and amendments
 * not decided yet.
 */
export type HomeWorkUpdateKind =
  | "document_review"
  | "document_published"
  | "amendment_review"
  | "amendment_validated"
  | "amendment_published"
  | "amendment_other";

export interface HomeWorkDocumentRef {
  id: string;
  slug: string;
  title: string;
}

export interface HomeWorkAmendmentRef {
  id: string;
  code: string | null;
}

export interface HomeWorkTask {
  /** Unique across documents and amendments. */
  key: string;
  kind: HomeWorkTaskKind;
  assembly: MeWorkAssemblyRef;
  document: HomeWorkDocumentRef;
  amendment: HomeWorkAmendmentRef | null;
  /** The Secretaría's note when it asked for a correction. */
  note: string | null;
  /** Internal deadline of an expected document. */
  dueAt: string | null;
  /** The deadline has passed and the document was not presented. */
  overdue: boolean;
  /** Fix it in the document editor or in the document workspace. */
  target: "edit" | "document";
}

export interface HomeWorkUpdate {
  key: string;
  kind: HomeWorkUpdateKind;
  assembly: MeWorkAssemblyRef;
  document: HomeWorkDocumentRef;
  amendment: (HomeWorkAmendmentRef & { status: string }) | null;
}

function documentRef(entry: MeWorkDocumentDto): HomeWorkDocumentRef {
  return {
    id: entry.document.id,
    slug: entry.document.slug,
    title: entry.document.title,
  };
}

function time(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** What the user has to do with one of their documents, if anything. */
export function homeWorkDocumentTask(
  entry: MeWorkDocumentDto,
): HomeWorkTaskKind | null {
  const document = entry.document;
  if (document.status !== "draft") return null;
  if (document.correctionRequestedAt || document.correctionNote) {
    return "document_correction";
  }
  return document.hasContent ? "document_send" : "document_prepare";
}

/** What the user has to do with one of their amendments, if anything. */
export function homeWorkAmendmentTask(
  entry: MeWorkAmendmentDto,
): HomeWorkTaskKind | null {
  const amendment = entry.amendment;
  if (amendment.status !== "draft") return null;
  return amendment.reviewState === "correction_requested" ||
    amendment.correctionNote
    ? "amendment_correction"
    : "amendment_draft";
}

const TASK_RANK: Record<HomeWorkTaskKind, number> = {
  document_correction: 0,
  amendment_correction: 0,
  document_prepare: 1,
  document_send: 1,
  amendment_draft: 2,
};

/**
 * Everything the user has to do, most urgent first: corrections the
 * Secretaría asked for, then overdue documents, then the rest by deadline
 * (documents without one after those with one), then amendment drafts.
 */
export function homeWorkTasks(work: MeWorkDto, now: number): HomeWorkTask[] {
  const tasks: HomeWorkTask[] = [];
  for (const entry of work.documents) {
    const kind = homeWorkDocumentTask(entry);
    if (!kind) continue;
    const due = time(entry.document.dueAt);
    tasks.push({
      key: `document-${entry.document.id}`,
      kind,
      assembly: entry.assembly,
      document: documentRef(entry),
      amendment: null,
      note:
        kind === "document_correction" ? entry.document.correctionNote : null,
      dueAt: entry.document.dueAt,
      overdue: due !== null && due < now,
      target: "edit",
    });
  }
  for (const entry of work.amendments) {
    const kind = homeWorkAmendmentTask(entry);
    if (!kind) continue;
    tasks.push({
      key: `amendment-${entry.amendment.id}`,
      kind,
      assembly: entry.assembly,
      document: { ...entry.document },
      amendment: { id: entry.amendment.id, code: entry.amendment.code },
      note:
        kind === "amendment_correction" ? entry.amendment.correctionNote : null,
      dueAt: null,
      overdue: false,
      target: "document",
    });
  }
  return tasks.sort((a, b) => {
    const rank = TASK_RANK[a.kind] - TASK_RANK[b.kind];
    if (rank !== 0) return rank;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const dueA = time(a.dueAt) ?? Number.POSITIVE_INFINITY;
    const dueB = time(b.dueAt) ?? Number.POSITIVE_INFINITY;
    if (dueA !== dueB) return dueA - dueB;
    return (
      a.assembly.label.localeCompare(b.assembly.label) ||
      a.document.title.localeCompare(b.document.title) ||
      (a.amendment?.code ?? "").localeCompare(b.amendment?.code ?? "") ||
      a.key.localeCompare(b.key)
    );
  });
}

function documentUpdate(entry: MeWorkDocumentDto): HomeWorkUpdateKind | null {
  switch (entry.document.status) {
    case "submitted":
      return "document_review";
    case "published":
      return "document_published";
    default:
      return null;
  }
}

function amendmentUpdate(entry: MeWorkAmendmentDto): HomeWorkUpdateKind | null {
  const amendment = entry.amendment;
  if (amendment.status === "draft") return null;
  if (amendment.status !== "submitted") return "amendment_other";
  switch (amendment.reviewState) {
    case "pending_validation":
      return "amendment_review";
    case "validated":
      return "amendment_validated";
    case "published":
      return "amendment_published";
    default:
      return "amendment_other";
  }
}

const UPDATE_RANK: Record<HomeWorkUpdateKind, number> = {
  document_review: 0,
  amendment_review: 0,
  amendment_validated: 1,
  document_published: 2,
  amendment_published: 2,
  amendment_other: 3,
};

/**
 * Where the user's documents and amendments stand when there is nothing
 * for them to do: waiting for the Secretaría first, then validated, then
 * published.
 */
export function homeWorkUpdates(work: MeWorkDto): HomeWorkUpdate[] {
  const updates: HomeWorkUpdate[] = [];
  for (const entry of work.documents) {
    const kind = documentUpdate(entry);
    if (!kind) continue;
    updates.push({
      key: `document-${entry.document.id}`,
      kind,
      assembly: entry.assembly,
      document: documentRef(entry),
      amendment: null,
    });
  }
  for (const entry of work.amendments) {
    const kind = amendmentUpdate(entry);
    if (!kind) continue;
    updates.push({
      key: `amendment-${entry.amendment.id}`,
      kind,
      assembly: entry.assembly,
      document: { ...entry.document },
      amendment: {
        id: entry.amendment.id,
        code: entry.amendment.code,
        status: entry.amendment.status,
      },
    });
  }
  return updates.sort(
    (a, b) =>
      UPDATE_RANK[a.kind] - UPDATE_RANK[b.kind] ||
      a.assembly.label.localeCompare(b.assembly.label) ||
      a.document.title.localeCompare(b.document.title) ||
      (a.amendment ? 1 : 0) - (b.amendment ? 1 : 0) ||
      (a.amendment?.code ?? "").localeCompare(b.amendment?.code ?? "") ||
      a.key.localeCompare(b.key),
  );
}

/** Everything waiting for the Secretaría in one assembly. */
export function homeWorkReviewTotal(review: MeWorkReviewDto): number {
  return (
    review.documentsToValidate +
    review.amendmentsToValidate +
    review.amendmentsToPublish +
    review.documentsOverdue
  );
}

/** The assemblies with something waiting for the Secretaría. */
export function homeWorkReviewPending(
  review: MeWorkReviewDto[],
): MeWorkReviewDto[] {
  return review.filter((entry) => homeWorkReviewTotal(entry) > 0);
}

/** The part of the user's work that belongs to one assembly. */
export function homeWorkForAssembly(
  work: MeWorkDto,
  assemblyId: string,
): MeWorkDto {
  return {
    documents: work.documents.filter(
      (entry) => entry.assembly.id === assemblyId,
    ),
    amendments: work.amendments.filter(
      (entry) => entry.assembly.id === assemblyId,
    ),
    review: work.review.filter((entry) => entry.assembly.id === assemblyId),
  };
}

/**
 * Query string that opens an amendment in the document workspace
 * (`?enmienda=<id>`), so a task or an update lands on it; empty for a
 * document.
 */
export function homeWorkAmendmentQuery(
  amendment: { id: string } | null,
): string {
  return amendment ? `?enmienda=${encodeURIComponent(amendment.id)}` : "";
}
