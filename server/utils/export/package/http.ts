import { createError, getQuery, getRouterParam, type H3Event } from "h3";
import type { z } from "zod/v4";
import {
  assemblyPackageQuerySchema,
  assemblyPackageRequestSchema,
  type packageSelectionSchema,
} from "~~/shared/utils/schemas/export";
import { requireActor, type Actor } from "../../domain/actor";
import { parseDocumentBody } from "../../domain/documents";
import { resolveAssembly } from "../../domain/resolvers";
import { isFullPackageFilter, type PackageFilter } from "./filter";
import { rememberedPackageFilter } from "./service";

export interface PackageRequest {
  actor: Actor;
  assemblyId: string;
  locale: "es" | "en";
  editable: boolean;
  /** A part of the package; null for the whole of it. */
  filter: PackageFilter | null;
}

/**
 * What the package endpoints share: the requester (any account that sees
 * the assembly: the package only holds what is public), the assembly,
 * which package (language, Word versions or not) and which part of it: the
 * request's `selection` (POST), or the key of a filter asked for before
 * (`?filter=`, status and download).
 */
export async function resolvePackageRequest(
  event: H3Event,
  body?: unknown,
): Promise<PackageRequest> {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  if (body !== undefined) {
    const { locale, editable, selection } = parseDocumentBody(
      assemblyPackageRequestSchema,
      body ?? {},
    );
    return {
      actor,
      assemblyId: assembly.id,
      locale,
      editable,
      filter: selection ? partFilter(selection) : null,
    };
  }
  const { locale, editable, filter } = parseDocumentBody(
    assemblyPackageQuerySchema,
    getQuery(event),
  );
  let remembered: PackageFilter | null = null;
  if (filter) {
    remembered = rememberedPackageFilter(assembly.id, filter);
    if (!remembered) {
      throw createError({
        statusCode: 404,
        data: { messageKey: "assembly.package.selectionExpired" },
        message: "La selección ya no está disponible: vuelve a pedirla",
      });
    }
  }
  return {
    actor,
    assemblyId: assembly.id,
    locale,
    editable,
    filter: remembered,
  };
}

/** A selection as a part's filter; null when it takes the whole package. */
function partFilter(
  selection: z.output<typeof packageSelectionSchema>,
): PackageFilter | null {
  let amendments: PackageFilter["amendments"];
  switch (selection.amendments) {
    case "authors":
      amendments = { mode: "authors", memberIds: selection.memberIds };
      break;
    case "selected":
      amendments = { mode: "selected", amendmentIds: selection.amendmentIds };
      break;
    default:
      amendments = { mode: selection.amendments };
  }
  const filter: PackageFilter = {
    documentIds: selection.documentIds,
    texts: selection.texts,
    amendments,
  };
  return isFullPackageFilter(filter) ? null : filter;
}

/**
 * What the audit row says of a part: how much was chosen, never the ids.
 */
export function packageFilterAudit(filter: PackageFilter | null) {
  if (!filter) return null;
  const { amendments } = filter;
  return {
    documents: filter.documentIds?.length ?? null,
    texts: filter.texts,
    amendments: amendments.mode,
    chosen:
      amendments.mode === "authors"
        ? amendments.memberIds.length
        : amendments.mode === "selected"
          ? amendments.amendmentIds.length
          : null,
  };
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
