import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveStateDto, LiveStatePushDto } from "~~/shared/types/api";
import {
  LIVE_STATE_DOCUMENT_SPREAD_MS,
  followLiveState,
  isNewerLiveState,
  isOlderLiveState,
  liveStateDocumentDelay,
  liveStatePushTracker,
  parseLiveStatePush,
} from "./-liveState";

function state(
  updatedAt: string | null,
  overrides: Partial<LiveStateDto> = {},
): LiveStateDto {
  return {
    agendaItemId: "i1",
    documentId: "d1",
    amendmentId: null,
    amendmentBloc: [],
    amendmentBlocOptions: null,
    vote: null,
    message: null,
    speakersVisible: false,
    recess: null,
    speakingLimitSeconds: 180,
    updatedAt,
    ...overrides,
  };
}

const T1 = "2026-11-20T10:00:00.000Z";
const T2 = "2026-11-20T10:00:01.000Z";
const T3 = "2026-11-20T10:00:02.000Z";

function pushData(dto: LiveStateDto, voteQuestionRedacted = false): string {
  const push: LiveStatePushDto = { state: dto, voteQuestionRedacted };
  return JSON.stringify(push);
}

describe("isOlderLiveState", () => {
  it("is older only when its stamp comes before the held one", () => {
    expect(isOlderLiveState(state(T1), state(T2))).toBe(true);
    expect(isOlderLiveState(state(T2), state(T1))).toBe(false);
  });

  it("keeps a state as new as the held one (equal is fine)", () => {
    expect(isOlderLiveState(state(T2), state(T2))).toBe(false);
  });

  it("never drops anything when nothing, or nothing stamped, is held", () => {
    expect(isOlderLiveState(state(T1), null)).toBe(false);
    expect(isOlderLiveState(state(T1), undefined)).toBe(false);
    expect(isOlderLiveState(state(null), state(null))).toBe(false);
    expect(isOlderLiveState(state(T1), state(null))).toBe(false);
  });

  it("takes a state without a stamp as older than one with it", () => {
    expect(isOlderLiveState(state(null), state(T1))).toBe(true);
  });
});

describe("isNewerLiveState", () => {
  it("is newer only when its stamp comes after the held one", () => {
    expect(isNewerLiveState(state(T2), state(T1))).toBe(true);
    expect(isNewerLiveState(state(T1), state(T2))).toBe(false);
  });

  it("takes an equal stamp as not newer", () => {
    expect(isNewerLiveState(state(T1), state(T1))).toBe(false);
  });

  it("is newer than nothing held, or an unstamped state", () => {
    expect(isNewerLiveState(state(T1), null)).toBe(true);
    expect(isNewerLiveState(state(null), undefined)).toBe(true);
    expect(isNewerLiveState(state(T1), state(null))).toBe(true);
    expect(isNewerLiveState(state(null), state(null))).toBe(false);
    expect(isNewerLiveState(state(null), state(T1))).toBe(false);
  });
});

describe("parseLiveStatePush", () => {
  it("reads a push", () => {
    expect(parseLiveStatePush(pushData(state(T1)))).toEqual({
      state: state(T1),
      voteQuestionRedacted: false,
    });
  });

  it("refuses what is not one", () => {
    expect(parseLiveStatePush(undefined)).toBeNull();
    expect(parseLiveStatePush("not json")).toBeNull();
    expect(parseLiveStatePush("null")).toBeNull();
    expect(parseLiveStatePush(JSON.stringify({ state: state(T1) }))).toBeNull();
    expect(
      parseLiveStatePush(JSON.stringify({ voteQuestionRedacted: false })),
    ).toBeNull();
  });
});

describe("liveStatePushTracker", () => {
  it("starts uncovered: a new stream pushed nothing yet", () => {
    expect(liveStatePushTracker().covered()).toBe(false);
  });

  it("is covered once a push follows the last live change", () => {
    const tracker = liveStatePushTracker();
    tracker.change({ entityType: "live" });
    expect(tracker.covered()).toBe(false);
    expect(tracker.push(pushData(state(T1)))).toEqual(state(T1));
    expect(tracker.covered()).toBe(true);
  });

  it("is uncovered again by a live change with no push after it", () => {
    const tracker = liveStatePushTracker();
    tracker.push(pushData(state(T1)));
    tracker.change({ entityType: "live" });
    expect(tracker.covered()).toBe(false);
  });

  it("ignores changes of other entities", () => {
    const tracker = liveStatePushTracker();
    tracker.push(pushData(state(T1)));
    tracker.change({ entityType: "amendment" });
    tracker.change({ entityType: "speakers" });
    expect(tracker.covered()).toBe(true);
  });

  it("hands over no redacted push, and leaves the read to the page", () => {
    const tracker = liveStatePushTracker();
    tracker.change({ entityType: "live" });
    expect(tracker.push(pushData(state(T1), true))).toBeNull();
    expect(tracker.covered()).toBe(false);
  });

  it("drops a malformed push", () => {
    const tracker = liveStatePushTracker();
    tracker.change({ entityType: "live" });
    expect(tracker.push("{")).toBeNull();
    expect(tracker.covered()).toBe(false);
  });

  it("starts over on a new stream", () => {
    const tracker = liveStatePushTracker();
    tracker.push(pushData(state(T1)));
    tracker.reset();
    expect(tracker.covered()).toBe(false);
  });
});

describe("followLiveState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies a push at once", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply });
    follower.pushed(state(T1));
    expect(apply).toHaveBeenCalledWith(state(T1));
  });

  it("keeps a read as new as anything seen", () => {
    const follower = followLiveState({ apply: vi.fn() });
    follower.pushed(state(T1));
    const read = state(T2);
    expect(follower.fetched(read)).toBe(read);
    const same = state(T2);
    expect(follower.fetched(same)).toBe(same);
    expect(follower.fetched(null)).toBeNull();
  });

  it("drops a read that a push overtook, keeping the pushed state", () => {
    const follower = followLiveState({ apply: vi.fn() });
    const pushed = state(T2);
    follower.pushed(pushed);
    expect(follower.fetched(state(T1))).toBe(pushed);
  });

  it("drops a push older than what the page read", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply });
    follower.fetched(state(T2));
    follower.pushed(state(T1));
    expect(apply).not.toHaveBeenCalled();
    follower.pushed(state(T2, { amendmentId: "a1" }));
    expect(apply).toHaveBeenCalledWith(state(T2, { amendmentId: "a1" }));
  });

  it("applies pushes in the order they come, whatever their stamps", () => {
    // Two writers at once: committed in one order, stamped in the other.
    const apply = vi.fn();
    const follower = followLiveState({ apply });
    follower.pushed(state(T2));
    follower.pushed(state(T1, { amendmentId: "a2" }));
    expect(apply).toHaveBeenLastCalledWith(state(T1, { amendmentId: "a2" }));
  });

  it("drops an old push handed to a late handler, after the page's read", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply });
    follower.fetched(state(T2));
    follower.pushed(state(T1));
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops a replayed push as new as the page's read: the read is fresher", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply });
    const read = state(T1, {
      vote: { id: "v1", unanimous: true } as LiveStateDto["vote"],
    });
    expect(follower.fetched(read)).toBe(read);
    follower.pushed(
      state(T1, {
        vote: { id: "v1", unanimous: false } as LiveStateDto["vote"],
      }),
      { replay: true },
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies a replayed push newer than the page's read", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply });
    follower.fetched(state(T1));
    follower.pushed(state(T2), { replay: true });
    expect(apply).toHaveBeenCalledWith(state(T2));
  });

  it("applies a replayed push when the page has no read yet, then lets the read win", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply });
    follower.pushed(state(T1, { message: "old" }), { replay: true });
    expect(apply).toHaveBeenCalledWith(state(T1, { message: "old" }));
    const read = state(T1, { message: "new" });
    expect(follower.fetched(read)).toBe(read);
  });

  it("still keeps a live push as new as the page's read", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply });
    follower.fetched(state(T1));
    follower.pushed(state(T1, { message: "pushed" }));
    expect(apply).toHaveBeenCalledWith(state(T1, { message: "pushed" }));
  });

  it("waits when asked, then applies only the newest, once", () => {
    const apply = vi.fn();
    const follower = followLiveState({
      apply,
      delayMs: (next) => (next.documentId === "d2" ? 500 : 0),
    });
    follower.pushed(state(T1, { documentId: "d2" }));
    follower.pushed(state(T2, { documentId: "d2", amendmentId: "a1" }));
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      state(T2, { documentId: "d2", amendmentId: "a1" }),
    );
  });

  it("lets a read as new as a waiting push replace it", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply, delayMs: () => 500 });
    follower.pushed(state(T1, { documentId: "d2" }));
    const read = state(T3, { documentId: "d3" });
    expect(follower.fetched(read)).toBe(read);
    vi.advanceTimersByTime(500);
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops a waiting push on dispose", () => {
    const apply = vi.fn();
    const follower = followLiveState({ apply, delayMs: () => 500 });
    follower.pushed(state(T1));
    follower.dispose();
    vi.advanceTimersByTime(500);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("liveStateDocumentDelay", () => {
  const held = state(T1, { documentId: "d1" });

  it("spreads a move to another document over the room", () => {
    expect(
      liveStateDocumentDelay(state(T2, { documentId: "d2" }), held, {
        spread: true,
        share: 0.5,
      }),
    ).toBe(LIVE_STATE_DOCUMENT_SPREAD_MS / 2);
    expect(
      liveStateDocumentDelay(state(T2, { documentId: null }), held, {
        spread: true,
        share: 1,
      }),
    ).toBe(LIVE_STATE_DOCUMENT_SPREAD_MS);
  });

  it("applies at once within the same document, or for the Mesa", () => {
    expect(
      liveStateDocumentDelay(state(T2, { amendmentId: "a1" }), held, {
        spread: true,
        share: 0.9,
      }),
    ).toBe(0);
    expect(
      liveStateDocumentDelay(state(T2, { documentId: "d2" }), held, {
        spread: false,
        share: 0.9,
      }),
    ).toBe(0);
  });
});
