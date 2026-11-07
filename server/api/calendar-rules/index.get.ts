import { defineEventHandler } from "h3";
import { CALENDAR_RULES_PERMISSION } from "~~/shared/constants/calendarRules";
import type { CalendarRulesDto } from "~~/shared/types/api";
import { requireActor, requireCan } from "../../utils/domain/actor";
import { listCalendarRules } from "../../utils/domain/calendarRules";

/** The calendar rules of every assembly type (CALENDAR_RULES_PERMISSION). */
export default defineEventHandler(
  async (event): Promise<CalendarRulesDto[]> => {
    const actor = await requireActor(event);
    requireCan(actor, CALENDAR_RULES_PERMISSION);
    return listCalendarRules();
  },
);
