import { z } from "zod/v4";
import { ALL_ASSEMBLY_TYPES } from "../../constants/assemblyTypes";
import type { AssemblyType } from "../../constants/assemblyTypes";
import {
  ASSEMBLY_STATUSES,
  DOCUMENT_KINDS,
  MAJORITIES,
  MILESTONE_KEYS,
  VOTE_METHODS,
  VOTE_SUBJECTS,
} from "../../constants/domain";
import type {
  AgendaItemBody,
  AgendaReorderBody,
  AssemblyCreateBody,
  AssemblyStatusBody,
  AssemblyUpdateBody,
  CalendarBody,
  LivePointerBody,
  LiveScrollBody,
  LiveTallyBody,
  ProjectionControlBody,
  LiveStateBody,
} from "../../types/api";
import { normalizeText } from "./content";
import {
  ELECTION_CANDIDATE_MAX_LENGTH,
  ELECTION_MAX_CANDIDATES,
  ELECTION_RULES,
} from "../election";
import { VOTE_QUESTION_MAX_LENGTH } from "./vote";

/**
 * Request bodies and queries of the assembly, calendar, agenda and live
 * session API (docs/api.md). Dates stay ISO strings, as in shared/types/api.ts;
 * handlers turn them into Date objects.
 */

export const ASSEMBLY_LOCATION_MAX_LENGTH = 200;
export const CONVOCATION_INTRO_MAX_LENGTH = 20_000;
export const AGENDA_TITLE_MAX_LENGTH = 300;
export const AGENDA_DESCRIPTION_MAX_LENGTH = 5_000;
export const AGENDA_MAX_ITEMS = 500;
export const LIVE_MESSAGE_MAX_LENGTH = 500;
/** A speaking turn's limit: from 10 seconds to an hour. */
export const SPEAKING_LIMIT_MIN_SECONDS = 10;
export const SPEAKING_LIMIT_MAX_SECONDS = 3600;
/** The default limit of a speaking turn: three minutes (the column's default). */
export const DEFAULT_SPEAKING_LIMIT_SECONDS = 180;
export const MILESTONE_NOTE_MAX_LENGTH = 500;
/** The most amendments a bloc on screen holds (LiveStateBody.amendmentBloc). */
export const LIVE_BLOC_MAX_AMENDMENTS = 200;
export const ASSEMBLY_LIST_PAGE_SIZE = 20;

const assemblyIdPattern = /^[a-z0-9]{20,32}$/;
const assemblyEntityId = z.string().regex(assemblyIdPattern);
const isoDateTime = z.iso.datetime({ offset: true });
const assemblyTypeSchema = z.enum(
  ALL_ASSEMBLY_TYPES as [AssemblyType, ...AssemblyType[]],
);

const singleLine = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => normalizeText(value).replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1));

const multiLine = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => {
      const text = normalizeText(value).trim();
      return text === "" ? null : text;
    });

const endAfterStart = <T extends { startDate?: string; endDate?: string }>(
  body: T,
) =>
  !body.startDate ||
  !body.endDate ||
  new Date(body.endDate) >= new Date(body.startDate);

export const assemblyCreateBodySchema = z
  .object({
    number: z.number().int().min(1).max(9_999),
    type: assemblyTypeSchema,
    startDate: isoDateTime,
    endDate: isoDateTime,
    location: singleLine(ASSEMBLY_LOCATION_MAX_LENGTH),
    applyDefaultCalendar: z.boolean().optional(),
  })
  .refine(endAfterStart, { message: "end_before_start", path: ["endDate"] });

const assemblySettingsPatchSchema = z
  .object({
    tieRule: z.enum(["rejected", "repeat"]),
    denominator: z.enum(["valid_votes", "present"]),
    transactionalProposers: z.enum(["involved", "anyone"]),
  })
  .partial();

export const assemblyUpdateBodySchema = z
  .object({
    number: z.number().int().min(1).max(9_999).optional(),
    type: assemblyTypeSchema.optional(),
    startDate: isoDateTime.optional(),
    endDate: isoDateTime.optional(),
    location: singleLine(ASSEMBLY_LOCATION_MAX_LENGTH).optional(),
    convocationIntro: multiLine(CONVOCATION_INTRO_MAX_LENGTH)
      .nullable()
      .optional(),
    settings: assemblySettingsPatchSchema.optional(),
    updatedAt: isoDateTime,
  })
  .refine(endAfterStart, { message: "end_before_start", path: ["endDate"] });

export const assemblyStatusBodySchema = z.object({
  status: z.enum(ASSEMBLY_STATUSES),
  updatedAt: isoDateTime,
});

export const calendarBodySchema = z.object({
  milestones: z
    .array(
      z.object({
        key: z.enum(MILESTONE_KEYS),
        at: isoDateTime.nullable(),
        note: multiLine(MILESTONE_NOTE_MAX_LENGTH).nullable().optional(),
      }),
    )
    .max(MILESTONE_KEYS.length)
    .refine(
      (milestones) =>
        new Set(milestones.map((milestone) => milestone.key)).size ===
        milestones.length,
      { message: "duplicate_milestone" },
    ),
});

export const assemblyListQuerySchema = z.object({
  status: z.enum(ASSEMBLY_STATUSES).optional(),
  type: assemblyTypeSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

// Agenda -----------------------------------------------------------------

/**
 * `data.code` of the 409 a change to the root items gets once the agenda is
 * final and the request does not say `confirmFinal: true`. The client asks
 * and sends the request again with it.
 */
export const AGENDA_FINAL_CONFLICT_CODE = "agenda_final";

export const agendaItemBodySchema = z.object({
  parentId: assemblyEntityId.nullable().optional(),
  title: singleLine(AGENDA_TITLE_MAX_LENGTH),
  description: multiLine(AGENDA_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  acceptsSubmissions: z.boolean().optional(),
  submissionKinds: z
    .array(z.enum(DOCUMENT_KINDS))
    .max(DOCUMENT_KINDS.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, {
      message: "duplicate_kind",
    })
    .optional(),
  // Never a default: a PUT that leaves it out keeps what is stored.
  voted: z.boolean().optional(),
  updatedAt: isoDateTime.optional(),
  confirmFinal: z.boolean().optional(),
});

/** DELETE of an item has no body: the confirmation travels in the query. */
/** DELETE of the signed convocatoria: `updatedAt` of the assembly, for the lock. */
export const convocationDeleteQuerySchema = z.object({
  updatedAt: isoDateTime,
});

export const agendaItemDeleteQuerySchema = z.object({
  confirmFinal: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

/** PUT on an existing item: `updatedAt` is required for optimistic locking. */
export const agendaItemUpdateBodySchema = agendaItemBodySchema.extend({
  updatedAt: isoDateTime,
});

export const agendaReorderBodySchema = z.object({
  items: z
    .array(
      z.object({
        id: assemblyEntityId,
        parentId: assemblyEntityId.nullable(),
        order: z.number().int().min(0).max(100_000),
      }),
    )
    .min(1)
    .max(AGENDA_MAX_ITEMS)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      {
        message: "duplicate_id",
      },
    ),
  confirmFinal: z.boolean().optional(),
});

// Live session -----------------------------------------------------------

export const liveStateBodySchema = z.object({
  agendaItemId: assemblyEntityId.nullable().optional(),
  documentId: assemblyEntityId.nullable().optional(),
  amendmentId: assemblyEntityId.nullable().optional(),
  amendmentBloc: z
    .array(assemblyEntityId)
    .max(LIVE_BLOC_MAX_AMENDMENTS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "duplicate_id",
    })
    .nullable()
    .optional(),
  // The bloc as alternatives: each option's amendments (nextLivePointer
  // checks they split the bloc exactly).
  amendmentBlocOptions: z
    .array(z.array(assemblyEntityId).min(1).max(LIVE_BLOC_MAX_AMENDMENTS))
    .min(2)
    .max(10)
    .nullable()
    .optional(),
  voteId: assemblyEntityId.nullable().optional(),
  message: multiLine(LIVE_MESSAGE_MAX_LENGTH).nullable().optional(),
  speakersVisible: z.boolean().optional(),
  recess: z.object({ until: isoDateTime.nullable() }).nullable().optional(),
  speakingLimitSeconds: z
    .number()
    .int()
    .min(SPEAKING_LIMIT_MIN_SECONDS)
    .max(SPEAKING_LIMIT_MAX_SECONDS)
    .optional(),
});

/** POST .../live-scroll: where the Mesa has the document in debate. */
/** A console's browser tab id (crypto.randomUUID or similar). */
export const consoleTabIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);

export const projectionControlBodySchema = z.object({
  tabId: consoleTabIdSchema,
  action: z.enum(["beat", "take", "leave"]),
});

export const liveScrollBodySchema = z.object({
  documentId: assemblyEntityId,
  anchor: z.union([
    z.object({
      block: z.string().min(1).max(100),
      offset: z.number().min(0).max(1),
    }),
    z.object({
      page: z.number().int().min(1).max(10_000),
      offset: z.number().min(0).max(1),
    }),
  ]),
});

const fraction = z.number().min(0).max(1);
const livePointSchema = z.union([
  z.object({ block: z.string().min(1).max(100), x: fraction, y: fraction }),
  z.object({
    page: z.number().int().min(1).max(10_000),
    x: fraction,
    y: fraction,
  }),
]);

const spanPointSchema = z.object({
  blockId: z.string().min(1).max(100),
  offset: z.number().int().min(0).max(1_000_000),
});

/** Points a stroke may carry in one piece, and events in one request. */
export const LIVE_POINTER_MAX_POINTS = 400;
export const LIVE_POINTER_MAX_EVENTS = 60;

/** POST .../live-pointer: what the Mesa's pointer did on the document. */
export const livePointerBodySchema = z.object({
  documentId: assemblyEntityId,
  events: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("move"),
          point: livePointSchema.nullable(),
        }),
        z.object({ type: z.literal("click"), point: livePointSchema }),
        z.object({
          type: z.literal("select"),
          span: z
            .object({ start: spanPointSchema, end: spanPointSchema })
            .nullable(),
        }),
        z.object({
          type: z.literal("stroke"),
          id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
          points: z.array(livePointSchema).max(LIVE_POINTER_MAX_POINTS),
          end: z.boolean(),
          pinned: z.boolean(),
        }),
        z.object({ type: z.literal("clear") }),
      ]),
    )
    .min(1)
    .max(LIVE_POINTER_MAX_EVENTS),
});

const ballotCount = z.number().int().min(0).max(100_000);

/** How the room follows a secret vote's count (LiveTallyReveal). */
export const LIVE_TALLY_REVEALS = ["end", "live"] as const;

/**
 * A secret vote's count nobody has sent again for this long ends, on the
 * server and on the projection: the console repeats it every 15 s while
 * its form is open, and a hidden tab's timers fire once a minute, so 90 s
 * (as the projection control's CONTROL_TTL_MS) keeps a live count alive.
 */
export const LIVE_TALLY_TTL_MS = 90_000;

/**
 * POST .../live-tally: a secret vote the Mesa is counting (what is voted,
 * its question, how the count is shown and, ballot by ballot, the count),
 * or null.
 */
export const liveTallyBodySchema = z.object({
  tally: z
    .object({
      subject: z
        .object({
          type: z.enum(VOTE_SUBJECTS),
          id: assemblyEntityId.nullable(),
        })
        .nullable(),
      question: z
        .string()
        .max(VOTE_QUESTION_MAX_LENGTH)
        .transform((value) => normalizeText(value).trim() || null)
        .nullable(),
      method: z.enum(VOTE_METHODS),
      reveal: z.enum(LIVE_TALLY_REVEALS),
      counts: z
        .object({
          inFavor: ballotCount,
          against: ballotCount,
          blank: ballotCount,
          invalid: ballotCount,
        })
        .nullable(),
      options: z.array(ballotCount).max(10).nullable().optional(),
      election: z
        .object({
          candidates: z
            .array(
              z
                .string()
                .max(ELECTION_CANDIDATE_MAX_LENGTH)
                .transform((value) => normalizeText(value).trim()),
            )
            .min(1)
            .max(ELECTION_MAX_CANDIDATES),
          counts: z.array(ballotCount).max(ELECTION_MAX_CANDIDATES),
          ballots: ballotCount.nullable(),
          posts: z.number().int().min(1).max(ELECTION_MAX_CANDIDATES),
          maxChoices: z.number().int().min(1).max(ELECTION_MAX_CANDIDATES),
          rule: z.enum(ELECTION_RULES),
        })
        .nullable()
        .optional(),
      present: ballotCount.nullable(),
      majority: z.enum(MAJORITIES),
    })
    .nullable(),
});

// Compile-time checks: every parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _AssemblySchemaChecks = [
  Assignable<AssemblyCreateBody, z.output<typeof assemblyCreateBodySchema>>,
  Assignable<AssemblyUpdateBody, z.output<typeof assemblyUpdateBodySchema>>,
  Assignable<AssemblyStatusBody, z.output<typeof assemblyStatusBodySchema>>,
  Assignable<CalendarBody, z.output<typeof calendarBodySchema>>,
  Assignable<AgendaItemBody, z.output<typeof agendaItemBodySchema>>,
  Assignable<AgendaItemBody, z.output<typeof agendaItemUpdateBodySchema>>,
  Assignable<AgendaReorderBody, z.output<typeof agendaReorderBodySchema>>,
  Assignable<LiveStateBody, z.output<typeof liveStateBodySchema>>,
  Assignable<LiveScrollBody, z.output<typeof liveScrollBodySchema>>,
  Assignable<LivePointerBody, z.output<typeof livePointerBodySchema>>,
  Assignable<LiveTallyBody, z.output<typeof liveTallyBodySchema>>,
  Assignable<
    ProjectionControlBody,
    z.output<typeof projectionControlBodySchema>
  >,
];
