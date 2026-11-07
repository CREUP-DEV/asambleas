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
 * type has no row yet (a database migrated but neither seeded nor saved
 * from the admin page).
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
        `[calendar-rules] No stored rules for ${type}; using the initial ones until they are seeded or saved.`,
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
 * Replaces the rules of a type (PUT /api/calendar-rules/[type]) and returns
 * them. The client sends the `updatedAt` it read: the stored row's, or null
 * while the type has none, and then this call stores the first row (so a
 * deploy without `pnpm db:seed` still lets managers save). Any mismatch, or
 * a row that appeared in the meantime, is a 409. Writes
 * `calendar_rules.update` with the rules before (the initial ones when
 * there was no row) and after; an unchanged update writes nothing.
 */
export async function updateCalendarRules(input: {
  event: H3Event;
  actor: Actor;
  type: AssemblyType;
  rules: CalendarRules;
  updatedAt: string | null;
}): Promise<CalendarRulesDto> {
  const next = normalizeCalendarRules(input.rules);
  const conflict =
    "Otra persona ha cambiado las reglas del calendario. Recarga la página.";
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(calendarRules)
      .where(eq(calendarRules.type, input.type))
      .for("update");

    let saved: RulesRow | undefined;
    let before: CalendarRules;
    if (!current) {
      if (input.updatedAt !== null) {
        throw createError({ statusCode: 409, message: conflict });
      }
      before = normalizeCalendarRules(INITIAL_CALENDAR_RULES[input.type]);
      [saved] = await tx
        .insert(calendarRules)
        .values({ type: input.type, rules: next })
        .onConflictDoNothing({ target: calendarRules.type })
        .returning();
    } else {
      if (input.updatedAt === null) {
        throw createError({ statusCode: 409, message: conflict });
      }
      assertOptimisticLock(input.updatedAt, current.updatedAt, conflict);
      before = normalizeCalendarRules(storedRules(current));
      [saved] = await tx
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
    }
    if (!saved) throw createError({ statusCode: 409, message: conflict });

    await recordAudit(tx, {
      event: input.event,
      actor: input.actor,
      action: AUDIT_ACTIONS.CALENDAR_RULES_UPDATE,
      targetType: "calendar_rules",
      targetId: input.type,
      before: { rules: before },
      after: { rules: next },
      // Storing the first row is a change even when it keeps the values.
      recordUnchanged: !current,
    });
    return toDto(input.type, saved);
  });
}
