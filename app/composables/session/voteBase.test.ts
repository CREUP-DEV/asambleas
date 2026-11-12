import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import type { VoteInput } from "~~/shared/types/api";
import { computeVoteOutcome } from "~~/shared/utils/votes";
import { fillPresent } from "~~/server/utils/domain/headcounts";
import { sessionFillPresent, sessionVoteOutcome } from "./sessionModel";

// The server module touches the database: only its pure part is used.
vi.mock("~~/server/db", () => ({ db: {} }));
vi.mock("~~/server/utils/domain/events", () => ({ recordEvent: vi.fn() }));
vi.mock("~~/server/utils/domain/actor", () => ({ canModerate: vi.fn() }));

/**
 * The console's preview and confirmation must give the result the server
 * stores: with majorities on the members present and the field left empty,
 * the server counts on the latest headcount (fillPresent in withHeadcount),
 * and so must sessionVoteOutcome.
 */
describe("the vote preview against the server's rule", () => {
  const latest = { id: "count-1", present: 30 };
  const settings = {
    ...DEFAULT_ASSEMBLY_SETTINGS,
    tieRule: "rejected" as const,
  };

  function serverOutcome(vote: VoteInput) {
    const filled = fillPresent(vote, latest, settings).vote;
    return computeVoteOutcome(
      {
        inFavor: filled.inFavor ?? 0,
        against: filled.against ?? 0,
        abstentions: filled.abstentions ?? 0,
        blank: filled.blank ?? 0,
        invalid: filled.invalid ?? 0,
        present: filled.present ?? null,
      },
      filled.majority ?? "simple",
      settings,
    );
  }

  it("counts an empty field on the headcount, as the server does", () => {
    // 19 of 25 valid votes would pass two thirds (17); of the 30 present it
    // takes 20.
    for (const present of [null, undefined]) {
      const vote: VoteInput = {
        method: "show_of_hands",
        inFavor: 19,
        against: 4,
        abstentions: 2,
        present,
        majority: "two_thirds",
      };
      const client = sessionVoteOutcome(vote, settings, latest);
      expect(client).toEqual(serverOutcome(vote));
      expect(client).toMatchObject({
        result: "rejected",
        threshold: 20,
        denominator: 30,
      });
      expect(sessionFillPresent(vote, latest, settings)).toEqual(
        fillPresent(vote, latest, settings).vote,
      );
    }
  });

  it("keeps a typed figure, zero included, as the server does", () => {
    for (const present of [32, 0]) {
      const vote: VoteInput = {
        method: "show_of_hands",
        inFavor: 19,
        against: 4,
        abstentions: 2,
        present,
        majority: "absolute",
      };
      expect(sessionVoteOutcome(vote, settings, latest)).toEqual(
        serverOutcome(vote),
      );
    }
  });

  it("fills nothing on the valid votes, for assent or without a count", () => {
    const vote: VoteInput = {
      method: "show_of_hands",
      inFavor: 10,
      against: 5,
      majority: "absolute",
    };
    const valid = {
      denominator: "valid_votes" as const,
      tieRule: "rejected" as const,
    };
    expect(sessionFillPresent(vote, latest, valid)).toEqual(
      fillPresent(vote, latest, valid).vote,
    );
    const assent: VoteInput = { method: "assent" };
    expect(sessionFillPresent(assent, latest, settings)).toEqual(assent);
    expect(sessionFillPresent(vote, null, settings)).toEqual(
      fillPresent(vote, null, settings).vote,
    );
    // Not loaded yet: the preview counts on the valid votes.
    expect(sessionFillPresent(vote, undefined, settings)).toEqual(vote);
  });
});
