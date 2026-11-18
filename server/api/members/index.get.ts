import { createError, defineEventHandler, getQuery } from "h3";
import { asc, desc, eq } from "drizzle-orm";
import type { MemberDto } from "~~/shared/types/api";
import { orderMembers } from "~~/shared/utils/memberOrder";
import { memberListQuerySchema } from "~~/shared/utils/schemas/member";
import { db } from "../../db";
import { members } from "../../db/schema";
import { requireActor } from "../../utils/domain/actor";
import {
  canNameExecutiveAuthors,
  collapseExecutive,
} from "../../utils/domain/visibility";
import {
  genericExecutiveMemberDto,
  toMemberDto,
} from "../../utils/members/dto";
import { memberImages } from "../../utils/members/images";

/**
 * Active members first, by acronym. `?all=1` also returns inactive ones.
 * An account that may not see the executive areas gets one generic "CEA"
 * entry instead of them (canSeeExecutiveMembers).
 *
 * `?for=amendment` is the one exception, for the composers of amendments
 * and transactionals only: an account that presents amendments
 * (canNameExecutiveAuthors) gets the active members with the real areas,
 * to name them as authors. It carries members, never who acts for them
 * nor who holds an office, and what that account reads outside the
 * composer is the generic "CEA".
 *
 * Each member carries the photo of an account that acts for it
 * (`image`, memberImages), for its avatar; an office's, like who holds
 * it, only for those who see the offices.
 */
export default defineEventHandler(async (event): Promise<MemberDto[]> => {
  const actor = await requireActor(event);
  const query = memberListQuerySchema.safeParse(getQuery(event));
  if (!query.success) {
    throw createError({ statusCode: 400, message: "Parámetros no válidos" });
  }

  const forAmendment =
    query.data.for !== undefined && canNameExecutiveAuthors(actor);
  const [rows, images] = await Promise.all([
    db
      .select()
      .from(members)
      .where(
        query.data.all && !forAmendment ? undefined : eq(members.active, true),
      )
      .orderBy(desc(members.active), asc(members.acronym)),
    memberImages(),
  ]);
  const toDto = (row: (typeof rows)[number]) =>
    toMemberDto(row, images.get(row.id) ?? null);
  // The general order of every list of members: asociados, sectorials, the
  // others and the offices (the generic "CEA" among them), each by acronym.
  if (forAmendment) {
    return orderMembers(
      rows.map((row) => ({
        ...toDto(row),
        holderName: null,
        // An office's photo may be its holder's: like the name, not here.
        image: row.kind === "executive" ? null : (images.get(row.id) ?? null),
      })),
    );
  }

  return orderMembers(
    collapseExecutive(actor, rows.map(toDto), genericExecutiveMemberDto),
  );
});
