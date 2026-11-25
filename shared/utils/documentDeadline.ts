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
 * When members stop presenting a document of this kind: its own deadline
 * (documentDeadlineKey), or `documents_close` in an assembly without the
 * kind's own milestone (an AGET has no `candidacies_close`, an assembly may
 * have no `reports_close`), as before each kind had its own. Null with
 * neither: it never closes.
 */
export function presentationDeadlineAt(
  kind: DocumentKind,
  milestoneAt: (key: MilestoneKey) => string | Date | null | undefined,
): string | Date | null {
  return (
    milestoneAt(documentDeadlineKey(kind)) ??
    milestoneAt("documents_close") ??
    null
  );
}

/**
 * Whether a member may no longer present a document of this kind: its
 * deadline (presentationDeadlineAt) has passed, the deadline's own minute on
 * time (isPastDeadline). The documents the Secretaría expects are not
 * bound by it (isExpectedDocument on the server): a CEA report still comes
 * in after `reports_close` and reads late (sentAfterDeadline).
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
 * none), `next` the nearest deadline still ahead (what an open window counts
 * down to; null with none ahead) and `last` the latest one (when the whole
 * window closed; null without any).
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
 * Whether a document was sent after its deadline (documentDeadlineKey),
 * the deadline's own minute on time (isPastDeadline).
 */
export function sentAfterDeadline(
  document: { kind: DocumentKind; submittedAt: string | Date | null },
  milestoneAt: (key: MilestoneKey) => string | Date | null | undefined,
): boolean {
  const due = milestoneAt(documentDeadlineKey(document.kind));
  if (!due || document.submittedAt === null) return false;
  return isPastDeadline(due, document.submittedAt);
}
