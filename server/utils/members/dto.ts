import type { MemberDto, MemberRef } from "~~/shared/types/api";
import type { members } from "../../db/schema";

export type MemberRow = typeof members.$inferSelect;

export function toMemberRef(member: Pick<MemberRow, "id" | "acronym" | "name" | "kind">): MemberRef {
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
  };
}

/** Canonical key for matching acronyms: the unique index is case-sensitive. */
export function acronymKey(acronym: string): string {
  return acronym.trim().toLocaleLowerCase("es");
}
