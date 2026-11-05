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
  AdmissionBody,
  AmendmentDto,
  MemberRef,
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
 * (and publish it or not; a transactional is always published), publish
 * it, send it back, or record the assembly's decision on a late one
 * ("admit": it is treated, "inadmit": it is not).
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
type AuthorsLike = ReviewStateLike & Pick<AmendmentDto, "acceptances">;
type LateLike = Pick<
  AmendmentDto,
  "late" | "admission" | "status" | "validatedAt"
>;
type QueueLike = AuthorsLike & LateLike;

/** Presented and not checked by the Secretaría yet. */
export function isAwaitingValidation(amendment: ReviewStateLike): boolean {
  return amendment.reviewState === "pending_validation";
}

/** Some party already rejected this transactional. */
function rejectedByAnAuthor(
  amendment: Pick<AmendmentDto, "acceptances">,
): boolean {
  return amendment.acceptances.some(
    (acceptance) => acceptance.decision === "rejected",
  );
}

/**
 * A transactional waiting for the main author of each amendment it would
 * replace to accept it. The Secretaría cannot validate it until they all
 * do. One that any of them rejected is closed (the originals carry on), so
 * it waits for nothing, whatever state the server still reports.
 */
export function isAwaitingAuthors(amendment: AuthorsLike): boolean {
  return (
    amendment.reviewState === "pending_authors" &&
    !rejectedByAnAuthor(amendment)
  );
}

/**
 * The main authors who still have to answer a transactional, once each and
 * in the order the server lists them. The DTO's acceptances hold the main
 * authors only, so whoever it lists as pending is missing.
 */
export function missingAuthors(
  amendment: Pick<AmendmentDto, "acceptances">,
): MemberRef[] {
  const seen = new Set<string>();
  const missing: MemberRef[] = [];
  for (const acceptance of amendment.acceptances) {
    if (acceptance.decision !== "pending") continue;
    if (seen.has(acceptance.member.id)) continue;
    seen.add(acceptance.member.id);
    missing.push(acceptance.member);
  }
  return missing;
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
    isAwaitingAuthors(amendment) ||
    isAwaitingPublication(amendment) ||
    isAwaitingAssembly(amendment)
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
 * transactionals still waiting for their authors and late ones waiting for
 * the assembly are not counted: they wait for someone else, or the badge
 * would never go away.
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
  /** Transactionals waiting for their authors' answer, in text order. */
  awaitingAuthors: AmendmentDto[];
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
    "toValidate" | "awaitingAuthors" | "toPublish"
  >,
): number {
  return (
    group.toValidate.length +
    group.awaitingAuthors.length +
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
        awaitingAuthors: [],
        toPublish: [],
        late: [],
      };
      groups.set(document.id, group);
    }
    if (isAwaitingAssembly(amendment)) group.late.push(amendment);
    else if (isAwaitingValidation(amendment)) group.toValidate.push(amendment);
    else if (isAwaitingAuthors(amendment)) {
      group.awaitingAuthors.push(amendment);
    } else if (isAwaitingPublication(amendment)) {
      group.toPublish.push(amendment);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      toValidate: [...group.toValidate].sort(compareInText),
      awaitingAuthors: [...group.awaitingAuthors].sort(compareInText),
      toPublish: [...group.toPublish].sort(compareInText),
      late: [...group.late].sort(compareInText),
    }))
    .filter((group) => reviewGroupSize(group) + group.late.length > 0);
}

type SourcesLike = Pick<AmendmentDto, "id" | "kind" | "sourceIds">;

/** Whether both are transactionals that group some amendment in common. */
export function shareSources(a: SourcesLike, b: SourcesLike): boolean {
  if (a.id === b.id) return false;
  if (a.kind !== "transactional" || b.kind !== "transactional") return false;
  const sources = new Set(a.sourceIds);
  return b.sourceIds.some((id) => sources.has(id));
}

/**
 * The amendments that can be validated together, in the order given: a
 * transactional that groups an amendment an earlier one already groups is
 * left out. Only one of them can replace it (the server refuses both at
 * once and closes the other when the first replaces it), so the first in
 * text order wins.
 */
export function withoutSharedSources<T extends SourcesLike>(
  amendments: readonly T[],
): T[] {
  const kept: T[] = [];
  for (const amendment of amendments) {
    if (kept.some((other) => shareSources(other, amendment))) continue;
    kept.push(amendment);
  }
  return kept;
}

/**
 * Transactionals that cannot join the selection because a selected one
 * already groups one of their amendments: maps each of them to the first
 * selected transactional, in the order given, that blocks it. Selected ones
 * are never blocked, so they can always be unselected.
 */
export function blockedBySelection(
  amendments: readonly SourcesLike[],
  selected: ReadonlySet<string>,
): Map<string, string> {
  const chosen = amendments.filter((amendment) => selected.has(amendment.id));
  const blocked = new Map<string, string>();
  for (const amendment of amendments) {
    if (selected.has(amendment.id)) continue;
    const blocker = chosen.find((other) => shareSources(other, amendment));
    if (blocker) blocked.set(amendment.id, blocker.id);
  }
  return blocked;
}

export interface ReviewSelection {
  /**
   * Selected amendments the actor may validate now, without two
   * transactionals that group the same amendment.
   */
  validate: string[];
  /**
   * Those of `validate` that may stay private once validated: all but the
   * transactionals, which replace public amendments and so are always
   * published when validated.
   */
  validateOnly: string[];
  /** Selected amendments the actor may publish now. */
  publish: string[];
}

/**
 * Splits a selection of one group into what each bulk action applies to.
 * Only amendments in the right state count: a transactional waiting for
 * its authors is never validated, whatever `can` says.
 */
export function splitReviewSelection(
  group: Pick<ReviewDocumentGroup, "toValidate" | "toPublish">,
  selected: ReadonlySet<string>,
): ReviewSelection {
  const validate = withoutSharedSources(
    validatableNow(group).filter((amendment) => selected.has(amendment.id)),
  );
  return {
    validate: validate.map((amendment) => amendment.id),
    validateOnly: validate
      .filter((amendment) => amendment.kind !== "transactional")
      .map((amendment) => amendment.id),
    publish: publishableNow(group)
      .filter((amendment) => selected.has(amendment.id))
      .map((amendment) => amendment.id),
  };
}

/** Amendments of a group the actor may validate now, in text order. */
function validatableNow(
  group: Pick<ReviewDocumentGroup, "toValidate">,
): AmendmentDto[] {
  return group.toValidate.filter(
    (amendment) => isAwaitingValidation(amendment) && amendment.can.validate,
  );
}

/** Amendments of a group the actor may publish now, in text order. */
function publishableNow(
  group: Pick<ReviewDocumentGroup, "toPublish">,
): AmendmentDto[] {
  return group.toPublish.filter(
    (amendment) => isAwaitingPublication(amendment) && amendment.can.publish,
  );
}

/** Every amendment of a group that can be selected for a bulk action. */
export function selectableReviewIds(
  group: Pick<ReviewDocumentGroup, "toValidate" | "toPublish">,
): string[] {
  return [...validatableNow(group), ...publishableNow(group)].map(
    (amendment) => amendment.id,
  );
}

/**
 * What "Seleccionar todas" selects: every selectable amendment but a
 * transactional that groups an amendment an earlier one already groups.
 * Given the current selection, it keeps it and adds what still fits, so a
 * transactional the user chose is never swapped for another one.
 */
export function selectAllReviewIds(
  group: Pick<ReviewDocumentGroup, "toValidate" | "toPublish">,
  keep: ReadonlySet<string> = new Set(),
): string[] {
  const validatable = validatableNow(group);
  const chosen = new Set(
    withoutSharedSources([
      ...validatable.filter((amendment) => keep.has(amendment.id)),
      ...validatable.filter((amendment) => !keep.has(amendment.id)),
    ]).map((amendment) => amendment.id),
  );
  return [
    ...validatable.filter((amendment) => chosen.has(amendment.id)),
    ...publishableNow(group),
  ].map((amendment) => amendment.id);
}

/**
 * Whether selecting makes sense: at least two selectable amendments can be
 * acted on together. Every pair counts, not only what "Seleccionar todas"
 * picks: if T1 groups an amendment with T2 and another with T3, the pick is
 * just T1, yet T2 and T3 can be validated together.
 */
export function canSelectSeveral(
  group: Pick<ReviewDocumentGroup, "toValidate" | "toPublish">,
): boolean {
  const validatable = validatableNow(group);
  const publishable = publishableNow(group).length;
  if (publishable > 1 || (publishable === 1 && validatable.length > 0)) {
    return true;
  }
  return validatable.some((amendment, index) =>
    validatable
      .slice(index + 1)
      .some((other) => !shareSources(amendment, other)),
  );
}

/**
 * Whether nothing else can join the selection: every selectable amendment
 * is selected or kept out by a selected transactional.
 */
export function isSelectionFull(
  group: Pick<ReviewDocumentGroup, "toValidate" | "toPublish">,
  selected: ReadonlySet<string>,
): boolean {
  const blocked = blockedBySelection(validatableNow(group), selected);
  return selectableReviewIds(group).every(
    (id) => selected.has(id) || blocked.has(id),
  );
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
