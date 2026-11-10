import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS, MEMBER_KINDS } from "../constants/domain";
import { barredPresenters, memberMayPresent } from "./presenterKinds";

describe("memberMayPresent", () => {
  it("bars sectorials and the other members (the CAS) from internal motions only", () => {
    for (const memberKind of ["sectorial", "other"] as const) {
      for (const kind of DOCUMENT_KINDS) {
        expect(memberMayPresent(kind, memberKind)).toBe(
          kind !== "internal_motion",
        );
      }
    }
  });

  it("lets councils and the CEA's offices present every kind", () => {
    for (const memberKind of MEMBER_KINDS.filter(
      (k) => k !== "sectorial" && k !== "other",
    )) {
      for (const kind of DOCUMENT_KINDS) {
        expect(memberMayPresent(kind, memberKind)).toBe(true);
      }
    }
  });
});

describe("barredPresenters", () => {
  const presenters = [
    { acronym: "CEUM", kind: "asociado" as const },
    { acronym: "AEEE", kind: "sectorial" as const },
    { acronym: "VPU", kind: "executive" as const },
  ];

  it("names the sectorials of an internal motion", () => {
    expect(barredPresenters("internal_motion", presenters)).toEqual([
      { acronym: "AEEE", kind: "sectorial" },
    ]);
  });

  it("names nobody for any other kind", () => {
    expect(barredPresenters("resolution", presenters)).toEqual([]);
  });
});
