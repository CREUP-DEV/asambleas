import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEAVE_SAVE_WAIT_MS,
  keepMyObservations,
  keepsObservationDraft,
  newObservationDraft,
  observationConflicted,
  observationDirty,
  observationSaved,
  observationUnsaved,
  releaseObservationDraft,
  settledWithin,
  syncObservationDraft,
  takeTheirObservations,
  unsavedObservationIds,
  type ObservationDraft,
} from "./-drafts";

const row = (text: string, token: string | null, by: string | null = null) => ({
  observations: text,
  observationsUpdatedAt: token,
  observationsEdited: by ? { by } : null,
});

describe("observation drafts", () => {
  it("starts from the row's text and token", () => {
    const entry = newObservationDraft(row("Moción", "t1"));
    expect(entry).toEqual({
      draft: "Moción",
      base: { text: "Moción", token: "t1" },
      conflict: null,
      saving: false,
      savedAt: null,
    });
    expect(newObservationDraft(null).base).toEqual({ text: "", token: null });
    expect(observationDirty(entry)).toBe(false);
  });

  it("is dirty once typed, ignoring trailing blanks", () => {
    const entry = newObservationDraft(row("Moción", "t1"));
    entry.draft = "Moción  ";
    expect(observationDirty(entry)).toBe(false);
    entry.draft = "Moción de orden";
    expect(observationDirty(entry)).toBe(true);
  });

  it("keeps what was typed while it saved", () => {
    const entry = newObservationDraft(row("", null));
    entry.draft = "Uno";
    entry.draft = "Uno y dos";
    observationSaved(entry, "Uno", row("Uno", "t2"), 1000);
    expect(entry.base).toEqual({ text: "Uno", token: "t2" });
    expect(entry.draft).toBe("Uno y dos");
    expect(entry.savedAt).toBe(1000);
    expect(observationDirty(entry)).toBe(true);
  });

  it("takes the saved text when nothing else was typed", () => {
    const entry = newObservationDraft(row("", null));
    entry.draft = "Uno";
    observationSaved(entry, "Uno", row("Uno", "t2"), 1000);
    expect(observationDirty(entry)).toBe(false);
  });

  it("syncs from a refetched row", () => {
    const entry = newObservationDraft(row("Uno", "t1"));
    syncObservationDraft(entry, row("Dos", "t2"));
    expect(entry.draft).toBe("Dos");
    expect(entry.base).toEqual({ text: "Dos", token: "t2" });
  });

  describe("a save answered after the panel left its row", () => {
    function twoRows() {
      const drafts = new Map<string, ObservationDraft>();
      const a = newObservationDraft(row("", null));
      drafts.set("a", a);
      a.draft = "Lo que dijo la Mesa";
      a.saving = true;
      // The panel closes and opens row B while A saves.
      releaseObservationDraft(drafts, "a");
      const b = newObservationDraft(row("Nota de B", "b1"));
      drafts.set("b", b);
      b.draft = "Nota de B, ampliada";
      return { drafts, a, b };
    }

    it("keeps row A's entry while its save is on its way", () => {
      const { drafts } = twoRows();
      expect(drafts.has("a")).toBe(true);
    });

    it("lands a deferred 409 on row A, with its text, and leaves B alone", () => {
      const { drafts, a, b } = twoRows();
      observationConflicted(a, row("Otra versión", "t9", "Lucía"));
      a.saving = false;
      releaseObservationDraft(drafts, "a");
      expect(drafts.get("a")).toBe(a);
      expect(a.draft).toBe("Lo que dijo la Mesa");
      expect(a.conflict).toEqual({
        name: "Lucía",
        text: "Otra versión",
        token: "t9",
      });
      expect(b.draft).toBe("Nota de B, ampliada");
      expect(b.conflict).toBeNull();
      expect(unsavedObservationIds(drafts).sort()).toEqual(["a", "b"]);
    });

    it("keeps row A's text when the network failed", () => {
      const { drafts, a } = twoRows();
      a.saving = false;
      releaseObservationDraft(drafts, "a");
      expect(drafts.get("a")?.draft).toBe("Lo que dijo la Mesa");
      expect(observationUnsaved(a)).toBe(true);
      expect(unsavedObservationIds(drafts)).toContain("a");
    });

    it("drops row A's entry once saved", () => {
      const { drafts, a } = twoRows();
      observationSaved(a, a.draft, row("Lo que dijo la Mesa", "t2"), 1);
      a.saving = false;
      releaseObservationDraft(drafts, "a");
      expect(drafts.has("a")).toBe(false);
      expect(unsavedObservationIds(drafts)).toEqual(["b"]);
    });
  });

  it("drops an entry with nothing to keep, and keeps one in conflict", () => {
    const drafts = new Map<string, ObservationDraft>();
    drafts.set("clean", newObservationDraft(row("x", "t1")));
    const conflicted = newObservationDraft(row("x", "t1"));
    conflicted.conflict = { name: null, text: "y", token: "t2" };
    drafts.set("conflicted", conflicted);
    releaseObservationDraft(drafts, "clean");
    releaseObservationDraft(drafts, "conflicted");
    expect([...drafts.keys()]).toEqual(["conflicted"]);
    expect(keepsObservationDraft(conflicted)).toBe(true);
    // A conflict is unsaved even with the draft equal to the base.
    expect(observationDirty(conflicted)).toBe(false);
    expect(observationUnsaved(conflicted)).toBe(true);
  });

  it("chooses between the two versions", () => {
    const mine = newObservationDraft(row("Base", "t1"));
    mine.draft = "La mía";
    observationConflicted(mine, row("La suya", "t2", "Ana"));
    keepMyObservations(mine);
    expect(mine.conflict).toBeNull();
    expect(mine.base).toEqual({ text: "La suya", token: "t2" });
    expect(mine.draft).toBe("La mía");
    expect(observationDirty(mine)).toBe(true);

    const theirs = newObservationDraft(row("Base", "t1"));
    theirs.draft = "La mía";
    observationConflicted(theirs, row("La suya", "t2", "Ana"));
    takeTheirObservations(theirs);
    expect(theirs.conflict).toBeNull();
    expect(theirs.draft).toBe("La suya");
    expect(observationUnsaved(theirs)).toBe(false);
  });
});

describe("settledWithin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says a save that answers in time settled, even when it failed", async () => {
    await expect(settledWithin(Promise.resolve(true), 1000)).resolves.toBe(
      true,
    );
    await expect(
      settledWithin(Promise.reject(new Error("network")), 1000),
    ).resolves.toBe(true);
  });

  it("stops waiting for a save that hangs", async () => {
    vi.useFakeTimers();
    const hanging = new Promise<boolean>(() => {});
    const waited = settledWithin(hanging, LEAVE_SAVE_WAIT_MS);
    await vi.advanceTimersByTimeAsync(LEAVE_SAVE_WAIT_MS);
    await expect(waited).resolves.toBe(false);
  });

  it("clears its timer once the save answers", async () => {
    vi.useFakeTimers();
    await expect(
      settledWithin(Promise.resolve(true), LEAVE_SAVE_WAIT_MS),
    ).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
