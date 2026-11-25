import { fail, notFound } from "../core/http";
import { stat } from "node:fs/promises";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  max,
  or,
  type SQL,
} from "drizzle-orm";
import type { z } from "zod/v4";
import { db } from "../../db";
import {
  assemblies,
  cuid,
  members,
  seatingAssignments,
  seatingGroups,
  seatingPeople,
  seatingPlans,
} from "../../db/schema";
import { GENERIC_EXECUTIVE_MEMBER_ID } from "~~/shared/constants/domain";
import type { SeatingSyncStatus } from "~~/shared/constants/domain";
import type {
  SeatingAssignmentDto,
  SeatingAssignmentsResultDto,
  SeatingDeleteResultDto,
  SeatingGroupDto,
  SeatingLayoutResultDto,
  SeatingMemberRefDto,
  SeatingPersonDto,
  SeatingPersonResultDto,
  SeatingPlanDto,
  SeatingSourceResultDto,
  SeatingSyncCounts,
  SeatingSyncResultDto,
} from "~~/shared/types/api";
import {
  MESA_DEFAULT_LABELS,
  MESA_GROUP,
  hasSeatingRoom,
} from "~~/shared/utils/seating/groups";
import { enabledSeatIds } from "~~/shared/utils/seating/layout";
import type {
  seatingAssignmentsBodySchema,
  seatingGroupCreateBodySchema,
  seatingGroupUpdateBodySchema,
  seatingLayoutBodySchema,
  seatingPersonCreateBodySchema,
  seatingPersonUpdateBodySchema,
  seatingSourceBodySchema,
} from "~~/shared/utils/schemas/seating";
import { isStale } from "../optimisticLock";
import { validateCuid } from "../validation";
import {
  assignmentsLostByLayout,
  checkAssignmentBatch,
  releaseConfirmed,
} from "../seating/assignments";
import { pgErrorCode } from "../errors";
import {
  parseSeatingImageFileName,
  seatingImagePath,
  seatingImageUrl,
} from "../seating/files";
import {
  enqueueSeatingImages,
  removeSeatingImageFiles,
  type SeatingImageJob,
} from "../seating/images";
import {
  fetchAssemblyAttendees,
  type SeatingAttendeesFetch,
} from "../seating/intranet";
import { planSeatingSync, syncChangedRows } from "../seating/syncPlan";
import { canEditSeating, canViewSeating, type Actor } from "./actor";
import type { AssemblyRow } from "./assemblies";
import { shareLockAssembly } from "./documents";
import { recordEvent, type Executor } from "./events";
import {
  canSeeAssembly,
  canSeeExecutiveMembers,
  redactMember,
} from "./visibility";

/**
 * The room of an assembly and who sits where («Sala»,
 * docs/seating-plan.md). Readers hold seating:view or seating:edit, never
 * the room view (`?view=room`, refused by requireViewer in every read):
 * names and photos of attendees are personal data and leave the server
 * only in these answers, never in an event payload, a log, a live message
 * or another export. An AGET, held online, has no room (404).
 *
 * A read creates nothing: an assembly without a plan answers an empty one.
 * The first write or sync makes the plan and the Mesa's group, with the
 * people the Mesa usually has for the type (MESA_DEFAULT_LABELS).
 *
 * Lock order, everywhere: the assembly (FOR SHARE), then the plan row, then
 * the assignment rows. A layout save, a sync's write, the source and every
 * group or person write take the plan FOR UPDATE; an assignment batch takes
 * it FOR SHARE (batches run side by side, and no layout save removes a seat
 * between a batch's check and its insert), then its seats' rows in seat
 * order FOR NO KEY UPDATE.
 */

type PlanRow = typeof seatingPlans.$inferSelect;
type GroupRow = typeof seatingGroups.$inferSelect;
type PersonRow = typeof seatingPeople.$inferSelect;
type LayoutBody = z.output<typeof seatingLayoutBodySchema>;
type AssignmentsBody = z.output<typeof seatingAssignmentsBodySchema>;
type GroupCreateBody = z.output<typeof seatingGroupCreateBodySchema>;
type GroupUpdateBody = z.output<typeof seatingGroupUpdateBodySchema>;
type PersonCreateBody = z.output<typeof seatingPersonCreateBodySchema>;
type PersonUpdateBody = z.output<typeof seatingPersonUpdateBodySchema>;
type SourceBody = z.output<typeof seatingSourceBodySchema>;

/** Reasons of the seating refusals (useApi's REASON_KEYS). */
export const SEATING_STALE_REASON = "seating_stale";
export const SEATING_SEATS_OCCUPIED_REASON = "seating_seats_occupied";
export const SEATING_NOT_FOUND_REASON = "seating_not_found";

/** A sync within this long of the last call to the Intranet calls nothing. */
export const SEATING_SYNC_THROTTLE_MS = 60_000;

/** Rows per insert: well under PostgreSQL's 65,535 parameters. */
const INSERT_CHUNK = 500;

/** What every seating 404 carries, so the client tells «no room» apart. */
const NOT_FOUND = { reason: SEATING_NOT_FOUND_REASON };

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * Whether a group's, a person's or the layout's token still holds. Null on
 * both sides matches: the layout's `updatedAt` is null while there is none
 * (saveSeatingLayout spells that case out before it compares).
 */
const sameInstant = (stored: Date | null, sent: string | null) =>
  !isStale(stored, sent);

// Guards ---------------------------------------------------------------------

export function requireSeatingReader(actor: Actor): void {
  if (!canViewSeating(actor)) fail(403, "No tienes permiso para ver la sala");
}

export function requireSeatingEditor(actor: Actor): void {
  if (!canEditSeating(actor)) {
    fail(403, "No tienes permiso para cambiar la sala");
  }
}

/** An AGET is held online: it has no room. */
export function requireSeatingRoom(assembly: Pick<AssemblyRow, "type">): void {
  if (!hasSeatingRoom(assembly.type)) {
    notFound("Esta asamblea no tiene sala", NOT_FOUND);
  }
}

// DTOs -----------------------------------------------------------------------

interface MemberRefRow {
  id: string;
  acronym: string;
  name: string;
  kind: SeatingMemberRefDto["kind"];
  university: string | null;
}

/** A group's member as the actor may read it (redactMember). */
function memberRefDto(
  actor: Actor,
  member: MemberRefRow | null,
): SeatingMemberRefDto | null {
  if (!member) return null;
  const { university, ...ref } = member;
  const visible = redactMember(actor, ref);
  return {
    ...visible,
    university: visible.id === member.id ? university : null,
  };
}

/**
 * The URL of the cached image a row names, only while the row is listed and
 * the file is of the version the row has now: never an image the Intranet
 * no longer gives (docs/seating-plan.md, section 6).
 */
function currentImageUrl(
  assemblyId: string,
  file: string | null,
  version: string | null,
  goneAt: Date | null,
): string | null {
  if (!file || !version || goneAt) return null;
  return parseSeatingImageFileName(file)?.version === version
    ? seatingImageUrl(assemblyId, file)
    : null;
}

export function toSeatingGroupDto(
  actor: Actor,
  assemblyId: string,
  row: GroupRow,
  member: MemberRefRow | null,
): SeatingGroupDto {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    intranetType: row.intranetType,
    category: row.category,
    acronym: row.acronym,
    name: row.name,
    member: memberRefDto(actor, member),
    imageUrl: currentImageUrl(
      assemblyId,
      row.logoFile,
      row.logoVersion,
      row.goneAt,
    ),
    order: row.order,
    goneAt: iso(row.goneAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSeatingPersonDto(
  assemblyId: string,
  row: PersonRow,
): SeatingPersonDto {
  return {
    id: row.id,
    groupId: row.groupId,
    source: row.source,
    firstName: row.firstName,
    surname: row.surname,
    label: row.label,
    status: row.status,
    needsSeat: row.needsSeat,
    goneAt: iso(row.goneAt),
    userId: row.userId,
    photoUrl: currentImageUrl(
      assemblyId,
      row.photoFile,
      row.photoVersion,
      row.goneAt,
    ),
    position: row.position,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const memberRefColumns = {
  id: members.id,
  acronym: members.acronym,
  name: members.name,
  kind: members.kind,
  university: members.university,
};

async function loadGroupMember(
  executor: Executor,
  memberId: string | null,
): Promise<MemberRefRow | null> {
  if (!memberId) return null;
  const [row] = await executor
    .select(memberRefColumns)
    .from(members)
    .where(eq(members.id, memberId));
  return row ?? null;
}

async function loadAssignments(
  executor: Executor,
  planId: string,
): Promise<SeatingAssignmentDto[]> {
  return executor
    .select({
      seatId: seatingAssignments.seatId,
      personId: seatingAssignments.personId,
    })
    .from(seatingAssignments)
    .where(eq(seatingAssignments.planId, planId))
    .orderBy(asc(seatingAssignments.seatId));
}

function emptyPlanDto(actor: Actor): SeatingPlanDto {
  return {
    planId: null,
    layout: null,
    layoutUpdatedAt: null,
    template: null,
    groups: [],
    people: [],
    assignments: [],
    sync: { status: null, at: null, eventName: null },
    sourceAssemblyId: null,
    can: { edit: canEditSeating(actor) },
  };
}

async function buildPlanDto(
  actor: Actor,
  assemblyId: string,
  plan: PlanRow | null,
  executor: Executor = db,
): Promise<SeatingPlanDto> {
  if (!plan) return emptyPlanDto(actor);
  const [groupRows, peopleRows, assignments] = await Promise.all([
    executor
      .select({ group: seatingGroups, member: memberRefColumns })
      .from(seatingGroups)
      .leftJoin(members, eq(members.id, seatingGroups.memberId))
      .where(eq(seatingGroups.planId, plan.id))
      .orderBy(asc(seatingGroups.createdAt), asc(seatingGroups.id)),
    executor
      .select()
      .from(seatingPeople)
      .where(eq(seatingPeople.planId, plan.id))
      .orderBy(
        asc(seatingPeople.groupId),
        asc(seatingPeople.position),
        asc(seatingPeople.id),
      ),
    loadAssignments(executor, plan.id),
  ]);
  return {
    planId: plan.id,
    layout: plan.layout,
    layoutUpdatedAt: plan.layout ? iso(plan.layoutUpdatedAt) : null,
    template: plan.layout?.template ?? null,
    groups: groupRows.map(({ group, member }) =>
      toSeatingGroupDto(actor, assemblyId, group, member?.id ? member : null),
    ),
    people: peopleRows.map((row) => toSeatingPersonDto(assemblyId, row)),
    assignments,
    sync: {
      status: plan.syncStatus,
      at: iso(plan.syncedAt),
      eventName: plan.intranetEventName,
    },
    sourceAssemblyId: plan.sourceAssemblyId,
    can: { edit: canEditSeating(actor) },
  };
}

async function findPlan(assemblyId: string): Promise<PlanRow | null> {
  const [plan] = await db
    .select()
    .from(seatingPlans)
    .where(eq(seatingPlans.assemblyId, assemblyId));
  return plan ?? null;
}

/** GET .../seating: the room as the actor may read it. Creates nothing. */
export async function loadSeatingPlan(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<SeatingPlanDto> {
  requireSeatingReader(actor);
  requireSeatingRoom(assembly);
  return buildPlanDto(actor, assembly.id, await findPlan(assembly.id));
}

// The plan row ---------------------------------------------------------------

/**
 * Makes the plan of an assembly if it has none, with the Mesa's group and
 * the people the Mesa usually has (named by hand later). Whether it made it.
 */
async function ensurePlan(
  tx: Executor,
  assembly: Pick<AssemblyRow, "id" | "type">,
): Promise<boolean> {
  const [created] = await tx
    .insert(seatingPlans)
    .values({ assemblyId: assembly.id })
    .onConflictDoNothing({ target: seatingPlans.assemblyId })
    .returning({ id: seatingPlans.id });
  if (!created) return false;
  const [mesa] = await tx
    .insert(seatingGroups)
    .values({
      planId: created.id,
      source: "manual",
      kind: "mesa",
      acronym: MESA_GROUP.acronym,
      name: MESA_GROUP.name,
    })
    .returning({ id: seatingGroups.id });
  const labels = MESA_DEFAULT_LABELS[assembly.type];
  if (labels.length > 0) {
    await tx.insert(seatingPeople).values(
      labels.map((label, position) => ({
        planId: created.id,
        groupId: mesa!.id,
        source: "placeholder" as const,
        label,
        status: "manual" as const,
        position,
      })),
    );
  }
  return true;
}

async function lockPlan(
  tx: Executor,
  assemblyId: string,
  strength: "update" | "share",
): Promise<PlanRow | null> {
  const [plan] = await tx
    .select()
    .from(seatingPlans)
    .where(eq(seatingPlans.assemblyId, assemblyId))
    .for(strength);
  return plan ?? null;
}

/** The plan, made if missing, locked FOR UPDATE. */
async function ensureLockedPlan(
  tx: Executor,
  assembly: Pick<AssemblyRow, "id" | "type">,
): Promise<PlanRow> {
  await ensurePlan(tx, assembly);
  const plan = await lockPlan(tx, assembly.id, "update");
  if (!plan) notFound("No hay sala", NOT_FOUND);
  return plan;
}

/** The existing plan, locked FOR UPDATE, or 404. */
async function requireLockedPlan(
  tx: Executor,
  assemblyId: string,
): Promise<PlanRow> {
  const plan = await lockPlan(tx, assemblyId, "update");
  if (!plan) notFound("Esta asamblea aún no tiene sala", NOT_FOUND);
  return plan;
}

/** The member ids of the groups of some people, for event payloads. */
async function memberIdsOfPeople(
  tx: Executor,
  planId: string,
  personIds: readonly string[],
): Promise<string[]> {
  if (personIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ memberId: seatingGroups.memberId })
    .from(seatingPeople)
    .innerJoin(seatingGroups, eq(seatingGroups.id, seatingPeople.groupId))
    .where(
      and(
        eq(seatingPeople.planId, planId),
        inArray(seatingPeople.id, [...personIds]),
      ),
    );
  return rows
    .map((row) => row.memberId)
    .filter((id): id is string => id !== null)
    .sort();
}

// Layout ---------------------------------------------------------------------

/**
 * PUT .../seating/layout. `updatedAt` is the layout's token as read: null
 * only while there is none (a null token over a layout is stale too). An
 * edit that removes or disables occupied seats answers 409
 * `seating_seats_occupied` with them unless `releaseSeats` confirms every
 * one, seat and person (releaseConfirmed); then those people go back to the
 * tray in the same transaction. Someone seated there after the 409 was
 * never confirmed: the same 409 again, with the new list.
 */
export async function saveSeatingLayout(
  actor: Actor,
  assembly: AssemblyRow,
  body: LayoutBody,
): Promise<SeatingLayoutResultDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const plan = await ensureLockedPlan(tx, assembly);
    const stale =
      plan.layout === null || plan.layoutUpdatedAt === null
        ? body.updatedAt !== null
        : body.updatedAt === null ||
          !sameInstant(plan.layoutUpdatedAt, body.updatedAt);
    if (stale) {
      fail(409, "Alguien ha cambiado la sala mientras la editabas", {
        reason: SEATING_STALE_REASON,
        layout: plan.layout,
        layoutUpdatedAt: plan.layout ? iso(plan.layoutUpdatedAt) : null,
      });
    }

    // The plan is locked FOR UPDATE: no batch changes a seat meanwhile.
    const lost = assignmentsLostByLayout(
      body.layout,
      await loadAssignments(tx, plan.id),
    );
    if (!releaseConfirmed(lost, body.releaseSeats)) {
      fail(409, "El cambio quita asientos ocupados", {
        reason: SEATING_SEATS_OCCUPIED_REASON,
        seats: lost,
      });
    }
    if (lost.length > 0) {
      await tx.delete(seatingAssignments).where(
        and(
          eq(seatingAssignments.planId, plan.id),
          inArray(
            seatingAssignments.seatId,
            lost.map((row) => row.seatId),
          ),
        ),
      );
    }

    const now = new Date();
    await tx
      .update(seatingPlans)
      .set({
        layout: body.layout,
        layoutUpdatedAt: now,
        layoutUpdatedByUserId: actor.user.id,
      })
      .where(eq(seatingPlans.id, plan.id));
    const tableSeats = body.layout.tables.reduce(
      (sum, table) => sum + table.seats.length,
      0,
    );
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "seating",
      entityId: plan.id,
      type: "seating_layout_updated",
      payload: {
        tables: body.layout.tables.length,
        seats: tableSeats + body.layout.chairs.length,
        chairs: body.layout.chairs.length,
        fixtures: body.layout.fixtures.length,
        template: body.layout.template.kind,
        released: lost.length,
        memberIds: await memberIdsOfPeople(
          tx,
          plan.id,
          lost.map((row) => row.personId),
        ),
      },
      actor,
    });
    return {
      layout: body.layout,
      layoutUpdatedAt: now.toISOString(),
      released: lost,
    };
  });
}

// Assignments ----------------------------------------------------------------

/** A batch found the rows it compared changed: the client's view is stale. */
class SeatingBatchRaceError extends Error {
  override name = "SeatingBatchRaceError";
}

/**
 * A batch that raced another one: two batches filled the same empty seat or
 * seated the same person (unique violation), or deadlocked. Both mean the
 * client's view is stale.
 */
function isBatchRace(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === "23505" || code === "40P01";
}

/**
 * POST .../seating/assignments: up to 600 seat changes, all or none, each
 * compared with what the client saw there (checkAssignmentBatch). A
 * mismatch answers 409 `seating_stale` with who sits on the conflicting
 * seats now, and so does a person it may not seat (gone from the plan, or
 * marked «No necesita asiento»). The batch deletes the rows it saw on the
 * seats it changes (locked, so still there) and inserts the new occupants;
 * a seat it saw empty is never deleted, so one another batch filled
 * meanwhile makes the insert fail (unique violation, 409). Records one
 * `seating_assignments_changed` (counts and member ids). Returns every
 * assignment of the plan.
 */
export async function applySeatingAssignments(
  actor: Actor,
  assembly: AssemblyRow,
  body: AssignmentsBody,
): Promise<SeatingAssignmentsResultDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  const seatIds = body.ops.map((op) => op.seatId);
  const nextPeople = body.ops.flatMap((op) => (op.next ? [op.next] : []));
  try {
    return await db.transaction(async (tx) => {
      await shareLockAssembly(tx, assembly.id);
      const plan = await lockPlan(tx, assembly.id, "share");
      const touched: SQL[] = [inArray(seatingAssignments.seatId, seatIds)];
      if (nextPeople.length > 0) {
        touched.push(inArray(seatingAssignments.personId, nextPeople));
      }
      const current = plan
        ? await tx
            .select({
              seatId: seatingAssignments.seatId,
              personId: seatingAssignments.personId,
            })
            .from(seatingAssignments)
            .where(and(eq(seatingAssignments.planId, plan.id), or(...touched)))
            .orderBy(asc(seatingAssignments.seatId))
            .for("no key update")
        : [];
      const known =
        plan && nextPeople.length > 0
          ? await tx
              .select({
                id: seatingPeople.id,
                needsSeat: seatingPeople.needsSeat,
              })
              .from(seatingPeople)
              .where(
                and(
                  eq(seatingPeople.planId, plan.id),
                  inArray(seatingPeople.id, nextPeople),
                ),
              )
          : [];
      const check = checkAssignmentBatch({
        ops: body.ops,
        current,
        enabledSeats: plan?.layout
          ? enabledSeatIds(plan.layout)
          : new Set<string>(),
        // Someone marked «No necesita asiento» holds no seat: a tab that
        // has not seen the mark yet is stale.
        people: new Set(
          known.filter((row) => row.needsSeat).map((row) => row.id),
        ),
      });
      if (!check.ok) {
        fail(409, "Alguien ha cambiado esos asientos a la vez", {
          reason: SEATING_STALE_REASON,
          ...check.conflict,
        });
      }
      const { write } = check;
      if (!plan || (write.deletes.length === 0 && write.inserts.length === 0)) {
        return { assignments: plan ? await loadAssignments(tx, plan.id) : [] };
      }

      if (write.deletes.length > 0) {
        const deleted = await tx
          .delete(seatingAssignments)
          .where(
            and(
              eq(seatingAssignments.planId, plan.id),
              or(
                ...write.deletes.map((row) =>
                  and(
                    eq(seatingAssignments.seatId, row.seatId),
                    eq(seatingAssignments.personId, row.personId),
                  ),
                ),
              ),
            ),
          )
          .returning({ seatId: seatingAssignments.seatId });
        // The rows were locked when compared: they are all still there.
        if (deleted.length !== write.deletes.length) {
          throw new SeatingBatchRaceError();
        }
      }
      if (write.inserts.length > 0) {
        await tx.insert(seatingAssignments).values(
          write.inserts.map((row) => ({
            planId: plan.id,
            seatId: row.seatId,
            personId: row.personId,
            updatedByUserId: actor.user.id,
          })),
        );
      }
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "seating",
        entityId: plan.id,
        type: "seating_assignments_changed",
        payload: {
          placed: write.placed,
          moved: write.moved,
          removed: write.removed,
          memberIds: await memberIdsOfPeople(tx, plan.id, write.personIds),
        },
        actor,
      });
      return { assignments: await loadAssignments(tx, plan.id) };
    });
  } catch (error) {
    if (!(error instanceof SeatingBatchRaceError) && !isBatchRace(error)) {
      throw error;
    }
    // Read again, outside the failed transaction: who sits there now.
    const plan = await findPlan(assembly.id);
    const rows = plan
      ? await db
          .select({
            seatId: seatingAssignments.seatId,
            personId: seatingAssignments.personId,
          })
          .from(seatingAssignments)
          .where(
            and(
              eq(seatingAssignments.planId, plan.id),
              inArray(seatingAssignments.seatId, seatIds),
            ),
          )
      : [];
    const occupant = new Map(rows.map((row) => [row.seatId, row.personId]));
    fail(409, "Alguien ha cambiado esos asientos a la vez", {
      reason: SEATING_STALE_REASON,
      seats: [...seatIds]
        .sort()
        .map((seatId) => ({ seatId, personId: occupant.get(seatId) ?? null })),
      unavailableSeatIds: [],
      unknownPersonIds: [],
    });
  }
}

// Sync -----------------------------------------------------------------------

const SYNC_STATUS: Record<SeatingAttendeesFetch["outcome"], SeatingSyncStatus> =
  {
    ok: "ok",
    notFound: "not_found",
    unavailable: "unavailable",
    failed: "failed",
    unconfigured: "unconfigured",
  };

/** Reads the attendees; tests replace it. */
export type AttendeesFetcher = typeof fetchAssemblyAttendees;

/**
 * POST .../seating/sync (docs/seating-plan.md, section 5). Within
 * SEATING_SYNC_THROTTLE_MS of the last call to the Intranet, whatever it
 * answered, it answers the stored plan and calls nothing, so several
 * editors' tabs never spend the Intranet's 30 requests a minute. Otherwise:
 *
 * 1. a short transaction makes the plan if missing and claims the call
 *    (compare-and-set on `syncedAt`);
 * 2. the Intranet is read outside any transaction (never holding the plan
 *    while it answers), for the assembly's type and number, or those of
 *    `sourceAssemblyId`;
 * 3. a second transaction writes what changed (planSeatingSync) with the
 *    plan FOR UPDATE, and the status. Only `ok` touches groups and people;
 *    `not_found` forgets the event; `unavailable` (the Intranet without the
 *    route), `failed` and `unconfigured` keep everything.
 *
 * `seating_synced` (status and counts, never a name) is recorded only when
 * the status or a row changed: a sync that brings nothing new writes the
 * time of the call and wakes nobody. Once committed, files of images that
 * changed go and the new ones are queued.
 */
export async function syncSeating(
  actor: Actor,
  assembly: AssemblyRow,
  fetchAttendees: AttendeesFetcher = fetchAssemblyAttendees,
): Promise<SeatingSyncResultDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);

  const claimed = await db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    await ensurePlan(tx, assembly);
    const now = new Date();
    const cutoff = new Date(now.getTime() - SEATING_SYNC_THROTTLE_MS);
    const [row] = await tx
      .update(seatingPlans)
      .set({ syncedAt: now })
      .where(
        and(
          eq(seatingPlans.assemblyId, assembly.id),
          or(isNull(seatingPlans.syncedAt), lte(seatingPlans.syncedAt, cutoff)),
        ),
      )
      .returning();
    return row ?? null;
  });
  if (!claimed) {
    return {
      called: false,
      counts: null,
      plan: await buildPlanDto(actor, assembly.id, await findPlan(assembly.id)),
    };
  }

  const source = claimed.sourceAssemblyId
    ? await db.query.assemblies.findFirst({
        where: eq(assemblies.id, claimed.sourceAssemblyId),
      })
    : null;
  const target = source ?? assembly;
  const result = await fetchAttendees(target.type, target.number);

  const written = await db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const plan = await requireLockedPlan(tx, assembly.id);
    // The source changed meanwhile: the next sync reads the new one.
    if (plan.sourceAssemblyId !== claimed.sourceAssemblyId) {
      return { plan, counts: null, removeFiles: [], images: [] };
    }
    const status = SYNC_STATUS[result.outcome];
    const set: Partial<typeof seatingPlans.$inferInsert> = {
      syncStatus: status,
    };
    let counts: SeatingSyncCounts | null = null;
    let removeFiles: string[] = [];
    let images: SeatingImageJob[] = [];

    if (result.outcome === "ok") {
      const [groups, people] = await Promise.all([
        tx
          .select()
          .from(seatingGroups)
          .where(eq(seatingGroups.planId, plan.id)),
        tx
          .select()
          .from(seatingPeople)
          .where(eq(seatingPeople.planId, plan.id)),
      ]);
      const accountIds = result.data.accounts.map((account) => account.id);
      const linked =
        accountIds.length > 0
          ? await tx
              .select({ id: members.id, intranetId: members.intranetId })
              .from(members)
              .where(inArray(members.intranetId, accountIds))
          : [];
      const changes = planSeatingSync({
        groups,
        people,
        response: result.data,
        memberIdByIntranetId: new Map(
          linked.flatMap((row) =>
            row.intranetId === null ? [] : [[row.intranetId, row.id]],
          ),
        ),
        now: new Date(),
        newId: cuid,
      });
      for (let i = 0; i < changes.groupInserts.length; i += INSERT_CHUNK) {
        await tx
          .insert(seatingGroups)
          .values(
            changes.groupInserts
              .slice(i, i + INSERT_CHUNK)
              .map((row) => ({ ...row, planId: plan.id })),
          );
      }
      for (const update of changes.groupUpdates) {
        await tx
          .update(seatingGroups)
          .set(update.set)
          .where(eq(seatingGroups.id, update.id));
      }
      for (let i = 0; i < changes.peopleInserts.length; i += INSERT_CHUNK) {
        await tx
          .insert(seatingPeople)
          .values(
            changes.peopleInserts
              .slice(i, i + INSERT_CHUNK)
              .map((row) => ({ ...row, planId: plan.id })),
          );
      }
      for (const update of changes.peopleUpdates) {
        await tx
          .update(seatingPeople)
          .set(update.set)
          .where(eq(seatingPeople.id, update.id));
      }
      set.intranetEventId = result.data.event.id;
      set.intranetEventName = result.data.event.name;
      counts = changes.counts;
      removeFiles = changes.removeFiles;
      images = changes.images.map((image) => ({
        ...image,
        assemblyId: assembly.id,
        planId: plan.id,
      }));
    } else if (result.outcome === "notFound") {
      set.intranetEventId = null;
      set.intranetEventName = null;
    }

    await tx.update(seatingPlans).set(set).where(eq(seatingPlans.id, plan.id));
    const eventChanged =
      set.intranetEventId !== undefined &&
      (set.intranetEventId !== plan.intranetEventId ||
        set.intranetEventName !== plan.intranetEventName);
    if (
      status !== plan.syncStatus ||
      eventChanged ||
      (counts !== null && syncChangedRows(counts))
    ) {
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "seating",
        entityId: plan.id,
        type: "seating_synced",
        payload: {
          status,
          ...(counts ? { groups: counts.groups, people: counts.people } : {}),
        },
        actor,
      });
    }
    return { plan, counts, removeFiles, images };
  });

  // Once committed: a file whose row still named it would be served a 404.
  await removeSeatingImageFiles(written.plan.id, written.removeFiles);
  await enqueueSeatingImages(written.images);
  return {
    called: true,
    counts: written.counts,
    plan: await buildPlanDto(actor, assembly.id, await findPlan(assembly.id)),
  };
}

// Source ---------------------------------------------------------------------

/**
 * PUT .../seating/source: read another assembly's Intranet attendees (an
 * AGE held next to an AGO without an event of its own), or null for its
 * own. `expected` is the source the client read, null being a value; any
 * other answers 409 `seating_stale` with the current one. A change clears
 * the last sync, so the next one reads the new source at once.
 */
export async function setSeatingSource(
  actor: Actor,
  assembly: AssemblyRow,
  body: SourceBody,
): Promise<SeatingSourceResultDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  if (body.sourceAssemblyId === assembly.id) {
    fail(422, "La asamblea ya lee sus propios inscritos");
  }
  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    // Without a plan, its own attendees asked for its own: nothing to make.
    if (
      body.expected === null &&
      body.sourceAssemblyId === null &&
      !(await lockPlan(tx, assembly.id, "update"))
    ) {
      return { sourceAssemblyId: null };
    }
    // Compared on the locked row, never on one read before it existed: two
    // first choices at once would both pass, and the second overwrite the
    // first (the second's insert waits for the first and then finds it).
    const plan = await ensureLockedPlan(tx, assembly);
    const current = plan.sourceAssemblyId;
    if (current !== body.expected) {
      fail(409, "Alguien ha cambiado de dónde se leen los inscritos", {
        reason: SEATING_STALE_REASON,
        sourceAssemblyId: current,
      });
    }
    if (body.sourceAssemblyId === current) return { sourceAssemblyId: current };
    if (body.sourceAssemblyId) {
      const source = await tx.query.assemblies.findFirst({
        where: eq(assemblies.id, body.sourceAssemblyId),
      });
      if (!source || !canSeeAssembly(actor, source)) {
        fail(422, "Asamblea no encontrada");
      }
    }
    await tx
      .update(seatingPlans)
      .set({
        sourceAssemblyId: body.sourceAssemblyId,
        syncedAt: null,
        syncStatus: null,
        intranetEventId: null,
        intranetEventName: null,
      })
      .where(eq(seatingPlans.id, plan.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "seating",
      entityId: plan.id,
      type: "seating_source_changed",
      payload: {
        own: body.sourceAssemblyId === null,
        sourceAssemblyId: body.sourceAssemblyId,
        previousSourceAssemblyId: current,
      },
      actor,
    });
    return { sourceAssemblyId: body.sourceAssemblyId };
  });
}

// Groups ---------------------------------------------------------------------

/**
 * The member a group made by hand stands for: a real member (never the
 * generic "CEA"), and an office only for an actor who sees the offices
 * (every seating editor does, through its key; still checked).
 */
async function requireLinkableMember(
  tx: Executor,
  actor: Actor,
  memberId: string,
): Promise<MemberRefRow> {
  if (memberId === GENERIC_EXECUTIVE_MEMBER_ID) {
    fail(422, "La CEA no es un miembro", { reason: "executive_member" });
  }
  const member = await loadGroupMember(tx, memberId);
  if (!member) fail(422, "Miembro no encontrado");
  if (member.kind === "executive" && !canSeeExecutiveMembers(actor)) {
    fail(422, "No puedes elegir ese cargo", { reason: "executive_member" });
  }
  return member;
}

async function requireGroup(
  tx: Executor,
  planId: string,
  param: string | undefined,
): Promise<GroupRow> {
  const id = validateCuid(param, "Grupo");
  const [row] = await tx
    .select()
    .from(seatingGroups)
    .where(and(eq(seatingGroups.id, id), eq(seatingGroups.planId, planId)));
  if (!row) notFound("Ese grupo ya no está en la sala", NOT_FOUND);
  return row;
}

/** POST .../seating/groups: a group made by hand («Prensa»). */
export async function createSeatingGroup(
  actor: Actor,
  assembly: AssemblyRow,
  body: GroupCreateBody,
): Promise<SeatingGroupDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const plan = await ensureLockedPlan(tx, assembly);
    const member = body.memberId
      ? await requireLinkableMember(tx, actor, body.memberId)
      : null;
    const [row] = await tx
      .insert(seatingGroups)
      .values({
        planId: plan.id,
        source: "manual",
        kind: body.kind ?? "other",
        acronym: body.acronym,
        name: body.name,
        memberId: member?.id ?? null,
      })
      .returning();
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "seating",
      entityId: plan.id,
      type: "seating_group_created",
      payload: { groupId: row!.id, kind: row!.kind, memberId: row!.memberId },
      actor,
    });
    return toSeatingGroupDto(actor, assembly.id, row!, member);
  });
}

/**
 * PATCH .../seating/groups/[group]: only groups made by hand (an Intranet
 * account changes in the Intranet), and the Mesa keeps its kind. Optimistic
 * lock on `updatedAt`. The event names the fields changed, never a value.
 */
export async function updateSeatingGroup(
  actor: Actor,
  assembly: AssemblyRow,
  groupParam: string | undefined,
  body: GroupUpdateBody,
): Promise<SeatingGroupDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const plan = await requireLockedPlan(tx, assembly.id);
    const row = await requireGroup(tx, plan.id, groupParam);
    if (row.source === "intranet") {
      fail(422, "Una cuenta de la Intranet se cambia en la Intranet");
    }
    if (row.kind === "mesa" && body.kind !== undefined) {
      fail(422, "La Mesa no cambia de tipo");
    }
    if (!sameInstant(row.updatedAt, body.updatedAt)) {
      fail(409, "Alguien ha cambiado este grupo mientras lo editabas", {
        reason: SEATING_STALE_REASON,
        group: toSeatingGroupDto(
          actor,
          assembly.id,
          row,
          await loadGroupMember(tx, row.memberId),
        ),
      });
    }
    const set: Partial<typeof seatingGroups.$inferInsert> = {};
    if (body.acronym !== undefined && body.acronym !== row.acronym) {
      set.acronym = body.acronym;
    }
    if (body.name !== undefined && body.name !== row.name) set.name = body.name;
    if (body.kind !== undefined && body.kind !== row.kind) set.kind = body.kind;
    if (body.memberId !== undefined && body.memberId !== row.memberId) {
      if (body.memberId) await requireLinkableMember(tx, actor, body.memberId);
      set.memberId = body.memberId;
    }
    if (Object.keys(set).length === 0) {
      return toSeatingGroupDto(
        actor,
        assembly.id,
        row,
        await loadGroupMember(tx, row.memberId),
      );
    }
    const [updated] = await tx
      .update(seatingGroups)
      .set(set)
      .where(eq(seatingGroups.id, row.id))
      .returning();
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "seating",
      entityId: plan.id,
      type: "seating_group_updated",
      payload: {
        groupId: row.id,
        kind: updated!.kind,
        fields: Object.keys(set).sort(),
        memberId: updated!.memberId,
      },
      actor,
    });
    return toSeatingGroupDto(
      actor,
      assembly.id,
      updated!,
      await loadGroupMember(tx, updated!.memberId),
    );
  });
}

/**
 * DELETE .../seating/groups/[group]: a group made by hand, with its people;
 * their seats go back free. Never the Mesa, nor an Intranet account (the
 * next sync would bring it back).
 */
export async function deleteSeatingGroup(
  actor: Actor,
  assembly: AssemblyRow,
  groupParam: string | undefined,
): Promise<SeatingDeleteResultDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const plan = await requireLockedPlan(tx, assembly.id);
    const row = await requireGroup(tx, plan.id, groupParam);
    if (row.source === "intranet") {
      fail(422, "Una cuenta de la Intranet no se borra: sale de la sala sola");
    }
    if (row.kind === "mesa") fail(422, "La Mesa no se borra");
    const people = await tx
      .select({ id: seatingPeople.id })
      .from(seatingPeople)
      .where(eq(seatingPeople.groupId, row.id));
    const released =
      people.length > 0
        ? await tx
            .delete(seatingAssignments)
            .where(
              and(
                eq(seatingAssignments.planId, plan.id),
                inArray(
                  seatingAssignments.personId,
                  people.map((person) => person.id),
                ),
              ),
            )
            .returning({
              seatId: seatingAssignments.seatId,
              personId: seatingAssignments.personId,
            })
        : [];
    await tx.delete(seatingGroups).where(eq(seatingGroups.id, row.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "seating",
      entityId: plan.id,
      type: "seating_group_deleted",
      payload: {
        groupId: row.id,
        kind: row.kind,
        people: people.length,
        released: released.length,
        memberId: row.memberId,
      },
      actor,
    });
    return { released: sortAssignments(released) };
  });
}

const sortAssignments = (rows: SeatingAssignmentDto[]) =>
  [...rows].sort((a, b) =>
    a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0,
  );

// People ---------------------------------------------------------------------

async function requirePerson(
  tx: Executor,
  planId: string,
  param: string | undefined,
): Promise<PersonRow> {
  const id = validateCuid(param, "Persona");
  const [row] = await tx
    .select()
    .from(seatingPeople)
    .where(and(eq(seatingPeople.id, id), eq(seatingPeople.planId, planId)));
  if (!row) notFound("Esa persona ya no está en la sala", NOT_FOUND);
  return row;
}

/**
 * The platform account a person may be linked to: only a person of the
 * Mesa, and only to the editor's own account («Es mi cuenta»). No list of
 * accounts reaches a seating editor, so nobody links someone else's; a link
 * already stored stays as it is (the caller skips an unchanged value), and
 * null unlinks it.
 */
function requireOwnMesaLink(
  actor: Actor,
  group: Pick<GroupRow, "kind">,
  userId: string,
): void {
  if (group.kind !== "mesa") {
    fail(422, "Solo una persona de la Mesa se vincula a su cuenta");
  }
  if (userId !== actor.user.id) {
    fail(422, "Solo puedes vincular una persona a tu propia cuenta");
  }
}

async function groupOf(tx: Executor, groupId: string) {
  const [group] = await tx
    .select({ kind: seatingGroups.kind, memberId: seatingGroups.memberId })
    .from(seatingGroups)
    .where(eq(seatingGroups.id, groupId));
  return group ?? null;
}

/**
 * POST .../seating/people: someone added by hand (with a name) or a seat
 * kept without one, in any group of the plan, after its last person.
 */
export async function createSeatingPerson(
  actor: Actor,
  assembly: AssemblyRow,
  body: PersonCreateBody,
): Promise<SeatingPersonDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const plan = await requireLockedPlan(tx, assembly.id);
    const group = await requireGroup(tx, plan.id, body.groupId);
    if (body.source === "manual" && body.userId) {
      requireOwnMesaLink(actor, group, body.userId);
    }
    const [last] = await tx
      .select({ value: max(seatingPeople.position) })
      .from(seatingPeople)
      .where(eq(seatingPeople.groupId, group.id));
    const manual = body.source === "manual" ? body : null;
    const [row] = await tx
      .insert(seatingPeople)
      .values({
        planId: plan.id,
        groupId: group.id,
        source: body.source,
        firstName: manual?.firstName ?? null,
        surname: manual?.surname ?? null,
        label: body.label ?? null,
        status: "manual",
        needsSeat: body.needsSeat ?? true,
        userId: manual?.userId ?? null,
        position: (last?.value ?? -1) + 1,
      })
      .returning();
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "seating",
      entityId: plan.id,
      type: "seating_person_created",
      payload: {
        personId: row!.id,
        groupId: group.id,
        source: row!.source,
        kind: group.kind,
        memberId: group.memberId,
      },
      actor,
    });
    return toSeatingPersonDto(assembly.id, row!);
  });
}

/**
 * PATCH .../seating/people/[person]. Everyone takes `needsSeat`, `label`
 * and `position`; names and `userId` only people added by hand and
 * placeholders (an Intranet registration changes in the Intranet). A
 * placeholder given a first name becomes a person added by hand. «No
 * necesita asiento» frees the person's seat in the same write.
 */
export async function updateSeatingPerson(
  actor: Actor,
  assembly: AssemblyRow,
  personParam: string | undefined,
  body: PersonUpdateBody,
): Promise<SeatingPersonResultDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const plan = await requireLockedPlan(tx, assembly.id);
    const row = await requirePerson(tx, plan.id, personParam);
    const names =
      body.firstName !== undefined ||
      body.surname !== undefined ||
      body.userId !== undefined;
    if (row.source === "intranet" && names) {
      fail(
        422,
        "De una persona de la Intranet solo cambian el cargo, el orden y si necesita asiento",
      );
    }
    if (
      row.source === "placeholder" &&
      body.firstName === undefined &&
      body.surname !== undefined &&
      body.surname !== null
    ) {
      fail(422, "Una plaza sin nombre necesita un nombre");
    }
    if (!sameInstant(row.updatedAt, body.updatedAt)) {
      fail(409, "Alguien ha cambiado esta persona mientras la editabas", {
        reason: SEATING_STALE_REASON,
        person: toSeatingPersonDto(assembly.id, row),
      });
    }

    const set: Partial<typeof seatingPeople.$inferInsert> = {};
    if (body.needsSeat !== undefined && body.needsSeat !== row.needsSeat) {
      set.needsSeat = body.needsSeat;
    }
    if (body.label !== undefined && body.label !== row.label) {
      set.label = body.label;
    }
    if (body.position !== undefined && body.position !== row.position) {
      set.position = body.position;
    }
    if (body.firstName !== undefined && body.firstName !== row.firstName) {
      set.firstName = body.firstName;
    }
    if (body.surname !== undefined && body.surname !== row.surname) {
      set.surname = body.surname;
    }
    if (body.userId !== undefined && body.userId !== row.userId) {
      if (body.userId) {
        const group = await groupOf(tx, row.groupId);
        requireOwnMesaLink(actor, group ?? { kind: "other" }, body.userId);
      }
      set.userId = body.userId;
    }
    if (row.source === "placeholder" && set.firstName !== undefined) {
      set.source = "manual";
    }
    if (Object.keys(set).length === 0) {
      return { person: toSeatingPersonDto(assembly.id, row), released: [] };
    }

    const released =
      set.needsSeat === false
        ? await tx
            .delete(seatingAssignments)
            .where(
              and(
                eq(seatingAssignments.planId, plan.id),
                eq(seatingAssignments.personId, row.id),
              ),
            )
            .returning({
              seatId: seatingAssignments.seatId,
              personId: seatingAssignments.personId,
            })
        : [];
    const [updated] = await tx
      .update(seatingPeople)
      .set(set)
      .where(eq(seatingPeople.id, row.id))
      .returning();
    const group = await groupOf(tx, row.groupId);
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "seating",
      entityId: plan.id,
      type: "seating_person_updated",
      payload: {
        personId: row.id,
        groupId: row.groupId,
        source: updated!.source,
        fields: Object.keys(set)
          .filter((key) => key !== "source")
          .sort(),
        ...(set.needsSeat !== undefined ? { needsSeat: set.needsSeat } : {}),
        released: released.length,
        memberId: group?.memberId ?? null,
      },
      actor,
    });
    return { person: toSeatingPersonDto(assembly.id, updated!), released };
  });
}

/**
 * DELETE .../seating/people/[person]: someone added by hand or a
 * placeholder; their seat goes back free. Never an Intranet registration:
 * «No necesita asiento» takes it out instead.
 */
export async function deleteSeatingPerson(
  actor: Actor,
  assembly: AssemblyRow,
  personParam: string | undefined,
): Promise<SeatingDeleteResultDto> {
  requireSeatingEditor(actor);
  requireSeatingRoom(assembly);
  return db.transaction(async (tx) => {
    await shareLockAssembly(tx, assembly.id);
    const plan = await requireLockedPlan(tx, assembly.id);
    const row = await requirePerson(tx, plan.id, personParam);
    if (row.source === "intranet") {
      fail(
        422,
        "Una persona de la Intranet no se borra: márcala como que no necesita asiento",
      );
    }
    const released = await tx
      .delete(seatingAssignments)
      .where(
        and(
          eq(seatingAssignments.planId, plan.id),
          eq(seatingAssignments.personId, row.id),
        ),
      )
      .returning({
        seatId: seatingAssignments.seatId,
        personId: seatingAssignments.personId,
      });
    await tx.delete(seatingPeople).where(eq(seatingPeople.id, row.id));
    const group = await groupOf(tx, row.groupId);
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "seating",
      entityId: plan.id,
      type: "seating_person_deleted",
      payload: {
        personId: row.id,
        groupId: row.groupId,
        source: row.source,
        released: released.length,
        memberId: group?.memberId ?? null,
      },
      actor,
    });
    return { released };
  });
}

// Images ---------------------------------------------------------------------

function imageNotFound(): never {
  fail(404, "Imagen no encontrada");
}

/**
 * The file behind GET .../seating/images/[file]: a name of the pattern
 * that a group (logo) or a person (photo) of this assembly's plan names
 * now, of the version the row has now, and is not gone, so nothing the
 * Intranet no longer gives is served.
 */
export async function resolveSeatingImage(
  actor: Actor,
  assembly: AssemblyRow,
  param: string | undefined,
): Promise<string> {
  requireSeatingReader(actor);
  requireSeatingRoom(assembly);
  const name = param ?? "";
  const parsed = parseSeatingImageFileName(name);
  if (!parsed) imageNotFound();
  const plan = await findPlan(assembly.id);
  if (!plan) imageNotFound();
  const [row] =
    parsed.kind === "logo"
      ? await db
          .select({ id: seatingGroups.id })
          .from(seatingGroups)
          .where(
            and(
              eq(seatingGroups.id, parsed.id),
              eq(seatingGroups.planId, plan.id),
              eq(seatingGroups.logoFile, name),
              eq(seatingGroups.logoVersion, parsed.version),
              isNull(seatingGroups.goneAt),
            ),
          )
      : await db
          .select({ id: seatingPeople.id })
          .from(seatingPeople)
          .where(
            and(
              eq(seatingPeople.id, parsed.id),
              eq(seatingPeople.planId, plan.id),
              eq(seatingPeople.photoFile, name),
              eq(seatingPeople.photoVersion, parsed.version),
              isNull(seatingPeople.goneAt),
            ),
          );
  if (!row) imageNotFound();
  const path = seatingImagePath(plan.id, name);
  if (!path) imageNotFound();
  const isFile = await stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!isFile) imageNotFound();
  return path;
}
