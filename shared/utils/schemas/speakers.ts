import { z } from "zod/v4";
import { SPEAKING_TURN_STATUSES } from "../../constants/domain";
import type {
  SpeakerNoteBody,
  SpeakingTurnBody,
  SpeakingTurnUpdateBody,
} from "../../types/api";
import { normalizeText } from "./content";
import {
  SPEAKING_LIMIT_MAX_SECONDS,
  SPEAKING_LIMIT_MIN_SECONDS,
} from "./assembly";
import { entityIdSchema, updatedAtSchema } from "./primitives";

/**
 * Request bodies of the speaking turns API (docs/api.md, "Speaking turns").
 * Each schema is checked against its type in shared/types/api.ts below.
 */

/** Longest name the Mesa can write for the person who asks to speak. */
export const SPEAKER_NAME_MAX_LENGTH = 120;
/** Waiting turns of one assembly; a longer queue is refused. */
export const SPEAKING_QUEUE_MAX_LENGTH = 200;
const MAX_QUEUE_POSITION = 10_000;

/** A single line; blank means no name (null). */
const speakerNameSchema = z
  .string()
  .max(SPEAKER_NAME_MAX_LENGTH)
  .transform((value) => {
    const text = normalizeText(value).replace(/\s+/g, " ").trim();
    return text === "" ? null : text;
  })
  .nullable()
  .optional();

/** POST /api/assemblies/[assembly]/speakers (SpeakingTurnBody). */
export const speakingTurnBodySchema = z.object({
  memberId: entityIdSchema.nullable().optional(),
  speaker: speakerNameSchema,
  agendaItemId: entityIdSchema.nullable().optional(),
  limited: z.boolean().optional(),
  priority: z.boolean().optional(),
});

/** PUT /api/assemblies/[assembly]/speakers/[turn] (SpeakingTurnUpdateBody). */
export const speakingTurnUpdateBodySchema = z.object({
  status: z.enum(SPEAKING_TURN_STATUSES).optional(),
  position: z.number().int().min(0).max(MAX_QUEUE_POSITION).optional(),
  speaker: speakerNameSchema,
  limitSeconds: z
    .number()
    .int()
    .min(SPEAKING_LIMIT_MIN_SECONDS)
    .max(SPEAKING_LIMIT_MAX_SECONDS)
    .nullable()
    .optional(),
  expectHead: z.boolean().optional(),
  expectedSpeakingId: entityIdSchema.nullable().optional(),
  updatedAt: updatedAtSchema,
});

/** POST /api/assemblies/[assembly]/speakers/notes (SpeakerNoteBody). */
export const speakerNoteBodySchema = z.object({
  agendaItemId: entityIdSchema.nullable(),
  amendmentId: entityIdSchema.nullable().optional(),
  memberId: entityIdSchema.nullable().optional(),
  speaker: speakerNameSchema,
});

// Compile-time checks: every parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _SpeakerSchemaChecks = [
  Assignable<SpeakingTurnBody, z.output<typeof speakingTurnBodySchema>>,
  Assignable<
    SpeakingTurnUpdateBody,
    z.output<typeof speakingTurnUpdateBodySchema>
  >,
  Assignable<SpeakerNoteBody, z.output<typeof speakerNoteBodySchema>>,
];
