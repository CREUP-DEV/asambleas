import type {
  HeadcountDto,
  HeadcountEntryInput,
  HeadcountGuestDto,
  HeadcountMemberDto,
} from "~~/shared/types/api";
import {
  compareGuests,
  compareRollCall,
  votesInHeadcount,
} from "~~/shared/utils/headcount";

/**
 * The Mesa's headcount form, as pure functions: one checkbox per member in
 * the order of the roll call (asociados, sectorials), then one per guest
 * (an account with the role Invitado). An asociado with a vote that is not
 * in the room may delegate it to another one; a delegation counts only
 * while its receiver is in the room. Sectorials and guests are only marked
 * in the room: they never vote, delegate nor count. The server counts and
 * checks it again (tallyHeadcount).
 */

/** A member on the form, and whether it votes in this count. */
export interface FormMember extends HeadcountMemberDto {
  voting: boolean;
}

export interface FormRow {
  present: boolean;
  /** Who votes for this member when it is not in the room. */
  delegateId: string | null;
}

export type HeadcountForm = Record<string, FormRow>;

/** A guest on the form: an account with the role Invitado. */
export interface FormGuest {
  userId: string;
  name: string;
}

/** The guests in the room, by account id. */
export type GuestForm = Record<string, boolean>;

/** A count as the form holds it: members, guests and note. */
export interface HeadcountFormState {
  form: HeadcountForm;
  guests: GuestForm;
  note: string;
}

/** What survives an accidental close of the form (this device only). */
export interface HeadcountDraft {
  /** The count being corrected, or null for a new one. */
  targetId: string | null;
  form: HeadcountForm;
  /** Absent in drafts saved before guests were counted. */
  guests?: GuestForm;
  note: string;
  savedAt: string;
  /**
   * For a correction, the count as the form started from it and its lock
   * token: restored after someone else corrected it (another token), the
   * draft's changes go over that correction (rebaseHeadcountForm) instead
   * of overwriting it. Absent in older drafts and for a new count.
   */
  base?: HeadcountFormState & { updatedAt: string };
}

function sameRow(a: FormRow | undefined, b: FormRow | undefined): boolean {
  return (
    (a?.present ?? false) === (b?.present ?? false) &&
    (a?.delegateId ?? null) === (b?.delegateId ?? null)
  );
}

/**
 * This device's changes to a count (`mine` against `base`, the form it
 * started from) put over a newer copy of it (`theirs`: another Mesa
 * member's correction saved meanwhile): a member or guest this device
 * changed keeps its change, every other one takes theirs, and so does the
 * note unless this device changed it. `clashes` are the members and guests
 * (by id) both changed, each its own way: this device's change stays, and
 * the form says so. Rows only `theirs` lists come from it; rows it no
 * longer lists drop out.
 */
export function rebaseHeadcountForm(
  base: HeadcountFormState,
  mine: HeadcountFormState,
  theirs: HeadcountFormState,
): HeadcountFormState & { clashes: string[] } {
  const clashes: string[] = [];
  const form: HeadcountForm = {};
  for (const [id, their] of Object.entries(theirs.form)) {
    const own = mine.form[id];
    if (own === undefined || sameRow(own, base.form[id])) {
      form[id] = their;
      continue;
    }
    form[id] = own;
    if (!sameRow(their, base.form[id]) && !sameRow(their, own)) {
      clashes.push(id);
    }
  }
  const guests: GuestForm = {};
  for (const [id, their] of Object.entries(theirs.guests)) {
    const own = mine.guests[id];
    const was = base.guests[id] ?? false;
    if (own === undefined || own === was) {
      guests[id] = their;
      continue;
    }
    guests[id] = own;
    if (their !== was && their !== own) clashes.push(id);
  }
  return {
    form,
    guests,
    note: mine.note !== base.note ? mine.note : theirs.note,
    clashes,
  };
}

/**
 * The guests of the form: the accounts with the role Invitado now and, for
 * a count being corrected, the ones it listed (by the name they had then).
 * A deleted account is not offered: its entry stays as it was.
 */
export function headcountFormGuests(
  guests: readonly HeadcountGuestDto[],
  target: HeadcountDto | null,
): FormGuest[] {
  const byId = new Map<string, FormGuest>();
  for (const guest of [...(target?.guests ?? []), ...guests]) {
    if (guest.userId && !byId.has(guest.userId)) {
      byId.set(guest.userId, { userId: guest.userId, name: guest.name });
    }
  }
  return [...byId.values()].sort(compareGuests);
}

/** The guests of `guests` that `from` found in the room. */
export function guestFormFrom(
  guests: readonly FormGuest[],
  from: HeadcountDto | null,
): GuestForm {
  const present = new Set((from?.guests ?? []).map((guest) => guest.userId));
  return Object.fromEntries(
    guests.map((guest) => [guest.userId, present.has(guest.userId)]),
  );
}

/** The account ids of the guests in the room. */
export function guestIdsOf(form: GuestForm): string[] {
  return Object.entries(form).flatMap(([id, present]) => (present ? [id] : []));
}

/** Voters first, then the roll-call order. */
function compareFormMembers(a: FormMember, b: FormMember): number {
  if (a.voting !== b.voting) return a.voting ? -1 : 1;
  return compareRollCall(a, b);
}

/**
 * The members of the form: those a new count lists and, when `target` is
 * a count being corrected, those it listed that are no longer active, since
 * the count is a snapshot of its own moment. A corrected count keeps who
 * voted in it: a member it counted with a vote keeps it, and one it listed
 * without a vote never gets one.
 */
export function headcountFormMembers(
  members: readonly HeadcountMemberDto[],
  target: HeadcountDto | null,
): FormMember[] {
  const listed = new Map(
    (target?.entries ?? []).map((entry) => [entry.member.id, entry]),
  );
  const known = new Set(members.map((member) => member.id));
  const extra = (target?.entries ?? [])
    .map((entry) => entry.member)
    .filter((member) => !known.has(member.id));
  return [...members, ...extra]
    .map((member) => ({
      ...member,
      voting: listed.get(member.id)?.voting ?? votesInHeadcount(member.kind),
    }))
    .sort(compareFormMembers);
}

/**
 * A form for `members`, filled from `from` (the count being corrected, or
 * the latest one, since few people move between counts). Members `from`
 * does not list start out of the room; delegations to members no longer
 * listed, or between members that do not vote, are dropped.
 */
export function headcountFormFrom(
  members: readonly FormMember[],
  from: HeadcountDto | null,
): HeadcountForm {
  const voters = new Set(
    members.filter((member) => member.voting).map((member) => member.id),
  );
  const ids = new Set(members.map((member) => member.id));
  const form: HeadcountForm = Object.fromEntries(
    members.map((member) => [member.id, { present: false, delegateId: null }]),
  );
  for (const entry of from?.entries ?? []) {
    if (!ids.has(entry.member.id)) continue;
    if (entry.mark === "present") {
      form[entry.member.id] = { present: true, delegateId: null };
      continue;
    }
    const delegateId = entry.delegate?.id ?? null;
    if (delegateId && voters.has(entry.member.id) && voters.has(delegateId)) {
      form[entry.member.id] = { present: false, delegateId };
    }
  }
  return form;
}

/** What the server receives: members neither present nor delegating are left out. */
export function headcountEntriesOf(form: HeadcountForm): HeadcountEntryInput[] {
  return Object.entries(form).flatMap(
    ([memberId, row]): HeadcountEntryInput[] => {
      if (row.present) return [{ memberId, mark: "present" }];
      if (row.delegateId) {
        return [{ memberId, mark: "delegated", delegateId: row.delegateId }];
      }
      return [];
    },
  );
}

/** Who receives each delegation: receiver id -> delegating member id. */
export function delegationsReceived(form: HeadcountForm): Map<string, string> {
  const received = new Map<string, string>();
  for (const [id, row] of Object.entries(form)) {
    if (!row.present && row.delegateId) received.set(row.delegateId, id);
  }
  return received;
}

/**
 * Members that may receive `memberId`'s delegation: any other member that
 * neither delegates its own vote nor receives another delegation, those in
 * the room first (a delegation to one out of the room does not count yet).
 * `order` holds the members with a vote, in the order of the form.
 */
export function delegateOptions(
  form: HeadcountForm,
  memberId: string,
  order: readonly string[],
): string[] {
  const received = delegationsReceived(form);
  const open = order.filter((id) => {
    if (id === memberId || !form[id]) return false;
    const row = form[id]!;
    if (!row.present && row.delegateId) return false;
    const holder = received.get(id);
    return holder === undefined || holder === memberId;
  });
  return [
    ...open.filter((id) => form[id]!.present),
    ...open.filter((id) => !form[id]!.present),
  ];
}

/** Marks a member in the room or not; one in the room delegates nothing. */
export function setHeadcountPresent(
  form: HeadcountForm,
  memberId: string,
  present: boolean,
): HeadcountForm {
  const row = form[memberId] ?? { present: false, delegateId: null };
  return {
    ...form,
    [memberId]: { present, delegateId: present ? null : row.delegateId },
  };
}

/** Sets or clears who votes for a member that is not in the room. */
export function setHeadcountDelegate(
  form: HeadcountForm,
  memberId: string,
  delegateId: string | null,
): HeadcountForm {
  return { ...form, [memberId]: { present: false, delegateId } };
}

/** Live events that change the headcounts. */
export function isHeadcountEvent(event: {
  type: string;
  entityType: string;
}): boolean {
  return event.type === "poll" || event.entityType === "headcount";
}

/**
 * Whether someone else saved `sent` after this device read it: the list,
 * read again after a 409, holds it with another `updatedAt`. Not so when the
 * 409 had another cause (the session is not open), nor when the count is
 * missing from the list or the list could not be read again.
 */
export function headcountMovedOn(
  list: readonly HeadcountDto[] | undefined,
  sent: Pick<HeadcountDto, "id" | "updatedAt">,
): boolean {
  const fresh = list?.find((count) => count.id === sent.id);
  return Boolean(fresh && fresh.updatedAt !== sent.updatedAt);
}
