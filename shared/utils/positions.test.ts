import { describe, expect, it } from "vitest";
import { positionsArePublic, positionsUnpublishable } from "./positions";

const reserved = { positionsPublishedAt: null, positionsDebateStartedAt: null };
const published = { ...reserved, positionsPublishedAt: "2026-11-18T10:00Z" };
const debated = { ...reserved, positionsDebateStartedAt: "2026-11-19T10:00Z" };
const both = { ...published, positionsDebateStartedAt: "2026-11-19T10:00Z" };

describe("positionsArePublic", () => {
  it("is public once published or once the debate started", () => {
    expect(positionsArePublic(reserved)).toBe(false);
    expect(positionsArePublic(published)).toBe(true);
    expect(positionsArePublic(debated)).toBe(true);
    expect(positionsArePublic(both)).toBe(true);
  });
});

describe("positionsUnpublishable", () => {
  it("takes back only what was published, and only before the debate", () => {
    expect(positionsUnpublishable(reserved)).toBe(false);
    expect(positionsUnpublishable(published)).toBe(true);
    expect(positionsUnpublishable(debated)).toBe(false);
    expect(positionsUnpublishable(both)).toBe(false);
  });
});
