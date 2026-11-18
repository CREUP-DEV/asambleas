import { describe, expect, it } from "vitest";
import { turnClock } from "./turnClock";

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
