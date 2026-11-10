import { describe, expect, it } from "vitest";
import { AMENDMENT_KINDS, AMENDMENT_STATUSES } from "../constants/domain";
import {
  canReclassifyAmendment,
  RECLASSIFIABLE_KINDS,
  reclassifyTarget,
} from "./amendmentReclassify";
import { reclassifyBodySchema } from "./schemas/amendment";

describe("reclassifyTarget", () => {
  it("moves between form and content, and back", () => {
    expect(reclassifyTarget("partial")).toBe("formal");
    expect(reclassifyTarget("formal")).toBe("partial");
    for (const kind of RECLASSIFIABLE_KINDS) {
      expect(reclassifyTarget(reclassifyTarget(kind)!)).toBe(kind);
    }
  });

  it("leaves totality amendments and transactionals alone", () => {
    expect(reclassifyTarget("totality_return")).toBeNull();
    expect(reclassifyTarget("totality_alternative")).toBeNull();
    expect(reclassifyTarget("transactional")).toBeNull();
    // Every kind is either reclassifiable or not: none is forgotten.
    for (const kind of AMENDMENT_KINDS) {
      expect(reclassifyTarget(kind) !== null).toBe(
        (RECLASSIFIABLE_KINDS as readonly string[]).includes(kind),
      );
    }
  });
});

describe("canReclassifyAmendment", () => {
  it("only while presented and undecided", () => {
    for (const status of AMENDMENT_STATUSES) {
      expect(canReclassifyAmendment({ kind: "partial", status }, false)).toBe(
        status === "submitted",
      );
    }
  });

  it("never once the document is voted, nor for other kinds", () => {
    expect(
      canReclassifyAmendment({ kind: "formal", status: "submitted" }, true),
    ).toBe(false);
    expect(
      canReclassifyAmendment(
        { kind: "transactional", status: "submitted" },
        false,
      ),
    ).toBe(false);
    expect(
      canReclassifyAmendment(
        { kind: "totality_return", status: "submitted" },
        false,
      ),
    ).toBe(false);
  });
});

describe("reclassifyBodySchema", () => {
  const updatedAt = "2026-11-01T10:00:00.000Z";

  it("takes the two kinds and the version the client saw", () => {
    expect(reclassifyBodySchema.parse({ kind: "formal", updatedAt })).toEqual({
      kind: "formal",
      updatedAt,
    });
    expect(
      reclassifyBodySchema.safeParse({ kind: "partial", updatedAt }).success,
    ).toBe(true);
  });

  it("refuses any other kind and a missing version", () => {
    for (const kind of ["transactional", "totality_return", "", null]) {
      expect(reclassifyBodySchema.safeParse({ kind, updatedAt }).success).toBe(
        false,
      );
    }
    expect(reclassifyBodySchema.safeParse({ kind: "formal" }).success).toBe(
      false,
    );
  });
});
