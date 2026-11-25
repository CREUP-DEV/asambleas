import { describe, expect, it } from "vitest";
import {
  DRAFT_COPY_MAX_AGE_MS,
  draftCopyFingerprint,
  draftCopyKey,
  dropDraftCopy,
  isAmendmentComposerCopy,
  isDraftCopyRename,
  isTransactionalComposerCopy,
  pruneDraftCopies,
  readDraftCopy,
  sameIdList,
  writeDraftCopy,
  type AmendmentComposerCopy,
  type DraftCopyPlace,
  type DraftCopyStorage,
  type TransactionalComposerCopy,
} from "./draftCopy";

/** A localStorage stand-in over a Map. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const storage: DraftCopyStorage = {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
  return { storage, items };
}

/** A storage that refuses everything (private mode, blocked site data). */
const blocked: DraftCopyStorage = {
  get length(): number {
    throw new Error("blocked");
  },
  key: () => {
    throw new Error("blocked");
  },
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

const NOW = Date.parse("2026-11-25T10:00:00Z");
const stamp = { baseVersionId: "v1", token: null };
const key = draftCopyKey({
  composer: "amendment",
  userId: "u1",
  documentId: "d1",
  scope: "new-document",
});

describe("draftCopyKey", () => {
  it("is versioned and names the composer, account, document and draft", () => {
    expect(key).toBe("composer-copy:v1:amendment:u1:d1:new-document");
    expect(
      draftCopyKey({
        composer: "session-transactional",
        userId: "u1",
        documentId: "d1",
        scope: "new",
      }),
    ).not.toBe(key);
  });
});

describe("isDraftCopyRename", () => {
  const place: DraftCopyPlace = {
    composer: "amendment",
    userId: "u1",
    documentId: "d1",
    scope: "new-document",
  };
  const saved: DraftCopyPlace = { ...place, scope: "a1" };
  const newDraftGotItsId = (from: string) => from === "new-document";

  it("is a new draft that got its id, when the composer says so", () => {
    expect(isDraftCopyRename(place, saved, newDraftGotItsId)).toBe(true);
  });

  it("never renames for a composer that does not rename", () => {
    // An inclusion whose transactional left the list: not the same work.
    expect(
      isDraftCopyRename(
        { ...place, composer: "transactional", scope: "revise-t1" },
        { ...place, composer: "transactional", scope: "new" },
        undefined,
      ),
    ).toBe(false);
    expect(
      isDraftCopyRename(saved, { ...saved, scope: "a2" }, newDraftGotItsId),
    ).toBe(false);
  });

  it("keeps the copy when the account goes (sign-out, expired session)", () => {
    expect(isDraftCopyRename(place, null, newDraftGotItsId)).toBe(false);
    expect(isDraftCopyRename(null, saved, newDraftGotItsId)).toBe(false);
    expect(
      isDraftCopyRename(place, { ...saved, userId: "u2" }, newDraftGotItsId),
    ).toBe(false);
  });

  it("keeps the copy on another document or with the same scope", () => {
    expect(
      isDraftCopyRename(
        place,
        { ...saved, documentId: "d2" },
        newDraftGotItsId,
      ),
    ).toBe(false);
    expect(isDraftCopyRename(place, { ...place }, () => true)).toBe(false);
    expect(
      isDraftCopyRename(
        { ...place, composer: "session-transactional", scope: "new" },
        {
          ...place,
          composer: "session-transactional",
          documentId: "d2",
          scope: "new",
        },
        () => true,
      ),
    ).toBe(false);
  });
});

describe("writeDraftCopy and readDraftCopy", () => {
  it("reads back what was written, with its time and stamp", () => {
    const { storage } = memoryStorage();
    expect(writeDraftCopy(storage, key, { a: 1 }, stamp, NOW)).toBe(true);
    expect(readDraftCopy(storage, key, stamp, NOW + 1000)).toEqual({
      savedAt: "2026-11-25T10:00:00.000Z",
      baseVersionId: "v1",
      token: null,
      data: { a: 1 },
    });
  });

  it("returns null when there is none", () => {
    const { storage } = memoryStorage();
    expect(readDraftCopy(storage, key, stamp, NOW)).toBeNull();
    expect(readDraftCopy(null, key, stamp, NOW)).toBeNull();
  });

  it("drops a copy past its age", () => {
    const { storage, items } = memoryStorage();
    writeDraftCopy(storage, key, { a: 1 }, stamp, NOW);
    expect(
      readDraftCopy(storage, key, stamp, NOW + DRAFT_COPY_MAX_AGE_MS + 1),
    ).toBeNull();
    expect(items.has(key)).toBe(false);
  });

  it("drops a copy written over another base version", () => {
    const { storage, items } = memoryStorage();
    writeDraftCopy(storage, key, { a: 1 }, stamp, NOW);
    expect(
      readDraftCopy(storage, key, { baseVersionId: "v2", token: null }, NOW),
    ).toBeNull();
    expect(items.has(key)).toBe(false);
  });

  it("drops a copy of a stored draft someone saved since", () => {
    const { storage, items } = memoryStorage();
    const mine = { baseVersionId: "v1", token: "2026-11-25T09:00:00.000Z" };
    writeDraftCopy(storage, key, { a: 1 }, mine, NOW);
    expect(readDraftCopy(storage, key, mine, NOW)).not.toBeNull();
    expect(
      readDraftCopy(
        storage,
        key,
        { baseVersionId: "v1", token: "2026-11-25T09:30:00.000Z" },
        NOW,
      ),
    ).toBeNull();
    expect(items.has(key)).toBe(false);
  });

  it("drops what it cannot read", () => {
    for (const raw of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ savedAt: "yesterday", data: {} }),
      JSON.stringify({ savedAt: "2026-11-25T09:00:00Z" }),
      JSON.stringify({ savedAt: "2026-11-25T09:00:00Z", data: null }),
    ]) {
      const { storage, items } = memoryStorage({ [key]: raw });
      expect(readDraftCopy(storage, key, stamp, NOW)).toBeNull();
      expect(items.has(key)).toBe(false);
    }
  });

  it("never throws on a blocked or full storage", () => {
    expect(writeDraftCopy(blocked, key, { a: 1 }, stamp, NOW)).toBe(false);
    expect(readDraftCopy(blocked, key, stamp, NOW)).toBeNull();
    expect(() => dropDraftCopy(blocked, key)).not.toThrow();
    expect(() => pruneDraftCopies(blocked, NOW)).not.toThrow();
    expect(writeDraftCopy(null, key, { a: 1 }, stamp, NOW)).toBe(false);
  });
});

describe("dropDraftCopy", () => {
  it("removes one copy only", () => {
    const { storage, items } = memoryStorage({ [key]: "x", other: "y" });
    dropDraftCopy(storage, key);
    expect([...items.keys()]).toEqual(["other"]);
  });
});

describe("pruneDraftCopies", () => {
  it("removes expired, unreadable and older-version copies, nothing else", () => {
    const { storage, items } = memoryStorage({
      "composer-copy:v0:amendment:u1:d1:new-document": "{}",
      "composer-copy:v1:amendment:u1:d2:new-document": "broken",
      "session-headcount-draft-a1": JSON.stringify({ savedAt: "2020-01-01" }),
      "a11y-preferences": "{}",
    });
    const fresh = draftCopyKey({
      composer: "transactional",
      userId: "u1",
      documentId: "d1",
      scope: "new",
    });
    const old = draftCopyKey({
      composer: "transactional",
      userId: "u1",
      documentId: "d3",
      scope: "new",
    });
    writeDraftCopy(storage, fresh, { a: 1 }, stamp, NOW - 1000);
    writeDraftCopy(
      storage,
      old,
      { a: 1 },
      stamp,
      NOW - DRAFT_COPY_MAX_AGE_MS - 1,
    );
    pruneDraftCopies(storage, NOW);
    expect([...items.keys()].sort()).toEqual(
      [fresh, "a11y-preferences", "session-headcount-draft-a1"].sort(),
    );
  });
});

const amendmentCopy: AmendmentComposerCopy = {
  ops: [{ op: "delete", blockIds: ["b1"] }],
  find: "",
  replace: "",
  kind: "partial",
  justification: "Porque sí",
  withOthers: true,
  coAuthorIds: ["m2"],
  mainAuthorId: "m2",
  onBehalfOfMemberId: null,
};

describe("isAmendmentComposerCopy", () => {
  it("takes the amendment composer's shape", () => {
    expect(isAmendmentComposerCopy(amendmentCopy)).toBe(true);
    expect(isAmendmentComposerCopy({ ...amendmentCopy, kind: null })).toBe(
      true,
    );
  });

  it("refuses anything else", () => {
    expect(isAmendmentComposerCopy(null)).toBe(false);
    expect(isAmendmentComposerCopy([])).toBe(false);
    expect(isAmendmentComposerCopy({ ...amendmentCopy, ops: {} })).toBe(false);
    expect(isAmendmentComposerCopy({ ...amendmentCopy, ops: [1] })).toBe(false);
    expect(isAmendmentComposerCopy({ ...amendmentCopy, kind: "other" })).toBe(
      false,
    );
    expect(
      isAmendmentComposerCopy({ ...amendmentCopy, coAuthorIds: [1] }),
    ).toBe(false);
    const { justification: _, ...withoutWhy } = amendmentCopy;
    expect(isAmendmentComposerCopy(withoutWhy)).toBe(false);
  });
});

const transactionalCopy: TransactionalComposerCopy = {
  sourceIds: ["a1", "a2"],
  widen: { before: 1, after: 0 },
  passageIds: ["b1", "b2"],
  edited: [{ id: "b1", type: "paragraph", text: "Hola", marks: [] }],
  justification: "",
  authorIds: [],
  authorsTouched: false,
  executiveAuthorIds: [],
  mainAuthorId: null,
};

describe("isTransactionalComposerCopy", () => {
  it("takes a transactional composer's shape", () => {
    expect(isTransactionalComposerCopy(transactionalCopy)).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isTransactionalComposerCopy(undefined)).toBe(false);
    expect(
      isTransactionalComposerCopy({
        ...transactionalCopy,
        widen: { before: -1, after: 0 },
      }),
    ).toBe(false);
    expect(
      isTransactionalComposerCopy({ ...transactionalCopy, edited: [{}] }),
    ).toBe(false);
    expect(
      isTransactionalComposerCopy({ ...transactionalCopy, sourceIds: "a1" }),
    ).toBe(false);
    expect(
      isTransactionalComposerCopy({
        ...transactionalCopy,
        authorsTouched: "no",
      }),
    ).toBe(false);
  });
});

describe("sameIdList", () => {
  it("compares ids in order", () => {
    expect(sameIdList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIdList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameIdList(["a"], ["a", "b"])).toBe(false);
    expect(sameIdList([], [])).toBe(true);
  });
});

describe("draftCopyFingerprint", () => {
  it("is stable for equal values and differs for others", () => {
    const ops = [{ op: "delete", blockIds: ["b1"] }];
    expect(draftCopyFingerprint(ops)).toBe(
      draftCopyFingerprint([{ op: "delete", blockIds: ["b1"] }]),
    );
    expect(draftCopyFingerprint(ops)).not.toBe(
      draftCopyFingerprint([{ op: "delete", blockIds: ["b2"] }]),
    );
    expect(draftCopyFingerprint(undefined)).toMatch(/^0:/);
  });
});
