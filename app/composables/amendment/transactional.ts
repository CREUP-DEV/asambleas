/**
 * Pure helpers behind transactionals in the document workspace: which
 * amendments can be combined, the passage the composer starts from, where a
 * transactional stands (as a sentence with its next step), what happens
 * after sending one, who answers it (the main author of each amendment it
 * would replace), and how much waits for the document's main presenter in
 * the review mode. No Nuxt or Vue APIs here (transactional.test.ts).
 *
 * Every export is auto-imported app-wide (`imports.dirs: composables/**`),
 * hence the explicit, distinctive names.
 */
import type {
  AcceptedAmendmentRule,
  AmendmentStatus,
} from "~~/shared/constants/domain";
import type {
  AcceptanceDto,
  AmendmentDto,
  MemberRef,
} from "~~/shared/types/api";
import type { AmendmentInput, Block } from "~~/shared/types/content";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { copyShape } from "~~/shared/utils/content/lists";
import { touchedBlockIds } from "~~/shared/utils/content/ops";
import { MAX_TRANSACTIONAL_SOURCES } from "~~/shared/utils/schemas/amendment";
import { sessionReplacingIds } from "~/composables/session/sessionModel";
import {
  amendmentAwaitsPosition,
  amendmentMainAuthor,
  sortAmendments,
  type AmendmentPositionContext,
} from "./workspace";

// Sources ------------------------------------------------------------------------

type SourceLike = Pick<
  AmendmentDto,
  | "kind"
  | "status"
  | "admission"
  | "decidedAt"
  | "reviewState"
  | "ops"
  | "acceptances"
>;

/**
 * Every main author of the amendments a transactional would replace has
 * accepted it (only "author" rows count, as the server's authorsApproval).
 * Always true for any other amendment.
 */
function acceptedByMainAuthors(
  amendment: Pick<AmendmentDto, "kind" | "acceptances">,
): boolean {
  return (
    amendment.kind !== "transactional" ||
    amendment.acceptances.every(
      (party) => party.role !== "author" || party.decision === "accepted",
    )
  );
}

/**
 * Whether an amendment can be combined into a transactional: published (or
 * recorded before validation existed, hence public), admitted and still
 * undecided, and changing some passage of the text (a "devolución" has no
 * text to start from). Late amendments still waiting for the assembly's
 * decision are left out, as the server does. A transactional is a source
 * only once its main authors accepted it (it then replaced what it groups):
 * one still waiting for them, such as the Mesa's live one, published at
 * once, or one a main author rejected, is left out (the server's
 * transactionalSourceReason, `awaits_authors`).
 */
export function transactionalSourceEligible(amendment: SourceLike): boolean {
  return (
    amendment.status === "submitted" &&
    amendment.decidedAt === null &&
    amendment.admission === "admitted" &&
    (amendment.reviewState === "published" || amendment.reviewState === null) &&
    amendment.ops.length > 0 &&
    acceptedByMainAuthors(amendment)
  );
}

/** The amendments that can be combined, in text order. */
export function transactionalSourceCandidates<T extends AmendmentDto>(
  list: T[],
): T[] {
  return sortAmendments(list.filter(transactionalSourceEligible));
}

/**
 * The amendments of a group ("Mismo pasaje") that a transactional can
 * combine, in text order. A group offers one only when two or more qualify.
 */
export function transactionalGroupSources(
  group: (SourceLike & { id: string })[],
): string[] {
  return group
    .filter(transactionalSourceEligible)
    .map((amendment) => amendment.id);
}

/**
 * Sources in order of presentation (number, then position in the text):
 * when two collide, the first one shapes the starting text.
 */
export function transactionalSourcesInOrder<
  T extends Pick<AmendmentDto, "number" | "positionKey">,
>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      (a.number ?? Number.MAX_SAFE_INTEGER) -
        (b.number ?? Number.MAX_SAFE_INTEGER) || a.positionKey - b.positionKey,
  );
}

/**
 * How a choice of sources stands against the most a transactional may
 * combine (MAX_TRANSACTIONAL_SOURCES, the server's limit): `full` once no
 * more can be added (the remaining choices are disabled), `over` when a
 * choice that did not go through the list (an overlap group, a link) holds
 * more than that, so it cannot be sent until some are removed.
 */
export function transactionalSourceLimit(
  ids: string[],
  max: number = MAX_TRANSACTIONAL_SOURCES,
): { max: number; full: boolean; over: boolean } {
  const count = new Set(ids).size;
  return { max, full: count >= max, over: count > max };
}

/**
 * Chosen sources that can no longer be combined: decided, withdrawn or gone
 * while the composer was open. Sending waits until they are removed.
 */
export function transactionalSourceBlockers(
  ids: string[],
  byId: ReadonlyMap<string, SourceLike>,
): string[] {
  return ids.filter((id) => {
    const amendment = byId.get(id);
    return !amendment || !transactionalSourceEligible(amendment);
  });
}

// Composer seed ------------------------------------------------------------------

export interface TransactionalComposerSeed {
  /** The contiguous run of base blocks the sources touch. */
  passage: Block[];
  /** The base block right before the passage, null at the start. */
  anchorBefore: string | null;
  /** The passage with the sources applied, ready for the editor. */
  seed: Block[];
  /** Sources that could not be applied together with earlier ones. */
  skipped: string[];
}

/**
 * Starting point of a transactional: the passage touched by its sources,
 * with the sources applied in the given order. When two sources collide the
 * first applicable one wins, as `consolidate` does. Blocks the sources insert
 * get fresh ids, so they never clash with the sources' own. (Same rules as
 * the session console's composer.)
 */
export function transactionalComposerSeed(
  base: Block[],
  sources: AmendmentInput[],
  newId: () => string,
): TransactionalComposerSeed {
  const index = new Map(base.map((block, i) => [block.id, i]));
  const positions: number[] = [];
  for (const source of sources) {
    for (const id of touchedBlockIds(source.ops)) {
      const position = index.get(id);
      if (position !== undefined) positions.push(position);
    }
    if (
      source.ops.some((op) => op.op === "insert" && op.afterBlockId === null)
    ) {
      positions.push(0);
    }
  }
  if (positions.length === 0 || base.length === 0) {
    return { passage: [], anchorBefore: null, seed: [], skipped: [] };
  }

  const lo = Math.min(...positions);
  const hi = Math.max(...positions);
  const result = consolidate(base, sources);

  const seed: Block[] = [];
  let current = -1;
  for (const block of result.annotated) {
    if (block.status === "inserted") {
      const inside =
        (current >= lo || (lo === 0 && current === -1)) && current <= hi;
      if (!inside) continue;
    } else {
      current = index.get(block.id) ?? current;
      if (block.status === "deleted" || current < lo || current > hi) continue;
    }
    const clean: Block = {
      id: block.status === "inserted" ? newId() : block.id,
      type: block.type,
      text: block.segments
        .filter((segment) => !segment.removed)
        .map((segment) => segment.text)
        .join(""),
      marks: block.marks.map((mark) => ({ ...mark })),
    };
    seed.push(copyShape(block, clean));
  }

  return {
    passage: base.slice(lo, hi + 1),
    anchorBefore: lo > 0 ? base[lo - 1]!.id : null,
    seed,
    skipped: result.conflicts.map((conflict) => conflict.amendmentId),
  };
}

function blockContent(block: Block): string {
  return JSON.stringify([
    block.type,
    block.text,
    block.level ?? null,
    block.list ?? null,
    block.marker ?? null,
    block.start ?? null,
    block.cell ?? null,
    block.align ?? null,
    block.marks,
  ]);
}

/**
 * Whether two block lists hold the same text and formatting (ids left out:
 * the editor may renew one without changing its content). Tells whether the
 * author has edited the starting text.
 */
export function transactionalSameBlocks(a: Block[], b: Block[]): boolean {
  return (
    a.length === b.length &&
    a.every((block, index) => blockContent(block) === blockContent(b[index]!))
  );
}

/** Same ids, in any order and ignoring repeats. */
export function transactionalSameIds(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

// Progress ---------------------------------------------------------------------------

/**
 * Where a presented transactional stands, as the next thing that has to
 * happen (design.md, "Transactionals"):
 * - `rejected`: the main author of an amendment it would replace said no, so
 *   it is closed and the original amendments carry on;
 * - `authors`: the main authors of the amendments it would replace still
 *   have to answer (also the Mesa's live one, published at once);
 * - `validation`: the Secretaría has to check it; validating a
 *   transactional always publishes it, since it replaces amendments
 *   everyone can read;
 * - `publication`: checked but still private, only for transactionals
 *   validated before that rule: the Secretaría has to publish it;
 * - `admission`: late, the assembly still has to decide whether to treat it;
 * - `replaced`: accepted and validated, it replaced the original amendments
 *   (they are "transacted") and follows the normal flow;
 * - `accepted`: accepted and validated, but the list does not show its
 *   original amendments as replaced (hidden from the viewer, or recorded
 *   before replacements existed). Same next step, without naming them.
 */
export type TransactionalStage =
  | "rejected"
  | "authors"
  | "validation"
  | "publication"
  | "admission"
  | "replaced"
  | "accepted";

export interface TransactionalProgressView {
  stage: TransactionalStage;
  color: "info" | "warning" | "error" | "success";
  icon: string;
  /** Main authors that have not answered yet, in the order the API lists them. */
  missing: MemberRef[];
  /** Main authors that said no. */
  rejected: MemberRef[];
  /** The amendments it would replace (or replaced). */
  sourceIds: string[];
  /** The viewer's member has to answer now. */
  actorTurn: boolean;
}

const STAGE_LOOK: Record<
  TransactionalStage,
  Pick<TransactionalProgressView, "color" | "icon">
> = {
  rejected: { color: "error", icon: "i-lucide-circle-x" },
  authors: { color: "warning", icon: "i-lucide-users" },
  validation: { color: "info", icon: "i-lucide-hourglass" },
  publication: { color: "info", icon: "i-lucide-eye-off" },
  admission: { color: "warning", icon: "i-lucide-clock-alert" },
  replaced: { color: "success", icon: "i-lucide-git-merge" },
  accepted: { color: "success", icon: "i-lucide-circle-check" },
};

type ProgressInput = Pick<
  AmendmentDto,
  | "kind"
  | "status"
  | "reviewState"
  | "admission"
  | "acceptances"
  | "sourceIds"
  | "outcomeVote"
>;

/** Statuses a transactional a main author rejected may be left in. */
const CLOSED_BY_REJECTION: readonly AmendmentStatus[] = [
  "submitted",
  "rejected",
  "withdrawn",
  "lapsed",
];

/**
 * A main author rejected it, so it is closed and the originals carry on.
 * Whether the server keeps it "submitted" or closes it, the rejection is the
 * news, unless the assembly voted it (a vote is an outcome of its own).
 */
export function transactionalRejectedByAuthors(
  amendment: Pick<
    AmendmentDto,
    "kind" | "status" | "acceptances" | "outcomeVote"
  >,
): boolean {
  return (
    amendment.kind === "transactional" &&
    amendment.outcomeVote === null &&
    CLOSED_BY_REJECTION.includes(amendment.status) &&
    amendment.acceptances.some((party) => party.decision === "rejected")
  );
}

/**
 * The main authors whose rejection closed a transactional, in the order the
 * API lists them, from its acceptances (its outcome note stays for the
 * Mesa's own words, so it may be null). Empty when it was not closed by a
 * rejection: still open, voted, or closed for another reason (one of the
 * amendments it groups was settled or replaced: transactionalClosure).
 */
export function transactionalRejectedBy(
  amendment: Pick<
    AmendmentDto,
    "kind" | "status" | "acceptances" | "outcomeVote"
  >,
): MemberRef[] {
  if (!transactionalRejectedByAuthors(amendment)) return [];
  return amendment.acceptances
    .filter((party) => party.decision === "rejected")
    .map((party) => party.member);
}

/**
 * Why a transactional was closed without anyone rejecting it or voting it,
 * so the main authors still asked learn that their answer is no longer
 * needed:
 * - `source_replaced`: another transactional replaced one of the amendments
 *   it groups (that one is `transacted`);
 * - `source_decided`: one of them was settled otherwise (approved,
 *   incorporated, rejected, withdrawn, lapsed or inadmissible);
 * - `closed`: closed for another reason, or the viewer does not see the
 *   amendment that was settled.
 * `sourceId` names that amendment (null for `closed`). What counts is what
 * happened when it closed, not where its sources stand now: the server
 * stamps the settled amendment and the transactionals it closes with the
 * same `decidedAt`, so only a source settled at that very instant is named
 * (the first in the transactional's order). A source settled earlier (the
 * transactional itself replaced it, before the Mesa withdrew it) or later
 * (after its author withdrew it) did not close it: `closed` then. Null while
 * it is open, and once it was voted or a main author rejected it
 * (transactionalRejectedBy).
 */
export type TransactionalClosureReason =
  "source_replaced" | "source_decided" | "closed";

export interface TransactionalClosure {
  reason: TransactionalClosureReason;
  sourceId: string | null;
}

/** Statuses a transactional is left in when it closes on its own. */
const CLOSED_ON_ITS_OWN: readonly AmendmentStatus[] = ["withdrawn", "lapsed"];

/** A source as transactionalClosure looks it up: where it stands, since when. */
export type TransactionalClosureSource = Pick<
  AmendmentDto,
  "status" | "decidedAt"
>;

/** Both dates are set and name the same instant. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = new Date(a).getTime();
  return !Number.isNaN(left) && left === new Date(b).getTime();
}

export function transactionalClosure(
  amendment: Pick<
    AmendmentDto,
    | "kind"
    | "status"
    | "acceptances"
    | "outcomeVote"
    | "sourceIds"
    | "decidedAt"
  >,
  sourceOf?: (id: string) => TransactionalClosureSource | undefined,
): TransactionalClosure | null {
  if (
    amendment.kind !== "transactional" ||
    !CLOSED_ON_ITS_OWN.includes(amendment.status) ||
    amendment.outcomeVote !== null ||
    transactionalRejectedByAuthors(amendment)
  ) {
    return null;
  }
  for (const id of amendment.sourceIds) {
    const source = sourceOf?.(id);
    if (
      source === undefined ||
      source.status === "submitted" ||
      source.status === "draft" ||
      !sameInstant(source.decidedAt, amendment.decidedAt)
    ) {
      continue;
    }
    return {
      reason:
        source.status === "transacted" ? "source_replaced" : "source_decided",
      sourceId: id,
    };
  }
  return { reason: "closed", sourceId: null };
}

/**
 * Whether the sources are recorded as replaced ("transacted"), from the
 * list the viewer has. Null when it cannot be told: no lookup, or a source
 * the viewer does not see.
 */
export function transactionalSourcesReplaced(
  sourceIds: string[],
  statusOf?: (id: string) => AmendmentStatus | undefined,
): boolean | null {
  if (!statusOf || sourceIds.length === 0) return null;
  const statuses = sourceIds.map((id) => statusOf(id));
  if (statuses.some((status) => status === undefined)) return null;
  return statuses.every((status) => status === "transacted");
}

function stageOf(
  amendment: ProgressInput,
  missing: number,
  statusOf?: (id: string) => AmendmentStatus | undefined,
): TransactionalStage {
  if (transactionalRejectedByAuthors(amendment)) return "rejected";
  if (missing > 0) return "authors";
  if (
    amendment.reviewState === "pending_authors" ||
    amendment.reviewState === "pending_validation"
  ) {
    return "validation";
  }
  if (amendment.reviewState === "validated") return "publication";
  if (amendment.admission !== "admitted") return "admission";
  return transactionalSourcesReplaced(amendment.sourceIds, statusOf)
    ? "replaced"
    : "accepted";
}

/**
 * Where a transactional stands, worded around its next step, or null when
 * it is not a presented, undecided transactional (drafts and corrections
 * have their own review state; decided ones, their outcome), except one a
 * main author rejected, which says so. `statusOf` looks up the status of
 * the amendments it combines (the workspace list), to tell whether it has
 * replaced them.
 */
export function transactionalProgressOf(
  amendment: ProgressInput,
  actorMemberId: string | null,
  statusOf?: (id: string) => AmendmentStatus | undefined,
): TransactionalProgressView | null {
  if (amendment.kind !== "transactional") return null;
  if (
    amendment.status !== "submitted" &&
    !transactionalRejectedByAuthors(amendment)
  ) {
    return null;
  }
  const missing = amendment.acceptances
    .filter((party) => party.decision === "pending")
    .map((party) => party.member);
  const rejected = amendment.acceptances
    .filter((party) => party.decision === "rejected")
    .map((party) => party.member);
  const stage = stageOf(amendment, missing.length, statusOf);
  const actorTurn =
    stage === "authors" &&
    actorMemberId !== null &&
    missing.some((member) => member.id === actorMemberId);
  return {
    stage,
    ...STAGE_LOOK[stage],
    missing,
    rejected,
    sourceIds: [...amendment.sourceIds],
    actorTurn,
  };
}

/** "CEUM, CEUCA": acronyms of a list of members. */
export function transactionalMemberList(members: MemberRef[]): string {
  return members.map((member) => member.acronym).join(", ");
}

/** Plain ", " join: the text layer passes a locale-aware one (Intl.ListFormat). */
function joinComma(items: string[]): string {
  return items.join(", ");
}

export interface TransactionalProgressMessage {
  /** i18n key under `transactional.progress`. */
  key: string;
  params: Record<string, string>;
}

export interface TransactionalProgressWords {
  /** Labels of the amendments it combines, in order ("CEUM 1", "CAUB 1"). */
  sources?: string[];
  /** Joins a list for a sentence ("CEUM 1 y CAUB 1"). */
  join?: (items: string[]) => string;
}

/**
 * The words for where a transactional stands, as an i18n key and its
 * parameters: `short` for one line on a card ("Falta que respondan: …"),
 * `long` for the detail, with the next step. While the Secretaría has it
 * (`validation`, `publication`) the detail keeps the Secretaría's own
 * review sentence, so `long` is null there. The viewer is told when it is
 * their turn ("Te toca responder"); those who said no are named.
 */
export function transactionalProgressMessage(
  view: TransactionalProgressView,
  form: "short" | "long",
  words: TransactionalProgressWords = {},
): TransactionalProgressMessage | null {
  const prefix = `transactional.progress.${form}`;
  const join = words.join ?? joinComma;
  switch (view.stage) {
    case "validation":
    case "publication":
      return form === "long"
        ? null
        : { key: `${prefix}.${view.stage}`, params: {} };
    case "rejected":
      return {
        key: `${prefix}.rejected`,
        params: { members: join(view.rejected.map((m) => m.acronym)) },
      };
    case "authors": {
      const members = join(view.missing.map((m) => m.acronym));
      if (view.actorTurn) {
        return {
          key: `${prefix}.yourAnswer`,
          params: form === "long" ? { members } : {},
        };
      }
      return { key: `${prefix}.authors`, params: { members } };
    }
    case "replaced": {
      const sources = words.sources ?? [];
      return sources.length > 0
        ? { key: `${prefix}.replaced`, params: { list: join(sources) } }
        : { key: `${prefix}.accepted`, params: {} };
    }
    default:
      return { key: `${prefix}.${view.stage}`, params: {} };
  }
}

/**
 * While the Secretaría has it, what happens once it is checked: it is
 * published and replaces the amendments it combines (`validation`), or it
 * already replaced them (`publication`, an older private one, with the
 * originals recorded as replaced). Null past that stage, or when main
 * authors still have to answer (that comes first).
 */
export function transactionalAfterSecretaria(
  view: TransactionalProgressView,
  words: TransactionalProgressWords = {},
  replaced: boolean | null = null,
): TransactionalProgressMessage | null {
  if (view.stage !== "validation" && view.stage !== "publication") return null;
  const sources = words.sources ?? [];
  if (sources.length === 0) return null;
  const list = (words.join ?? joinComma)(sources);
  if (view.stage === "validation") {
    return { key: "transactional.progress.afterSecretaria", params: { list } };
  }
  return replaced
    ? { key: "transactional.progress.alreadyReplaced", params: { list } }
    : null;
}

// After sending --------------------------------------------------------------------------

/**
 * What happens to a transactional once sent, in order, starting from where
 * the answer of the server left it:
 * - `authors`: the main authors of the amendments it would replace accept
 *   or reject it (`members`, those still to answer); a rejection closes it;
 * - `secretaria`: the Secretaría checks it, which publishes it (skipped
 *   when the Mesa proposed it: it is public at once);
 * - `replaces`: it replaces the amendments it combines;
 * - `answer`: the document's main presenter answers it, and the assembly
 *   votes it, or it is incorporated if accepted (`rule`, the document's).
 */
export type TransactionalNextStep =
  | { key: "authors"; members: MemberRef[] }
  | { key: "secretaria" }
  | { key: "replaces"; sourceIds: string[] }
  | { key: "answer"; rule: AcceptedAmendmentRule };

export function transactionalNextSteps(
  amendment: Pick<AmendmentDto, "reviewState" | "acceptances" | "sourceIds">,
  rule: AcceptedAmendmentRule = "vote",
): TransactionalNextStep[] {
  const steps: TransactionalNextStep[] = [];
  const pending = amendment.acceptances
    .filter((party) => party.decision === "pending")
    .map((party) => party.member);
  if (pending.length > 0) steps.push({ key: "authors", members: pending });
  if (
    amendment.reviewState === "pending_authors" ||
    amendment.reviewState === "pending_validation" ||
    amendment.reviewState === "validated"
  ) {
    steps.push({ key: "secretaria" });
  }
  steps.push({ key: "replaces", sourceIds: [...amendment.sourceIds] });
  steps.push({ key: "answer", rule });
  return steps;
}

/**
 * Main authors who will have to accept a transactional over these
 * amendments, other than the proposer's own member (its answer is taken as
 * given), in order and without repeats. Empty: it goes straight to the
 * Secretaría.
 */
export function transactionalAuthorsToAsk(
  sources: Pick<AmendmentDto, "authors" | "mainAuthorId">[],
  proposerMemberId: string | null,
): MemberRef[] {
  const seen = new Map<string, MemberRef>();
  for (const source of sources) {
    const main = amendmentMainAuthor(source);
    if (main && main.id !== proposerMemberId && !seen.has(main.id)) {
      seen.set(main.id, main);
    }
  }
  return [...seen.values()];
}

/**
 * The acceptance a source's main author gives on a transactional over it:
 * its row among the parties, found by member (null when it is not a party,
 * as with transactionals recorded before main authors existed).
 */
export function transactionalAnswerOf<T extends Pick<AcceptanceDto, "member">>(
  acceptances: T[],
  memberId: string | null,
): T | null {
  if (memberId === null) return null;
  return acceptances.find((party) => party.member.id === memberId) ?? null;
}

/**
 * The viewer's member is the main author of `source` and it is its turn to
 * accept or reject the transactional over it: the transactional is still
 * open, the main author's row waits, and the server lets the viewer answer
 * (`can.accept`).
 */
export function transactionalAuthorTurn(
  transactional: Pick<AmendmentDto, "status" | "acceptances" | "can">,
  source: Pick<AmendmentDto, "authors" | "mainAuthorId">,
  actorMemberId: string | null,
): boolean {
  const mainAuthorId = amendmentMainAuthor(source)?.id ?? null;
  const party = transactionalAnswerOf(transactional.acceptances, mainAuthorId);
  return (
    transactional.status === "submitted" &&
    party !== null &&
    party.decision === "pending" &&
    party.member.id === actorMemberId &&
    transactional.can.accept
  );
}

/**
 * The main author was asked to answer a transactional that then closed
 * without a vote or a rejection before it answered (withdrawn or lapsed:
 * one of the amendments it groups was settled or replaced, or it was
 * withdrawn; transactionalClosure says which): the answer is no longer
 * needed, and the main author is told so instead of being left waiting.
 */
export function transactionalAnswerNotNeeded(
  transactional: Pick<
    AmendmentDto,
    "kind" | "status" | "acceptances" | "outcomeVote"
  >,
  mainAuthorId: string | null,
): boolean {
  return (
    transactional.kind === "transactional" &&
    CLOSED_ON_ITS_OWN.includes(transactional.status) &&
    transactional.outcomeVote === null &&
    !transactionalRejectedByAuthors(transactional) &&
    transactionalAnswerOf(transactional.acceptances, mainAuthorId)?.decision ===
      "pending"
  );
}

/**
 * Transactionals over `source` worth showing on it, with its main author's
 * answer (who, what, when): open ones, ones a main author's rejection
 * closed, any its main author already answered, whatever became of it
 * since, so its co-authors keep seeing that answer, and any that closed on
 * its own while waiting for that answer (transactionalAnswerNotNeeded), so
 * nobody wonders whether they still have to answer. Transactionals the
 * viewer does not see are left out; the order is the API's.
 */
export function transactionalsOverSource<
  T extends Pick<
    AmendmentDto,
    "id" | "kind" | "status" | "acceptances" | "outcomeVote"
  >,
>(
  source: Pick<AmendmentDto, "authors" | "mainAuthorId" | "transactionalIds">,
  byId: ReadonlyMap<string, T>,
): T[] {
  const mainAuthorId = amendmentMainAuthor(source)?.id ?? null;
  return source.transactionalIds
    .map((id) => byId.get(id))
    .filter(
      (item): item is T =>
        item !== undefined &&
        item.kind === "transactional" &&
        (item.status === "submitted" ||
          transactionalRejectedByAuthors(item) ||
          transactionalAnswerNotNeeded(item, mainAuthorId) ||
          (transactionalAnswerOf(item.acceptances, mainAuthorId)?.decision ??
            "pending") !== "pending"),
    );
}

export interface TransactionalLinks {
  /** The transactionals that replaced it (it is `transacted`). */
  replacedBy: string[];
  /** Open transactionals proposed over it (it is still `submitted`). */
  proposed: string[];
}

/**
 * How an amendment stands with the transactionals over it, for one line on
 * its card: a replaced (`transacted`) amendment names the ones that replaced
 * it (sessionReplacingIds: the one that did stays named whatever happened
 * to it later), a presented one the open transactionals proposed over it
 * that no main author turned down. Drafts and unknown ids (not loaded) are
 * left out; any other status has neither.
 */
export function transactionalLinksOf(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): TransactionalLinks {
  if (amendment.status === "transacted") {
    return {
      replacedBy: sessionReplacingIds(amendment, byId).filter((id) =>
        byId.has(id),
      ),
      proposed: [],
    };
  }
  if (amendment.status === "submitted") {
    return {
      replacedBy: [],
      proposed: amendment.transactionalIds.filter((id) => {
        const transactional = byId.get(id);
        return (
          transactional !== undefined &&
          transactional.kind === "transactional" &&
          transactional.status === "submitted" &&
          !transactional.acceptances.some(
            (party) => party.decision === "rejected",
          )
        );
      }),
    };
  }
  return { replacedBy: [], proposed: [] };
}

/**
 * The amendments a party answers for: the sources whose main author it is.
 * Feeds "autor principal de 12 · CEUM 4" next to each party.
 */
export function transactionalPartySources<
  T extends Pick<AmendmentDto, "id" | "authors" | "mainAuthorId">,
>(sources: T[], memberId: string): T[] {
  return sources.filter(
    (source) => amendmentMainAuthor(source)?.id === memberId,
  );
}

// The presenter's review ---------------------------------------------------------------

/**
 * What waits for the document's main presenter in the review mode (the Mesa
 * can answer for it too), by the document's rule for accepted amendments:
 * undecided amendments that reached it (published, so validated, admitted
 * if late, and for a transactional, accepted by the main authors:
 * amendmentAwaitsPosition) without its answer yet, among those the viewer
 * can answer (`can.position`, held by the main presenter and the Mesa
 * only), and nothing once the document was voted (`context.finalVoted`).
 * It is the count of the review mode's pending steps (isPositionReviewable)
 * and of the server's countPositionsPending, under either rule: one the
 * Secretaría keeps private waits until it is published. Answers belong to
 * the amendment, not to whoever records them, so the main presenter and
 * the Mesa count the same answers.
 */
export function proponentReviewBacklog(
  list: Pick<
    AmendmentDto,
    | "kind"
    | "status"
    | "reviewState"
    | "admission"
    | "validatedAt"
    | "position"
    | "acceptances"
    | "approvalMethod"
    | "can"
  >[],
  rule: AcceptedAmendmentRule,
  context: AmendmentPositionContext = {},
): { positions: number; total: number } {
  let positions = 0;
  for (const amendment of list) {
    if (
      amendment.can.position &&
      amendment.status === "submitted" &&
      amendmentAwaitsPosition(amendment, rule, context) &&
      (amendment.position === null || amendment.position.position === "pending")
    ) {
      positions += 1;
    }
  }
  return { positions, total: positions };
}
