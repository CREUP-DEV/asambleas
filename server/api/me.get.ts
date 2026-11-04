import { defineEventHandler } from "h3";
import { eq } from "drizzle-orm";
import type { MeDto } from "~~/shared/types/api";
import { db } from "../db";
import { members } from "../db/schema";
import { requireActor } from "../utils/domain/actor";
import { toMemberRef } from "../utils/members/dto";

export default defineEventHandler(async (event): Promise<MeDto> => {
  const actor = await requireActor(event);
  const member = actor.memberId
    ? await db.query.members.findFirst({
        where: eq(members.id, actor.memberId),
        columns: { id: true, acronym: true, name: true, kind: true },
      })
    : undefined;

  return {
    id: actor.user.id,
    name: actor.user.name,
    email: actor.user.email,
    image: actor.user.image,
    role: actor.user.role?.name ?? null,
    permissions: [...actor.permissions],
    isAdmin: actor.isAdmin,
    member: member ? toMemberRef(member) : null,
  };
});
