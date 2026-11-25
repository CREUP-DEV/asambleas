import { fail } from "../core/http";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  headcountEntries,
  headcountGuests,
  headcounts,
  members,
  roles,
  users,
} from "../../db/schema";
import type {
  HeadcountBody,
  HeadcountDto,
  HeadcountGuestDto,
  HeadcountMemberDto,
  HeadcountsDto,
  HeadcountUpdateBody,
  VoteInput,
} from "~~/shared/types/api";
import type { AssemblySettings } from "~~/shared/constants/domain";
import { quorumRulesOf } from "~~/shared/constants/calendarRules";
import { HEADCOUNT_GUEST_ROLES } from "~~/shared/constants/roles";
import {
  ROLL_CALL_KINDS,
  compareGuests,
  compareRollCall,
  quorumRequired,
  rollCallOrder,
  tallyHeadcount,
  votesInHeadcount,
  type QuorumThreshold,
} from "~~/shared/utils/headcount";
import {
  resolveRollCall,
  rollCallCounts,
  rollCallVoters,
  type RollCallCounts,
  type VoteBallot,
  type VoteBallotInput,
} from "~~/shared/utils/rollCall";
import { getOptimisticLockTimestampMs } from "../optimisticLock";
import { canModerate, type Actor } from "./actor";
import { lockAssembly } from "./agendaWrites";
import type { AssemblyRow } from "./assemblies";
import { loadCalendarRules } from "./calendarRules";
import { diffChanges } from "./changes";
import type { Executor } from "./events";
import { recordEvent } from "./events";
import { assertSessionOpen } from "./sessionOpen";

/**
 * Headcounts the Mesa takes during the session (docs/api.md, "Headcounts"):
 * who among the active asociados is in the room or represented by a
 * delegation, and whether that makes quorum under the threshold of the
 * assembly type (`calendar_rules`, the call a session opens in). The
 * sectorials and the guests (accounts with the role Invitado) in the room
 * are written down too, for the record, but never count. Every write locks
 * the assembly row first and records a `headcount` event, so the Mesa's
 * devices refetch. The latest count is the base of majorities on "present"
 * (votesBase).
 */

type HeadcountRow = typeof headcounts.$inferSelect;
type MemberColumns = Pick<
  typeof members.$inferSelect,
  "id" | "acronym" | "name" | "kind" | "university"
>;

const MEMBER_COLUMNS = {
  id: members.id,
  acronym: members.acronym,
  name: members.name,
  kind: members.kind,
  university: members.university,
} as const;

function toHeadcountMember(member: MemberColumns): HeadcountMemberDto {
  return {
    id: member.id,
    acronym: member.acronym,
    name: member.name,
    kind: member.kind,
    university: member.university,
  };
}

/** Counts are taken, and corrected, only while the session is open. */
function assertCountable(assembly: Pick<AssemblyRow, "status">): void {
  assertSessionOpen(assembly.status);
}

/**
 * The members a new count lists, in the order of the roll call: the active
 * asociados (with a vote), then the active sectorials (without).
 */
async function rollCallMembers(executor: Executor): Promise<MemberColumns[]> {
  const rows = await executor
    .select(MEMBER_COLUMNS)
    .from(members)
    .where(
      and(
        inArray(members.kind, [...ROLL_CALL_KINDS]),
        eq(members.active, true),
      ),
    );
  return rollCallOrder(rows);
}

/**
 * The guests a new count lists: the accounts with access and a guest role
 * (HEADCOUNT_GUEST_ROLES: Invitado, given here by hand, and the members of
 * the CAI and the CdG). Reverse alphabetical by name.
 */
async function invitedAccounts(
  executor: Executor,
): Promise<{ userId: string; name: string }[]> {
  const rows = await executor
    .select({ userId: users.id, name: users.name })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(
      and(
        inArray(roles.name, [...HEADCOUNT_GUEST_ROLES]),
        isNull(users.accessRevokedAt),
      ),
    );
  return rows.sort(compareGuests);
}

/** The ids a count may list: who votes and who only attends. */
interface RollCallSets {
  voters: Set<string>;
  attendees: Set<string>;
}

function rollCallSets(listed: readonly MemberColumns[]): RollCallSets {
  const sets: RollCallSets = { voters: new Set(), attendees: new Set() };
  for (const member of listed) {
    if (votesInHeadcount(member.kind)) sets.voters.add(member.id);
    else sets.attendees.add(member.id);
  }
  return sets;
}

async function quorumOf(
  assembly: Pick<AssemblyRow, "type">,
  executor: Executor,
): Promise<QuorumThreshold> {
  return quorumRulesOf(
    assembly.type,
    await loadCalendarRules(assembly.type, executor),
  );
}

interface StoredEntry {
  memberId: string;
  mark: HeadcountDto["entries"][number]["mark"];
  delegateMemberId: string | null;
  voting: boolean;
}

function toHeadcountDto(
  row: HeadcountRow,
  entries: StoredEntry[],
  guests: HeadcountGuestDto[],
  refs: Map<string, HeadcountMemberDto>,
): HeadcountDto {
  return {
    id: row.id,
    eligible: row.eligible,
    inRoom: row.inRoom,
    delegated: row.delegated,
    present: row.present,
    attending: entries.filter((entry) => !entry.voting).length + guests.length,
    required: row.required,
    quorum: row.present >= row.required,
    note: row.note,
    takenAt: row.takenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    entries: entries.flatMap((entry) => {
      const member = refs.get(entry.memberId);
      if (!member) return [];
      return [
        {
          member,
          mark: entry.mark,
          delegate: entry.delegateMemberId
            ? (refs.get(entry.delegateMemberId) ?? null)
            : null,
          voting: entry.voting,
        },
      ];
    }),
    guests: [...guests].sort(compareGuests),
  };
}

/**
 * The order of a count's entries: those it counted with a vote first (a
 * member that changed kind since stays where the count had it), then the
 * roll-call order.
 */
function entryOrder(
  refs: Map<string, HeadcountMemberDto>,
): (a: StoredEntry, b: StoredEntry) => number {
  return (a, b) => {
    if (a.voting !== b.voting) return a.voting ? -1 : 1;
    const first = refs.get(a.memberId);
    const second = refs.get(b.memberId);
    return first && second ? compareRollCall(first, second) : 0;
  };
}

function groupBy<T extends { headcountId: string }>(
  rows: T[],
): Map<string, T[]> {
  const byHeadcount = new Map<string, T[]>();
  for (const row of rows) {
    const list = byHeadcount.get(row.headcountId) ?? [];
    list.push(row);
    byHeadcount.set(row.headcountId, list);
  }
  return byHeadcount;
}

/**
 * GET .../headcounts: every count of the assembly, newest first, with the
 * quorum threshold of its type and, for the Mesa (canModerate), the members
 * and guests a new count lists (roll-call order; empty for anyone else, since
 * the guests are people). Entries follow the roll-call order too. Public to
 * everyone who sees the assembly, for transparency: who was in the room, the
 * delegations and the quorum are shown in the live view and on the
 * projection. Who was counted goes to everyone but the Mesa for the latest
 * count only (headcountsForReader).
 */
export async function loadHeadcounts(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<HeadcountsDto> {
  const rows = await db
    .select()
    .from(headcounts)
    .where(eq(headcounts.assemblyId, assembly.id))
    .orderBy(desc(headcounts.takenAt), desc(headcounts.id));
  const ids = rows.map((row) => row.id);
  const [entries, guestRows] =
    ids.length > 0
      ? await Promise.all([
          db
            .select()
            .from(headcountEntries)
            .where(inArray(headcountEntries.headcountId, ids)),
          db
            .select()
            .from(headcountGuests)
            .where(inArray(headcountGuests.headcountId, ids)),
        ])
      : [[], []];
  const mesa = canModerate(actor);
  // Everyone else reads who was counted in the latest count only
  // (headcountsForReader): only its members are named.
  const named = mesa
    ? entries
    : entries.filter((entry) => entry.headcountId === ids[0]);
  const memberIds = [
    ...new Set(
      named.flatMap((entry) =>
        entry.delegateMemberId
          ? [entry.memberId, entry.delegateMemberId]
          : [entry.memberId],
      ),
    ),
  ];
  // The roll call is what a new count lists, the Mesa's; the members an
  // entry names are all in `counted`.
  const [counted, listed, invited, quorum] = await Promise.all([
    memberIds.length > 0
      ? db
          .select(MEMBER_COLUMNS)
          .from(members)
          .where(inArray(members.id, memberIds))
      : Promise.resolve([] as MemberColumns[]),
    mesa ? rollCallMembers(db) : Promise.resolve([] as MemberColumns[]),
    mesa ? invitedAccounts(db) : Promise.resolve([]),
    quorumOf(assembly, db),
  ]);
  const refs = new Map<string, HeadcountMemberDto>(
    [...counted, ...listed].map((member) => [
      member.id,
      toHeadcountMember(member),
    ]),
  );
  const entriesBy = groupBy(entries);
  const guestsBy = groupBy(guestRows);
  const order = entryOrder(refs);
  const dtos = rows.map((row) =>
    toHeadcountDto(
      row,
      (entriesBy.get(row.id) ?? []).sort(order),
      (guestsBy.get(row.id) ?? []).map(({ userId, name }) => ({
        userId,
        name,
      })),
      refs,
    ),
  );
  return {
    ...headcountsForReader(dtos, mesa),
    members: mesa ? listed.map(toHeadcountMember) : [],
    guests: invited,
    quorum,
  };
}

/**
 * The counts (newest first) as a reader gets them: the Mesa, which
 * corrects any of them, every one whole; everyone else the latest whole in
 * `latest` and the list as figures only (no entries nor guests, which the
 * room reads of the latest alone), so a phone neither downloads who was
 * counted in earlier counts nor the latest twice.
 */
export function headcountsForReader(
  dtos: HeadcountDto[],
  mesa: boolean,
): Pick<HeadcountsDto, "headcounts" | "latest"> {
  const latest = dtos[0] ?? null;
  if (mesa) return { headcounts: dtos, latest };
  return {
    headcounts: dtos.map((dto) => ({ ...dto, entries: [], guests: [] })),
    latest,
  };
}

/**
 * Validates the marks against who may vote and who may only attend, and
 * counts them. 422 `{ problems: [{ memberId, problem }] }` when the form is
 * wrong.
 */
function tallyOrFail(body: HeadcountBody, sets: RollCallSets) {
  const tally = tallyHeadcount(body.entries, sets.voters, sets.attendees);
  if (tally.problems.size > 0) {
    fail(422, "El recuento no es válido", {
      problems: [...tally.problems].map(([memberId, problem]) => ({
        memberId,
        problem,
      })),
    });
  }
  return tally;
}

/**
 * The guests of the body, each with its name: every one must be listed in
 * `allowed` (by account id) and listed once. 422 `{ guests: [ids] }`
 * otherwise.
 */
function guestsOrFail(
  body: HeadcountBody,
  allowed: ReadonlyMap<string, string>,
): { userId: string; name: string }[] {
  const ids = body.guests ?? [];
  const seen = new Set<string>();
  const wrong = new Set<string>();
  for (const id of ids) {
    if (seen.has(id) || !allowed.has(id)) wrong.add(id);
    seen.add(id);
  }
  if (wrong.size > 0) {
    fail(422, "Algún invitado indicado no es válido", {
      guests: [...wrong],
    });
  }
  return ids.map((userId) => ({ userId, name: allowed.get(userId)! }));
}

async function writeEntries(
  tx: Executor,
  headcountId: string,
  body: HeadcountBody,
  voters: ReadonlySet<string>,
  guests: readonly { userId: string; name: string }[],
): Promise<void> {
  if (body.entries.length > 0) {
    await tx.insert(headcountEntries).values(
      body.entries.map((entry) => ({
        headcountId,
        memberId: entry.memberId,
        mark: entry.mark,
        delegateMemberId:
          entry.mark === "delegated" ? (entry.delegateId ?? null) : null,
        voting: voters.has(entry.memberId),
      })),
    );
  }
  if (guests.length > 0) {
    await tx
      .insert(headcountGuests)
      .values(guests.map((guest) => ({ headcountId, ...guest })));
  }
}

/** What an event says about a count: figures only, never who was there. */
function countPayload(row: Pick<HeadcountRow, keyof CountFigures>) {
  return {
    eligible: row.eligible,
    present: row.present,
    required: row.required,
    quorum: row.present >= row.required,
  };
}

type CountFigures = Pick<HeadcountRow, "eligible" | "present" | "required">;

/**
 * POST .../headcounts (session:moderate): stores a new count of the active
 * asociados, with the sectorials and guests in the room, checked against
 * the quorum threshold of the type in force. Refused in a draft or closed
 * assembly.
 */
export async function recordHeadcount(
  actor: Actor,
  assembly: AssemblyRow,
  body: HeadcountBody,
): Promise<HeadcountsDto> {
  assertCountable(assembly);
  await db.transaction(async (tx) => {
    const locked = await lockAssembly(tx, assembly.id);
    assertCountable(locked);
    const quorum = await quorumOf(locked, tx);
    const sets = rollCallSets(await rollCallMembers(tx));
    const tally = tallyOrFail(body, sets);
    const guests = guestsOrFail(
      body,
      new Map(
        (await invitedAccounts(tx)).map((guest) => [guest.userId, guest.name]),
      ),
    );
    const required = quorumRequired(sets.voters.size, quorum);
    const [created] = await tx
      .insert(headcounts)
      .values({
        assemblyId: assembly.id,
        eligible: sets.voters.size,
        inRoom: tally.inRoom,
        delegated: tally.delegated,
        present: tally.present,
        required,
        note: body.note ?? null,
        takenByUserId: actor.user.id,
      })
      .returning();
    await writeEntries(tx, created!.id, body, sets.voters, guests);
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "headcount",
      entityId: created!.id,
      type: "headcount_recorded",
      payload: countPayload(created!),
      actor,
    });
  });
  return loadHeadcounts(actor, assembly);
}

/**
 * PUT .../headcounts/[headcount] (session:moderate): corrects a count. The
 * members it may list are those a new count lists plus those it already
 * listed, each as the count had it: a member it counted with a vote keeps
 * it, and one it listed without a vote never gets one, so a correction never
 * turns a sectorial into a vote. The guests are the accounts with the role
 * Invitado now plus those it already listed. Its `eligible` and `required`
 * stay those of the moment it was taken. Optimistic lock on `updatedAt`
 * (409 when stale).
 */
export async function updateHeadcount(
  actor: Actor,
  assembly: AssemblyRow,
  headcountId: string,
  body: HeadcountUpdateBody,
): Promise<HeadcountsDto> {
  assertCountable(assembly);
  await db.transaction(async (tx) => {
    const locked = await lockAssembly(tx, assembly.id);
    assertCountable(locked);
    const [row] = await tx
      .select()
      .from(headcounts)
      .where(
        and(
          eq(headcounts.id, headcountId),
          eq(headcounts.assemblyId, assembly.id),
        ),
      );
    if (!row) fail(404, "Recuento no encontrado");
    if (
      getOptimisticLockTimestampMs(row.updatedAt) !==
      getOptimisticLockTimestampMs(body.updatedAt)
    ) {
      fail(409, "El recuento ha cambiado. Recarga la página");
    }

    const listed = await tx
      .select({
        memberId: headcountEntries.memberId,
        voting: headcountEntries.voting,
      })
      .from(headcountEntries)
      .where(eq(headcountEntries.headcountId, row.id));
    const sets = rollCallSets(await rollCallMembers(tx));
    for (const entry of listed) {
      // As the count had it: neither a vote won nor a vote lost since.
      sets.voters.delete(entry.memberId);
      sets.attendees.delete(entry.memberId);
      if (entry.voting) sets.voters.add(entry.memberId);
      else sets.attendees.add(entry.memberId);
    }
    const tally = tallyOrFail(body, sets);

    // The guests it listed keep the name they had then.
    const allowed = new Map(
      (await invitedAccounts(tx)).map((guest) => [guest.userId, guest.name]),
    );
    const listedGuests = await tx
      .select({ userId: headcountGuests.userId, name: headcountGuests.name })
      .from(headcountGuests)
      .where(eq(headcountGuests.headcountId, row.id));
    for (const guest of listedGuests) {
      if (guest.userId) allowed.set(guest.userId, guest.name);
    }
    const guests = guestsOrFail(body, allowed);

    const next = {
      inRoom: tally.inRoom,
      delegated: tally.delegated,
      present: tally.present,
      note: body.note ?? null,
    };
    const [updated] = await tx
      .update(headcounts)
      .set(next)
      .where(eq(headcounts.id, row.id))
      .returning();
    await tx
      .delete(headcountEntries)
      .where(eq(headcountEntries.headcountId, row.id));
    // A deleted account's entry stays: it was there, and no form lists it.
    await tx
      .delete(headcountGuests)
      .where(
        and(
          eq(headcountGuests.headcountId, row.id),
          isNotNull(headcountGuests.userId),
        ),
      );
    await writeEntries(tx, row.id, body, sets.voters, guests);
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "headcount",
      entityId: row.id,
      type: "headcount_corrected",
      payload: {
        ...countPayload(updated!),
        // The note is the Mesa's label for the count, not a correction note.
        changes: diffChanges(row, next, {
          keys: ["inRoom", "delegated", "present", "note"],
        }),
      },
      actor,
    });
  });
  return loadHeadcounts(actor, assembly);
}

/** The count in force: the latest one taken in the assembly. */
export async function latestHeadcount(
  assemblyId: string,
  executor: Executor = db,
): Promise<Pick<HeadcountRow, "id" | "present"> | null> {
  const [row] = await executor
    .select({ id: headcounts.id, present: headcounts.present })
    .from(headcounts)
    .where(eq(headcounts.assemblyId, assemblyId))
    .orderBy(desc(headcounts.takenAt), desc(headcounts.id))
    .limit(1);
  return row ?? null;
}

/**
 * The base of a vote: with majorities on the members present and no figure
 * typed for this vote, the latest headcount's; the vote records which count
 * was in force either way. Assent carries no counts.
 */
export async function withHeadcount(
  assemblyId: string,
  vote: VoteInput,
  settings: Pick<AssemblySettings, "denominator">,
): Promise<{
  vote: VoteInput;
  headcountId: string | null;
  /** A registered vote's ballots, as recorded. */
  ballots?: VoteBallot[];
}> {
  if (vote.method === "assent") return { vote, headcountId: null };
  if (vote.method === "roll_call" && (vote.ballots?.length ?? 0) > 0) {
    const resolved = await resolveRollCallBallots(
      assemblyId,
      vote.ballots!,
      0,
      db,
      vote.rollCallHeadcountId,
    );
    return {
      vote: withRollCallCounts(vote, resolved.counts),
      headcountId: resolved.headcountId,
      ballots: resolved.ballots,
    };
  }
  const latest = await latestHeadcount(assemblyId);
  return fillPresent(vote, latest, settings);
}

/** The vote with the counts its ballots give, whatever was typed. */
export function withRollCallCounts(
  vote: VoteInput,
  counts: RollCallCounts,
): VoteInput {
  return {
    ...vote,
    inFavor: counts.inFavor,
    against: counts.against,
    abstentions: counts.abstentions,
    blank: 0,
    invalid: 0,
    notCast: counts.notCast,
    present: counts.present,
  };
}

/**
 * The ballots of a registered vote checked against the latest headcount
 * (user's decision of 2026-11-21): its voters (the entries with a vote,
 * those delegated voted by their delegate) in the roll call's order, each
 * with the ballot sent or «No vota»; 409 without a headcount, 422 for a
 * ballot of someone who is not a voter, a repeated one, or a choice the vote
 * does not take (`optionCount` for a vote between alternatives).
 */
export async function resolveRollCallBallots(
  assemblyId: string,
  ballots: readonly VoteBallotInput[],
  optionCount = 0,
  executor: Executor = db,
  /** The headcount the roll call was called from, when the form says. */
  calledFrom?: string,
): Promise<{
  ballots: VoteBallot[];
  counts: RollCallCounts;
  headcountId: string;
}> {
  const latest = await latestHeadcount(assemblyId, executor);
  if (!latest) {
    fail(
      409,
      "Para registrar el voto de cada delegación hace falta un recuento de presentes",
    );
  }
  // A headcount taken while the roll was called changes who votes: the
  // Mesa calls the new one (the form keeps the rows it marked).
  if (calledFrom && calledFrom !== latest.id) {
    fail(
      409,
      "El recuento de presentes ha cambiado: vuelve a pasar lista con el nuevo",
      { messageKey: "session.rollCall.errors.headcountChanged" },
    );
  }
  const entries = await executor
    .select({
      member: MEMBER_COLUMNS,
      mark: headcountEntries.mark,
      voting: headcountEntries.voting,
      delegateMemberId: headcountEntries.delegateMemberId,
    })
    .from(headcountEntries)
    .innerJoin(members, eq(members.id, headcountEntries.memberId))
    .where(eq(headcountEntries.headcountId, latest.id));
  const delegateIds = entries
    .map((entry) => entry.delegateMemberId)
    .filter((id): id is string => id !== null);
  const delegates = new Map(
    (delegateIds.length > 0
      ? await executor
          .select({ id: members.id, acronym: members.acronym })
          .from(members)
          .where(inArray(members.id, delegateIds))
      : []
    ).map((row) => [row.id, row]),
  );
  const voters = rollCallVoters(
    [...entries]
      .sort((a, b) => compareRollCall(a.member, b.member))
      .map((entry) => ({
        member: entry.member,
        mark: entry.mark,
        voting: entry.voting,
        delegate: entry.delegateMemberId
          ? (delegates.get(entry.delegateMemberId) ?? null)
          : null,
      })),
  );
  const result = resolveRollCall(voters, ballots, optionCount);
  if ("problem" in result) {
    fail(
      422,
      result.problem.reason === "unknown_member"
        ? "Alguna delegación no está en el último recuento de presentes"
        : result.problem.reason === "repeated_member"
          ? "Alguna delegación vota dos veces"
          : "Algún voto no corresponde a esta votación",
      { reasons: [{ index: -1, reason: result.problem.reason }] },
    );
  }
  return {
    ballots: result.ballots,
    counts: rollCallCounts(result.ballots, optionCount),
    headcountId: latest.id,
  };
}

/**
 * The pure part of withHeadcount: with majorities on the members present
 * and no figure typed for this vote (null or left out), the count's
 * `present`; a typed figure, zero included, stays. The count is recorded
 * whatever the denominator, and none is recorded without a count or for
 * assent. The count is the latest of the assembly, whatever its day.
 */
export function fillPresent(
  vote: VoteInput,
  latest: Pick<HeadcountRow, "id" | "present"> | null,
  settings: Pick<AssemblySettings, "denominator">,
): { vote: VoteInput; headcountId: string | null } {
  if (vote.method === "assent" || !latest) return { vote, headcountId: null };
  const fill = settings.denominator === "present" && vote.present == null;
  return {
    vote: fill ? { ...vote, present: latest.present } : vote,
    headcountId: latest.id,
  };
}
