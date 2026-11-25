import { describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { testActor } from "../../testing/actor";

// Who opens the validation inbox (GET .../review): whoever validates
// documents or amendments, and nobody else.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { requireReviewQueue } = await import("./review");

describe("requireReviewQueue", () => {
  it("lets document and amendment reviewers through, and an Admin", () => {
    for (const actor of [
      testActor({ permissions: [PERMISSION_KEYS.DOCUMENT_MANAGE] }),
      testActor({ permissions: [PERMISSION_KEYS.AMENDMENT_REVIEW] }),
      // amendment:manage holds amendment:review (PERMISSION_IMPLIED_BY).
      testActor({ permissions: [PERMISSION_KEYS.AMENDMENT_MANAGE] }),
      testActor({ role: SYSTEM_ROLES.ADMIN }),
    ]) {
      expect(() => requireReviewQueue(actor)).not.toThrow();
    }
  });

  it("refuses anyone else", () => {
    for (const actor of [
      testActor(),
      testActor({ permissions: [PERMISSION_KEYS.SESSION_MODERATE] }),
      testActor({ permissions: [PERMISSION_KEYS.CONTROL_SHEET_EDIT] }),
    ]) {
      expect(() => requireReviewQueue(actor)).toThrow(
        expect.objectContaining({ statusCode: 403 }),
      );
    }
  });
});
