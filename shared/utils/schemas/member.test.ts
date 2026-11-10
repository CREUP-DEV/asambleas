import { describe, expect, it } from "vitest";
import type { MemberSyncBody } from "../../types/api";
import {
  MEMBER_LIST_FOR_AMENDMENT,
  memberListQuerySchema,
  memberSyncBodySchema,
} from "./member";

describe("memberSyncBodySchema", () => {
  const none = { confirmDeactivation: false, confirmedKinds: [] };

  it("treats a missing or empty body as no confirmation", () => {
    expect(memberSyncBodySchema.parse(undefined)).toEqual(none);
    expect(memberSyncBodySchema.parse(null)).toEqual(none);
    expect(memberSyncBodySchema.parse({})).toEqual(none);
  });

  it("keeps the confirmation of a large deactivation and its counts", () => {
    const body: MemberSyncBody = {
      confirmDeactivation: true,
      confirmedKinds: [
        { kind: "asociado", toDeactivate: 5 },
        { kind: "sectorial", toDeactivate: 12 },
      ],
    };
    expect(memberSyncBodySchema.parse(body)).toEqual(body);
    expect(memberSyncBodySchema.parse({ confirmDeactivation: true })).toEqual({
      confirmDeactivation: true,
      confirmedKinds: [],
    });
    expect(memberSyncBodySchema.parse({ confirmDeactivation: false })).toEqual(
      none,
    );
  });

  it("drops counts sent without the confirmation", () => {
    expect(
      memberSyncBodySchema.parse({
        confirmedKinds: [{ kind: "asociado", toDeactivate: 5 }],
      }),
    ).toEqual(none);
  });

  it("rejects malformed or repeated counts", () => {
    for (const confirmedKinds of [
      [{ kind: "executive", toDeactivate: 1 }],
      [{ kind: "asociado", toDeactivate: -1 }],
      [{ kind: "asociado", toDeactivate: 1.5 }],
      [{ kind: "asociado", toDeactivate: "5" }],
      [{ kind: "asociado", toDeactivate: 5, active: 10 }],
      [
        { kind: "asociado", toDeactivate: 5 },
        { kind: "asociado", toDeactivate: 6 },
      ],
      "asociado",
    ]) {
      expect(
        memberSyncBodySchema.safeParse({
          confirmDeactivation: true,
          confirmedKinds,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects anything but a boolean confirmation", () => {
    for (const confirmDeactivation of ["true", 1, "yes"]) {
      expect(
        memberSyncBodySchema.safeParse({ confirmDeactivation }).success,
      ).toBe(false);
    }
    expect(memberSyncBodySchema.safeParse("confirm").success).toBe(false);
  });
});

describe("memberListQuerySchema", () => {
  it("takes the list of the amendment composers and nothing else", () => {
    expect(memberListQuerySchema.parse({})).toEqual({
      all: false,
      guests: false,
    });
    expect(
      memberListQuerySchema.parse({ for: MEMBER_LIST_FOR_AMENDMENT }),
    ).toEqual({ all: false, guests: false, for: "amendment" });
    expect(memberListQuerySchema.parse({ guests: "1" }).guests).toBe(true);
    expect(memberListQuerySchema.safeParse({ for: "document" }).success).toBe(
      false,
    );
  });
});
