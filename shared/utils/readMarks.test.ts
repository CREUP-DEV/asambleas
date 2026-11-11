import { describe, expect, it } from "vitest";
import type { ReadMarksDto } from "../types/api";
import {
  hasSomethingLeft,
  indexReadMarks,
  readNeighbours,
  readProgress,
  readStateOf,
} from "./readMarks";

const marks: ReadMarksDto = {
  documents: [
    { id: "a", state: "read", own: false },
    { id: "b", state: "unread", own: false },
    { id: "c", state: "changed", own: false },
    { id: "d", state: "unread", own: true },
    { id: "e", state: "read", own: false },
  ],
  amendments: [
    { id: "a1", documentId: "a", state: "unread", own: false, open: true },
    { id: "a2", documentId: "a", state: "unread", own: true, open: true },
    { id: "a3", documentId: "a", state: "unread", own: false, open: false },
    { id: "e1", documentId: "e", state: "read", own: false, open: true },
  ],
};

describe("readStateOf", () => {
  it("is unread without a mark", () => {
    expect(readStateOf(null, "r1")).toBe("unread");
    expect(readStateOf(undefined, "r1")).toBe("unread");
  });

  it("is read only for the revision on show", () => {
    expect(readStateOf("r1", "r1")).toBe("read");
    expect(readStateOf("r1", "r2")).toBe("changed");
  });
});

describe("readProgress", () => {
  it("leaves out the account's own and the amendments already decided", () => {
    expect(readProgress(marks)).toEqual({
      documents: 4,
      documentsLeft: 2,
      amendments: 2,
      amendmentsLeft: 1,
    });
  });

  it("is empty without marks", () => {
    expect(readProgress(null)).toEqual({
      documents: 0,
      documentsLeft: 0,
      amendments: 0,
      amendmentsLeft: 0,
    });
  });
});

describe("hasSomethingLeft", () => {
  const index = indexReadMarks(marks);

  it("counts a read document with an amendment left", () => {
    expect(hasSomethingLeft(index, "a")).toBe(true);
    expect(index.amendmentsLeft.get("a")).toBe(1);
  });

  it("never counts the account's own document nor a read one", () => {
    expect(hasSomethingLeft(index, "d")).toBe(false);
    expect(hasSomethingLeft(index, "e")).toBe(false);
    expect(hasSomethingLeft(index, "unknown")).toBe(false);
  });
});

describe("readNeighbours", () => {
  const index = indexReadMarks(marks);
  const ordered = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

  it("walks the documents in order", () => {
    const at = readNeighbours(ordered, "b", index);
    expect(at.index).toBe(1);
    expect(at.total).toBe(5);
    expect(at.previous?.id).toBe("a");
    expect(at.next?.id).toBe("c");
  });

  it("has no previous at the start and no next at the end", () => {
    expect(readNeighbours(ordered, "a", index).previous).toBeNull();
    expect(readNeighbours(ordered, "e", index).next).toBeNull();
  });

  it("finds the next one with something left, going round", () => {
    expect(readNeighbours(ordered, "b", index).nextLeft?.id).toBe("c");
    expect(readNeighbours(ordered, "c", index).nextLeft?.id).toBe("a");
    expect(readNeighbours(ordered, "e", index).nextLeft?.id).toBe("a");
  });

  it("never offers the document itself", () => {
    const only = indexReadMarks({
      documents: [{ id: "b", state: "unread", own: false }],
      amendments: [],
    });
    expect(readNeighbours(ordered, "b", only).nextLeft).toBeNull();
  });

  it("starts from the first one for a document that is not listed", () => {
    const at = readNeighbours(ordered, null, index);
    expect(at.index).toBe(-1);
    expect(at.nextLeft?.id).toBe("a");
  });
});
