import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ db: {} }));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));

const { onScreenMarks } = await import("./sessionProgress");

type OnScreen = Parameters<typeof onScreenMarks>[2];

function screen(overrides: Partial<OnScreen> = {}): OnScreen {
  return {
    agendaItemId: "item-a",
    documentId: "doc-a",
    amendmentId: null,
    amendmentBloc: null,
    ...overrides,
  };
}

const nothing = { documentId: null, amendmentIds: [], presented: false };

describe("onScreenMarks", () => {
  it("marks the document a vote takes the screen to, and what it presents (ARQ-9)", () => {
    // pointLiveVote with a subject: the PUT left doc-a on screen, the vote
    // of doc-b's amendment moves it to doc-b and its item.
    const previous = screen();
    const next = screen({
      agendaItemId: "item-b",
      documentId: "doc-b",
      amendmentId: "amendment-1",
    });
    expect(onScreenMarks("in_session", previous, next)).toEqual({
      documentId: "doc-b",
      amendmentIds: ["amendment-1"],
      presented: true,
    });
  });

  it("marks nothing outside the session", () => {
    const next = screen({ documentId: "doc-b", amendmentId: "amendment-1" });
    for (const status of ["draft", "convened", "closed", null, undefined]) {
      expect(onScreenMarks(status as "convened", screen(), next)).toEqual(
        nothing,
      );
    }
  });

  it("does not stamp nor present again the document already on screen", () => {
    const next = screen({ amendmentId: "amendment-2" });
    expect(onScreenMarks("in_session", screen(), next)).toEqual({
      documentId: null,
      amendmentIds: ["amendment-2"],
      presented: false,
    });
  });

  it("stamps no document when the screen leaves it", () => {
    // clearLiveDocument: the item stays, the document goes.
    expect(
      onScreenMarks("in_session", screen(), screen({ documentId: null })),
    ).toEqual({ documentId: null, amendmentIds: [], presented: true });
  });

  it("stamps the amendments of a bloc once each, with the one on screen", () => {
    const next = screen({
      amendmentId: "amendment-1",
      amendmentBloc: ["amendment-1", "amendment-2"],
    });
    expect(onScreenMarks("in_session", screen(), next).amendmentIds).toEqual([
      "amendment-1",
      "amendment-2",
    ]);
  });

  it("marks everything on screen when the session opens (no previous)", () => {
    expect(onScreenMarks("in_session", null, screen())).toEqual({
      documentId: "doc-a",
      amendmentIds: [],
      presented: true,
    });
    expect(
      onScreenMarks(
        "in_session",
        null,
        screen({ agendaItemId: null, documentId: null }),
      ),
    ).toEqual(nothing);
  });
});
