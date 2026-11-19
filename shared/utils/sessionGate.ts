import type { AssemblyStatus } from "../constants/domain";
import type { LiveStateBody, SpeakingTurnUpdateBody } from "../types/api";

/**
 * Nothing is projected or recorded in the room until the Mesa opens the
 * session (user's decision of 2026-11-18): what the room debates, votes,
 * headcounts and speaking turns all wait for `in_session`. A suspended
 * session goes back to `convened`, and then only what clears the room is
 * allowed (liveStateClearsOnly, speakerUpdateClearsOnly), so a break never
 * leaves something on screen or someone with the floor.
 */
export function isSessionInProgress(
  status: AssemblyStatus | null | undefined,
): boolean {
  return status === "in_session";
}

/** The i18n key of the 409 a write gets while the session is not open. */
export const SESSION_NOT_OPEN_MESSAGE_KEY = "common.errors.sessionNotOpen";

/**
 * A change of the live state that only takes things off the screen: no
 * agenda item, document, amendment or vote is pointed at, the speaking
 * turns are not shown and no recess starts (ending one clears the screen).
 * The message to the room and the default limit of a turn may change at
 * any time.
 */
export function liveStateClearsOnly(body: LiveStateBody): boolean {
  return (
    (["agendaItemId", "documentId", "amendmentId", "voteId"] as const).every(
      (key) => body[key] === undefined || body[key] === null,
    ) &&
    body.speakersVisible !== true &&
    (body.recess === undefined || body.recess === null)
  );
}

/**
 * A change of the live state that moves what is on screen: it points at, or
 * takes off, the agenda item, document, amendment or vote in debate. Only
 * the console that controls the projection sends one (user's decision of
 * 2026-11-19); the message, the recess, the speakers' visibility and the
 * default limit of a turn any console of the Mesa may change.
 */
export function liveStateMovesScreen(body: LiveStateBody): boolean {
  return (
    ["agendaItemId", "documentId", "amendmentId", "voteId"] as const
  ).some((key) => body[key] !== undefined);
}

/** The i18n key of the 409 a console without control gets for one. */
export const PROJECTION_CONTROL_MESSAGE_KEY =
  "session.control.errors.notInControl";

/**
 * A change of a speaking turn that only clears the list: the floor ends or a
 * turn is taken off it, with nothing moved or renamed.
 */
export function speakerUpdateClearsOnly(body: SpeakingTurnUpdateBody): boolean {
  return (
    (body.status === "done" || body.status === "cancelled") &&
    body.position === undefined &&
    body.speaker === undefined &&
    body.limitSeconds === undefined
  );
}
