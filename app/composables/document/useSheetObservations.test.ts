import { describe, expect, it } from "vitest";
import { affectsSheetObservations } from "./useSheetObservations";

describe("affectsSheetObservations", () => {
  it("fetches the observations again when someone writes them", () => {
    expect(
      affectsSheetObservations([
        { type: "control_sheet_observations_updated" },
      ]),
    ).toBe(true);
    expect(affectsSheetObservations([{ type: "poll" }])).toBe(true);
    expect(
      affectsSheetObservations([
        { type: "speaking_turn_added" },
        { type: "control_sheet_observations_updated" },
      ]),
    ).toBe(true);
  });

  it("never for the rest of the sheet, which they do not carry", () => {
    for (const type of [
      "control_sheet_treated_changed",
      "control_sheet_listed_changed",
      "control_sheet_result_changed",
      "vote_recorded",
      "amendment_approved",
      "speaking_turn_added",
      "live_changed",
    ]) {
      expect(affectsSheetObservations([{ type }])).toBe(false);
    }
    expect(affectsSheetObservations([])).toBe(false);
  });
});
