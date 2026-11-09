import {
  DOCUMENT_KIND_DEFAULTS,
  DOCUMENT_KINDS,
  type DocumentFormat,
  type DocumentKind,
  type MemberKind,
} from "~~/shared/constants/domain";
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

/** The types a PDF can take: those that take no amendments. */
export function kindAcceptsFile(kind: DocumentKind): boolean {
  return DOCUMENT_KIND_DEFAULTS[kind].amendable === false;
}

export function presenterKindGroups(options: {
  memberKind?: MemberKind | null;
  format?: DocumentFormat;
  /** The document's kind today, always offered. */
  current?: DocumentKind | null;
}): DocumentKindGroups {
  const { memberKind = null, format = "structured", current = null } = options;
  const allowed = DOCUMENT_KINDS.filter(
    (kind) =>
      kind === current ||
      ((format !== "file" || kindAcceptsFile(kind)) &&
        (!memberKind || memberMayPresent(kind, memberKind))),
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
 * A heading carries `value?: undefined` only so that every item has the key
 * USelectMenu's `value-key="value"` names (its type takes the keys all items
 * share).
 */
export type KindSelectItem =
  | { type: "label"; label: string; value?: undefined }
  | { label: string; value: DocumentKind };

/**
 * The groups as USelect items: one group per list, each under its heading
 * (a group with no kinds is left out; a single group needs no heading).
 */
export function kindSelectItems(
  groups: DocumentKindGroups,
  label: (kind: DocumentKind) => string,
  headings: { common: string; others: string },
): KindSelectItem[][] {
  const lists = [
    { heading: headings.common, kinds: groups.common },
    { heading: headings.others, kinds: groups.others },
  ].filter((list) => list.kinds.length > 0);
  return lists.map((list) => [
    ...(lists.length > 1
      ? [{ type: "label" as const, label: list.heading }]
      : []),
    ...list.kinds.map((kind) => ({ label: label(kind), value: kind })),
  ]);
}
