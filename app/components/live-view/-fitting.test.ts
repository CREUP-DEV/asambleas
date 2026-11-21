import { describe, expect, it } from "vitest";
import { fittingCount, PROJECTION_SPEAKERS_MAX } from "./-model";

// Chips of 60 px with gaps of 10: they end at 60, 130, 200, 270, 340.
const chips = [60, 60, 60, 60, 60];

describe("fittingCount (the projection's queue on one line)", () => {
  it("shows every chip, without the label, when all fit and none is left out", () => {
    expect(fittingCount(chips, 10, 340, 80)).toBe(5);
    expect(fittingCount(chips, 10, 340, 80, 5)).toBe(5);
  });

  it("leaves room for «y N más» when the chips do not all fit", () => {
    // 270 + 10 + 80 = 360 > 339; 200 + 10 + 80 = 290 fits.
    expect(fittingCount(chips, 10, 339, 80)).toBe(3);
  });

  it("keeps the label when the list was cut before (more waiting turns)", () => {
    // All five fit (340), but a sixth turn waits: the label must follow.
    expect(fittingCount(chips, 10, 340, 80, 6)).toBe(3);
    expect(fittingCount(chips, 10, 1000, 80, 12)).toBe(5);
  });

  it("never shows fewer than one chip, however narrow the row", () => {
    expect(fittingCount(chips, 10, 20, 80)).toBe(1);
    expect(fittingCount([500], 10, 100, 80)).toBe(1);
  });

  it("shows nothing when nobody waits", () => {
    expect(fittingCount([], 10, 500, 80, 0)).toBe(0);
  });

  it("absorbs half a pixel of rounding", () => {
    expect(fittingCount(chips, 10, 339.6, 80)).toBe(5);
  });

  it("caps the band at ten waiting turns", () => {
    expect(PROJECTION_SPEAKERS_MAX).toBe(10);
  });
});
