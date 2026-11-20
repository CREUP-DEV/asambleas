/**
 * A refresh that never misses a change (the control sheet in real time,
 * user's decision of 2026-11-19).
 *
 * A live event can land while a fetch started by an earlier one is still
 * on its way. That fetch may have read the database before the change the
 * new event announces, and joining it (useFetch's `dedupe: "defer"`) would
 * leave the change invisible until some later event. Cancelling it instead
 * (`dedupe: "cancel"`) can starve under a steady burst of events.
 *
 * `trailingRefresh(run)` returns a function that runs `run` when nothing
 * is on its way; called while a run is pending, it waits for that one and
 * then runs exactly once more, however many calls came meanwhile. A run
 * that fails never locks it.
 */
export function trailingRefresh(
  run: () => Promise<unknown>,
): () => Promise<void> {
  let pending: Promise<void> | null = null;
  let again = false;

  return () => {
    if (pending) {
      again = true;
      return pending;
    }
    // Started on the next microtask, so `pending` is set before the loop
    // can end, and cleared in the same tick as its last check of `again`.
    pending = Promise.resolve().then(async () => {
      do {
        again = false;
        try {
          await run();
        } catch {
          // The caller's own error state shows it; the next call runs again.
        }
      } while (again);
      pending = null;
    });
    return pending;
  };
}
