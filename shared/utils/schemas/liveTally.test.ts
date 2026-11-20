import { describe, expect, it } from "vitest";
import { liveTallyBodySchema } from "./assembly";

const itemId = "i".padEnd(24, "0");

const announcement = {
  subject: { type: "agenda_item", id: itemId },
  question: "  ¿Se aprueba la propuesta?  ",
  method: "secret",
  reveal: "live",
  counts: { inFavor: 3, against: 1, blank: 0, invalid: 0 },
  present: 20,
  majority: "simple",
};

describe("liveTallyBodySchema", () => {
  it("takes a secret vote's announcement with its running count", () => {
    const parsed = liveTallyBodySchema.parse({ tally: announcement });
    expect(parsed.tally).toEqual({
      ...announcement,
      question: "¿Se aprueba la propuesta?",
    });
  });

  it("takes one shown only at the end, without counts nor subject", () => {
    const parsed = liveTallyBodySchema.parse({
      tally: {
        ...announcement,
        subject: { type: "decision", id: null },
        question: "   ",
        reveal: "end",
        counts: null,
      },
    });
    expect(parsed.tally?.counts).toBeNull();
    expect(parsed.tally?.question).toBeNull();
    expect(parsed.tally?.subject).toEqual({ type: "decision", id: null });
  });

  it("takes null to end it", () => {
    expect(liveTallyBodySchema.parse({ tally: null })).toEqual({ tally: null });
  });

  it("refuses an unknown mode, a bad id or a negative count", () => {
    for (const tally of [
      { ...announcement, reveal: "now" },
      { ...announcement, subject: { type: "amendment", id: "x y" } },
      {
        ...announcement,
        counts: { inFavor: -1, against: 0, blank: 0, invalid: 0 },
      },
      { ...announcement, question: "x".repeat(501) },
    ]) {
      expect(liveTallyBodySchema.safeParse({ tally }).success).toBe(false);
    }
  });
});
