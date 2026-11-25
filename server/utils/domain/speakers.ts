import { fail } from "../core/http";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  agendaItems,
  amendments,
  documents,
  liveState,
  members,
  speakingTurns,
} from "../../db/schema";
import type {
  SpeakerNoteBody,
  SpeakerNotesDto,
  SpeakersDto,
  SpeakingTurnBody,
  SpeakingTurnDto,
  SpeakingTurnUpdateBody,
} from "~~/shared/types/api";
import { SPEAKING_QUEUE_MAX_LENGTH } from "~~/shared/utils/schemas/speakers";
import { DEFAULT_SPEAKING_LIMIT_SECONDS } from "~~/shared/utils/schemas/assembly";
import { getOptimisticLockTimestampMs } from "../optimisticLock";
import { toMemberRef } from "../members/dto";
import { canModerate, canNoteSpeakers, type Actor } from "./actor";
import { loadVisibleAmendmentIds } from "./documents";
import { lockAssembly } from "./agendaWrites";
import type { AssemblyRow } from "./assemblies";
import type { Executor } from "./events";
import { recordEvent } from "./events";
import { assertSessionOpen } from "./sessionOpen";
import { speakerUpdateClearsOnly } from "~~/shared/utils/sessionGate";
import {
  planTurnUpdate,
  resumableTurn,
  sortTurns,
  speakerHistory,
  turnEventType,
  turnsForActor,
  turnUpdateExpectationsHold,
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

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * A turn as the actor may read it: who spoke, by the member's own acronym
 * and the person's name, for everyone, an executive office's included
 * (user's decision of 2026-11-21: whoever speaks in the room is no secret,
 * so a turn never reads "CEA"). Elsewhere the offices stay redacted
 * (redactMember).
 */
function toTurnDto(
  actor: Actor,
  row: {
    turn: TurnRow;
    member: MemberColumns | null;
  },
  /** Only the sheet and the notes say which amendment; null elsewhere. */
  withAmendment = false,
): SpeakingTurnDto {
  const { turn } = row;
  return {
    id: turn.id,
    member: row.member ? toMemberRef(row.member) : null,
    speaker: turn.speaker,
    agendaItemId: turn.agendaItemId,
    amendmentId: withAmendment ? turn.amendmentId : null,
    noted: turn.noted,
    status: turn.status,
    position: turn.position,
    startedAt: iso(turn.startedAt),
    endedAt: iso(turn.endedAt),
    limitSeconds: turn.limitSeconds,
    priority: turn.priority,
    createdAt: turn.createdAt.toISOString(),
    updatedAt: turn.updatedAt.toISOString(),
  };
}

/**
 * Turns are written down and given only while the session is open; while
 * it is suspended the Mesa may still end the floor or take turns off the
 * list (`clears`), so a break never leaves someone speaking.
 */
function assertOpen(
  assembly: Pick<AssemblyRow, "status">,
  clears = false,
): void {
  if (assembly.status === "closed") fail(409, "La asamblea está cerrada");
  if (!clears) assertSessionOpen(assembly.status);
}

async function readLiveSpeakers(
  executor: Executor,
  assemblyId: string,
): Promise<{
  visible: boolean;
  agendaItemId: string | null;
  amendmentId: string | null;
}> {
  const [row] = await executor
    .select({
      visible: liveState.speakersVisible,
      agendaItemId: liveState.agendaItemId,
      amendmentId: liveState.amendmentId,
    })
    .from(liveState)
    .where(eq(liveState.assemblyId, assemblyId));
  return {
    visible: row?.visible ?? false,
    agendaItemId: row?.agendaItemId ?? null,
    amendmentId: row?.amendmentId ?? null,
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
        // Turns noted by hand never were in the queue.
        eq(speakingTurns.noted, false),
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
    turns: turns.map((turn) => toTurnDto(actor, byId.get(turn.id)!)),
    ...(moderate
      ? { history: speakerHistory(await loadTurnHistory(assemblyId)) }
      : {}),
  };
}

/**
 * Every turn of the assembly that spoke (took the floor, or was noted by
 * hand), in the order it did, as the actor may read it, with the amendment
 * it belongs to: the control sheet's «Intervinientes» and «Turnos de
 * palabra», and the noted speakers. A turn on an amendment the actor may
 * not read is left out. Callers check that the actor may read them.
 */
export async function loadSpokenTurns(
  actor: Actor,
  assemblyId: string,
): Promise<SpeakingTurnDto[]> {
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
        inArray(speakingTurns.status, ["speaking", "done"]),
      ),
    )
    .orderBy(
      sql`${speakingTurns.startedAt} asc nulls last`,
      asc(speakingTurns.createdAt),
      asc(speakingTurns.id),
    );
  const amendmentIds = [
    ...new Set(rows.flatMap((row) => row.turn.amendmentId ?? [])),
  ];
  let visible = new Set<string>();
  if (amendmentIds.length > 0) {
    const owners = await db
      .selectDistinct({ documentId: amendments.documentId })
      .from(amendments)
      .where(inArray(amendments.id, amendmentIds));
    visible = await loadVisibleAmendmentIds(
      actor,
      owners.map((row) => row.documentId),
    );
  }
  return rows
    .filter((row) => !row.turn.amendmentId || visible.has(row.turn.amendmentId))
    .map((row) => toTurnDto(actor, row, true));
}

/** Every turn of the assembly with a member, for speakerHistory (the Mesa). */
function loadTurnHistory(assemblyId: string) {
  return db
    .select({
      memberId: speakingTurns.memberId,
      speaker: speakingTurns.speaker,
      status: speakingTurns.status,
      createdAt: speakingTurns.createdAt,
    })
    .from(speakingTurns)
    .where(
      and(
        eq(speakingTurns.assemblyId, assemblyId),
        isNotNull(speakingTurns.memberId),
        eq(speakingTurns.noted, false),
      ),
    );
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
    // A turn with a limit takes the assembly's default (live_state).
    let limitSeconds: number | null = null;
    if (body.limited) {
      const [state] = await tx
        .select({ seconds: liveState.speakingLimitSeconds })
        .from(liveState)
        .where(eq(liveState.assemblyId, assembly.id));
      limitSeconds = state?.seconds ?? DEFAULT_SPEAKING_LIMIT_SECONDS;
    }

    // A priority turn goes ahead of the queue, after the priority turns
    // already waiting at its head; any other at its end.
    const priority = body.priority === true;
    let position = queue.length;
    if (priority) {
      position = 0;
      while (queue[position]?.priority) position++;
    }
    const [created] = await tx
      .insert(speakingTurns)
      .values({
        assemblyId: assembly.id,
        agendaItemId,
        memberId,
        speaker,
        status: "waiting",
        position,
        limitSeconds,
        priority,
        createdByUserId: actor.user.id,
      })
      .returning({ id: speakingTurns.id });
    // The others make room, and any gap left by an older queue closes, so
    // positions stay 0..n-1.
    const order = queue.map((turn) => turn.id);
    order.splice(position, 0, created!.id);
    await renumberQueue(tx, queue, order, created!.id);

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "speakers",
      entityId: created!.id,
      type: "speaking_turn_added",
      // Ids only: the person's name is read through GET .../speakers.
      payload: {
        memberId,
        agendaItemId,
        position,
        ...(limitSeconds !== null ? { limitSeconds } : {}),
        ...(priority ? { priority: true } : {}),
      },
      actor,
    });
  });

  return loadSpeakers(actor, assembly.id);
}

/**
 * PUT .../speakers/[turn] (session:moderate): gives or ends the floor,
 * cancels or restores a turn, moves it in the queue or fixes the name
 * (planTurnUpdate). Giving the floor ends the turn that was speaking.
 * Optimistic lock on the turn's `updatedAt` (409 when stale), and on the
 * head of the queue and the turn speaking when the body names them
 * (`expectHead`, `expectedSpeakingId`: turnUpdateExpectationsHold). `turnId` is
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
  const clears = speakerUpdateClearsOnly(body);
  assertOpen(assembly, clears);

  await db.transaction(async (tx) => {
    assertOpen(await lockAssembly(tx, assembly.id), clears);
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
    const queueIds = queue.map((item) => item.id);
    const speakingIds = open
      .filter((item) => item.status === "speaking")
      .map((item) => item.id);
    // «Siguiente» from a console that missed a change of the list (a
    // priority turn, the floor given elsewhere): the turn's own token is
    // still good, so the head and the speaker it saw are checked too.
    if (
      !turnUpdateExpectationsHold({
        turnId: turn.id,
        queue: queueIds,
        speakingIds,
        expectHead: body.expectHead,
        expectedSpeakingId: body.expectedSpeakingId,
      })
    ) {
      fail(409, "La lista de palabras ha cambiado. Recarga la página");
    }
    const now = new Date();
    const undoing = turn.status === "done" && body.status === "speaking";
    const plan = planTurnUpdate({
      turn,
      queue: queueIds,
      speakingIds,
      status: body.status,
      position: body.position,
      resumable: undoing && resumableTurn({ turn, speakingIds, now }),
    });
    if (plan === "transition" && undoing) {
      fail(
        409,
        "El final del turno ya no se puede deshacer: otra persona tiene la palabra o ha pasado demasiado tiempo",
      );
    }
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

    // Taking the floor stamps what is in debate then: the sheet names the
    // speaker under that item or amendment, whenever it asked. A waiting
    // turn taken off the list is stamped with the item in debate too, so it
    // stays in the Mesa's «Quitados» there even when it was asked for on an
    // earlier item (a restored turn is stamped again when it speaks).
    const cancelling = turn.status === "waiting" && plan.status === "cancelled";
    const stamp =
      plan.start || cancelling ? await readLiveSpeakers(tx, assembly.id) : null;
    const position = plan.queue.indexOf(turn.id);
    const moved = position >= 0 && position !== turn.position;
    const renamed = speaker !== turn.speaker;
    const limitSeconds =
      body.limitSeconds === undefined ? turn.limitSeconds : body.limitSeconds;
    const limitChanged = limitSeconds !== turn.limitSeconds;
    const changed =
      plan.status !== turn.status || moved || renamed || limitChanged;
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
        limitSeconds,
        ...(position >= 0 ? { position } : {}),
        ...(plan.start && stamp
          ? {
              startedAt: now,
              endedAt: null,
              agendaItemId: stamp.agendaItemId,
              amendmentId: stamp.amendmentId,
            }
          : {}),
        ...(cancelling && stamp?.agendaItemId
          ? { agendaItemId: stamp.agendaItemId }
          : {}),
        ...(plan.end ? { endedAt: now } : {}),
        ...(plan.reset ? { startedAt: null, endedAt: null } : {}),
        // Undone: the clock goes on from where it stopped.
        ...(plan.resume
          ? {
              startedAt:
                turn.startedAt && turn.endedAt
                  ? new Date(
                      turn.startedAt.getTime() +
                        (now.getTime() - turn.endedAt.getTime()),
                    )
                  : turn.startedAt,
              endedAt: null,
            }
          : {}),
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
        ...(limitChanged ? { limitSeconds } : {}),
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

// Noting who spoke ----------------------------------------------------------------
//
// Whoever notes the speakers (the Mesa and session:record_speakers; user's
// decision of 2026-11-19) says who spoke on an agenda item or one of its
// amendments, from the live view or the control sheet. A note is a turn
// `noted` and `done`, out of the queue, with no times of its own beyond
// when it was noted; the turns the Mesa gives from the queue count as well,
// so the sheet's «Intervinientes» name everyone once. Allowed while the
// assembly is not closed, as corrections of the record are.

function assertNotable(assembly: Pick<AssemblyRow, "status">): void {
  if (assembly.status === "closed") fail(409, "La asamblea está cerrada");
  if (assembly.status === "draft") {
    fail(409, "La asamblea todavía no se ha convocado");
  }
}

/** GET .../speakers/notes: every turn that spoke, for noting the rest. */
export async function loadSpeakerNotes(
  actor: Actor,
  assemblyId: string,
): Promise<SpeakerNotesDto> {
  if (!canNoteSpeakers(actor)) fail(403, "No puedes anotar intervenciones");
  return { turns: await loadSpokenTurns(actor, assemblyId) };
}

/**
 * POST .../speakers/notes: notes that a member, or a person by name, spoke
 * on an item or an amendment of it. Nothing changes when that member (or
 * that name, without a member) already spoke there, from the queue or
 * noted. The amendment must be one of the item's documents' and readable
 * by the actor; without an item, the amendment's own item is taken.
 */
export async function noteSpeaker(
  actor: Actor,
  assembly: AssemblyRow,
  body: SpeakerNoteBody,
): Promise<SpeakerNotesDto> {
  if (!canNoteSpeakers(actor)) fail(403, "No puedes anotar intervenciones");
  assertNotable(assembly);
  const memberId = body.memberId ?? null;
  const speaker = body.speaker ?? null;
  if (!memberId && !speaker) {
    fail(422, "Indica el miembro o el nombre de quien ha intervenido");
  }

  await db.transaction(async (tx) => {
    assertNotable(await lockAssembly(tx, assembly.id));

    if (memberId) {
      const [member] = await tx
        .select({ id: members.id })
        .from(members)
        .where(eq(members.id, memberId));
      if (!member) fail(422, "Ese miembro no existe");
    }

    let agendaItemId = body.agendaItemId;
    const amendmentId = body.amendmentId ?? null;
    if (amendmentId) {
      const [owner] = await tx
        .select({
          documentId: amendments.documentId,
          agendaItemId: documents.agendaItemId,
          assemblyId: documents.assemblyId,
        })
        .from(amendments)
        .innerJoin(documents, eq(documents.id, amendments.documentId))
        .where(eq(amendments.id, amendmentId));
      const readable =
        owner?.assemblyId === assembly.id &&
        (await loadVisibleAmendmentIds(actor, [owner.documentId], tx)).has(
          amendmentId,
        );
      if (!owner || !readable) {
        fail(422, "La enmienda no pertenece a esta asamblea");
      }
      agendaItemId ??= owner.agendaItemId;
    }
    if (agendaItemId) {
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

    // Under the assembly lock, so two notes of the same member cannot race.
    const [already] = await tx
      .select({ id: speakingTurns.id })
      .from(speakingTurns)
      .where(
        and(
          eq(speakingTurns.assemblyId, assembly.id),
          inArray(speakingTurns.status, ["speaking", "done"]),
          agendaItemId
            ? eq(speakingTurns.agendaItemId, agendaItemId)
            : isNull(speakingTurns.agendaItemId),
          amendmentId
            ? eq(speakingTurns.amendmentId, amendmentId)
            : isNull(speakingTurns.amendmentId),
          memberId
            ? eq(speakingTurns.memberId, memberId)
            : and(
                isNull(speakingTurns.memberId),
                sql`lower(${speakingTurns.speaker}) = lower(${speaker})`,
              ),
        ),
      )
      .limit(1);
    if (already) return;

    const now = new Date();
    const [created] = await tx
      .insert(speakingTurns)
      .values({
        assemblyId: assembly.id,
        agendaItemId: agendaItemId ?? null,
        amendmentId,
        memberId,
        speaker,
        noted: true,
        status: "done",
        startedAt: now,
        endedAt: now,
        createdByUserId: actor.user.id,
      })
      .returning({ id: speakingTurns.id });

    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "speakers",
      entityId: created!.id,
      type: "speaking_turn_noted",
      // Ids only: never the name written down.
      payload: {
        memberId,
        agendaItemId: agendaItemId ?? null,
        ...(amendmentId ? { amendmentId } : {}),
        ...(speaker ? { named: true } : {}),
      },
      actor,
    });
  });

  return loadSpeakerNotes(actor, assembly.id);
}

/**
 * DELETE .../speakers/notes/[turn]: takes back a note (cancelled, never
 * deleted). Only notes: a turn given from the queue spoke for real and
 * stays. Taking back one already gone changes nothing.
 */
export async function removeSpeakerNote(
  actor: Actor,
  assembly: AssemblyRow,
  turnId: string,
): Promise<SpeakerNotesDto> {
  if (!canNoteSpeakers(actor)) fail(403, "No puedes anotar intervenciones");
  assertNotable(assembly);

  await db.transaction(async (tx) => {
    assertNotable(await lockAssembly(tx, assembly.id));
    const [turn] = await tx
      .select()
      .from(speakingTurns)
      .where(
        and(
          eq(speakingTurns.id, turnId),
          eq(speakingTurns.assemblyId, assembly.id),
        ),
      );
    if (!turn) fail(404, "Intervención no encontrada");
    if (!turn.noted) {
      fail(409, "Ese turno se dio desde la sesión: no se puede quitar aquí");
    }
    if (turn.status === "cancelled") return;
    await tx
      .update(speakingTurns)
      .set({ status: "cancelled" })
      .where(eq(speakingTurns.id, turn.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "speakers",
      entityId: turn.id,
      type: "speaking_turn_unnoted",
      payload: {
        memberId: turn.memberId,
        agendaItemId: turn.agendaItemId,
        ...(turn.amendmentId ? { amendmentId: turn.amendmentId } : {}),
      },
      actor,
    });
  });

  return loadSpeakerNotes(actor, assembly.id);
}
