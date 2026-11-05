import { z } from "zod/v4";
import { SPEAKING_TURN_STATUSES } from "../../constants/domain";
import type { SpeakingTurnBody, SpeakingTurnUpdateBody } from "../../types/api";
import { normalizeText } from "./content";

/**
 * Request bodies of the speaking turns API (docs/api.md, "Speaking turns").
 * Each schema is checked against its type in shared/types/api.ts below.
 */

/** Longest name the Mesa can write for the person who asks to speak. */
export const SPEAKER_NAME_MAX_LENGTH = 120;
/** Waiting turns of one assembly; a longer queue is refused. */
export const SPEAKING_QUEUE_MAX_LENGTH = 200;
const MAX_QUEUE_POSITION = 10_000;

const entityId = z.string().regex(/^[a-z0-9]{20,32}$/);

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
  memberId: entityId.nullable().optional(),
  speaker: speakerNameSchema,
  agendaItemId: entityId.nullable().optional(),
});

/** PUT /api/assemblies/[assembly]/speakers/[turn] (SpeakingTurnUpdateBody). */
export const speakingTurnUpdateBodySchema = z.object({
  status: z.enum(SPEAKING_TURN_STATUSES).optional(),
  position: z.number().int().min(0).max(MAX_QUEUE_POSITION).optional(),
  speaker: speakerNameSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});

// Compile-time checks: every parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _SpeakerSchemaChecks = [
  Assignable<SpeakingTurnBody, z.output<typeof speakingTurnBodySchema>>,
  Assignable<
    SpeakingTurnUpdateBody,
    z.output<typeof speakingTurnUpdateBodySchema>
  >,
];
