import { describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { Actor } from "./actor";
import { testActor } from "../../testing/actor";

// The named guards the assembly routes call after resolveAssemblyRoute:
// who is refused (403) and who passes. requireCan is in actor.test.ts, the
// seating guards in seating.test.ts, requireReviewQueue in
// reviewQueue.test.ts.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { requireRecordManager } = await import("./agreementsRecord");
const { requireControlSheetReader } = await import("./controlSheet");
const { requireItemVoteReader } = await import("./itemVotes");

const admin = testActor({ role: SYSTEM_ROLES.ADMIN });
const nobody = testActor();
const holding = (...permissions: string[]) => testActor({ permissions });

function refuses(guard: (actor: Actor) => void, actor: Actor) {
  expect(() => guard(actor)).toThrow(
    expect.objectContaining({ statusCode: 403 }),
  );
}

describe("requireRecordManager (the acta de acuerdos)", () => {
  it("lets document managers and an Admin through", () => {
    expect(() =>
      requireRecordManager(holding(PERMISSION_KEYS.DOCUMENT_MANAGE)),
    ).not.toThrow();
    expect(() => requireRecordManager(admin)).not.toThrow();
  });

  it("refuses anyone else, the Mesa and the sheet's editors included", () => {
    refuses(requireRecordManager, nobody);
    refuses(requireRecordManager, holding(PERMISSION_KEYS.SESSION_MODERATE));
    refuses(requireRecordManager, holding(PERMISSION_KEYS.CONTROL_SHEET_EDIT));
    refuses(requireRecordManager, holding(PERMISSION_KEYS.ASSEMBLY_MANAGE));
  });
});

describe("requireControlSheetReader", () => {
  it("lets the sheet's readers and an Admin through", () => {
    for (const actor of [
      holding(PERMISSION_KEYS.CONTROL_SHEET_VIEW),
      // control_sheet:edit holds control_sheet:view.
      holding(PERMISSION_KEYS.CONTROL_SHEET_EDIT),
      admin,
    ]) {
      expect(() => requireControlSheetReader(actor)).not.toThrow();
    }
  });

  it("refuses an account without a sheet key", () => {
    refuses(requireControlSheetReader, nobody);
    refuses(
      requireControlSheetReader,
      holding(PERMISSION_KEYS.ASSEMBLY_MANAGE),
    );
  });
});

describe("requireItemVoteReader", () => {
  it("lets the Mesa, the sheet's readers and an Admin through", () => {
    for (const actor of [
      holding(PERMISSION_KEYS.SESSION_MODERATE),
      holding(PERMISSION_KEYS.CONTROL_SHEET_VIEW),
      admin,
    ]) {
      expect(() => requireItemVoteReader(actor)).not.toThrow();
    }
  });

  it("refuses anyone else", () => {
    refuses(requireItemVoteReader, nobody);
    refuses(requireItemVoteReader, holding(PERMISSION_KEYS.DOCUMENT_MANAGE));
  });
});
