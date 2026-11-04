import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import { sql } from "drizzle-orm";
import type { MemberDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { memberCreateBodySchema } from "~~/shared/utils/schemas/member";
import { db } from "../../db";
import { auditLog, members } from "../../db/schema";
import { requireActor, requireCan } from "../../utils/domain/actor";
import { throwMutationError } from "../../utils/errors";
import { toMemberDto } from "../../utils/members/dto";

/** Creates a member by hand, typically an executive area. */
export default defineEventHandler(async (event): Promise<MemberDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.MEMBER_MANAGE);

  const parsed = memberCreateBodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Datos del miembro no válidos" });
  }
  const body = parsed.data;

  try {
    const member = await db.transaction(async (tx) => {
      const [duplicate] = await tx
        .select({ id: members.id })
        .from(members)
        .where(sql`lower(${members.acronym}) = lower(${body.acronym})`)
        .limit(1);
      if (duplicate) {
        throw createError({ statusCode: 409, message: "Ya existe un miembro con esas siglas" });
      }

      const [created] = await tx
        .insert(members)
        .values({
          kind: body.kind,
          acronym: body.acronym,
          name: body.name,
          university: body.university ?? null,
          region: body.region ?? null,
          source: "manual",
          active: true,
        })
        .returning();
      if (!created) {
        throw createError({ statusCode: 500, message: "No se pudo crear el miembro" });
      }

      await tx.insert(auditLog).values({
        actorUserId: actor.user.id,
        action: "member.create",
        targetType: "member",
        targetId: created.id,
        before: null,
        after: toMemberDto(created),
      });
      return created;
    });

    setResponseStatus(event, 201);
    return toMemberDto(member);
  } catch (error) {
    throwMutationError("members.create", error, event);
  }
});
