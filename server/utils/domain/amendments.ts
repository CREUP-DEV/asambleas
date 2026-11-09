import { createError, getRouterParam, readBody, type H3Event } from "h3";
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
  documentVersions,
  documents,
  events,
  members,
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
  RelationKind,
} from "../../../shared/constants/domain";
import { amendmentVoteMajority } from "../../../shared/constants/domain";
import { PERMISSION_KEYS } from "../../../shared/constants/permissions";
import type {
  AcceptanceBody,
  AcceptanceDto,
  AdmissionBody,
  AmendmentCapabilities,
  AmendmentDraftBody,
  AmendmentDto,
  AmendmentUpdateBody,
  AmendmentAdmissionDto,
  AmendmentOutcomeDto,
  ApprovalWarnings,
  CorrectionBody,
  DocumentAmendmentsDto,
  EventDto,
  MemberRef,
  OutcomeBody,
  PositionBody,
  PublishAmendmentsBody,
  RelationBody,
  RelationDto,
  TransactionalBody,
  ValidateAmendmentsBody,
  VoteDto,
  VoteInput,
} from "../../../shared/types/api";
import type { AmendmentOp, Block } from "../../../shared/types/content";
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
  isHardOverlap,
  overlapBetween,
} from "../../../shared/utils/content/overlaps";
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
  submissionLate,
  transactionalReopenBlocker,
  transactionalSourcesMessage,
  unopenSourceReason,
  unopenSourcesMessage,
} from "./reviewState";
import {
  closeTransactionalsOver,
  competingTransactionalIds,
  loadSourceMap,
} from "./transactionalClosure";
import {
  canSeeAmendment,
  canSeePositions,
  isDocumentPresenter,
  isDocumentProponent,
  redactCorrectionNote,
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
type VoteRow = typeof votes.$inferSelect;

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
 * A devolution (`totality_return`) has no operations at all; every other kind
 * needs at least one, which `validateOps` reports as "empty".
 */
export function prepareAmendmentOps(input: {
  kind: AmendmentKind;
  ops: AmendmentOp[];
  base: Block[];
  takenIds: Iterable<string>;
  newId?: () => string;
}): { ops: AmendmentOp[]; errors: OpError[] } {
  if (input.kind === "totality_return") {
    return input.ops.length === 0
      ? { ops: [], errors: [] }
      : {
          ops: input.ops,
          errors: [{ index: -1, reason: "totality_return_ops" }],
        };
  }
  const ops = reIdInsertedBlocks(
    input.ops,
    input.base,
    input.takenIds,
    input.newId,
  );
  return { ops, errors: validateOps(input.base, ops) };
}

/**
 * Sort key by position in the base. Totality amendments go first: an
 * approved return leaves nothing else to vote (usual practice; no rule in
 * force fixes the order).
 */
export function amendmentSortKey(
  kind: AmendmentKind,
  ops: AmendmentOp[],
  base: Block[],
): number {
  if (kind === "totality_return") return -2;
  if (kind === "totality_alternative") return -1;
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

/** "T{n}" with n = existing transactionals + 1, skipping codes already taken. */
export function nextTransactionalCode(
  existingCodes: (string | null)[],
): string {
  const taken = new Set(existingCodes);
  let n = existingCodes.length + 1;
  while (taken.has(`T${n}`)) n += 1;
  return `T${n}`;
}

/**
 * Which sources a transactional that replaces them now turns `transacted`,
 * or why it cannot: every source must still be open (presented, admitted,
 * undecided), or the message of unopenSourcesMessage says what is missing.
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
      .filter((source) => !skipped(source))
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
 * it is created.
 */
export function unauthorizedTransactionalAuthors(
  nextAuthorIds: string[],
  input: {
    actorMemberId: string | null;
    currentAuthorIds: string[];
    partyMemberIds: (string | null)[];
  },
): string[] {
  const allowed = new Set<string | null>([
    input.actorMemberId,
    ...input.currentAuthorIds,
    ...input.partyMemberIds,
  ]);
  return nextAuthorIds.filter((id) => !allowed.has(id));
}

export interface CapabilityInput {
  status: AmendmentStatus;
  admission: AdmissionStatus;
  approvalMethod: ApprovalMethod | null;
  isAuthor: boolean;
  /** The actor acts for the document's main presenter. */
  isProponent: boolean;
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
      (input.isProponent || input.moderate) &&
      positionBlocker(input, input.rule, input.voted) === null,
    moderate: input.moderate,
    review: input.review,
  };
}

/** Hard overlaps with approved amendments and live "incompatible" links. */
export function computeApprovalWarnings(
  target: { id: string; ops: AmendmentOp[] },
  approved: { id: string; ops: AmendmentOp[] }[],
  incompatibleIds: string[],
): ApprovalWarnings {
  return {
    overlapsWithApproved: approved
      .filter((other) => other.id !== target.id)
      .filter((other) => isHardOverlap(overlapBetween(target.ops, other.ops)))
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

function toVoteDto(row: VoteRow): VoteDto {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    method: row.method,
    inFavor: row.inFavor,
    against: row.against,
    abstentions: row.abstentions,
    blank: row.blank,
    invalid: row.invalid,
    present: row.present,
    majority: row.majority,
    result: row.result,
    note: row.note,
    recordedAt: row.recordedAt.toISOString(),
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
  /** The actor acts for the main presenter, who answers the amendments. */
  isProponent: boolean;
  /** The actor acts for the main presenter or a co-presenter. */
  isPresenter: boolean;
  positionsVisible: boolean;
  /** What an amendment the main presenter accepts becomes. */
  rule: AcceptedAmendmentRule;
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
    positionsVisible: canSeePositions(actor, {
      settings,
      assemblyStatus: assembly.status,
      isPresenter,
    }),
    rule: document.acceptedAmendments,
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
  return canSeeLoadedAmendment(ctx.actor, row);
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
): Promise<{ agendaItemId: string | null }> {
  const [row] = await tx
    .select({
      status: documents.status,
      finalVoteId: documents.finalVoteId,
      consolidatedVersionId: documents.consolidatedVersionId,
      agendaItemId: documents.agendaItemId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for(mode);
  if (!row) fail(404, "Documento no encontrado");
  assertNotVoted(row);
  if (mode === "no key update" && row.status !== "published") {
    fail(409, "El documento no admite enmiendas");
  }
  return { agendaItemId: row.agendaItemId };
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
  return tx
    .select({
      id: amendments.id,
      code: amendments.code,
      status: amendments.status,
      admission: amendments.admission,
      late: amendments.late,
      validatedAt: amendments.validatedAt,
      publishedAt: amendments.publishedAt,
      decidedAt: amendments.decidedAt,
      approvalMethod: amendments.approvalMethod,
      outcomeVoteId: amendments.outcomeVoteId,
    })
    .from(amendments)
    .where(
      and(eq(amendments.documentId, documentId), inArray(amendments.id, ids)),
    )
    .orderBy(asc(amendments.id))
    .for("no key update");
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

function assertModerator(actor: Actor): void {
  if (!canModerate(actor))
    fail(403, "No tienes permiso para realizar esta acción");
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
  );
  const acceptanceRecorders = await loadAcceptanceRecorders(rows);
  const moderate = canModerate(ctx.actor);
  const review = canReviewAmendments(ctx.actor);
  const voted = documentVoted(ctx.document);
  const keep = (id: string) => !visibleIds || visibleIds.has(id);

  return rows.map((row) => {
    const meta = readMeta(row);
    const approval = authorsApproval(row);
    const mainAuthorId = loadedMainAuthor(row);
    const parties = partiesOf(row);
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
      authors: orderAuthors(
        row.authors.map((author) => toMemberRef(author.member)),
        mainAuthorId ?? undefined,
      ),
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
          ? {
              position: row.position.position,
              comment: row.position.comment,
              recordedBy: positionRecordedBy({
                decidedByUserId: row.position.decidedByUserId,
                recordedAs: recorders.recordedAs.get(row.id),
                recorderMemberId: row.position.decidedByUserId
                  ? recorders.memberOf.get(row.position.decidedByUserId)
                  : null,
                mainPresenterId: ctx.document.proponentMemberId,
              }),
              updatedAt: row.position.updatedAt.toISOString(),
            }
          : null,
      sourceIds: row.sources.map((source) => source.sourceId).filter(keep),
      transactionalIds: row.derived
        .map((derived) => derived.transactionalId)
        .filter(keep),
      acceptances: parties.map((acceptance) => ({
        member: toMemberRef(acceptance.member),
        role: acceptance.role,
        decision: acceptance.decision,
        decidedAt: iso(acceptance.decidedAt),
        recordedBy: acceptanceRecordedBy(
          acceptanceRecorders.get(acceptanceKey(row.id, acceptance.memberId)),
        ),
      })),
      updatedAt: row.updatedAt.toISOString(),
      can: amendmentCapabilities({
        status: row.status,
        admission: row.admission,
        approvalMethod: row.approvalMethod,
        isAuthor: isAmendmentAuthor(ctx.actor, row),
        isProponent: ctx.isProponent,
        moderate,
        review,
        actorMemberId: ctx.actor.memberId,
        acceptances: parties,
        validatedAt: row.validatedAt,
        publishedAt: row.publishedAt,
        authorsApproval: approval,
        rule: ctx.rule,
        sourcesOpen: transactionalSourcesOpen(row, sourceStates),
        voted,
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
 *   for (null when none), only for answers with no such event, compared
 *   with the document's current main presenter.
 */
async function loadPositionRecorders(rows: LoadedAmendment[]): Promise<{
  recordedAs: Map<string, string | null>;
  memberOf: Map<string, string | null>;
}> {
  const answered = rows.filter((row) => row.position);
  const recordedAs = new Map<string, string | null>();
  if (answered.length > 0) {
    const latest = await db
      .selectDistinctOn([events.entityId], {
        amendmentId: events.entityId,
        by: sql<string | null>`${events.payload}->>'by'`,
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
    for (const row of latest) recordedAs.set(row.amendmentId, row.by);
  }
  const userIds = unique(
    answered
      .filter((row) => !recordedAs.has(row.id))
      .map((row) => row.position?.decidedByUserId ?? null)
      .filter((id): id is string => id !== null),
  );
  const recorders =
    userIds.length > 0
      ? await db
          .select({ id: users.id, memberId: users.memberId })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
  return {
    recordedAs,
    memberOf: new Map(recorders.map((row) => [row.id, row.memberId])),
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

  return {
    amendments: dtos,
    relations: relationRows
      .filter((row) => visibleIds.has(row.fromId) && visibleIds.has(row.toId))
      .map(toRelationDto),
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

/** canSeeAmendment for a loaded row, outside a document context. */
export function canSeeLoadedAmendment(
  actor: Actor,
  row: LoadedAmendment,
): boolean {
  return canSeeAmendment(actor, {
    status: row.status,
    publishedAt: row.publishedAt,
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
  const authors = await resolveDraftAuthors(actor, body);
  // With co-authors, the main author has to be named (pickMainAuthor).
  const mainAuthorId = mainAuthorOrFail(
    pickMainAuthor(authors.memberIds, body.mainAuthorMemberId),
  )!;
  const base = await loadBaseBlocks(document);

  const id = await db.transaction(async (tx) => {
    await lockDocument(tx, document.id);
    const { ops, errors } = prepareAmendmentOps({
      kind: body.kind,
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
        positionKey: amendmentSortKey(body.kind, ops, base),
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

export async function updateAmendmentDraft(
  ctx: AmendmentContext,
  body: AmendmentUpdateBody,
): Promise<AmendmentDto> {
  const { actor, amendment, document } = ctx;
  if (!ctx.isAuthor) fail(403, "Solo los autores pueden editar la enmienda");
  if (amendment.status !== "draft")
    fail(409, "Solo se pueden editar borradores");
  assertAmendable(ctx);

  const transactional = amendment.kind === "transactional";
  if (transactional && body.kind) {
    fail(422, "No se puede cambiar el tipo de una transaccional");
  }
  const kind: AmendmentKind = transactional
    ? "transactional"
    : (body.kind ?? amendment.kind);
  const meta = readMeta(amendment);
  const currentAuthorIds = amendment.authors.map((author) => author.memberId);

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
      ],
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
      kind,
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
        positionKey: amendmentSortKey(kind, ops, base),
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
  return Number(row?.value ?? 0) + 1;
}

async function nextMemberSeq(
  tx: Tx,
  documentId: string,
  memberId: string,
): Promise<number> {
  const [row] = await tx
    .select({ value: sql<number>`coalesce(max(${amendments.memberSeq}), 0)` })
    .from(amendments)
    .where(
      and(
        eq(amendments.documentId, documentId),
        ne(amendments.kind, "transactional"),
        sql`${amendments.meta}->>'presentingMemberId' = ${memberId}`,
      ),
    );
  return Number(row?.value ?? 0) + 1;
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
      // Sent back for correction: it keeps its number and, while the same
      // member presents it, its code (numbering without gaps).
      const kept = numberingToKeep(amendment, presenting!.member.acronym);
      const number = kept.number ?? (await nextNumber(tx, document.id));
      const memberSeq =
        kept.memberSeq ??
        (await nextMemberSeq(tx, document.id, presenting!.memberId));
      const code = `${presenting!.member.acronym} ${memberSeq}`;
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
        transactional: { id: amendment.id, code: amendment.code },
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

export async function decideAmendmentAdmission(
  ctx: DocumentAmendmentContext,
  body: AdmissionBody,
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
    await lockDocument(tx, document.id, "share");
    // In id order, as an approval locks its lineage: the update below then
    // only touches rows this transaction already holds. The check above ran
    // before the lock, so a concurrent decision may have committed since.
    // Eligibility alone is not enough (both directions can be eligible, so
    // an opposite decision would be overturned): the locked rows must still
    // be exactly what the operator decided on. Declaring them inadmissible
    // closes the transactionals over them, locked in the same pass.
    const dependents =
      admission === "inadmissible"
        ? await findCompetitors(tx, document.id, null, body.amendmentIds)
        : { sourceMap: new Map<string, string[]>(), ids: [] };
    const requested = new Set(body.amendmentIds);
    const lockedAll = await lockAmendments(
      tx,
      document.id,
      unique([...body.amendmentIds, ...dependents.ids]),
    );
    const locked = lockedAll.filter((row) => requested.has(row.id));
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
              decidedAt: now,
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
        },
        actor,
      });
    }
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
      await closeDependents(
        tx,
        ctx,
        dependents,
        lockedAll,
        locked
          .filter((row) => row.status === "submitted")
          .map((row) => ({
            id: row.id,
            code: row.code,
            status: "inadmissible" as const,
          })),
      );
    }
    if (voteRow) {
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
 * refused (409). Locks the document (share), then the amendments, those
 * sources and the other transactionals over them in id order, then the
 * acceptances.
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
    await lockDocument(tx, document.id, "share");
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
    // One ordered pass: the amendments, what the transactionals among them
    // replace and the other transactionals over those.
    const lockedById = new Map(
      (
        await lockAmendments(
          tx,
          document.id,
          unique([...body.amendmentIds, ...sourceIds, ...competitors.ids]),
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
    const partyRows =
      transactionalIds.length > 0
        ? await lockParties(tx, transactionalIds, "share")
        : [];
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
        transactional: row,
        sources: sourcesOf(row.id),
        competitors: lockedCompetitors(competitors, lockedById.values()),
      });
    }
  });

  return listDocumentAmendments(ctx);
}

/**
 * The Secretaría makes validated amendments visible to everyone who can see
 * the document (amendment:review). Each one must be validated, past draft
 * and not published yet. Publishing only changes who sees the amendment, so
 * it is still allowed after the final vote: an amendment decided before it
 * was published can be shown afterwards.
 */
export async function publishAmendments(
  ctx: DocumentAmendmentContext,
  body: PublishAmendmentsBody,
): Promise<DocumentAmendmentsDto> {
  const { actor, document, now } = ctx;
  assertReviewer(actor);
  await assertDocumentAmendments(document.id, body.amendmentIds);

  await db.transaction(async (tx) => {
    const locked = await lockAmendments(tx, document.id, body.amendmentIds);
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
  });

  return listDocumentAmendments(ctx);
}

/**
 * The Secretaría sends a presented amendment that it has not validated yet
 * back to its authors (amendment:review), with a note: it returns to draft,
 * keeps its number, code and timing (see submitAmendment) and shows the note
 * to its authors until they present it again. Optimistic lock on the
 * amendment.
 */
export async function requestAmendmentCorrection(
  ctx: AmendmentContext,
  body: CorrectionBody,
): Promise<AmendmentDto> {
  const { actor, amendment, now } = ctx;
  assertReviewer(actor);
  const review = { ...amendment, authorsApproval: authorsApproval(amendment) };
  if (awaitsAuthors(review)) fail(409, AWAITS_AUTHORS_MESSAGE);
  if (!awaitsValidation(review)) {
    fail(
      409,
      "Solo se puede pedir una corrección de una enmienda enviada y pendiente de validación",
    );
  }
  assertNotFinal(ctx);

  await db.transaction(async (tx) => {
    await lockDocument(tx, ctx.document.id, "share");
    const updated = await tx
      .update(amendments)
      .set({
        status: "draft",
        submittedAt: null,
        submittedByUserId: null,
        correctionNote: body.note,
        correctionRequestedAt: now,
      })
      .where(
        and(
          eq(amendments.id, amendment.id),
          eq(amendments.status, "submitted"),
          isNull(amendments.validatedAt),
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
      type: "amendment_correction_requested",
      payload: { note: body.note },
      actor,
    });
  });

  return amendmentDto(ctx, amendment.id);
}

// Position -------------------------------------------------------------------

/**
 * The main presenter's answer to an amendment (or the Mesa's, for it):
 * only once it is validated, published and, if late, admitted, and for a
 * transactional once its main authors accepted it (positionBlocker).
 * `positionUpdatedAt` is the optimistic lock on the stored answer. Under the
 * document's "incorporate" rule accepting approves the amendment at once
 * (approval method "proponent"), which closes the pending transactionals
 * over it, and moving away from "accept" reopens it (positionEffect); after
 * the final vote nothing changes.
 */
export async function setAmendmentPosition(
  ctx: AmendmentContext,
  body: PositionBody,
): Promise<AmendmentDto> {
  const { actor, amendment, document, now } = ctx;
  if (!ctx.isProponent && !canModerate(actor)) {
    fail(
      403,
      "Solo quien presenta principalmente el documento o la Mesa pueden responder a las enmiendas",
    );
  }
  assertNotFinal(ctx);
  const blocker = positionBlocker(
    { ...amendment, authorsApproval: authorsApproval(amendment) },
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
    // incorporation closes) in one ordered pass, then its parties and its
    // answer: the checks above, again under lock.
    const competitors = await findCompetitors(tx, document.id, amendment.id, [
      amendment.id,
      ...sourceIds,
    ]);
    const locked = await lockAmendments(tx, document.id, [
      amendment.id,
      ...sourceIds,
      ...competitors.ids,
    ]);
    const current = locked.find((row) => row.id === amendment.id);
    if (!current) fail(404, "Enmienda no encontrada");
    const parties =
      amendment.kind === "transactional"
        ? await lockParties(tx, [amendment.id], "share")
        : [];
    const fields = {
      ...current,
      authorsApproval: authorsApproval({
        kind: amendment.kind,
        acceptances: parties,
      }),
    };
    const lockedBlocker = positionBlocker(fields, ctx.rule);
    if (lockedBlocker) fail(409, POSITION_BLOCKER_MESSAGES[lockedBlocker]);
    const effect = positionEffect(fields, body.position, ctx.rule);

    const [stored] = await tx
      .select({ updatedAt: amendmentPositions.updatedAt })
      .from(amendmentPositions)
      .where(eq(amendmentPositions.amendmentId, amendment.id))
      .for("no key update");
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

    const values = {
      position: body.position,
      comment: body.comment ?? null,
      decidedByUserId: actor.user.id,
      updatedAt: new Date(),
    };
    await tx
      .insert(amendmentPositions)
      .values({ amendmentId: amendment.id, ...values })
      .onConflictDoUpdate({
        target: amendmentPositions.amendmentId,
        set: values,
      });
    const base = {
      assemblyId: ctx.assembly.id,
      documentId: document.id,
      entityType: "amendment" as const,
      entityId: amendment.id,
      actor,
    };
    await recordEvent(tx, {
      ...base,
      type: "position_changed",
      payload: {
        position: body.position,
        by: ctx.isProponent ? "proponent" : "moderator",
        // Whose answer it is, also when the Mesa records it: the main
        // presenter (the news of co-presenters and authors name it).
        memberId: document.proponentMemberId,
      },
    });

    if (effect === "approve") {
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
            eq(amendments.id, amendment.id),
            eq(amendments.status, "submitted"),
            eq(amendments.admission, "admitted"),
          ),
        )
        .returning({ id: amendments.id });
      if (updated.length === 0)
        fail(409, "La enmienda ha cambiado. Recarga la página");
      await recordEvent(tx, {
        ...base,
        type: "amendment_approved",
        // The main presenter's acceptance incorporated it, also when the
        // Mesa recorded it (the news credit it).
        payload: {
          method: "proponent",
          byPosition: true,
          memberId: document.proponentMemberId,
        },
      });
      if (sourceIds.length > 0) {
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
        { id: amendment.id, code: amendment.code, status: "approved" },
      ]);
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
            eq(amendments.id, amendment.id),
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
        payload: { previousStatus: "approved", reason: "position_changed" },
      });
    }
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

export async function applyAmendmentOutcome(
  ctx: AmendmentContext,
  body: OutcomeBody,
): Promise<AmendmentOutcomeResult> {
  const { actor, amendment, document, now } = ctx;
  assertModerator(actor);
  assertNotFinal(ctx);
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
      if (voteRow) {
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
    await lockDocument(tx, document.id, "share");
    // The row also tells which vote this reopening voids. A transactional
    // keeps what it replaced: its sources stay transacted. One that never
    // replaced them needs them still open, and one a main author rejected
    // stays closed (transactionalReopenBlocker).
    const locked = await lockAmendments(tx, document.id, [
      amendment.id,
      ...sourceIds,
    ]);
    const current = locked.find((row) => row.id === amendment.id);
    if (!current) fail(409, "La enmienda ha cambiado. Recarga la página");
    if (transactional) {
      const parties = await lockParties(tx, [amendment.id], "share");
      const blocker = transactionalReopenBlocker({
        kind: "transactional",
        validatedAt: current.validatedAt,
        authorsApproval: authorsApproval({
          kind: "transactional",
          acceptances: parties,
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
 * Whether the actor may propose a transactional: any member account that
 * presents amendments (amendment:create), the document's main presenter and
 * the authors of the amendments it groups, or the Mesa. docs/design.md,
 * "Transactionals".
 */
export function canProposeTransactional(input: {
  moderate: boolean;
  canCreate: boolean;
  actorMemberId: string | null;
  isParty: boolean;
}): boolean {
  if (input.moderate) return true;
  if (!input.actorMemberId) return false;
  return input.canCreate || input.isParty;
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
      isParty: ctx.isProponent || actsFor(actor, sourceAuthorIds),
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
    const involved = new Set([...sourceAuthorIds, document.proponentMemberId]);
    authorIds = unique([
      ...(actor.memberId ? [actor.memberId] : []),
      ...(body.authorMemberIds ?? []),
    ]);
    if (authorIds.some((id) => id !== actor.memberId && !involved.has(id))) {
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

  const parties = buildAcceptanceParties(
    sources.map(loadedMainAuthor),
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
    const { ops, errors } = prepareAmendmentOps({
      kind: "transactional",
      ops: body.ops,
      base,
      takenIds: await otherInsertedIds(tx, document.id),
    });
    assertValidOps(errors);
    // Images it inserts are this document's own.
    await assertOpImagesBelong(document.id, ops);

    const existing = await tx
      .select({ code: amendments.code })
      .from(amendments)
      .where(
        and(
          eq(amendments.documentId, document.id),
          eq(amendments.kind, "transactional"),
        ),
      );
    const code = nextTransactionalCode(existing.map((row) => row.code));

    const meta: StoredAmendmentMeta = mainAuthorId
      ? { presentingMemberId: mainAuthorId }
      : {};
    const [row] = await tx
      .insert(amendments)
      .values({
        documentId: document.id,
        baseVersionId: document.baseVersionId!,
        code,
        kind: "transactional",
        status: submit ? "submitted" : "draft",
        ...instantReview(instant, actor, now),
        late: false,
        ops,
        meta,
        justification: body.justification,
        positionKey: amendmentSortKey("transactional", ops, base),
        createdByUserId: actor.user.id,
        submittedByUserId: submit ? actor.user.id : null,
        submittedAt: submit ? now : null,
      })
      .returning({ id: amendments.id });
    const amendmentId = row!.id;

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
    payload: redactCorrectionNote(
      row.type,
      redactAmendmentEventPayload(row.type, row.payload, ctx.positionsVisible),
      notesVisible,
    ),
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
    impersonatedBy: impersonatedByFor(ctx.actor, row, impersonators),
    createdAt: row.createdAt.toISOString(),
  }));
}
