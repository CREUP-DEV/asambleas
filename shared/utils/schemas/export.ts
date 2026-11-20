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

/**
 * Body of POST /api/assemblies/[assembly]/package and query of its status
 * and download: the language of the package and whether it carries the
 * Word versions of the texts.
 */
export const assemblyPackageSchema = z.object({
  locale: z.enum(EXPORT_LOCALES).default("es"),
  editable: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(false)
    .transform((value) => value === true || value === "true" || value === "1"),
});

/** Query of the package's status and download: a part names its filter. */
export const assemblyPackageQuerySchema = assemblyPackageSchema.extend({
  filter: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
});

const packageIdsSchema = (max: number) =>
  z.array(z.string().min(1).max(64)).max(max);

/**
 * A part of the package: some documents (all of them when null), whether
 * their texts go, and which amendments: all, none, those any of
 * `memberIds` signs, or `amendmentIds` (the control sheet's).
 */
export const packageSelectionSchema = z.object({
  documentIds: packageIdsSchema(2_000).nullable().default(null),
  texts: z.boolean().default(true),
  amendments: z.enum(["all", "none", "authors", "selected"]).default("all"),
  memberIds: packageIdsSchema(2_000).default([]),
  amendmentIds: packageIdsSchema(10_000).default([]),
});

export type PackageSelection = z.input<typeof packageSelectionSchema>;

/** Body of POST /api/assemblies/[assembly]/package. */
export const assemblyPackageRequestSchema = assemblyPackageSchema.extend({
  selection: packageSelectionSchema.nullable().default(null),
});

export type AssemblyPackageBody = z.input<typeof assemblyPackageRequestSchema>;
