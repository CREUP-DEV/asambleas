/**
 * Pure helpers behind the document workspace: ordering, overlap grouping,
 * gutter markers, filters, passage selection and the operations the composer
 * builds. No Nuxt or Vue APIs here, so they are unit-tested on their own
 * (workspace.test.ts).
 *
 * Every export is auto-imported app-wide (`imports.dirs: composables/**`),
 * hence the explicit names.
 */
import {
  AMENDMENT_CLOSED_STATUSES,
  type AmendmentKind,
  type AmendmentStatus,
} from "~~/shared/constants/domain";
import type {
  AmendmentCapabilities,
  AmendmentDto,
  AmendmentReviewState,
  RelationDto,
} from "~~/shared/types/api";
import type {
  AmendmentInput,
  AmendmentOp,
  Block,
} from "~~/shared/types/content";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { diffPassage } from "~~/shared/utils/content/diff";
import { indexBlocks, touchedBlockIds } from "~~/shared/utils/content/ops";
import {
  findOverlaps,
  type OverlapKind,
} from "~~/shared/utils/content/overlaps";

type AmendmentLike = Pick<
  AmendmentDto,
  "id" | "kind" | "status" | "ops" | "positionKey" | "number" | "code"
> &
  Partial<Pick<AmendmentDto, "submittedAt" | "decidedAt">>;

// Status and labels ------------------------------------------------------------

export const AMENDMENT_TOTALITY_KINDS: readonly AmendmentKind[] = [
  "totality_return",
  "totality_alternative",
];

export function isTotalityAmendment(kind: AmendmentKind): boolean {
  return AMENDMENT_TOTALITY_KINDS.includes(kind);
}

/** Drafts and submitted amendments: still to be decided. */
export function isAmendmentOpen(amendment: Pick<AmendmentDto, "status">) {
  return !AMENDMENT_CLOSED_STATUSES.includes(amendment.status);
}

/** "12 · CEUM 4", "T1", or null while it is a draft without a number. */
export function amendmentDisplayLabel(
  amendment: Pick<AmendmentDto, "number" | "code" | "kind">,
): string | null {
  if (amendment.kind === "transactional") return amendment.code ?? null;
  const parts = [
    amendment.number !== null ? String(amendment.number) : null,
    amendment.code,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Short reference for provenance marks: the code ("CEUM 4", "T1") or the number. */
export function amendmentShortLabel(
  amendment: Pick<AmendmentDto, "number" | "code">,
): string | null {
  if (amendment.code) return amendment.code;
  return amendment.number !== null ? String(amendment.number) : null;
}

// Review by the Secretaría -------------------------------------------------------

/**
 * Not visible to the whole assembly yet: a draft, or a presented amendment
 * the Secretaría has not published. Amendments without a review state past
 * draft (recorded before validation existed) count as public.
 */
export function isAmendmentPrivate(
  amendment: Pick<AmendmentDto, "status" | "reviewState">,
): boolean {
  if (amendment.status === "draft") return true;
  return (
    amendment.reviewState !== null && amendment.reviewState !== "published"
  );
}

/**
 * What the viewer is told about an amendment's review, as an i18n key under
 * `amendment.review.badges` (and the sentence of amendmentReviewSentenceKey):
 * - `draft`: never sent to the Secretaría;
 * - `correction`: sent back to its authors, who can fix it (the viewer can);
 * - `correction_sent`: sent back, seen by someone who cannot edit it;
 * - `to_validate` / `pending`: waiting for the Secretaría, for the
 *   Secretaría itself and for everyone else;
 * - `to_publish` / `validated`: validated but private, likewise. A decided
 *   amendment that was never published is `to_publish` for the Secretaría,
 *   which can still make it public;
 * - `published`: visible to everyone.
 */
export type AmendmentReviewKey =
  | "draft"
  | "correction"
  | "correction_sent"
  | "to_validate"
  | "pending"
  | "to_publish"
  | "validated"
  | "published";

export interface AmendmentReviewView {
  key: AmendmentReviewKey;
  color: "neutral" | "info" | "warning" | "success" | "primary";
  icon: string;
  /** Not visible to the whole assembly yet (see isAmendmentPrivate). */
  private: boolean;
  /** Late, validated, and still waiting for the Mesa to admit it. */
  awaitingAdmission: boolean;
}

export type AmendmentReviewInput = Pick<
  AmendmentDto,
  "status" | "reviewState" | "admission"
> & { can: Pick<AmendmentCapabilities, "edit" | "validate" | "publish"> };

const REVIEW_LOOK: Record<
  AmendmentReviewKey,
  Pick<AmendmentReviewView, "color" | "icon">
> = {
  draft: { color: "neutral", icon: "i-lucide-file-pen" },
  correction: { color: "warning", icon: "i-lucide-message-square-warning" },
  correction_sent: { color: "neutral", icon: "i-lucide-undo-2" },
  to_validate: { color: "warning", icon: "i-lucide-inbox" },
  pending: { color: "info", icon: "i-lucide-hourglass" },
  to_publish: { color: "primary", icon: "i-lucide-eye-off" },
  validated: { color: "info", icon: "i-lucide-eye-off" },
  published: { color: "success", icon: "i-lucide-eye" },
};

function reviewKeyOf(
  amendment: AmendmentReviewInput,
): AmendmentReviewKey | null {
  const { status, reviewState, can } = amendment;
  if (status === "draft") {
    if (reviewState === "correction_requested") {
      return can.edit ? "correction" : "correction_sent";
    }
    return "draft";
  }
  // Decided, withdrawn or inadmissible: the outcome says it all, except to
  // the Secretaría while it can still publish it (validated, never made
  // public). Nobody else is told it will be published: a withdrawn or
  // inadmissible one may well stay private.
  if (status !== "submitted") return can.publish ? "to_publish" : null;
  switch (reviewState) {
    case "pending_validation":
      return can.validate ? "to_validate" : "pending";
    case "validated":
      return can.publish ? "to_publish" : "validated";
    case "published":
    case null:
      return "published";
    default:
      return null;
  }
}

/**
 * Where an amendment stands with the Secretaría, worded for the viewer
 * (its author, the Secretaría or anyone else). Null once it is decided.
 */
export function amendmentReviewView(
  amendment: AmendmentReviewInput,
): AmendmentReviewView | null {
  const key = reviewKeyOf(amendment);
  if (!key) return null;
  return {
    key,
    ...REVIEW_LOOK[key],
    private: isAmendmentPrivate(amendment),
    awaitingAdmission:
      amendment.status === "submitted" &&
      amendment.admission === "pending" &&
      (amendment.reviewState === "validated" ||
        amendment.reviewState === "published"),
  };
}

/**
 * The sentence for a review key, as an i18n key. Its presenters read about
 * "you" (who can see it, what they do next); anyone else who sees it before
 * publication (the Mesa) reads about the rest of the assembly.
 */
export function amendmentReviewSentenceKey(
  key: AmendmentReviewKey,
  presenter: boolean,
): string {
  const others = !presenter && (key === "pending" || key === "validated");
  return `amendment.review.states.${others ? `${key}_others` : key}`;
}

/**
 * The viewer presents the amendment: their member is one of its authors, or
 * they can edit it (a draft they created).
 */
export function isAmendmentPresenter(
  amendment: Pick<AmendmentDto, "authors"> & {
    can: Pick<AmendmentCapabilities, "edit">;
  },
  memberId: string | null,
): boolean {
  return amendment.can.edit || isAmendmentAuthor(amendment, memberId);
}

/**
 * The actor's amendments waiting for them: those the Secretaría sent back
 * for correction, then the drafts never sent. Only drafts they can edit.
 */
export function amendmentsAwaitingActor<
  T extends Pick<AmendmentDto, "status" | "reviewState"> & {
    can: Pick<AmendmentCapabilities, "edit">;
  },
>(list: T[]): { corrections: T[]; drafts: T[] } {
  const editable = list.filter(
    (amendment) => amendment.status === "draft" && amendment.can.edit,
  );
  return {
    corrections: editable.filter(
      (amendment) => amendment.reviewState === "correction_requested",
    ),
    drafts: editable.filter(
      (amendment) => amendment.reviewState !== "correction_requested",
    ),
  };
}

/** What the Secretaría still has to do on the listed amendments. */
export function amendmentReviewQueue(
  list: { can: Pick<AmendmentCapabilities, "validate" | "publish"> }[],
): { toValidate: number; toPublish: number } {
  return {
    toValidate: list.filter((amendment) => amendment.can.validate).length,
    toPublish: list.filter((amendment) => amendment.can.publish).length,
  };
}

/**
 * The admission badge only means something once the Secretaría validated
 * the amendment: before that, admission is settled by the validation.
 */
export function showAmendmentAdmission(
  amendment: Pick<AmendmentDto, "status" | "reviewState" | "admission">,
): boolean {
  if (amendment.status === "draft") return false;
  if (
    amendment.reviewState === "pending_validation" ||
    amendment.reviewState === "correction_requested"
  ) {
    return false;
  }
  return amendment.admission !== "admitted";
}

/**
 * What to tell the author right after sending an amendment: it waits for
 * the Secretaría (`review`, or `review_late` when the Mesa must also admit
 * it), or it is public at once (a transactional presented by the Mesa).
 */
export function amendmentSentNotice(
  amendment: Pick<AmendmentDto, "late" | "reviewState">,
): "review" | "review_late" | "public" {
  if (amendment.reviewState === "published") return "public";
  return amendment.late ? "review_late" : "review";
}

/**
 * Whether sending a draft now makes it late. One the Secretaría sent back
 * for correction keeps the timing of its first presentation (the server's
 * submissionLate); any other is late once the window has closed.
 */
export function amendmentLateOnSend(
  draft: Pick<AmendmentDto, "late" | "reviewState"> | null | undefined,
  windowClosed: boolean,
): boolean {
  return draft?.reviewState === "correction_requested"
    ? draft.late
    : windowClosed;
}

/** The actor's member presents it (alone or with others). */
export function isAmendmentAuthor(
  amendment: Pick<AmendmentDto, "authors">,
  memberId: string | null,
): boolean {
  return (
    memberId !== null &&
    amendment.authors.some((author) => author.id === memberId)
  );
}

function mineRank(
  amendment: Pick<AmendmentDto, "status" | "reviewState">,
): number {
  if (amendment.status === "draft") {
    return amendment.reviewState === "correction_requested" ? 0 : 1;
  }
  if (amendment.status !== "submitted") return 5;
  if (amendment.reviewState === "pending_validation") return 2;
  if (amendment.reviewState === "validated") return 3;
  return 4;
}

/**
 * "Mis enmiendas": the drafts the actor can edit and every amendment their
 * member presents, what needs their attention first (corrections asked,
 * then drafts), then those waiting for the Secretaría, the published ones
 * and the decided ones. Text order is kept within each group.
 */
export function mineAmendments<
  T extends Pick<AmendmentDto, "status" | "reviewState" | "authors"> & {
    can: Pick<AmendmentCapabilities, "edit">;
  },
>(list: T[], memberId: string | null): T[] {
  return list
    .filter(
      (amendment) =>
        (amendment.status === "draft" && amendment.can.edit) ||
        isAmendmentAuthor(amendment, memberId),
    )
    .map((amendment, index) => ({ amendment, index }))
    .sort(
      (a, b) =>
        mineRank(a.amendment) - mineRank(b.amendment) || a.index - b.index,
    )
    .map(({ amendment }) => amendment);
}

function timeOf(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/** Text order: position in the base, then number, then submission time. */
export function compareAmendments(a: AmendmentLike, b: AmendmentLike): number {
  if (a.positionKey !== b.positionKey) return a.positionKey - b.positionKey;
  const na = a.number ?? Number.POSITIVE_INFINITY;
  const nb = b.number ?? Number.POSITIVE_INFINITY;
  if (na !== nb) return na - nb;
  const ta = timeOf(a.submittedAt);
  const tb = timeOf(b.submittedAt);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortAmendments<T extends AmendmentLike>(list: T[]): T[] {
  return [...list].sort(compareAmendments);
}

// Overlaps ---------------------------------------------------------------------

/** Amendments that act on concrete passages (totality ones act on everything). */
function passageAmendments<T extends AmendmentLike>(list: T[]): T[] {
  return list.filter(
    (amendment) =>
      !isTotalityAmendment(amendment.kind) && amendment.ops.length > 0,
  );
}

export interface AmendmentOverlap {
  id: string;
  kind: OverlapKind;
}

/** For each amendment, the others it overlaps with and how. */
export function amendmentOverlapIndex(
  list: AmendmentLike[],
): Map<string, AmendmentOverlap[]> {
  const index = new Map<string, AmendmentOverlap[]>();
  const { pairs } = findOverlaps(
    passageAmendments(list).map(({ id, ops }) => ({ id, ops })),
  );
  for (const pair of pairs) {
    const a = index.get(pair.a) ?? [];
    a.push({ id: pair.b, kind: pair.kind });
    index.set(pair.a, a);
    const b = index.get(pair.b) ?? [];
    b.push({ id: pair.a, kind: pair.kind });
    index.set(pair.b, b);
  }
  return index;
}

export interface AmendmentGroup<T extends AmendmentLike = AmendmentDto> {
  key: string;
  /**
   * - `totality`: amendments to the whole text, always first (RFAG 23ter);
   * - `overlap`: amendments acting on the same passage;
   * - `single`: an amendment that overlaps with none of the others.
   */
  kind: "totality" | "overlap" | "single";
  amendments: T[];
}

/**
 * Groups amendments by overlap cluster, in text order. Groups follow the
 * position of their first member; members keep text order.
 */
export function groupAmendmentsByOverlap<T extends AmendmentLike>(
  list: T[],
): AmendmentGroup<T>[] {
  const sorted = sortAmendments(list);
  const totality = sorted.filter((amendment) =>
    isTotalityAmendment(amendment.kind),
  );
  const rest = sorted.filter(
    (amendment) => !isTotalityAmendment(amendment.kind),
  );
  const { clusters } = findOverlaps(
    passageAmendments(rest).map(({ id, ops }) => ({ id, ops })),
  );
  const clusterOf = new Map<string, number>();
  clusters.forEach((cluster, i) =>
    cluster.forEach((id) => clusterOf.set(id, i)),
  );

  const groups: AmendmentGroup<T>[] = [];
  if (totality.length > 0) {
    groups.push({ key: "totality", kind: "totality", amendments: totality });
  }
  const byCluster = new Map<number, AmendmentGroup<T>>();
  for (const amendment of rest) {
    const cluster = clusterOf.get(amendment.id);
    if (cluster === undefined) {
      groups.push({
        key: amendment.id,
        kind: "single",
        amendments: [amendment],
      });
      continue;
    }
    let group = byCluster.get(cluster);
    if (!group) {
      group = {
        key: `cluster-${amendment.id}`,
        kind: "overlap",
        amendments: [],
      };
      byCluster.set(cluster, group);
      groups.push(group);
    }
    group.amendments.push(amendment);
  }
  return groups;
}

// Gutter markers ---------------------------------------------------------------

/** Same shape as ContentView's BlockMarker. */
export interface AmendmentBlockMarker {
  count: number;
  overlap: boolean;
}

/**
 * How many undecided amendments touch each base block, and whether two of
 * them overlap there. Totality amendments are left out: they touch every
 * block and are listed apart.
 */
export function amendmentBlockMarkers(
  list: AmendmentLike[],
): Record<string, AmendmentBlockMarker> {
  const open = passageAmendments(list.filter(isAmendmentOpen));
  const touched = new Map(
    open.map((amendment) => [
      amendment.id,
      new Set(touchedBlockIds(amendment.ops)),
    ]),
  );
  const markers: Record<string, AmendmentBlockMarker> = {};
  for (const ids of touched.values()) {
    for (const id of ids) {
      const marker = (markers[id] ??= { count: 0, overlap: false });
      marker.count += 1;
    }
  }
  const { pairs } = findOverlaps(open.map(({ id, ops }) => ({ id, ops })));
  for (const pair of pairs) {
    const a = touched.get(pair.a);
    const b = touched.get(pair.b);
    if (!a || !b) continue;
    for (const id of a) {
      if (b.has(id) && markers[id]) markers[id].overlap = true;
    }
  }
  return markers;
}

// Filters ----------------------------------------------------------------------

export type AmendmentLateFilter = "any" | "late" | "on_time";

/** Review states a listed (non-draft) amendment can be in. */
export type AmendmentReviewFilter =
  "any" | Exclude<AmendmentReviewState, "correction_requested">;

export const AMENDMENT_REVIEW_FILTERS: readonly AmendmentReviewFilter[] = [
  "any",
  "pending_validation",
  "validated",
  "published",
];

export interface AmendmentFilters {
  statuses: AmendmentStatus[];
  memberIds: string[];
  kinds: AmendmentKind[];
  late: AmendmentLateFilter;
  /** Where it stands with the Secretaría (reviewers and authors). */
  review: AmendmentReviewFilter;
  /** Only amendments presented by the actor's member. */
  mine: boolean;
  /** Only amendments touching this base block (gutter marker). */
  blockId: string | null;
  query: string;
}

export function emptyAmendmentFilters(): AmendmentFilters {
  return {
    statuses: [],
    memberIds: [],
    kinds: [],
    late: "any",
    review: "any",
    mine: false,
    blockId: null,
    query: "",
  };
}

/** Number of filters in use, for the filter button badge. */
export function activeAmendmentFilterCount(filters: AmendmentFilters): number {
  return (
    (filters.statuses.length > 0 ? 1 : 0) +
    (filters.memberIds.length > 0 ? 1 : 0) +
    (filters.kinds.length > 0 ? 1 : 0) +
    (filters.late !== "any" ? 1 : 0) +
    (filters.review !== "any" ? 1 : 0) +
    (filters.mine ? 1 : 0) +
    (filters.blockId ? 1 : 0) +
    (filters.query.trim() ? 1 : 0)
  );
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function filterAmendmentList(
  list: AmendmentDto[],
  filters: AmendmentFilters,
  actorMemberId: string | null,
): AmendmentDto[] {
  const query = fold(filters.query.trim());
  return list.filter((amendment) => {
    if (
      filters.statuses.length > 0 &&
      !filters.statuses.includes(amendment.status)
    ) {
      return false;
    }
    if (filters.kinds.length > 0 && !filters.kinds.includes(amendment.kind)) {
      return false;
    }
    if (
      filters.memberIds.length > 0 &&
      !amendment.authors.some((author) => filters.memberIds.includes(author.id))
    ) {
      return false;
    }
    if (filters.late === "late" && !amendment.late) return false;
    if (filters.late === "on_time" && amendment.late) return false;
    // Amendments recorded before validation existed have no state: public.
    if (
      filters.review !== "any" &&
      (amendment.reviewState ?? "published") !== filters.review
    ) {
      return false;
    }
    if (
      filters.mine &&
      !(
        actorMemberId &&
        amendment.authors.some((author) => author.id === actorMemberId)
      )
    ) {
      return false;
    }
    if (
      filters.blockId &&
      !touchedBlockIds(amendment.ops).includes(filters.blockId)
    ) {
      return false;
    }
    if (query) {
      const haystack = fold(
        [
          amendmentDisplayLabel(amendment) ?? "",
          amendment.justification,
          ...amendment.authors.flatMap((author) => [
            author.acronym,
            author.name,
          ]),
        ].join(" "),
      );
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

// Relations --------------------------------------------------------------------

export interface AmendmentRelationView {
  relation: RelationDto;
  otherId: string;
  /** "from": this amendment is the subject ("depende de X"). */
  direction: "from" | "to";
}

export function amendmentRelationsOf(
  id: string,
  relations: RelationDto[],
): AmendmentRelationView[] {
  return relations.flatMap((relation): AmendmentRelationView[] => {
    if (relation.fromId === id) {
      return [{ relation, otherId: relation.toId, direction: "from" }];
    }
    if (relation.toId === id) {
      return [{ relation, otherId: relation.fromId, direction: "to" }];
    }
    return [];
  });
}

// Passage selection ------------------------------------------------------------

/** The smallest run of consecutive base blocks covering `ids`, in base order. */
export function contiguousBlockRange(base: Block[], ids: string[]): string[] {
  const index = indexBlocks(base);
  const positions = ids
    .map((id) => index.get(id))
    .filter((position): position is number => position !== undefined);
  if (positions.length === 0) return [];
  const start = Math.min(...positions);
  const end = Math.max(...positions);
  return base.slice(start, end + 1).map((block) => block.id);
}

export interface BlockSelection {
  ids: string[];
  /** Block the range grows from on shift-click. */
  anchor: string | null;
}

/**
 * Click selects one block (or clears it when it was the only one selected);
 * shift-click selects the range between the anchor and the clicked block.
 */
export function extendBlockSelection(
  base: Block[],
  current: BlockSelection,
  clickedId: string,
  extend: boolean,
): BlockSelection {
  const anchor =
    current.anchor && current.ids.includes(current.anchor)
      ? current.anchor
      : (current.ids[0] ?? null);
  if (extend && anchor) {
    return {
      ids: contiguousBlockRange(base, [anchor, clickedId]),
      anchor,
    };
  }
  if (current.ids.length === 1 && current.ids[0] === clickedId) {
    return { ids: [], anchor: null };
  }
  return { ids: [clickedId], anchor: clickedId };
}

export interface Passage {
  blocks: Block[];
  /** The base block right before the passage (null at the start). */
  anchorBefore: string | null;
  start: number;
  end: number;
}

export function passageOf(base: Block[], ids: string[]): Passage | null {
  const range = contiguousBlockRange(base, ids);
  if (range.length === 0) return null;
  const index = indexBlocks(base);
  const start = index.get(range[0]!)!;
  const end = index.get(range[range.length - 1]!)!;
  return {
    blocks: base.slice(start, end + 1),
    anchorBefore: start > 0 ? base[start - 1]!.id : null,
    start,
    end,
  };
}

function cloneBlock(block: Block): Block {
  return {
    ...block,
    marks: block.marks.map((mark) => ({ ...mark })),
  };
}

/** Editor seed for a passage: copies of its base blocks (ids kept). */
export function passageSeed(
  base: Block[],
  ids: string[],
  options: { appendEmpty?: () => string } = {},
): Block[] {
  const passage = passageOf(base, ids);
  const blocks = passage ? passage.blocks.map(cloneBlock) : [];
  if (options.appendEmpty) {
    blocks.push({
      id: options.appendEmpty(),
      type: "paragraph",
      text: "",
      marks: [],
    });
  }
  return blocks;
}

// Operations -------------------------------------------------------------------

/** Operations turning the selected passage into what the author left in the editor. */
export function passageAmendmentOps(
  base: Block[],
  ids: string[],
  edited: Block[],
  newId: () => string,
): AmendmentOp[] {
  const passage = passageOf(base, ids);
  if (!passage) return [];
  return diffPassage(passage.blocks, edited, passage.anchorBefore, newId);
}

/** "Suprimir": deletes the selected passage. */
export function deletePassageOps(base: Block[], ids: string[]): AmendmentOp[] {
  const range = contiguousBlockRange(base, ids);
  return range.length > 0 ? [{ op: "delete", blockIds: range }] : [];
}

/**
 * "Texto alternativo": deletes the whole base and inserts the new text at the
 * start. Empty blocks are dropped and ids already used by the base are renewed.
 */
export function totalityAlternativeOps(
  base: Block[],
  blocks: Block[],
  newId: () => string,
): AmendmentOp[] {
  const taken = new Set(base.map((block) => block.id));
  const fresh = blocks
    .filter((block) => block.text.trim() !== "")
    .map((block) => {
      let id = block.id;
      while (taken.has(id)) id = newId();
      taken.add(id);
      return id === block.id ? block : { ...block, id };
    });
  const ops: AmendmentOp[] = [];
  if (base.length > 0) {
    ops.push({ op: "delete", blockIds: base.map((block) => block.id) });
  }
  if (fresh.length > 0) {
    ops.push({ op: "insert", afterBlockId: null, blocks: fresh });
  }
  return ops;
}

/** The blocks a "texto alternativo" inserts. */
export function insertedBlocksOf(ops: AmendmentOp[]): Block[] {
  return ops.flatMap((op) => (op.op === "insert" ? op.blocks : []));
}

// Composer seed ------------------------------------------------------------------

export type AmendmentComposerMode =
  "passage" | "delete" | "global" | "return" | "alternative";

/** Composer modes on the selected passage, then those on the whole text. */
export const AMENDMENT_PASSAGE_MODES: readonly AmendmentComposerMode[] = [
  "passage",
  "delete",
];
export const AMENDMENT_TOTALITY_MODES: readonly AmendmentComposerMode[] = [
  "return",
  "alternative",
];

/**
 * The guided steps of the composer for a mode, in order:
 * - `what`: what the amendment does (and on which passage);
 * - `write`: write the change (passage, global term or alternative text);
 * - `check`: see the change against the text;
 * - `why`: the justification.
 * A deletion has nothing to write, and a return changes no text.
 */
export type AmendmentComposerStep = "what" | "write" | "check" | "why";

export function amendmentComposerSteps(
  mode: AmendmentComposerMode,
): AmendmentComposerStep[] {
  switch (mode) {
    case "delete":
      return ["what", "check", "why"];
    case "return":
      return ["what", "why"];
    default:
      return ["what", "write", "check", "why"];
  }
}

export interface AmendmentComposerSeed {
  mode: AmendmentComposerMode;
  /** Selected base block ids (passage and delete modes). */
  selection: string[];
  /** Editor content (passage and alternative modes). */
  edited: Block[];
  find: string;
  replace: string;
}

/**
 * Rebuilds the passage a draft was written on: the base range its operations
 * touch, and that range as the draft leaves it. Re-diffing the result yields
 * the same operations.
 */
export function draftPassage(
  base: Block[],
  ops: AmendmentOp[],
): { selection: string[]; edited: Block[] } {
  const index = indexBlocks(base);
  const positions = touchedBlockIds(ops)
    .map((id) => index.get(id))
    .filter((position): position is number => position !== undefined);
  if (ops.some((op) => op.op === "insert" && op.afterBlockId === null)) {
    positions.push(0);
  }
  if (positions.length === 0 || base.length === 0) {
    return { selection: [], edited: [] };
  }
  const start = Math.min(...positions);
  const end = Math.max(...positions);
  const selection = base.slice(start, end + 1).map((block) => block.id);

  const result = consolidate(base, [{ id: "draft", ops }]);
  if (result.conflicts.length > 0) {
    // The draft no longer applies: start again from the base passage.
    return {
      selection,
      edited: base.slice(start, end + 1).map(cloneBlock),
    };
  }

  const clean = new Map(result.blocks.map((block) => [block.id, block]));
  const edited: Block[] = [];
  let current = -1;
  for (const block of result.annotated) {
    const position =
      block.status === "inserted" ? undefined : index.get(block.id);
    if (position !== undefined) {
      current = position;
      if (block.status !== "deleted" && position >= start && position <= end) {
        edited.push(cloneBlock(clean.get(block.id)!));
      }
      continue;
    }
    const inPassage =
      (current >= start && current <= end) || (current === -1 && start === 0);
    if (inPassage && clean.has(block.id)) {
      edited.push(cloneBlock(clean.get(block.id)!));
    }
  }
  return { selection, edited };
}

function isContiguous(base: Block[], ids: string[]): boolean {
  const range = contiguousBlockRange(base, ids);
  return range.length === ids.length && range.every((id) => ids.includes(id));
}

/** Composer state to keep editing an existing draft. */
export function seedComposerFromDraft(
  base: Block[],
  draft: Pick<AmendmentDto, "kind" | "ops" | "globalReplace">,
): AmendmentComposerSeed {
  const empty = { selection: [], edited: [], find: "", replace: "" };
  if (draft.kind === "totality_return") return { ...empty, mode: "return" };
  if (draft.kind === "totality_alternative") {
    return {
      ...empty,
      mode: "alternative",
      edited: insertedBlocksOf(draft.ops).map(cloneBlock),
    };
  }
  if (draft.globalReplace) {
    return {
      ...empty,
      mode: "global",
      find: draft.globalReplace.find,
      replace: draft.globalReplace.replace,
    };
  }
  const deleted = draft.ops.flatMap((op) =>
    op.op === "delete" ? op.blockIds : [],
  );
  if (
    draft.ops.length > 0 &&
    draft.ops.every((op) => op.op === "delete") &&
    isContiguous(base, deleted)
  ) {
    return {
      ...empty,
      mode: "delete",
      selection: contiguousBlockRange(base, deleted),
    };
  }
  return { ...empty, mode: "passage", ...draftPassage(base, draft.ops) };
}

// Composer authors ---------------------------------------------------------------

export interface ComposerAuthorSeed {
  /** Member the draft is presented on behalf of (moderators only). */
  onBehalfOfMemberId: string | undefined;
  /** Co-authors shown in the picker: never the presenting nor the actor's member. */
  coAuthorIds: string[];
  /** The stored presenting member (authors[0]); null for a new amendment. */
  presentingMemberId: string | null;
  /**
   * The actor's member when it is a co-author but not the presenting member.
   * The picker hides it, so it is sent back on every save and the actor never
   * drops out of a draft they are editing.
   */
  keptMemberId: string | null;
}

/**
 * Splits a draft's authors (presenting member first, as the API orders them)
 * into what the composer shows. A moderator who is not an author edits it on
 * behalf of the presenting member.
 */
export function composerAuthorSeed(
  authorIds: string[],
  ownMemberId: string | null,
  canActOnBehalf: boolean,
): ComposerAuthorSeed {
  const [presenting, ...rest] = authorIds;
  if (!presenting) {
    return {
      onBehalfOfMemberId: undefined,
      coAuthorIds: [],
      presentingMemberId: null,
      keptMemberId: null,
    };
  }
  const ownIsAuthor = ownMemberId !== null && authorIds.includes(ownMemberId);
  return {
    onBehalfOfMemberId: !ownIsAuthor && canActOnBehalf ? presenting : undefined,
    coAuthorIds: rest.filter((id) => id !== ownMemberId),
    presentingMemberId: presenting,
    keptMemberId:
      ownIsAuthor && ownMemberId !== presenting ? ownMemberId : null,
  };
}

/** `authorMemberIds` to send: the picked co-authors plus the kept own member. */
export function composerAuthorMemberIds(
  coAuthorIds: string[],
  keptMemberId: string | null,
): string[] {
  return keptMemberId && !coAuthorIds.includes(keptMemberId)
    ? [...coAuthorIds, keptMemberId]
    : [...coAuthorIds];
}

// Composer sync ------------------------------------------------------------------

/**
 * True when `remote` is strictly later than `local` (ISO dates). A refresh
 * that started before the composer's own save may land after it with the
 * older copy; that one is not newer and must not look like a conflict.
 */
export function isNewerAmendmentVersion(
  remote: string | null | undefined,
  local: string | null | undefined,
): boolean {
  if (!remote || !local) return false;
  const r = Date.parse(remote);
  const l = Date.parse(local);
  if (Number.isNaN(r) || Number.isNaN(l)) return false;
  return r > l;
}

/**
 * Where the draft being edited stands against the stored one:
 * - `in_sync`: saving uses the composer's own lock token;
 * - `remote_newer`: someone else saved it: load theirs or overwrite;
 * - `conflict`: a save was refused and the stored copy has not arrived yet;
 * - `not_editable`: it was submitted, withdrawn or deleted meanwhile, or the
 *   document stopped admitting amendments (final vote, unpublished).
 */
export type ComposerSyncState =
  "in_sync" | "remote_newer" | "conflict" | "not_editable";

export function composerSyncState(input: {
  draftId: string | null;
  /** The composer's optimistic-lock token (updatedAt of its last load or save). */
  token: string | null;
  /** The stored draft, as the live list has it. */
  remote: Pick<AmendmentDto, "id" | "status" | "updatedAt"> | null;
  /** A save was refused with 409 or 404. */
  conflicted: boolean;
  /** The document still admits amendments (published, amendable, not voted). */
  documentOpen?: boolean;
}): ComposerSyncState {
  const { draftId, token, remote, conflicted, documentOpen = true } = input;
  if (!draftId) return "in_sync";
  if (!documentOpen) return "not_editable";
  const current = remote && remote.id === draftId ? remote : null;
  const newer =
    current !== null && isNewerAmendmentVersion(current.updatedAt, token);
  // Only drafts are edited: a stored copy past that stage ends the edit.
  if (current ? current.status !== "draft" : conflicted) return "not_editable";
  if (newer) return "remote_newer";
  return conflicted ? "conflict" : "in_sync";
}

// History ------------------------------------------------------------------------

/**
 * Changes whenever something that writes to the amendment's history changes.
 * Positions, acceptances and relations live in their own tables and do not
 * touch updatedAt (the optimistic-lock token), so they are folded in here.
 */
export function amendmentHistoryVersion(
  amendment: Pick<AmendmentDto, "updatedAt" | "position" | "acceptances">,
  relationIds: string[],
): string {
  return [
    amendment.updatedAt,
    amendment.position
      ? `${amendment.position.position}@${amendment.position.updatedAt}`
      : "",
    amendment.acceptances
      .map(
        (acceptance) =>
          `${acceptance.member.id}:${acceptance.decision}@${acceptance.decidedAt ?? ""}`,
      )
      .sort()
      .join(","),
    [...relationIds].sort().join(","),
  ].join("|");
}

// Consolidation ------------------------------------------------------------------

/**
 * Amendments to consolidate, in application order: the approved ones by
 * decision time, then (optionally) the undecided ones the proponent accepted.
 */
export function consolidationInputs(
  list: (AmendmentLike & Pick<AmendmentDto, "position">)[],
  includeAccepted = false,
): AmendmentInput[] {
  const approved = list
    .filter((amendment) => amendment.status === "approved")
    .filter((amendment) => amendment.ops.length > 0)
    .sort((a, b) => {
      const ta = timeOf(a.decidedAt);
      const tb = timeOf(b.decidedAt);
      return ta !== tb ? ta - tb : compareAmendments(a, b);
    });
  const accepted = includeAccepted
    ? sortAmendments(
        list.filter(
          (amendment) =>
            amendment.status === "submitted" &&
            amendment.position?.position === "accept" &&
            amendment.ops.length > 0,
        ),
      )
    : [];
  return [...approved, ...accepted].map(({ id, ops }) => ({ id, ops }));
}

// API errors -------------------------------------------------------------------

/** Reason codes of 422 answers (validateOps and the amendment API). */
export const AMENDMENT_ERROR_REASONS = [
  "empty",
  "delete_empty",
  "unknown_block",
  "duplicate_delete",
  "unknown_anchor",
  "duplicate_anchor",
  "insert_empty",
  "duplicate_block_id",
  "out_of_range",
  "anchor_mismatch",
  "noop",
  "replace_in_deleted_block",
  "overlapping_ops",
  "totality_return_ops",
  "inconsistent_counts",
] as const;

/** i18n key of a reason code; unknown codes share a generic message. */
export function amendmentErrorKey(reason: string): string {
  return (AMENDMENT_ERROR_REASONS as readonly string[]).includes(reason)
    ? `amendment.errors.${reason}`
    : "amendment.errors.unknown";
}

/** Distinct reason codes carried by a 422 response (`data.data.reasons`). */
export function amendmentErrorReasons(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const body = (error as { data?: unknown }).data;
  const inner =
    body && typeof body === "object"
      ? (body as { data?: unknown }).data
      : undefined;
  const reasons =
    inner && typeof inner === "object"
      ? (inner as { reasons?: unknown }).reasons
      : undefined;
  if (!Array.isArray(reasons)) return [];
  const codes = reasons
    .map((item) =>
      item && typeof item === "object"
        ? (item as { reason?: unknown }).reason
        : undefined,
    )
    .filter((code): code is string => typeof code === "string");
  return [...new Set(codes)];
}
