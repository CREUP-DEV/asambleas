/**
 * The `?ids=` of GET .../documents/[document]/amendments, which reads some
 * amendments of the list instead of all of it (PartialDocumentAmendmentsDto).
 * Shared so the client never asks for more than the server answers.
 */

/** At most this many ids per request; a reader with more reads the list. */
export const PARTIAL_AMENDMENTS_MAX = 20;

/** An amendment id (cuid) or anything close: no separators, no spaces. */
const AMENDMENT_ID = /^[\w-]{1,64}$/;

/**
 * The ids of `?ids=a,b` (a repeated `ids` counts too), trimmed and without
 * repeats: undefined when the parameter is absent (the whole list), null
 * when it is malformed, empty or names more than PARTIAL_AMENDMENTS_MAX.
 */
export function parseAmendmentIdsQuery(
  value: unknown,
): string[] | null | undefined {
  if (value === undefined) return undefined;
  const parts = Array.isArray(value) ? value : [value];
  if (!parts.every((part) => typeof part === "string")) return null;
  const ids = [
    ...new Set(
      (parts as string[])
        .flatMap((part) => part.split(","))
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (ids.length === 0 || ids.length > PARTIAL_AMENDMENTS_MAX) return null;
  return ids.every((id) => AMENDMENT_ID.test(id)) ? ids : null;
}
