import { z } from "zod/v4";

/** Locales a PDF export can be rendered in. */
export const EXPORT_LOCALES = ["es", "en"] as const;
export type ExportLocale = (typeof EXPORT_LOCALES)[number];

/**
 * - `clean`: the consolidated text if stored, else the published base, else
 *   the working draft (editors only).
 * - `annotated`: the base with every approved amendment marked in place,
 *   followed by an annex of all amendments and their outcomes.
 */
export const EXPORT_VARIANTS = ["clean", "annotated"] as const;
export type ExportVariant = (typeof EXPORT_VARIANTS)[number];

/** Body of POST /api/assemblies/[assembly]/export. */
export const assemblyExportSchema = z.object({
  locale: z.enum(EXPORT_LOCALES).default("es"),
});

/** Body of POST /api/assemblies/[assembly]/documents/[document]/export. */
export const documentExportSchema = assemblyExportSchema.extend({
  variant: z.enum(EXPORT_VARIANTS).default("clean"),
});

export type AssemblyExportBody = z.input<typeof assemblyExportSchema>;
export type DocumentExportBody = z.input<typeof documentExportSchema>;
