import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { and, eq, ne, sql } from "drizzle-orm";
import type { MemberDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { memberUpdateBodySchema } from "~~/shared/utils/schemas/member";
import { db } from "../../db";
import { auditLog, members } from "../../db/schema";
import { requireActor, requireCan } from "../../utils/domain/actor";
import { throwMutationError } from "../../utils/errors";
import { toMemberDto } from "../../utils/members/dto";
import { buildOptimisticLockCondition } from "../../utils/optimisticLock";
import { validateCuid } from "../../utils/validation";

/** Edits name, kind, active and details, with optimistic locking. */
export default defineEventHandler(async (event): Promise<MemberDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.MEMBER_MANAGE);
  const memberId = validateCuid(getRouterParam(event, "id"), "Miembro");

  const parsed = memberUpdateBodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Datos del miembro no válidos" });
  }
  const { updatedAt, ...changes } = parsed.data;

  try {
    const updated = await db.transaction(async (tx) => {
      const current = await tx.query.members.findFirst({ where: eq(members.id, memberId) });
      if (!current) {
        throw createError({ statusCode: 404, message: "Miembro no encontrado" });
      }

      if (changes.acronym !== undefined && changes.acronym !== current.acronym) {
        if (current.source !== "manual") {
          throw createError({
            statusCode: 422,
            message: "Las siglas de un miembro sincronizado se cambian en la intranet",
          });
        }
        const [duplicate] = await tx
          .select({ id: members.id })
          .from(members)
          .where(
            and(
              ne(members.id, memberId),
              sql`lower(${members.acronym}) = lower(${changes.acronym})`,
            ),
          )
          .limit(1);
        if (duplicate) {
          throw createError({ statusCode: 409, message: "Ya existe un miembro con esas siglas" });
        }
      }

      const values = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      ) as Partial<typeof members.$inferInsert>;

      const [row] = await tx
        .update(members)
        .set(values)
        .where(and(eq(members.id, memberId), buildOptimisticLockCondition(members.updatedAt, updatedAt)))
        .returning();
      if (!row) {
        throw createError({
          statusCode: 409,
          message: "El miembro ha cambiado mientras lo editabas. Recarga e inténtalo de nuevo",
        });
      }

      await tx.insert(auditLog).values({
        actorUserId: actor.user.id,
        action: "member.update",
        targetType: "member",
        targetId: memberId,
        before: toMemberDto(current),
        after: toMemberDto(row),
      });
      return row;
    });

    return toMemberDto(updated);
  } catch (error) {
    throwMutationError("members.update", error, event);
  }
});
