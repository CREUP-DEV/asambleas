import { getHeader, type H3Event } from "h3";
import { CONSOLE_TAB_HEADER_NAME } from "~~/shared/constants/security";
import type {
  ProjectionControlBody,
  ProjectionControlDto,
} from "~~/shared/types/api";
import { consoleTabIdSchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../db";
import {
  beatConsole,
  isController,
  leaveConsole,
  takeControl,
  type ControlState,
} from "../live/projectionControl";
import { canModerate, type Actor } from "./actor";
import { recordEvent } from "./events";

/**
 * Control of the projection for the request's console (user's decision of
 * 2026-11-19; the holder lives in server/utils/live/projectionControl.ts).
 * The console names its browser tab in CONSOLE_TAB_HEADER_NAME; a request
 * without it comes from no console (Validación, the control sheet, an
 * amendment's page) and never moves the projection.
 */

/** The console tab a request names, if any (a malformed one is none). */
export function consoleTabOf(event: H3Event): string | null {
  const parsed = consoleTabIdSchema.safeParse(
    getHeader(event, CONSOLE_TAB_HEADER_NAME),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the request comes from the console tab that controls the
 * projection of the assembly: only then may it move what is on screen.
 */
export function controlsProjection(
  event: H3Event,
  assemblyId: string,
  actor: Actor,
): boolean {
  if (!canModerate(actor)) return false;
  const tabId = consoleTabOf(event);
  return (
    tabId !== null && isController(assemblyId, { userId: actor.user.id, tabId })
  );
}

function toDto(
  actor: Actor,
  tabId: string,
  state: ControlState,
): ProjectionControlDto {
  const holder = state.holder;
  return {
    holder: holder
      ? {
          name: holder.name,
          you: holder.userId === actor.user.id && holder.tabId === tabId,
          sameAccount: holder.userId === actor.user.id,
        }
      : null,
    consoles: state.consoles,
  };
}

/**
 * A console beats, takes control or leaves (POST .../projection-control).
 * A change of holder is recorded once, by the console that receives control
 * (ControlState.announce), so the history always names who holds it.
 */
export async function projectionControl(
  actor: Actor,
  assemblyId: string,
  body: ProjectionControlBody,
): Promise<ProjectionControlDto> {
  const key = { userId: actor.user.id, tabId: body.tabId };
  const entry = {
    ...key,
    // The intranet's name, as the history shows it; never the email.
    name: actor.user.externalName ?? actor.user.name,
  };
  const state =
    body.action === "leave"
      ? leaveConsole(assemblyId, key)
      : body.action === "take"
        ? takeControl(assemblyId, entry)
        : beatConsole(assemblyId, entry);
  if (state.announce) {
    await recordEvent(db, {
      assemblyId,
      entityType: "projection",
      entityId: assemblyId,
      type: "projection_control_changed",
      payload: { reason: state.announce },
      actor,
    });
  }
  return toDto(actor, body.tabId, state);
}
