import { describe, expect, it } from "vitest";
import { defaultAdjournChoice } from "./adjourn";

describe("defaultAdjournChoice", () => {
  const end = "2026-11-22T14:00:00.000Z";
  const at = (iso: string) => new Date(iso).getTime();

  it("resumes later while the end is more than an hour away", () => {
    expect(defaultAdjournChoice(end, at("2026-11-21T19:00:00.000Z"))).toBe(
      "resume",
    );
    expect(defaultAdjournChoice(end, at("2026-11-22T12:59:59.000Z"))).toBe(
      "resume",
    );
  });

  it("finishes within the last hour and once the end is past", () => {
    expect(defaultAdjournChoice(end, at("2026-11-22T13:00:00.000Z"))).toBe(
      "finish",
    );
    expect(defaultAdjournChoice(end, at("2026-11-23T09:00:00.000Z"))).toBe(
      "finish",
    );
  });

  it("resumes when the end is unknown", () => {
    expect(defaultAdjournChoice(null)).toBe("resume");
    expect(defaultAdjournChoice("nonsense")).toBe("resume");
  });
});
