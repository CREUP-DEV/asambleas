import { describe, expect, it } from "vitest";
import { readStateOf } from "~~/shared/utils/readMarks";
import { documentRevision } from "./readMarks";

describe("documentRevision", () => {
  it("follows a document's base version and its PDF", () => {
    const before = documentRevision({
      baseVersionId: "v1",
      fileUrl: null,
      generated: null,
    });
    expect(
      documentRevision({ baseVersionId: "v2", fileUrl: null, generated: null }),
    ).not.toBe(before);
    expect(
      documentRevision({
        baseVersionId: "v1",
        fileUrl: "a.pdf",
        generated: null,
      }),
    ).not.toBe(before);
  });

  it("leaves the acta de acuerdos' base out: read once, it stays read", () => {
    // Written again from the votes after each item vote (user's decision
    // of 2026-11-24).
    const acta = (baseVersionId: string | null) =>
      documentRevision({
        baseVersionId,
        fileUrl: null,
        generated: "agreements_record",
      });
    const marked = acta("v1");
    expect(readStateOf(marked, acta("v2"))).toBe("read");
    expect(readStateOf(marked, acta("v7"))).toBe("read");
    expect(readStateOf(undefined, acta("v2"))).toBe("unread");
    // A PDF put in its place is new to read.
    expect(
      documentRevision({
        baseVersionId: "v2",
        fileUrl: "acta.pdf",
        generated: "agreements_record",
      }),
    ).not.toBe(marked);
  });
});
