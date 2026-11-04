import { z } from "zod/v4";
import { MEMBER_KINDS } from "../../constants/domain";
import { normalizeText } from "./content";

/**
 * Request bodies of the members API (docs/api.md, "Members and me"). There
 * is no body type in shared/types/api.ts for these, so the inferred types
 * below are the contract.
 */

export const MEMBER_ACRONYM_MAX_LENGTH = 20;
export const MEMBER_NAME_MAX_LENGTH = 200;
export const MEMBER_DETAIL_MAX_LENGTH = 200;

/** Letters, digits and a few separators: "CEUM", "VPU", "CAUB", "UC3M", "DA-UPM". */
export const MEMBER_ACRONYM_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .&'/-]*$/u;

const cleanLine = (value: string) => normalizeText(value).replace(/\s+/g, " ").trim();

const memberAcronymSchema = z
  .string()
  .max(MEMBER_ACRONYM_MAX_LENGTH)
  .transform(cleanLine)
  .pipe(z.string().min(1).regex(MEMBER_ACRONYM_PATTERN));

const memberNameSchema = z
  .string()
  .max(MEMBER_NAME_MAX_LENGTH)
  .transform(cleanLine)
  .pipe(z.string().min(1));

const memberDetailSchema = z
  .string()
  .max(MEMBER_DETAIL_MAX_LENGTH)
  .transform((value) => cleanLine(value) || null)
  .nullable()
  .optional();

export const memberCreateBodySchema = z.object({
  kind: z.enum(MEMBER_KINDS),
  acronym: memberAcronymSchema,
  name: memberNameSchema,
  university: memberDetailSchema,
  region: memberDetailSchema,
});

/**
 * Edits a member. `acronym` can only change on manual members: intranet
 * members are keyed by it and the next sync would undo the change.
 */
export const memberUpdateBodySchema = z.object({
  acronym: memberAcronymSchema.optional(),
  name: memberNameSchema.optional(),
  kind: z.enum(MEMBER_KINDS).optional(),
  active: z.boolean().optional(),
  university: memberDetailSchema,
  region: memberDetailSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});

export const memberListQuerySchema = z.object({
  all: z
    .enum(["1", "0", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});

export type MemberCreateBody = z.input<typeof memberCreateBodySchema>;
export type MemberUpdateBody = z.input<typeof memberUpdateBodySchema>;
