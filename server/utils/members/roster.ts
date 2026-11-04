import { z } from "zod/v4";
import type { MemberKind, MemberSource } from "../../../shared/constants/domain";
import { acronymKey } from "./dto";

/**
 * Pure part of the intranet roster sync: payload validation, normalization
 * and the plan of inserts, updates and deactivations. The I/O lives in
 * `sync.ts`, so this file stays testable without a database.
 *
 * The intranet serializes nullable columns: `initials` and `denomination` may
 * be null, and `/usuarios/sectoriales` has no `university` nor
 * `autonomous_community` keys at all.
 */

const optionalText = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/\s+/g, " ").trim();
    return text === "" ? null : text;
  });

export const intranetRosterEntrySchema = z.object({
  order: z.number().nullish(),
  denomination: optionalText,
  initials: optionalText,
  university: optionalText,
  autonomous_community: optionalText,
});

export const intranetRosterResponseSchema = z.object({
  data: z.array(intranetRosterEntrySchema).max(5_000),
  generated_at: z.string().nullish(),
});

export type IntranetRosterEntry = z.output<typeof intranetRosterEntrySchema>;

export type RosterKind = Extract<MemberKind, "asociado" | "sectorial">;

export interface RosterMember {
  kind: RosterKind;
  acronym: string;
  name: string;
  university: string | null;
  region: string | null;
}

const ACRONYM_MAX_LENGTH = 20;
const NAME_MAX_LENGTH = 200;
const DETAIL_MAX_LENGTH = 200;

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

/**
 * Turns both intranet lists into one roster keyed by acronym. Rows without
 * initials cannot be matched and are skipped. An acronym listed twice keeps
 * its first appearance (asociados come first).
 */
export function normalizeRoster(lists: { kind: RosterKind; entries: IntranetRosterEntry[] }[]): {
  members: RosterMember[];
  skipped: number;
  duplicates: string[];
} {
  const byKey = new Map<string, RosterMember>();
  const duplicates: string[] = [];
  let skipped = 0;

  for (const list of lists) {
    for (const entry of list.entries) {
      const acronym = clip(entry.initials, ACRONYM_MAX_LENGTH);
      if (!acronym) {
        skipped += 1;
        continue;
      }
      const key = acronymKey(acronym);
      if (byKey.has(key)) {
        duplicates.push(acronym);
        continue;
      }
      byKey.set(key, {
        kind: list.kind,
        acronym,
        name: clip(entry.denomination, NAME_MAX_LENGTH) ?? acronym,
        university: clip(entry.university, DETAIL_MAX_LENGTH),
        region: clip(entry.autonomous_community, DETAIL_MAX_LENGTH),
      });
    }
  }

  return { members: [...byKey.values()], skipped, duplicates };
}

export interface ExistingMember {
  id: string;
  kind: MemberKind;
  acronym: string;
  name: string;
  university: string | null;
  region: string | null;
  source: MemberSource;
  active: boolean;
}

export interface RosterSyncPlan {
  create: RosterMember[];
  /** Intranet members whose data changed or that come back to the roster. */
  update: { id: string; values: RosterMember }[];
  /** Intranet members still listed and unchanged: only `syncedAt` moves. */
  unchanged: string[];
  /** Intranet members no longer listed. */
  deactivate: string[];
  /** Roster acronyms held by a manual member, which the sync never touches. */
  manualConflicts: string[];
}

/**
 * Compares the roster with the stored members. Manual members are never
 * touched, even when the roster lists their acronym.
 */
export function planRosterSync(roster: RosterMember[], existing: ExistingMember[]): RosterSyncPlan {
  const existingByKey = new Map(existing.map((member) => [acronymKey(member.acronym), member]));
  const listed = new Set<string>();
  const plan: RosterSyncPlan = {
    create: [],
    update: [],
    unchanged: [],
    deactivate: [],
    manualConflicts: [],
  };

  for (const entry of roster) {
    const key = acronymKey(entry.acronym);
    listed.add(key);
    const current = existingByKey.get(key);
    if (!current) {
      plan.create.push(entry);
      continue;
    }
    if (current.source === "manual") {
      plan.manualConflicts.push(current.acronym);
      continue;
    }
    const changed =
      !current.active ||
      current.kind !== entry.kind ||
      current.acronym !== entry.acronym ||
      current.name !== entry.name ||
      current.university !== entry.university ||
      current.region !== entry.region;
    if (changed) plan.update.push({ id: current.id, values: entry });
    else plan.unchanged.push(current.id);
  }

  for (const member of existing) {
    if (member.source !== "intranet" || !member.active) continue;
    if (!listed.has(acronymKey(member.acronym))) plan.deactivate.push(member.id);
  }

  return plan;
}
