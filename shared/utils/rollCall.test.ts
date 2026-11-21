import { describe, expect, it } from "vitest";
import { resolveRollCall, rollCallCounts, rollCallVoters } from "./rollCall";

const voters = [
  { memberId: "a", acronym: "CEUM", name: "Consejo A", delegate: null },
  { memberId: "b", acronym: "CEUPV", name: "Consejo B", delegate: null },
  {
    memberId: "c",
    acronym: "CEUIB",
    name: "Consejo C",
    delegate: { id: "b", acronym: "CEUPV" },
  },
];

describe("resolveRollCall", () => {
  it("records every voter in order, «No vota» for those left out", () => {
    const result = resolveRollCall(voters, [
      { memberId: "c", choice: "against" },
      { memberId: "a", choice: "in_favor" },
    ]);
    expect("ballots" in result && result.ballots).toEqual([
      expect.objectContaining({ memberId: "a", choice: "in_favor" }),
      expect.objectContaining({ memberId: "b", choice: "not_voting" }),
      expect.objectContaining({
        memberId: "c",
        choice: "against",
        delegate: { id: "b", acronym: "CEUPV" },
      }),
    ]);
  });

  it("refuses strangers, repeats and choices the vote does not take", () => {
    expect(
      resolveRollCall(voters, [{ memberId: "x", choice: "in_favor" }]),
    ).toEqual({
      problem: { reason: "unknown_member", memberId: "x" },
    });
    expect(
      resolveRollCall(voters, [
        { memberId: "a", choice: "in_favor" },
        { memberId: "a", choice: "against" },
      ]),
    ).toEqual({ problem: { reason: "repeated_member", memberId: "a" } });
    // An option outside a vote between alternatives, in favour inside one.
    expect(
      resolveRollCall(voters, [{ memberId: "a", choice: "option", option: 0 }]),
    ).toEqual({ problem: { reason: "bad_choice", memberId: "a" } });
    expect(
      resolveRollCall(voters, [{ memberId: "a", choice: "in_favor" }], 2),
    ).toEqual({ problem: { reason: "bad_choice", memberId: "a" } });
    expect(
      resolveRollCall(
        voters,
        [{ memberId: "a", choice: "option", option: 2 }],
        2,
      ),
    ).toEqual({ problem: { reason: "bad_choice", memberId: "a" } });
  });
});

describe("rollCallCounts", () => {
  it("counts each choice, and each option between alternatives", () => {
    expect(
      rollCallCounts([
        { choice: "in_favor", option: null },
        { choice: "in_favor", option: null },
        { choice: "against", option: null },
        { choice: "abstention", option: null },
        { choice: "not_voting", option: null },
      ]),
    ).toEqual({
      inFavor: 2,
      against: 1,
      abstentions: 1,
      notCast: 1,
      options: [],
      present: 5,
    });
    expect(
      rollCallCounts(
        [
          { choice: "option", option: 1 },
          { choice: "option", option: 0 },
          { choice: "option", option: 1 },
        ],
        2,
      ).options,
    ).toEqual([1, 2]);
  });
});

describe("rollCallVoters", () => {
  it("keeps the voting entries, with their delegate", () => {
    expect(
      rollCallVoters([
        {
          member: { id: "a", acronym: "CEUM", name: "A" },
          mark: "present",
          delegate: null,
          voting: true,
        },
        {
          member: { id: "s", acronym: "SECT", name: "S" },
          mark: "present",
          delegate: null,
          voting: false,
        },
        {
          member: { id: "c", acronym: "CEUIB", name: "C" },
          mark: "delegated",
          delegate: { id: "a", acronym: "CEUM" },
          voting: true,
        },
      ]).map((voter) => [voter.acronym, voter.delegate?.acronym ?? null]),
    ).toEqual([
      ["CEUM", null],
      ["CEUIB", "CEUM"],
    ]);
  });
});
