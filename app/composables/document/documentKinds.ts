import {
  DOCUMENT_KINDS,
  type DocumentFormat,
  type DocumentKind,
  type MemberKind,
} from "~~/shared/constants/domain";
import {
  itemAcceptsKind,
  type SubmissionRules,
} from "~~/shared/utils/agendaSubmissions";
import { kindAcceptsFile } from "~~/shared/utils/documentFormat";
import { memberMayPresent } from "~~/shared/utils/presenterKinds";

/**
 * The document types a presenter is offered, split into the ones their
 * member usually presents and the rest, so the first choice of the form is
 * a short list instead of fifteen options. Pure: components turn the kinds
 * into labels.
 *
 * - CEA areas (`executive` members) present their reports, work plans,
 *   budgets and accounts;
 * - councils and sectorials present positionings, resolutions and motions,
 *   but a sectorial never an internal motion (memberMayPresent), so it is
 *   not offered at all.
 *
 * A PDF (`format: "file"`) is never amendable, so it only takes the types
 * that take no amendments; the current kind always stays, so an existing
 * document never shows an empty select.
 *
 * An agenda item where members present documents may name the kinds it
 * takes (`accepted`); the presenter is then offered only those.
 */
export interface DocumentKindGroups {
  common: DocumentKind[];
  others: DocumentKind[];
}

const COMMON_KINDS: Record<"executive" | "member", readonly DocumentKind[]> = {
  executive: [
    "executive_report",
    "work_plan",
    "budget",
    "accounts",
    "report",
    "other",
  ],
  member: ["positioning", "resolution", "internal_motion", "report", "other"],
};

export { kindAcceptsFile };

/** A member's choice of type: one of the usual ones, or "Otro tipo". */
export const OTHER_KIND_CHOICE = "__other__";
export type KindCardValue = DocumentKind | typeof OTHER_KIND_CHOICE;

/**
 * The groups for the type picker as cards. The catch-all type ("Otro")
 * moves to the end of the rest, so it never sits as a card beside the
 * "Otro tipo" card that opens that list.
 */
export function cardKindGroups(groups: DocumentKindGroups): DocumentKindGroups {
  if (!groups.common.includes("other")) return groups;
  return {
    common: groups.common.filter((kind) => kind !== "other"),
    others: [...groups.others.filter((kind) => kind !== "other"), "other"],
  };
}

/**
 * The cards: the usual types one card each and, when there are more, a last
 * card "Otro tipo" that opens the list of the rest.
 */
export function kindCardValues(groups: DocumentKindGroups): KindCardValue[] {
  return groups.others.length > 0
    ? [...groups.common, OTHER_KIND_CHOICE]
    : [...groups.common];
}

/**
 * The card that shows as chosen: "Otro tipo" once the user opened it (the
 * kind itself changes only when they choose one from its list) or for a
 * kind of the rest, the kind's own card otherwise, none before any choice.
 */
export function kindCardChoice(
  groups: DocumentKindGroups,
  kind: DocumentKind | null | undefined,
  otherOpen: boolean,
): KindCardValue | undefined {
  const hasOthers = groups.others.length > 0;
  if (otherOpen && hasOthers) return OTHER_KIND_CHOICE;
  if (!kind) return undefined;
  if (groups.common.includes(kind)) return kind;
  return hasOthers ? OTHER_KIND_CHOICE : undefined;
}

export function presenterKindGroups(options: {
  memberKind?: MemberKind | null;
  format?: DocumentFormat;
  /** The document's kind today, always offered. */
  current?: DocumentKind | null;
  /**
   * The kinds the agenda item takes from members (its `submissionKinds`).
   * Empty or left out: every kind.
   */
  accepted?: readonly DocumentKind[] | null;
}): DocumentKindGroups {
  const { memberKind = null, format = "structured", current = null } = options;
  const accepted = options.accepted ?? [];
  const allowed = DOCUMENT_KINDS.filter(
    (kind) =>
      kind === current ||
      ((format !== "file" || kindAcceptsFile(kind)) &&
        (!memberKind || memberMayPresent(kind, memberKind)) &&
        (accepted.length === 0 || accepted.includes(kind))),
  );
  const preferred = COMMON_KINDS[
    memberKind === "executive" ? "executive" : "member"
  ].filter((kind) => allowed.includes(kind));
  return {
    common: preferred,
    others: allowed.filter((kind) => !preferred.includes(kind)),
  };
}

/**
 * The kinds a member of `memberKind` may present under an agenda item: the
 * ones the item takes that the member may present at all (a sectorial never
 * an internal motion). Empty when the item takes no documents from it.
 */
export function memberSubmissionKinds(
  item: SubmissionRules,
  memberKind: MemberKind | null | undefined,
): DocumentKind[] {
  return DOCUMENT_KINDS.filter(
    (kind) =>
      itemAcceptsKind(item, kind) &&
      (!memberKind || memberMayPresent(kind, memberKind)),
  );
}

/**
 * The kinds the Secretaría is offered first when it says what members
 * present under an agenda item: what they present in series.
 */
const CONTAINER_COMMON_KINDS: readonly DocumentKind[] = [
  "resolution",
  "internal_motion",
  "positioning",
];

/**
 * Every kind for the choice of what an agenda item takes: the usual ones
 * first, then the rest. `chosen` kinds of the rest count as usual, so a
 * stored choice always shows without unfolding anything.
 */
export function containerKindGroups(
  chosen: readonly DocumentKind[] = [],
): DocumentKindGroups {
  const common = DOCUMENT_KINDS.filter(
    (kind) => CONTAINER_COMMON_KINDS.includes(kind) || chosen.includes(kind),
  ).sort(
    (a, b) =>
      Number(!CONTAINER_COMMON_KINDS.includes(a)) -
        Number(!CONTAINER_COMMON_KINDS.includes(b)) ||
      CONTAINER_COMMON_KINDS.indexOf(a) - CONTAINER_COMMON_KINDS.indexOf(b),
  );
  return {
    common,
    others: DOCUMENT_KINDS.filter((kind) => !common.includes(kind)),
  };
}
