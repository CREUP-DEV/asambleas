import { createError, defineEventHandler, readBody } from "h3";
import type {
  MemberSyncBlockedData,
  MemberSyncResult,
} from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { memberSyncBodySchema } from "~~/shared/utils/schemas/member";
import { requireActor, requireCan } from "../../utils/domain/actor";
import { throwMutationError } from "../../utils/errors";
import {
  syncIntranetRoster,
  type RosterSyncOutcome,
} from "../../utils/members/sync";

/**
 * Syncs asociados and sectorials from the intranet roster. Writes one audit
 * row per member it changes plus the summary (syncIntranetRoster).
 *
 * The body is optional (MemberSyncBody). A sync that would deactivate every
 * active member of a kind, or more than max(3, 30%) of them, needs
 * `confirmDeactivation: true` with the `confirmedKinds` the page showed:
 * without them, or when the sync would now deactivate more than was
 * confirmed, nothing changes but the `members.sync_blocked` audit row, and
 * the answer is 409 with MemberSyncBlockedData (the current counts) so the
 * page can ask and send it again.
 */
export default defineEventHandler(async (event): Promise<MemberSyncResult> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.MEMBER_MANAGE);

  const parsed = memberSyncBodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos de la sincronización no válidos",
    });
  }

  let outcome: RosterSyncOutcome;
  try {
    outcome = await syncIntranetRoster({
      event,
      actor,
      trigger: "manual",
      confirmDeactivation: parsed.data.confirmDeactivation,
      confirmedKinds: parsed.data.confirmedKinds,
    });
  } catch (error) {
    throwMutationError("members.sync", error, event);
  }

  if (outcome.status === "blocked") {
    // Thrown after the transaction committed, so the audit row stays.
    const data: MemberSyncBlockedData = {
      reason: "large_deactivation",
      kinds: outcome.kinds,
    };
    throw createError({
      statusCode: 409,
      message:
        "La sincronización desactivaría demasiados miembros y necesita confirmación",
      data,
    });
  }
  return outcome.result;
});
