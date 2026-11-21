import { describe, expect, it } from "vitest";
import { turnClock, turnClockReserve } from "./turnClock";

describe("turnClock", () => {
  it("counts the time spoken without a limit", () => {
    expect(turnClock(151, null)).toEqual({
      text: "2:31",
      overtime: false,
      remaining: null,
    });
  });

  it("counts down to the limit, zero included", () => {
    expect(turnClock(42, 180)).toMatchObject({ text: "2:18", overtime: false });
    expect(turnClock(180, 180)).toMatchObject({
      text: "0:00",
      overtime: false,
      remaining: 0,
    });
  });

  it("counts the time over the limit, signed", () => {
    expect(turnClock(192, 180)).toEqual({
      text: "+0:12",
      overtime: true,
      remaining: -12,
    });
  });
});

describe("turnClockReserve", () => {
  it("reserves two digits of minutes without a limit", () => {
    expect(turnClockReserve(null)).toBe("00:00");
    expect(turnClockReserve(0)).toBe("00:00");
  });

  it("reserves the limit's shape, signed, with a limit", () => {
    expect(turnClockReserve(180)).toBe("+0:00");
    expect(turnClockReserve(600)).toBe("+00:00");
    expect(turnClockReserve(3600)).toBe("+0:00:00");
  });

  it("is never narrower than the countdown nor the time over below the limit", () => {
    const shape = (text: string) => text.replace(/\d/g, "0");
    const reserve = turnClockReserve(180);
    for (const elapsed of [0, 59, 180, 181, 359]) {
      expect(shape(turnClock(elapsed, 180).text).length).toBeLessThanOrEqual(
        reserve.length,
      );
    }
  });
});
