import { createError } from "h3";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { headcountEntries, headcounts, members } from "../../db/schema";
import type {
  HeadcountBody,
  HeadcountDto,
  HeadcountsDto,
  HeadcountUpdateBody,
  MemberRef,
  VoteInput,
} from "~~/shared/types/api";
import type { AssemblySettings } from "~~/shared/constants/domain";
import { quorumRulesOf } from "~~/shared/constants/calendarRules";
import {
  quorumRequired,
  quorumThreshold,
  tallyHeadcount,
  type QuorumCall,
  type QuorumRules,
} from "~~/shared/utils/headcount";
import { getOptimisticLockTimestampMs } from "../optimisticLock";
import { toMemberRef } from "../members/dto";
import type { Actor } from "./actor";
import { lockAssembly } from "./agendaWrites";
import type { AssemblyRow } from "./assemblies";
import { loadCalendarRules } from "./calendarRules";
import { diffChanges } from "./changes";
import type { Executor } from "./events";
import { recordEvent } from "./events";

/**
 * Headcounts the Mesa takes during the session (docs/api.md, "Headcounts"):
 * who among the active asociados is in the room or represented by a
 * delegation, and whether that makes quorum under the rules of the
 * assembly type (`calendar_rules`). Every write locks the assembly row
 * first and records a `headcount` event, so the Mesa's devices refetch.
 * The latest count is the base of majorities on "present" (votesBase).
 */

type HeadcountRow = typeof headcounts.$inferSelect;
type MemberColumns = Pick<
  typeof members.$inferSelect,
  "id" | "acronym" | "name" | "kind"
>;

const MEMBER_COLUMNS = {
  id: members.id,
  acronym: members.acronym,
  name: members.name,
  kind: members.kind,
} as const;

function fail(statusCode: number, message: string, data?: unknown): never {
  throw createError({ statusCode, message, data });
}

function assertCountable(assembly: Pick<AssemblyRow, "status">): void {
  if (assembly.status === "closed") fail(409, "La asamblea está cerrada");
  if (assembly.status === "draft") {
    fail(409, "La asamblea todavía no está convocada");
  }
}

/** The members with a vote now: the active asociados, by acronym. */
async function eligibleMembers(executor: Executor): Promise<MemberColumns[]> {
  return executor
    .select(MEMBER_COLUMNS)
    .from(members)
    .where(and(eq(members.kind, "asociado"), eq(members.active, true)))
    .orderBy(asc(members.acronym));
}

async function quorumRules(
  assembly: Pick<AssemblyRow, "type">,
  executor: Executor,
): Promise<QuorumRules> {
  return quorumRulesOf(
    assembly.type,
    await loadCalendarRules(assembly.type, executor),
  );
}

function toHeadcountDto(
  row: HeadcountRow,
  entries: {
    memberId: string;
    mark: HeadcountDto["entries"][number]["mark"];
    delegateMemberId: string | null;
  }[],
  refs: Map<string, MemberRef>,
): HeadcountDto {
  return {
    id: row.id,
    call: row.call,
    eligible: row.eligible,
    inRoom: row.inRoom,
    delegated: row.delegated,
    present: row.present,
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
        },
      ];
    }),
  };
}

/**
 * GET .../headcounts: every count of the assembly, newest first, with the
 * asociados that have a vote now and the quorum rules of its type. Public
 * to everyone who sees the assembly, for transparency: who was in the room,
 * the delegations and the quorum are shown in the live view and on the
 * projection.
 */
export async function loadHeadcounts(
  assembly: AssemblyRow,
): Promise<HeadcountsDto> {
  const rows = await db
    .select()
    .from(headcounts)
    .where(eq(headcounts.assemblyId, assembly.id))
    .orderBy(desc(headcounts.takenAt), desc(headcounts.id));
  const entries =
    rows.length > 0
      ? await db
          .select()
          .from(headcountEntries)
          .where(
            inArray(
              headcountEntries.headcountId,
              rows.map((row) => row.id),
            ),
          )
      : [];
  const memberIds = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.delegateMemberId
          ? [entry.memberId, entry.delegateMemberId]
          : [entry.memberId],
      ),
    ),
  ];
  const [counted, eligible, rules] = await Promise.all([
    memberIds.length > 0
      ? db
          .select(MEMBER_COLUMNS)
          .from(members)
          .where(inArray(members.id, memberIds))
      : Promise.resolve([] as MemberColumns[]),
    eligibleMembers(db),
    quorumRules(assembly, db),
  ]);
  const refs = new Map<string, MemberRef>(
    [...counted, ...eligible].map((member) => [member.id, toMemberRef(member)]),
  );
  const byHeadcount = new Map<string, typeof entries>();
  for (const entry of entries) {
    const list = byHeadcount.get(entry.headcountId) ?? [];
    list.push(entry);
    byHeadcount.set(entry.headcountId, list);
  }
  const dtos = rows.map((row) =>
    toHeadcountDto(
      row,
      (byHeadcount.get(row.id) ?? []).sort((a, b) =>
        (refs.get(a.memberId)?.acronym ?? "").localeCompare(
          refs.get(b.memberId)?.acronym ?? "",
        ),
      ),
      refs,
    ),
  );
  return {
    headcounts: dtos,
    latest: dtos[0] ?? null,
    members: eligible.map(toMemberRef),
    quorum: rules,
  };
}

/**
 * Validates the marks against the members with a vote and counts them.
 * 422 `{ problems: [{ memberId, problem }] }` when the form is wrong.
 */
function tallyOrFail(body: HeadcountBody, eligible: ReadonlySet<string>) {
  const tally = tallyHeadcount(body.entries, eligible);
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

function assertCall(rules: QuorumRules, call: QuorumCall): void {
  if (call === "second" && !rules.secondCall) {
    fail(422, "Este tipo de asamblea solo tiene una convocatoria");
  }
}

async function writeEntries(
  tx: Executor,
  headcountId: string,
  body: HeadcountBody,
): Promise<void> {
  if (body.entries.length === 0) return;
  await tx.insert(headcountEntries).values(
    body.entries.map((entry) => ({
      headcountId,
      memberId: entry.memberId,
      mark: entry.mark,
      delegateMemberId:
        entry.mark === "delegated" ? (entry.delegateId ?? null) : null,
    })),
  );
}

/** What an event says about a count: figures only, never who was there. */
function countPayload(row: Pick<HeadcountRow, keyof CountFigures>) {
  return {
    call: row.call,
    eligible: row.eligible,
    present: row.present,
    required: row.required,
    quorum: row.present >= row.required,
  };
}

type CountFigures = Pick<
  HeadcountRow,
  "call" | "eligible" | "present" | "required"
>;

/**
 * POST .../headcounts (session:moderate): stores a new count of the active
 * asociados, checked against the quorum of the call under the rules in
 * force. Refused in a draft or closed assembly.
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
    const rules = await quorumRules(locked, tx);
    assertCall(rules, body.call);
    const eligible = await eligibleMembers(tx);
    const tally = tallyOrFail(
      body,
      new Set(eligible.map((member) => member.id)),
    );
    const required = quorumRequired(
      eligible.length,
      quorumThreshold(rules, body.call),
    );
    const [created] = await tx
      .insert(headcounts)
      .values({
        assemblyId: assembly.id,
        call: body.call,
        eligible: eligible.length,
        inRoom: tally.inRoom,
        delegated: tally.delegated,
        present: tally.present,
        required,
        note: body.note ?? null,
        takenByUserId: actor.user.id,
      })
      .returning();
    await writeEntries(tx, created!.id, body);
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "headcount",
      entityId: created!.id,
      type: "headcount_recorded",
      payload: countPayload(created!),
      actor,
    });
  });
  return loadHeadcounts(assembly);
}

/**
 * PUT .../headcounts/[headcount] (session:moderate): corrects a count. The
 * members it may list are the asociados with a vote now plus those it
 * already listed; its `eligible` stays that of the moment it was taken, and
 * so does `required` unless the call changes. Optimistic lock on
 * `updatedAt` (409 when stale).
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
    const rules = await quorumRules(locked, tx);
    if (body.call !== row.call) assertCall(rules, body.call);

    const listed = await tx
      .select({ memberId: headcountEntries.memberId })
      .from(headcountEntries)
      .where(eq(headcountEntries.headcountId, row.id));
    const eligible = new Set([
      ...(await eligibleMembers(tx)).map((member) => member.id),
      ...listed.map((entry) => entry.memberId),
    ]);
    const tally = tallyOrFail(body, eligible);
    const required =
      body.call === row.call
        ? row.required
        : quorumRequired(row.eligible, quorumThreshold(rules, body.call));

    const next = {
      call: body.call,
      inRoom: tally.inRoom,
      delegated: tally.delegated,
      present: tally.present,
      required,
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
    await writeEntries(tx, row.id, body);
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "headcount",
      entityId: row.id,
      type: "headcount_corrected",
      payload: {
        ...countPayload(updated!),
        // The note is the Mesa's label for the count, not a correction note.
        changes: diffChanges(row, next, {
          keys: ["call", "inRoom", "delegated", "present", "required", "note"],
        }),
      },
      actor,
    });
  });
  return loadHeadcounts(assembly);
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
): Promise<{ vote: VoteInput; headcountId: string | null }> {
  if (vote.method === "assent") return { vote, headcountId: null };
  const latest = await latestHeadcount(assemblyId);
  if (!latest) return { vote, headcountId: null };
  const fill = settings.denominator === "present" && vote.present == null;
  return {
    vote: fill ? { ...vote, present: latest.present } : vote,
    headcountId: latest.id,
  };
}
