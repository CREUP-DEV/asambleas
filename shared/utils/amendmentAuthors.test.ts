import { describe, expect, it } from "vitest";
import { AMENDMENT_STATUSES } from "../constants/domain";
import {
  authorsChange,
  canChangeAmendmentAuthors,
  authorsChangeSide,
  formerMemberSeq,
} from "./amendmentAuthors";
import { amendmentAuthorsBodySchema } from "./schemas/amendment";

describe("canChangeAmendmentAuthors", () => {
  it("only for a presented, undecided amendment", () => {
    for (const status of AMENDMENT_STATUSES) {
      expect(canChangeAmendmentAuthors({ status }, false)).toBe(
        status === "submitted",
      );
    }
  });

  it("never once the document is voted", () => {
    expect(canChangeAmendmentAuthors({ status: "submitted" }, true)).toBe(
      false,
    );
  });
});

describe("authorsChange", () => {
  const base = { currentIds: ["a", "b"], currentMain: "a" };

  it("is null when nothing changes, whatever the order", () => {
    expect(
      authorsChange({ ...base, nextIds: ["b", "a"], nextMain: "a" }),
    ).toBeNull();
  });

  it("says who was added and removed", () => {
    expect(
      authorsChange({ ...base, nextIds: ["a", "c"], nextMain: "a" }),
    ).toEqual({ added: ["c"], removed: ["b"], mainChanged: false });
  });

  it("notices a new main author among the same authors", () => {
    expect(
      authorsChange({ ...base, nextIds: ["a", "b"], nextMain: "b" }),
    ).toEqual({ added: [], removed: [], mainChanged: true });
  });
});

describe("amendmentAuthorsBodySchema", () => {
  const updatedAt = "2026-01-01T10:00:00.000Z";
  const a = "a".repeat(24);
  const b = "b".repeat(24);

  it("takes the authors, the main one and the version seen", () => {
    expect(
      amendmentAuthorsBodySchema.parse({
        authorMemberIds: [a, b],
        mainAuthorMemberId: a,
        updatedAt,
      }),
    ).toEqual({ authorMemberIds: [a, b], mainAuthorMemberId: a, updatedAt });
  });

  it("needs an author, a main author and the version", () => {
    const parse = (body: unknown) =>
      amendmentAuthorsBodySchema.safeParse(body).success;
    expect(
      parse({ authorMemberIds: [], mainAuthorMemberId: a, updatedAt }),
    ).toBe(false);
    expect(parse({ authorMemberIds: [a], updatedAt })).toBe(false);
    expect(parse({ authorMemberIds: [a], mainAuthorMemberId: a })).toBe(false);
    expect(
      parse({ authorMemberIds: [a, a], mainAuthorMemberId: a, updatedAt }),
    ).toBe(false);
  });
});

describe("formerMemberSeq", () => {
  it("reads the number of a code of the sequence", () => {
    expect(formerMemberSeq("CEUM 2", "CEUM")).toBe(2);
    expect(formerMemberSeq("CEA 12", "CEA")).toBe(12);
  });

  it("ignores codes of other sequences and anything that is not a code", () => {
    expect(formerMemberSeq("CEUMA 2", "CEUM")).toBeNull();
    expect(formerMemberSeq("CEUM 2", "CEUMA")).toBeNull();
    expect(formerMemberSeq("T 1", "CEUM")).toBeNull();
    expect(formerMemberSeq("CEUM 0", "CEUM")).toBeNull();
    expect(formerMemberSeq("CEUM 2b", "CEUM")).toBeNull();
    expect(formerMemberSeq(undefined, "CEUM")).toBeNull();
    expect(formerMemberSeq(null, "CEUM")).toBeNull();
  });
});

describe("authorsChangeSide", () => {
  const names: Record<string, string> = { a: "CEUM", b: "UGR", c: "CEA" };
  const nameOf = (id: string) => names[id] ?? null;

  it("puts the main author first and the others by name", () => {
    expect(
      authorsChangeSide(
        { authorMemberIds: ["c", "b", "a"], mainAuthorId: "b" },
        nameOf,
      ),
    ).toEqual({ names: ["UGR", "CEA", "CEUM"], main: true });
  });

  it("marks no main author on a single member", () => {
    expect(
      authorsChangeSide({ authorMemberIds: ["a"], mainAuthorId: "a" }, nameOf),
    ).toEqual({ names: ["CEUM"], main: false });
  });

  it("is null when a member cannot be named or the side is malformed", () => {
    expect(
      authorsChangeSide(
        { authorMemberIds: ["a", "z"], mainAuthorId: "a" },
        nameOf,
      ),
    ).toBeNull();
    expect(authorsChangeSide(undefined, nameOf)).toBeNull();
    expect(authorsChangeSide({ authorMemberIds: [] }, nameOf)).toBeNull();
    expect(authorsChangeSide({ authorMemberIds: "a" }, nameOf)).toBeNull();
  });
});
