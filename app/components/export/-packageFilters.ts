/**
 * The documentation package's filters ("Descargar documentación"): which
 * documents, whether their texts go and which amendments, over what the
 * server offers (PackageOptionsDto, as the public reads it). Pure, so it is
 * unit-tested on its own (-packageFilters.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */

import type { PackageOptionsDto } from "~~/shared/types/api";
import { MEMBER_KIND_ORDER } from "~~/shared/utils/memberOrder";
import type { PackageSelection } from "~~/shared/utils/schemas/export";

export type AmendmentMode = "all" | "none" | "authors" | "selected";

export interface PackageFilterState {
  /** None chosen reads as every document. */
  documentIds: string[];
  texts: boolean;
  amendments: AmendmentMode;
  memberIds: string[];
  /** The control sheet's amendments (`selected`). */
  amendmentIds: string[];
}

/** What a page opens the dialog with. */
export interface PackagePreset {
  documentIds?: string[];
  texts?: boolean;
  /** The amendments a list shows (the control sheet's «Enmiendas»). */
  amendmentIds?: string[];
}

export function presetState(preset: PackagePreset | null): PackageFilterState {
  return {
    documentIds: preset?.documentIds ?? [],
    texts: preset?.texts ?? true,
    amendments: preset?.amendmentIds ? "selected" : "all",
    memberIds: [],
    amendmentIds: preset?.amendmentIds ?? [],
  };
}

/** The selection to ask the server for; null for the whole package. */
export function packageSelectionOf(
  state: PackageFilterState,
  /** Every document the package holds: choosing them all is choosing none. */
  allDocumentIds: readonly string[] = [],
): PackageSelection | null {
  const chosen = new Set(state.documentIds);
  const everyDocument =
    chosen.size === 0 ||
    (allDocumentIds.length > 0 && allDocumentIds.every((id) => chosen.has(id)));
  const whole = everyDocument && state.texts && state.amendments === "all";
  if (whole) return null;
  return {
    documentIds: everyDocument ? null : state.documentIds,
    texts: state.texts,
    amendments: state.amendments,
    memberIds: state.amendments === "authors" ? state.memberIds : [],
    amendmentIds: state.amendments === "selected" ? state.amendmentIds : [],
  };
}

// The documents' menu -----------------------------------------------------------

/** Menu values that stand for a whole agenda item, not one document. */
export const GROUP_VALUE_PREFIX = "item:";

export function groupValue(id: string): string {
  return `${GROUP_VALUE_PREFIX}${id}`;
}

/**
 * What the documents' menu shows chosen: the documents, and each item all
 * of whose documents are chosen.
 */
export function documentMenuValues(
  documentIds: readonly string[],
  groups: PackageOptionsDto["groups"],
): string[] {
  const chosen = new Set(documentIds);
  return [
    ...groups
      .filter(
        (group) =>
          group.documentIds.length > 0 &&
          group.documentIds.every((id) => chosen.has(id)),
      )
      .map((group) => groupValue(group.id)),
    ...documentIds,
  ];
}

/**
 * The documents chosen after the menu changed from `before` to `after`: an
 * item ticked takes all its documents, an item unticked lets them all go,
 * and a document unticked in a full item leaves the others.
 */
export function documentsAfterMenu(
  before: readonly string[],
  after: readonly string[],
  groups: PackageOptionsDto["groups"],
): string[] {
  const had = new Set(before);
  const has = new Set(after);
  const documents = new Set(
    after.filter((value) => !value.startsWith(GROUP_VALUE_PREFIX)),
  );
  for (const group of groups) {
    const value = groupValue(group.id);
    if (has.has(value) && !had.has(value)) {
      group.documentIds.forEach((id) => documents.add(id));
    } else if (!has.has(value) && had.has(value)) {
      group.documentIds.forEach((id) => documents.delete(id));
    }
  }
  // In agenda order.
  return groups.flatMap((group) =>
    group.documentIds.filter((id) => documents.has(id)),
  );
}

// Amendments ----------------------------------------------------------------------

function documentsIn(
  options: PackageOptionsDto,
  documentIds: readonly string[],
): PackageOptionsDto["documents"] {
  if (documentIds.length === 0) return options.documents;
  const chosen = new Set(documentIds);
  return options.documents.filter((document) => chosen.has(document.id));
}

/** How many amendments each member signs in the documents chosen. */
export function authorCounts(
  options: PackageOptionsDto,
  documentIds: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const document of documentsIn(options, documentIds)) {
    for (const amendment of document.amendments) {
      for (const id of amendment.authorIds) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * The members to choose from, those who sign amendments in the documents
 * chosen: by kind as everywhere (asociados first), and each kind by what
 * the menu shows first, a council's university.
 */
export function authorChoices(
  options: PackageOptionsDto,
  documentIds: readonly string[],
): (PackageOptionsDto["authors"][number] & { count: number })[] {
  const counts = authorCounts(options, documentIds);
  return options.authors
    .filter((author) => counts.has(author.id))
    .map((author) => ({ ...author, count: counts.get(author.id) ?? 0 }))
    .sort(
      (a, b) =>
        MEMBER_KIND_ORDER.indexOf(a.kind) - MEMBER_KIND_ORDER.indexOf(b.kind) ||
        (a.university ?? a.name).localeCompare(b.university ?? b.name, "es", {
          sensitivity: "base",
        }) ||
        a.acronym.localeCompare(b.acronym, "es"),
    );
}

export interface PackageSummary {
  documents: number;
  amendments: number;
  /** Amendments chosen by id that the package does not hold (not public). */
  dropped: number;
}

/** What a download with these filters holds, as the server will zip it. */
export function packageSummary(
  options: PackageOptionsDto,
  state: PackageFilterState,
): PackageSummary {
  const members = new Set(state.memberIds);
  const chosen = new Set(state.amendmentIds);
  let documents = 0;
  let amendments = 0;
  for (const document of documentsIn(options, state.documentIds)) {
    const taken = document.amendments.filter((amendment) => {
      switch (state.amendments) {
        case "all":
          return true;
        case "none":
          return false;
        case "authors":
          return amendment.authorIds.some((id) => members.has(id));
        case "selected":
          return chosen.has(amendment.id);
      }
    }).length;
    amendments += taken;
    if (taken > 0 || (state.texts && document.hasText)) documents += 1;
  }
  const known = new Set(
    options.documents.flatMap((document) =>
      document.amendments.map((amendment) => amendment.id),
    ),
  );
  const dropped =
    state.amendments === "selected"
      ? [...chosen].filter((id) => !known.has(id)).length
      : 0;
  return { documents, amendments, dropped };
}
