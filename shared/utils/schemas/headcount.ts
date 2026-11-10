import { z } from "zod/v4";
import type { HeadcountBody, HeadcountUpdateBody } from "../../types/api";
import { ATTENDANCE_MARKS } from "../headcount";
import { normalizeText } from "./content";

/**
 * Request bodies of the headcounts API (docs/api.md, "Headcounts"). Each
 * schema is checked against its type in shared/types/api.ts below.
 */

/** Longest note on a headcount ("Inicio de la segunda jornada"). */
export const HEADCOUNT_NOTE_MAX_LENGTH = 300;
/** Most members a headcount lists; more is refused. */
export const HEADCOUNT_MAX_ENTRIES = 500;

const entityId = z.string().regex(/^[a-z0-9]{20,32}$/);

const noteSchema = z
  .string()
  .max(HEADCOUNT_NOTE_MAX_LENGTH)
  .transform((value) => {
    const text = normalizeText(value).replace(/\s+/g, " ").trim();
    return text === "" ? null : text;
  })
  .nullable()
  .optional();

const entrySchema = z.strictObject({
  memberId: entityId,
  mark: z.enum(ATTENDANCE_MARKS),
  delegateId: entityId.nullable().optional(),
});

/** POST /api/assemblies/[assembly]/headcounts (HeadcountBody). */
export const headcountBodySchema = z.strictObject({
  entries: z.array(entrySchema).max(HEADCOUNT_MAX_ENTRIES),
  note: noteSchema,
});

/** PUT /api/assemblies/[assembly]/headcounts/[headcount]. */
export const headcountUpdateBodySchema = headcountBodySchema.extend({
  updatedAt: z.iso.datetime({ offset: true }),
});

// Compile-time checks: every parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _HeadcountSchemaChecks = [
  Assignable<HeadcountBody, z.output<typeof headcountBodySchema>>,
  Assignable<HeadcountUpdateBody, z.output<typeof headcountUpdateBodySchema>>,
];
