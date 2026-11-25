import { z } from "zod/v4";
import type {
  AmendmentNoteCreateBody,
  AmendmentNoteUpdateBody,
} from "../../types/api";
import { AMENDMENT_NOTE_MAX_LENGTH } from "../amendmentNotes";
import { updatedAtSchema } from "./primitives";

const body = z
  .string()
  .max(AMENDMENT_NOTE_MAX_LENGTH)
  .refine((value) => value.trim().length > 0);

/** POST .../amendments/[amendment]/notes (AmendmentNoteCreateBody). */
export const amendmentNoteCreateBodySchema = z.strictObject({ body });

/** PUT .../amendments/[amendment]/notes/[note] (AmendmentNoteUpdateBody). */
export const amendmentNoteUpdateBodySchema = z.strictObject({
  body,
  updatedAt: updatedAtSchema,
});

// Compile-time check: the parsed bodies are assignable to their API types.
type Assignable<T, U extends T> = U;
export type _AmendmentNoteSchemaChecks = [
  Assignable<
    AmendmentNoteCreateBody,
    z.output<typeof amendmentNoteCreateBodySchema>
  >,
  Assignable<
    AmendmentNoteUpdateBody,
    z.output<typeof amendmentNoteUpdateBodySchema>
  >,
];
