import { defineEventHandler } from "h3";
import type { MemberSyncResult } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireActor, requireCan } from "../../utils/domain/actor";
import { throwMutationError } from "../../utils/errors";
import { syncIntranetRoster } from "../../utils/members/sync";

/**
 * Syncs asociados and sectorials from the intranet roster. Writes one audit
 * row per member it changes plus the summary (syncIntranetRoster).
 */
export default defineEventHandler(async (event): Promise<MemberSyncResult> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.MEMBER_MANAGE);

  try {
    return await syncIntranetRoster({ event, actor });
  } catch (error) {
    throwMutationError("members.sync", error, event);
  }
});
