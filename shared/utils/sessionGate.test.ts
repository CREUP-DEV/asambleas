import { describe, expect, it } from "vitest";
import {
  isSessionInProgress,
  liveStateClearsOnly,
  liveStateMovesScreen,
  speakerUpdateClearsOnly,
} from "./sessionGate";

const updatedAt = "2026-11-18T10:00:00.000Z";

describe("session gate", () => {
  it("opens only in session", () => {
    expect(isSessionInProgress("in_session")).toBe(true);
    for (const status of ["draft", "convened", "closed", null, undefined]) {
      expect(isSessionInProgress(status as never)).toBe(false);
    }
  });

  it("lets the live state be cleared, never pointed at something", () => {
    expect(liveStateClearsOnly({})).toBe(true);
    expect(
      liveStateClearsOnly({
        agendaItemId: null,
        documentId: null,
        amendmentId: null,
        voteId: null,
      }),
    ).toBe(true);
    expect(liveStateClearsOnly({ documentId: null, amendmentId: null })).toBe(
      true,
    );
    expect(liveStateClearsOnly({ message: "Volvemos a las 17:00" })).toBe(true);
    expect(liveStateClearsOnly({ speakersVisible: false })).toBe(true);
    expect(liveStateClearsOnly({ speakersVisible: true })).toBe(false);
    expect(liveStateClearsOnly({ agendaItemId: "item" })).toBe(false);
    expect(liveStateClearsOnly({ documentId: "doc" })).toBe(false);
    expect(liveStateClearsOnly({ amendmentId: "amendment" })).toBe(false);
    expect(liveStateClearsOnly({ voteId: "vote" })).toBe(false);
  });

  it("tells what moves the screen, which only the console in control sends", () => {
    expect(liveStateMovesScreen({ agendaItemId: "item" })).toBe(true);
    expect(liveStateMovesScreen({ documentId: "doc" })).toBe(true);
    expect(liveStateMovesScreen({ amendmentId: "amendment" })).toBe(true);
    expect(liveStateMovesScreen({ voteId: "vote" })).toBe(true);
    // Taking the debate off the screen moves it too.
    expect(liveStateMovesScreen({ amendmentId: null, voteId: null })).toBe(
      true,
    );
    // Any console of the Mesa may change these.
    expect(liveStateMovesScreen({ message: "Volvemos a las 17:00" })).toBe(
      false,
    );
    expect(liveStateMovesScreen({ recess: null })).toBe(false);
    expect(liveStateMovesScreen({ speakersVisible: true })).toBe(false);
    expect(liveStateMovesScreen({ speakingLimitSeconds: 120 })).toBe(false);
  });

  it("lets a turn end or leave the list, nothing else", () => {
    expect(speakerUpdateClearsOnly({ status: "done", updatedAt })).toBe(true);
    expect(speakerUpdateClearsOnly({ status: "cancelled", updatedAt })).toBe(
      true,
    );
    expect(speakerUpdateClearsOnly({ status: "speaking", updatedAt })).toBe(
      false,
    );
    expect(speakerUpdateClearsOnly({ status: "waiting", updatedAt })).toBe(
      false,
    );
    expect(
      speakerUpdateClearsOnly({ status: "done", position: 0, updatedAt }),
    ).toBe(false);
    expect(
      speakerUpdateClearsOnly({ status: "done", speaker: "Ana", updatedAt }),
    ).toBe(false);
    expect(speakerUpdateClearsOnly({ position: 1, updatedAt })).toBe(false);
  });
});
