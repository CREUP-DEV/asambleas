import { createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  agendaItems,
  amendments,
  assemblies,
  documents,
} from "../../db/schema";
import { parseAssemblySlug } from "~~/shared/utils/slug";
import type { Actor } from "./actor";
import { canSeeAssembly, canSeeDocument } from "./visibility";

const CUID_PATTERN = /^[a-z0-9]{20,32}$/;

function notFound(message: string): never {
  throw createError({ statusCode: 404, message });
}

/** Resolves `80-ago` or an id. Hidden assemblies answer 404, not 403. */
export async function resolveAssembly(actor: Actor, param: string | undefined) {
  if (!param) notFound("Asamblea no encontrada");
  const parsed = parseAssemblySlug(param);
  const assembly = parsed
    ? await db.query.assemblies.findFirst({
        where: and(
          eq(assemblies.type, parsed.type),
          eq(assemblies.number, parsed.number),
        ),
      })
    : CUID_PATTERN.test(param)
      ? await db.query.assemblies.findFirst({ where: eq(assemblies.id, param) })
      : undefined;
  if (!assembly || !canSeeAssembly(actor, assembly))
    notFound("Asamblea no encontrada");
  return assembly;
}

/** Resolves a document by slug or id within an assembly. */
export async function resolveDocument(
  actor: Actor,
  assemblyId: string,
  param: string | undefined,
) {
  if (!param) notFound("Documento no encontrado");
  // A long hyphen-free slug can look like a CUID, so fall back to the slug.
  const byId = CUID_PATTERN.test(param)
    ? await db.query.documents.findFirst({
        where: and(
          eq(documents.assemblyId, assemblyId),
          eq(documents.id, param),
        ),
      })
    : undefined;
  const document =
    byId ??
    (await db.query.documents.findFirst({
      where: and(
        eq(documents.assemblyId, assemblyId),
        eq(documents.slug, param),
      ),
    }));
  if (!document || !canSeeDocument(actor, document))
    notFound("Documento no encontrado");
  return document;
}

export async function resolveAgendaItem(
  assemblyId: string,
  param: string | undefined,
) {
  if (!param || !CUID_PATTERN.test(param)) notFound("Punto no encontrado");
  const item = await db.query.agendaItems.findFirst({
    where: and(
      eq(agendaItems.id, param),
      eq(agendaItems.assemblyId, assemblyId),
    ),
  });
  if (!item) notFound("Punto no encontrado");
  return item;
}

/** Loads an amendment of the document. Visibility is checked by the caller. */
export async function resolveAmendment(
  documentId: string,
  param: string | undefined,
) {
  if (!param || !CUID_PATTERN.test(param)) notFound("Enmienda no encontrada");
  const amendment = await db.query.amendments.findFirst({
    where: and(eq(amendments.id, param), eq(amendments.documentId, documentId)),
  });
  if (!amendment) notFound("Enmienda no encontrada");
  return amendment;
}
