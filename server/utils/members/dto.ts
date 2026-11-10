import { GENERIC_EXECUTIVE_MEMBER } from "~~/shared/constants/domain";
import type { MemberDto, MemberRef } from "~~/shared/types/api";
import type { members } from "../../db/schema";

export type MemberRow = typeof members.$inferSelect;

export function toMemberRef(
  member: Pick<MemberRow, "id" | "acronym" | "name" | "kind">,
): MemberRef {
  return {
    id: member.id,
    acronym: member.acronym,
    name: member.name,
    kind: member.kind,
  };
}

export function toMemberDto(member: MemberRow): MemberDto {
  return {
    ...toMemberRef(member),
    university: member.university,
    region: member.region,
    source: member.source,
    active: member.active,
    syncedAt: member.syncedAt?.toISOString() ?? null,
    updatedAt: member.updatedAt.toISOString(),
  };
}

/**
 * The one entry GET /api/members returns instead of the executive areas to
 * an account that may not see them: the generic "CEA", active while any
 * area is. It is not a row: it cannot be edited (its `updatedAt` is no lock
 * token) and no body may name it as a member.
 */
export function genericExecutiveMemberDto(areas: MemberDto[]): MemberDto {
  return {
    ...GENERIC_EXECUTIVE_MEMBER,
    university: null,
    region: null,
    source: "manual",
    active: areas.some((area) => area.active),
    syncedAt: null,
    updatedAt: new Date(0).toISOString(),
  };
}

/** Canonical key for matching acronyms: the unique index is case-sensitive. */
export function acronymKey(acronym: string): string {
  return acronym.trim().toLocaleLowerCase("es");
}
