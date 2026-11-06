import { z } from "zod/v4";
import { MEMBER_KINDS } from "../../constants/domain";
import type {
  MemberSyncConfirmedKind,
  RosterMemberKind,
} from "../../types/api";
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

const cleanLine = (value: string) =>
  normalizeText(value).replace(/\s+/g, " ").trim();

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

/**
 * PUT /api/admin/users/[id]/member: links an account to the member it acts
 * for, or unlinks it with null, when role sync cannot (missing initials).
 */
export const userMemberLinkBodySchema = z.object({
  memberId: z
    .string()
    .regex(/^[a-z0-9]{20,32}$/)
    .nullable(),
});

/** The member kinds the intranet roster lists (RosterMemberKind). */
export const ROSTER_MEMBER_KINDS = [
  "asociado",
  "sectorial",
] as const satisfies readonly RosterMemberKind[];

/** Largest count a confirmation may carry: more members than any roster has. */
const CONFIRMED_COUNT_MAX = 10_000;

const memberSyncConfirmedKindSchema = z.strictObject({
  kind: z.enum(ROSTER_MEMBER_KINDS),
  toDeactivate: z.number().int().min(0).max(CONFIRMED_COUNT_MAX),
});

/**
 * POST /api/members/sync (MemberSyncBody in shared/types/api.ts). The body
 * may be absent, as it was before the safeguard: undefined and null parse
 * as `{}`. The output always says whether a large deactivation is
 * confirmed (only a literal `true` confirms it) and what was confirmed:
 * `confirmedKinds`, one entry per kind at most, empty without a
 * confirmation.
 */
export const memberSyncBodySchema = z
  .object({
    confirmDeactivation: z.boolean().optional(),
    confirmedKinds: z
      .array(memberSyncConfirmedKindSchema)
      .max(ROSTER_MEMBER_KINDS.length)
      .refine(
        (kinds) =>
          new Set(kinds.map((entry) => entry.kind)).size === kinds.length,
        { message: "one entry per kind" },
      )
      .optional(),
  })
  .nullish()
  .transform(
    (
      body,
    ): {
      confirmDeactivation: boolean;
      confirmedKinds: MemberSyncConfirmedKind[];
    } => {
      const confirmDeactivation = body?.confirmDeactivation === true;
      return {
        confirmDeactivation,
        confirmedKinds: confirmDeactivation ? (body?.confirmedKinds ?? []) : [],
      };
    },
  );

/** Largest Intranet id the platform stores (Postgres `integer`). */
export const INTRANET_ID_MAX = 2_147_483_647;

/**
 * An Intranet account id (`users.id`), as the role lookup and the roster
 * send it: a positive integer that fits users.intranet_id and
 * members.intranet_id.
 */
export const intranetIdSchema = z.number().int().min(1).max(INTRANET_ID_MAX);
