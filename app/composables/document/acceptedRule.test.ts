import { describe, expect, it } from "vitest";
import type { VersionDto, VoteDto } from "~~/shared/types/api";
import { acceptedRuleChange, acceptedRuleLocked } from "./acceptedRule";

const PUBLISHED = "2026-10-01T10:00:00.000Z";

describe("acceptedRuleLocked", () => {
  it("never locks a document that is not published", () => {
    expect(
      acceptedRuleLocked({
        publishedAt: null,
        finalVote: {} as VoteDto,
        consolidated: true,
      }),
    ).toBe(false);
  });

  it("stays open on a published document still in play", () => {
    expect(
      acceptedRuleLocked({
        publishedAt: PUBLISHED,
        finalVote: null,
        consolidatedVersion: null,
        consolidated: false,
      }),
    ).toBe(false);
    // Older servers may omit the fields.
    expect(acceptedRuleLocked({ publishedAt: PUBLISHED })).toBe(false);
  });

  it("locks after the final vote", () => {
    expect(
      acceptedRuleLocked({ publishedAt: PUBLISHED, finalVote: {} as VoteDto }),
    ).toBe(true);
  });

  it("locks once the consolidated text exists", () => {
    expect(
      acceptedRuleLocked({
        publishedAt: PUBLISHED,
        consolidatedVersion: {} as VersionDto,
      }),
    ).toBe(true);
    expect(
      acceptedRuleLocked({ publishedAt: PUBLISHED, consolidated: true }),
    ).toBe(true);
  });
});

describe("acceptedRuleChange", () => {
  const base = { published: true, locked: false } as const;

  it("names the rule a published document switches to", () => {
    expect(
      acceptedRuleChange({ ...base, stored: "vote", next: "incorporate" }),
    ).toBe("incorporate");
    expect(
      acceptedRuleChange({ ...base, stored: "incorporate", next: "vote" }),
    ).toBe("vote");
  });

  it("says nothing when the rule stays the same", () => {
    expect(acceptedRuleChange({ ...base, stored: "vote", next: "vote" })).toBe(
      null,
    );
  });

  it("says nothing before publication: nothing is answered yet", () => {
    expect(
      acceptedRuleChange({
        published: false,
        locked: false,
        stored: "vote",
        next: "incorporate",
      }),
    ).toBe(null);
  });

  it("says nothing once the rule is locked", () => {
    expect(
      acceptedRuleChange({
        published: true,
        locked: true,
        stored: "vote",
        next: "incorporate",
      }),
    ).toBe(null);
  });

  it("says nothing without a stored rule to compare with", () => {
    expect(
      acceptedRuleChange({ ...base, stored: undefined, next: "incorporate" }),
    ).toBe(null);
    expect(acceptedRuleChange({ ...base, stored: null, next: "vote" })).toBe(
      null,
    );
  });
});
