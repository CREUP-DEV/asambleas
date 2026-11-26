import { defineEventHandler, setResponseStatus } from "h3";
import { readBodyWith } from "../../../utils/core/http";
import { requireActor } from "../../../utils/domain/actor";
import { markNoticesSeen } from "../../../utils/domain/notices";
import { throwMutationError } from "../../../utils/errors";
import { noticesSeenBodySchema } from "~~/shared/utils/schemas/notices";

/**
 * The account has seen its notices up to `at`: never back, never past the
 * present, and nothing written while an Admin acts as the account
 * (markNoticesSeen). Answers 204 either way.
 */
export default defineEventHandler(async (event): Promise<null> => {
  const actor = await requireActor(event);
  const body = await readBodyWith(event, noticesSeenBodySchema);
  try {
    await markNoticesSeen(actor, new Date(body.at));
  } catch (error) {
    throwMutationError("notices.seen", error, event);
  }
  setResponseStatus(event, 204);
  return null;
});
