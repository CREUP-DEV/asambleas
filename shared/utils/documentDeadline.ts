import {
  DOCUMENT_KINDS,
  type DocumentKind,
  type MilestoneKey,
} from "../constants/domain";
import { isPastDeadline } from "./calendar";

/**
 * The calendar milestone after which a presented document reads as late
 * (the «Fuera de plazo» of the validation page): `candidacies_close` for
 * candidacies and venues, `reports_close` for reports, `documents_close`
 * for everything else. Reports have a deadline of their own, set per
 * assembly type (/admin/calendario) and per assembly; an assembly without
 * it never reads a report late, whatever `documents_close` says.
 */
export function documentDeadlineKey(kind: DocumentKind): MilestoneKey {
  if (kind === "candidacy" || kind === "venue") return "candidacies_close";
  if (kind === "report") return "reports_close";
  return "documents_close";
}

/**
 * Whether a late document of this kind needs the assembly to agree to
 * treat it. A report never does: it is treated however late it comes.
 */
export function lateNeedsAssembly(kind: DocumentKind): boolean {
  return kind !== "report";
}

/**
 * Whether members ever stop presenting a document of this kind. A report
 * never closes for them: it is created, sent and presented at any time, and
 * after `reports_close` it only reads late (sentAfterDeadline), treated all
 * the same (lateNeedsAssembly).
 */
export function closesForMembers(kind: DocumentKind): boolean {
  return kind !== "report";
}

/**
 * The deadline after which a document of this kind reads late
 * (documentDeadlineKey, the date sentAfterDeadline compares with), without
 * any fallback: an assembly without the kind's own milestone never reads
 * it late. Null then.
 */
export function lateAfterAt(
  kind: DocumentKind,
  milestoneAt: (key: MilestoneKey) => string | Date | null | undefined,
): string | Date | null {
  return milestoneAt(documentDeadlineKey(kind)) ?? null;
}

/**
 * When members stop presenting a document of this kind: its own deadline
 * (documentDeadlineKey), or `documents_close` in an assembly without the
 * kind's own milestone (an AGET has no `candidacies_close`), as before each
 * kind had its own. Null with neither, and always for a report
 * (closesForMembers): it never closes.
 */
export function presentationDeadlineAt(
  kind: DocumentKind,
  milestoneAt: (key: MilestoneKey) => string | Date | null | undefined,
): string | Date | null {
  if (!closesForMembers(kind)) return null;
  return (
    milestoneAt(documentDeadlineKey(kind)) ??
    milestoneAt("documents_close") ??
    null
  );
}

/**
 * Whether a member may no longer present a document of this kind: its
 * deadline (presentationDeadlineAt) has passed, the deadline's own minute on
 * time (isPastDeadline). Never for a report (closesForMembers). The
 * documents the Secretaría expects are not bound by it (isExpectedDocument
 * on the server): an expected resolution still comes in after
 * `documents_close` and reads late (sentAfterDeadline).
 */
export function presentationDeadlinePassed(
  kind: DocumentKind,
  milestoneAt: (key: MilestoneKey) => string | Date | null | undefined,
  now: string | Date = new Date(),
): boolean {
  const due = presentationDeadlineAt(kind, milestoneAt);
  return Boolean(due && isPastDeadline(due, now));
}

/**
 * Presentation across `kinds` (every kind unless given: a member passes the
 * ones it may present), by presentationDeadlineAt, for a notice that speaks
 * of it as a whole: `open` while some kind is still in its deadline (or has
 * none: with reports among `kinds` it never closes), `next` the nearest
 * deadline still ahead (what an open window counts down to; null with none
 * ahead) and `last` the latest one (when the whole window closed; null
 * without any). `reports_close` is never among them: it closes nothing.
 */
export function presentationSchedule(
  milestoneAt: (key: MilestoneKey) => string | Date | null | undefined,
  now: string | Date = new Date(),
  kinds: readonly DocumentKind[] = DOCUMENT_KINDS,
): { open: boolean; next: string | Date | null; last: string | Date | null } {
  const time = (value: string | Date) => new Date(value).getTime();
  let open = false;
  let next: string | Date | null = null;
  let last: string | Date | null = null;
  for (const kind of kinds) {
    const due = presentationDeadlineAt(kind, milestoneAt);
    if (!due) {
      open = true;
      continue;
    }
    if (!last || time(due) > time(last)) last = due;
    if (isPastDeadline(due, now)) continue;
    open = true;
    if (!next || time(due) < time(next)) next = due;
  }
  return { open, next, last };
}

/**
 * presentationSchedule over only the kinds among `kinds` (every kind unless
 * given) that close for members (closesForMembers), for a notice that says
 * whether presentation as a whole is over: past `documents_close` and
 * `candidacies_close` it reads closed, with `last` the latest of them, even
 * though reports still go in. With no such kind (a member who may present
 * only reports) there is no deadline to state: open, with neither date.
 */
export function closingPresentationSchedule(
  milestoneAt: (key: MilestoneKey) => string | Date | null | undefined,
  now: string | Date = new Date(),
  kinds: readonly DocumentKind[] = DOCUMENT_KINDS,
): { open: boolean; next: string | Date | null; last: string | Date | null } {
  const closing = kinds.filter(closesForMembers);
  if (closing.length === 0) return { open: true, next: null, last: null };
  return presentationSchedule(milestoneAt, now, closing);
}

/**
 * Whether a document was sent after its deadline (lateAfterAt), the
 * deadline's own minute on time (isPastDeadline).
 */
export function sentAfterDeadline(
  document: { kind: DocumentKind; submittedAt: string | Date | null },
  milestoneAt: (key: MilestoneKey) => string | Date | null | undefined,
): boolean {
  const due = lateAfterAt(document.kind, milestoneAt);
  if (!due || document.submittedAt === null) return false;
  return isPastDeadline(due, document.submittedAt);
}
