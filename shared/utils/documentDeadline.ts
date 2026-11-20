import type { DocumentKind, MilestoneKey } from "../constants/domain";
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
