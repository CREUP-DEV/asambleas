import { z } from "zod/v4";
import {
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  MAJORITIES,
  VOTE_METHODS,
} from "../../constants/domain";
import { blocksSchema } from "./content";

/**
 * Request bodies of the document endpoints. They mirror the types in
 * shared/types/api.ts (DocumentCreateBody, DocumentUpdateBody,
 * DocumentContentBody, FinalVoteBody).
 */

const ENTITY_ID_PATTERN = /^[a-z0-9]{20,32}$/;

export const entityIdSchema = z.string().regex(ENTITY_ID_PATTERN);

export const isoDateSchema = z.iso.datetime({ offset: true });

const titleSchema = z.string().trim().min(1).max(300);
const summarySchema = z.string().trim().max(5_000);

export const documentCreateSchema = z.object({
  agendaItemId: entityIdSchema,
  kind: z.enum(DOCUMENT_KINDS),
  format: z.enum(DOCUMENT_FORMATS),
  title: titleSchema,
  summary: summarySchema.nullable().optional(),
  proponentMemberId: entityIdSchema.nullable().optional(),
  amendable: z.boolean().optional(),
  voted: z.boolean().optional(),
  majority: z.enum(MAJORITIES).optional(),
  blocks: blocksSchema.optional(),
});

export const documentUpdateSchema = z.object({
  title: titleSchema.optional(),
  summary: summarySchema.nullable().optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  agendaItemId: entityIdSchema.optional(),
  proponentMemberId: entityIdSchema.nullable().optional(),
  amendable: z.boolean().optional(),
  voted: z.boolean().optional(),
  majority: z.enum(MAJORITIES).optional(),
  amendmentsOpenAt: isoDateSchema.nullable().optional(),
  amendmentsCloseAt: isoDateSchema.nullable().optional(),
  status: z.enum(["withdrawn", "postponed", "submitted"]).optional(),
  updatedAt: isoDateSchema,
});

/** SHA-256 hex digest, as produced by hashContent. */
export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const documentContentSchema = z.object({
  blocks: blocksSchema,
  baseHash: contentHashSchema,
});

/** Optional body of submit and publish: the updatedAt the client last saw. */
export const documentActionSchema = z
  .object({ updatedAt: isoDateSchema.optional() })
  .default({});

const voteCountSchema = z.number().int().min(0).max(100_000);

export const voteInputSchema = z.object({
  method: z.enum(VOTE_METHODS),
  inFavor: voteCountSchema.optional(),
  against: voteCountSchema.optional(),
  abstentions: voteCountSchema.optional(),
  blank: voteCountSchema.optional(),
  invalid: voteCountSchema.optional(),
  present: voteCountSchema.nullable().optional(),
  majority: z.enum(MAJORITIES).optional(),
  note: z.string().trim().max(2_000).nullable().optional(),
});

export const finalVoteSchema = z.object({
  vote: voteInputSchema,
  order: z
    .array(entityIdSchema)
    .max(2_000)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "duplicate_amendment_id",
    })
    .optional(),
});
