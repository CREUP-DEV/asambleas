import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DOCUMENTS,
  MAX_EDITORS_PER_DOCUMENT,
  PRESENCE_TTL_MS,
  leavePresence,
  listPresence,
  resetPresence,
  touchPresence,
} from "./presence";

const editor = (userId: string, tabId: string, unsaved = false) => ({
  userId,
  tabId,
  name: `Name ${userId}`,
  member: null,
  unsaved,
});

describe("draft editor presence", () => {
  beforeEach(() => resetPresence());

  it("lists the other tabs, never the caller's own", () => {
    touchPresence("doc", editor("ana", "tab-ana-1"), 1_000);
    touchPresence("doc", editor("luis", "tab-luis-1"), 2_000);

    const seen = listPresence(
      "doc",
      { userId: "ana", tabId: "tab-ana-1" },
      3_000,
    );
    expect(seen.map((entry) => entry.userId)).toEqual(["luis"]);
  });

  it("tells apart two tabs of the same account", () => {
    // A council's account is shared: another tab may be another person.
    touchPresence("doc", editor("council", "tab-one"), 1_000);
    touchPresence("doc", editor("council", "tab-two"), 2_000);

    const seen = listPresence(
      "doc",
      { userId: "council", tabId: "tab-one" },
      3_000,
    );
    expect(seen.map((entry) => entry.tabId)).toEqual(["tab-two"]);
  });

  it("never lets a tab id of one account stand for another", () => {
    touchPresence("doc", editor("ana", "same-tab"), 1_000);
    touchPresence("doc", editor("luis", "same-tab"), 1_000);
    leavePresence("doc", { userId: "luis", tabId: "same-tab" });

    const seen = listPresence(
      "doc",
      { userId: "x", tabId: "other-tab" },
      2_000,
    );
    expect(seen.map((entry) => entry.userId)).toEqual(["ana"]);
  });

  it("forgets a tab that stops beating", () => {
    touchPresence("doc", editor("luis", "tab-luis-1"), 1_000);
    const self = { userId: "ana", tabId: "tab-ana-1" };

    expect(listPresence("doc", self, 1_000 + PRESENCE_TTL_MS)).toHaveLength(1);
    expect(listPresence("doc", self, 1_001 + PRESENCE_TTL_MS)).toEqual([]);
  });

  it("keeps when a tab opened and updates what it holds", () => {
    touchPresence("doc", editor("luis", "tab-luis-1"), 1_000);
    touchPresence("doc", editor("luis", "tab-luis-1", true), 5_000);

    const [entry] = listPresence(
      "doc",
      { userId: "ana", tabId: "tab-ana-1" },
      6_000,
    );
    expect(entry).toMatchObject({ since: 1_000, seenAt: 5_000, unsaved: true });
  });

  it("drops a tab that leaves", () => {
    touchPresence("doc", editor("luis", "tab-luis-1"), 1_000);
    leavePresence("doc", { userId: "luis", tabId: "tab-luis-1" });

    expect(
      listPresence("doc", { userId: "ana", tabId: "tab-ana-1" }, 2_000),
    ).toEqual([]);
  });

  it("keeps each document apart", () => {
    touchPresence("one", editor("luis", "tab-luis-1"), 1_000);

    expect(
      listPresence("two", { userId: "ana", tabId: "tab-ana-1" }, 2_000),
    ).toEqual([]);
  });

  it("caps the tabs of one document, dropping the least recently seen", () => {
    for (let index = 0; index <= MAX_EDITORS_PER_DOCUMENT; index += 1) {
      touchPresence("doc", editor(`user-${index}`, "tab-abcdef"), index);
    }

    const seen = listPresence(
      "doc",
      { userId: "x", tabId: "other-tab" },
      MAX_EDITORS_PER_DOCUMENT,
    );
    expect(seen).toHaveLength(MAX_EDITORS_PER_DOCUMENT);
    expect(seen.some((entry) => entry.userId === "user-0")).toBe(false);
  });

  it("caps the documents, sweeping expired ones first", () => {
    for (let index = 0; index < MAX_DOCUMENTS; index += 1) {
      touchPresence(`doc-${index}`, editor("luis", "tab-luis-1"), 0);
    }
    const self = { userId: "ana", tabId: "tab-ana-1" };

    // Full of live editors: a new document goes unannounced.
    touchPresence("late", editor("luis", "tab-luis-1"), 1_000);
    expect(listPresence("late", self, 1_000)).toEqual([]);

    // Once they expire, there is room again.
    const later = PRESENCE_TTL_MS + 1;
    touchPresence("late", editor("luis", "tab-luis-1"), later);
    expect(listPresence("late", self, later)).toHaveLength(1);
  });
});
