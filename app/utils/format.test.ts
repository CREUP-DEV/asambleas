import { CalendarDateTime } from "@internationalized/date";
import { describe, expect, it } from "vitest";
import {
  formatDayMonth,
  formatMoment,
  formatRelative,
  fromAppWallTime,
  memberLabel,
  memberNameRepeatsAcronym,
  toAppWallTime,
} from "./format";

const DAY = 24 * 3_600_000;

describe("formatRelative", () => {
  const now = new Date("2026-11-05T09:00:00.000Z");
  const in35Days = new Date(now.getTime() + 35 * DAY);
  const HOUR = 3_600_000;

  it("uses the largest unit by default, counted in whole units", () => {
    expect(formatRelative(in35Days, { locale: "es", now })).toBe(
      "dentro de 1 mes",
    );
    expect(
      formatRelative(new Date(now.getTime() + 20 * DAY), {
        locale: "es",
        now,
      }),
    ).toBe("dentro de 2 semanas");
    expect(
      formatRelative(new Date(now.getTime() - 400 * DAY), {
        locale: "en",
        now,
      }),
    ).toBe("1 year ago");
  });

  it("counts days, not weeks, below two weeks", () => {
    // Rounding 11 days gave "dentro de 2 semanas", more time than is left.
    expect(
      formatRelative(new Date(now.getTime() + 11 * DAY), {
        locale: "es",
        now,
      }),
    ).toBe("dentro de 11 días");
  });

  it("counts days with maxUnit day", () => {
    expect(
      formatRelative(in35Days, { locale: "es", now, maxUnit: "day" }),
    ).toBe("dentro de 35 días");
    expect(
      formatRelative(in35Days, { locale: "en", now, maxUnit: "day" }),
    ).toBe("in 35 days");
  });

  it("still uses hours below a day with maxUnit day", () => {
    const soon = new Date(now.getTime() + 5 * HOUR);
    expect(formatRelative(soon, { locale: "en", now, maxUnit: "day" })).toBe(
      "in 5 hours",
    );
  });

  describe("a deadline at 23:59 in Madrid (22:59 UTC in November)", () => {
    const deadline = new Date("2026-11-17T22:59:00.000Z");
    const before = (hours: number) =>
      new Date(deadline.getTime() - hours * HOUR);

    it.each([36, 40, 47])(
      "reads tomorrow %i hours before, on the day before",
      (hours) => {
        expect(
          formatRelative(deadline, { locale: "es", now: before(hours) }),
        ).toBe("mañana");
        expect(
          formatRelative(deadline, { locale: "en", now: before(hours) }),
        ).toBe("tomorrow");
      },
    );

    it.each([48, 52, 59])(
      "reads the day after tomorrow %i hours before, two days before",
      (hours) => {
        expect(
          formatRelative(deadline, { locale: "es", now: before(hours) }),
        ).toBe("pasado mañana");
      },
    );

    it("reads in days, not weeks, with maxUnit day", () => {
      expect(
        formatRelative(deadline, {
          locale: "es",
          now: before(40),
          maxUnit: "day",
        }),
      ).toBe("mañana");
    });

    it("counts hours, truncated, within a day", () => {
      expect(
        formatRelative(deadline, { locale: "es", now: before(23.9) }),
      ).toBe("dentro de 23 horas");
      expect(formatRelative(deadline, { locale: "es", now: before(0.5) })).toBe(
        "dentro de 30 minutos",
      );
    });
  });

  it("counts hours for an earlier time the same day, never today", () => {
    // 09:00 seen at 18:00, Madrid time.
    const morning = new Date("2026-11-17T08:00:00.000Z");
    const evening = new Date("2026-11-17T17:00:00.000Z");
    expect(formatRelative(morning, { locale: "es", now: evening })).toBe(
      "hace 9 horas",
    );
    expect(formatRelative(morning, { locale: "en", now: evening })).toBe(
      "9 hours ago",
    );
  });

  it("counts calendar days in the past too", () => {
    // 23:00 two days before, seen at 09:00: 34 hours, two days back.
    const at = new Date("2026-11-15T22:00:00.000Z");
    const seen = new Date("2026-11-17T08:00:00.000Z");
    expect(formatRelative(at, { locale: "es", now: seen })).toBe("anteayer");
  });

  it("stays in hours on the day the clocks go back", () => {
    // 25 October 2026: 00:30 to 23:30 Madrid time is 24 hours, the same day.
    const start = new Date("2026-10-24T22:30:00.000Z");
    const end = new Date("2026-10-25T22:30:00.000Z");
    expect(formatRelative(end, { locale: "en", now: start })).toBe(
      "in 24 hours",
    );
  });
});

describe("formatDayMonth", () => {
  const now = new Date("2026-11-12T10:00:00.000Z");

  it("leaves the year out within the same year", () => {
    expect(
      formatDayMonth(new Date("2026-11-19T22:59:00.000Z"), {
        locale: "es",
        now,
      }),
    ).toBe("19 nov");
    expect(
      formatDayMonth(new Date("2026-11-19T22:59:00.000Z"), {
        locale: "en",
        now,
      }),
    ).toBe("19 Nov");
  });

  it("names the year of another year, in Madrid time", () => {
    // 23:30 UTC on 31 December is already 1 January in Madrid.
    expect(
      formatDayMonth(new Date("2026-12-31T23:30:00.000Z"), {
        locale: "es",
        now,
      }),
    ).toBe("1 ene 2027");
  });
});

describe("app wall time", () => {
  it("shows an instant as Madrid wall time", () => {
    // 13 Oct 2026 08:00 UTC is 10:00 CEST.
    const value = toAppWallTime("2026-10-13T08:00:00.000Z");
    expect(value?.toString()).toBe("2026-10-13T10:00:00");
    // 12 Nov 2026 09:00 UTC is 10:00 CET.
    expect(toAppWallTime("2026-11-12T09:00:00.000Z")?.toString()).toBe(
      "2026-11-12T10:00:00",
    );
  });

  it("is empty for empty or invalid values", () => {
    expect(toAppWallTime(null)).toBeUndefined();
    expect(toAppWallTime("")).toBeUndefined();
    expect(toAppWallTime("not a date")).toBeUndefined();
    expect(fromAppWallTime(undefined)).toBeNull();
    expect(fromAppWallTime(null)).toBeNull();
  });

  it("turns Madrid wall time back into the same instant", () => {
    expect(fromAppWallTime(new CalendarDateTime(2026, 10, 13, 10, 0))).toBe(
      "2026-10-13T08:00:00.000Z",
    );
    expect(fromAppWallTime(new CalendarDateTime(2026, 11, 12, 10, 0))).toBe(
      "2026-11-12T09:00:00.000Z",
    );
  });
});

describe("member labels", () => {
  it("joins the acronym and the full name", () => {
    expect(memberLabel({ acronym: "PRES", name: "Presidencia" })).toBe(
      "PRES · Presidencia",
    );
  });

  it("shows the acronym alone when the name only repeats it", () => {
    expect(memberLabel({ acronym: "VDT", name: "VDT" })).toBe("VDT");
    expect(memberLabel({ acronym: "VDT", name: " vdt " })).toBe("VDT");
    expect(memberLabel({ acronym: "VDT", name: "" })).toBe("VDT");
  });

  it("tells whether the name adds anything", () => {
    expect(memberNameRepeatsAcronym({ acronym: "VDT", name: "Vdt" })).toBe(
      true,
    );
    expect(memberNameRepeatsAcronym({ acronym: "VDT", name: "   " })).toBe(
      true,
    );
    expect(
      memberNameRepeatsAcronym({ acronym: "CEUCA", name: "Consejo de UCA" }),
    ).toBe(false);
  });
});

describe("formatMoment", () => {
  // Wednesday 18 November 2026, 10:00 in Madrid.
  const now = new Date("2026-11-18T09:00:00.000Z");

  it("gives only the time today", () => {
    expect(
      formatMoment(new Date("2026-11-18T08:15:00.000Z"), { locale: "es", now }),
    ).toEqual({ text: "09:15", today: true, dayOffset: 0 });
  });

  it("says yesterday for the day before, even a few hours ago", () => {
    const moment = formatMoment(new Date("2026-11-17T17:45:00.000Z"), {
      locale: "es",
      now,
    });
    expect(moment.today).toBe(false);
    expect(moment.dayOffset).toBe(-1);
    expect(moment.text).toBe("ayer, 18:45");
  });

  it("gives the date further back", () => {
    const moment = formatMoment(new Date("2026-11-16T17:45:00.000Z"), {
      locale: "en",
      now,
    });
    expect(moment.dayOffset).toBe(-2);
    expect(moment.text).toContain("18:45");
    expect(moment.text).toContain("16");
  });
});
