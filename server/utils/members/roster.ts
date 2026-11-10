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
 * public listings of the website send none, nor an `email`.
 *
 * Who an entry is: its Intranet id, then its email (which survives the
 * account being recreated with a new id). Initials only identify a stored
 * member that has neither, so they never hand a member to another account.
 *
 * Three lists: asociados, sectorials and the CEA's places (one account per
 * office, which outlives whoever holds it), all synced the same way. The
 * first two are required: without either the sync fails. The CEA list is
 * optional, since an Intranet without that route may not offer it: the
 * sync then leaves the offices untouched (OPTIONAL_ROSTER_KINDS).
 */

const optionalText = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/\s+/g, " ").trim();
    return text === "" ? null : text;
  });

/** Longest address SMTP allows (RFC 5321). */
const EMAIL_MAX_LENGTH = 254;

/**
 * The account's sign-in email, lowercased. Anything that does not look like
 * one is null rather than invalidating the list: it only helps matching.
 */
const optionalEmail = z
  .unknown()
  .optional()
  .transform((value) => {
    if (typeof value !== "string") return null;
    const email = value.trim().toLowerCase();
    return email.length <= EMAIL_MAX_LENGTH && /^[^\s@]+@[^\s@]+$/.test(email)
      ? email
      : null;
  });

export const intranetRosterEntrySchema = z.object({
  /**
   * The Intranet account. Missing or null on the public listings; anything
   * but a positive integer that fits Postgres `integer` invalidates the
   * whole list, so the sync writes nothing.
   */
  id: intranetIdSchema.nullish().transform((value) => value ?? null),
  email: optionalEmail,
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

/** The member kinds planRosterSync matches by Intranet id, then email. */
export type RosterKind = Extract<
  MemberKind,
  "asociado" | "sectorial" | "executive"
>;

/** Every list the sync fetches. */
export type RosterListKind = RosterKind;

/** Lists the sync does without when the Intranet cannot give them. */
export type OptionalRosterKind = Extract<RosterListKind, "executive">;
export const OPTIONAL_ROSTER_KINDS = [
  "executive",
] as const satisfies readonly OptionalRosterKind[];

/**
 * The kinds a large deactivation needs confirming for, in the order the
 * safeguard reports them.
 */
export const GUARDED_ROSTER_KINDS = [
  "asociado",
  "sectorial",
  "executive",
] as const satisfies readonly RosterKind[];

export interface RosterMember {
  kind: RosterKind;
  acronym: string;
  name: string;
  university: string | null;
  region: string | null;
  /** The Intranet account (`users.id`), or null when the roster sends none. */
  intranetId: number | null;
  /**
   * That account's sign-in email, lowercased, or null when the roster sends
   * none. Never put in an audit row, a log or a response.
   */
  email: string | null;
}

const ACRONYM_MAX_LENGTH = 20;
const NAME_MAX_LENGTH = 200;
const DETAIL_MAX_LENGTH = 200;

const clip = (value: string | null, max: number) =>
  value === null ? null : value.slice(0, max);

/**
 * Turns the intranet lists into one roster keyed by acronym. Rows without
 * initials cannot be stored and are skipped. An acronym or an Intranet id
 * listed twice keeps its first appearance (asociados come first); an email
 * listed twice is kept only on its first appearance.
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
  const seenEmails = new Set<string>();
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
      const email =
        entry.email !== null && !seenEmails.has(entry.email)
          ? entry.email
          : null;
      if (email) seenEmails.add(email);
      byKey.set(key, {
        kind: list.kind,
        acronym,
        name: clip(entry.denomination, NAME_MAX_LENGTH) ?? acronym,
        university: clip(entry.university, DETAIL_MAX_LENGTH),
        region: clip(entry.autonomous_community, DETAIL_MAX_LENGTH),
        intranetId: entry.id,
        email,
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
  email: string | null;
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
   * `values.intranetId` and `values.email` keep the stored ones when the
   * roster sends none (or the email is another member's).
   */
  update: {
    id: string;
    values: RosterMember;
    /**
     * A manual executive office the CEA list names: it becomes an intranet
     * member (offices used to be created by hand or at a sign-in).
     */
    adopt?: true;
  }[];
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
   * Members matched by email whose stored Intranet id the roster replaces:
   * the account was recreated in the Intranet with the same address.
   */
  replacedIds: { id: string; acronym: string; from: number; to: number }[];
}

/**
 * Compares the roster with the stored members:
 * 1. an entry with an Intranet id takes the member stored with that id, so
 *    a change of acronym updates the member instead of creating another;
 * 2. then an entry with an email takes the member stored with that email:
 *    the account was recreated, and its new id replaces the stored one
 *    (replacedIds);
 * 3. any other entry takes the member with its acronym (case-insensitive)
 *    only when that member has no identity the entry contradicts (another
 *    Intranet id or another email): members stored before the Intranet sent
 *    either, and manual offices. A member with another identity is never
 *    handed to the entry, which is then not created while the acronym is
 *    taken (acronymConflicts). Nor is a member taken in an earlier step (it
 *    is being renamed away: the entry is then created). An entry without id
 *    or email never clears a stored one.
 * Manual members are never touched, even when the roster lists their
 * acronym or id, except a manual executive office the CEA list names by
 * its acronym: it is adopted (`adopt`) and syncs from then on. No plan
 * leaves two members with the same acronym: a rename onto an acronym
 * another member keeps is not applied (the member keeps its own) and such
 * an entry is not created. Only members of a kind in `synced` (the lists
 * the Intranet gave) are deactivated: a list it did not give deactivates
 * nobody.
 */
export function planRosterSync(
  roster: RosterMember[],
  existing: ExistingMember[],
  synced: readonly RosterKind[] = GUARDED_ROSTER_KINDS,
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
  const byEmail = new Map<string, ExistingMember>();
  const byKey = new Map<string, ExistingMember>();
  for (const member of existing) {
    if (member.intranetId !== null && !byIntranetId.has(member.intranetId)) {
      byIntranetId.set(member.intranetId, member);
    }
    if (member.email !== null && !byEmail.has(member.email)) {
      byEmail.set(member.email, member);
    }
    const key = acronymKey(member.acronym);
    if (!byKey.has(key)) byKey.set(key, member);
  }

  // Which stored member each entry stands for: by Intranet id first.
  const matchOf = new Map<RosterMember, ExistingMember>();
  const claimed = new Map<string, RosterMember>();
  const take = (
    entries: RosterMember[],
    find: (entry: RosterMember) => ExistingMember | undefined,
  ): RosterMember[] => {
    const left: RosterMember[] = [];
    for (const entry of entries) {
      const member = find(entry);
      if (!member || claimed.has(member.id)) {
        left.push(entry);
      } else if (member.source === "manual") {
        plan.manualConflicts.push(member.acronym);
      } else {
        matchOf.set(entry, member);
        claimed.set(member.id, entry);
      }
    }
    return left;
  };
  const byId = take(roster, (entry) =>
    entry.intranetId === null ? undefined : byIntranetId.get(entry.intranetId),
  );
  // Then by email, among the members step 1 left.
  const pending = take(byId, (entry) =>
    entry.email === null ? undefined : byEmail.get(entry.email),
  );

  // Then by acronym, only a member with no identity the entry contradicts.
  const toCreate: RosterMember[] = [];
  const adopted = new Set<string>();
  for (const entry of pending) {
    const holder = byKey.get(acronymKey(entry.acronym));
    if (
      !holder ||
      claimed.has(holder.id) ||
      contradicts(holder.intranetId, entry.intranetId) ||
      contradicts(holder.email, entry.email)
    ) {
      toCreate.push(entry);
    } else if (
      holder.source === "manual" &&
      holder.kind === "executive" &&
      entry.kind === "executive"
    ) {
      matchOf.set(entry, holder);
      claimed.set(holder.id, entry);
      adopted.add(holder.id);
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
    if (keeper?.source === "manual" && !adopted.has(keeper.id)) {
      plan.manualConflicts.push(keeper.acronym);
    } else {
      plan.acronymConflicts.push(claimed.get(id)!.acronym);
    }
  }

  // Every email stays on one member: one another member stores is not
  // moved (the unique index would refuse it), and no entry is created with it.
  const takenEmails = new Set(
    existing.flatMap((member) => (member.email ? [member.email] : [])),
  );
  const emailFor = (entry: RosterMember, current: ExistingMember | null) => {
    if (entry.email === null || entry.email === current?.email) {
      return current?.email ?? entry.email;
    }
    if (takenEmails.has(entry.email)) return current?.email ?? null;
    takenEmails.add(entry.email);
    return entry.email;
  };

  for (const entry of roster) {
    const current = matchOf.get(entry);
    if (!current) continue;
    const values: RosterMember = {
      ...entry,
      acronym: blocked.has(current.id) ? current.acronym : entry.acronym,
      intranetId: entry.intranetId ?? current.intranetId,
      email: emailFor(entry, current),
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
    const adopt = adopted.has(current.id);
    const differs =
      adopt ||
      !current.active ||
      current.kind !== values.kind ||
      current.acronym !== values.acronym ||
      current.name !== values.name ||
      current.university !== values.university ||
      current.region !== values.region ||
      current.intranetId !== values.intranetId ||
      current.email !== values.email;
    if (differs) {
      plan.update.push(
        adopt ? { id: current.id, values, adopt } : { id: current.id, values },
      );
    } else plan.unchanged.push(current.id);
  }

  const takenKeys = new Set(finalKey.values());
  for (const entry of toCreate) {
    if (takenKeys.has(acronymKey(entry.acronym))) {
      plan.acronymConflicts.push(entry.acronym);
    } else {
      plan.create.push({ ...entry, email: emailFor(entry, null) });
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

/** Two identities that are both known and differ. */
function contradicts<T>(stored: T | null, listed: T | null): boolean {
  return stored !== null && listed !== null && stored !== listed;
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
