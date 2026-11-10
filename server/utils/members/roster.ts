import { z } from "zod/v4";
import type {
  MemberKind,
  MemberSource,
} from "../../../shared/constants/domain";
import type {
  MemberSyncConfirmedKind,
  MemberSyncDeactivationKind,
} from "../../../shared/types/api";
import { intranetIdSchema } from "../../../shared/utils/schemas/member";
import { acronymKey } from "./dto";

/**
 * Pure part of the intranet roster sync: payload validation, normalization,
 * the plan of inserts, updates and deactivations, and the safeguard against
 * a large deactivation. The I/O lives in `sync.ts`, so this file stays
 * testable without a database.
 *
 * The intranet serializes nullable columns: `initials` and `denomination` may
 * be null, and `/usuarios/sectoriales` has no `university` nor
 * `autonomous_community` keys at all. `id` is the Intranet `users.id`; the
 * public listings of the website send none.
 *
 * Four lists: asociados and sectorials (required: without either the sync
 * fails), and the CEA's places and the guests (Invitado and Desasociado),
 * which an Intranet without those routes may not offer: the sync then
 * leaves that kind untouched (OPTIONAL_ROSTER_KINDS).
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
  /**
   * The Intranet account. Missing or null on the public listings; anything
   * but a positive integer that fits Postgres `integer` invalidates the
   * whole list, so the sync writes nothing.
   */
  id: intranetIdSchema.nullish().transform((value) => value ?? null),
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

/** The member kinds planRosterSync matches by Intranet id, then acronym. */
export type RosterKind = Extract<
  MemberKind,
  "asociado" | "sectorial" | "guest"
>;

/** Every list the sync fetches, in the order acronyms are claimed. */
export type RosterListKind = RosterKind | "executive";

/** Lists the sync does without when the Intranet cannot give them. */
export type OptionalRosterKind = Extract<RosterListKind, "executive" | "guest">;
export const OPTIONAL_ROSTER_KINDS = [
  "executive",
  "guest",
] as const satisfies readonly OptionalRosterKind[];

/**
 * The kinds a large deactivation needs confirming for, in the order the
 * safeguard reports them. Guests come and go and never block a sync.
 */
export const GUARDED_ROSTER_KINDS = [
  "asociado",
  "sectorial",
] as const satisfies readonly RosterKind[];

export interface RosterMember {
  kind: RosterKind;
  acronym: string;
  name: string;
  university: string | null;
  region: string | null;
  /** The Intranet account (`users.id`), or null when the roster sends none. */
  intranetId: number | null;
}

const ACRONYM_MAX_LENGTH = 20;
const NAME_MAX_LENGTH = 200;
const DETAIL_MAX_LENGTH = 200;

const clip = (value: string | null, max: number) =>
  value === null ? null : value.slice(0, max);

/** The acronym key of a list entry, or null for one without initials. */
function entryKey(entry: IntranetRosterEntry): string | null {
  const acronym = clip(entry.initials, ACRONYM_MAX_LENGTH);
  return acronym ? acronymKey(acronym) : null;
}

/**
 * The entries whose acronym none of `reserved` uses: a guest never takes an
 * acronym the CEA list names, so a new office is not lost to a guest whose
 * initials happen to match it.
 */
export function withoutReservedAcronyms(
  entries: readonly IntranetRosterEntry[],
  reserved: readonly IntranetRosterEntry[],
): IntranetRosterEntry[] {
  const keys = new Set(reserved.map(entryKey));
  return entries.filter((entry) => {
    const key = entryKey(entry);
    return key === null || !keys.has(key);
  });
}

/**
 * Turns the intranet lists into one roster keyed by acronym. Rows without
 * initials cannot be stored and are skipped. An acronym or an Intranet id
 * listed twice keeps its first appearance (asociados come first, guests
 * last).
 */
export function normalizeRoster(
  lists: { kind: RosterKind; entries: IntranetRosterEntry[] }[],
): {
  members: RosterMember[];
  skipped: number;
  duplicates: string[];
  duplicateIds: number[];
} {
  const byKey = new Map<string, RosterMember>();
  const seenIds = new Set<number>();
  const duplicates: string[] = [];
  const duplicateIds: number[] = [];
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
      if (entry.id !== null) {
        if (seenIds.has(entry.id)) {
          duplicateIds.push(entry.id);
          continue;
        }
        seenIds.add(entry.id);
      }
      byKey.set(key, {
        kind: list.kind,
        acronym,
        name: clip(entry.denomination, NAME_MAX_LENGTH) ?? acronym,
        university: clip(entry.university, DETAIL_MAX_LENGTH),
        region: clip(entry.autonomous_community, DETAIL_MAX_LENGTH),
        intranetId: entry.id,
      });
    }
  }

  return { members: [...byKey.values()], skipped, duplicates, duplicateIds };
}

export interface ExistingMember {
  id: string;
  kind: MemberKind;
  acronym: string;
  name: string;
  university: string | null;
  region: string | null;
  intranetId: number | null;
  source: MemberSource;
  active: boolean;
}

export interface RosterSyncPlan {
  /** Roster entries no stored member stands for. */
  create: RosterMember[];
  /**
   * Intranet members whose data changed or that come back to the roster.
   * `values.acronym` is the member's current one when the roster's is held
   * by another member (acronymConflicts, manualConflicts), and
   * `values.intranetId` keeps the stored id when the roster sends none.
   */
  update: { id: string; values: RosterMember }[];
  /** Intranet members still listed and unchanged: only `syncedAt` moves. */
  unchanged: string[];
  /** Active intranet members no longer listed. */
  deactivate: string[];
  /** Roster acronyms held by a manual member, which the sync never touches. */
  manualConflicts: string[];
  /**
   * Roster acronyms another intranet member keeps (one the roster no longer
   * lists, or one whose own new acronym is taken): the member that wanted
   * it keeps its current acronym, or the entry is not created.
   */
  acronymConflicts: string[];
  /**
   * Members matched by acronym whose stored Intranet id the roster replaces:
   * the old account is no longer listed and a new one uses the acronym.
   */
  replacedIds: { id: string; acronym: string; from: number; to: number }[];
}

/**
 * Compares the roster with the stored members of the kinds in `synced` (the
 * lists the Intranet gave):
 * 1. an entry with an Intranet id takes the member stored with that id, so
 *    a change of acronym updates the member instead of creating another;
 * 2. any other entry takes the member with its acronym (case-insensitive),
 *    unless that member was taken in step 1 (it is being renamed away under
 *    its own id: the entry is then created). The entry's id is stored on
 *    the member; one the roster no longer lists is replaced (replacedIds),
 *    and an entry without id never clears a stored one.
 * Manual members are never touched, even when the roster lists their
 * acronym or id. No plan leaves two members with the same acronym: a
 * rename onto an acronym another member keeps is not applied (the member
 * keeps its own) and such an entry is not created. Only members of a kind
 * in `synced` are deactivated: a list the Intranet did not give deactivates
 * nobody.
 */
export function planRosterSync(
  roster: RosterMember[],
  existing: ExistingMember[],
  synced: readonly RosterKind[] = ["asociado", "sectorial", "guest"],
): RosterSyncPlan {
  const plan: RosterSyncPlan = {
    create: [],
    update: [],
    unchanged: [],
    deactivate: [],
    manualConflicts: [],
    acronymConflicts: [],
    replacedIds: [],
  };

  const byIntranetId = new Map<number, ExistingMember>();
  const byKey = new Map<string, ExistingMember>();
  for (const member of existing) {
    if (member.intranetId !== null && !byIntranetId.has(member.intranetId)) {
      byIntranetId.set(member.intranetId, member);
    }
    const key = acronymKey(member.acronym);
    if (!byKey.has(key)) byKey.set(key, member);
  }

  // Which stored member each entry stands for: by Intranet id first.
  const matchOf = new Map<RosterMember, ExistingMember>();
  const claimed = new Map<string, RosterMember>();
  const pending: RosterMember[] = [];
  for (const entry of roster) {
    const member =
      entry.intranetId === null
        ? undefined
        : byIntranetId.get(entry.intranetId);
    if (!member) {
      pending.push(entry);
    } else if (member.source === "manual") {
      plan.manualConflicts.push(member.acronym);
    } else {
      matchOf.set(entry, member);
      claimed.set(member.id, entry);
    }
  }

  // Then by acronym, among the members step 1 left.
  const toCreate: RosterMember[] = [];
  for (const entry of pending) {
    const holder = byKey.get(acronymKey(entry.acronym));
    if (!holder || claimed.has(holder.id)) {
      toCreate.push(entry);
    } else if (holder.source === "manual") {
      plan.manualConflicts.push(holder.acronym);
    } else {
      matchOf.set(entry, holder);
      claimed.set(holder.id, entry);
    }
  }

  // The acronym key each member ends with. A rename onto a key another
  // member keeps is not applied; that member then keeps its own key, which
  // may block another rename, so repeat until nothing changes.
  const finalKey = new Map<string, string>();
  for (const member of existing) {
    const entry = claimed.get(member.id);
    finalKey.set(member.id, acronymKey((entry ?? member).acronym));
  }
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const holders = new Map<string, number>();
    for (const key of finalKey.values()) {
      holders.set(key, (holders.get(key) ?? 0) + 1);
    }
    for (const member of existing) {
      if (!claimed.has(member.id) || blocked.has(member.id)) continue;
      const key = finalKey.get(member.id)!;
      const own = acronymKey(member.acronym);
      if (key !== own && (holders.get(key) ?? 0) > 1) {
        blocked.add(member.id);
        finalKey.set(member.id, own);
        changed = true;
      }
    }
  }
  for (const id of blocked) {
    const wanted = acronymKey(claimed.get(id)!.acronym);
    const keeper = existing.find(
      (member) => member.id !== id && finalKey.get(member.id) === wanted,
    );
    if (keeper?.source === "manual") plan.manualConflicts.push(keeper.acronym);
    else plan.acronymConflicts.push(claimed.get(id)!.acronym);
  }

  for (const entry of roster) {
    const current = matchOf.get(entry);
    if (!current) continue;
    const values: RosterMember = {
      ...entry,
      acronym: blocked.has(current.id) ? current.acronym : entry.acronym,
      intranetId: entry.intranetId ?? current.intranetId,
    };
    if (
      entry.intranetId !== null &&
      current.intranetId !== null &&
      current.intranetId !== entry.intranetId
    ) {
      plan.replacedIds.push({
        id: current.id,
        acronym: current.acronym,
        from: current.intranetId,
        to: entry.intranetId,
      });
    }
    const differs =
      !current.active ||
      current.kind !== values.kind ||
      current.acronym !== values.acronym ||
      current.name !== values.name ||
      current.university !== values.university ||
      current.region !== values.region ||
      current.intranetId !== values.intranetId;
    if (differs) plan.update.push({ id: current.id, values });
    else plan.unchanged.push(current.id);
  }

  const takenKeys = new Set(finalKey.values());
  for (const entry of toCreate) {
    if (takenKeys.has(acronymKey(entry.acronym))) {
      plan.acronymConflicts.push(entry.acronym);
    } else {
      plan.create.push(entry);
    }
  }

  const deactivatable = new Set<MemberKind>(synced);
  for (const member of existing) {
    if (member.source !== "intranet" || !member.active) continue;
    if (!deactivatable.has(member.kind)) continue;
    if (!claimed.has(member.id)) plan.deactivate.push(member.id);
  }

  return plan;
}

// CEA places ------------------------------------------------------------------

export interface ExecutiveSyncPlan {
  /** Offices the CEA list names and no member has the acronym of. */
  create: { acronym: string; name: string }[];
  /** Offices still named after their acronym, which the list now names. */
  rename: { id: string; name: string }[];
  /** CEA acronyms another kind of member holds: never touched. */
  conflicts: string[];
}

/**
 * The executive offices the CEA list adds (`/usuarios/cea`, one account per
 * place). Offices are matched by acronym only: an account outlives whoever
 * holds the place, but the platform has always keyed offices by initials
 * (link.ts), and sign-in links CEA accounts the same way. Offices are
 * manual members:
 * - a missing one is created, named after the list's denomination;
 * - one still named after its acronym (created at a sign-in) takes the
 *   denomination; one renamed by hand keeps its name;
 * - none is ever deactivated, nor reactivated: a manager does that.
 * An acronym held by a member of another kind is left alone (conflicts).
 */
export function planExecutiveSync(
  entries: IntranetRosterEntry[],
  existing: Pick<ExistingMember, "id" | "kind" | "acronym" | "name">[],
): ExecutiveSyncPlan {
  const plan: ExecutiveSyncPlan = { create: [], rename: [], conflicts: [] };
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const member of existing) {
    const key = acronymKey(member.acronym);
    if (!byKey.has(key)) byKey.set(key, member);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const acronym = clip(entry.initials, ACRONYM_MAX_LENGTH);
    if (!acronym) continue;
    const key = acronymKey(acronym);
    if (seen.has(key)) continue;
    seen.add(key);
    const denomination = clip(entry.denomination, NAME_MAX_LENGTH);
    const holder = byKey.get(key);
    if (!holder) {
      plan.create.push({ acronym, name: denomination ?? acronym });
    } else if (holder.kind !== "executive") {
      plan.conflicts.push(holder.acronym);
    } else if (
      denomination &&
      holder.name === holder.acronym &&
      denomination !== holder.name
    ) {
      plan.rename.push({ id: holder.id, name: denomination });
    }
  }
  return plan;
}

// Safeguard -------------------------------------------------------------------

/** A sync may always deactivate this many members of a kind... */
export const LARGE_DEACTIVATION_MIN = 3;
/** ...or this share of its active members, whichever is larger. */
export const LARGE_DEACTIVATION_PERCENT = 30;

/**
 * Whether deactivating `toDeactivate` of `active` members of a kind needs
 * confirmation: all of them, or more than max(3, 30%) of them. Integer
 * math, so 3 of 10 is exactly 30% and passes.
 */
export function isLargeDeactivation(
  active: number,
  toDeactivate: number,
): boolean {
  if (active <= 0 || toDeactivate <= 0) return false;
  if (toDeactivate >= active) return true;
  return (
    toDeactivate > LARGE_DEACTIVATION_MIN &&
    toDeactivate * 100 > active * LARGE_DEACTIVATION_PERCENT
  );
}

/**
 * Whether a large deactivation is the one the account confirmed: every kind
 * in `large` is in `confirmed` with at least as many members to deactivate.
 * A confirmation shown fewer members (the Intranet returned less on the
 * retry, or an empty list) does not cover the new plan. Empty `large` needs
 * no confirmation.
 */
export function isDeactivationConfirmed(
  large: readonly MemberSyncDeactivationKind[],
  confirmed: readonly MemberSyncConfirmedKind[],
): boolean {
  return large.every((entry) =>
    confirmed.some(
      (item) =>
        item.kind === entry.kind && entry.toDeactivate <= item.toDeactivate,
    ),
  );
}

/**
 * The roster kinds a plan would deactivate too much of (isLargeDeactivation),
 * counting the active intranet members of each kind before the sync. Empty
 * when the plan can be applied without confirmation.
 */
export function findLargeDeactivations(
  existing: ExistingMember[],
  deactivate: readonly string[],
): MemberSyncDeactivationKind[] {
  const leaving = new Set(deactivate);
  const kinds: MemberSyncDeactivationKind[] = [];
  for (const kind of GUARDED_ROSTER_KINDS) {
    let active = 0;
    let toDeactivate = 0;
    for (const member of existing) {
      if (member.kind !== kind || member.source !== "intranet") continue;
      if (!member.active) continue;
      active += 1;
      if (leaving.has(member.id)) toDeactivate += 1;
    }
    if (isLargeDeactivation(active, toDeactivate)) {
      kinds.push({ kind, active, toDeactivate });
    }
  }
  return kinds;
}
