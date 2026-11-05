import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import type { ImpersonationDto } from "~~/shared/types/api";
import { impersonationStartBodySchema } from "~~/shared/utils/schemas/activity";
import { requireAdmin } from "../../../../utils/auth/rbac";
import { startImpersonation } from "../../../../utils/auth/impersonation";
import { validateAuthId } from "../../../../utils/validation";

/**
 * The signed-in Admin starts acting as the account `[id]` for at most
 * IMPERSONATION_TTL_MINUTES, with a written reason (docs/api.md,
 * "Impersonation"). Admin only by role, never by a permission key:
 * Secretaría and Presidencia hold every key. Never as itself (422), never
 * as another Admin (403), never nested (409; the admin section is
 * read-only while impersonating, so a second start answers 403 first).
 * Writes the impersonations row and `impersonation.start`. No cookie
 * changes: the client reloads and every request then runs as `[id]`.
 */
export default defineEventHandler(async (event): Promise<ImpersonationDto> => {
  await requireAdmin(event);
  const targetUserId = validateAuthId(getRouterParam(event, "id"));

  const parsed = impersonationStartBodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Indica el motivo en una sola línea de hasta 200 caracteres",
      data: { messageKey: "impersonation.errors.reason" },
    });
  }

  return startImpersonation(event, {
    targetUserId,
    reason: parsed.data.reason,
  });
});
