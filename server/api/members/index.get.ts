import { createError, defineEventHandler, getQuery } from "h3";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { MemberDto } from "~~/shared/types/api";
import { orderMembers } from "~~/shared/utils/memberOrder";
import { memberListQuerySchema } from "~~/shared/utils/schemas/member";
import { db } from "../../db";
import { members } from "../../db/schema";
import { requireActor } from "../../utils/domain/actor";
import {
  canNameExecutiveAuthors,
  canSeeGuests,
  collapseExecutive,
} from "../../utils/domain/visibility";
import {
  genericExecutiveMemberDto,
  toMemberDto,
} from "../../utils/members/dto";

/**
 * Active members first, by acronym. `?all=1` also returns inactive ones,
 * `?guests=1` the guests too, and so does `?all=1`, to resolve the former
 * councils in a history; both only for those who read the guests
 * (canSeeGuests), and never with `for`: guests present nothing.
 * An account that may not see the executive areas gets one generic "CEA"
 * entry instead of them (canSeeExecutiveMembers).
 *
 * `?for=amendment` is the one exception, for the composers of amendments
 * and transactionals only: an account that presents amendments
 * (canNameExecutiveAuthors) gets the active members with the real areas,
 * to name them as authors. It carries members, never who acts for them,
 * and what that account reads outside the composer is the generic "CEA".
 */
export default defineEventHandler(async (event): Promise<MemberDto[]> => {
  const actor = await requireActor(event);
  const query = memberListQuerySchema.safeParse(getQuery(event));
  if (!query.success) {
    throw createError({ statusCode: 400, message: "Parámetros no válidos" });
  }

  const forAmendment =
    query.data.for !== undefined && canNameExecutiveAuthors(actor);
  const rows = await db
    .select()
    .from(members)
    .where(
      and(
        query.data.all && !forAmendment ? undefined : eq(members.active, true),
        (query.data.guests || query.data.all) &&
          query.data.for === undefined &&
          canSeeGuests(actor)
          ? undefined
          : ne(members.kind, "guest"),
      ),
    )
    .orderBy(desc(members.active), asc(members.acronym));
  // The general order of every list of members: asociados, sectorials, the
  // others and the offices (the generic "CEA" among them), each by acronym.
  if (forAmendment) return orderMembers(rows.map(toMemberDto));

  return orderMembers(
    collapseExecutive(actor, rows.map(toMemberDto), genericExecutiveMemberDto),
  );
});
