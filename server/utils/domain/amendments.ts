import { createError, getRouterParam, readBody, type H3Event } from "h3";
import { and, asc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
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
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  type AcceptanceDecision,
  type AcceptanceRole,
  type AdmissionStatus,
  type AmendmentKind,
  type AmendmentStatus,
  type AssemblySettings,
  type Majority,
  type RelationKind,
} from "../../../shared/constants/domain";
import { PERMISSION_KEYS } from "../../../shared/constants/permissions";
import type {
  AcceptanceBody,
  AdmissionBody,
  AmendmentCapabilities,
  AmendmentDraftBody,
  AmendmentDto,
  AmendmentUpdateBody,
  AmendmentAdmissionDto,
  AmendmentOutcomeDto,
  ApprovalWarnings,
  DocumentAmendmentsDto,
  EventDto,
  MemberRef,
  OutcomeBody,
  PositionBody,
  RelationBody,
  RelationDto,
  TransactionalBody,
  VoteDto,
  VoteInput,
} from "../../../shared/types/api";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import {
  amendmentWindow,
  isLateSubmission,
  type AmendmentWindow,
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
import { buildOptimisticLockCondition } from "../optimisticLock";
import {
  actsFor,
  canModerate,
  canReviewAmendments,
  requireActor,
  type Actor,
} from "./actor";
import { clearLiveVote, loadMilestones, pointLiveVote } from "./documents";
import { recordEvent } from "./events";
import {
  resolveAmendment,
  resolveAssembly,
  resolveDocument,
} from "./resolvers";
import {
  amendmentsPublic,
  canSeeAmendment,
  canSeePositions,
  isDocumentProponent,
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

/** Amendment metadata as stored. `presentingMemberId` drives memberSeq and the code. */
export interface StoredAmendmentMeta extends AmendmentMeta {
  presentingMemberId?: string;
}

/** Response of POST .../amendments/[amendment]/outcome. */
export type AmendmentOutcomeResult = AmendmentOutcomeDto;
/** Response of POST .../amendments/admission. */
export type AmendmentAdmissionResult = AmendmentAdmissionDto;

const OPEN_STATUSES: AmendmentStatus[] = ["draft", "submitted"];
const SYMMETRIC_RELATIONS: RelationKind[] = ["incompatible", "duplicate"];

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

/** Sort key by position in the base. Totality amendments go first (RFAG 23ter). */
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
 * One acceptance per distinct author of the sources (role author) plus the
 * document proponent (role proponent). The creator's own member accepts at once.
 */
export function buildAcceptanceParties(
  sourceAuthorIds: string[],
  proponentMemberId: string | null,
  creatorMemberId: string | null,
): { memberId: string; role: AcceptanceRole; accepted: boolean }[] {
  const parties = new Map<string, AcceptanceRole>();
  for (const id of sourceAuthorIds) {
    if (!parties.has(id)) parties.set(id, "author");
  }
  if (proponentMemberId && !parties.has(proponentMemberId)) {
    parties.set(proponentMemberId, "proponent");
  }
  return [...parties].map(([memberId, role]) => ({
    memberId,
    role,
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

/** transactional id -> its source ids, from `amendment_sources` rows. */
export function buildSourceMap(
  rows: { transactionalId: string; sourceId: string }[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const entry = map.get(row.transactionalId) ?? [];
    entry.push(row.sourceId);
    map.set(row.transactionalId, entry);
  }
  return map;
}

/**
 * Every amendment absorbed by `roots`: their sources and, through nested
 * transactionals (a transactional over another), the sources of those at any
 * depth, in breadth-first order. A root only appears when another root
 * absorbs it.
 */
export function collectAncestors(
  sourceMap: Map<string, string[]>,
  roots: string[],
): string[] {
  const seen = new Set<string>();
  const queue = roots.flatMap((id) => sourceMap.get(id) ?? []);
  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    queue.push(...(sourceMap.get(id) ?? []));
  }
  return result;
}

/**
 * What reopening an approved transactional gives back: its whole lineage,
 * except what another approved transactional still absorbs.
 */
export function lineageToRestore(
  sourceMap: Map<string, string[]>,
  transactionalId: string,
  otherApprovedIds: string[],
): string[] {
  const kept = new Set(
    collectAncestors(
      sourceMap,
      otherApprovedIds.filter((id) => id !== transactionalId),
    ),
  );
  return collectAncestors(sourceMap, [transactionalId]).filter(
    (id) => !kept.has(id),
  );
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
 * actor's member, its current authors and its parties (the authors of its
 * sources and the proponent), as when it is created.
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
  isAuthor: boolean;
  isProponent: boolean;
  moderate: boolean;
  review: boolean;
  actorMemberId: string | null;
  acceptances: { memberId: string; decision: AcceptanceDecision }[];
}

export function amendmentCapabilities(
  input: CapabilityInput,
): AmendmentCapabilities {
  const draft = input.status === "draft";
  const submitted = input.status === "submitted";
  return {
    edit: input.isAuthor && draft,
    submit: input.isAuthor && draft,
    withdraw: input.isAuthor && submitted,
    accept:
      OPEN_STATUSES.includes(input.status) &&
      input.actorMemberId !== null &&
      input.acceptances.some(
        (acceptance) =>
          acceptance.memberId === input.actorMemberId &&
          acceptance.decision === "pending",
      ),
    position: (input.isProponent || input.moderate) && submitted,
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
 * Computes a vote with `computeVoteOutcome`. A tie under tieRule "repeat"
 * answers 409 with `{ tie: true }` before anything is stored, and counts
 * that exceed the members present are refused.
 */
export function evaluateVoteInput(
  vote: VoteInput,
  settings: Pick<AssemblySettings, "denominator" | "tieRule">,
): {
  majority: Majority;
  outcome: VoteOutcome & { result: "approved" | "rejected" };
} {
  const majority = vote.majority ?? "simple";
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

/** The presenting member first, then the rest by acronym. */
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
      sources: { columns: { sourceId: true } },
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

async function loadAmendment(executor: Executor, id: string) {
  const [row] = await findAmendments(executor, eq(amendments.id, id));
  return row;
}

export interface DocumentAmendmentContext {
  actor: Actor;
  assembly: AssemblyRow;
  document: DocumentRow;
  settings: AssemblySettings;
  window: AmendmentWindow;
  /**
   * Presented amendments are public under `after_close` (amendmentsPublic):
   * the window closed, has no close date, or the session started. The `late`
   * flag is computed separately with `isLateSubmission`.
   */
  windowClosed: boolean;
  isProponent: boolean;
  positionsVisible: boolean;
  now: Date;
}

export interface AmendmentContext extends DocumentAmendmentContext {
  amendment: LoadedAmendment;
  isAuthor: boolean;
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
  const settings: AssemblySettings = {
    ...DEFAULT_ASSEMBLY_SETTINGS,
    ...(assembly.settings ?? {}),
  };
  const milestones = await loadMilestones(assembly.id);
  const window = amendmentWindow(document, milestones);
  const now = new Date();
  const isProponent = isDocumentProponent(actor, document);
  return {
    actor,
    assembly,
    document,
    settings,
    window,
    windowClosed: amendmentsPublic(window, assembly.status, now),
    isProponent,
    positionsVisible: canSeePositions(actor, {
      settings,
      assemblyStatus: assembly.status,
      isProponent,
    }),
    now,
  };
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

function isVisible(
  ctx: DocumentAmendmentContext,
  row: LoadedAmendment,
): boolean {
  return canSeeAmendment(
    ctx.actor,
    {
      status: row.status,
      late: row.late,
      createdByUserId: row.createdByUserId,
      authorMemberIds: row.authors.map((author) => author.memberId),
      partyMemberIds: row.acceptances.map((acceptance) => acceptance.memberId),
    },
    { settings: ctx.settings, windowClosed: ctx.windowClosed },
  );
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
 * vote (recordFinalVote locks the row for update).
 * - `update` also serializes numbering and block re-ids per document, and
 *   requires the document to be still published.
 * - `share` only holds a concurrent final vote off until this transaction
 *   commits; several amendment changes may hold it at once.
 * A transaction takes it once, in one mode, before any amendment row lock.
 */
async function lockDocument(
  tx: Tx,
  documentId: string,
  mode: "update" | "share" = "update",
): Promise<void> {
  const [row] = await tx
    .select({
      status: documents.status,
      finalVoteId: documents.finalVoteId,
      consolidatedVersionId: documents.consolidatedVersionId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for(mode);
  if (!row) fail(404, "Documento no encontrado");
  assertNotVoted(row);
  if (mode === "update" && row.status !== "published") {
    fail(409, "El documento no admite enmiendas");
  }
}

/**
 * Locks amendment rows of the document in id order. Taking every row a
 * transaction needs in one ordered pass keeps two transactions (say, the
 * approvals of T1 and of a transactional over T1) from waiting on each other.
 */
function lockAmendments(tx: Tx, documentId: string, ids: string[]) {
  return tx
    .select({
      id: amendments.id,
      status: amendments.status,
      admission: amendments.admission,
      decidedAt: amendments.decidedAt,
      outcomeVoteId: amendments.outcomeVoteId,
    })
    .from(amendments)
    .where(
      and(eq(amendments.documentId, documentId), inArray(amendments.id, ids)),
    )
    .orderBy(asc(amendments.id))
    .for("update");
}

/**
 * Locks `sourceIds` and every amendment they absorb through nested
 * transactionals (plus `alsoLock`, in the same ordered pass) and fails 409
 * unless that lineage is still open (submitted, admitted, undecided).
 * Returns the lineage.
 */
async function lockOpenLineage(
  tx: Tx,
  documentId: string,
  sourceIds: string[],
  alsoLock: string[] = [],
): Promise<string[]> {
  const lineage =
    sourceIds.length > 0
      ? unique([
          ...sourceIds,
          ...collectAncestors(await loadSourceMap(tx, documentId), sourceIds),
        ])
      : [];
  const ids = unique([...lineage, ...alsoLock]);
  if (ids.length === 0) return [];
  const rows = await lockAmendments(tx, documentId, ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (
    lineage.some((id) => {
      const row = byId.get(id);
      return !row || !isOpenSource(row);
    })
  ) {
    fail(409, "Alguna de las enmiendas de origen ya está decidida");
  }
  return lineage;
}

/** Every transactional -> sources edge of the document. */
async function loadSourceMap(
  executor: Executor,
  documentId: string,
): Promise<Map<string, string[]>> {
  const rows = await executor
    .select({
      transactionalId: amendmentSources.transactionalId,
      sourceId: amendmentSources.sourceId,
    })
    .from(amendmentSources)
    .innerJoin(amendments, eq(amendments.id, amendmentSources.transactionalId))
    .where(eq(amendments.documentId, documentId));
  return buildSourceMap(rows);
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

/** The final vote fixes the text: nothing about its amendments changes afterwards. */
function assertNotVoted(document: {
  finalVoteId: string | null;
  consolidatedVersionId: string | null;
}): void {
  if (document.finalVoteId || document.consolidatedVersionId) {
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
    if (!moderate) fail(403, "Tu cuenta no está vinculada a ningún miembro");
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
  const moderate = canModerate(ctx.actor);
  const review = canReviewAmendments(ctx.actor);
  const keep = (id: string) => !visibleIds || visibleIds.has(id);

  return rows.map((row) => {
    const meta = readMeta(row);
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
        meta.presentingMemberId,
      ),
      submittedAt: iso(row.submittedAt),
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
              updatedAt: row.position.updatedAt.toISOString(),
            }
          : null,
      sourceIds: row.sources.map((source) => source.sourceId).filter(keep),
      transactionalIds: row.derived
        .map((derived) => derived.transactionalId)
        .filter(keep),
      acceptances: row.acceptances.map((acceptance) => ({
        member: toMemberRef(acceptance.member),
        role: acceptance.role,
        decision: acceptance.decision,
        decidedAt: iso(acceptance.decidedAt),
      })),
      updatedAt: row.updatedAt.toISOString(),
      can: amendmentCapabilities({
        status: row.status,
        isAuthor: isAmendmentAuthor(ctx.actor, row),
        isProponent: ctx.isProponent,
        moderate,
        review,
        actorMemberId: ctx.actor.memberId,
        acceptances: row.acceptances,
      }),
    };
  });
}

/** Reloads one amendment after a mutation and maps it for the actor. */
export async function amendmentDto(
  ctx: DocumentAmendmentContext,
  id: string,
): Promise<AmendmentDto> {
  const row = await loadAmendment(db, id);
  if (!row) fail(404, "Enmienda no encontrada");
  const [dto] = await buildAmendmentDtos(ctx, [row]);
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

    const meta: StoredAmendmentMeta = {
      presentingMemberId: authors.presentingMemberId,
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

  const requestedAuthorIds = requestedDraftAuthorIds({
    authorMemberIds: body.authorMemberIds,
    onBehalfOfMemberId: body.onBehalfOfMemberId,
    actorMemberId: actor.memberId,
    presentingMemberId: meta.presentingMemberId,
    currentAuthorIds,
  });
  const authorsChanged =
    requestedAuthorIds !== undefined || Boolean(body.onBehalfOfMemberId);
  const authors = authorsChanged
    ? await resolveDraftAuthors(actor, {
        onBehalfOfMemberId: body.onBehalfOfMemberId,
        authorMemberIds:
          requestedAuthorIds ??
          currentAuthorIds.filter((id) => id !== meta.presentingMemberId),
        currentPresentingId: meta.presentingMemberId,
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
        ...amendment.acceptances.map((acceptance) => acceptance.memberId),
        document.proponentMemberId,
      ],
    }).length > 0
  ) {
    fail(
      403,
      "Solo las partes de la transaccional pueden figurar como autoras",
    );
  }

  const nextMeta: StoredAmendmentMeta = { ...meta };
  if (authors) nextMeta.presentingMemberId = authors.presentingMemberId;
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
      payload: { kind: amendment.kind, code: amendment.code },
      actor: ctx.actor,
    });
  });
  return { success: true };
}

// Submission and withdrawal ----------------------------------------------------

function isOpenSource(row: {
  status: AmendmentStatus;
  admission: AdmissionStatus;
  decidedAt: Date | null;
}): boolean {
  return (
    row.status === "submitted" && row.admission === "admitted" && !row.decidedAt
  );
}

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
  const presentingId =
    meta.presentingMemberId ??
    orderAuthors(
      amendment.authors.map((author) => toMemberRef(author.member)),
    )[0]?.id;
  const presenting = amendment.authors.find(
    (author) => author.memberId === presentingId,
  );
  if (!transactional && !presenting)
    fail(422, "Indica el miembro que presenta la enmienda");

  await db.transaction(async (tx) => {
    await lockDocument(tx, document.id);
    let payload: Record<string, unknown>;
    let updated: { id: string }[];

    if (transactional) {
      await lockOpenLineage(
        tx,
        document.id,
        amendment.sources.map((source) => source.sourceId),
      );
      updated = await tx
        .update(amendments)
        .set({
          status: "submitted",
          submittedAt: now,
          submittedByUserId: actor.user.id,
          late: false,
          admission: "admitted",
        })
        .where(
          and(eq(amendments.id, amendment.id), eq(amendments.status, "draft")),
        )
        .returning({ id: amendments.id });
      payload = { code: amendment.code, late: false, admission: "admitted" };
    } else {
      const number = await nextNumber(tx, document.id);
      const memberSeq = await nextMemberSeq(
        tx,
        document.id,
        presenting!.memberId,
      );
      const code = `${presenting!.member.acronym} ${memberSeq}`;
      const late = isLateSubmission(ctx.window, now);
      const admission: AdmissionStatus = late ? "pending" : "admitted";
      updated = await tx
        .update(amendments)
        .set({
          status: "submitted",
          submittedAt: now,
          submittedByUserId: actor.user.id,
          number,
          memberSeq,
          code,
          late,
          admission,
          meta: {
            ...meta,
            presentingMemberId: presenting!.memberId,
          } as StoredAmendmentMeta,
        })
        .where(
          and(eq(amendments.id, amendment.id), eq(amendments.status, "draft")),
        )
        .returning({ id: amendments.id });
      payload = { number, code, late, admission };
    }
    if (updated.length === 0) fail(409, "La enmienda ya se ha presentado");

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
  });

  return amendmentDto(ctx, amendment.id);
}

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
  });

  return amendmentDto(ctx, amendment.id);
}

// Admission ------------------------------------------------------------------

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

  const eligible =
    body.decision === "admitted"
      ? rows.every(
          (row) =>
            (row.status === "submitted" && row.admission !== "admitted") ||
            row.status === "inadmissible",
        )
      : rows.every((row) => row.status === "submitted");
  if (!eligible) {
    fail(
      409,
      body.decision === "admitted"
        ? "Alguna enmienda no está pendiente de admisión"
        : "Alguna enmienda ya está decidida",
    );
  }

  const evaluated =
    body.method === "vote" && body.vote
      ? evaluateVoteInput(body.vote, ctx.settings)
      : null;
  const admission: AmendmentAdmissionResult["admission"] =
    !evaluated || evaluated.outcome.result === "approved"
      ? body.decision
      : body.decision === "admitted"
        ? "inadmissible"
        : "admitted";

  const result = await db.transaction(async (tx) => {
    await lockDocument(tx, document.id, "share");
    const decisionId = cuid();
    let voteRow: VoteRow | undefined;
    if (evaluated && body.vote) {
      [voteRow] = await tx
        .insert(votes)
        .values({
          assemblyId: ctx.assembly.id,
          subjectType: "decision",
          subjectId: decisionId,
          method: body.vote.method,
          ...voteCounts(body.vote),
          majority: evaluated.majority,
          result: evaluated.outcome.result,
          note: body.vote.note ?? null,
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
        },
        actor,
      });
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

// Position -------------------------------------------------------------------

export async function setAmendmentPosition(
  ctx: AmendmentContext,
  body: PositionBody,
): Promise<AmendmentDto> {
  const { actor, amendment } = ctx;
  if (!ctx.isProponent && !canModerate(actor)) {
    fail(403, "Solo el proponente o la Mesa pueden fijar la posición");
  }
  if (amendment.status !== "submitted") {
    fail(
      409,
      "Solo se puede fijar la posición de enmiendas presentadas y sin decidir",
    );
  }
  assertNotFinal(ctx);

  await db.transaction(async (tx) => {
    await lockDocument(tx, ctx.document.id, "share");
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
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "position_changed",
      payload: {
        position: body.position,
        by: ctx.isProponent ? "proponent" : "moderator",
      },
      actor,
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
  const sourceIds = amendment.sources.map((source) => source.sourceId);
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
    const evaluated =
      body.action === "vote"
        ? evaluateVoteInput(body.vote, ctx.settings)
        : null;
    const approved =
      body.action === "approve" || evaluated?.outcome.result === "approved";

    const result = await db.transaction(async (tx) => {
      await lockDocument(tx, document.id, "share");
      // An approved transactional absorbs its sources and, through nested
      // transactionals, theirs. They must all be still open, or a source and
      // the transactional that absorbs it could both end up approved. The
      // amendment itself is locked in the same ordered pass.
      const lineage = await lockOpenLineage(
        tx,
        document.id,
        approved && amendment.kind === "transactional" ? sourceIds : [],
        [amendment.id],
      );
      if (amendment.kind === "transactional") {
        const parties = await tx
          .select({ decision: amendmentAcceptances.decision })
          .from(amendmentAcceptances)
          .where(eq(amendmentAcceptances.amendmentId, amendment.id))
          .for("update");
        if (parties.some((party) => party.decision !== "accepted")) {
          fail(409, "Todas las partes deben aceptar la transaccional");
        }
      }

      let voteRow: VoteRow | undefined;
      if (body.action === "vote" && evaluated) {
        [voteRow] = await tx
          .insert(votes)
          .values({
            assemblyId: ctx.assembly.id,
            subjectType: "amendment",
            subjectId: amendment.id,
            method: body.vote.method,
            ...voteCounts(body.vote),
            majority: evaluated.majority,
            result: evaluated.outcome.result,
            note: body.vote.note ?? null,
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

      if (lineage.length > 0) {
        const transacted = await tx
          .update(amendments)
          .set({ status: "transacted", decidedAt: now })
          .where(
            and(
              inArray(amendments.id, lineage),
              eq(amendments.status, "submitted"),
            ),
          )
          .returning({ id: amendments.id });
        for (const row of transacted) {
          await recordEvent(tx, {
            ...base,
            entityId: row.id,
            type: "amendment_transacted",
            payload: {
              transactionalId: amendment.id,
              code: amendment.code,
              ...(sourceIds.includes(row.id) ? {} : { nested: true }),
            },
          });
        }
      }

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
            agendaItemId: document.agendaItemId,
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
    const status = body.action === "withdraw" ? "withdrawn" : "lapsed";
    await db.transaction(async (tx) => {
      await lockDocument(tx, document.id, "share");
      const updated = await tx
        .update(amendments)
        .set({ status, decidedAt: now, outcomeNote: body.note ?? null })
        .where(
          and(
            eq(amendments.id, amendment.id),
            eq(amendments.status, "submitted"),
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
    await lockDocument(tx, document.id, "share");
    // Reopening an approved transactional gives back everything it absorbed,
    // nested transactionals included, unless another approved transactional
    // still absorbs it.
    let restore: string[] = [];
    if (amendment.status === "approved" && amendment.kind === "transactional") {
      const sourceMap = await loadSourceMap(tx, document.id);
      const otherApproved = await tx
        .select({ id: amendments.id })
        .from(amendments)
        .where(
          and(
            eq(amendments.documentId, document.id),
            eq(amendments.kind, "transactional"),
            eq(amendments.status, "approved"),
            ne(amendments.id, amendment.id),
          ),
        );
      restore = lineageToRestore(
        sourceMap,
        amendment.id,
        otherApproved.map((row) => row.id),
      );
    }
    // One ordered pass, as approval does; the row also tells which vote
    // this reopening voids.
    const locked = await lockAmendments(tx, document.id, [
      amendment.id,
      ...restore,
    ]);
    const current = locked.find((row) => row.id === amendment.id);
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
    if (updated.length === 0 || !current)
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

    if (current.status === "approved" && restore.length > 0) {
      const restored = await tx
        .update(amendments)
        .set({ status: "submitted", decidedAt: null })
        .where(
          and(
            inArray(amendments.id, restore),
            eq(amendments.status, "transacted"),
          ),
        )
        .returning({ id: amendments.id });
      for (const row of restored) {
        await recordEvent(tx, {
          ...base,
          entityId: row.id,
          type: "amendment_reopened",
          payload: {
            previousStatus: "transacted",
            transactionalId: amendment.id,
          },
        });
      }
    }

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
  if (!sources.every(isOpenSource)) {
    fail(409, "Solo se pueden transaccionar enmiendas admitidas y sin decidir");
  }

  // Over another transactional, the authors of what it absorbs are parties
  // too: their amendments become transacted when this one is approved.
  const nestedIds = collectAncestors(
    await loadSourceMap(db, document.id),
    body.sourceIds,
  ).filter((id) => !body.sourceIds.includes(id));
  const nestedAuthors =
    nestedIds.length > 0
      ? await db
          .select({ memberId: amendmentAuthors.memberId })
          .from(amendmentAuthors)
          .where(inArray(amendmentAuthors.amendmentId, nestedIds))
      : [];
  const sourceAuthorIds = unique([
    ...sources.flatMap((source) =>
      source.authors.map((author) => author.memberId),
    ),
    ...nestedAuthors.map((row) => row.memberId),
  ]);
  const moderate = canModerate(actor);
  const sourceAuthor =
    actsFor(actor, sourceAuthorIds) ||
    sources.some((source) => source.createdByUserId === actor.user.id);
  if (!moderate && !ctx.isProponent && !sourceAuthor) {
    fail(
      403,
      "Solo los autores, el proponente o la Mesa pueden proponer transaccionales",
    );
  }

  let authorIds: string[];
  if (moderate) {
    authorIds = unique(
      body.authorMemberIds ?? (actor.memberId ? [actor.memberId] : []),
    );
  } else {
    const parties = new Set([...sourceAuthorIds, document.proponentMemberId]);
    authorIds = unique([
      ...(actor.memberId ? [actor.memberId] : []),
      ...(body.authorMemberIds ?? []),
    ]);
    if (authorIds.some((id) => id !== actor.memberId && !parties.has(id))) {
      fail(
        403,
        "Solo las partes de la transaccional pueden figurar como autoras",
      );
    }
  }
  await assertMembers(authorIds, false);

  const parties = buildAcceptanceParties(
    sourceAuthorIds,
    document.proponentMemberId,
    actor.memberId,
  );
  const submit = body.submit ?? true;
  const base = await loadBaseBlocks(document);

  const id = await db.transaction(async (tx) => {
    await lockDocument(tx, document.id);
    // The sources may have been decided since they were read.
    await lockOpenLineage(tx, document.id, body.sourceIds);
    const { ops, errors } = prepareAmendmentOps({
      kind: "transactional",
      ops: body.ops,
      base,
      takenIds: await otherInsertedIds(tx, document.id),
    });
    assertValidOps(errors);

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

    const meta: StoredAmendmentMeta = authorIds[0]
      ? { presentingMemberId: authorIds[0] }
      : {};
    const [row] = await tx
      .insert(amendments)
      .values({
        documentId: document.id,
        baseVersionId: document.baseVersionId!,
        code,
        kind: "transactional",
        status: submit ? "submitted" : "draft",
        admission: submit ? "admitted" : "pending",
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
        payload: { code, late: false, admission: "admitted" },
        actor,
      });
    }
    return amendmentId;
  });

  return amendmentDto(ctx, id);
}

// Acceptance -----------------------------------------------------------------

export async function recordAmendmentAcceptance(
  ctx: AmendmentContext,
  body: AcceptanceBody,
): Promise<AmendmentDto> {
  const { actor, amendment, now } = ctx;
  if (amendment.kind !== "transactional") {
    fail(409, "Solo las transaccionales necesitan aceptación");
  }
  if (!OPEN_STATUSES.includes(amendment.status))
    fail(409, "La enmienda ya está decidida");
  assertNotFinal(ctx);

  const moderate = canModerate(actor);
  const memberId = body.memberId ?? actor.memberId;
  if (!memberId) fail(403, "Tu cuenta no está vinculada a ningún miembro");
  if (memberId !== actor.memberId && !moderate) {
    fail(403, "Solo la Mesa puede registrar la respuesta de otra parte");
  }
  const party = amendment.acceptances.find(
    (acceptance) => acceptance.memberId === memberId,
  );
  if (!party) fail(404, "Ese miembro no es parte de la transaccional");
  if (party.decision !== "pending" && !moderate)
    fail(409, "Esta parte ya ha respondido");

  await db.transaction(async (tx) => {
    await lockDocument(tx, ctx.document.id, "share");
    await tx
      .update(amendmentAcceptances)
      .set({
        decision: body.decision,
        decidedAt: now,
        recordedByUserId: actor.user.id,
      })
      .where(eq(amendmentAcceptances.id, party.id));
    await recordEvent(tx, {
      assemblyId: ctx.assembly.id,
      documentId: ctx.document.id,
      entityType: "amendment",
      entityId: amendment.id,
      type: "acceptance_recorded",
      payload: {
        memberId,
        role: party.role,
        decision: body.decision,
        ...(memberId !== actor.memberId
          ? { recordedForMemberId: memberId }
          : {}),
      },
      actor,
    });
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
        payload: { relationId: relation.id, kind: relation.kind, otherId },
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

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: redactAmendmentEventPayload(
      row.type,
      row.payload,
      ctx.positionsVisible,
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
    createdAt: row.createdAt.toISOString(),
  }));
}
