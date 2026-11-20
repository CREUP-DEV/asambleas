import {
  createError,
  getRouterParam,
  isError,
  readBody,
  type H3Event,
} from "h3";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { z } from "zod/v4";
import { db } from "../../db";
import {
  amendmentAcceptances,
  amendmentAuthors,
  amendmentPositions,
  amendmentRelations,
  amendmentSources,
  amendments,
  decisions,
  transactionalRevisionAcceptances,
  transactionalRevisions,
  documentVersions,
  documents,
  events,
  liveState,
  members,
  roles,
  users,
  votes,
  type AmendmentMeta,
} from "../../db/schema";
import { cuid } from "../../db/schema/common";
import type {
  AcceptanceDecision,
  AcceptedAmendmentRule,
  AdmissionStatus,
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  AssemblySettings,
  Majority,
  ProponentPosition,
  RelationKind,
} from "../../../shared/constants/domain";
import {
  amendmentVoteMajority,
  GENERIC_EXECUTIVE_MEMBER_ID,
} from "../../../shared/constants/domain";
import { PERMISSION_KEYS } from "../../../shared/constants/permissions";
import type {
  AcceptanceBody,
  AcceptanceDto,
  AdmissionBody,
  AmendmentAuthorsBody,
  AmendmentCapabilities,
  AmendmentComposerAuthorsDto,
  AmendmentDraftBody,
  AmendmentDto,
  AmendmentUpdateBody,
  AmendmentAdmissionDto,
  AmendmentOutcomeDto,
  ApprovalWarnings,
  BulkAssentBody,
  BulkAssentDto,
  CorrectionBody,
  UndoValidationBody,
  DocumentAmendmentsDto,
  EventDto,
  MemberRef,
  OutcomeBody,
  PositionBody,
  PublishAmendmentsBody,
  ReclassifyBody,
  RelationBody,
  RelationDto,
  TransactionalBody,
  TransactionalRevisionBody,
  TransactionalRevisionDto,
  ValidateAmendmentsBody,
  VoteInput,
} from "../../../shared/types/api";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { authorsChange } from "../../../shared/utils/amendmentAuthors";
import {
  amendmentCodePrefix,
  amendmentCodeSeq,
  formatAmendmentCode,
} from "../../../shared/utils/amendmentCode";
import {
  canReclassifyAmendment,
  reclassifyTarget,
} from "../../../shared/utils/amendmentReclassify";
import {
  amendmentWindow,
  isLateSubmission,
  type AmendmentWindow,
  type Milestones,
} from "../../../shared/utils/calendar";
import {
  changeKinds,
  positionKey,
  validateOps,
  type OpError,
} from "../../../shared/utils/content/ops";
import {
  computeVoteOutcome,
  type VoteCounts,
  type VoteOutcome,
} from "../../../shared/utils/votes";
import { isUniqueConstraintViolation } from "../errors";
import {
  buildOptimisticLockCondition,
  getOptimisticLockTimestampMs,
} from "../optimisticLock";
import {
  actsFor,
  canModerate,
  canRecordResults,
  canReviewAmendments,
  requireActor,
  UNLINKED_ACCOUNT_MESSAGE,
  type Actor,
} from "./actor";
import {
  assemblySettings,
  clearLiveVote,
  loadMilestones,
  pointLiveVote,
  shareLockAssembly,
} from "./documents";
import { recordEvent } from "./events";
import { loadPassageWordings, toPassageWordingDto } from "./wordings";
import { amendmentsMeet } from "../../../shared/utils/content/passages";
import { assertSessionOpen } from "./sessionOpen";
import { toVoteDto, type VoteRow } from "./votes";
import {
  loadAnswersOnValidation,
  loadExecutiveMask,
  loadExecutiveMemberIds,
  requireAmendmentBodyMembers,
} from "./executiveMembers";
import { withHeadcount } from "./headcounts";
import { assertOpImagesBelong } from "./documentImages";
import {
  impersonatedByFor,
  loadImpersonators,
  seesImpersonator,
} from "./impersonators";
import {
  resolveAmendment,
  resolveAssembly,
  resolveDocument,
} from "./resolvers";
import {
  MAIN_AUTHOR_MESSAGES,
  POSITION_BLOCKER_MESSAGES,
  TRANSACTIONAL_REOPEN_MESSAGES,
  UNOPEN_SOURCE_MESSAGES,
  admissionNeedsValidation,
  admissionOnValidation,
  amendmentReviewState,
  authorsApproval,
  awaitsAssemblyDecision,
  isPendingLateSource,
  awaitsAuthors,
  awaitsPartyAnswer,
  awaitsPublication,
  awaitsValidation,
  isAmendmentPublishable,
  mainAuthorOf,
  numberingToKeep,
  pickMainAuthor,
  positionBlocker,
  publishOnValidation,
  positionEffect,
  positionRecordedBy,
  positionRecorder,
  reclassifyPositionPlan,
  REVIEW_INADMISSION_MESSAGE,
  reviewInadmissionCase,
  shouldAutoAcceptPosition,
  submissionLate,
  transactionalReopenBlocker,
  transactionalSourcesMessage,
  unopenSourceReason,
  unopenSourcesMessage,
  validationReopenBlocker,
} from "./reviewState";
import {
  closeTransactionalsOver,
  competingTransactionalIds,
  inadmissibleSourcePlan,
  loadSourceMap,
  reopenTransactionalsClosedBy,
  restoreLockIds,
  transactionalsOverIds,
  type RestoreRow,
} from "./transactionalClosure";
import {
  canSeeAmendment,
  canSeePositions,
  isDocumentPresenter,
  isDocumentProponent,
  redactAcceptances,
  redactAuthors,
  redactCorrectionNote,
  redactEventActor,
  redactPayloadMembers,
  seesAnswerRecord,
  type DocumentPresenters,
  type ExecutiveMask,
} from "./visibility";

/**
 * The amendment API (docs/api.md, "Amendments"). Handlers stay thin: they
 * load a context with `loadAmendmentDocumentContext` or `loadAmendmentContext`, parse
 * the body and call one function of this module.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type AssemblyRow = Awaited<ReturnType<typeof resolveAssembly>>;
type DocumentRow = Awaited<ReturnType<typeof resolveDocument>>;

/**
 * Amendment metadata as stored. `presentingMemberId` is the main author
 * (AmendmentDto.mainAuthorId): it drives memberSeq and the code, and answers
 * the transactionals proposed over the amendment.
 */
export interface StoredAmendmentMeta extends AmendmentMeta {
  presentingMemberId?: string;
}

/** Response of POST .../amendments/[amendment]/outcome. */
export type AmendmentOutcomeResult = AmendmentOutcomeDto;
/** Response of POST .../amendments/admission. */
export type AmendmentAdmissionResult = AmendmentAdmissionDto;

const SYMMETRIC_RELATIONS: RelationKind[] = ["incompatible", "duplicate"];

/** 409 on a transactional its main authors have not all accepted yet. */
const AWAITS_AUTHORS_MESSAGE =
  "Los autores principales de las enmiendas que sustituye todavía no han aceptado esta transaccional";

/**
 * 409 when deciding a transactional some of whose parents are late and still
 * waiting for the assembly's admission: the Mesa decides that first (user's
 * decision of 2026-11-19), since not admitting one may make it lapse.
 */
export const AWAITS_ADMISSION_MESSAGE =
  "Alguna de las enmiendas que agrupa esta transaccional está fuera de plazo y la asamblea todavía no ha decidido si la admite. Decide primero su admisión";

/** Whether any of a transactional's parents waits for its admission. */
export function sourcesAwaitAdmission(
  sources: Parameters<typeof isPendingLateSource>[0][],
): boolean {
  return sources.some(isPendingLateSource);
}

/** 409 when accepting a transactional that can no longer go through. */
const CLOSED_SOURCES_MESSAGE =
  "Alguna de las enmiendas que agrupa esta transaccional ya está decidida o la sustituye otra transaccional: ya no se puede aceptar";

/**
 * Whether every amendment a transactional groups is still open (presented,
 * admitted, undecided: unopenSourceReason), so it can still replace them.
 */
export function sourcesAreOpen(
  sources: Parameters<typeof unopenSourceReason>[0][],
): boolean {
  return sources.every((source) => unopenSourceReason(source) === null);
}

/** The main author picked for a draft or transactional, or a 422. */
function mainAuthorOrFail(
  choice: ReturnType<typeof pickMainAuthor>,
): string | null {
  if (choice === "not_author" || choice === "required") {
    fail(422, MAIN_AUTHOR_MESSAGES[choice]);
  }
  return choice;
}

function fail(statusCode: number, message: string, data?: unknown): never {
  throw createError({ statusCode, message, ...(data ? { data } : {}) });
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// Body parsing -------------------------------------------------------------

export async function readAmendmentBody<S extends z.ZodType>(
  event: H3Event,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await readBody(event);
  } catch {
    fail(400, "Cuerpo de la petición no válido");
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    fail(400, "Datos no válidos", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

// Pure helpers ---------------------------------------------------------------

/** Ids of the new blocks an amendment inserts. */
export function insertedBlockIds(ops: AmendmentOp[]): string[] {
  return ops.flatMap((op) =>
    op.op === "insert" ? op.blocks.map((block) => block.id) : [],
  );
}

/**
 * Gives a fresh id to every inserted block whose id is already used by the
 * base, by another amendment of the document (`takenIds`) or earlier in the
 * same operations. Operations only anchor to base blocks, so nothing else
 * refers to these ids.
 */
export function reIdInsertedBlocks(
  ops: AmendmentOp[],
  base: Block[],
  takenIds: Iterable<string>,
  newId: () => string = cuid,
): AmendmentOp[] {
  const taken = new Set<string>([
    ...base.map((block) => block.id),
    ...takenIds,
  ]);
  return ops.map((op) => {
    if (op.op !== "insert") return op;
    return {
      ...op,
      blocks: op.blocks.map((block) => {
        if (!taken.has(block.id)) {
          taken.add(block.id);
          return block;
        }
        let id = newId();
        while (taken.has(id)) id = newId();
        taken.add(id);
        return { ...block, id };
      }),
    };
  });
}

/**
 * Re-ids inserted blocks and validates the operations against the base.
 * An amendment needs at least one, which `validateOps` reports as "empty".
 */
export function prepareAmendmentOps(input: {
  ops: AmendmentOp[];
  base: Block[];
  takenIds: Iterable<string>;
  newId?: () => string;
}): { ops: AmendmentOp[]; errors: OpError[] } {
  const ops = reIdInsertedBlocks(
    input.ops,
    input.base,
    input.takenIds,
    input.newId,
  );
  return { ops, errors: validateOps(input.base, ops) };
}

/** Sort key by position in the base. */
export function amendmentSortKey(ops: AmendmentOp[], base: Block[]): number {
  return ops.length > 0 ? positionKey(ops, base) : base.length;
}

/**
 * The parties of a new transactional: one acceptance per distinct main
 * author of the amendments it would replace (role "author"). The document's
 * presenter is not a party unless it is one of them. The creator's own
 * member accepts at once.
 */
export function buildAcceptanceParties(
  sourceMainAuthorIds: (string | null)[],
  creatorMemberId: string | null,
): { memberId: string; role: "author"; accepted: boolean }[] {
  return unique(
    sourceMainAuthorIds.filter((id): id is string => id !== null),
  ).map((memberId) => ({
    memberId,
    role: "author",
    accepted: memberId === creatorMemberId,
  }));
}

/**
 * "T{n}" with n = the highest "T" number ever given in the document + 1, so
 * a number once taken (by a transactional withdrawn or deleted since) is
 * never given again. `takenCodes` are every code the document's amendments
 * hold or held (takenAmendmentCodes); a draft has none.
 */
export function nextTransactionalCode(
  takenCodes: Iterable<string | null>,
): string {
  const taken = new Set<string>();
  let max = 0;
  for (const code of takenCodes) {
    if (code === null) continue;
    taken.add(code);
    max = Math.max(max, amendmentCodeSeq(code, "T") ?? 0);
  }
  let n = max + 1;
  while (taken.has(formatAmendmentCode("T", n))) n += 1;
  return formatAmendmentCode("T", n);
}

/**
 * Which sources a transactional that replaces them now turns `transacted`,
 * or why it cannot: every source must still be open (presented, admitted or
 * late awaiting admission, undecided), or the message of
 * unopenSourcesMessage says what is missing. A late one still waiting for
 * the assembly is left out: it is replaced once admitted
 * (decideAmendmentAdmission), never before.
 * With `allowTransacted` (approving a transactional presented under the
 * earlier rule, which replaced its sources only on approval) one already
 * `transacted` is left as it is.
 */
export function sourcesToReplace(
  sources: (Parameters<typeof unopenSourceReason>[0] & { id: string })[],
  allowTransacted = false,
): { ids: string[] } | { message: string } {
  const skipped = (source: { status: AmendmentStatus }) =>
    allowTransacted && source.status === "transacted";
  const blocking = sources.filter(
    (source) => !skipped(source) && unopenSourceReason(source) !== null,
  );
  if (blocking.length > 0) {
    return { message: unopenSourcesMessage(blocking)! };
  }
  return {
    ids: sources
      .filter((source) => !skipped(source) && !isPendingLateSource(source))
      .map((source) => source.id),
  };
}

/**
 * Whether two of these transactionals group the same amendment: validating
 * both at once would make both replace it, so the Secretaría validates one
 * (the other is then closed).
 */
export function transactionalsShareSources(
  sourceMap: ReadonlyMap<string, readonly string[]>,
  ids: readonly string[],
): boolean {
  const seen = new Set<string>();
  for (const id of new Set(ids)) {
    for (const sourceId of new Set(sourceMap.get(id) ?? [])) {
      if (seen.has(sourceId)) return true;
      seen.add(sourceId);
    }
  }
  return false;
}

/**
 * Authors requested by a draft update. The actor's member is always kept
 * (AmendmentDraftBody): a co-author editing someone else's draft sends the
 * other authors only and must not drop out of it. Moderators presenting on
 * behalf of a member, and actors who are not authors, are left as sent.
 */
export function requestedDraftAuthorIds(input: {
  authorMemberIds: string[] | undefined;
  onBehalfOfMemberId: string | null | undefined;
  actorMemberId: string | null;
  presentingMemberId: string | undefined;
  currentAuthorIds: string[];
}): string[] | undefined {
  const { authorMemberIds, actorMemberId } = input;
  if (
    authorMemberIds === undefined ||
    input.onBehalfOfMemberId ||
    !actorMemberId ||
    actorMemberId === input.presentingMemberId ||
    !input.currentAuthorIds.includes(actorMemberId)
  ) {
    return authorMemberIds;
  }
  return unique([...authorMemberIds, actorMemberId]);
}

/**
 * Authors a non-moderator may not add to a transactional: anyone but the
 * actor's member, its current authors and the members involved (the authors
 * of the amendments it replaces and the document's main presenter), as when
 * it is created. An executive area always passes (`executiveIds`), whoever
 * asks: an account that does not see the areas names them by their real
 * ids, and refusing the ones that are not involved would tell it which area
 * presented what it groups.
 */
export function unauthorizedTransactionalAuthors(
  nextAuthorIds: string[],
  input: {
    actorMemberId: string | null;
    currentAuthorIds: string[];
    partyMemberIds: (string | null)[];
    executiveIds?: ReadonlySet<string>;
  },
): string[] {
  const allowed = new Set<string | null>([
    input.actorMemberId,
    ...input.currentAuthorIds,
    ...input.partyMemberIds,
  ]);
  return nextAuthorIds.filter(
    (id) => !allowed.has(id) && !input.executiveIds?.has(id),
  );
}

export interface CapabilityInput {
  status: AmendmentStatus;
  admission: AdmissionStatus;
  approvalMethod: ApprovalMethod | null;
  isAuthor: boolean;
  /**
   * The actor acts for one of the document's presenters (main or
   * co-presenter), any of whom answers its amendments.
   */
  isPresenter: boolean;
  moderate: boolean;
  review: boolean;
  actorMemberId: string | null;
  /** The parties of a transactional: rows with the role "author". */
  acceptances: { memberId: string; decision: AcceptanceDecision }[];
  validatedAt: Date | null;
  publishedAt: Date | null;
  /**
   * For a transactional, the answer of its main authors (authorsApproval):
   * the Secretaría validates it only once they all accepted it.
   */
  authorsApproval?: AcceptanceDecision | null;
  /** The document's rule for accepted amendments. */
  rule: AcceptedAmendmentRule;
  /** The main presenter reads it once validated (answersOnValidation). */
  presenterSeesValidated?: boolean;
  /**
   * For a transactional, whether everything it groups is still open
   * (sourcesAreOpen): once one of them is decided or replaced by another
   * transactional, nobody is asked to accept it any more.
   */
  sourcesOpen?: boolean;
  /**
   * The document's final vote is recorded (documentVoted): nothing about
   * its amendments changes any more, except publishing them.
   */
  voted?: boolean;
  /** For validationReopenBlocker; absent reads as not reopenable. */
  kind?: AmendmentKind;
  late?: boolean;
  /** The assembly is closed: nothing goes back to review. */
  assemblyClosed?: boolean;
  /** A transactional groups it: it never goes back to review. */
  grouped?: boolean;
}

/**
 * What the actor may do with an amendment. Once the document is voted only
 * publishing is left (docs/api.md, "After the final vote").
 */
export function amendmentCapabilities(
  input: CapabilityInput,
): AmendmentCapabilities {
  const open = !input.voted;
  const draft = open && input.status === "draft";
  const submitted = open && input.status === "submitted";
  return {
    validate: open && input.review && awaitsValidation(input),
    publish: input.review && isAmendmentPublishable(input),
    unvalidate:
      open &&
      input.review &&
      !input.assemblyClosed &&
      !input.grouped &&
      input.kind !== undefined &&
      validationReopenBlocker({
        status: input.status,
        validatedAt: input.validatedAt,
        kind: input.kind,
        late: input.late ?? false,
        admission: input.admission,
      }) === null,
    edit: input.isAuthor && draft,
    submit: input.isAuthor && draft,
    withdraw: input.isAuthor && submitted,
    accept: awaitsPartyAnswer({
      status: input.status,
      memberId: input.actorMemberId,
      parties: input.acceptances,
      sourcesOpen: input.sourcesOpen !== false,
      voted: Boolean(input.voted),
    }),
    position:
      (input.isPresenter || input.moderate) &&
      positionBlocker(input, input.rule, input.voted) === null,
    moderate: input.moderate,
    review: input.review,
  };
}

/**
 * Approved amendments this one now shares a passage with (amendmentsMeet:
 * the Mesa words it, or a deletion wins) and live "incompatible" links.
 */
export function computeApprovalWarnings(
  target: { id: string; ops: AmendmentOp[] },
  approved: { id: string; ops: AmendmentOp[] }[],
  incompatibleIds: string[],
): ApprovalWarnings {
  return {
    overlapsWithApproved: approved
      .filter((other) => other.id !== target.id)
      .filter((other) => amendmentsMeet(target.ops, other.ops))
      .map((other) => other.id),
    incompatible: unique(incompatibleIds.filter((id) => id !== target.id)),
  };
}

function voteCounts(vote: VoteInput): Required<Omit<VoteCounts, "present">> & {
  present: number | null;
} {
  return {
    inFavor: vote.inFavor ?? 0,
    against: vote.against ?? 0,
    abstentions: vote.abstentions ?? 0,
    blank: vote.blank ?? 0,
    invalid: vote.invalid ?? 0,
    notCast: vote.notCast ?? 0,
    present: vote.present ?? null,
  };
}

/**
 * Computes a vote with `computeVoteOutcome`, under the vote's majority or
 * else `defaultMajority`. A tie under tieRule "repeat" answers 409 with
 * `{ tie: true }` before anything is stored, and counts that exceed the
 * members present are refused.
 */
export function evaluateVoteInput(
  vote: VoteInput,
  settings: Pick<AssemblySettings, "denominator" | "tieRule">,
  defaultMajority: Majority = "simple",
): {
  majority: Majority;
  outcome: VoteOutcome & { result: "approved" | "rejected" };
} {
  const majority = vote.majority ?? defaultMajority;
  // Assent carries no counts: nobody objected, so it passes (as in the
  // document final vote, evaluateFinalVote).
  if (vote.method === "assent") {
    return {
      majority,
      outcome: {
        result: "approved",
        threshold: 0,
        denominator: 0,
        inconsistent: false,
      },
    };
  }
  const outcome = computeVoteOutcome(voteCounts(vote), majority, settings);
  if (outcome.result === "tie") {
    fail(409, "Empate: hay que repetir la votación", { tie: true });
  }
  if (outcome.inconsistent) {
    fail(422, "Los votos emitidos superan a los miembros presentes", {
      reasons: [{ index: -1, reason: "inconsistent_counts" }],
    });
  }
  return {
    majority,
    outcome: outcome as VoteOutcome & { result: "approved" | "rejected" },
  };
}

/** Hides payloads that would reveal proponent positions to those who cannot see them. */
export function redactAmendmentEventPayload(
  type: string,
  payload: Record<string, unknown>,
  positionsVisible: boolean,
): Record<string, unknown> {
  return type === "position_changed" && !positionsVisible ? {} : payload;
}

// Mappers ------------------------------------------------------------------

const MEMBER_REF_COLUMNS = {
  id: true,
  acronym: true,
  name: true,
  kind: true,
} as const;

function toMemberRef(member: MemberRef): MemberRef {
  return {
    id: member.id,
    acronym: member.acronym,
    name: member.name,
    kind: member.kind,
  };
}

function toRelationDto(
  row: typeof amendmentRelations.$inferSelect,
): RelationDto {
  return {
    id: row.id,
    fromId: row.fromId,
    toId: row.toId,
    kind: row.kind,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

function readMeta(row: { meta: AmendmentMeta | null }): StoredAmendmentMeta {
  return (row.meta ?? {}) as StoredAmendmentMeta;
}

/** The main author first, then the rest by acronym. */
function orderAuthors(
  authors: MemberRef[],
  presentingMemberId?: string,
): MemberRef[] {
  return [...authors].sort((a, b) => {
    if (a.id === presentingMemberId) return -1;
    if (b.id === presentingMemberId) return 1;
    return a.acronym.localeCompare(b.acronym);
  });
}

// Loading ------------------------------------------------------------------

function findAmendments(executor: Executor, where: SQL | undefined) {
  return executor.query.amendments.findMany({
    where,
    with: {
      authors: { with: { member: { columns: MEMBER_REF_COLUMNS } } },
      // The authors of what a transactional replaces are its insiders.
      sources: {
        columns: { sourceId: true },
        with: {
          source: {
            columns: { id: true },
            with: { authors: { columns: { memberId: true } } },
          },
        },
      },
      derived: { columns: { transactionalId: true } },
      acceptances: { with: { member: { columns: MEMBER_REF_COLUMNS } } },
      position: true,
    },
    orderBy: [
      asc(amendments.positionKey),
      asc(amendments.number),
      asc(amendments.createdAt),
    ],
  });
}

export type LoadedAmendment = Awaited<
  ReturnType<typeof findAmendments>
>[number];

/**
 * The original amendments behind these sources (user's decisions of
 * 2026-11-20): a source that is itself a transactional counts by what it
 * combines, down to the originals. Its parties are their main authors
 * (originalMainAuthors), and who may propose one is among their authors.
 */
async function originalAmendments(
  documentId: string,
  sources: LoadedAmendment[],
): Promise<LoadedAmendment[]> {
  const result: LoadedAmendment[] = [];
  const seen = new Set<string>();
  let frontier = sources;
  while (frontier.length > 0) {
    const deeper: string[] = [];
    for (const source of frontier) {
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      if (source.kind === "transactional" && source.sources.length > 0) {
        deeper.push(...source.sources.map((link) => link.sourceId));
      } else {
        result.push(source);
      }
    }
    const next = unique(deeper).filter((id) => !seen.has(id));
    frontier =
      next.length > 0
        ? await findAmendments(
            db,
            and(
              eq(amendments.documentId, documentId),
              inArray(amendments.id, next),
            ),
          )
        : [];
  }
  return result;
}

/**
 * The main authors who accept a transactional over these sources: those of
 * the original amendments, never who proposed a transactional it combines
 * (T13 over T12 over UEX1 asks UEX1's main author, not T12's).
 */
async function originalMainAuthors(
  documentId: string,
  sources: LoadedAmendment[],
): Promise<(string | null)[]> {
  return (await originalAmendments(documentId, sources)).map(loadedMainAuthor);
}

/**
 * The parties of a transactional: the main authors of the amendments it
 * would replace (rows with the role "author"; rows with the role
 * "proponent" come from the earlier rule and are ignored).
 */
function partiesOf(row: Pick<LoadedAmendment, "acceptances">) {
  return row.acceptances.filter((acceptance) => acceptance.role === "author");
}

/**
 * Members involved in a transactional besides its authors: its parties and
 * every author of the amendments it would replace. They see it while it is
 * private and read its correction notes.
 */
function involvedMemberIds(
  row: Pick<LoadedAmendment, "acceptances" | "sources">,
): string[] {
  return unique([
    ...row.acceptances.map((acceptance) => acceptance.memberId),
    ...row.sources.flatMap((source) =>
      source.source.authors.map((author) => author.memberId),
    ),
  ]);
}

/** The main author of a loaded amendment (AmendmentDto.mainAuthorId). */
export function loadedMainAuthor(row: LoadedAmendment): string | null {
  return mainAuthorOf(
    row.authors.map((author) => author.memberId),
    readMeta(row).presentingMemberId,
  );
}

async function loadAmendment(executor: Executor, id: string) {
  const [row] = await findAmendments(executor, eq(amendments.id, id));
  return row;
}

export interface DocumentAmendmentContext {
  actor: Actor;
  assembly: AssemblyRow;
  document: DocumentRow;
  settings: AssemblySettings;
  /** Effective amendment window; `late` is computed with `isLateSubmission`. */
  window: AmendmentWindow;
  /** The actor acts for the main presenter. */
  isProponent: boolean;
  /**
   * The actor acts for the main presenter or a co-presenter: either
   * answers the amendments (setAmendmentPosition).
   */
  isPresenter: boolean;
  positionsVisible: boolean;
  /** What an amendment the main presenter accepts becomes. */
  rule: AcceptedAmendmentRule;
  /**
   * The main presenter reads the amendments once validated, so it may
   * answer them before they are published (answersOnValidation).
   */
  presenterSeesValidated: boolean;
  now: Date;
}

export interface AmendmentContext extends DocumentAmendmentContext {
  amendment: LoadedAmendment;
  isAuthor: boolean;
}

/** The amendment context of a document the caller already resolved. */
export function buildDocumentAmendmentContext(
  actor: Actor,
  assembly: AssemblyRow,
  document: DocumentRow,
  milestones: Milestones,
  presenterSeesValidated: boolean,
  now = new Date(),
): DocumentAmendmentContext {
  const settings = assemblySettings(assembly);
  const isPresenter = isDocumentPresenter(actor, document);
  return {
    actor,
    assembly,
    document,
    settings,
    window: amendmentWindow(document, milestones),
    isProponent: isDocumentProponent(actor, document),
    isPresenter,
    positionsVisible: canSeePositions(actor, { document, isPresenter }),
    rule: document.acceptedAmendments,
    presenterSeesValidated,
    now,
  };
}

export async function loadAmendmentDocumentContext(
  event: H3Event,
): Promise<DocumentAmendmentContext> {
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
  return buildDocumentAmendmentContext(
    actor,
    assembly,
    document,
    await loadMilestones(assembly.id),
    await loadAnswersOnValidation(document),
  );
}

function isAmendmentAuthor(actor: Actor, row: LoadedAmendment): boolean {
  return (
    row.createdByUserId === actor.user.id ||
    actsFor(
      actor,
      row.authors.map((author) => author.memberId),
    )
  );
}

/**
 * Correction notes are for the authors, the creator, the members involved in
 * a transactional, the Secretaría and the Mesa (AmendmentDto.correctionNote).
 */
function canReadCorrection(actor: Actor, row: LoadedAmendment): boolean {
  return (
    canReviewAmendments(actor) ||
    canModerate(actor) ||
    isAmendmentAuthor(actor, row) ||
    actsFor(actor, involvedMemberIds(row))
  );
}

function isVisible(
  ctx: DocumentAmendmentContext,
  row: LoadedAmendment,
): boolean {
  return canSeeLoadedAmendment(ctx.actor, row, ctx.document);
}

/** Loads the `[amendment]` route param. Hidden amendments answer 404. */
export async function loadAmendmentContext(
  event: H3Event,
): Promise<AmendmentContext> {
  const ctx = await loadAmendmentDocumentContext(event);
  const found = await resolveAmendment(
    ctx.document.id,
    getRouterParam(event, "amendment"),
  );
  const amendment = await loadAmendment(db, found.id);
  if (!amendment || !isVisible(ctx, amendment))
    fail(404, "Enmienda no encontrada");
  return {
    ...ctx,
    amendment,
    isAuthor: isAmendmentAuthor(ctx.actor, amendment),
  };
}

async function loadBaseBlocks(document: DocumentRow): Promise<Block[]> {
  if (!document.baseVersionId) fail(409, "El documento no tiene texto base");
  const version = await db.query.documentVersions.findFirst({
    where: eq(documentVersions.id, document.baseVersionId),
    columns: { blocks: true },
  });
  if (!version) fail(409, "El documento no tiene texto base");
  return version.blocks;
}

/**
 * Re-reads the document under a row lock and refuses once its final vote is
 * recorded, so the "already voted" guard holds against a concurrent final
 * vote (recordFinalVote locks the row with no key update).
 * - `no key update` also serializes numbering and block re-ids per document,
 *   and requires the document to be still published.
 * - `share` only holds a concurrent final vote off until this transaction
 *   commits; several amendment changes may hold it at once.
 * Neither blocks the foreign key checks of rows that reference the document.
 * A transaction takes it once, in one mode, after the assembly share lock
 * when it moves the projection and before any amendment row lock ("Row
 * locks" in documents.ts).
 * Returns the agenda item of the locked row: a vote that moves the
 * projection uses it, not the one read before the transaction, since the
 * document may have moved in between.
 */
async function lockDocument(
  tx: Tx,
  documentId: string,
  mode: "no key update" | "share" = "no key update",
): Promise<{ agendaItemId: string | null; rule: AcceptedAmendmentRule }> {
  const row = await lockDocumentRow(tx, documentId, mode);
  assertNotVoted(row);
  if (mode === "no key update" && row.status !== "published") {
    fail(409, "El documento no admite enmiendas");
  }
  return { agendaItemId: row.agendaItemId, rule: row.acceptedAmendments };
}

/**
 * The document row under a row lock (lockDocument), without refusing a
 * voted one: publishing still runs after the final vote, and only needs to
 * know whether the answers are closed (`voted`) and the document's rule.
 */
async function lockDocumentRow(
  tx: Tx,
  documentId: string,
  mode: "no key update" | "share",
) {
  const [row] = await tx
    .select({
      status: documents.status,
      finalVoteId: documents.finalVoteId,
      consolidatedVersionId: documents.consolidatedVersionId,
      agendaItemId: documents.agendaItemId,
      acceptedAmendments: documents.acceptedAmendments,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for(mode);
  if (!row) fail(404, "Documento no encontrado");
  return row;
}

/**
 * Locks amendment rows of the document in id order. Taking every row a
 * transaction needs in one ordered pass keeps two transactions (say, the
 * approvals of T1 and of a transactional over T1) from waiting on each other.
 * No key update leaves the foreign key checks of relations, sources and
 * positions free, since the locked rows only change status and outcome
 * fields, never their key.
 */
function lockAmendments(tx: Tx, documentId: string, ids: string[]) {
  return selectAmendmentRows(tx, documentId, ids).for("no key update");
}

/** What lockAmendments reads of each row. */
const LOCKED_AMENDMENT_COLUMNS = {
  id: amendments.id,
  kind: amendments.kind,
  code: amendments.code,
  status: amendments.status,
  admission: amendments.admission,
  late: amendments.late,
  validatedAt: amendments.validatedAt,
  publishedAt: amendments.publishedAt,
  decidedAt: amendments.decidedAt,
  approvalMethod: amendments.approvalMethod,
  outcomeVoteId: amendments.outcomeVoteId,
};

function selectAmendmentRows(tx: Tx, documentId: string, ids: string[]) {
  return tx
    .select(LOCKED_AMENDMENT_COLUMNS)
    .from(amendments)
    .where(
      and(eq(amendments.documentId, documentId), inArray(amendments.id, ids)),
    )
    .orderBy(asc(amendments.id))
    .$dynamic();
}

/**
 * The rows of amendments this transaction already locked (lockAmendments),
 * read again after it changed them: the locked snapshot still shows them
 * as they were before.
 */
function rereadLocked(tx: Tx, documentId: string, ids: string[]) {
  if (ids.length === 0) return Promise.resolve([] as LockedAmendment[]);
  return selectAmendmentRows(tx, documentId, ids);
}

type LockedAmendment = Awaited<ReturnType<typeof lockAmendments>>[number];

/**
 * Locks the direct sources of a transactional (plus `alsoLock`, in the same
 * ordered pass) and fails 409 unless every one is still open (submitted,
 * admitted, undecided). The message says what is missing: the Secretaría's
 * validation, the Mesa's admission, or nothing to do because one is decided
 * (unopenSourcesMessage). With `publishedSources` (presenting a
 * transactional), they must also be published (transactionalSourcesMessage).
 * Returns the locked rows by id.
 */
async function lockOpenSources(
  tx: Tx,
  documentId: string,
  sourceIds: string[],
  alsoLock: string[] = [],
  publishedSources = false,
): Promise<Map<string, LockedAmendment>> {
  const ids = unique([...sourceIds, ...alsoLock]);
  if (ids.length === 0) return new Map();
  const rows = await lockAmendments(tx, documentId, ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const sources = sourceIds.map((id) => byId.get(id));
  if (sources.some((row) => row === undefined)) {
    fail(409, UNOPEN_SOURCE_MESSAGES.decided);
  }
  const present = sources.filter((row) => row !== undefined);
  const message =
    (publishedSources ? transactionalSourcesMessage(present) : null) ??
    unopenSourcesMessage(present);
  if (message) fail(409, message);
  return byId;
}

/**
 * The acceptance rows of these transactionals, locked after their amendment
 * rows ("Row locks"): `share` to read them, `no key update` to answer.
 */
function lockParties(
  tx: Tx,
  amendmentIds: string[],
  mode: "share" | "no key update",
) {
  return tx
    .select({
      id: amendmentAcceptances.id,
      amendmentId: amendmentAcceptances.amendmentId,
      memberId: amendmentAcceptances.memberId,
      role: amendmentAcceptances.role,
      decision: amendmentAcceptances.decision,
    })
    .from(amendmentAcceptances)
    .where(inArray(amendmentAcceptances.amendmentId, amendmentIds))
    .orderBy(asc(amendmentAcceptances.id))
    .for(mode);
}

/** The other transactionals over some amendments, and every source edge. */
interface Competitors {
  sourceMap: Map<string, string[]>;
  ids: string[];
}

/**
 * The other transactionals of the document over the amendments a
 * transactional groups (competingTransactionalIds), to lock in the same
 * ordered pass as the transactional and its sources and hand to
 * replaceSources. Read after the document lock: presenting a transactional
 * takes the document NO KEY UPDATE, which waits for the SHARE of the paths
 * that replace sources, so none appears before they are locked.
 */
async function findCompetitors(
  tx: Tx,
  documentId: string,
  transactionalId: string | null,
  sourceIds: string[],
): Promise<Competitors> {
  if (sourceIds.length === 0) return { sourceMap: new Map(), ids: [] };
  const sourceMap = await loadSourceMap(tx, documentId);
  return {
    sourceMap,
    ids: competingTransactionalIds(sourceMap, transactionalId, sourceIds),
  };
}

/** The locked rows of the competitors, for replaceSources. */
function lockedCompetitors(
  competitors: Competitors,
  locked: Iterable<LockedAmendment>,
): { sourceMap: Map<string, string[]>; rows: LockedAmendment[] } {
  const ids = new Set(competitors.ids);
  return {
    sourceMap: competitors.sourceMap,
    rows: [...locked].filter((row) => ids.has(row.id)),
  };
}

/**
 * Closes the pending transactionals over amendments this path just settled
 * (closeTransactionalsOver): `dependents` are the transactionals over them
 * (findCompetitors), locked in the same ordered pass as those amendments.
 */
function closeDependents(
  tx: Tx,
  ctx: DocumentAmendmentContext,
  dependents: Competitors,
  locked: Iterable<LockedAmendment>,
  closed: { id: string; code: string | null; status: AmendmentStatus }[],
): Promise<string[]> {
  const { sourceMap, rows } = lockedCompetitors(dependents, locked);
  return closeTransactionalsOver(tx, {
    assemblyId: ctx.assembly.id,
    documentId: ctx.document.id,
    actor: ctx.actor,
    now: ctx.now,
    sourceMap,
    closed,
    candidates: rows,
  });
}

/**
 * Brings back the transactionals closed over `reopened`
 * (reopenTransactionalsClosedBy), once this path put them back to
 * undecided: `reopened` are their rows as locked before, `reopenedAs` what
 * else the reopening changed (readmission also admits them). `locked`
 * holds them and restoreLockIds, locked in the same ordered pass, and
 * `parties` the acceptances of the transactionals over them
 * (transactionalsOverIds), locked after.
 */
function restoreDependents(
  tx: Tx,
  ctx: DocumentAmendmentContext,
  sourceMap: ReadonlyMap<string, readonly string[]>,
  locked: Iterable<LockedAmendment>,
  parties: Awaited<ReturnType<typeof lockParties>>,
  reopened: LockedAmendment[],
  reopenedAs: Partial<RestoreRow> = {},
): Promise<string[]> {
  return reopenTransactionalsClosedBy(tx, {
    assemblyId: ctx.assembly.id,
    documentId: ctx.document.id,
    actor: ctx.actor,
    sourceMap,
    reopened: reopened.map((row) => ({ id: row.id, code: row.code })),
    locked,
    reopenedAs,
    parties,
  });
}

/**
 * Declared inadmissible, amendments leave the open transactionals over them
 * (inadmissibleSourcePlan; user's decision of 2026-11-19): one with another
 * parent left goes on without them, and their main authors stop being its
 * parties unless they are through another parent; one with nothing else
 * left lapses. `dependents` are the transactionals over them
 * (findCompetitors), locked in the same ordered pass as those amendments.
 */
async function settleTransactionalsOverInadmissible(
  tx: Tx,
  ctx: DocumentAmendmentContext,
  dependents: Competitors,
  locked: Iterable<LockedAmendment>,
  inadmissible: { id: string; code: string | null }[],
): Promise<void> {
  const { sourceMap, rows } = lockedCompetitors(dependents, locked);
  const plan = inadmissibleSourcePlan(
    sourceMap,
    inadmissible.map((row) => row.id),
    rows,
  );
  const codeOf = new Map(inadmissible.map((row) => [row.id, row.code]));

  if (plan.lapse.length > 0) {
    const lapsed = await tx
      .update(amendments)
      .set({ status: "lapsed", decidedAt: ctx.now, outcomeNote: null })
      .where(
        and(
          inArray(
            amendments.id,
            plan.lapse.map((entry) => entry.id),
          ),
          eq(amendments.status, "submitted"),
        ),
      )
      .returning({ id: amendments.id });
    const done = new Set(lapsed.map((row) => row.id));
    for (const entry of plan.lapse) {
      if (!done.has(entry.id)) continue;
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: ctx.document.id,
        entityType: "amendment",
        entityId: entry.id,
        type: "amendment_lapsed",
        payload: {
          reason: "sources_inadmissible",
          sourceIds: entry.sourceIds,
          sourceCodes: entry.sourceIds.map((id) => codeOf.get(id) ?? null),
        },
        actor: ctx.actor,
      });
    }
  }

  if (plan.drop.length === 0) return;
  const remaining = unique(plan.drop.flatMap((entry) => entry.remainingIds));
  const mainAuthors = new Map(
    (await findAmendments(tx, inArray(amendments.id, remaining))).map((row) => [
      row.id,
      loadedMainAuthor(row),
    ]),
  );
  for (const entry of plan.drop) {
    await tx
      .delete(amendmentSources)
      .where(
        and(
          eq(amendmentSources.transactionalId, entry.id),
          inArray(amendmentSources.sourceId, entry.sourceIds),
        ),
      );
    // Its parties are the main authors of the parents left.
    const keep = new Set(
      entry.remainingIds
        .map((id) => mainAuthors.get(id))
        .filter((id): id is string => !!id),
    );
    const parties = await tx
      .select({
        id: amendmentAcceptances.id,
        memberId: amendmentAcceptances.memberId,
      })
      .from(amendmentAcceptances)
      .where(eq(amendmentAcceptances.amendmentId, entry.id));
    const leaving = parties
      .filter((party) => !keep.has(party.memberId))
      .map((party) => party.id);
    if (leaving.length > 0) {
      await tx
        .delete(amendmentAcceptances)
        .where(inArray(amendmentAcceptances.id, leaving));
    }
    for (const sourceId of entry.sourceIds) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: ctx.document.id,
        entityType: "amendment",
        entityId: entry.id,
        type: "transactional_source_dropped",
        payload: {
          sourceId,
          sourceCode: codeOf.get(sourceId) ?? null,
          reason: "inadmissible",
        },
        actor: ctx.actor,
      });
    }
  }
}

/**
 * Admitted, late amendments that are parents of a transactional already in
 * force (validated, or the Mesa's, and accepted by every main author) are
 * replaced by it now (replaceSources), as its other parents were: until the
 * assembly's decision they stayed linked and undecided
 * (isPendingLateSource). `sourceMap`, `locked` and `parties` are those of
 * the transactionals over them (transactionalsOverIds), locked with them.
 */
async function replaceAdmittedInForce(
  tx: Tx,
  ctx: DocumentAmendmentContext,
  sourceMap: ReadonlyMap<string, readonly string[]>,
  locked: LockedAmendment[],
  parties: Awaited<ReturnType<typeof lockParties>>,
  admitted: LockedAmendment[],
): Promise<void> {
  if (admitted.length === 0) return;
  const overIds = transactionalsOverIds(
    sourceMap,
    admitted.map((row) => row.id),
  );
  const replaced = new Set<string>();
  for (const transactional of locked) {
    if (
      !overIds.includes(transactional.id) ||
      transactional.kind !== "transactional" ||
      transactional.status !== "submitted" ||
      transactional.validatedAt === null ||
      authorsApproval({
        kind: "transactional",
        acceptances: parties.filter(
          (party) => party.amendmentId === transactional.id,
        ),
      }) !== "accepted"
    ) {
      continue;
    }
    const sources = admitted
      .filter(
        (row) =>
          !replaced.has(row.id) &&
          (sourceMap.get(transactional.id) ?? []).includes(row.id),
      )
      .map((row) => ({
        ...row,
        admission: "admitted" as const,
        validatedAt: row.validatedAt ?? ctx.now,
      }));
    if (sources.length === 0) continue;
    await replaceSources(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      actor: ctx.actor,
      now: ctx.now,
      transactional: { id: transactional.id, code: transactional.code },
      sources,
      competitors: lockedCompetitors(
        {
          sourceMap: new Map(
            [...sourceMap].map(([id, list]) => [id, [...list]]),
          ),
          ids: overIds.filter((id) => id !== transactional.id),
        },
        locked,
      ),
    });
    for (const row of sources) replaced.add(row.id);
  }
}

/**
 * A transactional replaces the amendments it groups (docs/design.md,
 * "Transactionals"): once the Secretaría validated it (or the Mesa presented
 * it) and every main author accepted it, whichever comes last, its sources
 * become `transacted` (amendment_transacted) and it follows the normal flow.
 * The other transactionals still open over any of those amendments can no
 * longer go through: they lapse (amendment_lapsed, reason
 * "sources_transacted"), so their authors and parties see it in their news
 * and nobody is asked to answer them any more.
 * The caller holds the locks of the transactional, of `sources` and of the
 * competitors (findCompetitors, lockAmendments). A source that is no longer
 * open fails 409 (sourcesToReplace); with `allowTransacted` (approving a
 * transactional presented under the earlier rule, which replaced its
 * sources only on approval) one already `transacted` is left as it is.
 */
async function replaceSources(
  tx: Tx,
  input: {
    assemblyId: string;
    documentId: string;
    actor: Actor;
    now: Date;
    transactional: { id: string; code: string | null };
    sources: LockedAmendment[];
    competitors: { sourceMap: Map<string, string[]>; rows: LockedAmendment[] };
    allowTransacted?: boolean;
  },
): Promise<void> {
  const plan = sourcesToReplace(input.sources, input.allowTransacted);
  if ("message" in plan) fail(409, plan.message);
  if (plan.ids.length === 0) return;
  const transacted = await tx
    .update(amendments)
    .set({ status: "transacted", decidedAt: input.now })
    .where(
      and(inArray(amendments.id, plan.ids), eq(amendments.status, "submitted")),
    )
    .returning({ id: amendments.id });
  if (transacted.length !== plan.ids.length) {
    fail(409, "Las enmiendas han cambiado. Recarga la página");
  }
  for (const row of transacted) {
    await recordEvent(tx, {
      assemblyId: input.assemblyId,
      documentId: input.documentId,
      entityType: "amendment",
      entityId: row.id,
      type: "amendment_transacted",
      payload: {
        transactionalId: input.transactional.id,
        code: input.transactional.code,
      },
      actor: input.actor,
    });
  }

  const replaced = new Set(plan.ids);
  const closing = input.competitors.rows
    .filter(
      (row) =>
        row.id !== input.transactional.id &&
        row.status === "submitted" &&
        (input.competitors.sourceMap.get(row.id) ?? []).some((id) =>
          replaced.has(id),
        ),
    )
    .map((row) => row.id);
  if (closing.length === 0) return;
  const lapsed = await tx
    .update(amendments)
    .set({ status: "lapsed", decidedAt: input.now, outcomeNote: null })
    .where(
      and(inArray(amendments.id, closing), eq(amendments.status, "submitted")),
    )
    .returning({ id: amendments.id });
  for (const row of lapsed) {
    await recordEvent(tx, {
      assemblyId: input.assemblyId,
      documentId: input.documentId,
      entityType: "amendment",
      entityId: row.id,
      type: "amendment_lapsed",
      payload: {
        reason: "sources_transacted",
        transactionalId: input.transactional.id,
        code: input.transactional.code,
      },
      actor: input.actor,
    });
  }
}

async function otherInsertedIds(
  tx: Tx,
  documentId: string,
  excludeId?: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({ ops: amendments.ops })
    .from(amendments)
    .where(
      and(
        eq(amendments.documentId, documentId),
        excludeId ? ne(amendments.id, excludeId) : undefined,
      ),
    );
  return new Set(rows.flatMap((row) => insertedBlockIds(row.ops)));
}

// Guards ---------------------------------------------------------------------

/** The document's final vote is recorded, or its consolidated text exists. */
export function documentVoted(document: {
  finalVoteId: string | null;
  consolidatedVersionId: string | null;
}): boolean {
  return Boolean(document.finalVoteId || document.consolidatedVersionId);
}

/** The final vote fixes the text: nothing about its amendments changes afterwards. */
function assertNotVoted(document: {
  finalVoteId: string | null;
  consolidatedVersionId: string | null;
}): void {
  if (documentVoted(document)) {
    fail(409, "El documento ya se ha votado");
  }
}

/** Early check on the loaded document; lockDocument re-checks it in the transaction. */
function assertNotFinal(ctx: DocumentAmendmentContext): void {
  assertNotVoted(ctx.document);
}

/** Presenting or editing amendments needs a published, structured, amendable text. */
function assertAmendable(ctx: DocumentAmendmentContext): void {
  const { document } = ctx;
  if (
    document.status !== "published" ||
    document.format !== "structured" ||
    !document.amendable ||
    !document.baseVersionId
  ) {
    fail(409, "El documento no admite enmiendas");
  }
  if (ctx.assembly.status === "closed") fail(409, "La asamblea está cerrada");
  assertNotFinal(ctx);
}

function assertValidOps(errors: OpError[]): void {
  if (errors.length > 0)
    fail(422, "La enmienda no es válida", { reasons: errors });
}

async function assertMembers(
  ids: string[],
  activeOnly: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: members.id, active: members.active })
    .from(members)
    .where(inArray(members.id, ids));
  if (
    rows.length !== ids.length ||
    (activeOnly && rows.some((row) => !row.active))
  ) {
    fail(422, "Algún miembro indicado no existe o no está activo");
  }
}

/**
 * Presenting member and authors of a draft. Moderators may present on behalf
 * of a member, which replaces their own member.
 */
async function resolveDraftAuthors(
  actor: Actor,
  input: {
    onBehalfOfMemberId?: string | null;
    authorMemberIds?: string[];
    currentPresentingId?: string | null;
  },
): Promise<{ presentingMemberId: string; memberIds: string[] }> {
  const moderate = canModerate(actor);
  if (input.onBehalfOfMemberId && !moderate) {
    fail(403, "Solo la Mesa puede presentar enmiendas en nombre de un miembro");
  }
  const extra = input.authorMemberIds ?? [];
  const presentingMemberId =
    input.onBehalfOfMemberId ??
    input.currentPresentingId ??
    actor.memberId ??
    (moderate ? extra[0] : undefined);
  if (!presentingMemberId) {
    if (!moderate) fail(403, UNLINKED_ACCOUNT_MESSAGE);
    fail(422, "Indica el miembro que presenta la enmienda");
  }
  const memberIds = unique([presentingMemberId, ...extra]);
  await assertMembers(memberIds, true);
  return { presentingMemberId, memberIds };
}

// DTOs -----------------------------------------------------------------------

export async function buildAmendmentDtos(
  ctx: DocumentAmendmentContext,
  rows: LoadedAmendment[],
  visibleIds?: Set<string>,
): Promise<AmendmentDto[]> {
  const voteIds = unique(
    rows
      .map((row) => row.outcomeVoteId)
      .filter((id): id is string => Boolean(id)),
  );
  const voteRows =
    voteIds.length > 0
      ? await db.select().from(votes).where(inArray(votes.id, voteIds))
      : [];
  const voteById = new Map(voteRows.map((row) => [row.id, toVoteDto(row)]));
  const sourceStates = await loadSourceStates(rows);
  const recorders = await loadPositionRecorders(
    ctx.positionsVisible ? rows : [],
    ctx.actor,
  );
  const acceptanceRecorders = await loadAcceptanceRecorders(rows);
  const moderate = canModerate(ctx.actor);
  const review = canReviewAmendments(ctx.actor);
  const voted = documentVoted(ctx.document);
  const keep = (id: string) => !visibleIds || visibleIds.has(id);
  const openRevisions = await loadOpenRevisions(ctx, rows, keep);

  return rows.map((row) => {
    const meta = readMeta(row);
    const approval = authorsApproval(row);
    const parties = partiesOf(row);
    // An executive area reads as "CEA" to whoever may not see the areas:
    // the authors, the main author's id and the parties of a transactional.
    const { authors, mainAuthorId } = redactAuthors(
      ctx.actor,
      row.authors.map((author) => toMemberRef(author.member)),
      loadedMainAuthor(row),
    );
    return {
      id: row.id,
      documentId: row.documentId,
      number: row.number,
      code: row.code,
      kind: row.kind,
      status: row.status,
      admission: row.admission,
      late: row.late,
      ops: row.ops,
      globalReplace: meta.globalReplace ?? null,
      justification: row.justification,
      positionKey: row.positionKey,
      changeKinds: changeKinds(row.ops),
      authors: orderAuthors(authors, mainAuthorId ?? undefined),
      mainAuthorId,
      submittedAt: iso(row.submittedAt),
      validatedAt: iso(row.validatedAt),
      publishedAt: iso(row.publishedAt),
      reviewState: amendmentReviewState({
        ...row,
        authorsApproval: approval,
      }),
      correctionNote: canReadCorrection(ctx.actor, row)
        ? row.correctionNote
        : null,
      decidedAt: iso(row.decidedAt),
      approvalMethod: row.approvalMethod,
      outcomeNote: row.outcomeNote,
      outcomeVote: row.outcomeVoteId
        ? (voteById.get(row.outcomeVoteId) ?? null)
        : null,
      position:
        ctx.positionsVisible && row.position
          ? toPositionDto(
              row.position,
              row.id,
              ctx.document.proponentMemberId,
              recorders,
              seesAnswerRecord(ctx.actor, {
                insider: isAmendmentAuthor(ctx.actor, row),
                isPresenter: ctx.isPresenter,
              }),
            )
          : null,
      sourceIds: row.sources.map((source) => source.sourceId).filter(keep),
      transactionalIds: row.derived
        .map((derived) => derived.transactionalId)
        .filter(keep),
      acceptances: redactAcceptances(
        ctx.actor,
        parties.map((acceptance) => ({
          member: toMemberRef(acceptance.member),
          role: acceptance.role,
          decision: acceptance.decision,
          decidedAt: iso(acceptance.decidedAt),
          recordedBy: acceptanceRecordedBy(
            acceptanceRecorders.get(acceptanceKey(row.id, acceptance.memberId)),
          ),
        })),
      ),
      openRevision: openRevisions.get(row.id) ?? null,
      updatedAt: row.updatedAt.toISOString(),
      can: amendmentCapabilities({
        status: row.status,
        admission: row.admission,
        approvalMethod: row.approvalMethod,
        isAuthor: isAmendmentAuthor(ctx.actor, row),
        isPresenter: ctx.isPresenter,
        moderate,
        review,
        actorMemberId: ctx.actor.memberId,
        acceptances: parties,
        validatedAt: row.validatedAt,
        publishedAt: row.publishedAt,
        authorsApproval: approval,
        rule: ctx.rule,
        presenterSeesValidated: ctx.presenterSeesValidated,
        sourcesOpen: transactionalSourcesOpen(row, sourceStates),
        voted,
        kind: row.kind,
        late: row.late,
        assemblyClosed: ctx.assembly.status === "closed",
        grouped: row.derived.length > 0,
      }),
    };
  });
}

/**
 * What PositionDto.recordedBy (positionRecordedBy) needs:
 * - `recordedAs`, by amendment id: `by` of the amendment's latest
 *   position_changed event, which says whether the Mesa recorded the
 *   answer, as it was then (every answer is recorded with one);
 * - `memberOf`, by user id: the member the user who recorded an answer acts
 *   for (null when none), compared with the document's current main
 *   presenter for answers with no such event;
 * - `roleOf`, by user id: the role of that user now, which tells the Mesa
 *   from the Secretaría and the Presidencia (positionRecorder).
 */
export interface PositionRecorders {
  recordedAs: Map<string, string | null>;
  memberOf: Map<string, string | null>;
  roleOf?: Map<string, string | null>;
  /**
   * By amendment id: the presenter the latest answer was given for (its
   * position_changed's memberId), main presenter or co-presenter.
   */
  answeredFor?: Map<string, string | null>;
  /** The executive offices the reader does not see (loadExecutiveMask). */
  mask?: ExecutiveMask;
}

/**
 * The main presenter's answer as a reader gets it (PositionDto): who gave
 * it and when only when `seesRecord` (seesAnswerRecord), the answer alone
 * otherwise.
 */
export function toPositionDto(
  position: NonNullable<LoadedAmendment["position"]>,
  amendmentId: string,
  mainPresenterId: string | null,
  recorders: PositionRecorders,
  seesRecord: boolean,
): PositionDto {
  const decidedBy = position.decidedByUserId;
  const recordedBy = positionRecordedBy({
    decidedByUserId: decidedBy,
    recordedAs: recorders.recordedAs.get(amendmentId),
    recorderMemberId: decidedBy ? recorders.memberOf.get(decidedBy) : null,
    mainPresenterId,
  });
  // A presenter's own answer names that presenter; an office the reader
  // does not see reads as the generic "CEA", as on the document.
  const answeredFor =
    recordedBy === "presenter"
      ? (recorders.answeredFor?.get(amendmentId) ?? mainPresenterId)
      : null;
  const answeredBy =
    answeredFor && recorders.mask?.has(answeredFor)
      ? GENERIC_EXECUTIVE_MEMBER_ID
      : answeredFor;
  return {
    position: position.position,
    comment: position.comment,
    recordedBy: seesRecord ? recordedBy : null,
    recorder: seesRecord
      ? positionRecorder(
          recordedBy,
          decidedBy ? recorders.roleOf?.get(decidedBy) : null,
        )
      : null,
    updatedAt: seesRecord ? position.updatedAt.toISOString() : null,
    answeredBy: seesRecord ? answeredBy : null,
  };
}

/**
 * What toPositionDto needs to say who gave each answer. With `actor`, the
 * offices it does not see are masked in `answeredBy`.
 */
export async function loadPositionRecorders(
  rows: LoadedAmendment[],
  actor?: Actor,
): Promise<PositionRecorders> {
  const answered = rows.filter((row) => row.position);
  const recordedAs = new Map<string, string | null>();
  const answeredFor = new Map<string, string | null>();
  if (answered.length > 0) {
    const latest = await db
      .selectDistinctOn([events.entityId], {
        amendmentId: events.entityId,
        by: sql<string | null>`${events.payload}->>'by'`,
        memberId: sql<string | null>`${events.payload}->>'memberId'`,
      })
      .from(events)
      .where(
        and(
          eq(events.entityType, "amendment"),
          eq(events.type, "position_changed"),
          inArray(
            events.entityId,
            answered.map((row) => row.id),
          ),
        ),
      )
      .orderBy(events.entityId, desc(events.createdAt), desc(events.id));
    for (const row of latest) {
      recordedAs.set(row.amendmentId, row.by);
      answeredFor.set(row.amendmentId, row.memberId);
    }
  }
  const userIds = unique(
    answered
      .map((row) => row.position?.decidedByUserId ?? null)
      .filter((id): id is string => id !== null),
  );
  const recorders =
    userIds.length > 0
      ? await db
          .select({
            id: users.id,
            memberId: users.memberId,
            role: roles.name,
          })
          .from(users)
          .leftJoin(roles, eq(roles.id, users.roleId))
          .where(inArray(users.id, userIds))
      : [];
  return {
    recordedAs,
    memberOf: new Map(recorders.map((row) => [row.id, row.memberId])),
    roleOf: new Map(recorders.map((row) => [row.id, row.role])),
    answeredFor,
    mask: actor && answered.length > 0 ? await loadExecutiveMask(actor) : null,
  };
}

/** Key of one party's answer to one transactional. */
function acceptanceKey(amendmentId: string, memberId: string): string {
  return `${amendmentId}:${memberId}`;
}

/**
 * AcceptanceDto.recordedBy, from the latest acceptance_recorded event of
 * that party: the Mesa recorded the answer when the event names the party
 * it answered for (`recordedForMemberId`), as it was then. An answer with no
 * such event (the creator's own, accepted when it presented it) is the
 * party's.
 */
export function acceptanceRecordedBy(
  recordedForMemberId: string | null | undefined,
): AcceptanceDto["recordedBy"] {
  return recordedForMemberId ? "mesa" : "party";
}

/**
 * What acceptanceRecordedBy needs, by acceptanceKey: `recordedForMemberId`
 * of the latest acceptance_recorded event of each party that answered a
 * transactional among `rows` (the Mesa can correct an answer, so only the
 * latest one counts).
 */
async function loadAcceptanceRecorders(
  rows: LoadedAmendment[],
): Promise<Map<string, string | null>> {
  const recordedFor = new Map<string, string | null>();
  const answered = rows.filter(
    (row) =>
      row.kind === "transactional" &&
      partiesOf(row).some((party) => party.decision !== "pending"),
  );
  if (answered.length === 0) return recordedFor;
  const partyOf = sql<string | null>`${events.payload}->>'memberId'`;
  const latest = await db
    .selectDistinctOn([events.entityId, partyOf], {
      amendmentId: events.entityId,
      memberId: partyOf,
      recordedFor: sql<
        string | null
      >`${events.payload}->>'recordedForMemberId'`,
    })
    .from(events)
    .where(
      and(
        eq(events.entityType, "amendment"),
        eq(events.type, "acceptance_recorded"),
        inArray(
          events.entityId,
          answered.map((row) => row.id),
        ),
      ),
    )
    .orderBy(events.entityId, partyOf, desc(events.createdAt), desc(events.id));
  for (const row of latest) {
    if (!row.memberId) continue;
    recordedFor.set(
      acceptanceKey(row.amendmentId, row.memberId),
      row.recordedFor,
    );
  }
  return recordedFor;
}

type SourceState = Parameters<typeof unopenSourceReason>[0] & { id: string };

/**
 * Where the amendments grouped by the submitted transactionals among `rows`
 * stand, by id: from `rows` when they are there (a document's list), read
 * otherwise.
 */
async function loadSourceStates(
  rows: LoadedAmendment[],
): Promise<Map<string, SourceState>> {
  const known = new Map<string, SourceState>(rows.map((row) => [row.id, row]));
  const missing = unique(
    rows
      .filter(
        (row) => row.kind === "transactional" && row.status === "submitted",
      )
      .flatMap((row) => row.sources.map((source) => source.sourceId)),
  ).filter((id) => !known.has(id));
  if (missing.length > 0) {
    const extra = await db
      .select({
        id: amendments.id,
        status: amendments.status,
        admission: amendments.admission,
        validatedAt: amendments.validatedAt,
        decidedAt: amendments.decidedAt,
      })
      .from(amendments)
      .where(inArray(amendments.id, missing));
    for (const row of extra) known.set(row.id, row);
  }
  return known;
}

/** sourcesAreOpen for a loaded transactional; true for other kinds. */
function transactionalSourcesOpen(
  row: Pick<LoadedAmendment, "kind" | "sources">,
  states: Map<string, SourceState>,
): boolean {
  if (row.kind !== "transactional") return true;
  const sources = row.sources.map((source) => states.get(source.sourceId));
  return (
    sources.every((source) => source !== undefined) &&
    sourcesAreOpen(sources.filter((source) => source !== undefined))
  );
}

/**
 * Reloads one amendment after a mutation and maps it for the actor. As in
 * the document's list, it names only the related amendments the actor can
 * see (sourceIds, transactionalIds): a source replaced by a transactional
 * the actor cannot see (one validated privately before validation always
 * published transactionals) does not point to it.
 */
export async function amendmentDto(
  ctx: DocumentAmendmentContext,
  id: string,
): Promise<AmendmentDto> {
  const row = await loadAmendment(db, id);
  if (!row) fail(404, "Enmienda no encontrada");
  const relatedIds = unique([
    ...row.sources.map((source) => source.sourceId),
    ...row.derived.map((derived) => derived.transactionalId),
  ]);
  const related =
    relatedIds.length > 0
      ? await findAmendments(db, inArray(amendments.id, relatedIds))
      : [];
  const visibleIds = new Set([
    row.id,
    ...related.filter((item) => isVisible(ctx, item)).map((item) => item.id),
  ]);
  const [dto] = await buildAmendmentDtos(ctx, [row], visibleIds);
  return dto!;
}

// List ---------------------------------------------------------------------

export async function listDocumentAmendments(
  ctx: DocumentAmendmentContext,
): Promise<DocumentAmendmentsDto> {
  const rows = await findAmendments(
    db,
    eq(amendments.documentId, ctx.document.id),
  );
  const visible = rows.filter((row) => isVisible(ctx, row));
  const visibleIds = new Set(visible.map((row) => row.id));
  const dtos = await buildAmendmentDtos(ctx, visible, visibleIds);

  const ids = [...visibleIds];
  const relationRows =
    ids.length > 0
      ? await db
          .select()
          .from(amendmentRelations)
          .where(
            or(
              inArray(amendmentRelations.fromId, ids),
              inArray(amendmentRelations.toId, ids),
            ),
          )
          .orderBy(asc(amendmentRelations.createdAt))
      : [];

  const wordingRows = await loadPassageWordings(db, ctx.document.id);

  return {
    amendments: dtos,
    relations: relationRows
      .filter((row) => visibleIds.has(row.fromId) && visibleIds.has(row.toId))
      .map(toRelationDto),
    wordings: wordingRows
      .filter((row) => row.amendmentIds.every((id) => visibleIds.has(id)))
      .map(toPassageWordingDto),
    baseVersionId: ctx.document.baseVersionId,
  };
}

/**
 * Amendments of these documents for the Secretaría's validation inbox, in
 * text order:
 * - to validate (awaitsValidation);
 * - to publish (awaitsPublication);
 * - late ones it validated, published or not, still waiting for the
 *   assembly's decision (awaitsAssemblyDecision);
 * - read only, transactionals proposed by a member that their main authors
 *   have not all accepted yet (awaitsAuthors), so it sees what is about to
 *   reach it.
 */
export async function findAmendmentsAwaitingReview(
  documents: { id: string }[],
): Promise<LoadedAmendment[]> {
  if (documents.length === 0) return [];
  const rows = await findAmendments(
    db,
    and(
      inArray(
        amendments.documentId,
        documents.map((document) => document.id),
      ),
      ne(amendments.status, "draft"),
      or(
        isNull(amendments.publishedAt),
        and(
          eq(amendments.late, true),
          eq(amendments.admission, "pending"),
          eq(amendments.status, "submitted"),
          isNotNull(amendments.validatedAt),
        ),
      ),
    ),
  );
  return rows.filter((row) => {
    const fields = { ...row, authorsApproval: authorsApproval(row) };
    return (
      awaitsValidation(fields) ||
      awaitsPublication(fields) ||
      awaitsAssemblyDecision(fields) ||
      awaitsAuthors(fields)
    );
  });
}

/**
 * Amendments of these documents the Secretaría validated and published that
 * are still undecided, for «Validadas» in the validation inbox (user's
 * decision of 2026-11-20), where a validation made by mistake is taken
 * back. Late ones still waiting for the assembly's decision are left out:
 * «Fuera de plazo» lists them. Whether each can go back is the DTO's
 * `can.unvalidate`, which the caller checks.
 */
export async function findValidatedPublishedAmendments(
  documents: { id: string }[],
): Promise<LoadedAmendment[]> {
  if (documents.length === 0) return [];
  const rows = await findAmendments(
    db,
    and(
      inArray(
        amendments.documentId,
        documents.map((document) => document.id),
      ),
      eq(amendments.status, "submitted"),
      isNotNull(amendments.validatedAt),
      isNotNull(amendments.publishedAt),
    ),
  );
  return rows.filter((row) => !awaitsAssemblyDecision(row));
}

/**
 * Submitted transactionals of these documents (published, not voted) in
 * which the member is a party still to answer, for the home page: only the
 * ones it can still answer (awaitsPartyAnswer). Those that can no longer go
 * through (one of the amendments they group is decided or replaced by
 * another transactional: transactionalSourcesOpen) are left out, as the
 * ones already closed are.
 */
export async function findTransactionalsAwaitingMember(
  documentIds: string[],
  memberId: string,
): Promise<LoadedAmendment[]> {
  if (documentIds.length === 0) return [];
  const rows = await findAmendments(
    db,
    and(
      inArray(amendments.documentId, documentIds),
      eq(amendments.kind, "transactional"),
      eq(amendments.status, "submitted"),
      exists(
        db
          .select({ id: amendmentAcceptances.id })
          .from(amendmentAcceptances)
          .where(
            and(
              eq(amendmentAcceptances.amendmentId, amendments.id),
              eq(amendmentAcceptances.memberId, memberId),
              eq(amendmentAcceptances.role, "author"),
              eq(amendmentAcceptances.decision, "pending"),
            ),
          ),
      ),
    ),
  );
  const states = await loadSourceStates(rows);
  return rows.filter((row) =>
    awaitsPartyAnswer({
      status: row.status,
      memberId,
      parties: partiesOf(row),
      sourcesOpen: transactionalSourcesOpen(row, states),
      voted: false,
    }),
  );
}

/**
 * The amendments a transactional would replace that the member presents as
 * main author (or, for older rows, authors): why it is a party.
 */
export async function membersSourcesOf(
  transactionals: LoadedAmendment[],
  memberId: string,
): Promise<Map<string, { id: string; code: string | null }[]>> {
  const sourceIds = unique(
    transactionals.flatMap((row) => row.sources.map((s) => s.sourceId)),
  );
  const result = new Map<string, { id: string; code: string | null }[]>();
  if (sourceIds.length === 0) return result;
  const sources = await findAmendmentsByIds(sourceIds);
  const byId = new Map(sources.map((row) => [row.id, row]));
  for (const transactional of transactionals) {
    const own = transactional.sources
      .map((source) => byId.get(source.sourceId))
      .filter((row): row is LoadedAmendment => row !== undefined);
    const main = own.filter((row) => loadedMainAuthor(row) === memberId);
    const listed =
      main.length > 0
        ? main
        : own.filter((row) =>
            row.authors.some((author) => author.memberId === memberId),
          );
    result.set(
      transactional.id,
      listed.map((row) => ({ id: row.id, code: row.code })),
    );
  }
  return result;
}

/** These amendments with their authors, acceptances and position. */
export async function findAmendmentsByIds(
  ids: string[],
): Promise<LoadedAmendment[]> {
  if (ids.length === 0) return [];
  return findAmendments(db, inArray(amendments.id, ids));
}

/**
 * Presented, undecided amendments of these documents (status submitted), in
 * text order, with their authors, acceptances and position. Callers filter
 * them by visibility.
 */
export async function findSubmittedAmendments(
  documentIds: string[],
): Promise<LoadedAmendment[]> {
  if (documentIds.length === 0) return [];
  return findAmendments(
    db,
    and(
      inArray(amendments.documentId, documentIds),
      eq(amendments.status, "submitted"),
    ),
  );
}

/**
 * Every amendment of these documents past draft, in text order, with their
 * authors, acceptances and position. Callers filter them by visibility.
 */
export async function findPresentedAmendments(
  documentIds: string[],
): Promise<LoadedAmendment[]> {
  if (documentIds.length === 0) return [];
  return findAmendments(
    db,
    and(
      inArray(amendments.documentId, documentIds),
      ne(amendments.status, "draft"),
    ),
  );
}

/**
 * canSeeAmendment for a loaded row, with the presenters of its document
 * (they read it once validated, published or not).
 */
export function canSeeLoadedAmendment(
  actor: Actor,
  row: LoadedAmendment,
  document: DocumentPresenters,
): boolean {
  return canSeeAmendment(actor, {
    status: row.status,
    publishedAt: row.publishedAt,
    validatedAt: row.validatedAt,
    documentPresenters: document,
    createdByUserId: row.createdByUserId,
    authorMemberIds: row.authors.map((author) => author.memberId),
    partyMemberIds: involvedMemberIds(row),
  });
}

// Drafts -------------------------------------------------------------------

export async function createAmendmentDraft(
  ctx: DocumentAmendmentContext,
  body: AmendmentDraftBody,
): Promise<AmendmentDto> {
  const { actor, document } = ctx;
  const onBehalf = Boolean(body.onBehalfOfMemberId) && canModerate(actor);
  if (!actor.can(PERMISSION_KEYS.AMENDMENT_CREATE) && !onBehalf) {
    fail(403, "No tienes permiso para presentar enmiendas");
  }
  assertAmendable(ctx);
  // Every executive office is named by its real id (an account that does
  // not see them reads their list to compose this); the generic "CEA" id
  // is never a member (422 `executive_author`).
  await requireAmendmentBodyMembers(actor, {
    listed: body.authorMemberIds,
    named: body.mainAuthorMemberId,
  });
  const authors = await resolveDraftAuthors(actor, body);
  // With co-authors, the main author has to be named (pickMainAuthor).
  const mainAuthorId = mainAuthorOrFail(
    pickMainAuthor(authors.memberIds, body.mainAuthorMemberId),
  )!;
  const base = await loadBaseBlocks(document);

  const id = await db.transaction(async (tx) => {
    await lockDocument(tx, document.id);
    const { ops, errors } = prepareAmendmentOps({
      ops: body.ops,
      base,
      takenIds: await otherInsertedIds(tx, document.id),
    });
    assertValidOps(errors);
    // Images it inserts are this document's own.
    await assertOpImagesBelong(document.id, ops);

    const meta: StoredAmendmentMeta = {
      presentingMemberId: mainAuthorId,
      ...(body.globalReplace ? { globalReplace: body.globalReplace } : {}),
    };
    const [row] = await tx
      .insert(amendments)
      .values({
        documentId: document.id,
        baseVersionId: document.baseVersionId!,
        kind: body.kind,
        status: "draft",
        admission: "pending",
        ops,
        meta,
        justification: body.justification,
        positionKey: amendmentSortKey(ops, base),
        createdByUserId: actor.user.id,
      })
      .returning({ id: amendments.id });
    await tx.insert(amendmentAuthors).values(
      authors.memberIds.map((memberId) => ({
        amendmentId: row!.id,
        memberId,
      })),
    );

    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "amendment",
      entityId: row!.id,
      type: "amendment_created",
      payload: {
        kind: body.kind,
        authorMemberIds: authors.memberIds,
        mainAuthorId,
        ...(body.onBehalfOfMemberId
          ? { onBehalfOfMemberId: body.onBehalfOfMemberId }
          : {}),
      },
      actor,
    });
    return row!.id;
  });

  return amendmentDto(ctx, id);
}

/**
 * Whether the composer may read the real authors of an amendment
 * (amendmentComposerAuthors): exactly whoever may edit it, so the same
 * checks as updateAmendmentDraft, in the same order. An author of a draft
 * ("ok") still needs the document and the assembly to take edits
 * (assertAmendable), which the caller checks.
 */
export function composerAuthorsAccess(input: {
  isAuthor: boolean;
  status: AmendmentStatus;
}): "ok" | "not_author" | "not_draft" {
  if (!input.isAuthor) return "not_author";
  return input.status === "draft" ? "ok" : "not_draft";
}

/**
 * The real authors of a draft, for its composer and nothing else: the one
 * read where an account that does not see the executive offices gets the
 * ones among the authors of an amendment, so it sees which it named and
 * takes them out one by one. Only while the draft can be edited: once the
 * document is voted or the assembly closed it answers 409, as the PUT does.
 * Members only, never who acted for them. Every other answer about the
 * same draft keeps the generic "CEA" (redactAuthors).
 */
export function amendmentComposerAuthors(
  ctx: AmendmentContext,
): AmendmentComposerAuthorsDto {
  const { amendment } = ctx;
  const access = composerAuthorsAccess({
    isAuthor: ctx.isAuthor,
    status: amendment.status,
  });
  if (access === "not_author") {
    fail(403, "Solo los autores pueden editar la enmienda");
  }
  if (access === "not_draft") fail(409, "Solo se pueden editar borradores");
  assertAmendable(ctx);
  const mainAuthorId = loadedMainAuthor(amendment);
  return {
    authors: orderAuthors(
      amendment.authors.map((author) => toMemberRef(author.member)),
      mainAuthorId ?? undefined,
    ),
    mainAuthorId,
  };
}

export async function updateAmendmentDraft(
  ctx: AmendmentContext,
  body: AmendmentUpdateBody,
): Promise<AmendmentDto> {
  const { actor, amendment, document } = ctx;
  if (!ctx.isAuthor) fail(403, "Solo los autores pueden editar la enmienda");
  if (amendment.status !== "draft")
    fail(409, "Solo se pueden editar borradores");
  assertAmendable(ctx);

  const currentAuthorIds = amendment.authors.map((author) => author.memberId);
  // The executive offices among the authors are named by their real ids,
  // which whoever edits the draft reads in the composer
  // (amendmentComposerAuthors); the generic "CEA" id is never one (422
  // `executive_author`). The actor passed the checks of that read just
  // above, so the offices already among the authors (`known`) are ones it
  // reads there and may keep even when it may not name any other.
  await requireAmendmentBodyMembers(actor, {
    listed: body.authorMemberIds,
    named: body.mainAuthorMemberId,
    known: currentAuthorIds,
  });

  const transactional = amendment.kind === "transactional";
  if (transactional && body.kind) {
    fail(422, "No se puede cambiar el tipo de una transaccional");
  }
  const kind: AmendmentKind = transactional
    ? "transactional"
    : (body.kind ?? amendment.kind);
  const meta = readMeta(amendment);

  // A new main author must already be an author or be added now; it then
  // anchors the authors, as the stored one does: `authorMemberIds` lists
  // the others.
  const requestedMain = body.mainAuthorMemberId || undefined;
  if (
    requestedMain &&
    ![
      ...currentAuthorIds,
      ...(body.authorMemberIds ?? []),
      body.onBehalfOfMemberId,
    ].includes(requestedMain)
  ) {
    fail(422, MAIN_AUTHOR_MESSAGES.not_author);
  }
  const anchor = requestedMain ?? meta.presentingMemberId;
  const requestedAuthorIds = requestedDraftAuthorIds({
    authorMemberIds: body.authorMemberIds,
    onBehalfOfMemberId: body.onBehalfOfMemberId,
    actorMemberId: actor.memberId,
    presentingMemberId: anchor,
    currentAuthorIds,
  });
  const authorsChanged =
    requestedAuthorIds !== undefined ||
    Boolean(body.onBehalfOfMemberId) ||
    (requestedMain !== undefined && requestedMain !== meta.presentingMemberId);
  const authors = authorsChanged
    ? await resolveDraftAuthors(actor, {
        onBehalfOfMemberId: body.onBehalfOfMemberId,
        authorMemberIds:
          requestedAuthorIds ?? currentAuthorIds.filter((id) => id !== anchor),
        currentPresentingId: anchor,
      })
    : null;
  // Joint ordinary amendments may name any active member, but only the
  // parties may sign a transactional (as in createTransactionalAmendment).
  if (
    authors &&
    transactional &&
    !canModerate(actor) &&
    unauthorizedTransactionalAuthors(authors.memberIds, {
      actorMemberId: actor.memberId,
      currentAuthorIds,
      partyMemberIds: [
        ...involvedMemberIds(amendment),
        document.proponentMemberId,
        ...document.coProponentMemberIds,
      ],
      executiveIds: await loadExecutiveMemberIds(),
    }).length > 0
  ) {
    fail(
      403,
      "Solo las partes de la transaccional pueden figurar como autoras",
    );
  }

  // The main author: the one named, or the stored one while it is still an
  // author (a draft the Mesa presents on behalf of a member takes it).
  const nextAuthorIds = authors ? authors.memberIds : currentAuthorIds;
  const mainAuthorId =
    authors || body.mainAuthorMemberId !== undefined
      ? mainAuthorOrFail(
          pickMainAuthor(
            nextAuthorIds,
            body.mainAuthorMemberId,
            authors?.presentingMemberId ?? meta.presentingMemberId,
          ),
        )
      : null;

  const nextMeta: StoredAmendmentMeta = { ...meta };
  if (mainAuthorId) nextMeta.presentingMemberId = mainAuthorId;
  if (body.globalReplace === null) delete nextMeta.globalReplace;
  else if (body.globalReplace) nextMeta.globalReplace = body.globalReplace;

  const base = await loadBaseBlocks(document);

  await db.transaction(async (tx) => {
    await lockDocument(tx, document.id);
    const { ops, errors } = prepareAmendmentOps({
      ops: body.ops ?? amendment.ops,
      base,
      takenIds: await otherInsertedIds(tx, document.id, amendment.id),
    });
    assertValidOps(errors);
    // Images it inserts are this document's own.
    await assertOpImagesBelong(document.id, ops);

    const updated = await tx
      .update(amendments)
      .set({
        kind,
        ops,
        meta: nextMeta,
        justification: body.justification ?? amendment.justification,
        positionKey: amendmentSortKey(ops, base),
      })
      .where(
        and(
          eq(amendments.id, amendment.id),
          eq(amendments.status, "draft"),
          buildOptimisticLockCondition(amendments.updatedAt, body.updatedAt),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");

    if (authors) {
      await tx
        .delete(amendmentAuthors)
        .where(eq(amendmentAuthors.amendmentId, amendment.id));
      await tx.insert(amendmentAuthors).values(
        authors.memberIds.map((memberId) => ({
          amendmentId: amendment.id,
          memberId,
        })),
      );
    }

    // The parties accepted a text: a new one needs their answer again.
    if (transactional && body.ops !== undefined) {
      await tx
        .update(amendmentAcceptances)
        .set({ decision: "pending", decidedAt: null, recordedByUserId: null })
        .where(
          and(
            eq(amendmentAcceptances.amendmentId, amendment.id),
            actor.memberId
              ? ne(amendmentAcceptances.memberId, actor.memberId)
              : undefined,
          ),
        );
    }

    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_updated",
      payload: {
        kind,
        ...(authors ? { authorMemberIds: authors.memberIds } : {}),
        ...(mainAuthorId ? { mainAuthorId } : {}),
        ...(body.onBehalfOfMemberId
          ? { onBehalfOfMemberId: body.onBehalfOfMemberId }
          : {}),
      },
      actor,
    });
  });

  return amendmentDto(ctx, amendment.id);
}

export async function deleteAmendmentDraft(
  ctx: AmendmentContext,
): Promise<{ success: true }> {
  const { amendment } = ctx;
  if (!ctx.isAuthor) fail(403, "Solo los autores pueden eliminar la enmienda");
  if (amendment.status !== "draft")
    fail(409, "Solo se pueden eliminar borradores");

  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(amendments)
      .where(
        and(eq(amendments.id, amendment.id), eq(amendments.status, "draft")),
      )
      .returning({ id: amendments.id });
    if (deleted.length === 0) fail(409, "La enmienda ya no es un borrador");
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_deleted",
      // An explicit allowlist (never the correction note): enough to say
      // what was deleted and who still sees it once the row is gone
      // (insidersOfPayload). Only kind and code reach non-Admins.
      payload: {
        kind: amendment.kind,
        code: amendment.code,
        documentId: ctx.document.id,
        createdByUserId: amendment.createdByUserId,
        submittedByUserId: amendment.submittedByUserId,
        authorMemberIds: amendment.authors.map((author) => author.memberId),
        mainAuthorId: loadedMainAuthor(amendment),
        ...(amendment.kind === "transactional"
          ? { sourceIds: amendment.sources.map((source) => source.sourceId) }
          : {}),
      },
      actor: ctx.actor,
    });
  });
  return { success: true };
}

// Submission and withdrawal ----------------------------------------------------

/**
 * The events of a document's amendments, also of those deleted since (their
 * `amendment_deleted` carries the document): events store no document.
 */
function amendmentEventOfDocument(documentId: string) {
  return or(
    inArray(
      events.entityId,
      sql`(select ${amendments.id} from ${amendments} where ${amendments.documentId} = ${documentId})`,
    ),
    sql`${events.payload}->>'documentId' = ${documentId}`,
  )!;
}

/**
 * The next number of an amendment in the document: one past the highest
 * ever given, also to an amendment deleted since (a draft sent back for
 * correction may be deleted; its presentation recorded its number).
 */
async function nextNumber(tx: Tx, documentId: string): Promise<number> {
  const [row] = await tx
    .select({ value: sql<number>`coalesce(max(${amendments.number}), 0)` })
    .from(amendments)
    .where(
      and(
        eq(amendments.documentId, documentId),
        ne(amendments.kind, "transactional"),
      ),
    );
  const [given] = await tx
    .select({
      value: sql<number>`coalesce(max(case when ${events.payload}->>'number' ~ '^[0-9]+$' then (${events.payload}->>'number')::integer end), 0)`,
    })
    .from(events)
    .where(
      and(
        eq(events.entityType, "amendment"),
        amendmentEventOfDocument(documentId),
        eq(events.type, "amendment_submitted"),
      ),
    );
  return Math.max(Number(row?.value ?? 0), Number(given?.value ?? 0)) + 1;
}

/** A code an amendment of the document holds or held, and when. */
interface TakenCode {
  amendmentId: string;
  code: string;
  /** When it was recorded; null for the code the row holds now. */
  at: Date | null;
}

/**
 * Every code the amendments of a document hold or ever held: the ones on
 * their rows, the ones their presentation recorded, the ones a correction of
 * the main author gave up (`previousCode`) and those of deleted drafts. A
 * code once given is never handed to another amendment.
 */
async function takenAmendmentCodes(
  tx: Tx,
  documentId: string,
): Promise<TakenCode[]> {
  const rows = await tx
    .select({ id: amendments.id, code: amendments.code })
    .from(amendments)
    .where(
      and(eq(amendments.documentId, documentId), isNotNull(amendments.code)),
    );
  const recorded = await tx
    .select({
      amendmentId: events.entityId,
      payload: events.payload,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        eq(events.entityType, "amendment"),
        amendmentEventOfDocument(documentId),
        inArray(events.type, [
          "amendment_submitted",
          "amendment_authors_changed",
          "amendment_deleted",
        ]),
      ),
    );
  const taken: TakenCode[] = rows.map((row) => ({
    amendmentId: row.id,
    code: row.code!,
    at: null,
  }));
  for (const event of recorded) {
    const payload = (event.payload ?? {}) as {
      code?: unknown;
      previousCode?: unknown;
    };
    for (const code of [payload.code, payload.previousCode]) {
      if (typeof code === "string" && code) {
        taken.push({
          amendmentId: event.amendmentId,
          code,
          at: event.createdAt,
        });
      }
    }
  }
  return taken;
}

/**
 * Serializes the numbering of a document's amendments: publishing takes no
 * lock of the document (it is allowed after the final vote too).
 */
async function lockNumbering(tx: Tx, documentId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`amendment_numbering:${documentId}`}))`,
  );
}

/**
 * The next number of a code sequence of the document ("UGR4", "CEA2"): one
 * per prefix (amendmentCodePrefix), whoever holds it now. The offices of the
 * CEA share "CEA"; a member whose prefix changed starts its own at 1, and
 * its earlier codes keep theirs taken. Every code ever given in the document
 * counts (takenAmendmentCodes), so a number never goes to two amendments.
 * Only the amendment that held a code of this sequence before
 * (`returningAmendmentId`) gets its latest one back, when a correction
 * returns it to that sequence.
 */
async function nextMemberSeq(
  tx: Tx,
  documentId: string,
  sequence: { prefix: string; returningAmendmentId?: string },
): Promise<number> {
  const taken = await takenAmendmentCodes(tx, documentId);
  const own = taken
    .filter(
      (entry) =>
        entry.amendmentId === sequence.returningAmendmentId &&
        entry.at !== null &&
        amendmentCodeSeq(entry.code, sequence.prefix) !== null,
    )
    .sort((a, b) => b.at!.getTime() - a.at!.getTime())[0];
  if (own) return amendmentCodeSeq(own.code, sequence.prefix)!;
  const codes = new Set(taken.map((entry) => entry.code));
  let max = 0;
  for (const code of codes) {
    max = Math.max(max, amendmentCodeSeq(code, sequence.prefix) ?? 0);
  }
  // An acronym that ends where another begins ("UC" and "UC3") could meet
  // one of the other's codes: skip it.
  let seq = max + 1;
  while (codes.has(formatAmendmentCode(sequence.prefix, seq))) seq += 1;
  return seq;
}

/**
 * The prefix of the codes a member presents (amendmentCodePrefix), or null
 * for a member that is not there.
 */
async function codePrefixOf(
  tx: Tx,
  memberId: string | null,
): Promise<string | null> {
  if (!memberId) return null;
  const [member] = await tx
    .select({
      acronym: members.acronym,
      kind: members.kind,
      universityAcronym: members.universityAcronym,
    })
    .from(members)
    .where(eq(members.id, memberId));
  return member ? amendmentCodePrefix(member) : null;
}

/**
 * Numbers amendments when they are presented: its number in the document
 * and its code ("UGR3", "CEA2", or "T1" for a transactional), in the order
 * they were presented. A number once given stays taken, whatever happens to
 * the amendment. What one already has stays (presented again after a
 * correction); publishing calls it too, for amendments presented before this
 * rule, when they were numbered on publication. Returns the code of each.
 */
async function numberAmendments(
  tx: Tx,
  documentId: string,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const codes = new Map<string, string | null>();
  if (ids.length === 0) return codes;
  await lockNumbering(tx, documentId);
  const rows = await tx
    .select({
      id: amendments.id,
      kind: amendments.kind,
      number: amendments.number,
      memberSeq: amendments.memberSeq,
      code: amendments.code,
      meta: amendments.meta,
    })
    .from(amendments)
    .where(
      and(
        eq(amendments.documentId, documentId),
        inArray(amendments.id, [...ids]),
      ),
    )
    .orderBy(
      asc(amendments.submittedAt),
      asc(amendments.createdAt),
      asc(amendments.id),
    );
  for (const row of rows) {
    if (row.kind === "transactional") {
      let code = row.code;
      if (code === null) {
        const taken = await takenAmendmentCodes(tx, documentId);
        code = nextTransactionalCode(taken.map((entry) => entry.code));
        await tx
          .update(amendments)
          .set({ code })
          .where(eq(amendments.id, row.id));
      }
      codes.set(row.id, code);
      continue;
    }
    const prefix = await codePrefixOf(
      tx,
      readMeta(row).presentingMemberId ?? null,
    );
    const number = row.number ?? (await nextNumber(tx, documentId));
    let memberSeq = row.memberSeq;
    let code = row.code;
    if (prefix && (code === null || memberSeq === null)) {
      memberSeq = await nextMemberSeq(tx, documentId, {
        prefix,
        returningAmendmentId: row.id,
      });
      code = formatAmendmentCode(prefix, memberSeq);
    }
    if (
      number !== row.number ||
      memberSeq !== row.memberSeq ||
      code !== row.code
    ) {
      await tx
        .update(amendments)
        .set({ number, memberSeq, code })
        .where(eq(amendments.id, row.id));
    }
    codes.set(row.id, code);
  }
  return codes;
}

export async function submitAmendment(
  ctx: AmendmentContext,
): Promise<AmendmentDto> {
  const { actor, amendment, document, now } = ctx;
  if (!ctx.isAuthor) fail(403, "Solo los autores pueden presentar la enmienda");
  if (amendment.status !== "draft")
    fail(409, "La enmienda ya se ha presentado");
  assertAmendable(ctx);

  const transactional = amendment.kind === "transactional";
  const privileged = canModerate(actor) || canReviewAmendments(actor);
  if (
    !transactional &&
    !privileged &&
    ctx.window.opensAt &&
    now < ctx.window.opensAt
  ) {
    fail(409, "El plazo de enmiendas todavía no está abierto");
  }

  const meta = readMeta(amendment);
  // The main author presents it: it drives memberSeq and the code.
  const presentingId = loadedMainAuthor(amendment);
  const presenting = amendment.authors.find(
    (author) => author.memberId === presentingId,
  );
  if (!transactional && !presenting)
    fail(422, "Indica el miembro que presenta la enmienda");

  const afterCorrection = amendment.correctionRequestedAt !== null;
  await db.transaction(async (tx) => {
    await lockDocument(tx, document.id);
    let payload: Record<string, unknown>;
    let updated: { id: string }[];
    // A transactional the Mesa presents in session needs no check: it is
    // validated, admitted and published at once.
    let instant = false;
    let replace: Pick<
      Parameters<typeof replaceSources>[1],
      "sources" | "competitors"
    > | null = null;
    // Presenting again clears the correction the Secretaría asked for.
    const review = {
      submittedAt: now,
      submittedByUserId: actor.user.id,
      correctionNote: null,
      correctionRequestedAt: null,
    };

    if (transactional) {
      // As on creation: published, open sources, locked with the
      // transactional in one ordered pass.
      const sourceIds = amendment.sources.map((source) => source.sourceId);
      const competitors = await findCompetitors(
        tx,
        document.id,
        amendment.id,
        sourceIds,
      );
      const locked = await lockOpenSources(
        tx,
        document.id,
        sourceIds,
        [amendment.id, ...competitors.ids],
        true,
      );
      // Presented by a member, it waits for the main authors of what it
      // replaces and then for the Secretaría (reviewState).
      instant = canModerate(actor);
      updated = await tx
        .update(amendments)
        .set({
          ...review,
          status: "submitted",
          late: false,
          ...instantReview(instant, actor, now),
        })
        .where(
          and(eq(amendments.id, amendment.id), eq(amendments.status, "draft")),
        )
        .returning({ id: amendments.id });
      const parties = await lockParties(tx, [amendment.id], "share");
      const approval = authorsApproval({
        kind: "transactional",
        acceptances: parties,
      });
      // Presented by the Mesa and already accepted by everyone: it replaces
      // its sources at once.
      if (instant && approval === "accepted") {
        replace = {
          sources: sourceIds.map((id) => locked.get(id)!),
          competitors: lockedCompetitors(competitors, locked.values()),
        };
      }
      payload = {
        code: amendment.code,
        late: false,
        admission: instant ? "admitted" : "pending",
        ...(!instant && approval !== "accepted" ? { awaitsAuthors: true } : {}),
      };
    } else {
      // Numbered here, on presentation (numberAmendments, below). One sent
      // back for correction keeps its number and, while its main author's
      // prefix is the same, its code; otherwise it takes the next of the
      // new prefix, and the old code stays taken.
      const prefix =
        (await codePrefixOf(tx, presenting!.memberId)) ??
        amendmentCodePrefix(presenting!.member);
      const kept = numberingToKeep(amendment, prefix);
      const number = kept.number;
      const memberSeq = kept.memberSeq;
      const code =
        memberSeq === null ? null : formatAmendmentCode(prefix, memberSeq);
      const late = submissionLate(amendment, isLateSubmission(ctx.window, now));
      // Never admitted here: the Secretaría validates it first (and admits
      // it if on time); a late one also waits for the Mesa.
      updated = await tx
        .update(amendments)
        .set({
          ...review,
          status: "submitted",
          number,
          memberSeq,
          code,
          late,
          admission: "pending",
          validatedAt: null,
          validatedByUserId: null,
          publishedAt: null,
          meta: {
            ...meta,
            presentingMemberId: presenting!.memberId,
          } as StoredAmendmentMeta,
        })
        .where(
          and(eq(amendments.id, amendment.id), eq(amendments.status, "draft")),
        )
        .returning({ id: amendments.id });
      payload = { number, code, late, admission: "pending" };
    }
    if (updated.length === 0) fail(409, "La enmienda ya se ha presentado");
    if (afterCorrection) payload.afterCorrection = true;
    // Numbered on presentation, every kind; the event records what it got,
    // so the number stays taken whatever becomes of the amendment.
    await numberAmendments(tx, document.id, [amendment.id]);
    const [numbered] = await tx
      .select({ number: amendments.number, code: amendments.code })
      .from(amendments)
      .where(eq(amendments.id, amendment.id));
    payload.code = numbered?.code ?? null;
    if (!transactional) payload.number = numbered?.number ?? null;

    await tx
      .insert(amendmentPositions)
      .values({ amendmentId: amendment.id, position: "pending" })
      .onConflictDoNothing();
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_submitted",
      payload,
      actor,
    });
    if (instant) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        entityType: "amendment",
        entityId: amendment.id,
        type: "amendment_validated",
        payload: { publish: true, admission: "admitted", method: "mesa" },
        actor,
      });
    }
    if (replace) {
      await replaceSources(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        actor,
        now,
        transactional: { id: amendment.id, code: numbered?.code ?? null },
        ...replace,
      });
    }
  });

  return amendmentDto(ctx, amendment.id);
}

/**
 * Review fields of a transactional presented by the Mesa (`instant`):
 * validated, admitted and published at once. Otherwise it waits for the
 * Secretaría like any other amendment.
 */
function instantReview(instant: boolean, actor: Actor, now: Date) {
  return {
    admission: (instant ? "admitted" : "pending") as AdmissionStatus,
    validatedAt: instant ? now : null,
    validatedByUserId: instant ? actor.user.id : null,
    publishedAt: instant ? now : null,
  };
}

/**
 * An author withdraws its presented, undecided amendment, or the Mesa does
 * it for them. The pending transactionals over it are closed
 * (closeTransactionalsOver).
 */
export async function withdrawAmendment(
  ctx: AmendmentContext,
): Promise<AmendmentDto> {
  const { actor, amendment, now } = ctx;
  if (!ctx.isAuthor && !canModerate(actor)) {
    fail(403, "Solo los autores o la Mesa pueden retirar la enmienda");
  }
  if (amendment.status !== "submitted") {
    fail(409, "Solo se pueden retirar enmiendas presentadas y sin decidir");
  }
  assertNotFinal(ctx);

  await db.transaction(async (tx) => {
    await lockDocument(tx, ctx.document.id, "share");
    // The amendment and the transactionals over it, in one ordered pass:
    // withdrawing it closes them.
    const dependents = await findCompetitors(tx, ctx.document.id, null, [
      amendment.id,
    ]);
    const locked = await lockAmendments(tx, ctx.document.id, [
      amendment.id,
      ...dependents.ids,
    ]);
    const updated = await tx
      .update(amendments)
      .set({ status: "withdrawn", decidedAt: now })
      .where(
        and(
          eq(amendments.id, amendment.id),
          eq(amendments.status, "submitted"),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0) fail(409, "La enmienda ya está decidida");
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_withdrawn",
      payload: { by: ctx.isAuthor ? "author" : "moderator" },
      actor,
    });
    await closeDependents(tx, ctx, dependents, locked, [
      { id: amendment.id, code: amendment.code, status: "withdrawn" },
    ]);
  });

  return amendmentDto(ctx, amendment.id);
}

// Admission ------------------------------------------------------------------

/**
 * Whether an amendment may take the requested admission decision: admitting
 * needs one that is still pending (submitted and not yet admitted) or
 * inadmissible; declaring it inadmissible needs one still submitted. Keyed on
 * the decision requested, not on the outcome of its vote, so a failed vote to
 * admit cannot overturn an admission that committed in the meantime.
 */
export function admissionEligible(
  row: { status: string; admission: string | null },
  decision: AdmissionBody["decision"],
): boolean {
  return decision === "admitted"
    ? (row.status === "submitted" && row.admission !== "admitted") ||
        row.status === "inadmissible"
    : row.status === "submitted";
}

/**
 * Refuses an admission decision that would skip the Secretaría
 * (admissionNeedsValidation): admitting an on-time amendment it has not
 * validated, or voting on one, since a failed vote to declare it
 * inadmissible would admit it.
 */
function assertValidatedForAdmission(
  rows: { status: string; late: boolean; validatedAt: Date | null }[],
  body: AdmissionBody,
): void {
  const byVote = body.method === "vote";
  if (
    rows.some((row) => admissionNeedsValidation(row, body.decision, byVote))
  ) {
    fail(
      409,
      body.decision === "admitted"
        ? "La Secretaría tiene que validar esta enmienda antes de admitirla"
        : "La Secretaría tiene que validar esta enmienda antes de votar si se admite",
    );
  }
}

/**
 * The Secretaría or the Mesa decides whether late amendments are treated,
 * or declares amendments inadmissible, by itself or by a vote (docs/api.md,
 * "Admission"). Admitting publishes them, and a formal one admitted is
 * answered by itself (autoAcceptFormal).
 */
export async function decideAmendmentAdmission(
  ctx: DocumentAmendmentContext,
  body: AdmissionBody,
  /**
   * The request comes from the session console that controls the
   * projection (controlsProjection): only then does a vote go on screen.
   */
  options: { controlsProjection?: boolean } = {},
): Promise<AmendmentAdmissionResult> {
  const { actor, document, now } = ctx;
  if (!canReviewAmendments(actor) && !canModerate(actor)) {
    fail(403, "No tienes permiso para decidir la admisión");
  }
  assertNotFinal(ctx);

  const rows = await db
    .select({
      id: amendments.id,
      status: amendments.status,
      admission: amendments.admission,
      late: amendments.late,
      validatedAt: amendments.validatedAt,
    })
    .from(amendments)
    .where(
      and(
        eq(amendments.documentId, document.id),
        inArray(amendments.id, body.amendmentIds),
      ),
    );
  if (rows.length !== body.amendmentIds.length)
    fail(404, "Enmienda no encontrada");

  if (!rows.every((row) => admissionEligible(row, body.decision))) {
    fail(
      409,
      body.decision === "admitted"
        ? "Alguna enmienda no está pendiente de admisión"
        : "Alguna enmienda ya está decidida",
    );
  }
  assertValidatedForAdmission(rows, body);

  // The members present come from the Mesa's latest headcount unless typed.
  const based =
    body.method === "vote" && body.vote
      ? await withHeadcount(ctx.assembly.id, body.vote, ctx.settings)
      : null;
  const evaluated = based ? evaluateVoteInput(based.vote, ctx.settings) : null;
  const admission: AmendmentAdmissionResult["admission"] =
    !evaluated || evaluated.outcome.result === "approved"
      ? body.decision
      : body.decision === "admitted"
        ? "inadmissible"
        : "admitted";

  const result = await db.transaction(async (tx) => {
    // A vote is projected: assembly before document ("Row locks").
    if (evaluated) await shareLockAssembly(tx, ctx.assembly.id);
    const { rule } = await lockDocument(tx, document.id, "share");
    // In id order, as an approval locks its lineage: the update below then
    // only touches rows this transaction already holds. The check above ran
    // before the lock, so a concurrent decision may have committed since.
    // Eligibility alone is not enough (both directions can be eligible, so
    // an opposite decision would be overturned): the locked rows must still
    // be exactly what the operator decided on. Declaring them inadmissible
    // closes the transactionals over them, locked in the same pass; readmitting
    // inadmissible ones brings back what that closed, so those and what they
    // group are locked too (restoreLockIds), then their acceptances.
    const readmitting =
      admission === "admitted"
        ? rows
            .filter((row) => row.status === "inadmissible")
            .map((row) => row.id)
        : [];
    const dependents =
      admission === "inadmissible"
        ? await findCompetitors(tx, document.id, null, body.amendmentIds)
        : await findCompetitors(tx, document.id, null, readmitting);
    // Admitted, a formal amendment is answered by itself, and under the
    // "incorporate" rule that acceptance closes the transactionals over it
    // (autoAcceptFormal): those are locked too, with their acceptances.
    const sourceMap =
      admission === "admitted" && dependents.sourceMap.size === 0
        ? await loadSourceMap(tx, document.id)
        : dependents.sourceMap;
    const overIds =
      admission === "admitted"
        ? transactionalsOverIds(sourceMap, body.amendmentIds)
        : [];
    const requested = new Set(body.amendmentIds);
    const lockedAll = await lockAmendments(
      tx,
      document.id,
      unique([
        ...body.amendmentIds,
        ...(admission === "inadmissible" ? dependents.ids : []),
        ...restoreLockIds(sourceMap, readmitting),
        ...overIds,
      ]),
    );
    const locked = lockedAll.filter((row) => requested.has(row.id));
    const restoreParties =
      overIds.length > 0 ? await lockParties(tx, overIds, "share") : [];
    const seen = new Map(rows.map((row) => [row.id, row]));
    if (
      locked.length !== body.amendmentIds.length ||
      !locked.every((row) => {
        const before = seen.get(row.id);
        return (
          before !== undefined &&
          before.status === row.status &&
          before.admission === row.admission &&
          admissionEligible(row, body.decision)
        );
      })
    ) {
      fail(409, "Las enmiendas han cambiado. Recarga la página");
    }
    assertValidatedForAdmission(locked, body);
    // Deciding on admission checks the amendment: one the Secretaría had not
    // validated yet (a late one) counts as validated from now on.
    const unvalidated = new Set(
      locked.filter((row) => row.validatedAt === null).map((row) => row.id),
    );
    // Admitting is a public act of the Mesa, like the transactional it
    // presents in session: an admitted amendment becomes visible to everyone,
    // so it can be debated and decided. The Mesa cannot publish otherwise.
    const unpublished =
      admission === "admitted"
        ? locked.filter((row) => row.publishedAt === null).map((row) => row.id)
        : [];
    const nowSql = sql`${now.toISOString()}::timestamptz`;
    const validation = {
      validatedAt: sql`coalesce(${amendments.validatedAt}, ${nowSql})`,
      validatedByUserId: sql`case when ${amendments.validatedAt} is null then ${actor.user.id} else ${amendments.validatedByUserId} end`,
    };
    const decisionId = cuid();
    let voteRow: VoteRow | undefined;
    if (evaluated && based) {
      [voteRow] = await tx
        .insert(votes)
        .values({
          assemblyId: ctx.assembly.id,
          subjectType: "decision",
          subjectId: decisionId,
          method: based.vote.method,
          ...voteCounts(based.vote),
          headcountId: based.headcountId,
          majority: evaluated.majority,
          result: evaluated.outcome.result,
          note: based.vote.note ?? null,
          recordedByUserId: actor.user.id,
        })
        .returning();
    }

    const [decision] = await tx
      .insert(decisions)
      .values({
        id: decisionId,
        assemblyId: ctx.assembly.id,
        kind: body.decision === "admitted" ? "admit_late" : "inadmission",
        method: body.method,
        voteId: voteRow?.id ?? null,
        subjectIds: body.amendmentIds,
        note: body.note ?? null,
        decidedByUserId: actor.user.id,
      })
      .returning();

    const updated =
      admission === "admitted"
        ? await tx
            .update(amendments)
            .set({
              ...validation,
              publishedAt: sql`coalesce(${amendments.publishedAt}, ${nowSql})`,
              admission: "admitted",
              status: "submitted",
              decidedAt: null,
              // Readmitted: the reason it was not admitted no longer holds.
              // A submitted one keeps the note the Mesa left on reopening it.
              outcomeNote: sql`case when ${amendments.status} = 'inadmissible' then null else ${amendments.outcomeNote} end`,
            })
            .where(
              and(
                inArray(amendments.id, body.amendmentIds),
                inArray(amendments.status, ["submitted", "inadmissible"]),
              ),
            )
            .returning({ id: amendments.id })
        : await tx
            .update(amendments)
            .set({
              ...validation,
              admission: "inadmissible",
              status: "inadmissible",
              // One already inadmissible (a failed vote to readmit it) keeps
              // the instant it was declared so: what that closed is dated
              // with it (sessionClosingSourceIds).
              decidedAt: sql`case when ${amendments.status} = 'inadmissible' then ${amendments.decidedAt} else ${nowSql} end`,
              // The reason, for its authors (user's decision of 2026-11-19);
              // one already inadmissible keeps the reason it was given then.
              outcomeNote: sql`case when ${amendments.status} = 'inadmissible' then ${amendments.outcomeNote} else ${body.note ?? null} end`,
            })
            .where(
              and(
                inArray(amendments.id, body.amendmentIds),
                // A failed vote to re-admit leaves inadmissible ones as they were.
                inArray(amendments.status, ["submitted", "inadmissible"]),
              ),
            )
            .returning({ id: amendments.id });
    if (updated.length !== body.amendmentIds.length) {
      fail(409, "Las enmiendas han cambiado. Recarga la página");
    }

    if (voteRow) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        entityType: "vote",
        entityId: voteRow.id,
        type: "vote_recorded",
        payload: {
          subjectType: "decision",
          subjectId: decisionId,
          result: voteRow.result,
        },
        actor,
      });
    }
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "decision",
      entityId: decisionId,
      type: "decision_recorded",
      payload: {
        kind: decision!.kind,
        method: body.method,
        subjectIds: body.amendmentIds,
      },
      actor,
    });
    for (const id of body.amendmentIds) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        entityType: "amendment",
        entityId: id,
        type:
          admission === "admitted"
            ? "amendment_admitted"
            : "amendment_inadmissible",
        payload: {
          decisionId,
          method: body.method,
          ...(voteRow
            ? { voteId: voteRow.id, voteResult: voteRow.result }
            : {}),
          ...(unvalidated.has(id) ? { validated: true } : {}),
          // The reason it is not admitted, for the email and the news; one
          // already inadmissible (a failed vote to readmit it) keeps its own.
          ...(admission === "inadmissible" &&
          body.note &&
          seen.get(id)?.status !== "inadmissible"
            ? { note: body.note }
            : {}),
        },
        actor,
      });
    }
    // Numbered on presentation; one presented before that rule is numbered now (numberAmendments).
    await numberAmendments(tx, document.id, unpublished);
    for (const id of unpublished) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        entityType: "amendment",
        entityId: id,
        type: "amendment_published",
        payload: { decisionId },
        actor,
      });
    }
    if (admission === "inadmissible") {
      // Not admitted, it leaves the transactionals over it: they go on with
      // their other parents, or lapse with none left (user's decision of
      // 2026-11-19).
      await settleTransactionalsOverInadmissible(
        tx,
        ctx,
        dependents,
        lockedAll,
        locked
          .filter((row) => row.status === "submitted")
          .map((row) => ({ id: row.id, code: row.code })),
      );
    }
    if (readmitting.length > 0) {
      // Admitted again: what declaring it inadmissible closed comes back.
      await restoreDependents(
        tx,
        ctx,
        sourceMap,
        lockedAll,
        restoreParties,
        locked.filter((row) => row.status === "inadmissible"),
        { admission: "admitted" },
      );
    }
    if (admission === "admitted") {
      // Late parents of a transactional already in force are replaced by it
      // now, before anything else could decide them on their own.
      await replaceAdmittedInForce(
        tx,
        ctx,
        sourceMap,
        lockedAll,
        restoreParties,
        locked.filter((row) => row.status === "submitted"),
      );
      // A formal one nobody answered yet is answered by itself, and under
      // "incorporate" the accepted ones go into the text now.
      await autoAcceptFormal(tx, ctx, {
        ids: body.amendmentIds,
        lockedIds: lockedAll.map((row) => row.id),
        sourceMap,
        parties: restoreParties,
        rule,
        voted: false,
      });
      await incorporateOnAdmission(tx, ctx, {
        ids: body.amendmentIds,
        lockedIds: lockedAll.map((row) => row.id),
        sourceMap,
        rule,
        voted: false,
      });
    }
    // On screen only from the console that controls the projection
    // (user's decision of 2026-11-19): one recorded from Validación or the
    // amendment's page leaves it where it is.
    if (voteRow && options.controlsProjection) {
      await pointLiveVote(tx, {
        assemblyId: ctx.assembly.id,
        voteId: voteRow.id,
        actor,
      });
    }

    return { decision: decision!, voteRow };
  });

  return {
    decision: {
      id: result.decision.id,
      kind: result.decision.kind,
      method: result.decision.method,
      subjectIds: result.decision.subjectIds,
      note: result.decision.note,
      vote: result.voteRow ? toVoteDto(result.voteRow) : null,
      decidedAt: result.decision.decidedAt.toISOString(),
    },
    admission,
    amendmentIds: body.amendmentIds,
  };
}

// Validation by the Secretaría -------------------------------------------------

function assertReviewer(actor: Actor): void {
  if (!canReviewAmendments(actor)) {
    fail(403, "No tienes permiso para revisar enmiendas");
  }
}

/** Every requested id must name an amendment of this document. */
async function assertDocumentAmendments(
  documentId: string,
  ids: string[],
): Promise<void> {
  const rows = await db
    .select({ id: amendments.id })
    .from(amendments)
    .where(
      and(eq(amendments.documentId, documentId), inArray(amendments.id, ids)),
    );
  if (rows.length !== ids.length) fail(404, "Enmienda no encontrada");
}

/**
 * The Secretaría validates presented amendments in bulk (amendment:review):
 * each one must still be submitted and not validated. An on-time amendment is
 * admitted at the same time; a late one keeps admission "pending" for the
 * Mesa. With `publish` they become visible to everyone at once; otherwise
 * they stay private until POST .../publish. A transactional is validated only
 * once its main authors accepted it, and is always published then
 * (publishOnValidation): it replaces what it groups, which must still be
 * open (replaceSources), and the other transactionals over those amendments
 * lapse. Two transactionals over the same amendment in one batch are
 * refused (409). A formal amendment it publishes is answered by itself
 * (autoAcceptFormal). Locks the document (share), then the amendments,
 * those sources and the other transactionals over them in id order, then
 * the acceptances, then the answers of the formal ones.
 */
export async function validateAmendments(
  ctx: DocumentAmendmentContext,
  body: ValidateAmendmentsBody,
): Promise<DocumentAmendmentsDto> {
  const { actor, document, now } = ctx;
  assertReviewer(actor);
  assertNotFinal(ctx);
  await assertDocumentAmendments(document.id, body.amendmentIds);

  await db.transaction(async (tx) => {
    const { rule } = await lockDocument(tx, document.id, "share");
    const sourceMap = await loadSourceMap(tx, document.id);
    // Both would replace the same amendment: one at a time, and the other
    // one is closed when the first replaces it.
    if (transactionalsShareSources(sourceMap, body.amendmentIds)) {
      fail(
        409,
        "Dos de estas transaccionales agrupan la misma enmienda: valida solo una. La otra se cerrará cuando la primera sustituya a esa enmienda",
      );
    }
    const sourceIds = unique(
      body.amendmentIds.flatMap((id) => sourceMap.get(id) ?? []),
    );
    const competitors: Competitors = {
      sourceMap,
      ids: unique(
        body.amendmentIds.flatMap((id) =>
          competingTransactionalIds(sourceMap, id, sourceMap.get(id) ?? []),
        ),
      ),
    };
    // The transactionals over the amendments themselves, which a formal
    // one's automatic acceptance would close (autoAcceptFormal; none
    // groups an amendment that was never published).
    const overIds = transactionalsOverIds(sourceMap, body.amendmentIds);
    // One ordered pass: the amendments, what the transactionals among them
    // replace and the other transactionals over those.
    const lockedById = new Map(
      (
        await lockAmendments(
          tx,
          document.id,
          unique([
            ...body.amendmentIds,
            ...sourceIds,
            ...competitors.ids,
            ...overIds,
          ]),
        )
      ).map((row) => [row.id, row]),
    );
    // Already locked by this transaction: the values are current.
    const locked = await tx
      .select({
        id: amendments.id,
        kind: amendments.kind,
        code: amendments.code,
        status: amendments.status,
        admission: amendments.admission,
        late: amendments.late,
        validatedAt: amendments.validatedAt,
      })
      .from(amendments)
      .where(
        and(
          eq(amendments.documentId, document.id),
          inArray(amendments.id, body.amendmentIds),
        ),
      );
    // The main authors' answers to a transactional, locked after the
    // amendments ("Row locks"), so a concurrent rejection cannot slip past
    // this check.
    const transactionalIds = locked
      .filter((row) => row.kind === "transactional")
      .map((row) => row.id);
    const partyIds = unique([...transactionalIds, ...overIds]);
    const partyRows =
      partyIds.length > 0 ? await lockParties(tx, partyIds, "share") : [];
    const rows = locked.map((row) => ({
      ...row,
      authorsApproval: authorsApproval({
        kind: row.kind,
        acceptances: partyRows.filter((party) => party.amendmentId === row.id),
      }),
    }));
    if (rows.some(awaitsAuthors)) fail(409, AWAITS_AUTHORS_MESSAGE);
    if (
      rows.length !== body.amendmentIds.length ||
      !rows.every(awaitsValidation)
    ) {
      fail(
        409,
        "Alguien ya ha revisado alguna de estas enmiendas. Recarga la página para ver cómo está",
      );
    }
    // Validating a transactional its main authors accepted makes it replace
    // what it groups, which must still be open.
    const sourcesOf = (id: string) =>
      (sourceMap.get(id) ?? [])
        .map((sourceId) => lockedById.get(sourceId))
        .filter((row) => row !== undefined);
    for (const row of rows) {
      if (row.kind !== "transactional") continue;
      const plan = sourcesToReplace(sourcesOf(row.id));
      if ("message" in plan) fail(409, plan.message);
    }

    // Grouped by what validation leaves: the admission (on time or late)
    // and the publication (a transactional is always published).
    const groups = new Map<
      string,
      { admission: AdmissionStatus; publish: boolean; ids: string[] }
    >();
    for (const row of rows) {
      const admission = admissionOnValidation(row);
      const publish = publishOnValidation(row, body.publish);
      const key = `${admission}:${publish}`;
      const group = groups.get(key) ?? { admission, publish, ids: [] };
      group.ids.push(row.id);
      groups.set(key, group);
    }
    const publishedCodes = new Map<string, string | null>();
    for (const { admission, publish, ids } of groups.values()) {
      const updated = await tx
        .update(amendments)
        .set({
          admission,
          validatedAt: now,
          validatedByUserId: actor.user.id,
          publishedAt: publish ? now : null,
        })
        .where(
          and(
            inArray(amendments.id, ids),
            eq(amendments.status, "submitted"),
            isNull(amendments.validatedAt),
          ),
        )
        .returning({ id: amendments.id });
      if (updated.length !== ids.length) {
        fail(409, "Las enmiendas han cambiado. Recarga la página");
      }
      // Numbered on presentation; one presented before that rule is numbered now (numberAmendments).
      if (publish) {
        for (const [id, code] of await numberAmendments(tx, document.id, ids)) {
          publishedCodes.set(id, code);
        }
      }
      for (const id of ids) {
        await recordEvent(tx, {
          assemblyId: ctx.assembly.id,
          documentId: document.id,
          entityType: "amendment",
          entityId: id,
          type: "amendment_validated",
          payload: {
            publish,
            admission,
            ...(admission === "admitted" ? { method: "secretaria" } : {}),
          },
          actor,
        });
      }
    }

    for (const row of rows) {
      if (row.kind !== "transactional") continue;
      await replaceSources(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        actor,
        now,
        transactional: {
          id: row.id,
          code: publishedCodes.get(row.id) ?? row.code,
        },
        sources: sourcesOf(row.id),
        competitors: lockedCompetitors(competitors, lockedById.values()),
      });
    }
    // A formal amendment answerable now (published, or validated when an
    // office of the CEA presents the document) is answered by itself.
    await autoAcceptFormal(tx, ctx, {
      ids: body.amendmentIds,
      lockedIds: [...lockedById.keys()],
      sourceMap,
      parties: partyRows,
      rule,
      voted: false,
    });
  });

  return listDocumentAmendments(ctx);
}

/**
 * The Secretaría makes validated amendments visible to everyone who can see
 * the document (amendment:review). Each one must be validated, past draft
 * and not published yet. Publishing only changes who sees the amendment, so
 * it is still allowed after the final vote: an amendment decided before it
 * was published can be shown afterwards. Before it, a formal amendment it
 * makes answerable is answered by itself (autoAcceptFormal). Locks the
 * document (share, voted or not), then the amendments with the
 * transactionals over them, then their acceptances and answers.
 */
export async function publishAmendments(
  ctx: DocumentAmendmentContext,
  body: PublishAmendmentsBody,
): Promise<DocumentAmendmentsDto> {
  const { actor, document, now } = ctx;
  assertReviewer(actor);
  await assertDocumentAmendments(document.id, body.amendmentIds);

  await db.transaction(async (tx) => {
    // Shared, before the amendments ("Row locks"): a final vote waits, and
    // tells whether a formal amendment published now is still answered.
    const documentRow = await lockDocumentRow(tx, document.id, "share");
    const sourceMap = await loadSourceMap(tx, document.id);
    const overIds = transactionalsOverIds(sourceMap, body.amendmentIds);
    const requested = new Set(body.amendmentIds);
    const lockedAll = await lockAmendments(
      tx,
      document.id,
      unique([...body.amendmentIds, ...overIds]),
    );
    const parties =
      overIds.length > 0 ? await lockParties(tx, overIds, "share") : [];
    const locked = lockedAll.filter((row) => requested.has(row.id));
    if (
      locked.length !== body.amendmentIds.length ||
      !locked.every(isAmendmentPublishable)
    ) {
      fail(409, "Alguna enmienda no está validada o ya está publicada");
    }
    const updated = await tx
      .update(amendments)
      .set({ publishedAt: now })
      .where(
        and(
          inArray(amendments.id, body.amendmentIds),
          isNotNull(amendments.validatedAt),
          isNull(amendments.publishedAt),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length !== body.amendmentIds.length) {
      fail(409, "Las enmiendas han cambiado. Recarga la página");
    }
    await numberAmendments(tx, document.id, body.amendmentIds);
    for (const id of body.amendmentIds) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        entityType: "amendment",
        entityId: id,
        type: "amendment_published",
        payload: {},
        actor,
      });
    }
    // A formal amendment answerable now is answered by itself, unless the
    // document was voted.
    await autoAcceptFormal(tx, ctx, {
      ids: body.amendmentIds,
      lockedIds: lockedAll.map((row) => row.id),
      sourceMap,
      parties,
      rule: documentRow.acceptedAmendments,
      voted: documentVoted(documentRow),
    });
  });

  return listDocumentAmendments(ctx);
}

/**
 * Accepts by itself, as it would have the moment it became answerable, every
 * formal amendment among `ids` of the document that can be answered now and
 * has no answer yet (autoAcceptFormal): for the ones that became answerable
 * before the automatic answer existed (backfillFormalAnswers). The same
 * locks as publishAmendments; `ctx.actor` is who made them answerable.
 */
export async function acceptAnswerableFormalAmendments(
  ctx: DocumentAmendmentContext,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const { document } = ctx;
  await db.transaction(async (tx) => {
    const documentRow = await lockDocumentRow(tx, document.id, "share");
    const sourceMap = await loadSourceMap(tx, document.id);
    const overIds = transactionalsOverIds(sourceMap, ids);
    const lockedAll = await lockAmendments(
      tx,
      document.id,
      unique([...ids, ...overIds]),
    );
    const parties =
      overIds.length > 0 ? await lockParties(tx, overIds, "share") : [];
    await autoAcceptFormal(tx, ctx, {
      ids,
      lockedIds: lockedAll.map((row) => row.id),
      sourceMap,
      parties,
      rule: documentRow.acceptedAmendments,
      voted: documentVoted(documentRow),
    });
  });
}

/**
 * What still keeps a validated amendment from going back to review, read
 * under the document lock: the Mesa has it on screen, or a pending
 * transactional builds on it (it builds only on published, admitted
 * amendments; it is closed or turned down first). Null when nothing does.
 */
async function assertValidationReopenable(
  tx: Executor,
  amendmentId: string,
  assemblyId: string,
): Promise<void> {
  // Under shareLockAssembly: PUT .../live-state (lockAssembly) waits, so
  // the projection never points at it once it stops being public.
  const [live] = await tx
    .select({
      amendmentId: liveState.amendmentId,
      amendmentBloc: liveState.amendmentBloc,
    })
    .from(liveState)
    .where(eq(liveState.assemblyId, assemblyId));
  // On its own or in the bloc on screen (user's decision of 2026-11-19).
  if (
    live?.amendmentId === amendmentId ||
    (live?.amendmentBloc ?? []).includes(amendmentId)
  ) {
    fail(409, "La Mesa la tiene en pantalla: quítala de la proyección antes", {
      messageKey: "amendment.validationUndo.errors.onScreen",
    });
  }
  // A transactional over it, whatever its state: one pending would build on
  // something no longer public, and one closed could come back over a text
  // that changed (transactionalsToRestore). Transactionals are created only
  // under the document lock NO KEY UPDATE, which waits for this share lock.
  const [grouped] = await tx
    .select({ id: amendmentSources.transactionalId })
    .from(amendmentSources)
    .where(eq(amendmentSources.sourceId, amendmentId))
    .limit(1);
  if (grouped) {
    fail(409, "Una transaccional la agrupa: ya no puede volver a revisión", {
      messageKey: "amendment.validationUndo.errors.transactional",
    });
  }
}

/** The presenter answers it again: back to pending, under the row lock. */
async function resetPosition(
  tx: Executor,
  amendmentId: string,
): Promise<boolean> {
  const reset = await tx
    .update(amendmentPositions)
    .set({ position: "pending", comment: null, decidedByUserId: null })
    .where(
      and(
        eq(amendmentPositions.amendmentId, amendmentId),
        ne(amendmentPositions.position, "pending"),
      ),
    )
    .returning({ amendmentId: amendmentPositions.amendmentId });
  return reset.length > 0;
}

/**
 * Takes back the validation of an amendment (validationReopenBlocker): it
 * stops being validated, published and admitted, so only its authors, the
 * Secretaría and the Mesa read it again, and the Secretaría has it to
 * review (amendment:review). `publishedAt` goes too, since nothing that is
 * not validated is public. The presenter's answer goes back to pending: it
 * answers once the amendment is public again, and an earlier acceptance
 * would otherwise skip the "incorporate" rule. Records
 * amendment_validation_undone with whether it was public and whether the
 * answer was reset. Optimistic lock on the amendment.
 */
export async function undoAmendmentValidation(
  ctx: AmendmentContext,
  body: UndoValidationBody,
): Promise<AmendmentDto> {
  const { actor, amendment } = ctx;
  assertReviewer(actor);
  assertNotFinal(ctx);
  if (ctx.assembly.status === "closed") fail(409, "La asamblea está cerrada");
  const blocker = validationReopenBlocker(amendment);
  if (blocker) fail(409, blocker);

  await db.transaction(async (tx) => {
    await shareLockAssembly(tx, ctx.assembly.id);
    await lockDocument(tx, ctx.document.id, "share");
    await assertValidationReopenable(tx, amendment.id, ctx.assembly.id);
    const updated = await tx
      .update(amendments)
      .set({
        validatedAt: null,
        validatedByUserId: null,
        publishedAt: null,
        admission: "pending",
      })
      .where(
        and(
          eq(amendments.id, amendment.id),
          eq(amendments.status, "submitted"),
          isNotNull(amendments.validatedAt),
          buildOptimisticLockCondition(amendments.updatedAt, body.updatedAt),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");
    const positionReset = await resetPosition(tx, amendment.id);
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_validation_undone",
      payload: {
        published: amendment.publishedAt !== null,
        ...(positionReset ? { positionReset: true } : {}),
      },
      actor,
    });
  });

  return amendmentDto(ctx, amendment.id);
}

/**
 * The Secretaría sends a presented amendment back to its authors
 * (amendment:review), with a note saying why it cannot go as it is: one it
 * has not validated yet, or one it validated, published or not, that is
 * still undecided (validationReopenBlocker). It returns to draft, keeps its
 * number, code and timing (see submitAmendment) and shows the note to its
 * authors until they present it again; they may also leave it, and a
 * draft never counts. A validated one also stops being validated,
 * published and admitted, and the presenter's answer goes back to
 * pending: the text may change. Optimistic lock on the amendment.
 */
export async function requestAmendmentCorrection(
  ctx: AmendmentContext,
  body: CorrectionBody,
): Promise<AmendmentDto> {
  const { actor, amendment, now } = ctx;
  assertReviewer(actor);
  const review = { ...amendment, authorsApproval: authorsApproval(amendment) };
  if (awaitsAuthors(review)) fail(409, AWAITS_AUTHORS_MESSAGE);
  const validated = amendment.validatedAt !== null;
  if (validated) {
    const blocker = validationReopenBlocker(amendment);
    if (blocker) fail(409, blocker);
    if (ctx.assembly.status === "closed") fail(409, "La asamblea está cerrada");
  } else if (!awaitsValidation(review)) {
    fail(
      409,
      "Solo se puede pedir una corrección de una enmienda presentada y sin decidir",
    );
  }
  assertNotFinal(ctx);

  await db.transaction(async (tx) => {
    if (validated) await shareLockAssembly(tx, ctx.assembly.id);
    await lockDocument(tx, ctx.document.id, "share");
    if (validated) {
      await assertValidationReopenable(tx, amendment.id, ctx.assembly.id);
    }
    const updated = await tx
      .update(amendments)
      .set({
        status: "draft",
        submittedAt: null,
        submittedByUserId: null,
        correctionNote: body.note,
        correctionRequestedAt: now,
        validatedAt: null,
        validatedByUserId: null,
        publishedAt: null,
        admission: "pending",
      })
      .where(
        and(
          eq(amendments.id, amendment.id),
          eq(amendments.status, "submitted"),
          validated
            ? isNotNull(amendments.validatedAt)
            : isNull(amendments.validatedAt),
          buildOptimisticLockCondition(amendments.updatedAt, body.updatedAt),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");
    // The text may change: the presenter answers it again once it is
    // back. Read under the row lock the update took, so an answer recorded
    // meanwhile is reset too.
    const positionReset = validated
      ? await resetPosition(tx, amendment.id)
      : false;
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_correction_requested",
      payload: {
        note: body.note,
        ...(validated
          ? {
              afterValidation: true,
              published: amendment.publishedAt !== null,
            }
          : {}),
        ...(positionReset ? { positionReset: true } : {}),
      },
      actor,
    });
  });

  return amendmentDto(ctx, amendment.id);
}

/**
 * The Secretaría declares an amendment not admitted while reviewing it,
 * when it cannot be corrected (user's decision of 2026-11-19: «¿Puede
 * corregirla?» «No», POST .../correction with `correctable: false`):
 * one waiting for its check, one it validated that can still go back to
 * review (not a late one: the assembly decides on those once validated), or
 * a draft it already sent back for a correction (reviewInadmissionCase).
 * It becomes `inadmissible` (status and admission), decided now, with the
 * note as its outcome note, which its authors read and, if it was public,
 * everyone who sees it. A `decisions` row records it (kind "inadmission",
 * method "secretaria"), and amendment_inadmissible says it came from the
 * review (`onReview`) with the note, so the email and the news say it
 * cannot be corrected. Its validation and publication stay as they were:
 * one never validated stays private and leaves the inbox. A returned draft
 * gets back the presentation its correction cleared (submittedAt and who
 * sent it, from its latest amendment_submitted), so a later readmission by
 * the Mesa has one. One validated has the presenter's answer reset, as a
 * correction does. The Mesa may readmit it (POST .../admission). Same locks
 * as requestAmendmentCorrection, and the optimistic lock on the amendment.
 */
export async function declareInadmissibleOnReview(
  ctx: AmendmentContext,
  body: CorrectionBody,
): Promise<AmendmentDto> {
  // Optional when it cannot be corrected (user's decision of 2026-11-20).
  const note = body.note.trim() || null;
  const { actor, amendment, now } = ctx;
  assertReviewer(actor);
  assertNotFinal(ctx);
  const footing = reviewInadmissionCase({
    ...amendment,
    authorsApproval: authorsApproval(amendment),
  });
  if (!footing) fail(409, REVIEW_INADMISSION_MESSAGE);
  const validated = footing === "validated";
  if (validated && ctx.assembly.status === "closed") {
    fail(409, "La asamblea está cerrada");
  }

  await db.transaction(async (tx) => {
    if (validated) await shareLockAssembly(tx, ctx.assembly.id);
    await lockDocument(tx, ctx.document.id, "share");
    if (validated) {
      await assertValidationReopenable(tx, amendment.id, ctx.assembly.id);
    }
    // A returned draft: its presentation as the latest one recorded it.
    const [presented] =
      footing === "returned"
        ? await tx
            .select({
              at: events.createdAt,
              userId: events.actorUserId,
            })
            .from(events)
            .where(
              and(
                eq(events.entityType, "amendment"),
                eq(events.entityId, amendment.id),
                eq(events.type, "amendment_submitted"),
              ),
            )
            .orderBy(desc(events.createdAt))
            .limit(1)
        : [];
    const updated = await tx
      .update(amendments)
      .set({
        status: "inadmissible",
        admission: "inadmissible",
        decidedAt: now,
        outcomeNote: note,
        ...(footing === "returned"
          ? {
              submittedAt: presented?.at ?? amendment.correctionRequestedAt,
              submittedByUserId: presented?.userId ?? null,
            }
          : {}),
      })
      .where(
        and(
          eq(amendments.id, amendment.id),
          footing === "returned"
            ? and(
                eq(amendments.status, "draft"),
                isNotNull(amendments.correctionRequestedAt),
              )
            : eq(amendments.status, "submitted"),
          validated
            ? isNotNull(amendments.validatedAt)
            : isNull(amendments.validatedAt),
          buildOptimisticLockCondition(amendments.updatedAt, body.updatedAt),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");
    const positionReset = validated
      ? await resetPosition(tx, amendment.id)
      : false;

    const decisionId = cuid();
    await tx.insert(decisions).values({
      id: decisionId,
      assemblyId: ctx.assembly.id,
      kind: "inadmission",
      method: "secretaria",
      voteId: null,
      subjectIds: [amendment.id],
      note: note,
      decidedByUserId: actor.user.id,
    });
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "decision",
      entityId: decisionId,
      type: "decision_recorded",
      payload: {
        kind: "inadmission",
        method: "secretaria",
        subjectIds: [amendment.id],
      },
      actor,
    });
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_inadmissible",
      payload: {
        decisionId,
        method: "secretaria",
        note: note,
        onReview: true,
        ...(validated
          ? {
              afterValidation: true,
              published: amendment.publishedAt !== null,
            }
          : {}),
        ...(footing === "returned" ? { afterCorrection: true } : {}),
        ...(positionReset ? { positionReset: true } : {}),
      },
      actor,
    });
  });

  return amendmentDto(ctx, amendment.id);
}

/**
 * The Secretaría (amendment:review; the Mesa alone cannot) moves a
 * presented, undecided amendment between "de forma" (`formal`) and the
 * content kind (`partial`): reclassifyTarget. One the main presenter's
 * acceptance incorporated still counts as undecided (canReclassifyAmendment).
 * Nothing else about it changes (operations, number, code, timing, review
 * state), except its answer (reclassifyPositionPlan): made formal while
 * answerable and unanswered, it is accepted by itself; made a content
 * amendment while its answer is still that automatic acceptance, the
 * answer goes back to pending, which reopens it if the acceptance had
 * incorporated it (recordPosition). An answer given by hand stays.
 * Optimistic lock on the amendment; the event carries both kinds. Locks
 * the document (share), then the amendment with the transactionals over
 * it and what they group (restoreLockIds), then their acceptances, then
 * its answer.
 */
export async function reclassifyAmendment(
  ctx: AmendmentContext,
  body: ReclassifyBody,
): Promise<AmendmentDto> {
  const { actor, amendment } = ctx;
  assertReviewer(actor);
  const from = amendment.kind;
  const to = reclassifyTarget(from);
  if (to === null) {
    fail(
      409,
      "Solo se puede cambiar entre enmienda de forma y enmienda de contenido",
    );
  }
  if (body.kind !== to) fail(409, "La enmienda ya es de ese tipo");
  if (!canReclassifyAmendment(amendment, false)) {
    fail(
      409,
      "Solo se puede cambiar el tipo de una enmienda presentada y sin decidir",
    );
  }
  assertNotFinal(ctx);

  await db.transaction(async (tx) => {
    const { rule } = await lockDocument(tx, ctx.document.id, "share");
    const sourceMap = await loadSourceMap(tx, ctx.document.id);
    const locked = await lockAmendments(
      tx,
      ctx.document.id,
      unique([amendment.id, ...restoreLockIds(sourceMap, [amendment.id])]),
    );
    const overIds = transactionalsOverIds(sourceMap, [amendment.id]);
    const parties =
      overIds.length > 0 ? await lockParties(tx, overIds, "share") : [];
    const stored = (await lockPositions(tx, [amendment.id])).get(amendment.id);
    const updated = await tx
      .update(amendments)
      .set({ kind: to })
      .where(
        and(
          eq(amendments.id, amendment.id),
          or(
            eq(amendments.status, "submitted"),
            and(
              eq(amendments.status, "approved"),
              eq(amendments.approvalMethod, "proponent"),
            ),
          ),
          eq(amendments.kind, from),
          buildOptimisticLockCondition(amendments.updatedAt, body.updatedAt),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_reclassified",
      payload: { from, to },
      actor,
    });

    const current = locked.find((row) => row.id === amendment.id);
    if (!current) fail(409, "La enmienda ha cambiado. Recarga la página");
    const position = stored?.position ?? null;
    const plan = reclassifyPositionPlan(
      { ...current, presenterSeesValidated: ctx.presenterSeesValidated },
      to,
      position,
      position === "accept"
        ? await latestPositionBy(tx, amendment.id)
        : undefined,
      rule,
    );
    if (plan) {
      await recordPosition(tx, ctx, {
        current: { ...current, kind: to },
        rule,
        position: plan,
        comment: null,
        by: "auto",
        sourceIds: [],
        competitors: { sourceMap, ids: overIds },
        locked,
        parties,
      });
    }
  });

  return amendmentDto(ctx, amendment.id);
}

/**
 * The Secretaría (amendment:review; the Mesa alone cannot) corrects who
 * presents a presented, undecided amendment or transactional, in case it
 * was presented wrong: the authors and the main author are replaced by the
 * ones the body names (docs/api.md, "Correcting who presents an
 * amendment").
 * - Members added must be active; an executive area is named by its real
 *   id (those who review amendments see the areas).
 * - The number in the document stays. The code follows the main author as
 *   when a corrected draft is presented again (numberingToKeep): kept while
 *   its prefix is the same (also from one area to another, both "CEA n"),
 *   otherwise the next of the new main author's sequence. A transactional
 *   keeps its "T n".
 * - The main author of an amendment is a party of the transactionals over
 *   it, so it cannot change while one of them is still open (409). That
 *   holds for a transactional too, which others may build on once it
 *   replaced its parents.
 * Optimistic lock on the amendment; the event carries the authors before
 * and after, and the codes when the code changes.
 */
export async function changeAmendmentAuthors(
  ctx: AmendmentContext,
  body: AmendmentAuthorsBody,
): Promise<AmendmentDto> {
  const { actor, amendment, document } = ctx;
  assertReviewer(actor);
  if (amendment.status !== "submitted") {
    fail(
      409,
      "Solo se puede cambiar quién presenta una enmienda presentada y sin decidir",
    );
  }
  assertNotFinal(ctx);

  const currentIds = amendment.authors.map((author) => author.memberId);
  const currentMain = loadedMainAuthor(amendment);
  // The generic "CEA" id is never a member (422 `executive_author`).
  await requireAmendmentBodyMembers(actor, {
    listed: body.authorMemberIds,
    named: body.mainAuthorMemberId,
  });
  const nextIds = unique(body.authorMemberIds);
  const nextMain = mainAuthorOrFail(
    pickMainAuthor(nextIds, body.mainAuthorMemberId),
  )!;
  const change = authorsChange({ currentIds, currentMain, nextIds, nextMain });
  if (!change) fail(422, "Quienes la presentan ya son esos");
  await assertMembers(change.added, true);

  const transactional = amendment.kind === "transactional";
  await db.transaction(async (tx) => {
    // Exclusive: a new code takes the next number of a member's sequence.
    await lockDocument(tx, document.id);
    if (change.mainChanged) {
      const [pending] = await tx
        .select({ id: amendments.id })
        .from(amendmentSources)
        .innerJoin(
          amendments,
          eq(amendments.id, amendmentSources.transactionalId),
        )
        .where(
          and(
            eq(amendmentSources.sourceId, amendment.id),
            inArray(amendments.status, ["draft", "submitted"]),
          ),
        )
        .limit(1);
      if (pending) {
        fail(
          409,
          "Hay una transaccional pendiente sobre esta enmienda y su autor principal tiene que aceptarla. Ciérrala antes de cambiar el autor principal",
        );
      }
    }

    // Only a new main author moves the code: with the same one it stays as
    // it was presented, also if the member's acronym changed since. The old
    // code stays taken (its `previousCode` is recorded below).
    let numbering: { memberSeq: number | null; code: string | null } | null =
      null;
    if (!transactional && change.mainChanged) {
      const prefix = (await codePrefixOf(tx, nextMain))!;
      const kept = numberingToKeep(amendment, prefix).memberSeq;
      if (kept !== null) {
        numbering = { memberSeq: kept, code: amendment.code };
      } else {
        // Its row before the numbering lock, the order presenting and
        // publishing take them in (numberAmendments), so they never wait
        // on each other.
        await lockAmendments(tx, document.id, [amendment.id]);
        await lockNumbering(tx, document.id);
        const memberSeq = await nextMemberSeq(tx, document.id, {
          prefix,
          returningAmendmentId: amendment.id,
        });
        numbering = { memberSeq, code: formatAmendmentCode(prefix, memberSeq) };
      }
    }
    const codeChanged = numbering !== null && numbering.code !== amendment.code;

    const updated = await tx
      .update(amendments)
      .set({
        ...(numbering ?? {}),
        meta: {
          ...readMeta(amendment),
          presentingMemberId: nextMain,
        } as StoredAmendmentMeta,
      })
      .where(
        and(
          eq(amendments.id, amendment.id),
          eq(amendments.status, "submitted"),
          buildOptimisticLockCondition(amendments.updatedAt, body.updatedAt),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");

    await tx
      .delete(amendmentAuthors)
      .where(eq(amendmentAuthors.amendmentId, amendment.id));
    await tx
      .insert(amendmentAuthors)
      .values(
        nextIds.map((memberId) => ({ amendmentId: amendment.id, memberId })),
      );

    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "amendment_authors_changed",
      // Member ids only: readers mask the executive areas
      // (redactPayloadMembers).
      payload: {
        from: {
          authorMemberIds: [...currentIds].sort(),
          mainAuthorId: currentMain,
        },
        to: { authorMemberIds: [...nextIds].sort(), mainAuthorId: nextMain },
        ...(codeChanged
          ? {
              ...(numbering!.code ? { code: numbering!.code } : {}),
              previousCode: amendment.code,
            }
          : {}),
      },
      actor,
    });
  });

  return amendmentDto(ctx, amendment.id);
}

// Position -------------------------------------------------------------------

/**
 * Who gave an answer (position_changed's `by`): the main presenter, the Mesa
 * on its behalf, or nobody ("auto": the acceptance a formal amendment gets
 * by itself, autoAcceptFormal, and its undoing when it stops being formal).
 */
type PositionBy = "proponent" | "moderator" | "auto";

/**
 * The stored answers of these amendments, locked for the change in id
 * order, after their amendment rows ("Row locks"). Missing rows read as
 * absent.
 */
async function lockPositions(
  tx: Tx,
  amendmentIds: string[],
): Promise<Map<string, { position: ProponentPosition; updatedAt: Date }>> {
  if (amendmentIds.length === 0) return new Map();
  const rows = await tx
    .select({
      amendmentId: amendmentPositions.amendmentId,
      position: amendmentPositions.position,
      updatedAt: amendmentPositions.updatedAt,
    })
    .from(amendmentPositions)
    .where(inArray(amendmentPositions.amendmentId, amendmentIds))
    .orderBy(asc(amendmentPositions.amendmentId))
    .for("no key update");
  return new Map(rows.map(({ amendmentId, ...row }) => [amendmentId, row]));
}

/**
 * Records the main presenter's answer and what it does under the document's
 * rule (positionEffect): under "incorporate" accepting approves an
 * undecided amendment (approval method "proponent"), with what a
 * transactional replaces and the pending transactionals over it closed, and
 * moving an amendment approved that way away from "accept" reopens it, with
 * what its incorporation closed brought back. The one path for an answer,
 * given by hand (setAmendmentPosition) or by itself (autoAcceptFormal,
 * reclassifyAmendment): the caller checked it may be given
 * (positionBlocker) and holds the document lock, the rows of `locked` (the
 * amendment, what a transactional groups, the transactionals over the
 * amendment and restoreLockIds, in one ordered pass), the acceptances of
 * those transactionals (`parties`) and the position row. `current` is the
 * amendment's row as it is now.
 */
async function recordPosition(
  tx: Tx,
  ctx: DocumentAmendmentContext,
  input: {
    current: LockedAmendment;
    rule: AcceptedAmendmentRule;
    position: ProponentPosition;
    comment: string | null;
    by: PositionBy;
    sourceIds: string[];
    competitors: Competitors;
    locked: LockedAmendment[];
    parties: Awaited<ReturnType<typeof lockParties>>;
  },
): Promise<void> {
  const { actor, document } = ctx;
  const { current } = input;
  const auto = input.by === "auto";
  const effect = positionEffect(current, input.position, input.rule);
  // Whose answer it is: the presenter the actor acts for (the main
  // presenter or a co-presenter), else the main presenter, for whom the
  // Mesa records it or the automatic answer is given.
  const answeredFor =
    input.by === "proponent" && actor.memberId
      ? actor.memberId
      : document.proponentMemberId;
  const values = {
    position: input.position,
    comment: input.comment,
    // The automatic answer keeps who made the amendment answerable (the
    // Secretaría or the Mesa); `by: "auto"` says nobody chose it.
    decidedByUserId: actor.user.id,
    updatedAt: new Date(),
  };
  await tx
    .insert(amendmentPositions)
    .values({ amendmentId: current.id, ...values })
    .onConflictDoUpdate({
      target: amendmentPositions.amendmentId,
      set: values,
    });
  const base = {
    assemblyId: ctx.assembly.id,
    documentId: document.id,
    entityType: "amendment" as const,
    entityId: current.id,
    actor,
  };
  await recordEvent(tx, {
    ...base,
    type: "position_changed",
    payload: {
      position: input.position,
      by: input.by,
      // Whose answer it is (`answeredFor`): the news of the other
      // presenters and of the authors name it, unless it is automatic.
      memberId: answeredFor,
    },
  });

  if (effect === "approve") {
    await incorporateAcceptance(tx, ctx, {
      current,
      auto,
      memberId: answeredFor,
      sourceIds: input.sourceIds,
      competitors: input.competitors,
      locked: input.locked,
    });
  } else if (effect === "reopen") {
    const updated = await tx
      .update(amendments)
      .set({
        status: "submitted",
        approvalMethod: null,
        outcomeNote: null,
        decidedAt: null,
      })
      .where(
        and(
          eq(amendments.id, current.id),
          eq(amendments.status, "approved"),
          eq(amendments.approvalMethod, "proponent"),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");
    await recordEvent(tx, {
      ...base,
      type: "amendment_reopened",
      payload: {
        previousStatus: "approved",
        reason: "position_changed",
        // The presenter whose new answer took it out (newsByMemberId).
        memberId: answeredFor,
        ...(auto ? { by: "auto" } : {}),
      },
    });
    // What its incorporation closed comes back.
    await restoreDependents(
      tx,
      ctx,
      input.competitors.sourceMap,
      input.locked,
      input.parties,
      [current],
    );
  } else if (effect === "reject") {
    // A formal amendment its main presenter rejects is not debated by
    // default (user's decision of 2026-11-20): rejected at once, with no
    // vote (rejectedByAnswer), and what waited on it closed. The Mesa may
    // reopen it to debate and vote it.
    const updated = await tx
      .update(amendments)
      .set({
        status: "rejected",
        approvalMethod: null,
        outcomeVoteId: null,
        outcomeNote: null,
        decidedAt: ctx.now,
      })
      .where(
        and(
          eq(amendments.id, current.id),
          eq(amendments.status, "submitted"),
          eq(amendments.admission, "admitted"),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");
    await recordEvent(tx, {
      ...base,
      type: "amendment_rejected",
      payload: {
        method: "proponent",
        byPosition: true,
        reason: "formal_rejected",
        memberId: answeredFor,
      },
    });
    await closeDependents(tx, ctx, input.competitors, input.locked, [
      { id: current.id, code: current.code, status: "rejected" },
    ]);
  } else if (effect === "reopen_rejected") {
    // Another answer to a formal amendment its rejection closed: it is
    // undecided again, with what that closed brought back; accepted under
    // "incorporate", it is incorporated as any acceptance.
    const updated = await tx
      .update(amendments)
      .set({ status: "submitted", outcomeNote: null, decidedAt: null })
      .where(
        and(
          eq(amendments.id, current.id),
          eq(amendments.status, "rejected"),
          eq(amendments.kind, "formal"),
          isNull(amendments.outcomeVoteId),
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");
    await recordEvent(tx, {
      ...base,
      type: "amendment_reopened",
      payload: {
        previousStatus: "rejected",
        reason: "position_changed",
        memberId: answeredFor,
      },
    });
    await restoreDependents(
      tx,
      ctx,
      input.competitors.sourceMap,
      input.locked,
      input.parties,
      [current],
    );
    await incorporateOnAdmission(tx, ctx, {
      ids: [current.id],
      lockedIds: input.locked.map((row) => row.id),
      sourceMap: input.competitors.sourceMap,
      rule: input.rule,
      voted: false,
    });
  }
}

/**
 * Approves an undecided, admitted amendment its main presenter accepted
 * under the "incorporate" rule (approval method "proponent"), with what a
 * transactional replaces and the pending transactionals over it closed:
 * the "approve" of positionEffect, from recordPosition or, for a late one
 * accepted before the assembly admitted it, from incorporateOnAdmission.
 * The caller holds the locks recordPosition names.
 */
async function incorporateAcceptance(
  tx: Tx,
  ctx: DocumentAmendmentContext,
  input: {
    current: LockedAmendment;
    /** The acceptance was the automatic one of a formal amendment. */
    auto: boolean;
    /** The presenter whose acceptance it is (position_changed's memberId). */
    memberId: string | null;
    sourceIds: string[];
    competitors: Competitors;
    locked: LockedAmendment[];
  },
): Promise<void> {
  const { actor, document, now } = ctx;
  const { current } = input;
  const updated = await tx
    .update(amendments)
    .set({
      status: "approved",
      approvalMethod: "proponent",
      outcomeVoteId: null,
      outcomeNote: null,
      decidedAt: now,
    })
    .where(
      and(
        eq(amendments.id, current.id),
        eq(amendments.status, "submitted"),
        eq(amendments.admission, "admitted"),
      ),
    )
    .returning({ id: amendments.id });
  if (updated.length === 0)
    fail(409, "La enmienda ha cambiado. Recarga la página");
  await recordEvent(tx, {
    assemblyId: ctx.assembly.id,
    documentId: document.id,
    entityType: "amendment",
    entityId: current.id,
    actor,
    type: "amendment_approved",
    // A presenter's acceptance incorporated it, also when the Mesa
    // recorded it (the news credit that presenter). The automatic one says
    // why (`reason: "formal"`) and credits nobody.
    payload: {
      method: "proponent",
      byPosition: true,
      memberId: input.memberId,
      ...(input.auto ? { reason: "formal" } : {}),
    },
  });
  if (input.sourceIds.length > 0) {
    await replaceSources(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      actor,
      now,
      transactional: { id: current.id, code: current.code },
      sources: input.locked.filter((row) => input.sourceIds.includes(row.id)),
      competitors: lockedCompetitors(input.competitors, input.locked),
      allowTransacted: true,
    });
  }
  await closeDependents(tx, ctx, input.competitors, input.locked, [
    { id: current.id, code: current.code, status: "approved" },
  ]);
}

/**
 * Under the "incorporate" rule, approves the amendments among `ids` that
 * have just become undecided and admitted with their main presenter's
 * acceptance already on record: the late ones the assembly has just
 * admitted (user's decision of 2026-11-17: a late one is answered once
 * validated, and the acceptance waits for the admission to incorporate it)
 * and one the Mesa has just reopened that keeps its acceptance. Never a
 * transactional. Same locks as autoAcceptFormal, which runs before it; the
 * position rows it locks are read here again.
 */
async function incorporateOnAdmission(
  tx: Tx,
  ctx: DocumentAmendmentContext,
  input: {
    ids: string[];
    lockedIds: string[];
    sourceMap: Map<string, string[]>;
    rule: AcceptedAmendmentRule;
    voted: boolean;
  },
): Promise<void> {
  if (input.voted || input.rule !== "incorporate" || input.ids.length === 0) {
    return;
  }
  const documentId = ctx.document.id;
  const lockedIds = unique([...input.ids, ...input.lockedIds]);
  const ids = [...input.ids].sort();
  const positions = await lockPositions(tx, ids);
  for (const id of ids) {
    if (positions.get(id)?.position !== "accept") continue;
    // Again for each one: an earlier approval may have closed
    // transactionals over the next.
    const locked = await rereadLocked(tx, documentId, lockedIds);
    const current = locked.find((row) => row.id === id);
    if (
      !current ||
      current.kind === "transactional" ||
      positionEffect(current, "accept", input.rule) !== "approve"
    ) {
      continue;
    }
    await incorporateAcceptance(tx, ctx, {
      current,
      ...(await latestPositionAnswer(tx, id, ctx.document.proponentMemberId)),
      sourceIds: [],
      competitors: {
        sourceMap: input.sourceMap,
        ids: transactionalsOverIds(input.sourceMap, [id]),
      },
      locked,
    });
  }
}

/**
 * Accepts by itself, as if its main presenter had, every formal amendment
 * among `ids` that has just become answerable with no answer yet
 * (shouldAutoAcceptPosition; docs/api.md, "The main presenter's answer"): the
 * position_changed says `by: "auto"`, and under the "incorporate" rule it
 * is approved at once like any acceptance (recordPosition). Runs at the
 * end of the transaction that made it answerable (a validation that
 * publishes, a publication, an admission, the Mesa's reopening), after
 * that path's own writes. The caller holds the document lock (`voted` and
 * `rule` read under it) and, in its one ordered pass, the rows of `ids`,
 * of the transactionals over them and of restoreLockIds (`lockedIds`),
 * then the acceptances of those transactionals (`parties`). The position
 * rows are locked here, last. Every row is read again first: the locked
 * snapshot predates the path's own changes.
 */
async function autoAcceptFormal(
  tx: Tx,
  ctx: DocumentAmendmentContext,
  input: {
    ids: string[];
    lockedIds: string[];
    sourceMap: Map<string, string[]>;
    parties: Awaited<ReturnType<typeof lockParties>>;
    rule: AcceptedAmendmentRule;
    voted: boolean;
  },
): Promise<void> {
  if (input.voted || input.ids.length === 0) return;
  const documentId = ctx.document.id;
  const lockedIds = unique([...input.ids, ...input.lockedIds]);
  const formalIds = (await rereadLocked(tx, documentId, input.ids))
    .filter((row) => row.kind === "formal")
    .map((row) => row.id)
    .sort();
  if (formalIds.length === 0) return;
  const positions = await lockPositions(tx, formalIds);
  for (const id of formalIds) {
    // Again for each one: an earlier acceptance may have closed
    // transactionals over the next.
    const locked = await rereadLocked(tx, documentId, lockedIds);
    const current = locked.find((row) => row.id === id);
    if (
      !current ||
      !shouldAutoAcceptPosition(
        { ...current, presenterSeesValidated: ctx.presenterSeesValidated },
        positions.get(id)?.position ?? null,
        input.rule,
      )
    ) {
      continue;
    }
    await recordPosition(tx, ctx, {
      current,
      rule: input.rule,
      position: "accept",
      comment: null,
      by: "auto",
      sourceIds: [],
      competitors: {
        sourceMap: input.sourceMap,
        ids: transactionalsOverIds(input.sourceMap, [id]),
      },
      locked,
      parties: input.parties,
    });
  }
}

/** The payload of the latest position_changed of an amendment, if any. */
async function latestPositionPayload(
  tx: Executor,
  amendmentId: string,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.entityType, "amendment"),
        eq(events.entityId, amendmentId),
        eq(events.type, "position_changed"),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(1);
  return row?.payload as Record<string, unknown> | undefined;
}

/**
 * The `by` of the latest position_changed of an amendment ("proponent",
 * "moderator", "auto"), or undefined when it has none.
 */
async function latestPositionBy(
  tx: Executor,
  amendmentId: string,
): Promise<unknown> {
  return (await latestPositionPayload(tx, amendmentId))?.by;
}

/**
 * Who gave the stored acceptance of an amendment, for its incorporation
 * once the assembly admits it: automatic or not, and the presenter it was
 * given for (the main presenter for answers recorded before it was named).
 */
async function latestPositionAnswer(
  tx: Executor,
  amendmentId: string,
  mainPresenterId: string | null,
): Promise<{ auto: boolean; memberId: string | null }> {
  const payload = await latestPositionPayload(tx, amendmentId);
  const memberId = payload?.memberId;
  return {
    auto: payload?.by === "auto",
    memberId: typeof memberId === "string" ? memberId : mainPresenterId,
  };
}

/**
 * The presenters' answer to an amendment, given by the main presenter or a
 * co-presenter (or by the Mesa, for them):
 * only once it is validated, published and, if late, admitted, and for a
 * transactional once its main authors accepted it (positionBlocker).
 * `positionUpdatedAt` is the optimistic lock on the stored answer. Under the
 * document's "incorporate" rule accepting approves the amendment at once
 * (approval method "proponent"), which closes the pending transactionals
 * over it, and moving away from "accept" reopens it (positionEffect,
 * recordPosition); after the final vote nothing changes. One the assembly
 * already approved (by a vote, by assent or as a formal one) can still be
 * answered until then (answerableAfterDecision, user's decision of
 * 2026-11-19): only the answer and its position_changed are recorded, the
 * approval stays. The automatic acceptance of a formal amendment changes
 * here like any other answer.
 */
export async function setAmendmentPosition(
  ctx: AmendmentContext,
  body: PositionBody,
): Promise<AmendmentDto> {
  const { actor, amendment, document } = ctx;
  if (!ctx.isPresenter && !canModerate(actor)) {
    fail(
      403,
      "Solo quienes presentan el documento o la Mesa pueden responder a las enmiendas",
    );
  }
  assertNotFinal(ctx);
  const blocker = positionBlocker(
    {
      ...amendment,
      authorsApproval: authorsApproval(amendment),
      presenterSeesValidated: ctx.presenterSeesValidated,
    },
    ctx.rule,
  );
  if (blocker) fail(409, POSITION_BLOCKER_MESSAGES[blocker]);
  const sourceIds =
    amendment.kind === "transactional"
      ? amendment.sources.map((source) => source.sourceId)
      : [];

  await db.transaction(async (tx) => {
    await lockDocument(tx, document.id, "share");
    // The amendment (and what a transactional replaces, with the other
    // transactionals over that or over the amendment itself, which its
    // incorporation closes and taking it out again brings back, with what
    // those group) in one ordered pass, then the parties and its answer:
    // the checks above, again under lock.
    const competitors = await findCompetitors(tx, document.id, amendment.id, [
      amendment.id,
      ...sourceIds,
    ]);
    const locked = await lockAmendments(
      tx,
      document.id,
      unique([
        amendment.id,
        ...sourceIds,
        ...competitors.ids,
        ...restoreLockIds(competitors.sourceMap, [amendment.id]),
      ]),
    );
    const current = locked.find((row) => row.id === amendment.id);
    if (!current) fail(404, "Enmienda no encontrada");
    const partyIds = unique([
      ...(amendment.kind === "transactional" ? [amendment.id] : []),
      ...transactionalsOverIds(competitors.sourceMap, [amendment.id]),
    ]);
    const parties =
      partyIds.length > 0 ? await lockParties(tx, partyIds, "share") : [];
    const fields = {
      ...current,
      presenterSeesValidated: ctx.presenterSeesValidated,
      authorsApproval: authorsApproval({
        kind: amendment.kind,
        acceptances: parties.filter(
          (party) => party.amendmentId === amendment.id,
        ),
      }),
    };
    const lockedBlocker = positionBlocker(fields, ctx.rule);
    if (lockedBlocker) fail(409, POSITION_BLOCKER_MESSAGES[lockedBlocker]);
    // Accepted under `incorporate`, a transactional is approved at once: not
    // while a parent still waits for the assembly's admission.
    if (
      amendment.kind === "transactional" &&
      ctx.rule === "incorporate" &&
      body.position === "accept" &&
      sourcesAwaitAdmission(locked.filter((row) => sourceIds.includes(row.id)))
    ) {
      fail(409, AWAITS_ADMISSION_MESSAGE);
    }

    const stored = (await lockPositions(tx, [amendment.id])).get(amendment.id);
    if (
      body.positionUpdatedAt !== undefined &&
      getOptimisticLockTimestampMs(stored?.updatedAt ?? null) !==
        getOptimisticLockTimestampMs(body.positionUpdatedAt)
    ) {
      fail(
        409,
        "Alguien ha respondido a esta enmienda mientras tanto. Recarga la página para ver su respuesta",
      );
    }

    await recordPosition(tx, ctx, {
      current,
      rule: ctx.rule,
      position: body.position,
      comment: body.comment ?? null,
      by: ctx.isPresenter ? "proponent" : "moderator",
      sourceIds,
      competitors,
      locked,
      parties,
    });
  });

  return amendmentDto(ctx, amendment.id);
}

// Outcome --------------------------------------------------------------------

async function approvalWarnings(
  tx: Tx,
  documentId: string,
  target: { id: string; ops: AmendmentOp[] },
): Promise<ApprovalWarnings> {
  const approved = await tx
    .select({ id: amendments.id, ops: amendments.ops })
    .from(amendments)
    .where(
      and(
        eq(amendments.documentId, documentId),
        eq(amendments.status, "approved"),
        ne(amendments.id, target.id),
      ),
    );
  const links = await tx
    .select({
      fromId: amendmentRelations.fromId,
      toId: amendmentRelations.toId,
    })
    .from(amendmentRelations)
    .where(
      and(
        eq(amendmentRelations.kind, "incompatible"),
        or(
          eq(amendmentRelations.fromId, target.id),
          eq(amendmentRelations.toId, target.id),
        ),
      ),
    );
  const linkedIds = unique(
    links.map((link) => (link.fromId === target.id ? link.toId : link.fromId)),
  );
  const live =
    linkedIds.length > 0
      ? await tx
          .select({ id: amendments.id })
          .from(amendments)
          .where(
            and(
              inArray(amendments.id, linkedIds),
              inArray(amendments.status, ["submitted", "approved"]),
            ),
          )
      : [];
  return computeApprovalWarnings(
    target,
    approved,
    live.map((row) => row.id),
  );
}

/**
 * A bloc approved by assent in one request (POST .../amendments/assent;
 * user's decision of 2026-11-20): each amendment goes through the single
 * approval (applyAmendmentOutcome, its own transaction, checks and events)
 * in the order given, one after another, so the room's clients refetch
 * once for the whole bloc instead of once per amendment, as the console's
 * request after request made them do. One that cannot be approved (decided
 * meanwhile, changed since it was seen, hidden or of another document) is
 * left with the reason and the rest go on; anything but a client error
 * stops it.
 */
export async function applyBulkAssent(
  ctx: DocumentAmendmentContext,
  body: BulkAssentBody,
): Promise<BulkAssentDto> {
  if (!canRecordResults(ctx.actor)) {
    fail(403, "No tienes permiso para realizar esta acción");
  }
  assertSessionOpen(ctx.assembly.status);
  const results: AmendmentOutcomeDto[] = [];
  const failed: BulkAssentDto["failed"] = [];
  for (const item of body.items) {
    const amendment = await loadAmendment(db, item.id);
    if (
      !amendment ||
      amendment.documentId !== ctx.document.id ||
      !isVisible(ctx, amendment)
    ) {
      failed.push({ id: item.id, message: "Enmienda no encontrada" });
      continue;
    }
    try {
      results.push(
        await applyAmendmentOutcome(
          {
            ...ctx,
            amendment,
            isAuthor: isAmendmentAuthor(ctx.actor, amendment),
          },
          { action: "approve", method: "assent", updatedAt: item.updatedAt },
        ),
      );
    } catch (error) {
      if (!isError(error) || error.statusCode >= 500) throw error;
      failed.push({ id: item.id, message: error.message });
    }
  }
  return { results, failed };
}

export async function applyAmendmentOutcome(
  ctx: AmendmentContext,
  body: OutcomeBody,
  /**
   * The request comes from the session console that controls the
   * projection (controlsProjection): only then does a vote go on screen.
   */
  options: { controlsProjection?: boolean } = {},
): Promise<AmendmentOutcomeResult> {
  const { actor, amendment, document, now } = ctx;
  if (!canRecordResults(actor)) {
    fail(403, "No tienes permiso para realizar esta acción");
  }
  assertNotFinal(ctx);
  // The Mesa decides in the room: only while the session is open. Reopening
  // a decision recorded by mistake corrects the record and may wait.
  if (body.action !== "reopen") assertSessionOpen(ctx.assembly.status);
  // A vote goes on screen only from the console that controls the
  // projection, unless it says otherwise: one recorded from the control
  // sheet or another console leaves the projection where it is (user's
  // decisions of 2026-11-19).
  const projectVote =
    body.action === "vote" &&
    body.project !== false &&
    canModerate(actor) &&
    options.controlsProjection === true;
  const lock = buildOptimisticLockCondition(
    amendments.updatedAt,
    body.updatedAt,
  );
  const transactional = amendment.kind === "transactional";
  const sourceIds = transactional
    ? amendment.sources.map((source) => source.sourceId)
    : [];
  const base = {
    assemblyId: ctx.assembly.id,
    documentId: document.id,
    entityType: "amendment" as const,
    actor,
  };

  if (body.action === "approve" || body.action === "vote") {
    if (amendment.status !== "submitted")
      fail(409, "La enmienda ya está decidida");
    if (amendment.admission !== "admitted")
      fail(409, "La enmienda no está admitida");
    // Delegates cannot debate what they cannot read. Publication is never
    // undone, so this check holds without re-reading the row.
    if (!amendment.publishedAt) {
      fail(
        409,
        "La Secretaría tiene que publicar la enmienda antes de decidirla",
      );
    }
    // The members present come from the Mesa's latest headcount unless typed.
    const based =
      body.action === "vote"
        ? await withHeadcount(ctx.assembly.id, body.vote, ctx.settings)
        : null;
    // Absolute in a reform of the Estatutos or a regulation (RRI art. 65.5).
    const evaluated = based
      ? evaluateVoteInput(
          based.vote,
          ctx.settings,
          amendmentVoteMajority(document.kind),
        )
      : null;
    const approved =
      body.action === "approve" || evaluated?.outcome.result === "approved";

    const result = await db.transaction(async (tx) => {
      // A vote is projected: assembly before document ("Row locks").
      if (body.action === "vote") await shareLockAssembly(tx, ctx.assembly.id);
      // The projection takes the agenda item from the locked row: the share
      // lock holds off a move, but one may have committed since the resolve.
      const { agendaItemId } = await lockDocument(tx, document.id, "share");
      // The amendment and what a transactional replaces (with the other
      // transactionals over that or over the amendment itself, which the
      // decision closes), in one ordered pass.
      const competitors = await findCompetitors(tx, document.id, amendment.id, [
        amendment.id,
        ...sourceIds,
      ]);
      const locked = await lockAmendments(tx, document.id, [
        amendment.id,
        ...sourceIds,
        ...competitors.ids,
      ]);
      // A transactional is debated once it replaced what it groups: its
      // main authors accepted it (the Mesa's own wait for them in the room).
      if (transactional) {
        const parties = await lockParties(tx, [amendment.id], "share");
        if (
          authorsApproval({ kind: "transactional", acceptances: parties }) !==
          "accepted"
        ) {
          fail(409, AWAITS_AUTHORS_MESSAGE);
        }
        if (
          sourcesAwaitAdmission(
            locked.filter((row) => sourceIds.includes(row.id)),
          )
        ) {
          fail(409, AWAITS_ADMISSION_MESSAGE);
        }
      }

      let voteRow: VoteRow | undefined;
      if (based && evaluated) {
        [voteRow] = await tx
          .insert(votes)
          .values({
            assemblyId: ctx.assembly.id,
            subjectType: "amendment",
            subjectId: amendment.id,
            method: based.vote.method,
            ...voteCounts(based.vote),
            headcountId: based.headcountId,
            majority: evaluated.majority,
            result: evaluated.outcome.result,
            note: based.vote.note ?? null,
            recordedByUserId: actor.user.id,
          })
          .returning();
      }

      const updated = await tx
        .update(amendments)
        .set({
          status: approved ? "approved" : "rejected",
          approvalMethod: approved
            ? body.action === "approve"
              ? body.method
              : "vote"
            : null,
          outcomeVoteId: voteRow?.id ?? null,
          outcomeNote:
            body.action === "approve"
              ? (body.note ?? null)
              : (body.vote.note ?? null),
          decidedAt: now,
        })
        .where(
          and(
            eq(amendments.id, amendment.id),
            eq(amendments.status, "submitted"),
            eq(amendments.admission, "admitted"),
            lock,
          ),
        )
        .returning({ id: amendments.id });
      if (updated.length === 0)
        fail(409, "La enmienda ha cambiado. Recarga la página");

      if (voteRow) {
        await recordEvent(tx, {
          ...base,
          entityType: "vote",
          entityId: voteRow.id,
          type: "vote_recorded",
          payload: {
            subjectType: "amendment",
            subjectId: amendment.id,
            result: voteRow.result,
          },
        });
      }
      await recordEvent(tx, {
        ...base,
        entityId: amendment.id,
        type: approved ? "amendment_approved" : "amendment_rejected",
        payload: {
          method: approved
            ? body.action === "approve"
              ? body.method
              : "vote"
            : "vote",
          ...(voteRow
            ? {
                voteId: voteRow.id,
                inFavor: voteRow.inFavor,
                against: voteRow.against,
                abstentions: voteRow.abstentions,
                blank: voteRow.blank,
                invalid: voteRow.invalid,
                notCast: voteRow.notCast,
              }
            : {}),
        },
      });

      // Its sources were replaced when it took over. One presented under
      // the earlier rule replaced them only on approval: do it now, so a
      // source and its transactional never both end up approved.
      if (approved && sourceIds.length > 0) {
        await replaceSources(tx, {
          assemblyId: ctx.assembly.id,
          documentId: document.id,
          actor,
          now,
          transactional: { id: amendment.id, code: amendment.code },
          sources: locked.filter((row) => sourceIds.includes(row.id)),
          competitors: lockedCompetitors(competitors, locked),
          allowTransacted: true,
        });
      }
      await closeDependents(tx, ctx, competitors, locked, [
        {
          id: amendment.id,
          code: amendment.code,
          status: approved ? "approved" : "rejected",
        },
      ]);

      const warnings = approved
        ? await approvalWarnings(tx, document.id, amendment)
        : null;
      if (voteRow && projectVote) {
        await pointLiveVote(tx, {
          assemblyId: ctx.assembly.id,
          voteId: voteRow.id,
          actor,
          subject: {
            documentId: document.id,
            agendaItemId,
            amendmentId: amendment.id,
          },
        });
      }
      return { voteRow, warnings };
    });

    return {
      amendment: await amendmentDto(ctx, amendment.id),
      vote: result.voteRow ? toVoteDto(result.voteRow) : null,
      warnings: result.warnings,
    };
  }

  if (body.action === "withdraw" || body.action === "lapse") {
    if (amendment.status !== "submitted")
      fail(409, "La enmienda ya está decidida");
    // The Mesa settles only what is in the debate: validated by the
    // Secretaría and, if late, admitted by the assembly. An author can still
    // withdraw their own amendment through POST .../withdraw.
    if (amendment.admission !== "admitted") {
      fail(
        409,
        amendment.validatedAt === null
          ? "Secretaría aún no ha validado esta enmienda"
          : "Esta enmienda llegó fuera de plazo y la asamblea todavía no ha decidido si se trata",
      );
    }
    const status = body.action === "withdraw" ? "withdrawn" : "lapsed";
    await db.transaction(async (tx) => {
      await lockDocument(tx, document.id, "share");
      // The amendment and the transactionals over it, in one ordered pass:
      // settling it closes them.
      const dependents = await findCompetitors(tx, document.id, amendment.id, [
        amendment.id,
      ]);
      const locked = await lockAmendments(tx, document.id, [
        amendment.id,
        ...dependents.ids,
      ]);
      const updated = await tx
        .update(amendments)
        .set({ status, decidedAt: now, outcomeNote: body.note ?? null })
        .where(
          and(
            eq(amendments.id, amendment.id),
            eq(amendments.status, "submitted"),
            eq(amendments.admission, "admitted"),
            lock,
          ),
        )
        .returning({ id: amendments.id });
      if (updated.length === 0)
        fail(409, "La enmienda ha cambiado. Recarga la página");
      await recordEvent(tx, {
        ...base,
        entityId: amendment.id,
        type:
          body.action === "withdraw"
            ? "amendment_withdrawn"
            : "amendment_lapsed",
        payload: { by: "moderator" },
      });
      await closeDependents(tx, ctx, dependents, locked, [
        { id: amendment.id, code: amendment.code, status },
      ]);
    });
    return {
      amendment: await amendmentDto(ctx, amendment.id),
      vote: null,
      warnings: null,
    };
  }

  // reopen
  const reopenable: AmendmentStatus[] = [
    "approved",
    "rejected",
    "withdrawn",
    "lapsed",
  ];
  if (!reopenable.includes(amendment.status)) {
    fail(409, "Esta enmienda no se puede reabrir");
  }
  await db.transaction(async (tx) => {
    // The projection may stop showing the voided vote, which is only known
    // under the amendment lock: assembly before document ("Row locks").
    await shareLockAssembly(tx, ctx.assembly.id);
    const { rule } = await lockDocument(tx, document.id, "share");
    // The row also tells which vote this reopening voids. A transactional
    // keeps what it replaced: its sources stay transacted. One that never
    // replaced them needs them still open, and one a main author rejected
    // stays closed (transactionalReopenBlocker). With them, the
    // transactionals its settling closed and what those group: they come
    // back (restoreDependents).
    const dependents = await findCompetitors(tx, document.id, null, [
      amendment.id,
    ]);
    const locked = await lockAmendments(
      tx,
      document.id,
      unique([
        amendment.id,
        ...sourceIds,
        ...restoreLockIds(dependents.sourceMap, [amendment.id]),
      ]),
    );
    const current = locked.find((row) => row.id === amendment.id);
    if (!current) fail(409, "La enmienda ha cambiado. Recarga la página");
    const partyIds = unique([
      ...(transactional ? [amendment.id] : []),
      ...transactionalsOverIds(dependents.sourceMap, [amendment.id]),
    ]);
    const parties =
      partyIds.length > 0 ? await lockParties(tx, partyIds, "share") : [];
    if (transactional) {
      const blocker = transactionalReopenBlocker({
        kind: "transactional",
        validatedAt: current.validatedAt,
        authorsApproval: authorsApproval({
          kind: "transactional",
          acceptances: parties.filter(
            (party) => party.amendmentId === amendment.id,
          ),
        }),
        sources: locked.filter((row) => sourceIds.includes(row.id)),
      });
      if (blocker) fail(409, TRANSACTIONAL_REOPEN_MESSAGES[blocker]);
    }
    const updated = await tx
      .update(amendments)
      .set({
        status: "submitted",
        approvalMethod: null,
        outcomeVoteId: null,
        outcomeNote: body.note ?? null,
        decidedAt: null,
      })
      .where(
        and(
          eq(amendments.id, amendment.id),
          inArray(amendments.status, reopenable),
          lock,
        ),
      )
      .returning({ id: amendments.id });
    if (updated.length === 0)
      fail(409, "La enmienda ha cambiado. Recarga la página");
    await recordEvent(tx, {
      ...base,
      entityId: amendment.id,
      type: "amendment_reopened",
      payload: {
        previousStatus: current.status,
        ...(current.outcomeVoteId
          ? { voidedVoteId: current.outcomeVoteId }
          : {}),
      },
    });
    await restoreDependents(tx, ctx, dependents.sourceMap, locked, parties, [
      current,
    ]);
    // Undecided again and still unanswered: a formal one is answered by
    // itself (the transactionals over it are in restoreLockIds).
    await autoAcceptFormal(tx, ctx, {
      ids: [amendment.id],
      lockedIds: locked.map((row) => row.id),
      sourceMap: dependents.sourceMap,
      parties,
      rule,
      voted: false,
    });
    // Undecided again with its presenter's acceptance kept (given after
    // the assembly approved it, answerableAfterDecision, or under the
    // "vote" rule before the document moved to "incorporate"): under
    // "incorporate" an acceptance never leaves it undecided, so it is
    // incorporated again, as when accepted (positionEffect). Same locks as
    // autoAcceptFormal above; a transactional is left as it is.
    await incorporateOnAdmission(tx, ctx, {
      ids: [amendment.id],
      lockedIds: locked.map((row) => row.id),
      sourceMap: dependents.sourceMap,
      rule,
      voted: false,
    });

    await clearLiveVote(tx, {
      assemblyId: ctx.assembly.id,
      voteId: current.outcomeVoteId,
      actor,
    });
  });
  return {
    amendment: await amendmentDto(ctx, amendment.id),
    vote: null,
    warnings: null,
  };
}

// Transactionals -------------------------------------------------------------

/**
 * Whether the actor may propose a transactional: the Mesa always; a member,
 * when it is a party (`isParty`: it presents the document, or it is an
 * author of an original amendment the transactional combines, through any
 * transactional it combines); any member account that presents amendments
 * (amendment:create) only when the assembly opens it to anyone
 * (`transactionalProposers: "anyone"`; user's decision of 2026-11-20, the
 * default being only the parties). docs/design.md, "Transactionals".
 */
export function canProposeTransactional(input: {
  moderate: boolean;
  canCreate: boolean;
  actorMemberId: string | null;
  isParty: boolean;
  anyone: boolean;
}): boolean {
  if (input.moderate) return true;
  if (!input.actorMemberId) return false;
  if (input.isParty) return true;
  return input.anyone && input.canCreate;
}

/**
 * A transactional over published, undecided amendments of the document
 * (docs/design.md, "Transactionals"). Its parties are the main authors of
 * those amendments. Proposed by a member, it waits for every party to
 * accept it ("pending_authors"), then for the Secretaría's validation, and
 * then replaces them. Proposed by the Mesa, it is validated and published at
 * once and replaces them when their main authors accept it in the room.
 */
export async function createTransactionalAmendment(
  ctx: DocumentAmendmentContext,
  body: TransactionalBody,
): Promise<AmendmentDto> {
  const { actor, document, now } = ctx;
  assertAmendable(ctx);

  const sources = await findAmendments(
    db,
    and(
      eq(amendments.documentId, document.id),
      inArray(amendments.id, body.sourceIds),
    ),
  );
  if (
    sources.length !== body.sourceIds.length ||
    !sources.every((source) => isVisible(ctx, source))
  ) {
    fail(404, "Enmienda no encontrada");
  }
  // Reviewers and the Mesa also see unpublished amendments: a transactional
  // only builds on what everyone can read, and on a transactional only once
  // it replaced what it groups.
  const unopen = transactionalSourcesMessage(
    sources.map((source) => ({
      ...source,
      authorsApproval: authorsApproval(source),
    })),
  );
  if (unopen) fail(409, unopen);

  const sourceAuthorIds = unique(
    sources.flatMap((source) =>
      source.authors.map((author) => author.memberId),
    ),
  );
  // The parties come from the database, so proposing one over an office's
  // amendment needs nothing from the body. Its co-authors do: every
  // executive office is named by its real id, never by the generic "CEA"
  // one (422 `executive_author`).
  await requireAmendmentBodyMembers(actor, {
    listed: body.authorMemberIds,
    named: body.mainAuthorMemberId,
  });
  const moderate = canModerate(actor);
  const canCreate = actor.can(PERMISSION_KEYS.AMENDMENT_CREATE);
  // Presents amendments but acts for no member: tell it how to fix that.
  if (!moderate && canCreate && !actor.memberId) {
    fail(403, UNLINKED_ACCOUNT_MESSAGE);
  }
  if (
    !canProposeTransactional({
      moderate,
      canCreate,
      actorMemberId: actor.memberId,
      isParty:
        ctx.isPresenter ||
        actsFor(
          actor,
          (await originalAmendments(document.id, sources)).flatMap((row) =>
            row.authors.map((author) => author.memberId),
          ),
        ),
      anyone: ctx.settings.transactionalProposers === "anyone",
    })
  ) {
    fail(403, "No tienes permiso para proponer transaccionales");
  }

  let authorIds: string[];
  if (moderate) {
    authorIds = unique(
      body.authorMemberIds ?? (actor.memberId ? [actor.memberId] : []),
    );
  } else {
    // Co-authors among those involved: the authors of what it groups and
    // the document's main presenter.
    // Any executive area may also be named: see
    // unauthorizedTransactionalAuthors.
    authorIds = unique([
      ...(actor.memberId ? [actor.memberId] : []),
      ...(body.authorMemberIds ?? []),
    ]);
    if (
      unauthorizedTransactionalAuthors(authorIds, {
        actorMemberId: actor.memberId,
        currentAuthorIds: [],
        partyMemberIds: [
          ...sourceAuthorIds,
          document.proponentMemberId,
          ...document.coProponentMemberIds,
        ],
        executiveIds: body.authorMemberIds?.length
          ? await loadExecutiveMemberIds()
          : undefined,
      }).length > 0
    ) {
      fail(
        403,
        "Solo las partes de la transaccional pueden figurar como autoras",
      );
    }
  }
  await assertMembers(authorIds, false);
  const mainAuthorId = mainAuthorOrFail(
    pickMainAuthor(authorIds, body.mainAuthorMemberId),
  );

  const sourceMainAuthors = sources.map(loadedMainAuthor);
  const parties = buildAcceptanceParties(
    await originalMainAuthors(document.id, sources),
    actor.memberId,
  );
  const allAccepted = parties.every((party) => party.accepted);
  const submit = body.submit ?? true;
  // Proposed by the Mesa in session: validated, admitted and published at
  // once. Proposed by a member: presented, it waits for the main authors
  // ("pending_authors") and then for the Secretaría ("pending_validation").
  const instant = submit && moderate;
  const awaitingAuthors = submit && !instant && !allAccepted;
  const base = await loadBaseBlocks(document);

  const id = await db.transaction(async (tx) => {
    await lockDocument(tx, document.id);
    // The sources may have been decided since they were read. The other
    // transactionals over them are locked in the same pass: the Mesa's may
    // replace the sources at once and close those.
    const competitors = instant
      ? await findCompetitors(tx, document.id, null, body.sourceIds)
      : { sourceMap: new Map<string, string[]>(), ids: [] };
    const lockedSources = await lockOpenSources(
      tx,
      document.id,
      body.sourceIds,
      competitors.ids,
      true,
    );
    // The parties are the main authors read before the lock; the Secretaría
    // may have corrected one since (changeAmendmentAuthors, which takes the
    // same lock and would not have seen this transactional).
    const lockedMainAuthors = new Map(
      (
        await findAmendments(
          tx,
          and(
            eq(amendments.documentId, document.id),
            inArray(amendments.id, body.sourceIds),
          ),
        )
      ).map((source) => [source.id, loadedMainAuthor(source)]),
    );
    if (
      sources.some(
        (source, index) =>
          lockedMainAuthors.get(source.id) !== sourceMainAuthors[index],
      )
    ) {
      fail(
        409,
        "Ha cambiado quién presenta alguna de las enmiendas. Recarga la página",
      );
    }
    const { ops, errors } = prepareAmendmentOps({
      ops: body.ops,
      base,
      takenIds: await otherInsertedIds(tx, document.id),
    });
    assertValidOps(errors);
    // Images it inserts are this document's own.
    await assertOpImagesBelong(document.id, ops);

    const meta: StoredAmendmentMeta = mainAuthorId
      ? { presentingMemberId: mainAuthorId }
      : {};
    const [row] = await tx
      .insert(amendments)
      .values({
        documentId: document.id,
        baseVersionId: document.baseVersionId!,
        kind: "transactional",
        status: submit ? "submitted" : "draft",
        ...instantReview(instant, actor, now),
        late: false,
        ops,
        meta,
        justification: body.justification,
        positionKey: amendmentSortKey(ops, base),
        createdByUserId: actor.user.id,
        submittedByUserId: submit ? actor.user.id : null,
        submittedAt: submit ? now : null,
      })
      .returning({ id: amendments.id });
    const amendmentId = row!.id;
    // Its "T n" comes when it is presented (numberAmendments); a draft has
    // none until then.
    const code = submit
      ? ((await numberAmendments(tx, document.id, [amendmentId])).get(
          amendmentId,
        ) ?? null)
      : null;

    if (authorIds.length > 0) {
      await tx
        .insert(amendmentAuthors)
        .values(authorIds.map((memberId) => ({ amendmentId, memberId })));
    }
    await tx.insert(amendmentSources).values(
      body.sourceIds.map((sourceId) => ({
        transactionalId: amendmentId,
        sourceId,
      })),
    );
    if (parties.length > 0) {
      await tx.insert(amendmentAcceptances).values(
        parties.map((party) => ({
          amendmentId,
          memberId: party.memberId,
          role: party.role,
          decision: party.accepted
            ? ("accepted" as const)
            : ("pending" as const),
          decidedAt: party.accepted ? now : null,
          recordedByUserId: party.accepted ? actor.user.id : null,
        })),
      );
    }
    if (submit) {
      await tx
        .insert(amendmentPositions)
        .values({ amendmentId, position: "pending" })
        .onConflictDoNothing();
    }

    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "amendment",
      entityId: amendmentId,
      type: "amendment_created",
      payload: {
        kind: "transactional",
        code,
        sourceIds: body.sourceIds,
        authorMemberIds: authorIds,
        mainAuthorId,
      },
      actor,
    });
    if (submit) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        entityType: "amendment",
        entityId: amendmentId,
        type: "amendment_submitted",
        payload: {
          code,
          late: false,
          admission: instant ? "admitted" : "pending",
          ...(awaitingAuthors ? { awaitsAuthors: true } : {}),
        },
        actor,
      });
    }
    if (instant) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        entityType: "amendment",
        entityId: amendmentId,
        type: "amendment_validated",
        payload: { publish: true, admission: "admitted", method: "mesa" },
        actor,
      });
      // Nobody else to ask: it replaces its sources at once.
      if (allAccepted) {
        await replaceSources(tx, {
          assemblyId: ctx.assembly.id,
          documentId: document.id,
          actor,
          now,
          transactional: { id: amendmentId, code },
          sources: body.sourceIds.map((sourceId) =>
            lockedSources.get(sourceId)!,
          ),
          competitors: lockedCompetitors(competitors, lockedSources.values()),
        });
      }
    }
    return amendmentId;
  });

  return amendmentDto(ctx, id);
}

// Acceptance -----------------------------------------------------------------

/**
 * A party of a transactional (the main author of one of the amendments it
 * would replace) accepts or rejects it, or the Mesa records the answer it
 * gave in the room (`memberId`). The party is found by member.
 * - A party answers once (409 afterwards); the Mesa can correct an answer
 *   until the transactional replaced its sources, after which the answers
 *   are final.
 * - Any rejection closes it (withdrawn; who rejected it is in its
 *   acceptances and in the amendment_withdrawn event, never in the outcome
 *   note, which clients show as written): the originals carry on.
 * - Accepting needs every amendment it groups still open (409 otherwise):
 *   once one is decided or replaced by another transactional it can no
 *   longer go through.
 * - The last acceptance of a transactional already validated (the Mesa's,
 *   presented in session) makes it replace its sources (replaceSources).
 * Locks: document (share), the transactional, its sources and the other
 * transactionals over them in id order, then its acceptance rows; the
 * answers are read again under those locks, so two parties answering at
 * once both see the other's answer.
 */
export async function recordAmendmentAcceptance(
  ctx: AmendmentContext,
  body: AcceptanceBody,
): Promise<AmendmentDto> {
  const { actor, amendment, document, now } = ctx;
  if (amendment.kind !== "transactional") {
    fail(409, "Solo las transaccionales necesitan aceptación");
  }
  if (amendment.status !== "submitted") {
    fail(
      409,
      amendment.status === "draft"
        ? "La transaccional todavía no se ha presentado"
        : "La transaccional ya está decidida",
    );
  }
  assertNotFinal(ctx);

  const moderate = canModerate(actor);
  const memberId = body.memberId ?? actor.memberId;
  if (!memberId) fail(403, UNLINKED_ACCOUNT_MESSAGE);
  if (memberId !== actor.memberId && !moderate) {
    fail(403, "Solo la Mesa puede registrar la respuesta de otra parte");
  }
  const party = partiesOf(amendment).find(
    (acceptance) => acceptance.memberId === memberId,
  );
  if (!party) {
    fail(
      404,
      "Ese miembro no es autor principal de ninguna de las enmiendas que sustituye",
    );
  }
  if (party.decision !== "pending" && !moderate)
    fail(409, "Esta parte ya ha respondido");
  const sourceIds = amendment.sources.map((source) => source.sourceId);

  await db.transaction(async (tx) => {
    await lockDocument(tx, document.id, "share");
    // The transactional, its sources and the other transactionals over
    // them (which its replacing them closes), in one ordered pass.
    const competitors = await findCompetitors(
      tx,
      document.id,
      amendment.id,
      sourceIds,
    );
    const locked = await lockAmendments(tx, document.id, [
      amendment.id,
      ...sourceIds,
      ...competitors.ids,
    ]);
    const current = locked.find((row) => row.id === amendment.id);
    if (!current || current.status !== "submitted") {
      fail(409, "La transaccional ya está decidida");
    }
    const parties = (
      await lockParties(tx, [amendment.id], "no key update")
    ).filter((row) => row.role === "author");
    // Once it replaced what it groups, the originals are gone: the answers
    // that made it happen cannot change any more.
    if (
      current.validatedAt !== null &&
      authorsApproval({ kind: "transactional", acceptances: parties }) ===
        "accepted"
    ) {
      fail(
        409,
        "Esta transaccional ya sustituye a las enmiendas que agrupa: las respuestas ya no se pueden cambiar",
      );
    }
    const row = parties.find((item) => item.memberId === memberId);
    if (!row) fail(409, "Las respuestas han cambiado. Recarga la página");
    if (row.decision !== "pending" && !moderate)
      fail(409, "Esta parte ya ha respondido");
    // Accepting only makes sense while what it groups is still open: one of
    // them decided, or replaced by another transactional, means it can no
    // longer go through. Rejecting it is always possible.
    const sources = locked.filter((item) => sourceIds.includes(item.id));
    if (
      body.decision === "accepted" &&
      (sources.length !== sourceIds.length || !sourcesAreOpen(sources))
    ) {
      fail(409, CLOSED_SOURCES_MESSAGE);
    }

    await tx
      .update(amendmentAcceptances)
      .set({
        decision: body.decision,
        decidedAt: now,
        recordedByUserId: actor.user.id,
      })
      .where(eq(amendmentAcceptances.id, row.id));
    const base = {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "amendment" as const,
      entityId: amendment.id,
      actor,
    };
    await recordEvent(tx, {
      ...base,
      type: "acceptance_recorded",
      payload: {
        memberId,
        role: row.role,
        decision: body.decision,
        ...(memberId !== actor.memberId
          ? { recordedForMemberId: memberId }
          : {}),
      },
    });

    const after = authorsApproval({
      kind: "transactional",
      acceptances: parties.map((item) =>
        item.id === row.id ? { ...item, decision: body.decision } : item,
      ),
    });
    if (after === "rejected") {
      // Any rejection closes it: the originals carry on.
      // Who rejected it is in its acceptances and in the event: the
      // outcome note stays for the Mesa's own words.
      const updated = await tx
        .update(amendments)
        .set({ status: "withdrawn", decidedAt: now, outcomeNote: null })
        .where(
          and(
            eq(amendments.id, amendment.id),
            eq(amendments.status, "submitted"),
          ),
        )
        .returning({ id: amendments.id });
      if (updated.length === 0) fail(409, "La transaccional ya está decidida");
      await recordEvent(tx, {
        ...base,
        type: "amendment_withdrawn",
        payload: { by: "author_rejection", memberId },
      });
    } else if (after === "accepted" && current.validatedAt !== null) {
      await replaceSources(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        actor,
        now,
        transactional: { id: amendment.id, code: amendment.code },
        sources,
        competitors: lockedCompetitors(competitors, locked),
      });
    }
  });

  return amendmentDto(ctx, amendment.id);
}

// Inclusions in a transactional (revisions) ----------------------------------

/** Statuses of an inclusion still waiting for someone. */
const OPEN_REVISION_STATUSES = [
  "pending_parties",
  "pending_validation",
] as const;

type RevisionRow = typeof transactionalRevisions.$inferSelect;

/**
 * Who may propose including amendments in an existing transactional (user's
 * decision of 2026-11-19): its main author (who proposed it), the Mesa and
 * the Secretaría (amendment:review).
 */
export function canReviseTransactional(input: {
  moderate: boolean;
  review: boolean;
  actsForMainAuthor: boolean;
}): boolean {
  return input.moderate || input.review || input.actsForMainAuthor;
}

/**
 * Where an inclusion goes once every party answered: any rejection leaves
 * the transactional as it was (`rejected`); all accepted, the Mesa's or the
 * Secretaría's is applied at once (`apply`), a member's waits for the
 * Secretaría (`validation`); otherwise it keeps waiting (`wait`).
 */
export function revisionAfterAnswers(
  decisions: readonly AcceptanceDecision[],
  staffProposed: boolean,
): "rejected" | "apply" | "validation" | "wait" {
  if (decisions.includes("rejected")) return "rejected";
  if (decisions.some((decision) => decision === "pending")) return "wait";
  return staffProposed ? "apply" : "validation";
}

function lockRevision(tx: Tx, transactionalId: string, revisionId: string) {
  return tx
    .select()
    .from(transactionalRevisions)
    .where(
      and(
        eq(transactionalRevisions.id, revisionId),
        eq(transactionalRevisions.transactionalId, transactionalId),
      ),
    )
    .for("update");
}

function lockRevisionParties(tx: Tx, revisionId: string) {
  return tx
    .select()
    .from(transactionalRevisionAcceptances)
    .where(eq(transactionalRevisionAcceptances.revisionId, revisionId))
    .orderBy(asc(transactionalRevisionAcceptances.id))
    .for("no key update");
}

/**
 * The transactional, its parents (current and added) and the other
 * transactionals over them, in one ordered pass, after the document lock;
 * then its acceptances. What applying an inclusion needs locked.
 */
async function lockForRevision(
  tx: Tx,
  ctx: AmendmentContext,
  addedSourceIds: readonly string[],
) {
  const { amendment, document } = ctx;
  await lockDocument(tx, document.id, "share");
  const parentIds = unique([
    ...amendment.sources.map((source) => source.sourceId),
    ...addedSourceIds,
  ]);
  const competitors = await findCompetitors(
    tx,
    document.id,
    amendment.id,
    parentIds,
  );
  const locked = await lockAmendments(tx, document.id, [
    amendment.id,
    ...parentIds,
    ...competitors.ids,
  ]);
  const current = locked.find((row) => row.id === amendment.id);
  if (!current || current.status !== "submitted") {
    fail(409, "La transaccional ya está decidida");
  }
  const parties = (
    await lockParties(tx, [amendment.id], "no key update")
  ).filter((row) => row.role === "author");
  return { competitors, locked, current, parties };
}

/**
 * Applies an inclusion every party accepted: the transactional takes its
 * new text and parents, the main authors it adds become parties (accepted),
 * and, when the transactional is already in force (validated and accepted),
 * it replaces the parents it adds now (replaceSources; a late one awaiting
 * the assembly stays linked, isPendingLateSource).
 */
async function applyRevision(
  tx: Tx,
  ctx: AmendmentContext,
  revision: RevisionRow,
  locks: Awaited<ReturnType<typeof lockForRevision>>,
  revisionParties: { memberId: string }[],
): Promise<void> {
  const { actor, amendment, document, now } = ctx;
  const added = revision.addedSourceIds;
  const addedRows = locks.locked.filter((row) => added.includes(row.id));
  if (addedRows.length !== added.length || !sourcesAreOpen(addedRows)) {
    fail(409, CLOSED_SOURCES_MESSAGE);
  }
  const base = await loadBaseBlocks(document);
  await tx
    .update(amendments)
    .set({
      ops: revision.ops,
      justification: revision.justification,
      positionKey: amendmentSortKey(revision.ops, base),
    })
    .where(eq(amendments.id, amendment.id));
  if (added.length > 0) {
    await tx
      .insert(amendmentSources)
      .values(
        added.map((sourceId) => ({ transactionalId: amendment.id, sourceId })),
      )
      .onConflictDoNothing();
  }
  const known = new Set(locks.parties.map((party) => party.memberId));
  const joining = revisionParties.filter((party) => !known.has(party.memberId));
  if (joining.length > 0) {
    await tx.insert(amendmentAcceptances).values(
      joining.map((party) => ({
        amendmentId: amendment.id,
        memberId: party.memberId,
        role: "author" as const,
        decision: "accepted" as const,
        decidedAt: now,
        recordedByUserId: actor.user.id,
      })),
    );
  }
  const inForce =
    locks.current.validatedAt !== null &&
    authorsApproval({
      kind: "transactional",
      acceptances: locks.parties,
    }) === "accepted";
  if (inForce && addedRows.length > 0) {
    await replaceSources(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      actor,
      now,
      transactional: { id: amendment.id, code: amendment.code },
      sources: addedRows,
      competitors: lockedCompetitors(locks.competitors, locks.locked),
    });
  }
  await tx
    .update(transactionalRevisions)
    .set({ status: "applied", decidedAt: now })
    .where(eq(transactionalRevisions.id, revision.id));
  await recordEvent(tx, {
    assemblyId: ctx.assembly.id,
    documentId: document.id,
    entityType: "amendment",
    entityId: amendment.id,
    type: "transactional_revision_applied",
    payload: {
      revisionId: revision.id,
      addedSourceIds: added,
      addedCodes: addedRows.map((row) => row.code),
    },
    actor,
  });
}

/**
 * Settles an inclusion after an answer or its proposal: rejected, applied,
 * or on to the Secretaría, as revisionAfterAnswers says.
 */
async function settleRevision(
  tx: Tx,
  ctx: AmendmentContext,
  revision: RevisionRow,
  locks: Awaited<ReturnType<typeof lockForRevision>>,
  parties: { memberId: string; decision: AcceptanceDecision }[],
): Promise<void> {
  const next = revisionAfterAnswers(
    parties.map((party) => party.decision),
    revision.staffProposed,
  );
  const base = {
    assemblyId: ctx.assembly.id,
    documentId: ctx.document.id,
    entityType: "amendment" as const,
    entityId: ctx.amendment.id,
    actor: ctx.actor,
  };
  if (next === "rejected") {
    await tx
      .update(transactionalRevisions)
      .set({ status: "rejected", decidedAt: ctx.now })
      .where(eq(transactionalRevisions.id, revision.id));
    await recordEvent(tx, {
      ...base,
      type: "transactional_revision_rejected",
      payload: { revisionId: revision.id },
    });
  } else if (next === "apply") {
    await applyRevision(tx, ctx, revision, locks, parties);
  } else if (next === "validation" && revision.status === "pending_parties") {
    await tx
      .update(transactionalRevisions)
      .set({ status: "pending_validation" })
      .where(eq(transactionalRevisions.id, revision.id));
    await recordEvent(tx, {
      ...base,
      type: "transactional_revision_ready",
      payload: { revisionId: revision.id },
    });
  }
}

/**
 * Proposes including amendments in an existing transactional, with its new
 * text (user's decision of 2026-11-19). Every party of the new version (the
 * main authors of its parents, old and added) answers it; the proposer's
 * member is accepted from the start. Until it is applied the transactional
 * stays as it is.
 */
export async function proposeTransactionalRevision(
  ctx: AmendmentContext,
  body: TransactionalRevisionBody,
): Promise<AmendmentDto> {
  const { actor, amendment, document, now } = ctx;
  if (amendment.kind !== "transactional") {
    fail(409, "Solo se pueden incluir enmiendas en una transaccional");
  }
  if (amendment.status !== "submitted") {
    fail(409, "La transaccional ya está decidida");
  }
  assertAmendable(ctx);
  const moderate = canModerate(actor);
  const review = canReviewAmendments(actor);
  const mainAuthor = loadedMainAuthor(amendment);
  if (
    !canReviseTransactional({
      moderate,
      review,
      actsForMainAuthor: !!mainAuthor && actsFor(actor, [mainAuthor]),
    })
  ) {
    fail(403, "No tienes permiso para incluir enmiendas en esta transaccional");
  }
  const currentIds = amendment.sources.map((source) => source.sourceId);
  const added = unique(body.addSourceIds).filter(
    (id) => id !== amendment.id && !currentIds.includes(id),
  );
  if (added.length === 0) {
    fail(422, "Elige al menos una enmienda que todavía no agrupe");
  }
  const [addedRows, currentRows] = await Promise.all([
    findAmendments(
      db,
      and(
        eq(amendments.documentId, document.id),
        inArray(amendments.id, added),
      ),
    ),
    currentIds.length > 0
      ? findAmendments(db, inArray(amendments.id, currentIds))
      : Promise.resolve([]),
  ]);
  if (
    addedRows.length !== added.length ||
    !addedRows.every((row) => isVisible(ctx, row))
  ) {
    fail(404, "Enmienda no encontrada");
  }
  const unopen = transactionalSourcesMessage(
    addedRows.map((row) => ({ ...row, authorsApproval: authorsApproval(row) })),
  );
  if (unopen) fail(409, unopen);
  const parties = buildAcceptanceParties(
    await originalMainAuthors(document.id, [...currentRows, ...addedRows]),
    moderate || review ? null : actor.memberId,
  );
  const staffProposed = moderate || review;

  await db.transaction(async (tx) => {
    const locks = await lockForRevision(tx, ctx, added);
    const [open] = await tx
      .select({ id: transactionalRevisions.id })
      .from(transactionalRevisions)
      .where(
        and(
          eq(transactionalRevisions.transactionalId, amendment.id),
          inArray(transactionalRevisions.status, [...OPEN_REVISION_STATUSES]),
        ),
      )
      .for("update");
    if (open) {
      fail(
        409,
        "Ya hay una inclusión pendiente en esta transaccional: espera a que se resuelva o retírala",
      );
    }
    const addedLocked = locks.locked.filter((row) => added.includes(row.id));
    if (addedLocked.length !== added.length || !sourcesAreOpen(addedLocked)) {
      fail(409, CLOSED_SOURCES_MESSAGE);
    }
    const base = await loadBaseBlocks(document);
    const { ops, errors } = prepareAmendmentOps({
      ops: body.ops,
      base,
      takenIds: await otherInsertedIds(tx, document.id, amendment.id),
    });
    assertValidOps(errors);
    await assertOpImagesBelong(document.id, ops);

    const [revision] = await tx
      .insert(transactionalRevisions)
      .values({
        transactionalId: amendment.id,
        proposedByUserId: actor.user.id,
        proposedAsMemberId: staffProposed ? null : actor.memberId,
        staffProposed,
        addedSourceIds: added,
        ops,
        justification: body.justification,
      })
      .returning();
    const rows = parties.map((party) => ({
      revisionId: revision!.id,
      memberId: party.memberId,
      decision: party.accepted ? ("accepted" as const) : ("pending" as const),
      decidedAt: party.accepted ? now : null,
      recordedByUserId: party.accepted ? actor.user.id : null,
    }));
    if (rows.length > 0) {
      await tx.insert(transactionalRevisionAcceptances).values(rows);
    }
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "transactional_revision_proposed",
      payload: {
        revisionId: revision!.id,
        addedSourceIds: added,
        addedCodes: addedLocked.map((row) => row.code),
        // For the notices only (rules.ts): never an activity key.
        pendingMemberIds: rows
          .filter((row) => row.decision === "pending")
          .map((row) => row.memberId),
      },
      actor,
    });
    await settleRevision(tx, ctx, revision!, locks, rows);
  });

  return amendmentDto(ctx, amendment.id);
}

/**
 * A party answers an inclusion, or the Mesa records the answer it gave in
 * the room (`memberId`), as recordAmendmentAcceptance does for the
 * transactional itself. Any rejection leaves the transactional as it was.
 */
export async function answerTransactionalRevision(
  ctx: AmendmentContext,
  revisionId: string,
  body: AcceptanceBody,
): Promise<AmendmentDto> {
  const { actor, amendment, now } = ctx;
  assertNotFinal(ctx);
  const moderate = canModerate(actor);
  const memberId = body.memberId ?? actor.memberId;
  if (!memberId) fail(403, UNLINKED_ACCOUNT_MESSAGE);
  if (memberId !== actor.memberId && !moderate) {
    fail(403, "Solo la Mesa puede registrar la respuesta de otra parte");
  }

  await db.transaction(async (tx) => {
    const [revision] = await lockRevision(tx, amendment.id, revisionId);
    if (!revision) fail(404, "Inclusión no encontrada");
    if (revision.status !== "pending_parties") {
      fail(409, "Esta inclusión ya no espera respuestas");
    }
    const locks = await lockForRevision(tx, ctx, revision.addedSourceIds);
    const parties = await lockRevisionParties(tx, revision.id);
    const row = parties.find((party) => party.memberId === memberId);
    if (!row) fail(404, "Ese miembro no tiene que responder a esta inclusión");
    if (row.decision !== "pending" && !moderate) {
      fail(409, "Esta parte ya ha respondido");
    }
    await tx
      .update(transactionalRevisionAcceptances)
      .set({
        decision: body.decision,
        decidedAt: now,
        recordedByUserId: actor.user.id,
      })
      .where(eq(transactionalRevisionAcceptances.id, row.id));
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "transactional_revision_answered",
      payload: {
        revisionId: revision.id,
        memberId,
        decision: body.decision,
        ...(memberId !== actor.memberId
          ? { recordedForMemberId: memberId }
          : {}),
      },
      actor,
    });
    await settleRevision(
      tx,
      ctx,
      revision,
      locks,
      parties.map((party) =>
        party.id === row.id ? { ...party, decision: body.decision } : party,
      ),
    );
  });

  return amendmentDto(ctx, amendment.id);
}

/**
 * The Secretaría validates an inclusion a member proposed and every party
 * accepted: it is applied (applyRevision).
 */
export async function validateTransactionalRevision(
  ctx: AmendmentContext,
  revisionId: string,
): Promise<AmendmentDto> {
  const { actor, amendment } = ctx;
  if (!canReviewAmendments(actor)) {
    fail(403, "No tienes permiso para validar inclusiones");
  }
  assertNotFinal(ctx);
  await db.transaction(async (tx) => {
    const [revision] = await lockRevision(tx, amendment.id, revisionId);
    if (!revision) fail(404, "Inclusión no encontrada");
    if (revision.status !== "pending_validation") {
      fail(409, "Esta inclusión no está esperando la validación");
    }
    const locks = await lockForRevision(tx, ctx, revision.addedSourceIds);
    const parties = await lockRevisionParties(tx, revision.id);
    await applyRevision(tx, ctx, revision, locks, parties);
  });
  return amendmentDto(ctx, amendment.id);
}

/**
 * Whoever proposed an inclusion, the Mesa or the Secretaría withdraws it
 * while it is open: the transactional stays as it is.
 */
export async function cancelTransactionalRevision(
  ctx: AmendmentContext,
  revisionId: string,
): Promise<AmendmentDto> {
  const { actor, amendment, now } = ctx;
  await db.transaction(async (tx) => {
    const [revision] = await lockRevision(tx, amendment.id, revisionId);
    if (!revision) fail(404, "Inclusión no encontrada");
    if (
      !(OPEN_REVISION_STATUSES as readonly string[]).includes(revision.status)
    ) {
      fail(409, "Esta inclusión ya está resuelta");
    }
    if (
      revision.proposedByUserId !== actor.user.id &&
      !canModerate(actor) &&
      !canReviewAmendments(actor)
    ) {
      fail(
        403,
        "Solo quien la propuso, la Mesa o la Secretaría pueden retirarla",
      );
    }
    await tx
      .update(transactionalRevisions)
      .set({ status: "cancelled", decidedAt: now })
      .where(eq(transactionalRevisions.id, revision.id));
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "transactional_revision_cancelled",
      payload: { revisionId: revision.id },
      actor,
    });
  });
  return amendmentDto(ctx, amendment.id);
}

/**
 * The open inclusion of each of these transactionals, as the reader gets
 * it (TransactionalRevisionDto): its parents only when the reader sees
 * them, its parties with offices redacted.
 */
async function loadOpenRevisions(
  ctx: DocumentAmendmentContext,
  rows: LoadedAmendment[],
  keep: (id: string) => boolean,
): Promise<Map<string, TransactionalRevisionDto>> {
  const ids = rows
    .filter((row) => row.kind === "transactional" && row.status === "submitted")
    .map((row) => row.id);
  const result = new Map<string, TransactionalRevisionDto>();
  if (ids.length === 0) return result;
  const revisions = await db
    .select()
    .from(transactionalRevisions)
    .where(
      and(
        inArray(transactionalRevisions.transactionalId, ids),
        inArray(transactionalRevisions.status, [...OPEN_REVISION_STATUSES]),
      ),
    );
  if (revisions.length === 0) return result;
  const parties = await db
    .select({
      revisionId: transactionalRevisionAcceptances.revisionId,
      decision: transactionalRevisionAcceptances.decision,
      decidedAt: transactionalRevisionAcceptances.decidedAt,
      member: {
        id: members.id,
        acronym: members.acronym,
        name: members.name,
        kind: members.kind,
      },
    })
    .from(transactionalRevisionAcceptances)
    .innerJoin(
      members,
      eq(members.id, transactionalRevisionAcceptances.memberId),
    )
    .where(
      inArray(
        transactionalRevisionAcceptances.revisionId,
        revisions.map((revision) => revision.id),
      ),
    )
    .orderBy(asc(members.acronym));
  const moderate = canModerate(ctx.actor);
  const review = canReviewAmendments(ctx.actor);
  for (const revision of revisions) {
    const own = parties.filter((party) => party.revisionId === revision.id);
    const pendingFor = (memberId: string | null) =>
      own.some(
        (party) => party.member.id === memberId && party.decision === "pending",
      );
    result.set(revision.transactionalId, {
      id: revision.id,
      status: revision.status as TransactionalRevisionDto["status"],
      addedSourceIds: revision.addedSourceIds.filter(keep),
      ops: revision.ops,
      justification: revision.justification,
      staffProposed: revision.staffProposed,
      createdAt: revision.createdAt.toISOString(),
      acceptances: redactAcceptances(
        ctx.actor,
        own.map((party) => ({
          member: toMemberRef(party.member),
          role: "author" as const,
          decision: party.decision,
          decidedAt: iso(party.decidedAt),
          recordedBy: "party" as const,
        })),
      ),
      can: {
        answer:
          revision.status === "pending_parties" &&
          (moderate || pendingFor(ctx.actor.memberId)),
        validate: revision.status === "pending_validation" && review,
        cancel:
          revision.proposedByUserId === ctx.actor.user.id || moderate || review,
      },
    });
  }
  return result;
}

// Relations ------------------------------------------------------------------

function assertRelationRole(ctx: DocumentAmendmentContext): void {
  if (
    !canModerate(ctx.actor) &&
    !canReviewAmendments(ctx.actor) &&
    !ctx.isProponent
  ) {
    fail(403, "No tienes permiso para gestionar relaciones entre enmiendas");
  }
}

export async function createAmendmentRelation(
  ctx: DocumentAmendmentContext,
  body: RelationBody,
): Promise<RelationDto> {
  const { actor, document } = ctx;
  assertRelationRole(ctx);
  assertNotFinal(ctx);
  // Both ends belong to this document, so this kind would record a false
  // cross-document link.
  if (body.kind === "same_in_other_document") {
    fail(
      422,
      "Esta relación solo se puede registrar entre enmiendas de documentos distintos",
    );
  }

  const ends = await findAmendments(
    db,
    and(
      eq(amendments.documentId, document.id),
      inArray(amendments.id, [body.fromId, body.toId]),
    ),
  );
  if (ends.length !== 2 || !ends.every((row) => isVisible(ctx, row))) {
    fail(404, "Enmienda no encontrada");
  }
  if (ends.some((row) => row.status === "draft")) {
    fail(409, "No se pueden relacionar borradores");
  }

  if (SYMMETRIC_RELATIONS.includes(body.kind)) {
    const reverse = await db.query.amendmentRelations.findFirst({
      where: and(
        eq(amendmentRelations.fromId, body.toId),
        eq(amendmentRelations.toId, body.fromId),
        eq(amendmentRelations.kind, body.kind),
      ),
      columns: { id: true },
    });
    if (reverse) fail(409, "La relación ya existe");
  }

  try {
    const row = await db.transaction(async (tx) => {
      await lockDocument(tx, document.id, "share");
      const [created] = await tx
        .insert(amendmentRelations)
        .values({
          fromId: body.fromId,
          toId: body.toId,
          kind: body.kind,
          note: body.note ?? null,
          createdByUserId: actor.user.id,
        })
        .returning();
      for (const [entityId, otherId] of [
        [body.fromId, body.toId],
        [body.toId, body.fromId],
      ] as const) {
        await recordEvent(tx, {
          assemblyId: ctx.assembly.id,
          documentId: document.id,
          entityType: "amendment",
          entityId,
          type: "relation_created",
          payload: {
            relationId: created!.id,
            kind: body.kind,
            otherId,
            direction: entityId === body.fromId ? "from" : "to",
          },
          actor,
        });
      }
      return created!;
    });
    return toRelationDto(row);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) fail(409, "La relación ya existe");
    throw error;
  }
}

export async function deleteAmendmentRelation(
  ctx: DocumentAmendmentContext,
  relationParam: string | undefined,
): Promise<{ success: true }> {
  const { actor, document } = ctx;
  assertRelationRole(ctx);
  assertNotFinal(ctx);
  if (!relationParam || !/^[a-z0-9]{20,32}$/.test(relationParam)) {
    fail(404, "Relación no encontrada");
  }

  const relation = await db.query.amendmentRelations.findFirst({
    where: eq(amendmentRelations.id, relationParam),
  });
  if (!relation) fail(404, "Relación no encontrada");
  const ends = await findAmendments(
    db,
    and(
      eq(amendments.documentId, document.id),
      inArray(amendments.id, [relation.fromId, relation.toId]),
    ),
  );
  if (ends.length !== 2 || !ends.every((row) => isVisible(ctx, row))) {
    fail(404, "Relación no encontrada");
  }

  await db.transaction(async (tx) => {
    await lockDocument(tx, document.id, "share");
    const deleted = await tx
      .delete(amendmentRelations)
      .where(eq(amendmentRelations.id, relation.id))
      .returning({ id: amendmentRelations.id });
    if (deleted.length === 0) fail(404, "Relación no encontrada");
    for (const [entityId, otherId] of [
      [relation.fromId, relation.toId],
      [relation.toId, relation.fromId],
    ] as const) {
      await recordEvent(tx, {
        assemblyId: ctx.assembly.id,
        documentId: document.id,
        entityType: "amendment",
        entityId,
        type: "relation_deleted",
        payload: {
          relationId: relation.id,
          kind: relation.kind,
          otherId,
          direction: entityId === relation.fromId ? "from" : "to",
        },
        actor,
      });
    }
  });
  return { success: true };
}

// History --------------------------------------------------------------------

export async function amendmentHistory(
  ctx: AmendmentContext,
): Promise<EventDto[]> {
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
    .where(
      and(
        eq(events.assemblyId, ctx.assembly.id),
        eq(events.entityType, "amendment"),
        eq(events.entityId, ctx.amendment.id),
      ),
    )
    .orderBy(asc(events.createdAt), asc(events.id));

  const notesVisible = canReadCorrection(ctx.actor, ctx.amendment);
  // Payloads name members by id: the areas read as one for those who may
  // not see them.
  const mask = await loadExecutiveMask(ctx.actor);
  // An Admin's act as an account names the Admin to that account and Admins.
  const impersonators = await loadImpersonators(
    rows
      .filter((row) => seesImpersonator(ctx.actor, row.actorUserId))
      .map((row) => row.impersonationId),
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: redactPayloadMembers(
      mask,
      redactCorrectionNote(
        row.type,
        redactAmendmentEventPayload(
          row.type,
          row.payload,
          ctx.positionsVisible,
        ),
        notesVisible,
      ),
    ),
    // Neither the area nor the person who acted for it, for those who may
    // not see the areas.
    ...redactEventActor(ctx.actor, {
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
    impersonatedBy: impersonatedByFor(ctx.actor, row, impersonators),
    createdAt: row.createdAt.toISOString(),
  }));
}
