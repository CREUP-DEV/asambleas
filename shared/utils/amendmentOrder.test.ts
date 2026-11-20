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
  it("puts accepted first, transactions next, then rejected, then the rest", () => {
    expect(amendmentAnswerRank(answered("accept"))).toBe(0);
    expect(amendmentAnswerRank(answered("transact"))).toBe(1);
    expect(amendmentAnswerRank(answered("reject"))).toBe(2);
    expect(amendmentAnswerRank(answered("pending"))).toBe(3);
    expect(amendmentAnswerRank(answered(null))).toBe(3);
    expect(amendmentAnswerRank({ kind: "formal" })).toBe(3);
  });

  it("puts an accepted amendment a transactional replaced with the transactions", () => {
    expect(
      amendmentAnswerRank({ ...answered("accept"), status: "transacted" }),
    ).toBe(1);
  });

  it("puts a transactional by the main presenter's acceptance", () => {
    const party = (decision: "accepted" | "pending" | "rejected") => ({
      ...answered(null, "transactional"),
      acceptances: [
        { role: "author" as const, decision: "accepted" as const },
        { role: "proponent" as const, decision },
      ],
    });
    expect(amendmentAnswerRank(party("accepted"))).toBe(1);
    expect(amendmentAnswerRank(answered("accept", "transactional"))).toBe(1);
    expect(amendmentAnswerRank(party("pending"))).toBe(3);
    expect(amendmentAnswerRank(answered("reject", "transactional"))).toBe(2);
    expect(amendmentAnswerRank(answered(null, "transactional"))).toBe(3);
  });

  it("leaves the rejected formal amendments for last", () => {
    expect(amendmentAnswerRank(answered("reject", "formal"))).toBe(4);
    expect(amendmentAnswerRank(answered("accept", "formal"))).toBe(0);
  });
});

describe("amendmentOrderRank", () => {
  it("ranks by the group only while the answers are public", () => {
    const rejected = answered("reject");
    expect(amendmentOrderRank(rejected, { byAnswer: true })).toBe(2);
    expect(amendmentOrderRank(rejected, { byAnswer: false })).toBe(0);
    expect(amendmentOrderRank(rejected)).toBe(0);
    expect(amendmentOrderRank(answered(null))).toBe(0);
  });
});

describe("compareAmendmentAnswers", () => {
  const pub = { byAnswer: true };

  it("orders by group once public and leaves ties to text order", () => {
    expect(
      compareAmendmentAnswers(answered("accept"), answered("reject"), pub),
    ).toBeLessThan(0);
    expect(
      compareAmendmentAnswers(answered(null), answered("reject"), pub),
    ).toBeGreaterThan(0);
    expect(
      compareAmendmentAnswers(answered("transact"), answered("accept"), pub),
    ).toBeGreaterThan(0);
    expect(
      compareAmendmentAnswers(answered("pending"), answered(null), pub),
    ).toBe(0);
    expect(
      compareAmendmentAnswers(
        answered("accept", "transactional"),
        answered("reject"),
        pub,
      ),
    ).toBeLessThan(0);
    expect(
      compareAmendmentAnswers(
        answered("reject", "formal"),
        answered(null),
        pub,
      ),
    ).toBeGreaterThan(0);
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
