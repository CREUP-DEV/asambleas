import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS, MEMBER_KINDS } from "../constants/domain";
import { barredPresenters, memberMayPresent } from "./presenterKinds";

describe("memberMayPresent", () => {
  it("bars sectorials from internal motions only", () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(memberMayPresent(kind, "sectorial")).toBe(
        kind !== "internal_motion",
      );
    }
  });

  it("lets every other member present every kind", () => {
    for (const memberKind of MEMBER_KINDS.filter((k) => k !== "sectorial")) {
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
