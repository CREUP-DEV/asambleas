/**
 * Room for the whole title of nearly every document, so the URL rarely
 * stops mid-phrase ("...-centrado-en-el").
 */
export const SLUG_MAX_LENGTH = 200;

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

/** Words used by the document routes themselves. */
export const RESERVED_DOCUMENT_SLUGS: ReadonlySet<string> = new Set([
  "nuevo",
  "new",
  "documentos",
  "documents",
]);

/**
 * The URL slug of a document titled `title`: slugify(title), or the first of
 * its -2, -3... that is neither taken in the assembly nor reserved.
 */
export function pickDocumentSlug(
  title: string,
  taken: ReadonlySet<string>,
): string {
  const base = slugify(title) || "documento";
  const isFree = (slug: string) =>
    !taken.has(slug) && !RESERVED_DOCUMENT_SLUGS.has(slug);
  if (isFree(base)) return base;
  let suffix = 2;
  while (!isFree(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * The slug each document of an assembly gets from its current title, given
 * in creation order (`drizzle/reslug-documents.ts`): each takes the first
 * free one among those settled before it. Only the ones that change.
 */
export function planDocumentSlugs(
  rows: readonly { id: string; slug: string; title: string }[],
): { id: string; from: string; to: string }[] {
  const taken = new Set<string>();
  const changes: { id: string; from: string; to: string }[] = [];
  for (const row of rows) {
    const to = pickDocumentSlug(row.title, taken);
    taken.add(to);
    if (to !== row.slug) changes.push({ id: row.id, from: row.slug, to });
  }
  return changes;
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

/**
 * The URL slug of every agenda item of an assembly, by id: slugify(title),
 * with -2, -3... where two items share it. Computed from every item with its
 * real title, so everyone gets the same slug for the same item; the earlier
 * created item keeps the plain one, so a new item never moves another's
 * link. Never stored: renaming an item changes its link.
 */
export function agendaItemSlugs(
  rows: readonly { id: string; title: string; createdAt: Date | string }[],
): Map<string, string> {
  const ordered = [...rows].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const taken = new Set<string>();
  const slugs = new Map<string, string>();
  for (const row of ordered) {
    const base = slugify(row.title) || "punto";
    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix += 1) {
      slug = `${base}-${suffix}`;
    }
    taken.add(slug);
    slugs.set(row.id, slug);
  }
  return slugs;
}

export function formatAssemblyLabel(assembly: {
  number: number;
  type: string;
}): string {
  return `${assembly.number}.ª ${assembly.type}`;
}
