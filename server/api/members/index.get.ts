import { createError, defineEventHandler, getQuery } from "h3";
import { asc, desc, eq } from "drizzle-orm";
import type { MemberDto } from "~~/shared/types/api";
import { memberListQuerySchema } from "~~/shared/utils/schemas/member";
import { db } from "../../db";
import { members } from "../../db/schema";
import { requireActor } from "../../utils/domain/actor";
import { toMemberDto } from "../../utils/members/dto";

/** Active members first, by acronym. `?all=1` also returns inactive ones. */
export default defineEventHandler(async (event): Promise<MemberDto[]> => {
  await requireActor(event);
  const query = memberListQuerySchema.safeParse(getQuery(event));
  if (!query.success) {
    throw createError({ statusCode: 400, message: "Parámetros no válidos" });
  }

  const rows = await db
    .select()
    .from(members)
    .where(query.data.all ? undefined : eq(members.active, true))
    .orderBy(desc(members.active), asc(members.acronym));

  return rows.map(toMemberDto);
});
