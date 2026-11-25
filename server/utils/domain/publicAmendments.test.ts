import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { AMENDMENT_STATUSES } from "~~/shared/constants/domain";
import type { Actor } from "./actor";

// Only the pure rules run here: the loaders need the database.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const {
  NEVER_PUBLIC_AMENDMENT_STATUSES,
  isPublicAmendment,
  publicAmendmentWhere,
} = await import("./publicAmendments");
const { canSeeAmendment } = await import("./visibility");

/** Someone who sees the assembly and nothing more: no role, key nor member. */
const PUBLIC_READER: Actor = {
  user: {
    id: "r".repeat(32),
    name: "Reader",
    email: "reader@example.org",
    image: null,
    roleId: null,
    externalRole: null,
    externalName: null,
    externalInitials: null,
    university: null,
    memberId: null,
    lastRoleSyncAt: null,
    role: null,
  },
  memberId: null,
  memberKind: null,
  isAdmin: false,
  permissions: [],
  can: () => false,
  impersonation: null,
};

const PUBLISHED_AT = new Date("2026-11-20T10:00:00Z");

function amendment(
  status: (typeof AMENDMENT_STATUSES)[number],
  publishedAt: Date | null,
) {
  return {
    kind: "partial" as const,
    status,
    publishedAt,
    validatedAt: publishedAt,
    documentPresenters: { proponentMemberId: null, coProponentMemberIds: [] },
    createdByUserId: "c".repeat(32),
    authorMemberIds: ["m".repeat(24)],
    partyMemberIds: [],
  };
}

describe("isPublicAmendment", () => {
  it("is what canSeeAmendment lets a plain reader see, for every status", () => {
    for (const status of AMENDMENT_STATUSES) {
      for (const publishedAt of [null, PUBLISHED_AT]) {
        const row = amendment(status, publishedAt);
        expect(
          isPublicAmendment(row),
          `${status}, ${publishedAt ? "published" : "unpublished"}`,
        ).toBe(canSeeAmendment(PUBLIC_READER, row));
      }
    }
  });

  it("never makes a withdrawn or draft amendment public, published or not", () => {
    for (const status of ["draft", "withdrawn"] as const) {
      expect(isPublicAmendment(amendment(status, PUBLISHED_AT))).toBe(false);
    }
  });

  it("makes every other published amendment public, and no unpublished one", () => {
    for (const status of AMENDMENT_STATUSES) {
      if (NEVER_PUBLIC_AMENDMENT_STATUSES.includes(status)) continue;
      expect(isPublicAmendment(amendment(status, PUBLISHED_AT)), status).toBe(
        true,
      );
      expect(isPublicAmendment(amendment(status, null)), status).toBe(false);
    }
  });
});

describe("publicAmendmentWhere", () => {
  it("excludes the statuses that are never public and asks for publishedAt", () => {
    const query = new PgDialect().sqlToQuery(publicAmendmentWhere());
    expect(query.sql).toMatch(/"status" not in \(\$1, \$2\)/);
    expect(query.sql).toMatch(/"published_at" is not null/);
    expect([...query.params].sort()).toEqual(
      [...NEVER_PUBLIC_AMENDMENT_STATUSES].sort(),
    );
  });
});
