/**
 * Which live events can change the Secretaría's validation inbox, so the
 * hub's badge and the inbox refetch only when it matters. No Nuxt or Vue
 * APIs here, so it is unit-tested on its own (-live.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */

/**
 * Live event types that can change the inbox: documents and amendments
 * entering or leaving it, or changing what a card shows (title, admission).
 * An acceptance counts: the main authors accepting a transactional is what
 * makes it ready for validation, and one of them rejecting it closes it.
 * So does an amendment being transacted: a transactional that replaces it
 * takes it out of the inbox. Outcomes count too: a transactional still
 * waiting is closed when any amendment it groups is decided, withdrawn,
 * lapsed, incorporated or replaced, and nothing is validated after the
 * document's final vote (annulling it opens the document again). "poll" is
 * the synthetic event sent while the live stream is down, when anything
 * may have changed. Vote tallies, positions and draft edits are left out:
 * they never touch what waits for validation.
 */
export const REVIEW_LIVE_TYPES: ReadonlySet<string> = new Set([
  "poll",
  "document_created",
  "document_updated",
  "document_submitted",
  "document_correction_requested",
  "document_published",
  "document_status_changed",
  "document_deleted",
  "amendment_created",
  "amendment_submitted",
  "amendment_validated",
  "amendment_published",
  "amendment_correction_requested",
  "amendment_withdrawn",
  // The Mesa can declare lapsed a late one still waiting for the assembly.
  "amendment_lapsed",
  "amendment_deleted",
  "amendment_reopened",
  "amendment_admitted",
  "amendment_inadmissible",
  "amendment_transacted",
  // Deciding an amendment closes the transactionals still waiting over it.
  "amendment_approved",
  "amendment_rejected",
  "acceptance_recorded",
  "document_voted",
  "final_vote_annulled",
]);

/** Whether a batch of live events may have changed the review queue. */
export function affectsReviewQueue(
  events: readonly { type: string }[],
): boolean {
  return events.some((event) => REVIEW_LIVE_TYPES.has(event.type));
}
