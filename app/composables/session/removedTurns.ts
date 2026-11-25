import type { SpeakingTurnDto } from "~~/shared/types/api";

/**
 * The turns the Mesa took off the list («Quitar de la lista») on the agenda
 * item in debate, the last one taken off first: the console's «Quitados»
 * fold, from which each goes back to the list without the toast. The
 * server keeps a cancelled turn in the Mesa's list only while it belongs to
 * the item in debate (`agendaItemId`, null with no item); a waiting turn
 * taken off is stamped with that item, even one asked for on an earlier
 * item. Noted turns are never in it.
 */
export function sessionRemovedTurns(
  turns: SpeakingTurnDto[],
  agendaItemId: string | null,
): SpeakingTurnDto[] {
  return turns
    .filter(
      (turn) =>
        turn.status === "cancelled" &&
        !turn.noted &&
        turn.agendaItemId === agendaItemId,
    )
    .sort(
      (a, b) =>
        time(b.endedAt) - time(a.endedAt) ||
        time(b.updatedAt) - time(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * Where a turn taken off the list goes back: the place it had then. The
 * server leaves a cancelled turn's `position` as it was when it left the
 * queue (it renumbers only the waiting ones), so that is its old 0-based
 * place, kept within the queue as it is now (the end at most).
 */
export function sessionRestorePlace(
  turn: Pick<SpeakingTurnDto, "position">,
  waitingCount: number,
): number {
  const position = Number.isFinite(turn.position) ? turn.position : 0;
  return Math.min(Math.max(0, Math.trunc(position)), Math.max(0, waitingCount));
}

function time(value: string | null): number {
  return value ? new Date(value).getTime() : 0;
}
