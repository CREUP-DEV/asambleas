import { describe, expect, it } from "vitest";
import { datedCountdown } from "./-countdown";

const HOUR = 3_600_000;
// 23:59 on Tuesday 17 November 2026 in Madrid.
const deadline = new Date("2026-11-17T22:59:00.000Z");
const before = (hours: number) => new Date(deadline.getTime() - hours * HOUR);

describe("datedCountdown", () => {
  it("counts down and gives the time today", () => {
    expect(datedCountdown(deadline, { now: before(5), locale: "es" })).toEqual({
      key: "common.countdown.relativeAt",
      params: { relative: "dentro de 5 horas", time: "23:59" },
    });
  });

  it.each([5 + 24, 40, 47])(
    "says tomorrow and the time %i hours before, on the day before",
    (hours) => {
      expect(
        datedCountdown(deadline, { now: before(hours), locale: "es" }),
      ).toEqual({
        key: "common.countdown.tomorrowAt",
        params: { time: "23:59" },
      });
    },
  );

  it("says tomorrow when fewer than 24 hours are left across midnight", () => {
    // 10:00 on Wednesday, seen at 18:00 on Tuesday.
    const morning = new Date("2026-11-18T09:00:00.000Z");
    expect(datedCountdown(morning, { now: before(5), locale: "en" })).toEqual({
      key: "common.countdown.tomorrowAt",
      params: { time: "10:00" },
    });
  });

  it("gives the date further on", () => {
    expect(datedCountdown(deadline, { now: before(52), locale: "es" })).toEqual(
      {
        key: "common.countdown.relativeOn",
        params: { relative: "pasado mañana", date: "17 nov", time: "23:59" },
      },
    );
    expect(
      datedCountdown(deadline, {
        now: before(24 * 20),
        locale: "en",
        maxUnit: "day",
      }),
    ).toEqual({
      key: "common.countdown.relativeOn",
      params: { relative: "in 20 days", date: "17 Nov", time: "23:59" },
    });
  });

  it("leaves a past or missing date to the plain wording", () => {
    expect(datedCountdown(deadline, { now: deadline })).toBeNull();
    expect(
      datedCountdown(deadline, { now: new Date(deadline.getTime() + HOUR) }),
    ).toBeNull();
    expect(datedCountdown(null, { now: before(5) })).toBeNull();
  });
});
