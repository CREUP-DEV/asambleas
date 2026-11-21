import { describe, expect, it } from "vitest";
import type { LiveStateDto, VoteDto } from "~~/shared/types/api";
import { liveVoteItemId, redactLiveVote } from "./liveStateVote";

function vote(overrides: Partial<VoteDto> = {}): VoteDto {
  return {
    id: "v1",
    subjectType: "agenda_item",
    subjectId: "item",
    method: "show_of_hands",
    inFavor: 10,
    against: 2,
    abstentions: 1,
    blank: 0,
    invalid: 0,
    notCast: 0,
    present: 13,
    majority: "simple",
    result: "approved",
    note: null,
    question: "¿Se ratifica el nombramiento?",
    unanimous: false,
    options: null,
    winningOption: null,
    tieResolution: null,
    winnerOutcome: null,
    ballots: null,
    blocAmendmentIds: null,
    election: null,
    recordedAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    voidedAt: null,
    ...overrides,
  };
}

function state(voteDto: VoteDto | null): LiveStateDto {
  return {
    agendaItemId: "item",
    documentId: null,
    amendmentId: null,
    amendmentBloc: [],
    amendmentBlocOptions: null,
    vote: voteDto,
    message: null,
    speakersVisible: false,
    recess: null,
    speakingLimitSeconds: 180,
    updatedAt: "2026-11-20T10:00:00.000Z",
  };
}

const none = { titleHidden: new Set<string>(), unlisted: () => false };

describe("liveVoteItemId", () => {
  it("names the item of a point vote with a question", () => {
    expect(liveVoteItemId(state(vote()))).toBe("item");
  });

  it("is null when nothing could be taken out", () => {
    expect(liveVoteItemId(state(null))).toBeNull();
    expect(liveVoteItemId(state(vote({ question: null })))).toBeNull();
    expect(
      liveVoteItemId(
        state(vote({ subjectType: "amendment", subjectId: "a1" })),
      ),
    ).toBeNull();
    expect(
      liveVoteItemId(state(vote({ subjectType: "document", subjectId: "d1" }))),
    ).toBeNull();
  });
});

describe("redactLiveVote", () => {
  it("keeps the question for a reader who gets the item with its title", () => {
    const live = state(vote());
    const result = redactLiveVote(live, none);
    expect(result.redacted).toBe(false);
    expect(result.state).toBe(live);
    expect(result.state.vote?.question).toBe("¿Se ratifica el nombramiento?");
  });

  it("takes it out for a reader who gets the item without its title", () => {
    const live = state(vote());
    const result = redactLiveVote(live, {
      titleHidden: new Set(["item"]),
      unlisted: () => false,
    });
    expect(result.redacted).toBe(true);
    expect(result.state.vote?.question).toBeNull();
    // The rest of the vote, and the state it came in, stay as they were.
    expect(result.state.vote?.inFavor).toBe(10);
    expect(live.vote?.question).toBe("¿Se ratifica el nombramiento?");
  });

  it("takes it out for a reader who does not get the item at all", () => {
    const result = redactLiveVote(state(vote()), {
      titleHidden: new Set(),
      unlisted: (itemId) => itemId === "item",
    });
    expect(result.redacted).toBe(true);
    expect(result.state.vote?.question).toBeNull();
  });

  it("never marks a question that was already missing", () => {
    const result = redactLiveVote(state(vote({ question: null })), {
      titleHidden: new Set(["item"]),
      unlisted: () => true,
    });
    expect(result.redacted).toBe(false);
  });

  it("leaves the vote on a document or an amendment alone", () => {
    const live = state(vote({ subjectType: "document", subjectId: "item" }));
    const result = redactLiveVote(live, {
      titleHidden: new Set(["item"]),
      unlisted: () => true,
    });
    expect(result.redacted).toBe(false);
    expect(result.state.vote?.question).toBe("¿Se ratifica el nombramiento?");
  });
});
