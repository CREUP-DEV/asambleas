import { CalendarDateTime } from "@internationalized/date";
import { describe, expect, it } from "vitest";
import {
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

  it("uses the largest unit by default", () => {
    expect(formatRelative(in35Days, { locale: "es", now })).toBe(
      "el próximo mes",
    );
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
    const soon = new Date(now.getTime() + 5 * 3_600_000);
    expect(formatRelative(soon, { locale: "en", now, maxUnit: "day" })).toBe(
      "in 5 hours",
    );
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
