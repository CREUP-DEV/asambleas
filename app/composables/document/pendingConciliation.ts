import type {
  AmendmentDto,
  PendingPassageDto,
  VersionDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";

/**
 * Passages approved pending conciliation (user's decisions of 2026-11-21;
 * shared/utils/content/pendingPassages.ts), as every reader of the approved
 * text shows them: the version reads «Aprobado · pendiente de conciliar»
 * and each passage is marked in the text, opening with «Pendiente de
 * conciliar E3 y E5» (codes as the reader reads them).
 */

/** What ContentView marks for one passage. */
export interface PendingPassageMark {
  key: string;
  blockIds: string[];
  label: string;
}

/** «E3 y E5», as the locale joins a list (", " without Intl.ListFormat). */
export function joinCodes(codes: readonly string[], locale: string): string {
  if (typeof Intl === "undefined" || !("ListFormat" in Intl)) {
    return codes.join(", ");
  }
  try {
    return new Intl.ListFormat(locale, {
      type: "conjunction",
      style: "long",
    }).format(codes);
  } catch {
    return codes.join(", ");
  }
}

/**
 * An amendment's code from a list the view already holds (the projection,
 * the live view): its code, "#n" before it has one, "?" when not there.
 */
export function amendmentCodeIn(
  amendments: readonly Pick<AmendmentDto, "id" | "code" | "number">[],
): (amendmentId: string) => string {
  const byId = new Map(
    amendments.map((amendment) => [amendment.id, amendment]),
  );
  return (amendmentId) => {
    const amendment = byId.get(amendmentId);
    if (!amendment) return "?";
    return amendment.code ?? (amendment.number ? `#${amendment.number}` : "?");
  };
}

/** The passages a version leaves pending: none for a final text. */
export function pendingPassagesOfVersion(
  version: Pick<VersionDto, "pendingPassages"> | null | undefined,
): PendingPassageDto[] {
  return version?.pendingPassages ?? [];
}

/**
 * The marks of the pending passages of a version: `text` words the label
 * from the joined codes of each.
 */
export function pendingPassageMarks(
  version: Pick<VersionDto, "pendingPassages"> | null | undefined,
  input: {
    label: (amendmentId: string) => string;
    locale: string;
    text: (codes: string) => string;
  },
): PendingPassageMark[] {
  return pendingPassagesOfVersion(version).map((passage) => ({
    key: passage.key,
    blockIds: passage.textBlockIds,
    label: input.text(
      joinCodes(passage.amendmentIds.map(input.label), input.locale),
    ),
  }));
}

/** A block as compared: what it reads and how, in a fixed key order. */
function blockShape(block: Block): string {
  return JSON.stringify(
    sortedKeys([
      block.id,
      block.type,
      block.text,
      block.level ?? null,
      block.list ?? null,
      block.marker ?? null,
      block.start ?? null,
      block.align ?? null,
      block.cell ?? null,
      block.image ?? null,
      block.marks.map((mark) => [
        mark.type,
        mark.from,
        mark.to,
        mark.href ?? null,
      ]),
    ]),
  );
}

/**
 * A value with every object's keys sorted, nested ones too (JSONB stores
 * them in its own order), and undefined ones left out.
 */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortedKeys(item)]),
    );
  }
  return value;
}

/**
 * Whether two texts read the same, block by block (ids, text, marks and
 * format), whatever order their keys were stored in. The consolidated page
 * shows a text conciliated after the vote with the amendments' marks while
 * it is the one the approved amendments and wordings give; a correction of
 * form makes it differ.
 */
export function sameBlocks(
  a: readonly Block[] | null | undefined,
  b: readonly Block[] | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((block, index) => blockShape(block) === blockShape(b[index]!));
}

/** The pending passages of a version, worded for the reader. */
export function usePendingConciliation() {
  const { t, locale } = useI18n();
  function codes(
    amendmentIds: readonly string[],
    label: (amendmentId: string) => string,
  ): string {
    return joinCodes(amendmentIds.map(label), locale.value);
  }
  /** Without `label` (no amendments at hand) the codes are left out. */
  function marks(
    version: Pick<VersionDto, "pendingPassages"> | null | undefined,
    label?: (amendmentId: string) => string,
  ): PendingPassageMark[] {
    return pendingPassageMarks(version, {
      label: label ?? (() => ""),
      locale: locale.value,
      text: (joined) =>
        label
          ? t("document.pendingConciliation.passage", { codes: joined })
          : t("document.pendingConciliation.status"),
    });
  }
  return { codes, marks };
}
