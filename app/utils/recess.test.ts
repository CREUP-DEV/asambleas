import { describe, expect, it } from "vitest";
import { recessTimeOf, recessUntilFromTime } from "./recess";

describe("recessUntilFromTime", () => {
  // 16:20 in Madrid (UTC+1 in November).
  const now = new Date("2026-11-18T15:20:00.000Z");

  it("reads the time as today in Madrid", () => {
    expect(recessUntilFromTime("17:30", now)).toBe("2026-11-18T16:30:00.000Z");
    expect(
      recessUntilFromTime(" 9:05 ", new Date("2026-11-18T07:00:00Z")),
    ).toBe("2026-11-18T08:05:00.000Z");
  });

  it("moves a time already past to tomorrow", () => {
    expect(recessUntilFromTime("16:00", now)).toBe("2026-11-19T15:00:00.000Z");
    expect(recessUntilFromTime("16:20", now)).toBe("2026-11-19T15:20:00.000Z");
  });

  it("is null for nothing or a malformed time", () => {
    for (const value of [null, undefined, "", "17", "25:00", "17:60", "x:y"]) {
      expect(recessUntilFromTime(value, now)).toBeNull();
    }
  });
});

describe("recessTimeOf", () => {
  it("gives the Madrid time of an instant", () => {
    expect(recessTimeOf("2026-11-18T16:30:00.000Z")).toBe("17:30");
    expect(recessTimeOf(null)).toBe("");
  });
});
