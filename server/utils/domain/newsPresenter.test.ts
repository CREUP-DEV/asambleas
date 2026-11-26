import { describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

// What a document's presenters read of the amendments new to it
// (loadWorkNews): presenterNewsState against the real visibility rules.
// The loader itself needs the database.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("./amendments", () => ({
  canSeeLoadedAmendment: vi.fn(),
  findAmendmentsByIds: vi.fn(),
}));

const { isRepeatedArrival, presenterNewsState } = await import("./news");
const { canSeeAmendment, seesOthersValidatedAmendments } =
  await import("./visibility");
const { testActor } = await import("../../testing/actor");

const VALIDATED_AT = new Date("2026-11-04T10:00:00Z");
const PUBLISHED_AT = new Date("2026-11-05T10:00:00Z");
const document = { proponentMemberId: "main", coProponentMemberIds: ["co"] };

/** An amendment of another member to the document, as it stands now. */
const amendment = (
  over: Partial<{
    kind: "partial" | "transactional";
    status: "submitted" | "withdrawn" | "lapsed";
    validatedAt: Date | null;
    publishedAt: Date | null;
  }> = {},
) => ({
  kind: "partial" as const,
  status: "submitted" as const,
  validatedAt: VALIDATED_AT,
  publishedAt: PUBLISHED_AT as Date | null,
  documentPresenters: document,
  createdByUserId: "author-user",
  authorMemberIds: ["author"],
  partyMemberIds: [],
  ...over,
});

/** Whether the reader gets the row: visible now, and visible then. */
const told = (
  actor: ReturnType<typeof testActor>,
  type: string,
  row: ReturnType<typeof amendment>,
  at: Date,
  payload: Record<string, unknown> = {},
) =>
  canSeeAmendment(actor, row) &&
  canSeeAmendment(actor, {
    ...row,
    ...presenterNewsState(type, payload, row, at),
  }) &&
  !isRepeatedArrival(type, row, at, (state) =>
    canSeeAmendment(actor, { ...row, ...state }),
  );

describe("presenters' news against visibility", () => {
  const presenter = testActor({ memberId: "main", memberKind: "asociado" });
  const coPresenter = testActor({ memberId: "co", memberKind: "asociado" });
  const ceaOffice = testActor({
    role: SYSTEM_ROLES.CEA,
    memberId: "main",
    memberKind: "executive",
  });

  it("tells plain presenters an amendment once published, not on validation", () => {
    for (const actor of [presenter, coPresenter]) {
      expect(
        told(actor, "amendment_validated", amendment(), VALIDATED_AT),
      ).toBe(false);
      expect(
        told(actor, "amendment_published", amendment(), PUBLISHED_AT),
      ).toBe(true);
    }
  });

  it("tells plain presenters an amendment validated and published at once", () => {
    const atOnce = amendment({ publishedAt: VALIDATED_AT });
    for (const actor of [presenter, coPresenter]) {
      expect(
        told(actor, "amendment_validated", atOnce, VALIDATED_AT, {
          publish: true,
        }),
      ).toBe(true);
    }
  });

  it("tells an office of the CEA an amendment once, at validation, not again at publication", () => {
    // Only the publication loaded: the validation left the window or the
    // query's room.
    expect(
      told(ceaOffice, "amendment_published", amendment(), PUBLISHED_AT),
    ).toBe(false);
    // A plain presenter, who could not read it validated, is told now.
    expect(
      told(presenter, "amendment_published", amendment(), PUBLISHED_AT),
    ).toBe(true);
  });

  it("reads validated amendments of others exactly where canSeeAmendment does", () => {
    const validated = amendment({ publishedAt: null });
    const reviewer = testActor({
      memberId: "main",
      permissions: [PERMISSION_KEYS.AMENDMENT_REVIEW],
    });
    const moderator = testActor({
      memberId: "main",
      permissions: [PERMISSION_KEYS.SESSION_MODERATE],
    });
    for (const actor of [
      presenter,
      coPresenter,
      ceaOffice,
      reviewer,
      moderator,
    ]) {
      expect(seesOthersValidatedAmendments(actor)).toBe(
        canSeeAmendment(actor, validated),
      );
    }
  });

  it("tells them a transactional on validation, since they read it before its publication", () => {
    const transactional = amendment({
      kind: "transactional",
      publishedAt: null,
    });
    expect(
      told(presenter, "amendment_validated", transactional, VALIDATED_AT),
    ).toBe(true);
  });

  it("tells an office of the CEA an amendment on validation", () => {
    expect(
      told(
        ceaOffice,
        "amendment_validated",
        amendment({ publishedAt: null }),
        VALIDATED_AT,
      ),
    ).toBe(true);
  });

  it("tells a lapse only of one the presenter could read while it was open", () => {
    const lapsedAt = new Date("2026-11-06T10:00:00Z");
    expect(
      told(
        presenter,
        "amendment_lapsed",
        amendment({ status: "lapsed" }),
        lapsedAt,
      ),
    ).toBe(true);
    // Validated, never published: a plain presenter never read it.
    expect(
      told(
        presenter,
        "amendment_lapsed",
        amendment({ status: "lapsed", publishedAt: null }),
        lapsedAt,
      ),
    ).toBe(false);
  });

  it("never shows a withdrawn amendment to a plain presenter, its arrival included", () => {
    const withdrawn = amendment({ status: "withdrawn" });
    for (const type of ["amendment_published", "amendment_withdrawn"]) {
      expect(told(presenter, type, withdrawn, PUBLISHED_AT), type).toBe(false);
    }
    // The CEA's accounts read withdrawn amendments: its arrival (at
    // validation) and its withdrawal.
    expect(
      told(ceaOffice, "amendment_validated", withdrawn, VALIDATED_AT),
    ).toBe(true);
    expect(
      told(ceaOffice, "amendment_withdrawn", withdrawn, PUBLISHED_AT),
    ).toBe(true);
  });
});
