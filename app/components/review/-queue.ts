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
  AcceptanceDto,
  AdmissionBody,
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

/**
 * What the Secretaría can do to an amendment from the inbox: validate it
 * (and publish it or not), publish it, send it back, or record the
 * assembly's decision on a late one ("admit": it is treated, "inadmit": it
 * is not).
 */
export type ReviewAmendmentAction =
  | "validate_publish"
  | "validate_only"
  | "publish"
  | "correction"
  | "admit"
  | "inadmit";

/** The assembly's decision on late amendments, without the ids. */
export type AdmissionChoice = Omit<AdmissionBody, "amendmentIds">;

type ReviewStateLike = Pick<AmendmentDto, "reviewState">;
type LateLike = Pick<
  AmendmentDto,
  "late" | "admission" | "status" | "validatedAt"
>;
type QueueLike = ReviewStateLike & LateLike;

/** Presented and not checked by the Secretaría yet. */
export function isAwaitingValidation(amendment: ReviewStateLike): boolean {
  return amendment.reviewState === "pending_validation";
}

/**
 * A transactional proposed by a member, waiting for whoever presents the
 * document to approve it. The Secretaría cannot validate it until then.
 */
export function isAwaitingProponent(amendment: ReviewStateLike): boolean {
  return amendment.reviewState === "pending_proponent";
}

/**
 * Presented after the deadline and already validated, waiting for the
 * assembly to decide whether to treat it (admission still pending), public
 * or not.
 */
export function isAwaitingAssembly(amendment: LateLike): boolean {
  return (
    amendment.late &&
    amendment.admission === "pending" &&
    amendment.status === "submitted" &&
    amendment.validatedAt !== null
  );
}

/**
 * Checked by the Secretaría but not visible to everyone yet. A late one
 * waiting for the assembly's decision is listed with the late ones instead:
 * treating it publishes it.
 */
export function isAwaitingPublication(amendment: QueueLike): boolean {
  return (
    amendment.reviewState === "validated" && !isAwaitingAssembly(amendment)
  );
}

/** Whether an amendment still belongs in the inbox. */
export function isInReviewQueue(amendment: QueueLike): boolean {
  return (
    isAwaitingValidation(amendment) ||
    isAwaitingProponent(amendment) ||
    isAwaitingPublication(amendment) ||
    isAwaitingAssembly(amendment)
  );
}

/**
 * The answer of the document's presenter to a transactional, when it is a
 * party of its own (role "proponent"). Null when the presenter also wrote
 * one of the amendments it groups (a single "author" row then) or is not a
 * party: the card then names nobody.
 */
export function proponentAcceptance(
  amendment: Pick<AmendmentDto, "acceptances">,
): AcceptanceDto | null {
  return (
    amendment.acceptances.find(
      (acceptance) => acceptance.role === "proponent",
    ) ?? null
  );
}

export interface ReviewScope {
  /** The actor validates documents (document:manage). */
  documents: boolean;
  /** The actor validates amendments (amendment:review). */
  amendments: boolean;
}

/**
 * Items waiting for the Secretaría's validation: presented documents and
 * presented amendments. Validated amendments kept unpublished on purpose,
 * transactionals still waiting for the document's presenter and late ones
 * waiting for the assembly are not counted: they wait for someone else, or
 * the badge would never go away.
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
  /** Transactionals waiting for the document's presenter, in text order. */
  awaitingProponent: AmendmentDto[];
  /** Validated, waiting for publication, in text order. */
  toPublish: AmendmentDto[];
  /** Late and validated, waiting for the assembly's decision, in text order. */
  late: AmendmentDto[];
}

/** Text order: position in the base, then number, then id. */
function compareInText(a: AmendmentDto, b: AmendmentDto): number {
  if (a.positionKey !== b.positionKey) return a.positionKey - b.positionKey;
  const na = a.number ?? Number.POSITIVE_INFINITY;
  const nb = b.number ?? Number.POSITIVE_INFINITY;
  if (na !== nb) return na - nb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Amendments of a group the Secretaría checks now (not the late ones). */
export function reviewGroupSize(
  group: Pick<
    ReviewDocumentGroup,
    "toValidate" | "awaitingProponent" | "toPublish"
  >,
): number {
  return (
    group.toValidate.length +
    group.awaitingProponent.length +
    group.toPublish.length
  );
}

/**
 * The queue's amendments by document, keeping the order in which documents
 * first appear in the server's response (the order the assembly will debate
 * them). Amendments that left the review states are dropped, and so are
 * documents left with nothing.
 */
export function groupReviewAmendments(
  entries: readonly ReviewQueueAmendmentDto[],
): ReviewDocumentGroup[] {
  const groups = new Map<string, ReviewDocumentGroup>();
  for (const { document, amendment } of entries) {
    let group = groups.get(document.id);
    if (!group) {
      group = {
        document,
        toValidate: [],
        awaitingProponent: [],
        toPublish: [],
        late: [],
      };
      groups.set(document.id, group);
    }
    if (isAwaitingAssembly(amendment)) group.late.push(amendment);
    else if (isAwaitingValidation(amendment)) group.toValidate.push(amendment);
    else if (isAwaitingProponent(amendment)) {
      group.awaitingProponent.push(amendment);
    } else if (isAwaitingPublication(amendment)) {
      group.toPublish.push(amendment);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      toValidate: [...group.toValidate].sort(compareInText),
      awaitingProponent: [...group.awaitingProponent].sort(compareInText),
      toPublish: [...group.toPublish].sort(compareInText),
      late: [...group.late].sort(compareInText),
    }))
    .filter((group) => reviewGroupSize(group) + group.late.length > 0);
}

export interface ReviewSelection {
  /** Selected amendments the actor may validate now. */
  validate: string[];
  /** Selected amendments the actor may publish now. */
  publish: string[];
}

/**
 * Splits a selection of one group into what each bulk action applies to.
 * Only amendments in the right state count: a transactional waiting for
 * the document's presenter is never validated, whatever `can` says.
 */
export function splitReviewSelection(
  group: Pick<ReviewDocumentGroup, "toValidate" | "toPublish">,
  selected: ReadonlySet<string>,
): ReviewSelection {
  return {
    validate: group.toValidate
      .filter(
        (amendment) =>
          selected.has(amendment.id) &&
          isAwaitingValidation(amendment) &&
          amendment.can.validate,
      )
      .map((amendment) => amendment.id),
    publish: group.toPublish
      .filter(
        (amendment) =>
          selected.has(amendment.id) &&
          isAwaitingPublication(amendment) &&
          amendment.can.publish,
      )
      .map((amendment) => amendment.id),
  };
}

/** Whether the actor can record the assembly's decision on it. */
export function canRecordAdmission(
  amendment: Pick<AmendmentDto, "can"> & LateLike,
): boolean {
  return (
    isAwaitingAssembly(amendment) &&
    (amendment.can.review || amendment.can.moderate)
  );
}

/**
 * The queue after an amendment action on one document: every amendment the
 * server returned replaces its entry, and those that left the review states
 * (published on time, sent back for correction, withdrawn...) leave the
 * queue. Amendments the response does not mention stay as they were.
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

/** The queue without these amendments (sent back, or decided by the assembly). */
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
