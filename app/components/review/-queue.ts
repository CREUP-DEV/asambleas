/**
 * Pure helpers behind the Secretaría's validation inbox
 * (GET /api/assemblies/[assembly]/review): grouping, counting and patching
 * the queue with what each action returned. No Nuxt or Vue APIs here, so
 * they are unit-tested on their own (-queue.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */
import type {
  AmendmentDto,
  ReviewQueueAmendmentDto,
  ReviewQueueDto,
} from "~~/shared/types/api";

/** Shared fetch key of an assembly's review queue (hub, sidebar, inbox). */
export function reviewQueueKey(assemblyId: string): string {
  return `assembly-review-${assemblyId}`;
}

/** useState key of the pending count shown next to "Validación". */
export const REVIEW_BADGE_STATE_KEY = "assembly-review-badge";

export interface ReviewBadgeState {
  assemblyId: string;
  count: number;
}

/** What the Secretaría can do to an amendment from the inbox. */
export type ReviewAmendmentAction =
  "validate_publish" | "validate_only" | "publish" | "correction";

type ReviewStateLike = Pick<AmendmentDto, "reviewState">;

/** Presented and not checked by the Secretaría yet. */
export function isAwaitingValidation(amendment: ReviewStateLike): boolean {
  return amendment.reviewState === "pending_validation";
}

/** Checked by the Secretaría but not visible to everyone yet. */
export function isAwaitingPublication(amendment: ReviewStateLike): boolean {
  return amendment.reviewState === "validated";
}

/** Whether an amendment still belongs in the inbox. */
export function isInReviewQueue(amendment: ReviewStateLike): boolean {
  return isAwaitingValidation(amendment) || isAwaitingPublication(amendment);
}

export interface ReviewScope {
  /** The actor validates documents (document:manage). */
  documents: boolean;
  /** The actor validates amendments (amendment:review). */
  amendments: boolean;
}

/**
 * Items waiting for the Secretaría's validation: presented documents and
 * presented amendments. Validated amendments kept unpublished on purpose are
 * not counted, or the badge would never go away.
 */
export function pendingReviewCount(
  queue: ReviewQueueDto | null | undefined,
  scope: ReviewScope,
): number {
  if (!queue) return 0;
  const documents = scope.documents ? queue.documents.length : 0;
  const amendments = scope.amendments
    ? queue.amendments.filter((entry) => isAwaitingValidation(entry.amendment))
        .length
    : 0;
  return documents + amendments;
}

export interface ReviewDocumentGroup {
  document: ReviewQueueAmendmentDto["document"];
  /** Presented, waiting for validation, in text order. */
  toValidate: AmendmentDto[];
  /** Validated, waiting for publication, in text order. */
  toPublish: AmendmentDto[];
}

/** Text order: position in the base, then number, then id. */
function compareInText(a: AmendmentDto, b: AmendmentDto): number {
  if (a.positionKey !== b.positionKey) return a.positionKey - b.positionKey;
  const na = a.number ?? Number.POSITIVE_INFINITY;
  const nb = b.number ?? Number.POSITIVE_INFINITY;
  if (na !== nb) return na - nb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The queue's amendments by document, keeping the order in which documents
 * first appear in the server's response (for now the order in which the
 * documents were created). Amendments that left the review states are
 * dropped.
 */
export function groupReviewAmendments(
  entries: readonly ReviewQueueAmendmentDto[],
): ReviewDocumentGroup[] {
  const groups = new Map<string, ReviewDocumentGroup>();
  for (const { document, amendment } of entries) {
    let group = groups.get(document.id);
    if (!group) {
      group = { document, toValidate: [], toPublish: [] };
      groups.set(document.id, group);
    }
    if (isAwaitingValidation(amendment)) group.toValidate.push(amendment);
    else if (isAwaitingPublication(amendment)) group.toPublish.push(amendment);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      toValidate: [...group.toValidate].sort(compareInText),
      toPublish: [...group.toPublish].sort(compareInText),
    }))
    .filter((group) => group.toValidate.length + group.toPublish.length > 0);
}

export interface ReviewSelection {
  /** Selected amendments the actor may validate now. */
  validate: string[];
  /** Selected amendments the actor may publish now. */
  publish: string[];
}

/** Splits a selection of one group into what each bulk action applies to. */
export function splitReviewSelection(
  group: Pick<ReviewDocumentGroup, "toValidate" | "toPublish">,
  selected: ReadonlySet<string>,
): ReviewSelection {
  return {
    validate: group.toValidate
      .filter(
        (amendment) => selected.has(amendment.id) && amendment.can.validate,
      )
      .map((amendment) => amendment.id),
    publish: group.toPublish
      .filter(
        (amendment) => selected.has(amendment.id) && amendment.can.publish,
      )
      .map((amendment) => amendment.id),
  };
}

/**
 * The queue after an amendment action on one document: every amendment the
 * server returned replaces its entry, and those that left the review states
 * (published, sent back for correction, withdrawn...) leave the queue.
 * Amendments the response does not mention stay as they were.
 */
export function applyAmendmentResults(
  queue: ReviewQueueDto,
  updated: readonly AmendmentDto[],
): ReviewQueueDto {
  const byId = new Map(updated.map((amendment) => [amendment.id, amendment]));
  const amendments: ReviewQueueAmendmentDto[] = [];
  for (const entry of queue.amendments) {
    const next = byId.get(entry.amendment.id);
    if (!next) {
      amendments.push(entry);
    } else if (isInReviewQueue(next)) {
      amendments.push({ document: entry.document, amendment: next });
    }
  }
  return { ...queue, amendments };
}

/** The queue without these amendments (e.g. sent back for correction). */
export function removeReviewAmendments(
  queue: ReviewQueueDto,
  ids: readonly string[],
): ReviewQueueDto {
  const drop = new Set(ids);
  return {
    ...queue,
    amendments: queue.amendments.filter(
      (entry) => !drop.has(entry.amendment.id),
    ),
  };
}

/** The queue without this document (validated or sent back). */
export function removeReviewDocument(
  queue: ReviewQueueDto,
  documentId: string,
): ReviewQueueDto {
  return {
    ...queue,
    documents: queue.documents.filter((document) => document.id !== documentId),
  };
}
