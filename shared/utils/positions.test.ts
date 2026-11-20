import { describe, expect, it } from "vitest";
import {
  alwaysPublishedOnValidation,
  amendmentRule,
  answerableAfterDecision,
  positionsArePublic,
  positionsUnpublishable,
} from "./positions";

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

describe("answerableAfterDecision", () => {
  it("keeps the answer open on what the assembly approved", () => {
    for (const method of ["vote", "assent", "formal"] as const) {
      expect(
        answerableAfterDecision({ status: "approved", approvalMethod: method }),
      ).toBe(true);
    }
  });

  it("leaves out incorporated, undecided and closed amendments", () => {
    expect(
      answerableAfterDecision({
        status: "approved",
        approvalMethod: "proponent",
      }),
    ).toBe(false);
    expect(
      answerableAfterDecision({ status: "approved", approvalMethod: null }),
    ).toBe(false);
    for (const status of [
      "draft",
      "submitted",
      "rejected",
      "withdrawn",
      "lapsed",
      "transacted",
      "inadmissible",
    ] as const) {
      expect(answerableAfterDecision({ status, approvalMethod: "vote" })).toBe(
        false,
      );
    }
  });
});

describe("amendmentRule", () => {
  it("incorporates a formal amendment whatever the document's rule", () => {
    expect(amendmentRule("formal", "vote")).toBe("incorporate");
    expect(amendmentRule("formal", "incorporate")).toBe("incorporate");
    expect(amendmentRule("partial", "vote")).toBe("vote");
    expect(amendmentRule("transactional", "incorporate")).toBe("incorporate");
    expect(amendmentRule(undefined, "vote")).toBe("vote");
  });
});

describe("alwaysPublishedOnValidation", () => {
  it("publishes transactionals and formal amendments", () => {
    expect(alwaysPublishedOnValidation("transactional")).toBe(true);
    expect(alwaysPublishedOnValidation("formal")).toBe(true);
    expect(alwaysPublishedOnValidation("partial")).toBe(false);
  });
});
