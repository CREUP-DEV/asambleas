import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { auditLog, members, users } from "../../../../db/schema";
import { loadAdminUser } from "../../../../utils/auth/adminUsers";
import { requireAdmin } from "../../../../utils/auth/rbac";
import { validateAuthId } from "../../../../utils/validation";
import { userMemberLinkBodySchema } from "~~/shared/utils/schemas/member";

/**
 * Links an account to the member it acts for (users.memberId), or unlinks it
 * with null. Role sync links Asociado, Sectorial and CEA accounts by their
 * intranet initials; this covers accounts without initials and CEA accounts
 * whose initials are the person's rather than the area's. A CEA account
 * keeps a manual link until its intranet initials change; an Asociado or
 * Sectorial account with initials is linked by them again at its next
 * sign-in (docs/api.md, "Linking accounts to members"). Admin only.
 * Returns the row as the admin users list shows it.
 */
export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event);
  const userId = validateAuthId(getRouterParam(event, "id"));

  const parsed = userMemberLinkBodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Miembro no válido" });
  }
  const { memberId } = parsed.data;

  const target = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, memberId: true },
  });
  if (!target) {
    throw createError({ statusCode: 404, message: "Usuario no encontrado" });
  }
  if (memberId) {
    const member = await db.query.members.findFirst({
      where: eq(members.id, memberId),
      columns: { id: true, active: true },
    });
    if (!member) {
      throw createError({ statusCode: 404, message: "Miembro no encontrado" });
    }
    if (!member.active) {
      throw createError({
        statusCode: 422,
        message: "Ese miembro está desactivado",
      });
    }
  }

  if (target.memberId !== memberId) {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ memberId }).where(eq(users.id, userId));
      await tx.insert(auditLog).values({
        actorUserId: session?.user.id ?? null,
        action: "user.member_link",
        targetType: "user",
        targetId: userId,
        before: { memberId: target.memberId },
        after: { memberId },
      });
    });
  }

  const updated = await loadAdminUser(userId);
  if (!updated) {
    throw createError({ statusCode: 404, message: "Usuario no encontrado" });
  }
  return updated;
});
