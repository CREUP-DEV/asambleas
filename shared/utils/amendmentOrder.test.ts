import { describe, expect, it } from "vitest";
import type { ProponentPosition } from "../constants/domain";
import {
  amendmentAnswerRank,
  amendmentOrderRank,
  compareAmendmentAnswers,
  type AmendmentOrderSubject,
} from "./amendmentOrder";

const answered = (
  position: ProponentPosition | null,
  kind: AmendmentOrderSubject["kind"] = "partial",
): AmendmentOrderSubject => ({
  kind,
  position: position ? { position } : null,
});

describe("amendmentAnswerRank", () => {
  it("puts accepted and transacted first, rejected next, the rest last", () => {
    expect(amendmentAnswerRank(answered("accept"))).toBe(0);
    expect(amendmentAnswerRank(answered("transact"))).toBe(0);
    expect(amendmentAnswerRank(answered("reject"))).toBe(1);
    expect(amendmentAnswerRank(answered("pending"))).toBe(2);
    expect(amendmentAnswerRank(answered(null))).toBe(2);
    expect(amendmentAnswerRank({ kind: "formal" })).toBe(2);
  });

  it("puts a transactional with the accepted, whatever its answer", () => {
    expect(amendmentAnswerRank(answered(null, "transactional"))).toBe(0);
    expect(amendmentAnswerRank(answered("reject", "transactional"))).toBe(0);
  });
});

describe("amendmentOrderRank", () => {
  it("ranks by the group only while the answers are public", () => {
    const rejected = answered("reject");
    expect(amendmentOrderRank(rejected, { answersPublic: true })).toBe(1);
    expect(amendmentOrderRank(rejected, { answersPublic: false })).toBe(0);
    expect(amendmentOrderRank(rejected)).toBe(0);
    expect(amendmentOrderRank(answered(null))).toBe(0);
  });
});

describe("compareAmendmentAnswers", () => {
  const pub = { answersPublic: true };

  it("orders by group once public and leaves ties to text order", () => {
    expect(
      compareAmendmentAnswers(answered("accept"), answered("reject"), pub),
    ).toBeLessThan(0);
    expect(
      compareAmendmentAnswers(answered(null), answered("reject"), pub),
    ).toBeGreaterThan(0);
    expect(
      compareAmendmentAnswers(answered("transact"), answered("accept"), pub),
    ).toBe(0);
    expect(
      compareAmendmentAnswers(answered("pending"), answered(null), pub),
    ).toBe(0);
    expect(
      compareAmendmentAnswers(
        answered(null, "transactional"),
        answered("reject"),
        pub,
      ),
    ).toBeLessThan(0);
  });

  it("never reorders before the answers are public", () => {
    expect(
      compareAmendmentAnswers(answered("accept"), answered("reject")),
    ).toBe(0);
    expect(
      compareAmendmentAnswers(
        answered(null),
        answered(null, "transactional"),
        {},
      ),
    ).toBe(0);
  });
});
