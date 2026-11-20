import { createHash } from "node:crypto";
import type { Translate } from "../labels";
import { safeName } from "./names";
import type {
  PackageIncludes,
  PackageItem,
  PackagePlan,
  PackageSource,
} from "./plan";

/**
 * A part of the documentation package ("Descargar documentación" with
 * filters): some documents, with or without their texts, and some of their
 * amendments (all, none, those some members sign, or the ones the control
 * sheet showed). A part is never planned on its own: it is the whole
 * package's plan with fewer entries (filterPackagePlan), so it renders no
 * piece of its own and its files land where the whole package puts them.
 */

export interface PackageFilter {
  /** All of them when null. */
  documentIds: string[] | null;
  texts: boolean;
  amendments:
    | { mode: "all" }
    | { mode: "none" }
    /** Those any of these members signs, by the id the public reads. */
    | { mode: "authors"; memberIds: string[] }
    /** These amendments, as the control sheet showed them. */
    | { mode: "selected"; amendmentIds: string[] };
}

export const FULL_PACKAGE_FILTER: PackageFilter = {
  documentIds: null,
  texts: true,
  amendments: { mode: "all" },
};

function sortedOnce(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The same choice always reads the same: ids sorted and once, and a list of
 * members or amendments left empty taking none.
 */
export function normalizePackageFilter(filter: PackageFilter): PackageFilter {
  const { amendments } = filter;
  let normalized: PackageFilter["amendments"];
  if (amendments.mode === "authors") {
    normalized =
      amendments.memberIds.length > 0
        ? { mode: "authors", memberIds: sortedOnce(amendments.memberIds) }
        : { mode: "none" };
  } else if (amendments.mode === "selected") {
    normalized =
      amendments.amendmentIds.length > 0
        ? {
            mode: "selected",
            amendmentIds: sortedOnce(amendments.amendmentIds),
          }
        : { mode: "none" };
  } else {
    normalized = { mode: amendments.mode };
  }
  return {
    documentIds:
      filter.documentIds === null ? null : sortedOnce(filter.documentIds),
    texts: filter.texts,
    amendments: normalized,
  };
}

/** The whole package: the convocatoria and the agenda go only with it. */
export function isFullPackageFilter(filter: PackageFilter): boolean {
  return (
    filter.documentIds === null &&
    filter.texts &&
    filter.amendments.mode === "all"
  );
}

/** A short key naming a normalised filter (16 hex characters). */
export function packageFilterKey(filter: PackageFilter): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizePackageFilter(filter)))
    .digest("hex")
    .slice(0, 16);
}

export interface FilteredPackagePlan {
  plan: PackagePlan;
  /** Amendments chosen by id that are not in the package (not public). */
  dropped: number;
  /** Documents and amendments it holds. */
  documentCount: number;
  amendmentCount: number;
}

/**
 * The part of a planned package a filter takes: the same entries, paths and
 * keys, fewer of them. Its fingerprint follows the whole package's and its
 * own entries.
 */
export function filterPackagePlan(
  plan: PackagePlan,
  source: PackageSource,
  rawFilter: PackageFilter,
): FilteredPackagePlan {
  const filter = normalizePackageFilter(rawFilter);
  const documentIds = filter.documentIds ? new Set(filter.documentIds) : null;
  const authorsById = new Map(
    source.documents.flatMap((document) =>
      document.amendments.map(
        (amendment) => [amendment.id, amendment.authorIds] as const,
      ),
    ),
  );
  const { amendments } = filter;
  const members = new Set(
    amendments.mode === "authors" ? amendments.memberIds : [],
  );
  const chosen = new Set(
    amendments.mode === "selected" ? amendments.amendmentIds : [],
  );
  const takesAmendment = (id: string): boolean => {
    switch (amendments.mode) {
      case "all":
        return true;
      case "none":
        return false;
      case "authors":
        return (authorsById.get(id) ?? []).some((member) =>
          members.has(member),
        );
      case "selected":
        return chosen.has(id);
    }
  };
  const full = isFullPackageFilter(filter);
  const entries = plan.entries.filter((entry) => {
    if (!entry.documentId) return full;
    if (documentIds && !documentIds.has(entry.documentId)) return false;
    return entry.amendmentId ? takesAmendment(entry.amendmentId) : filter.texts;
  });

  const shownDocuments = new Set(
    entries.flatMap((entry) => (entry.documentId ? [entry.documentId] : [])),
  );
  const shownAmendments = new Set(
    entries.flatMap((entry) => (entry.amendmentId ? [entry.amendmentId] : [])),
  );
  const includes: PackageIncludes = {
    documents: plan.includes.documents.filter((document) =>
      shownDocuments.has(document.id),
    ),
    amendmentIds: plan.includes.amendmentIds.filter((id) =>
      shownAmendments.has(id),
    ),
    convocationFileUrl: full ? plan.includes.convocationFileUrl : null,
  };
  return {
    plan: {
      root: plan.root,
      entries,
      includes,
      fingerprint: full
        ? plan.fingerprint
        : createHash("sha256")
            .update(
              JSON.stringify([
                plan.fingerprint,
                entries.map((entry) => [entry.path, entry.key]),
              ]),
            )
            .digest("hex")
            .slice(0, 32),
    },
    dropped: [...chosen].filter((id) => !authorsById.has(id)).length,
    documentCount: shownDocuments.size,
    amendmentCount: shownAmendments.size,
  };
}

/**
 * The agenda item a download lists each document under: the item it hangs
 * from, or the parent of its automatic sub-item (the document's own place),
 * so "3. Resoluciones" gathers every resolution. In agenda order.
 */
export function packageDocumentGroups(
  source: PackageSource,
): { item: PackageItem; documentIds: string[] }[] {
  const itemById = new Map(source.items.map((item) => [item.id, item]));
  const groups = new Map<string, string[]>();
  for (const document of source.documents) {
    let item = itemById.get(document.agendaItemId);
    if (!item) continue;
    const parent = item.parentId ? itemById.get(item.parentId) : undefined;
    if (item.automaticFor === document.id && parent) item = parent;
    const list = groups.get(item.id) ?? [];
    list.push(document.id);
    groups.set(item.id, list);
  }
  return source.items.flatMap((item) => {
    const documentIds = groups.get(item.id);
    return documentIds ? [{ item, documentIds }] : [];
  });
}

/** The members who sign the package's amendments, by public id. */
export function packageAuthors(
  source: PackageSource,
): Map<string, { acronym: string }> {
  const authors = new Map<string, { acronym: string }>();
  for (const document of source.documents) {
    for (const amendment of document.amendments) {
      amendment.authorIds.forEach((id, index) => {
        const acronym = amendment.authors[index];
        if (acronym && !authors.has(id)) authors.set(id, { acronym });
      });
    }
  }
  return authors;
}

/** Longest list of acronyms a download's name spells out. */
const NAMED_AUTHORS_MAX = 3;

/**
 * The name of a download (without ".zip"): the package's, then what the
 * part takes ("Punto 4", "Enmiendas de UGR, UCO"), joined by plain hyphens.
 */
export function packageDownloadName(
  root: string,
  source: PackageSource,
  rawFilter: PackageFilter,
  t: Translate,
): string {
  const filter = normalizePackageFilter(rawFilter);
  if (isFullPackageFilter(filter)) return root;
  const parts: string[] = [];
  if (filter.documentIds) {
    const chosen = new Set(filter.documentIds);
    const documents = source.documents.filter((document) =>
      chosen.has(document.id),
    );
    const group = packageDocumentGroups(source).find(
      (candidate) =>
        candidate.documentIds.length === documents.length &&
        candidate.documentIds.every((id) => chosen.has(id)),
    );
    const [only] = documents;
    if (documents.length === 1 && only) {
      parts.push(only.title);
    } else if (group) {
      parts.push(t("package.item", { number: group.item.numbering }));
    } else {
      parts.push(t("package.documentCount", { count: documents.length }));
    }
  }
  const { amendments } = filter;
  if (amendments.mode === "authors") {
    const authors = packageAuthors(source);
    const named = amendments.memberIds.flatMap((id) => {
      const acronym = authors.get(id)?.acronym;
      return acronym ? [acronym] : [];
    });
    parts.push(
      named.length > 0 && named.length <= NAMED_AUTHORS_MAX
        ? t("package.amendmentsBy", { authors: named.join(", ") })
        : t("package.amendmentsByCount", {
            count: amendments.memberIds.length,
          }),
    );
  } else if (amendments.mode === "selected") {
    parts.push(t("package.selection"));
  } else if (amendments.mode === "none") {
    parts.push(t("package.withoutAmendments"));
  } else if (!filter.texts) {
    parts.push(t("package.amendments"));
  }
  return safeName(`${root} - ${parts.join(" - ")}`, 160);
}
