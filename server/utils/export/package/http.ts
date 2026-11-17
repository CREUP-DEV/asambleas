import { createError, getQuery, getRouterParam, type H3Event } from "h3";
import { assemblyPackageSchema } from "~~/shared/utils/schemas/export";
import { requireActor, type Actor } from "../../domain/actor";
import { parseDocumentBody } from "../../domain/documents";
import { resolveAssembly } from "../../domain/resolvers";

/**
 * What the package endpoints share: the requester (any account that sees
 * the assembly: the package only holds what is public), the assembly and
 * which package (language, Word versions or not).
 */
export async function resolvePackageRequest(
  event: H3Event,
  input: unknown = getQuery(event),
): Promise<{
  actor: Actor;
  assemblyId: string;
  locale: "es" | "en";
  editable: boolean;
}> {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const { locale, editable } = parseDocumentBody(
    assemblyPackageSchema,
    input ?? {},
  );
  return { actor, assemblyId: assembly.id, locale, editable };
}

/** The assembly is not public yet (a draft): there is no package. */
export function packageNotPublic(): never {
  throw createError({
    statusCode: 404,
    data: { messageKey: "assembly.package.notPublic" },
    message: "La asamblea todavía no es pública",
  });
}

/**
 * Content-Disposition for a download name that may hold accents and "ª":
 * a plain ASCII name for old clients and the real one in UTF-8 (RFC 6266).
 */
export function attachmentDisposition(filename: string): string {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii || "documentacion.zip"}"; filename*=UTF-8''${encoded}`;
}
