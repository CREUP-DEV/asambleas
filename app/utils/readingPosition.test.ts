import { describe, expect, it } from "vitest";
import { amendStartBlockId, isScrolledIntoText } from "./readingPosition";

describe("isScrolledIntoText", () => {
  it("is false while the text's start is still in view", () => {
    // The page scrolls: its top is the window's.
    expect(isScrolledIntoText(120, null)).toBe(false);
    expect(isScrolledIntoText(0, null)).toBe(false);
    // A panel below a header: the text starts at the panel's top.
    expect(isScrolledIntoText(64, 64)).toBe(false);
  });

  it("allows a few pixels above the top before counting", () => {
    expect(isScrolledIntoText(-8, null)).toBe(false);
    expect(isScrolledIntoText(-9, null)).toBe(true);
    expect(isScrolledIntoText(56, 64)).toBe(false);
    expect(isScrolledIntoText(55, 64)).toBe(true);
  });

  it("counts from the window's top when the scrolling area starts above it", () => {
    // The area's top is off screen: only the window's top edge matters.
    expect(isScrolledIntoText(-5, -200)).toBe(false);
    expect(isScrolledIntoText(-20, -200)).toBe(true);
  });
});

describe("amendStartBlockId", () => {
  it("starts at the selection, wherever the reader is", () => {
    expect(
      amendStartBlockId({
        selected: "b40",
        current: "b1",
        lastRead: "b25",
        atHeader: true,
      }),
    ).toBe("b40");
  });

  it("starts at the last paragraph read when the reader went back up to the header", () => {
    // A phone: the text scrolls with the page, so at the header the first
    // paragraph in view is the text's first one.
    expect(
      amendStartBlockId({
        selected: null,
        current: "b1",
        lastRead: "b25",
        atHeader: true,
      }),
    ).toBe("b25");
  });

  it("starts at the paragraph on top while the reader is inside the text", () => {
    expect(
      amendStartBlockId({
        selected: null,
        current: "b30",
        lastRead: "b25",
        atHeader: false,
      }),
    ).toBe("b30");
  });

  it("keeps the start of a text scrolled to its top in a box of its own", () => {
    // A wide screen: the text's panel scrolls on its own and the header
    // stays above it, so a panel at its top is the reader's choice.
    expect(
      amendStartBlockId({
        selected: null,
        current: "b1",
        lastRead: "b25",
        atHeader: false,
      }),
    ).toBe("b1");
  });

  it("starts at the paragraph on top when nothing was read yet", () => {
    expect(
      amendStartBlockId({
        selected: null,
        current: "b1",
        lastRead: null,
        atHeader: true,
      }),
    ).toBe("b1");
  });

  it("falls back to the last paragraph read when the text is not on screen", () => {
    expect(
      amendStartBlockId({
        selected: null,
        current: null,
        lastRead: "b25",
        atHeader: false,
      }),
    ).toBe("b25");
    expect(
      amendStartBlockId({
        selected: null,
        current: null,
        lastRead: null,
        atHeader: false,
      }),
    ).toBeNull();
  });
});
