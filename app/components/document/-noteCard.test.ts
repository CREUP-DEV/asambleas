import { describe, expect, it } from "vitest";
import { NOTE_CARD, placeNoteCard } from "./-noteCard";

describe("placeNoteCard", () => {
  it("opens under the passage, at its left, where it fits", () => {
    expect(
      placeNoteCard(
        { top: 100, bottom: 120, left: 200 },
        { width: 1280, height: 800 },
      ),
    ).toEqual({ left: 200, width: 320, top: 126, maxHeight: 666 });
  });

  it("narrows to the window and never starts past its left edge at 320", () => {
    const place = placeNoteCard(
      { top: 100, bottom: 120, left: 40 },
      { width: 320, height: 640 },
    );
    expect(place.width).toBe(304);
    expect(place.left).toBe(NOTE_CARD.margin);
    expect(place.left + place.width).toBeLessThanOrEqual(320 - 8);
  });

  it("keeps the right edge in at 375", () => {
    const place = placeNoteCard(
      { top: 100, bottom: 120, left: 200 },
      { width: 375, height: 812 },
    );
    expect(place).toMatchObject({ width: 320, left: 47, top: 126 });
  });

  it("opens above a passage low in the window, measured from the bottom", () => {
    expect(
      placeNoteCard(
        { top: 580, bottom: 600, left: 16 },
        { width: 320, height: 640 },
      ),
    ).toEqual({ left: 8, width: 304, bottom: 66, maxHeight: 566 });
  });

  it("stays under the passage while the card fits there", () => {
    const place = placeNoteCard(
      { top: 480, bottom: 500, left: 16 },
      { width: 1280, height: 800 },
    );
    expect(place.top).toBe(506);
    expect(place.bottom).toBeUndefined();
  });

  it("never hands back a negative size in a tiny window", () => {
    const place = placeNoteCard(
      { top: 2, bottom: 10, left: 0 },
      { width: 10, height: 12 },
    );
    expect(place.width).toBe(0);
    expect(place.left).toBe(NOTE_CARD.margin);
    expect(place.maxHeight).toBe(0);
  });
});
