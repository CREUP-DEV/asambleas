import { createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agendaItems, assemblies } from "../db/schema";
import { isDefaultCuid } from "./validation";
import { parseAssemblySlug, slugify } from "~~/shared/utils/slug";

export async function resolveAssemblyFromParam(param: string | undefined) {
  if (!param) {
    throw createError({ statusCode: 400, message: "Assembly ID inválido" });
  }

  if (isDefaultCuid(param)) {
    const assembly = await db.query.assemblies.findFirst({
      where: eq(assemblies.id, param),
    });
    if (assembly) return assembly;
  }

  const parsedSlug = parseAssemblySlug(param);
  if (parsedSlug) {
    const assembly = await db.query.assemblies.findFirst({
      where: and(
        eq(assemblies.number, parsedSlug.number),
        eq(assemblies.type, parsedSlug.type),
      ),
    });
    if (assembly) return assembly;
  }

  throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
}

export async function resolveAgendaItemFromParam(
  assemblyId: string,
  param: string | undefined,
) {
  if (!param) {
    throw createError({ statusCode: 400, message: "Item ID inválido" });
  }

  if (isDefaultCuid(param)) {
    const item = await db.query.agendaItems.findFirst({
      where: and(
        eq(agendaItems.id, param),
        eq(agendaItems.assemblyId, assemblyId),
      ),
    });
    if (item) return item;
  }

  const items = await db.query.agendaItems.findMany({
    where: eq(agendaItems.assemblyId, assemblyId),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
  const item = items.find((candidate) => slugify(candidate.title) === param);

  if (!item) {
    throw createError({ statusCode: 404, message: "Punto no encontrado" });
  }

  return item;
}
