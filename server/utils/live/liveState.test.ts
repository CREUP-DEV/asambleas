import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveStateDto, VoteDto } from "~~/shared/types/api";
import type { Actor } from "../domain/actor";

const loadLiveStateDto = vi.fn<(id: string) => Promise<LiveStateDto>>();
const loadPublicItemMarks =
  vi.fn<
    (id: string) => Promise<{ unlisted: Set<string>; titleHidden: Set<string> }>
  >();
const loadReaderItems =
  vi.fn<
    (
      actor: Actor,
      id: string,
    ) => Promise<{ items: Map<string, unknown>; titleHidden: Set<string> }>
  >();

vi.mock("../domain/assemblies", () => ({
  loadLiveStateDto: (id: string) => loadLiveStateDto(id),
  loadPublicItemMarks: (id: string) => loadPublicItemMarks(id),
}));
vi.mock("../domain/controlSheet", () => ({
  loadReaderItems: (actor: Actor, id: string) => loadReaderItems(actor, id),
}));

const { liveStateFor, loadPublicLiveState } = await import("./liveState");

const QUESTION = "¿Se ratifica el nombramiento de la persona propuesta?";

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
    question: QUESTION,
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
    amendmentBlocPurpose: null,
    vote: voteDto,
    voteDecision: null,
    message: null,
    speakersVisible: true,
    recess: null,
    speakingLimitSeconds: 180,
    updatedAt: "2026-11-20T10:00:00.000Z",
  };
}

const reader = { user: { id: "u1" } } as unknown as Actor;

afterEach(() => {
  loadLiveStateDto.mockReset();
  loadPublicItemMarks.mockReset();
  loadReaderItems.mockReset();
});

describe("liveStateFor (GET and PUT .../live-state)", () => {
  it("keeps the question for a reader who gets the item with its title", async () => {
    loadLiveStateDto.mockResolvedValue(state(vote()));
    loadReaderItems.mockResolvedValue({
      items: new Map([["item", {}]]),
      titleHidden: new Set(),
    });
    const result = await liveStateFor(reader, "asm");
    expect(result.vote?.question).toBe(QUESTION);
    expect(loadReaderItems).toHaveBeenCalledWith(reader, "asm");
  });

  it("takes it out for a reader who gets the item without its title", async () => {
    loadLiveStateDto.mockResolvedValue(state(vote()));
    loadReaderItems.mockResolvedValue({
      items: new Map([["item", {}]]),
      titleHidden: new Set(["item"]),
    });
    const result = await liveStateFor(reader, "asm");
    expect(result.vote?.question).toBeNull();
    expect(result.vote?.id).toBe("v1");
    expect(result.speakersVisible).toBe(true);
  });

  it("takes it out for a reader who does not get the item at all", async () => {
    loadLiveStateDto.mockResolvedValue(state(vote()));
    loadReaderItems.mockResolvedValue({
      items: new Map(),
      titleHidden: new Set(),
    });
    expect((await liveStateFor(reader, "asm")).vote?.question).toBeNull();
  });

  it("reads no agenda when no point vote with a question is on screen", async () => {
    loadLiveStateDto.mockResolvedValue(state(null));
    expect((await liveStateFor(reader, "asm")).vote).toBeNull();
    loadLiveStateDto.mockResolvedValue(
      state(vote({ subjectType: "amendment", subjectId: "a1" })),
    );
    expect((await liveStateFor(reader, "asm")).vote?.question).toBe(QUESTION);
    expect(loadReaderItems).not.toHaveBeenCalled();
  });

  it("answers the state it is given without loading it again", async () => {
    loadReaderItems.mockResolvedValue({
      items: new Map([["item", {}]]),
      titleHidden: new Set(["item"]),
    });
    const result = await liveStateFor(reader, "asm", state(vote()));
    expect(loadLiveStateDto).not.toHaveBeenCalled();
    expect(result.vote?.question).toBeNull();
  });
});

describe("loadPublicLiveState (the stream's push)", () => {
  it("pushes the question when the public reads the item's title", async () => {
    loadLiveStateDto.mockResolvedValue(state(vote()));
    loadPublicItemMarks.mockResolvedValue({
      unlisted: new Set(),
      titleHidden: new Set(),
    });
    const push = await loadPublicLiveState("asm");
    expect(push.voteQuestionRedacted).toBe(false);
    expect(push.state.vote?.question).toBe(QUESTION);
  });

  it("takes it out, and says so, when the item's title is not public", async () => {
    loadLiveStateDto.mockResolvedValue(state(vote()));
    loadPublicItemMarks.mockResolvedValue({
      unlisted: new Set(),
      titleHidden: new Set(["item"]),
    });
    const push = await loadPublicLiveState("asm");
    expect(push.voteQuestionRedacted).toBe(true);
    expect(push.state.vote?.question).toBeNull();
  });

  it("takes it out when the public does not get the item", async () => {
    loadLiveStateDto.mockResolvedValue(state(vote()));
    loadPublicItemMarks.mockResolvedValue({
      unlisted: new Set(["item"]),
      titleHidden: new Set(),
    });
    const push = await loadPublicLiveState("asm");
    expect(push.voteQuestionRedacted).toBe(true);
    expect(push.state.vote?.question).toBeNull();
  });

  it("reads no agenda and marks nothing without a point vote's question", async () => {
    loadLiveStateDto.mockResolvedValue(state(vote({ question: null })));
    const push = await loadPublicLiveState("asm");
    expect(push.voteQuestionRedacted).toBe(false);
    expect(loadPublicItemMarks).not.toHaveBeenCalled();
  });
});
