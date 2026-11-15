import { z } from "zod/v4";
import { MAJORITIES, VOTE_METHODS } from "../../constants/domain";
import type {
  ItemVoteBody,
  VoteInput,
  VoteUnanimityBody,
  VoteVoidBody,
} from "../../types/api";
import { normalizeText } from "./content";

/**
 * The one vote input every vote body takes (a document's final vote, an
 * amendment's outcome and admission, an agenda item's vote), and the bodies
 * of the votes on agenda items.
 */

export const VOTE_NOTE_MAX_LENGTH = 2_000;
export const VOTE_QUESTION_MAX_LENGTH = 500;
export const MAX_VOTE_COUNT = 100_000;

const count = z.number().int().min(0).max(MAX_VOTE_COUNT);

const noteSchema = z
  .string()
  .max(VOTE_NOTE_MAX_LENGTH)
  .transform((value) => normalizeText(value).trim())
  .nullable()
  .optional();

export const voteInputSchema = z.object({
  method: z.enum(VOTE_METHODS),
  inFavor: count.optional(),
  against: count.optional(),
  abstentions: count.optional(),
  blank: count.optional(),
  invalid: count.optional(),
  present: count.nullable().optional(),
  majority: z.enum(MAJORITIES).optional(),
  note: noteSchema,
  unanimous: z.boolean().optional(),
});

const updatedAt = z.iso.datetime({ offset: true });

/** Body of POST .../agenda/[item]/votes (ItemVoteBody). */
export const itemVoteBodySchema = z.object({
  question: z
    .string()
    .max(VOTE_QUESTION_MAX_LENGTH)
    .transform((value) => normalizeText(value).trim())
    .pipe(z.string().min(1)),
  vote: voteInputSchema,
  project: z.boolean().optional(),
});

/** Body of DELETE .../votes/[vote] (VoteVoidBody). */
export const voteVoidBodySchema = z.object({ updatedAt });

/** Body of PATCH .../votes/[vote]/unanimity (VoteUnanimityBody). */
export const voteUnanimityBodySchema = z.object({
  unanimous: z.boolean(),
  updatedAt,
});

// Compile-time checks: every parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _VoteSchemaChecks = [
  Assignable<VoteInput, z.output<typeof voteInputSchema>>,
  Assignable<ItemVoteBody, z.output<typeof itemVoteBodySchema>>,
  Assignable<VoteVoidBody, z.output<typeof voteVoidBodySchema>>,
  Assignable<VoteUnanimityBody, z.output<typeof voteUnanimityBodySchema>>,
];
