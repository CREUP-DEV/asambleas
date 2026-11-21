import { z } from "zod/v4";
import { MAJORITIES, VOTE_METHODS } from "../../constants/domain";
import { foreignBallotKeys } from "../votes";
import { ROLL_CALL_CHOICES } from "../rollCall";
import {
  ELECTION_CANDIDATE_MAX_LENGTH,
  ELECTION_MAX_CANDIDATES,
  ELECTION_RULES,
} from "../election";
import {
  ALTERNATIVES_OPTION_COUNT,
  ALTERNATIVES_TIE_RESOLUTIONS,
  ALTERNATIVES_WINNER_OUTCOMES,
  alternativesSetsProblem,
} from "../alternativesVote";
import type {
  AlternativesVoteBody,
  BlocVoteBody,
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

/** The most delegations a registered vote lists. */
export const MAX_VOTE_BALLOTS = 500;

/** Each delegation's ballot of a registered vote (VoteBallotInput). */
const ballotsSchema = z
  .array(
    z.object({
      memberId: z.string().min(1).max(64),
      choice: z.enum(ROLL_CALL_CHOICES),
      option: z.number().int().min(0).max(50).nullable().optional(),
    }),
  )
  .max(MAX_VOTE_BALLOTS);

const noteSchema = z
  .string()
  .max(VOTE_NOTE_MAX_LENGTH)
  .transform((value) => normalizeText(value).trim())
  .nullable()
  .optional();

/**
 * Blank and invalid ballots only in a secret vote, abstentions in any other
 * counted one (user's decision of 2026-11-19): a count the method does not
 * take is refused unless it is zero.
 */
export const voteInputSchema = z
  .object({
    method: z.enum(VOTE_METHODS),
    inFavor: count.optional(),
    against: count.optional(),
    abstentions: count.optional(),
    blank: count.optional(),
    invalid: count.optional(),
    notCast: count.optional(),
    present: count.nullable().optional(),
    ballots: ballotsSchema.optional(),
    rollCallHeadcountId: z.string().min(1).max(64).optional(),
    majority: z.enum(MAJORITIES).optional(),
    note: noteSchema,
    unanimous: z.boolean().optional(),
  })
  .superRefine((vote, ctx) => {
    if ((vote.ballots?.length ?? 0) > 0 && vote.method !== "roll_call") {
      ctx.addIssue({
        code: "custom",
        path: ["ballots"],
        message: "Only a registered vote records each delegation's ballot",
      });
    }
    for (const key of foreignBallotKeys(vote.method)) {
      if ((vote[key] ?? 0) > 0) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            key === "abstentions"
              ? "A secret vote counts blank ballots, not abstentions"
              : "Only a secret vote counts blank and invalid ballots",
        });
      }
    }
  });

const updatedAt = z.iso.datetime({ offset: true });

/**
 * Body of POST .../amendments/alternatives (AlternativesVoteBody): as many
 * options as ALTERNATIVES_OPTION_COUNT, none empty, no amendment in two;
 * no assent; blank and invalid ballots only in a secret vote.
 */
export const alternativesVoteBodySchema = z
  .object({
    method: z.enum(VOTE_METHODS).exclude(["assent"]),
    options: z
      .array(
        z.object({
          items: z
            .array(z.object({ id: z.string().min(1).max(64), updatedAt }))
            .min(1)
            .max(200),
          count,
        }),
      )
      .length(ALTERNATIVES_OPTION_COUNT),
    abstentions: count.optional(),
    blank: count.optional(),
    invalid: count.optional(),
    notCast: count.optional(),
    present: count.nullable().optional(),
    note: noteSchema,
    tieResolution: z.enum(ALTERNATIVES_TIE_RESOLUTIONS).optional(),
    winnerOutcome: z.enum(ALTERNATIVES_WINNER_OUTCOMES).optional(),
    ballots: ballotsSchema.optional(),
    rollCallHeadcountId: z.string().min(1).max(64).optional(),
    project: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    const problem = alternativesSetsProblem(
      body.options.map((option) => option.items.map((item) => item.id)),
    );
    if (problem) {
      ctx.addIssue({ code: "custom", path: ["options"], message: problem });
    }
    if ((body.ballots?.length ?? 0) > 0 && body.method !== "roll_call") {
      ctx.addIssue({
        code: "custom",
        path: ["ballots"],
        message: "Only a registered vote records each delegation's ballot",
      });
    }
    const secret = body.method === "secret";
    for (const key of secret
      ? (["abstentions"] as const)
      : (["blank", "invalid"] as const)) {
      if ((body[key] ?? 0) > 0) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: secret
            ? "A secret vote counts blank ballots, not abstentions"
            : "Only a secret vote counts blank and invalid ballots",
        });
      }
    }
  });

/** An election's candidates and votes (ElectionInput). */
const electionSchema = z
  .object({
    candidates: z
      .array(
        z
          .string()
          .max(ELECTION_CANDIDATE_MAX_LENGTH)
          .transform((value) => normalizeText(value).trim())
          .pipe(z.string().min(1)),
      )
      .min(1)
      .max(ELECTION_MAX_CANDIDATES),
    maxChoices: z.number().int().min(1).max(ELECTION_MAX_CANDIDATES),
    rule: z.enum(ELECTION_RULES),
    counts: z.array(count).max(ELECTION_MAX_CANDIDATES),
    ballots: count,
  })
  .superRefine((election, ctx) => {
    if (election.counts.length !== election.candidates.length) {
      ctx.addIssue({
        code: "custom",
        path: ["counts"],
        message: "count_per_candidate",
      });
    }
    if (election.maxChoices > election.candidates.length) {
      ctx.addIssue({
        code: "custom",
        path: ["maxChoices"],
        message: "too_many_posts",
      });
    }
    // No candidate gets more votes than ballots marked someone, nor do all
    // of them more than the ballots may mark.
    const total = election.counts.reduce((sum, value) => sum + value, 0);
    if (
      election.counts.some((value) => value > election.ballots) ||
      total > election.ballots * election.maxChoices
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ballots"],
        message: "ballots_short",
      });
    }
  });

/** Body of POST .../agenda/[item]/votes (ItemVoteBody). */
export const itemVoteBodySchema = z
  .object({
    question: z
      .string()
      .max(VOTE_QUESTION_MAX_LENGTH)
      .transform((value) => normalizeText(value).trim())
      .pipe(z.string().min(1)),
    vote: voteInputSchema,
    election: electionSchema.optional(),
    project: z.boolean().optional(),
  })
  .refine(
    (body) =>
      !body.election ||
      (body.vote.method !== "assent" && body.vote.method !== "roll_call"),
    {
      path: ["vote", "method"],
      message: "An election is never by assent nor registered",
    },
  );

/**
 * Body of POST .../amendments/bloc-vote (BlocVoteBody): two or more
 * different amendments, a counted vote (never assent: it has its own
 * request).
 */
export const blocVoteBodySchema = z
  .object({
    items: z
      .array(z.object({ id: z.string().min(1).max(64), updatedAt }))
      .min(2)
      .max(200)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        { message: "duplicate_ids" },
      ),
    vote: voteInputSchema,
    project: z.boolean().optional(),
  })
  .refine((body) => body.vote.method !== "assent", {
    path: ["vote", "method"],
    message: "A bloc is approved by assent through POST .../assent",
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
  Assignable<BlocVoteBody, z.output<typeof blocVoteBodySchema>>,
  Assignable<AlternativesVoteBody, z.output<typeof alternativesVoteBodySchema>>,
  Assignable<ItemVoteBody, z.output<typeof itemVoteBodySchema>>,
  Assignable<VoteVoidBody, z.output<typeof voteVoidBodySchema>>,
  Assignable<VoteUnanimityBody, z.output<typeof voteUnanimityBodySchema>>,
];
