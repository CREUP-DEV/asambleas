import { z } from "zod/v4";
import { MILESTONE_KEYS, type MilestoneKey } from "../../constants/domain";
import type { CalendarRulesBody } from "../../types/api";
import type { CalendarRules, MilestoneOffset } from "../calendar";

/**
 * The calendar rules of an assembly type (docs/api.md, "Calendar rules"):
 * what PUT /api/calendar-rules/[type] accepts and what the stored jsonb must
 * hold. Strict objects, so a typo in a key is refused rather than ignored.
 */

/** Longest offset accepted, in each unit: a year before the start. */
export const OFFSET_MAX = { days: 366, hours: 24 * 366, months: 12 } as const;
/** Longest regulation amendment window, in days. */
export const REGULATION_WINDOW_MAX_DAYS = 366;

const amount = (max: number) => z.number().int().min(0).max(max);

export const milestoneOffsetSchema = z.union([
  z.strictObject({ days: amount(OFFSET_MAX.days) }),
  z.strictObject({ hours: amount(OFFSET_MAX.hours) }),
  z.strictObject({ months: amount(OFFSET_MAX.months) }),
]);

const offsetsByMilestone = z
  .record(z.string(), milestoneOffsetSchema)
  .refine(
    (offsets) =>
      Object.keys(offsets).every((key) =>
        (MILESTONE_KEYS as readonly string[]).includes(key),
      ),
    { message: "unknown_milestone" },
  )
  .transform(
    (offsets) => offsets as Partial<Record<MilestoneKey, MilestoneOffset>>,
  );

export const calendarRulesSchema = z.strictObject({
  defaults: offsetsByMilestone,
  minimums: offsetsByMilestone,
  regulationWindowDays: z
    .number()
    .int()
    .min(1)
    .max(REGULATION_WINDOW_MAX_DAYS)
    .nullable(),
});

export const calendarRulesBodySchema = z.strictObject({
  rules: calendarRulesSchema,
  /** The `updatedAt` the client read (optimistic locking); null: no row yet. */
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});

/**
 * The rules in a canonical order (milestones in MILESTONE_KEYS order), so
 * two equal sets of rules compare equal in the audit log.
 */
export function normalizeCalendarRules(rules: CalendarRules): CalendarRules {
  const ordered = (offsets: Partial<Record<MilestoneKey, MilestoneOffset>>) =>
    Object.fromEntries(
      MILESTONE_KEYS.flatMap((key) => {
        const offset = offsets[key];
        return offset ? [[key, offset]] : [];
      }),
    ) as Partial<Record<MilestoneKey, MilestoneOffset>>;
  return {
    defaults: ordered(rules.defaults),
    minimums: ordered(rules.minimums),
    regulationWindowDays: rules.regulationWindowDays,
  };
}

// Compile-time checks: every parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _CalendarRulesSchemaChecks = [
  Assignable<CalendarRules, z.output<typeof calendarRulesSchema>>,
  Assignable<CalendarRulesBody, z.output<typeof calendarRulesBodySchema>>,
];
