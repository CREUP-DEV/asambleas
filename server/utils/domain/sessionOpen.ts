import { createError } from "h3";
import type { AssemblyStatus } from "~~/shared/constants/domain";
import {
  isSessionInProgress,
  PROJECTION_CONTROL_MESSAGE_KEY,
  SESSION_NOT_OPEN_MESSAGE_KEY,
} from "~~/shared/utils/sessionGate";

/**
 * 409 unless the request's console controls the projection
 * (controlsProjection in projectionControl.ts): only it moves what is on
 * screen.
 */
export function assertControlsProjection(controls: boolean): void {
  if (controls) return;
  throw createError({
    statusCode: 409,
    message: "Otra consola controla la proyección",
    data: {
      code: "projection_control",
      messageKey: PROJECTION_CONTROL_MESSAGE_KEY,
    },
  });
}

/**
 * 409 unless the session is open (`in_session`): nothing is projected or
 * recorded in the room before the Mesa opens it, nor while it is suspended
 * (shared/utils/sessionGate.ts). Callers read the status under the
 * assembly's lock when they hold one.
 */
export function assertSessionOpen(
  status: AssemblyStatus | null | undefined,
): void {
  if (isSessionInProgress(status)) return;
  throw createError({
    statusCode: 409,
    message:
      status === "closed"
        ? "La asamblea está cerrada"
        : "La sesión no está abierta",
    data: { messageKey: SESSION_NOT_OPEN_MESSAGE_KEY },
  });
}
