import { z } from "zod/v4";
import { ALL_ASSEMBLY_TYPES } from "../../constants/assemblyTypes";
import type { AssemblyType } from "../../constants/assemblyTypes";
import { ASSEMBLY_STATUSES, MILESTONE_KEYS } from "../../constants/domain";
import type {
  AgendaItemBody,
  AgendaReorderBody,
  AssemblyCreateBody,
  AssemblyStatusBody,
  AssemblyUpdateBody,
  CalendarBody,
  LiveStateBody,
} from "../../types/api";
import { normalizeText } from "./content";

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
export const MILESTONE_NOTE_MAX_LENGTH = 500;
export const ASSEMBLY_LIST_PAGE_SIZE = 20;

const assemblyIdPattern = /^[a-z0-9]{20,32}$/;
const assemblyEntityId = z.string().regex(assemblyIdPattern);
const isoDateTime = z.iso.datetime({ offset: true });
const assemblyTypeSchema = z.enum(ALL_ASSEMBLY_TYPES as [AssemblyType, ...AssemblyType[]]);

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

const endAfterStart = <T extends { startDate?: string; endDate?: string }>(body: T) =>
  !body.startDate || !body.endDate || new Date(body.endDate) >= new Date(body.startDate);

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
    amendmentVisibility: z.enum(["immediate", "after_close"]),
    positionVisibility: z.enum(["mesa", "session", "public"]),
    acceptedAmendments: z.enum(["assent", "vote"]),
    tieRule: z.enum(["rejected", "repeat"]),
    denominator: z.enum(["valid_votes", "present"]),
  })
  .partial();

export const assemblyUpdateBodySchema = z
  .object({
    number: z.number().int().min(1).max(9_999).optional(),
    type: assemblyTypeSchema.optional(),
    startDate: isoDateTime.optional(),
    endDate: isoDateTime.optional(),
    location: singleLine(ASSEMBLY_LOCATION_MAX_LENGTH).optional(),
    convocationIntro: multiLine(CONVOCATION_INTRO_MAX_LENGTH).nullable().optional(),
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
      (milestones) => new Set(milestones.map((milestone) => milestone.key)).size === milestones.length,
      { message: "duplicate_milestone" },
    ),
  agendaFinal: z.boolean().optional(),
});

export const assemblyListQuerySchema = z.object({
  status: z.enum(ASSEMBLY_STATUSES).optional(),
  type: assemblyTypeSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

// Agenda -----------------------------------------------------------------

export const agendaItemBodySchema = z.object({
  parentId: assemblyEntityId.nullable().optional(),
  title: singleLine(AGENDA_TITLE_MAX_LENGTH),
  description: multiLine(AGENDA_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  acceptsSubmissions: z.boolean().optional(),
  updatedAt: isoDateTime.optional(),
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
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
      message: "duplicate_id",
    }),
});

// Live session -----------------------------------------------------------

export const liveStateBodySchema = z.object({
  agendaItemId: assemblyEntityId.nullable().optional(),
  documentId: assemblyEntityId.nullable().optional(),
  amendmentId: assemblyEntityId.nullable().optional(),
  voteId: assemblyEntityId.nullable().optional(),
  message: multiLine(LIVE_MESSAGE_MAX_LENGTH).nullable().optional(),
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
];
