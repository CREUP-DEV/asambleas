/**
 * Pure helpers behind transactionals in the document workspace: which
 * amendments can be combined, the passage the composer starts from, where a
 * transactional stands (as a sentence with its next step), what happens
 * after sending one, and how much waits for the document's presenter in the
 * review mode. No Nuxt or Vue APIs here (transactional.test.ts).
 *
 * Every export is auto-imported app-wide (`imports.dirs: composables/**`),
 * hence the explicit, distinctive names.
 */
import type {
  AcceptanceDto,
  AmendmentDto,
  MemberRef,
} from "~~/shared/types/api";
import type { AmendmentInput, Block } from "~~/shared/types/content";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { touchedBlockIds } from "~~/shared/utils/content/ops";
import { MAX_TRANSACTIONAL_SOURCES } from "~~/shared/utils/schemas/amendment";
import { sortAmendments } from "./workspace";

// Sources ------------------------------------------------------------------------

type SourceLike = Pick<
  AmendmentDto,
  "status" | "admission" | "decidedAt" | "reviewState" | "ops"
>;

/**
 * Whether an amendment can be combined into a transactional: published (or
 * recorded before validation existed, hence public), admitted and still
 * undecided, and changing some passage of the text (a "devolución" has no
 * text to start from). Late amendments still waiting for the assembly's
 * decision are left out, as the server does.
 */
export function transactionalSourceEligible(amendment: SourceLike): boolean {
  return (
    amendment.status === "submitted" &&
    amendment.decidedAt === null &&
    amendment.admission === "admitted" &&
    (amendment.reviewState === "published" || amendment.reviewState === null) &&
    amendment.ops.length > 0
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
    if (block.level !== undefined) clean.level = block.level;
    if (block.list !== undefined) clean.list = block.list;
    seed.push(clean);
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
 * happen before it can be voted:
 * - `proponent`: the document's presenter has to approve it;
 * - `proponent_rejected`: the presenter did not approve it;
 * - `validation` / `publication`: the Secretaría has to check it, or to
 *   publish it once checked;
 * - `rejected`: a party does not accept it, so it cannot be voted;
 * - `parties`: some parties have not accepted it yet;
 * - `admission`: the assembly still has to decide whether to treat it;
 * - `ready`: everyone accepted it, it can be voted.
 */
export type TransactionalStage =
  | "proponent"
  | "proponent_rejected"
  | "validation"
  | "publication"
  | "rejected"
  | "parties"
  | "admission"
  | "ready";

export interface TransactionalProgressView {
  stage: TransactionalStage;
  color: "info" | "warning" | "error" | "success";
  icon: string;
  /** The document's presenter, as a party of the transactional. */
  proponent: MemberRef | null;
  /** Parties that have not answered yet, in the order the API lists them. */
  missing: MemberRef[];
  /** Parties that said no. */
  rejected: MemberRef[];
  /** The viewer's member has to answer now. */
  actorTurn: boolean;
}

const STAGE_LOOK: Record<
  TransactionalStage,
  Pick<TransactionalProgressView, "color" | "icon">
> = {
  proponent: { color: "info", icon: "i-lucide-user-check" },
  proponent_rejected: { color: "error", icon: "i-lucide-user-x" },
  validation: { color: "info", icon: "i-lucide-hourglass" },
  publication: { color: "info", icon: "i-lucide-eye-off" },
  rejected: { color: "error", icon: "i-lucide-circle-x" },
  parties: { color: "warning", icon: "i-lucide-users" },
  admission: { color: "warning", icon: "i-lucide-clock-alert" },
  ready: { color: "success", icon: "i-lucide-circle-check" },
};

/**
 * The row of the document's presenter among the parties of a
 * transactional. Matched by member, as the server does (proponentApproval):
 * when the presenter also wrote a source, or an earlier transactional the
 * new one builds on, its single row has the role "author". The role
 * "proponent" is the fallback when the presenter's member is not known.
 */
export function transactionalPresenterParty<
  T extends Pick<AcceptanceDto, "member" | "role">,
>(acceptances: T[], proponentMemberId: string | null = null): T | null {
  return (
    (proponentMemberId
      ? acceptances.find((party) => party.member.id === proponentMemberId)
      : undefined) ??
    acceptances.find((party) => party.role === "proponent") ??
    null
  );
}

type ProgressInput = Pick<
  AmendmentDto,
  "kind" | "status" | "reviewState" | "admission" | "acceptances"
>;

function stageOf(
  amendment: ProgressInput,
  proponentDecision: string | null,
  missing: number,
  rejected: number,
): TransactionalStage {
  switch (amendment.reviewState) {
    case "pending_proponent":
      return proponentDecision === "rejected"
        ? "proponent_rejected"
        : "proponent";
    case "pending_validation":
      return "validation";
    case "validated":
      return "publication";
    default:
      if (rejected > 0) return "rejected";
      if (missing > 0) return "parties";
      return amendment.admission === "admitted" ? "ready" : "admission";
  }
}

/**
 * Where a transactional stands, worded around its next step, or null when
 * it is not a presented, undecided transactional (drafts and corrections
 * have their own review state; decided ones, their outcome).
 * `proponentMemberId` is the document's presenter (document.proponent),
 * found among the parties by member (transactionalPresenterParty).
 */
export function transactionalProgressOf(
  amendment: ProgressInput,
  actorMemberId: string | null,
  proponentMemberId: string | null = null,
): TransactionalProgressView | null {
  if (amendment.kind !== "transactional" || amendment.status !== "submitted") {
    return null;
  }
  const proponentParty = transactionalPresenterParty(
    amendment.acceptances,
    proponentMemberId,
  );
  const missing = amendment.acceptances
    .filter((party) => party.decision === "pending")
    .map((party) => party.member);
  const rejected = amendment.acceptances
    .filter((party) => party.decision === "rejected")
    .map((party) => party.member);
  const stage = stageOf(
    amendment,
    proponentParty?.decision ?? null,
    missing.length,
    rejected.length,
  );
  const mine = (member: MemberRef | null | undefined) =>
    actorMemberId !== null && member?.id === actorMemberId;
  const actorTurn =
    stage === "proponent"
      ? mine(proponentParty?.member)
      : (stage === "parties" ||
          stage === "rejected" ||
          stage === "validation" ||
          stage === "publication") &&
        missing.some((member) => mine(member));
  return {
    stage,
    ...STAGE_LOOK[stage],
    proponent: proponentParty?.member ?? null,
    missing,
    rejected,
    actorTurn,
  };
}

/** "CEUM, CEUCA": acronyms of a list of members. */
export function transactionalMemberList(members: MemberRef[]): string {
  return members.map((member) => member.acronym).join(", ");
}

export interface TransactionalProgressMessage {
  /** i18n key under `transactional.progress`. */
  key: string;
  params: Record<string, string>;
}

/**
 * The words for where a transactional stands, as an i18n key and its
 * parameters: `short` for one line on a card ("Falta que la acepten: …"),
 * `long` for the detail, with the next step. While the Secretaría has it
 * (`validation`, `publication`) the detail keeps the Secretaría's own
 * review sentence, so `long` is null there. The viewer is told when it is
 * their turn ("Te toca aprobarla"); those who said no are named when it is
 * stuck on them.
 */
export function transactionalProgressMessage(
  view: TransactionalProgressView,
  form: "short" | "long",
): TransactionalProgressMessage | null {
  const prefix = `transactional.progress.${form}`;
  const member = view.proponent?.acronym ?? "";
  switch (view.stage) {
    case "validation":
    case "publication":
      return form === "long"
        ? null
        : { key: `${prefix}.${view.stage}`, params: {} };
    case "proponent":
      if (view.actorTurn) return { key: `${prefix}.yourApproval`, params: {} };
      return view.proponent
        ? { key: `${prefix}.proponent`, params: { member } }
        : { key: `${prefix}.proponentUnknown`, params: {} };
    case "proponent_rejected":
      return { key: `${prefix}.proponent_rejected`, params: { member } };
    case "rejected":
      return {
        key: `${prefix}.rejected`,
        params: { members: transactionalMemberList(view.rejected) },
      };
    case "parties": {
      const members = transactionalMemberList(view.missing);
      if (view.actorTurn) {
        return {
          key: `${prefix}.yourAcceptance`,
          params: form === "long" ? { members } : {},
        };
      }
      return { key: `${prefix}.parties`, params: { members } };
    }
    default:
      return { key: `${prefix}.${view.stage}`, params: {} };
  }
}

/**
 * While the Secretaría has it, who will still have to accept it before the
 * vote (null when nobody, or past that stage).
 */
export function transactionalAfterSecretaria(
  view: TransactionalProgressView,
): TransactionalProgressMessage | null {
  if (view.stage !== "validation" && view.stage !== "publication") return null;
  if (view.missing.length === 0) return null;
  return {
    key: "transactional.progress.afterSecretaria",
    params: { members: transactionalMemberList(view.missing) },
  };
}

// After sending --------------------------------------------------------------------------

/**
 * What happens to a transactional once sent, in order, starting from where
 * the answer of the server left it:
 * - `proponent`: the document's presenter approves it (skipped when the
 *   presenter proposed it, or when the Mesa did, live);
 * - `secretaria`: the Secretaría checks and publishes it (skipped when the
 *   Mesa proposed it: it is public at once);
 * - `parties`: the parties still pending accept it (`members`); after the
 *   presenter's step, only the authors of the amendments it combines;
 * - `vote`: then the Mesa can put it to the vote.
 * The presenter is found by member (`proponentMemberId`, the document's
 * presenter), also when it wrote a source and its row has the role "author".
 */
export type TransactionalNextStep =
  | { key: "proponent"; members: MemberRef[] }
  | { key: "secretaria"; members: [] }
  | { key: "parties"; members: MemberRef[] }
  | { key: "vote"; members: [] };

export function transactionalNextSteps(
  amendment: Pick<AmendmentDto, "reviewState" | "acceptances">,
  proponentMemberId: string | null = null,
): TransactionalNextStep[] {
  const steps: TransactionalNextStep[] = [];
  const pending = amendment.acceptances.filter(
    (party) => party.decision === "pending",
  );
  const proponentStep = amendment.reviewState === "pending_proponent";
  const presenter = proponentStep
    ? transactionalPresenterParty(pending, proponentMemberId)
    : null;
  if (proponentStep) {
    steps.push({
      key: "proponent",
      members: presenter ? [presenter.member] : [],
    });
  }
  if (
    proponentStep ||
    amendment.reviewState === "pending_validation" ||
    amendment.reviewState === "validated"
  ) {
    steps.push({ key: "secretaria", members: [] });
  }
  const parties = pending
    .filter((party) => party !== presenter)
    .map((party) => party.member);
  if (parties.length > 0) steps.push({ key: "parties", members: parties });
  steps.push({ key: "vote", members: [] });
  return steps;
}

// The presenter's review ---------------------------------------------------------------

/**
 * What waits for the document's presenter in the review mode (the Mesa can
 * answer for it too): undecided amendments without its position yet, and
 * transactionals waiting for its approval. Mirrors MeWorkProponentDto
 * (countProponentWork), which finds the presenter's answer by member:
 * `proponentMemberId` is the document's presenter, not the viewer.
 */
export function proponentReviewBacklog(
  list: Pick<
    AmendmentDto,
    "kind" | "status" | "reviewState" | "position" | "acceptances" | "can"
  >[],
  proponentMemberId: string | null = null,
): { positions: number; transactionals: number; total: number } {
  let positions = 0;
  let transactionals = 0;
  for (const amendment of list) {
    if (amendment.status !== "submitted") continue;
    if (amendment.kind === "transactional") {
      const presenter = transactionalPresenterParty(
        amendment.acceptances,
        proponentMemberId,
      );
      if (presenter?.decision === "pending") transactionals += 1;
      continue;
    }
    if (
      amendment.can.position &&
      amendment.reviewState !== "pending_validation" &&
      (amendment.position === null || amendment.position.position === "pending")
    ) {
      positions += 1;
    }
  }
  return { positions, transactionals, total: positions + transactionals };
}
