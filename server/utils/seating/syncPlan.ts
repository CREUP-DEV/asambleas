import type {
  SeatingGroupCategory,
  SeatingGroupKind,
  SeatingGroupSource,
  SeatingPersonSource,
  SeatingPersonStatus,
} from "~~/shared/constants/domain";
import type { SeatingSyncCounts } from "~~/shared/types/api";
import {
  seatingCategoryForIntranet,
  seatingKindForIntranetType,
  seatingStatusForIntranet,
} from "~~/shared/utils/seating/groups";
import type { IntranetAttendeesResponse } from "~~/shared/utils/schemas/seating";
import { SEATING_LIMITS } from "~~/shared/utils/schemas/seating";
import type { SeatingImageKind } from "./intranet";

/**
 * What a sync with the Intranet's attendees changes (docs/seating-plan.md,
 * section 5), worked out from the rows of the plan and the answer, with no
 * database: the caller writes it in one transaction.
 *
 * - Groups are matched by `intranetAccountId` and people by
 *   `intranetAttendeeId`; groups made by hand, people added by hand and
 *   placeholders are never touched, not even inside an Intranet group.
 * - A row is written only when a field it keeps from the Intranet changed,
 *   so a sync that brings nothing new leaves every lock token as it was.
 *   `needsSeat`, `label` and `position` are the platform's: never written
 *   back (a new person's position is set once, after the group's last).
 * - What the Intranet no longer lists gets `goneAt` (and loses its image:
 *   the platform never serves one the Intranet no longer gives); what comes
 *   back loses it. Assignments are never touched.
 * - Images: a new or changed version is queued; a version that changed,
 *   turned null or whose row is gone has its cached file removed. A version
 *   with no file yet (a fetch that failed) is queued again.
 */

export interface SyncGroupRow {
  id: string;
  source: SeatingGroupSource;
  intranetAccountId: number | null;
  memberId: string | null;
  kind: SeatingGroupKind;
  intranetType: string | null;
  category: SeatingGroupCategory | null;
  acronym: string;
  name: string;
  logoVersion: string | null;
  logoFile: string | null;
  order: number | null;
  goneAt: Date | null;
}

export interface SyncPersonRow {
  id: string;
  groupId: string;
  source: SeatingPersonSource;
  intranetAttendeeId: number | null;
  firstName: string | null;
  surname: string | null;
  status: SeatingPersonStatus;
  photoVersion: string | null;
  photoFile: string | null;
  position: number;
  goneAt: Date | null;
}

/** The Intranet's fields of a group, as written. */
export interface SyncGroupValues {
  memberId: string | null;
  kind: SeatingGroupKind;
  intranetType: string | null;
  category: SeatingGroupCategory | null;
  acronym: string;
  name: string;
  logoVersion: string | null;
  logoFile: string | null;
  order: number | null;
  goneAt: Date | null;
}

export interface SyncGroupInsert extends SyncGroupValues {
  id: string;
  source: "intranet";
  intranetAccountId: number;
}

/** The Intranet's fields of a person, as written. */
export interface SyncPersonValues {
  groupId: string;
  firstName: string | null;
  surname: string | null;
  status: SeatingPersonStatus;
  photoVersion: string | null;
  photoFile: string | null;
  goneAt: Date | null;
}

export interface SyncPersonInsert extends SyncPersonValues {
  id: string;
  source: "intranet";
  intranetAttendeeId: number;
  position: number;
}

export interface SyncImageJob {
  kind: SeatingImageKind;
  /** The group (logo) or the person (photo). */
  id: string;
  /** The account or the attendee in the Intranet. */
  intranetId: number;
  version: string;
}

export interface SeatingSyncPlan {
  groupInserts: SyncGroupInsert[];
  groupUpdates: { id: string; set: Partial<SyncGroupValues> }[];
  peopleInserts: SyncPersonInsert[];
  peopleUpdates: { id: string; set: Partial<SyncPersonValues> }[];
  /** Cached files to delete once the writes commit. */
  removeFiles: string[];
  /** Images to fetch once the writes commit. */
  images: SyncImageJob[];
  counts: SeatingSyncCounts;
}

export interface SeatingSyncInput {
  groups: readonly SyncGroupRow[];
  people: readonly SyncPersonRow[];
  response: IntranetAttendeesResponse;
  /** Platform members by their Intranet id (members.intranetId). */
  memberIdByIntranetId: ReadonlyMap<number, string>;
  now: Date;
  newId: () => string;
}

const clip = (value: string, max: number) => value.slice(0, max);

/** Only the keys whose value differs, compared as stored. */
function changed<T extends object>(row: T, next: Partial<T>): Partial<T> {
  const set: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    const before = row[key];
    const after = next[key];
    const same =
      before instanceof Date || after instanceof Date
        ? (before as Date | null)?.getTime() ===
          (after as Date | null)?.getTime()
        : before === after;
    if (!same) set[key] = after;
  }
  return set;
}

/** The group values an Intranet account gives. */
function accountValues(
  account: IntranetAttendeesResponse["accounts"][number],
  memberId: string | null,
): Omit<SyncGroupValues, "logoFile" | "goneAt"> {
  const acronym = clip(
    account.initials ?? account.designation ?? `#${account.id}`,
    SEATING_LIMITS.acronym,
  );
  return {
    memberId,
    kind: seatingKindForIntranetType(account.type),
    intranetType: account.type,
    category: seatingCategoryForIntranet(account.category),
    acronym,
    name: clip(account.designation ?? acronym, SEATING_LIMITS.groupName),
    logoVersion: account.logo_version,
    order: account.order,
  };
}

const emptyCounts = () => ({ created: 0, updated: 0, gone: 0, back: 0 });

export function planSeatingSync(input: SeatingSyncInput): SeatingSyncPlan {
  const { response, now } = input;
  const plan: SeatingSyncPlan = {
    groupInserts: [],
    groupUpdates: [],
    peopleInserts: [],
    peopleUpdates: [],
    removeFiles: [],
    images: [],
    counts: { groups: emptyCounts(), people: emptyCounts() },
  };

  // Groups -------------------------------------------------------------------
  const groupByAccount = new Map<number, SyncGroupRow>();
  for (const group of input.groups) {
    if (group.source === "intranet" && group.intranetAccountId !== null) {
      groupByAccount.set(group.intranetAccountId, group);
    }
  }
  /** The group id of each account the answer lists. */
  const groupIdOfAccount = new Map<number, string>();

  for (const account of response.accounts) {
    const values = accountValues(
      account,
      input.memberIdByIntranetId.get(account.id) ?? null,
    );
    const existing = groupByAccount.get(account.id);
    if (!existing) {
      const id = input.newId();
      groupIdOfAccount.set(account.id, id);
      plan.groupInserts.push({
        id,
        source: "intranet",
        intranetAccountId: account.id,
        ...values,
        logoFile: null,
        goneAt: null,
      });
      plan.counts.groups.created += 1;
      if (values.logoVersion) {
        plan.images.push({
          kind: "logo",
          id,
          intranetId: account.id,
          version: values.logoVersion,
        });
      }
      continue;
    }
    groupIdOfAccount.set(account.id, existing.id);
    const versionChanged = existing.logoVersion !== values.logoVersion;
    const next: Partial<SyncGroupValues> = { ...values, goneAt: null };
    const set = changed(existing, next);
    // Written even when the row read had no file: a file the image worker
    // names meanwhile (for the old version) never outlives the version.
    if (versionChanged) set.logoFile = null;
    if (versionChanged && existing.logoFile) {
      plan.removeFiles.push(existing.logoFile);
    }
    if (
      values.logoVersion &&
      (versionChanged || !existing.logoFile || existing.goneAt)
    ) {
      plan.images.push({
        kind: "logo",
        id: existing.id,
        intranetId: account.id,
        version: values.logoVersion,
      });
    }
    if (Object.keys(set).length === 0) continue;
    plan.groupUpdates.push({ id: existing.id, set });
    if (existing.goneAt) plan.counts.groups.back += 1;
    const { goneAt: _goneAt, ...rest } = set;
    if (Object.keys(rest).length > 0) plan.counts.groups.updated += 1;
  }

  const listedAccounts = new Set(response.accounts.map((row) => row.id));
  for (const [accountId, group] of groupByAccount) {
    if (listedAccounts.has(accountId) || group.goneAt) continue;
    plan.groupUpdates.push({
      id: group.id,
      set: { goneAt: now, logoVersion: null, logoFile: null },
    });
    if (group.logoFile) plan.removeFiles.push(group.logoFile);
    plan.counts.groups.gone += 1;
  }

  // People -------------------------------------------------------------------
  const personByAttendee = new Map<number, SyncPersonRow>();
  /** The last position of each group, people of every source counted. */
  const lastPosition = new Map<string, number>();
  for (const person of input.people) {
    if (person.source === "intranet" && person.intranetAttendeeId !== null) {
      personByAttendee.set(person.intranetAttendeeId, person);
    }
    lastPosition.set(
      person.groupId,
      Math.max(lastPosition.get(person.groupId) ?? -1, person.position),
    );
  }

  for (const attendee of response.attendees) {
    const groupId = groupIdOfAccount.get(attendee.account_id);
    // The schema refuses an attendee whose account is not listed.
    if (!groupId) continue;
    const values: Omit<SyncPersonValues, "photoFile" | "goneAt"> = {
      groupId,
      firstName: attendee.name,
      surname: attendee.surname,
      status: seatingStatusForIntranet(attendee.status),
      photoVersion: attendee.photo_version,
    };
    const existing = personByAttendee.get(attendee.id);
    if (!existing) {
      const id = input.newId();
      const position = Math.min(
        (lastPosition.get(groupId) ?? -1) + 1,
        SEATING_LIMITS.position,
      );
      lastPosition.set(groupId, position);
      plan.peopleInserts.push({
        id,
        source: "intranet",
        intranetAttendeeId: attendee.id,
        ...values,
        photoFile: null,
        goneAt: null,
        position,
      });
      plan.counts.people.created += 1;
      if (values.photoVersion) {
        plan.images.push({
          kind: "photo",
          id,
          intranetId: attendee.id,
          version: values.photoVersion,
        });
      }
      continue;
    }
    const versionChanged = existing.photoVersion !== values.photoVersion;
    const next: Partial<SyncPersonValues> = { ...values, goneAt: null };
    const set = changed(existing, next);
    // As for logos: never a file of another version on the row.
    if (versionChanged) set.photoFile = null;
    if (versionChanged && existing.photoFile) {
      plan.removeFiles.push(existing.photoFile);
    }
    if (
      values.photoVersion &&
      (versionChanged || !existing.photoFile || existing.goneAt)
    ) {
      plan.images.push({
        kind: "photo",
        id: existing.id,
        intranetId: attendee.id,
        version: values.photoVersion,
      });
    }
    if (Object.keys(set).length === 0) continue;
    plan.peopleUpdates.push({ id: existing.id, set });
    if (existing.goneAt) plan.counts.people.back += 1;
    const { goneAt: _goneAt, ...rest } = set;
    if (Object.keys(rest).length > 0) plan.counts.people.updated += 1;
  }

  const listedAttendees = new Set(response.attendees.map((row) => row.id));
  for (const [attendeeId, person] of personByAttendee) {
    if (listedAttendees.has(attendeeId) || person.goneAt) continue;
    plan.peopleUpdates.push({
      id: person.id,
      set: { goneAt: now, photoVersion: null, photoFile: null },
    });
    if (person.photoFile) plan.removeFiles.push(person.photoFile);
    plan.counts.people.gone += 1;
  }

  return plan;
}

/** Whether a sync changed any row. */
export function syncChangedRows(counts: SeatingSyncCounts): boolean {
  return [counts.groups, counts.people].some(
    (entry) =>
      entry.created > 0 ||
      entry.updated > 0 ||
      entry.gone > 0 ||
      entry.back > 0,
  );
}
