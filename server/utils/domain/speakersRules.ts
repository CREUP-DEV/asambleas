import type { SpeakingTurnStatus } from "~~/shared/constants/domain";

/**
 * Pure rules of the speaking turns the Mesa writes down (docs/api.md,
 * "Speaking turns"). No database access here.
 */

/**
 * Status changes the Mesa can make:
 * - a waiting turn gets the floor (speaking) or is cancelled (the person no
 *   longer wants to speak);
 * - a speaking turn ends (done) or is cancelled (given by mistake);
 * - a cancelled turn goes back to the end of the queue (undo).
 * A finished turn stays finished: a person who asks again gets a new turn.
 */
export const SPEAKING_TURN_TRANSITIONS: Record<
  SpeakingTurnStatus,
  readonly SpeakingTurnStatus[]
> = {
  waiting: ["speaking", "cancelled"],
  speaking: ["done", "cancelled"],
  done: [],
  cancelled: ["waiting"],
};

export function canChangeTurnStatus(
  from: SpeakingTurnStatus,
  to: SpeakingTurnStatus,
): boolean {
  return from === to || SPEAKING_TURN_TRANSITIONS[from].includes(to);
}

export interface QueueTurn {
  id: string;
  status: SpeakingTurnStatus;
  position: number;
  createdAt: Date;
}

function byQueueOrder(a: QueueTurn, b: QueueTurn): number {
  return (
    a.position - b.position ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

/** Waiting turns in speaking order: position, then arrival, then id. */
export function waitingQueue<T extends QueueTurn>(turns: T[]): T[] {
  return turns.filter((turn) => turn.status === "waiting").sort(byQueueOrder);
}

/** `orderedIds` with `movedId` placed at `toIndex` (clamped to the queue). */
export function moveInQueue(
  orderedIds: string[],
  movedId: string,
  toIndex: number,
): string[] {
  const rest = orderedIds.filter((id) => id !== movedId);
  const index = Math.max(0, Math.min(Math.trunc(toIndex), rest.length));
  return [...rest.slice(0, index), movedId, ...rest.slice(index)];
}

export interface TurnUpdatePlan {
  status: SpeakingTurnStatus;
  /** The turn gets the floor now: set `startedAt`. */
  start: boolean;
  /** The turn leaves the floor or the queue now: set `endedAt`. */
  end: boolean;
  /** Back in the queue: clear `startedAt` and `endedAt`. */
  reset: boolean;
  /** Turns that were speaking and end now (done) because this one starts. */
  finishIds: string[];
  /** The waiting queue after the change, in speaking order (positions 0..n-1). */
  queue: string[];
}

export type TurnUpdateError = "transition" | "not_waiting";

/**
 * What a PUT .../speakers/[turn] does, before anything is written:
 * - giving the floor ends the turn that was speaking (done);
 * - `position` moves a waiting turn to that place of the queue (0 speaks
 *   next), and is refused for a turn that is not waiting;
 * - a cancelled turn that goes back to waiting joins the end of the queue,
 *   or `position` when given;
 * - the queue is renumbered 0..n-1, so gaps never build up.
 */
export function planTurnUpdate(input: {
  turn: { id: string; status: SpeakingTurnStatus };
  /** Waiting turn ids in speaking order (waitingQueue), this one included if waiting. */
  queue: string[];
  speakingIds: string[];
  status?: SpeakingTurnStatus;
  position?: number;
}): TurnUpdatePlan | TurnUpdateError {
  const { turn } = input;
  const status = input.status ?? turn.status;
  if (!canChangeTurnStatus(turn.status, status)) return "transition";
  const changes = status !== turn.status;

  let queue = input.queue.filter((id) => id !== turn.id);
  if (status === "waiting") {
    const current = input.queue.indexOf(turn.id);
    const index =
      input.position ?? (current >= 0 && !changes ? current : queue.length);
    queue = moveInQueue(queue, turn.id, index);
  } else if (input.position !== undefined) {
    return "not_waiting";
  }

  const start = changes && status === "speaking";
  return {
    status,
    start,
    end: changes && (status === "done" || status === "cancelled"),
    reset: changes && status === "waiting",
    finishIds: start ? input.speakingIds.filter((id) => id !== turn.id) : [],
    queue,
  };
}

export interface ListedTurn extends QueueTurn {
  agendaItemId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

const OPEN_TURN_STATUSES: readonly SpeakingTurnStatus[] = [
  "speaking",
  "waiting",
];

/**
 * The turns an actor gets from GET .../speakers. The Mesa sees the turns
 * that are speaking or waiting and every turn of the agenda item in debate
 * (`agendaItemId` of the live state; null matches turns without an item),
 * plus `include`: the turn a PUT just changed, which the Mesa gets back even
 * when it no longer fits (a cancelled turn of another item). Anyone else
 * sees the speaking and waiting turns only while the Mesa makes them
 * visible, and nothing otherwise.
 */
export function turnsForActor<T extends ListedTurn>(
  turns: T[],
  input: {
    moderate: boolean;
    visible: boolean;
    agendaItemId: string | null;
    include?: readonly string[];
  },
): T[] {
  if (input.moderate) {
    return turns.filter(
      (turn) =>
        OPEN_TURN_STATUSES.includes(turn.status) ||
        turn.agendaItemId === input.agendaItemId ||
        Boolean(input.include?.includes(turn.id)),
    );
  }
  if (!input.visible) return [];
  return turns.filter((turn) => OPEN_TURN_STATUSES.includes(turn.status));
}

function statusRank(status: SpeakingTurnStatus): number {
  if (status === "speaking") return 0;
  if (status === "waiting") return 1;
  return 2;
}

function finishedAt(turn: ListedTurn): number {
  return (turn.startedAt ?? turn.endedAt ?? turn.createdAt).getTime();
}

/**
 * Display order: who has the floor, then the queue in speaking order, then
 * the finished and cancelled turns in the order they happened.
 */
export function sortTurns<T extends ListedTurn>(turns: T[]): T[] {
  return [...turns].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    if (a.status === "waiting") return byQueueOrder(a, b);
    return finishedAt(a) - finishedAt(b) || a.id.localeCompare(b.id);
  });
}

/** Event type recorded for a turn change, from the plan and the fields that changed. */
export function turnEventType(input: {
  from: SpeakingTurnStatus;
  to: SpeakingTurnStatus;
  moved: boolean;
}): string {
  if (input.from !== input.to) {
    switch (input.to) {
      case "speaking":
        return "speaking_turn_started";
      case "done":
        return "speaking_turn_finished";
      case "cancelled":
        return "speaking_turn_cancelled";
      case "waiting":
        return "speaking_turn_restored";
    }
  }
  return input.moved ? "speaking_turn_moved" : "speaking_turn_updated";
}
