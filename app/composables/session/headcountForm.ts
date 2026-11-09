import type {
  HeadcountDto,
  HeadcountEntryInput,
  MemberRef,
} from "~~/shared/types/api";
import type { QuorumCall } from "~~/shared/utils/headcount";

/**
 * The Mesa's headcount form, as pure functions: one checkbox per asociado
 * with a vote (in the room or not) and, for one that is not, the member it
 * delegates its vote to. A delegation counts only while its receiver is in
 * the room; the server counts and checks it again (tallyHeadcount).
 */

export interface FormRow {
  present: boolean;
  /** Who votes for this member when it is not in the room. */
  delegateId: string | null;
}

export type HeadcountForm = Record<string, FormRow>;

/** What survives an accidental close of the form (this device only). */
export interface HeadcountDraft {
  /** The count being corrected, or null for a new one. */
  targetId: string | null;
  form: HeadcountForm;
  call: QuorumCall;
  note: string;
  savedAt: string;
}

/**
 * A form for `members`, filled from `from` (the count being corrected, or
 * the latest one, since few people move between counts). Members `from`
 * does not list start out of the room; delegations to members no longer
 * listed are dropped.
 */
export function headcountFormFrom(
  members: readonly MemberRef[],
  from: HeadcountDto | null,
): HeadcountForm {
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
    if (delegateId && ids.has(delegateId)) {
      form[entry.member.id] = { present: false, delegateId };
    }
  }
  return form;
}

/**
 * Members of a corrected count that are no longer active asociados: they
 * stay on its form, since the count is a snapshot of its own moment.
 */
export function headcountFormMembers(
  members: readonly MemberRef[],
  from: HeadcountDto | null,
): MemberRef[] {
  const known = new Set(members.map((member) => member.id));
  const extra = (from?.entries ?? [])
    .map((entry) => entry.member)
    .filter((member) => !known.has(member.id));
  return [...members, ...extra].sort((a, b) =>
    a.acronym.localeCompare(b.acronym),
  );
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
 * `order` is the listing order of the form.
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
