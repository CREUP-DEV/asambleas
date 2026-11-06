import { createError } from "h3";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  agendaItems,
  liveState,
  members,
  speakingTurns,
} from "../../db/schema";
import type {
  SpeakersDto,
  SpeakingTurnBody,
  SpeakingTurnDto,
  SpeakingTurnUpdateBody,
} from "~~/shared/types/api";
import { SPEAKING_QUEUE_MAX_LENGTH } from "~~/shared/utils/schemas/speakers";
import { getOptimisticLockTimestampMs } from "../optimisticLock";
import { toMemberRef } from "../members/dto";
import { canModerate, type Actor } from "./actor";
import { lockAssembly, type AssemblyRow } from "./assemblies";
import type { Executor } from "./events";
import { recordEvent } from "./events";
import {
  planTurnUpdate,
  sortTurns,
  turnEventType,
  turnsForActor,
  waitingQueue,
} from "./speakersRules";

/**
 * Speaking turns the Mesa writes down during the session (docs/api.md,
 * "Speaking turns"). Every write locks the assembly row first (lockAssembly,
 * "Row locks" in documents.ts), which serializes the queue: two Mesa members
 * cannot both give the floor or renumber it at once. Each change records an
 * event with entityType "speakers", so live clients refetch the list.
 */

type TurnRow = typeof speakingTurns.$inferSelect;
type MemberColumns = Pick<
  typeof members.$inferSelect,
  "id" | "acronym" | "name" | "kind"
>;

function fail(statusCode: number, message: string): never {
  throw createError({ statusCode, message });
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toTurnDto(row: {
  turn: TurnRow;
  member: MemberColumns | null;
}): SpeakingTurnDto {
  const { turn } = row;
  return {
    id: turn.id,
    member: row.member ? toMemberRef(row.member) : null,
    speaker: turn.speaker,
    agendaItemId: turn.agendaItemId,
    status: turn.status,
    position: turn.position,
    startedAt: iso(turn.startedAt),
    endedAt: iso(turn.endedAt),
    createdAt: turn.createdAt.toISOString(),
    updatedAt: turn.updatedAt.toISOString(),
  };
}

function assertOpen(assembly: Pick<AssemblyRow, "status">): void {
  if (assembly.status === "closed") fail(409, "La asamblea está cerrada");
}

async function readLiveSpeakers(
  executor: Executor,
  assemblyId: string,
): Promise<{ visible: boolean; agendaItemId: string | null }> {
  const [row] = await executor
    .select({
      visible: liveState.speakersVisible,
      agendaItemId: liveState.agendaItemId,
    })
    .from(liveState)
    .where(eq(liveState.assemblyId, assemblyId));
  return {
    visible: row?.visible ?? false,
    agendaItemId: row?.agendaItemId ?? null,
  };
}

/**
 * GET .../speakers: the Mesa (session:moderate) gets the speaking and
 * waiting turns and every turn of the agenda item in debate; anyone else
 * gets the speaking and waiting turns only while the Mesa makes them
 * visible (live_state.speakersVisible), and an empty list otherwise.
 * `include` adds turns the Mesa gets back anyway (the one a PUT changed).
 */
export async function loadSpeakers(
  actor: Actor,
  assemblyId: string,
  include: readonly string[] = [],
): Promise<SpeakersDto> {
  const live = await readLiveSpeakers(db, assemblyId);
  const moderate = canModerate(actor);
  if (!moderate && !live.visible) return { visible: false, turns: [] };

  const open = inArray(speakingTurns.status, ["speaking", "waiting"]);
  const rows = await db
    .select({
      turn: speakingTurns,
      member: {
        id: members.id,
        acronym: members.acronym,
        name: members.name,
        kind: members.kind,
      },
    })
    .from(speakingTurns)
    .leftJoin(members, eq(members.id, speakingTurns.memberId))
    .where(
      and(
        eq(speakingTurns.assemblyId, assemblyId),
        moderate
          ? or(
              open,
              live.agendaItemId
                ? eq(speakingTurns.agendaItemId, live.agendaItemId)
                : isNull(speakingTurns.agendaItemId),
              include.length > 0
                ? inArray(speakingTurns.id, [...include])
                : undefined,
            )
          : open,
      ),
    );

  const byId = new Map(rows.map((row) => [row.turn.id, row]));
  const turns = sortTurns(
    turnsForActor(
      rows.map((row) => row.turn),
      {
        moderate,
        visible: live.visible,
        agendaItemId: live.agendaItemId,
        include,
      },
    ),
  );
  return {
    visible: live.visible,
    turns: turns.map((turn) => toTurnDto(byId.get(turn.id)!)),
  };
}

/** Waiting and speaking turns of the assembly, read under the assembly lock. */
async function loadOpenTurns(executor: Executor, assemblyId: string) {
  return executor
    .select()
    .from(speakingTurns)
    .where(
      and(
        eq(speakingTurns.assemblyId, assemblyId),
        inArray(speakingTurns.status, ["speaking", "waiting"]),
      ),
    );
}

/**
 * Writes the queue positions 0..n-1 in `queue` order. Only the place in the
 * queue changes for these turns, so their `updatedAt` (the optimistic lock
 * token) is kept: reordering does not make the other Mesa members' copies
 * stale. `skipId` is the turn the caller updates itself.
 */
async function renumberQueue(
  executor: Executor,
  turns: TurnRow[],
  queue: string[],
  skipId?: string,
): Promise<void> {
  const current = new Map(turns.map((turn) => [turn.id, turn.position]));
  for (const [position, id] of queue.entries()) {
    if (id === skipId || current.get(id) === position) continue;
    await executor
      .update(speakingTurns)
      .set({ position, updatedAt: sql`${speakingTurns.updatedAt}` })
      .where(eq(speakingTurns.id, id));
  }
}

/**
 * POST .../speakers (session:moderate): adds a request to speak at the end of
 * the queue, for a member, a person's name or both. The agenda item
 * defaults to the one in debate (live state). Refused once the assembly is
 * closed.
 */
export async function addSpeakingTurn(
  actor: Actor,
  assembly: AssemblyRow,
  body: SpeakingTurnBody,
): Promise<SpeakersDto> {
  assertOpen(assembly);
  const memberId = body.memberId ?? null;
  const speaker = body.speaker ?? null;
  if (!memberId && !speaker) {
    fail(422, "Indica el miembro o el nombre de quien pide la palabra");
  }

  await db.transaction(async (tx) => {
    assertOpen(await lockAssembly(tx, assembly.id));

    if (memberId) {
      const [member] = await tx
        .select({ active: members.active })
        .from(members)
        .where(eq(members.id, memberId));
      if (!member?.active) {
        fail(422, "Ese miembro no existe o no está activo");
      }
    }

    let agendaItemId = body.agendaItemId;
    if (agendaItemId === undefined) {
      agendaItemId = (await readLiveSpeakers(tx, assembly.id)).agendaItemId;
    } else if (agendaItemId !== null) {
      const [item] = await tx
        .select({ id: agendaItems.id })
        .from(agendaItems)
        .where(
          and(
            eq(agendaItems.id, agendaItemId),
            eq(agendaItems.assemblyId, assembly.id),
          ),
        );
      if (!item) fail(422, "El punto no pertenece a esta asamblea");
    }

    const queue = waitingQueue(await loadOpenTurns(tx, assembly.id));
    if (queue.length >= SPEAKING_QUEUE_MAX_LENGTH) {
      fail(409, "La lista de palabras está llena");
    }

    const [created] = await tx
      .insert(speakingTurns)
      .values({
        assemblyId: assembly.id,
        agendaItemId,
        memberId,
        speaker,
        status: "waiting",
        position: queue.length,
        createdByUserId: actor.user.id,
      })
      .returning({ id: speakingTurns.id });
    // Close any gap left by an older queue, so positions stay 0..n-1.
    await renumberQueue(
      tx,
      queue,
      queue.map((turn) => turn.id),
    );

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "speakers",
      entityId: created!.id,
      type: "speaking_turn_added",
      // Ids only: the person's name is read through GET .../speakers.
      payload: { memberId, agendaItemId, position: queue.length },
      actor,
    });
  });

  return loadSpeakers(actor, assembly.id);
}

/**
 * PUT .../speakers/[turn] (session:moderate): gives or ends the floor,
 * cancels or restores a turn, moves it in the queue or fixes the name
 * (planTurnUpdate). Giving the floor ends the turn that was speaking.
 * Optimistic lock on the turn's `updatedAt` (409 when stale). `turnId` is
 * the route param, already validated by the handler (validateCuid). The
 * answer includes the changed turn even when the Mesa's list would leave it
 * out (cancelled on an item other than the one in debate).
 */
export async function updateSpeakingTurn(
  actor: Actor,
  assembly: AssemblyRow,
  turnId: string,
  body: SpeakingTurnUpdateBody,
): Promise<SpeakersDto> {
  assertOpen(assembly);

  await db.transaction(async (tx) => {
    assertOpen(await lockAssembly(tx, assembly.id));
    const [turn] = await tx
      .select()
      .from(speakingTurns)
      .where(
        and(
          eq(speakingTurns.id, turnId),
          eq(speakingTurns.assemblyId, assembly.id),
        ),
      );
    if (!turn) fail(404, "Turno de palabra no encontrado");
    // Every write holds the assembly lock, so this comparison cannot race.
    if (
      getOptimisticLockTimestampMs(turn.updatedAt) !==
      getOptimisticLockTimestampMs(body.updatedAt)
    ) {
      fail(409, "La lista de palabras ha cambiado. Recarga la página");
    }

    const open = await loadOpenTurns(tx, assembly.id);
    const queue = waitingQueue(open);
    const plan = planTurnUpdate({
      turn,
      queue: queue.map((item) => item.id),
      speakingIds: open
        .filter((item) => item.status === "speaking")
        .map((item) => item.id),
      status: body.status,
      position: body.position,
    });
    if (plan === "transition") {
      fail(409, "Ese cambio no es posible para este turno");
    }
    if (plan === "not_waiting") {
      fail(409, "Solo se pueden mover los turnos que esperan");
    }

    const speaker = body.speaker === undefined ? turn.speaker : body.speaker;
    if (!turn.memberId && !speaker) {
      fail(422, "Indica el miembro o el nombre de quien pide la palabra");
    }

    const now = new Date();
    const position = plan.queue.indexOf(turn.id);
    const moved = position >= 0 && position !== turn.position;
    const renamed = speaker !== turn.speaker;
    const changed = plan.status !== turn.status || moved || renamed;
    if (!changed) return;

    for (const id of plan.finishIds) {
      await tx
        .update(speakingTurns)
        .set({ status: "done", endedAt: now })
        .where(eq(speakingTurns.id, id));
    }
    await tx
      .update(speakingTurns)
      .set({
        status: plan.status,
        speaker,
        ...(position >= 0 ? { position } : {}),
        ...(plan.start ? { startedAt: now, endedAt: null } : {}),
        ...(plan.end ? { endedAt: now } : {}),
        ...(plan.reset ? { startedAt: null, endedAt: null } : {}),
      })
      .where(eq(speakingTurns.id, turn.id));
    await renumberQueue(tx, queue, plan.queue, turn.id);

    for (const id of plan.finishIds) {
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "speakers",
        entityId: id,
        type: "speaking_turn_finished",
        payload: { nextTurnId: turn.id },
        actor,
      });
    }
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "speakers",
      entityId: turn.id,
      type: turnEventType({ from: turn.status, to: plan.status, moved }),
      payload: {
        from: turn.status,
        to: plan.status,
        ...(position >= 0 ? { position } : {}),
        ...(renamed ? { renamed: true } : {}),
      },
      actor,
    });
  });

  return loadSpeakers(actor, assembly.id, [turnId]);
}

/**
 * When the assembly closes (PUT .../status to `closed`, in its transaction,
 * which already holds the assembly row lock): the turn with the floor ends
 * (`done`), the waiting ones are cancelled and attendees stop seeing the
 * list (`live_state.speakersVisible` false). Once closed every write to the
 * turns is refused, so nothing could end them later. Records the usual
 * speakers events (`reason: "assembly_closed"`) and, when the visibility
 * changes, `live_changed` and `speakers_visibility_changed`, so live clients
 * refetch. Reopening the session keeps them as they were left.
 */
export async function closeSpeakingTurns(
  tx: Executor,
  assemblyId: string,
  actor: Actor,
): Promise<void> {
  const now = new Date();
  const finished = await tx
    .update(speakingTurns)
    .set({ status: "done", endedAt: now })
    .where(
      and(
        eq(speakingTurns.assemblyId, assemblyId),
        eq(speakingTurns.status, "speaking"),
      ),
    )
    .returning({ id: speakingTurns.id });
  const cancelled = await tx
    .update(speakingTurns)
    .set({ status: "cancelled", endedAt: now })
    .where(
      and(
        eq(speakingTurns.assemblyId, assemblyId),
        eq(speakingTurns.status, "waiting"),
      ),
    )
    .returning({ id: speakingTurns.id });

  for (const { id } of finished) {
    await recordEvent(tx, {
      assemblyId,
      entityType: "speakers",
      entityId: id,
      type: "speaking_turn_finished",
      payload: { from: "speaking", to: "done", reason: "assembly_closed" },
      actor,
    });
  }
  for (const { id } of cancelled) {
    await recordEvent(tx, {
      assemblyId,
      entityType: "speakers",
      entityId: id,
      type: "speaking_turn_cancelled",
      payload: { from: "waiting", to: "cancelled", reason: "assembly_closed" },
      actor,
    });
  }

  const [hidden] = await tx
    .update(liveState)
    .set({ speakersVisible: false, updatedByUserId: actor.user.id })
    .where(
      and(
        eq(liveState.assemblyId, assemblyId),
        eq(liveState.speakersVisible, true),
      ),
    )
    .returning();
  if (!hidden) return;
  await recordEvent(tx, {
    assemblyId,
    entityType: "live",
    entityId: assemblyId,
    type: "live_changed",
    payload: {
      changed: ["speakersVisible"],
      agendaItemId: hidden.agendaItemId,
      documentId: hidden.documentId,
      amendmentId: hidden.amendmentId,
      voteId: hidden.voteId,
      speakersVisible: false,
    },
    actor,
  });
  await recordEvent(tx, {
    assemblyId,
    entityType: "speakers",
    entityId: assemblyId,
    type: "speakers_visibility_changed",
    payload: { visible: false, reason: "assembly_closed" },
    actor,
  });
}
