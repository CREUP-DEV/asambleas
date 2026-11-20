import { sameBloc } from "./liveBloc";

/**
 * How a vote between alternatives splits its amendments, against the
 * options on screen (live_state's amendmentBlocOptions). Shared by the
 * server, which refuses a vote that differs, and the console's dialog,
 * which follows the screen.
 */

/** Whether two splits are the same, option by option (any order within one). */
export function sameAlternatives(
  a: readonly (readonly string[])[] | null | undefined,
  b: readonly (readonly string[])[] | null | undefined,
): boolean {
  if (!a || !b) return !a === !b;
  return (
    a.length === b.length && a.every((ids, index) => sameBloc(ids, b[index]))
  );
}

/**
 * Whether a vote splits its amendments otherwise than the options on screen
 * for its document (`projected`). With none on screen, or none of the
 * vote's amendments among them, any split goes: the Mesa may vote without
 * projecting. Otherwise the room voted on what it read, so each option must
 * hold the same amendments in the same place (the winner is an option's
 * index), in any order within it.
 */
export function alternativesSplitConflict(
  projected: readonly (readonly string[])[] | null | undefined,
  sent: readonly (readonly string[])[],
): boolean {
  if (!projected || projected.length === 0) return false;
  const sentIds = new Set(sent.flat());
  if (!projected.some((ids) => ids.some((id) => sentIds.has(id)))) {
    return false;
  }
  return !sameAlternatives(projected, sent);
}

/**
 * Whether an open dialog of a vote between alternatives takes the split the
 * projection just changed to (`next`, after `previous`). Only when the
 * server would now refuse the dialog's split (`current`, its options) and
 * the projection holds the same amendments as the dialog (`ids`), so the
 * counts entered still belong to that vote: a projection of other
 * amendments never takes over an unrelated vote, and one that adds or drops
 * amendments leaves the dialog as it is, with its warning, to be reopened.
 * A refresh of the same projection never undoes a split made in the dialog
 * and not projected yet.
 */
export function followsProjectedSplit(
  next: readonly (readonly string[])[] | null | undefined,
  previous: readonly (readonly string[])[] | null | undefined,
  current: readonly (readonly string[])[],
  ids: readonly string[],
): boolean {
  if (!next || sameAlternatives(next, previous)) return false;
  return alternativesSplitConflict(next, current) && sameBloc(next.flat(), ids);
}
