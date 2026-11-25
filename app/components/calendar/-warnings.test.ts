import { describe, expect, it } from "vitest";
import { warnedMilestoneKeys } from "./-warnings";

describe("warnedMilestoneKeys", () => {
  it("is empty without warnings", () => {
    expect(warnedMilestoneKeys([])).toEqual([]);
  });

  it("lists every milestone once, in the order it first appears", () => {
    expect(
      warnedMilestoneKeys([
        { keys: ["amendments_open", "documents_publish"] },
        { keys: ["convocation", "documents_publish"] },
        { keys: ["amendments_open", "amendments_close"] },
      ]),
    ).toEqual([
      "amendments_open",
      "documents_publish",
      "convocation",
      "amendments_close",
    ]);
  });
});
