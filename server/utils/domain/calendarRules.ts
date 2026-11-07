import { and, eq } from "drizzle-orm";
import { createError, type H3Event } from "h3";
import { db } from "../../db";
import { calendarRules } from "../../db/schema";
import type { Executor } from "./events";
import { recordAudit } from "./audit";
import type { Actor } from "./actor";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import {
  ALL_ASSEMBLY_TYPES,
  type AssemblyType,
} from "~~/shared/constants/assemblyTypes";
import { INITIAL_CALENDAR_RULES } from "~~/shared/constants/calendarRules";
import type { CalendarRulesDto } from "~~/shared/types/api";
import type { CalendarRules } from "~~/shared/utils/calendar";
import {
  calendarRulesSchema,
  normalizeCalendarRules,
} from "~~/shared/utils/schemas/calendarRules";
import {
  assertOptimisticLock,
  buildOptimisticLockCondition,
} from "../optimisticLock";

/**
 * The calendar rules of each assembly type (`calendar_rules`). The stored
 * row rules; INITIAL_CALENDAR_RULES only stands in, with a warning, while a
 * type has no row yet (a database migrated but never seeded).
 */

type RulesRow = typeof calendarRules.$inferSelect;

const warnedMissing = new Set<AssemblyType>();

function storedRules(row: RulesRow): CalendarRules {
  // The jsonb was validated on write; parse again so a hand-edited row
  // never reaches the calendar check half-formed.
  const parsed = calendarRulesSchema.safeParse(row.rules);
  if (parsed.success) return parsed.data;
  console.warn(
    `[calendar-rules] Stored rules of ${row.type} are invalid; using the initial ones.`,
  );
  return INITIAL_CALENDAR_RULES[row.type];
}

function toDto(
  type: AssemblyType,
  row: RulesRow | undefined,
): CalendarRulesDto {
  if (!row) {
    if (!warnedMissing.has(type)) {
      warnedMissing.add(type);
      console.warn(
        `[calendar-rules] No stored rules for ${type}; using the initial ones until \`pnpm db:seed\` runs.`,
      );
    }
    return {
      type,
      rules: INITIAL_CALENDAR_RULES[type],
      updatedAt: null,
      stored: false,
    };
  }
  return {
    type,
    rules: storedRules(row),
    updatedAt: row.updatedAt.toISOString(),
    stored: true,
  };
}

/** The rules of every assembly type, in ALL_ASSEMBLY_TYPES order. */
export async function listCalendarRules(
  executor: Executor = db,
): Promise<CalendarRulesDto[]> {
  const rows = await executor.select().from(calendarRules);
  const byType = new Map(rows.map((row) => [row.type, row]));
  return ALL_ASSEMBLY_TYPES.map((type) => toDto(type, byType.get(type)));
}

/** The rules of one assembly type. */
export async function loadCalendarRules(
  type: AssemblyType,
  executor: Executor = db,
): Promise<CalendarRules> {
  const [row] = await executor
    .select()
    .from(calendarRules)
    .where(eq(calendarRules.type, type));
  return toDto(type, row).rules;
}

/**
 * Replaces the rules of a type (PUT /api/calendar-rules/[type]). The row
 * must exist and still carry the `updatedAt` the client read (409
 * otherwise). Writes `calendar_rules.update` with the rules before and
 * after, unless nothing changed.
 */
export async function updateCalendarRules(input: {
  event: H3Event;
  actor: Actor;
  type: AssemblyType;
  rules: CalendarRules;
  updatedAt: string;
}): Promise<CalendarRulesDto> {
  const next = normalizeCalendarRules(input.rules);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(calendarRules)
      .where(eq(calendarRules.type, input.type))
      .for("update");
    if (!current) {
      throw createError({
        statusCode: 409,
        message:
          "Las reglas del calendario de este tipo aún no están guardadas: ejecuta pnpm db:seed",
        data: { messageKey: "admin.calendarRules.notStored" },
      });
    }
    const conflict =
      "Otra persona ha cambiado las reglas del calendario. Recarga la página.";
    assertOptimisticLock(input.updatedAt, current.updatedAt, conflict);

    const before = normalizeCalendarRules(storedRules(current));
    const [updated] = await tx
      .update(calendarRules)
      .set({ rules: next })
      .where(
        and(
          eq(calendarRules.id, current.id),
          buildOptimisticLockCondition(
            calendarRules.updatedAt,
            input.updatedAt,
          ),
        ),
      )
      .returning();
    if (!updated) throw createError({ statusCode: 409, message: conflict });

    await recordAudit(tx, {
      event: input.event,
      actor: input.actor,
      action: AUDIT_ACTIONS.CALENDAR_RULES_UPDATE,
      targetType: "calendar_rules",
      targetId: input.type,
      before: { rules: before },
      after: { rules: next },
    });
    return toDto(input.type, updated);
  });
}
