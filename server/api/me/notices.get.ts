import { defineEventHandler } from "h3";
import type { MeNoticesDto } from "~~/shared/types/api";
import { requireActor } from "../../utils/domain/actor";
import { loadNotices } from "../../utils/domain/notices";

/**
 * The account's notices («Avisos»): what others decided about its member's
 * work, its mark of how far it has seen them and how many are new.
 */
export default defineEventHandler(async (event): Promise<MeNoticesDto> => {
  const actor = await requireActor(event);
  return loadNotices(actor);
});
