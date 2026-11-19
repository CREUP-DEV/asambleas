import { describe, expect, it } from "vitest";
import {
  amendmentVoteMajority,
  DEFAULT_ASSEMBLY_SETTINGS,
  DOCUMENT_KIND_DEFAULTS,
  type DocumentKind,
} from "../constants/domain";
import { voteInputSchema } from "./schemas/vote";
import {
  ballotKeysOf,
  computeVoteOutcome,
  foreignBallotKeys,
  shownVoteCounts,
  thirdCount,
  voteTextKey,
  type VoteCounts,
} from "./votes";

/**
 * Votes recorded in the minutes of the 77.ª AGO (Sevilla, April 2025), with
 * the outcome the assembly declared. Each one must come out the same with
 * the default majority of its document kind and the default settings.
 */
const documentVotes: {
  name: string;
  kind: DocumentKind;
  counts: VoteCounts;
  result: "approved" | "rejected";
}[] = [
  {
    name: "Convenio con CANAE (point 24.2)",
    kind: "agreement",
    counts: { inFavor: 18, against: 2, abstentions: 10 },
    result: "rejected",
  },
  {
    name: "IEJ sobre dobles titulaciones (point 23.3), secret vote",
    kind: "executive_report",
    counts: { inFavor: 19, against: 12, abstentions: 0, blank: 3 },
    result: "rejected",
  },
  {
    name: "Posicionamiento de financiación (point 16), secret vote",
    kind: "positioning",
    counts: { inFavor: 28, against: 2, abstentions: 0, blank: 3 },
    result: "approved",
  },
  {
    name: "RES Reforma Normativa (point 22.1)",
    kind: "resolution",
    counts: { inFavor: 30, against: 2, abstentions: 2 },
    result: "approved",
  },
];

const amendmentVotes: typeof documentVotes = [
  {
    name: "RFCAS USC-3 (point 13), a 9-9 tie",
    kind: "regulation",
    counts: { inFavor: 9, against: 9, abstentions: 14 },
    result: "rejected",
  },
  {
    name: "RFCAS UPM-1 (point 13)",
    kind: "regulation",
    counts: { inFavor: 29, against: 1, abstentions: 2 },
    result: "approved",
  },
  {
    name: "RES Reforma Normativa UAM-1 (point 22.1)",
    kind: "resolution",
    counts: { inFavor: 14, against: 13, abstentions: 7 },
    result: "approved",
  },
  {
    name: "PO Financiación UCA-2 (point 16)",
    kind: "positioning",
    counts: { inFavor: 9, against: 16, abstentions: 9 },
    result: "rejected",
  },
];

describe("computeVoteOutcome against the 77.ª AGO minutes", () => {
  // The minutes counted majorities on the valid votes cast.
  const settings = {
    ...DEFAULT_ASSEMBLY_SETTINGS,
    denominator: "valid_votes" as const,
  };

  it.each(documentVotes)("final vote: $name", ({ kind, counts, result }) => {
    const outcome = computeVoteOutcome(
      counts,
      DOCUMENT_KIND_DEFAULTS[kind].majority,
      settings,
    );
    expect(outcome.result).toBe(result);
  });

  it.each(amendmentVotes)("amendment: $name", ({ kind, counts, result }) => {
    const outcome = computeVoteOutcome(
      counts,
      amendmentVoteMajority(kind),
      settings,
    );
    expect(outcome.result).toBe(result);
  });
});

describe("computeVoteOutcome with the default settings", () => {
  // Majorities on the members present (DEFAULT_ASSEMBLY_SETTINGS), the base
  // of every assembly unless its settings say otherwise.
  const settings = DEFAULT_ASSEMBLY_SETTINGS;

  it("counts on the members present", () => {
    expect(settings.denominator).toBe("present");
  });

  it("asks two thirds of 30 present for 20 in favour", () => {
    expect(
      computeVoteOutcome(
        { inFavor: 19, against: 8, abstentions: 3, present: 30 },
        "two_thirds",
        settings,
      ),
    ).toEqual({
      result: "rejected",
      threshold: 20,
      denominator: 30,
      inconsistent: false,
    });
    expect(
      computeVoteOutcome(
        { inFavor: 20, against: 7, abstentions: 3, present: 30 },
        "two_thirds",
        settings,
      ),
    ).toEqual({
      result: "approved",
      threshold: 20,
      denominator: 30,
      inconsistent: false,
    });
  });

  it("counts abstentions and those who did not vote against an absolute majority", () => {
    expect(
      computeVoteOutcome(
        { inFavor: 12, against: 2, abstentions: 6, present: 30 },
        "absolute",
        settings,
      ),
    ).toEqual({
      result: "rejected",
      threshold: 16,
      denominator: 30,
      inconsistent: false,
    });
  });

  it("falls back to the valid votes when no figure of present is given", () => {
    // Deliberate: without a headcount the vote form warns
    // (session.vote.noHeadcount) and the base is the valid votes cast.
    for (const present of [null, undefined]) {
      expect(
        computeVoteOutcome(
          { inFavor: 12, against: 2, abstentions: 6, present },
          "absolute",
          settings,
        ),
      ).toEqual({
        result: "approved",
        threshold: 11,
        denominator: 20,
        inconsistent: false,
      });
    }
  });
});

describe("the ballots each method takes (user's decision of 2026-11-19)", () => {
  it("counts blank and invalid ballots only in a secret vote", () => {
    expect(ballotKeysOf("secret")).toEqual([
      "inFavor",
      "against",
      "blank",
      "invalid",
    ]);
    for (const method of ["show_of_hands", "roll_call", "portal"] as const) {
      expect(ballotKeysOf(method)).toEqual([
        "inFavor",
        "against",
        "abstentions",
      ]);
      expect(foreignBallotKeys(method)).toEqual(["blank", "invalid"]);
    }
    expect(foreignBallotKeys("secret")).toEqual(["abstentions"]);
    expect(ballotKeysOf("assent")).toEqual([]);
    expect(foreignBallotKeys("assent")).toEqual([]);
  });

  it("refuses a count the method does not take, but not a zero", () => {
    expect(
      voteInputSchema.safeParse({ method: "show_of_hands", blank: 1 }).success,
    ).toBe(false);
    expect(
      voteInputSchema.safeParse({ method: "roll_call", invalid: 2 }).success,
    ).toBe(false);
    expect(
      voteInputSchema.safeParse({ method: "secret", abstentions: 1 }).success,
    ).toBe(false);
    expect(
      voteInputSchema.safeParse({
        method: "show_of_hands",
        inFavor: 3,
        abstentions: 2,
        blank: 0,
        invalid: 0,
        notCast: 4,
      }).success,
    ).toBe(true);
    expect(
      voteInputSchema.safeParse({
        method: "secret",
        inFavor: 3,
        blank: 2,
        invalid: 1,
        abstentions: 0,
      }).success,
    ).toBe(true);
  });

  it("counts blank ballots as valid votes, never those not cast", () => {
    const settings = {
      ...DEFAULT_ASSEMBLY_SETTINGS,
      denominator: "valid_votes" as const,
    };
    expect(
      computeVoteOutcome(
        {
          inFavor: 10,
          against: 4,
          abstentions: 0,
          blank: 6,
          invalid: 3,
          notCast: 9,
        },
        "absolute",
        settings,
      ),
    ).toEqual({
      result: "rejected",
      threshold: 11,
      denominator: 20,
      inconsistent: false,
    });
  });

  it("shows abstentions, or blank ballots in a secret vote", () => {
    const base = {
      inFavor: 5,
      against: 2,
      abstentions: 3,
      blank: 0,
      invalid: 0,
      notCast: 0,
    };
    expect(shownVoteCounts({ ...base, method: "show_of_hands" })).toEqual([
      { key: "inFavor", value: 5 },
      { key: "against", value: 2 },
      { key: "abstentions", value: 3 },
    ]);
    expect(
      shownVoteCounts({
        ...base,
        abstentions: 0,
        blank: 4,
        invalid: 1,
        notCast: 2,
        method: "secret",
      }),
    ).toEqual([
      { key: "inFavor", value: 5 },
      { key: "against", value: 2 },
      { key: "blank", value: 4 },
      { key: "invalid", value: 1 },
      { key: "notCast", value: 2 },
    ]);
    expect(thirdCount({ abstentions: 3, blank: 4, method: "secret" })).toBe(4);
    expect(thirdCount({ abstentions: 3, blank: 4, method: "portal" })).toBe(3);
    expect(voteTextKey("a.b", "secret")).toBe("a.bSecret");
    expect(voteTextKey("a.b", "show_of_hands")).toBe("a.b");
  });
});
