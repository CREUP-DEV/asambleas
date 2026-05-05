export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
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
