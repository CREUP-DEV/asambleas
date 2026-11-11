import { z } from "zod/v4";
import type {
  DocumentNoteCreateBody,
  DocumentNoteUpdateBody,
} from "../../types/api";
import {
  DOCUMENT_NOTE_MAX_LENGTH,
  DOCUMENT_NOTE_QUOTE_MAX_LENGTH,
} from "../documentNotes";

/** Longest block text a stretch can point into. */
const MAX_OFFSET = 1_000_000;

const body = z
  .string()
  .max(DOCUMENT_NOTE_MAX_LENGTH)
  .refine((value) => value.trim().length > 0);

const anchor = z
  .strictObject({
    blockId: z.string().regex(/^[\w-]{1,64}$/),
    from: z.number().int().min(0).max(MAX_OFFSET),
    to: z.number().int().min(1).max(MAX_OFFSET),
    quote: z.string().min(1).max(DOCUMENT_NOTE_QUOTE_MAX_LENGTH),
  })
  .refine((value) => value.to > value.from);

/** POST .../documents/[document]/notes (DocumentNoteCreateBody). */
export const documentNoteCreateBodySchema = z.strictObject({
  anchor: anchor.nullable().optional(),
  body,
});

/** PUT .../documents/[document]/notes/[note] (DocumentNoteUpdateBody). */
export const documentNoteUpdateBodySchema = z.strictObject({
  body,
  updatedAt: z.iso.datetime({ offset: true }),
});

// Compile-time check: the parsed bodies are assignable to their API types.
type Assignable<T, U extends T> = U;
export type _DocumentNoteSchemaChecks = [
  Assignable<
    DocumentNoteCreateBody,
    z.output<typeof documentNoteCreateBodySchema>
  >,
  Assignable<
    DocumentNoteUpdateBody,
    z.output<typeof documentNoteUpdateBodySchema>
  >,
];
