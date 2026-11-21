import { describe, expect, it } from "vitest";
import { digitCells, TABULAR_DIGIT_EM } from "./-digits";

describe("digitCells", () => {
  it("marks every digit of a clock and leaves the colon alone", () => {
    expect(digitCells("2:31")).toEqual([
      { char: "2", digit: true },
      { char: ":", digit: false },
      { char: "3", digit: true },
      { char: "1", digit: true },
    ]);
  });

  it("keeps the sign of an overtime clock and the hours", () => {
    expect(
      digitCells("+1:02:03").map((cell) => (cell.digit ? "d" : cell.char)),
    ).toEqual(["+", "d", ":", "d", "d", ":", "d", "d"]);
  });

  it("returns nothing for an empty text", () => {
    expect(digitCells("")).toEqual([]);
  });

  it("splits by character, not by UTF-16 unit, and marks no other figures", () => {
    expect(digitCells("½٣𝟙").map((cell) => cell.digit)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("leaves room for the widest lining digit of the Bold face", () => {
    expect(TABULAR_DIGIT_EM).toBeGreaterThanOrEqual(0.701);
  });
});
