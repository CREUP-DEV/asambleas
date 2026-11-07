import { describe, expect, it } from "vitest";
import { INITIAL_CALENDAR_RULES } from "../../constants/calendarRules";
import {
  calendarRulesBodySchema,
  calendarRulesSchema,
  normalizeCalendarRules,
} from "./calendarRules";

describe("calendarRulesSchema", () => {
  it.each(["AGO", "AGE", "AGET"] as const)(
    "accepts the initial %s rules",
    (type) => {
      expect(
        calendarRulesSchema.safeParse(INITIAL_CALENDAR_RULES[type]).success,
      ).toBe(true);
    },
  );

  it("refuses unknown milestones, mixed units and negative amounts", () => {
    const base = INITIAL_CALENDAR_RULES.AGO;
    const bad = [
      { ...base, defaults: { nope: { days: 1 } } },
      { ...base, minimums: { convocation: { days: 1, hours: 2 } } },
      { ...base, minimums: { convocation: { days: -1 } } },
      { ...base, minimums: { convocation: { weeks: 1 } } },
      { ...base, minimums: { convocation: { months: 1.5 } } },
      { ...base, regulationWindowDays: 0 },
      { ...base, extra: true },
    ];
    for (const rules of bad) {
      expect(calendarRulesSchema.safeParse(rules).success).toBe(false);
    }
  });

  it("requires the updatedAt the client read", () => {
    expect(
      calendarRulesBodySchema.safeParse({
        rules: INITIAL_CALENDAR_RULES.AGE,
      }).success,
    ).toBe(false);
  });

  it("normalizes the milestone order so equal rules compare equal", () => {
    const rules = {
      defaults: {
        amendments_close: { days: 4 },
        convocation: { days: 15 },
      },
      minimums: {},
      regulationWindowDays: null,
    };
    expect(Object.keys(normalizeCalendarRules(rules).defaults)).toEqual([
      "convocation",
      "amendments_close",
    ]);
  });
});
