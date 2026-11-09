export const SLUG_MAX_LENGTH = 60;

/**
 * URL slug of a title: lower case ASCII words joined by hyphens, at most
 * SLUG_MAX_LENGTH characters. A long title is cut after its last whole word
 * ("...a-las-lenguas", never "...a-las-lengu"), unless its first word alone
 * is longer than the limit.
 */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length <= SLUG_MAX_LENGTH) return slug;
  const cut = slug.slice(0, SLUG_MAX_LENGTH + 1);
  const lastBreak = cut.lastIndexOf("-");
  return lastBreak > 0
    ? cut.slice(0, lastBreak)
    : slug.slice(0, SLUG_MAX_LENGTH);
}

export function buildAssemblySlug(assembly: {
  number: number;
  type: string;
}): string {
  return `${assembly.number}-${assembly.type.toLowerCase()}`;
}

export function parseAssemblySlug(
  value: string | undefined,
): { number: number; type: "AGO" | "AGE" | "AGET" } | null {
  const match = value?.match(/^(\d+)-(ago|age|aget)$/i);
  if (!match) return null;

  return {
    number: Number(match[1]),
    type: match[2]!.toUpperCase() as "AGO" | "AGE" | "AGET",
  };
}

export function buildAgendaItemSlug(item: {
  title: string;
  id: string;
}): string {
  return slugify(item.title) || item.id;
}

export function formatAssemblyLabel(assembly: {
  number: number;
  type: string;
}): string {
  return `${assembly.number}.ª ${assembly.type}`;
}
