import { describe, expect, it } from "vitest";
import {
  assemblyClockKey,
  assemblyDateFormatter,
  assemblyDayKey,
  assemblyWallClock,
  assemblyYear,
  formatLongDate,
  toIntlLocale,
} from "./dates";

describe("toIntlLocale", () => {
  it("maps the app locales and leaves any other code as it is", () => {
    expect(toIntlLocale("es")).toBe("es-ES");
    expect(toIntlLocale("en")).toBe("en-GB");
    expect(toIntlLocale("fr")).toBe("fr");
  });
});

describe("formatLongDate", () => {
  it("writes the long date of each locale", () => {
    const at = new Date("2026-11-21T15:40:00Z");
    expect(formatLongDate(at, "es-ES")).toBe("21 de noviembre de 2026");
    expect(formatLongDate(at, "en-GB")).toBe("21 November 2026");
    expect(formatLongDate(at.toISOString(), "es-ES")).toBe(
      "21 de noviembre de 2026",
    );
  });

  it("takes the day in Madrid, not in UTC", () => {
    expect(formatLongDate(new Date("2026-01-05T23:30:00Z"), "en-GB")).toBe(
      "6 January 2026",
    );
  });

  it("matches Intl's long date style, as the exports wrote it", () => {
    const at = new Date("2026-03-29T00:30:00Z");
    for (const locale of ["es-ES", "en-GB"]) {
      expect(formatLongDate(at, locale)).toBe(
        new Intl.DateTimeFormat(locale, {
          timeZone: "Europe/Madrid",
          dateStyle: "long",
        }).format(at),
      );
    }
  });
});

describe("assemblyDateFormatter", () => {
  it("reuses one formatter per locale and options", () => {
    const options = { hour: "2-digit", minute: "2-digit" } as const;
    expect(assemblyDateFormatter("es-ES", options)).toBe(
      assemblyDateFormatter("es-ES", { ...options }),
    );
    expect(assemblyDateFormatter("es-ES", options)).not.toBe(
      assemblyDateFormatter("en-GB", options),
    );
  });
});

describe("assemblyYear", () => {
  it("is the year in Madrid", () => {
    expect(assemblyYear(new Date("2025-12-31T23:30:00Z"))).toBe("2026");
    expect(assemblyYear(new Date("2025-12-31T22:30:00Z"))).toBe("2025");
  });
});

describe("assemblyDayKey and assemblyClockKey", () => {
  it("give the Madrid day and time, zero-padded", () => {
    const at = new Date("2026-01-05T23:05:00Z");
    expect(assemblyDayKey(at)).toBe("2026-01-06");
    expect(assemblyClockKey(at)).toBe("0005");
    expect(assemblyWallClock(at)).toEqual({
      year: 2026,
      month: 1,
      day: 6,
      hour: 0,
      minute: 5,
    });
  });

  it("follow the clock change", () => {
    // Summer time (UTC+2) until 25 October 2026 at 03:00, then UTC+1.
    expect(assemblyDayKey(new Date("2026-10-24T22:30:00Z"))).toBe("2026-10-25");
    expect(assemblyClockKey(new Date("2026-10-24T22:30:00Z"))).toBe("0030");
    expect(assemblyDayKey(new Date("2026-10-25T22:30:00Z"))).toBe("2026-10-25");
    expect(assemblyClockKey(new Date("2026-10-25T22:30:00Z"))).toBe("2330");
  });

  it("match the en-CA day the exports used", () => {
    const at = new Date("2026-11-21T15:40:00Z");
    expect(assemblyDayKey(at)).toBe(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Madrid",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(at),
    );
  });
});
