import { describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { Actor } from "./actor";
import type { LoadedAmendment, PositionRecorders } from "./amendments";
import type { DocumentPresenters } from "./visibility";

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { sheetPositions, visibleSheetAmendments } =
  await import("./controlSheet");
const { canSeePositions } = await import("./visibility");

const CEA_USER = "u".repeat(24);
const PRESENTER = "p".repeat(24);
const AUTHOR = "a".repeat(24);
const MESA_USER = "m".repeat(24);

function makeActor(role: string, permissions: string[] = []): Actor {
  return {
    user: {
      id: CEA_USER,
      name: "Presidencia",
      email: "pres@example.org",
      image: null,
      roleId: "role",
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: null,
      lastRoleSyncAt: null,
      role: { id: "role", name: role },
    },
    memberId: null,
    memberKind: null,
    isAdmin: false,
    permissions: permissions as Actor["permissions"],
    can: (key) => permissions.includes(key),
    impersonation: null,
  };
}

/** A CEA account that reads the sheet, not the Mesa nor a reviewer. */
const CEA_READER = makeActor(SYSTEM_ROLES.CEA, [
  PERMISSION_KEYS.CONTROL_SHEET_VIEW,
]);

const DOCUMENT: DocumentPresenters = {
  proponentMemberId: PRESENTER,
  coProponentMemberIds: [],
};

function amendment(
  id: string,
  over: Partial<LoadedAmendment> = {},
): LoadedAmendment {
  return {
    id,
    documentId: "doc",
    status: "submitted",
    publishedAt: new Date("2026-11-01T10:00:00Z"),
    validatedAt: new Date("2026-11-01T09:00:00Z"),
    createdByUserId: "creator",
    authors: [{ memberId: AUTHOR }],
    sources: [],
    acceptances: [],
    position: {
      position: "accept",
      comment: "De acuerdo",
      decidedByUserId: null,
      updatedAt: new Date("2026-11-02T12:00:00Z"),
    },
    ...over,
  } as never as LoadedAmendment;
}

const NO_RECORDERS: PositionRecorders = {
  recordedAs: new Map(),
  memberOf: new Map(),
};

describe("control sheet positions", () => {
  it("reach a sheet reader whom the assembly's rule hides them from", () => {
    // Before the answers are public, the CEA reads none elsewhere.
    expect(
      canSeePositions(CEA_READER, {
        document: {
          positionsPublishedAt: null,
          positionsDebateStartedAt: null,
        },
        isPresenter: false,
      }),
    ).toBe(false);
    const documents = new Map([["doc", DOCUMENT]]);
    const rows = visibleSheetAmendments(
      CEA_READER,
      [amendment("a1")],
      documents,
    );
    expect(sheetPositions(rows, documents, NO_RECORDERS)).toEqual([
      {
        amendmentId: "a1",
        position: {
          position: "accept",
          comment: "De acuerdo",
          recordedBy: "presenter",
          recorder: null,
          updatedAt: "2026-11-02T12:00:00.000Z",
        },
      },
    ]);
  });

  it("leave out amendments the reader does not see", () => {
    const documents = new Map([["doc", DOCUMENT]]);
    const rows = visibleSheetAmendments(
      CEA_READER,
      [
        // Presented, not validated yet: only its insiders, the Secretaría
        // and the Mesa read it.
        amendment("hidden", { validatedAt: null, publishedAt: null }),
        // Validated, unpublished: a sheet reader reads it.
        amendment("validated", { publishedAt: null }),
        // A document the reader does not see.
        amendment("other", { documentId: "elsewhere" }),
      ],
      documents,
    );
    expect(rows.map((row) => row.id)).toEqual(["validated"]);
    expect(
      sheetPositions(rows, documents, NO_RECORDERS).map(
        (entry) => entry.amendmentId,
      ),
    ).toEqual(["validated"]);
  });

  it("skip amendments without an answer row", () => {
    const documents = new Map([["doc", DOCUMENT]]);
    expect(
      sheetPositions(
        [amendment("a1", { position: undefined })],
        documents,
        NO_RECORDERS,
      ),
    ).toEqual([]);
  });

  it("say who recorded the answer as AmendmentDto.position does", () => {
    const documents = new Map([["doc", DOCUMENT]]);
    const recorders: PositionRecorders = {
      // The latest position_changed event says the Mesa recorded a1.
      recordedAs: new Map([["a1", "moderator"]]),
      // No event for a2 nor a3: their recorders' members decide.
      memberOf: new Map([
        [MESA_USER, null],
        [CEA_USER, PRESENTER],
      ]),
    };
    const answered = (id: string, decidedByUserId: string) =>
      amendment(id, {
        position: {
          position: "reject",
          comment: null,
          decidedByUserId,
          updatedAt: new Date("2026-11-03T08:00:00Z"),
        } as LoadedAmendment["position"],
      });
    const result = sheetPositions(
      [
        answered("a1", CEA_USER),
        answered("a2", MESA_USER),
        answered("a3", CEA_USER),
      ],
      documents,
      recorders,
    );
    expect(
      result.map((entry) => [entry.amendmentId, entry.position.recordedBy]),
    ).toEqual([
      ["a1", "mesa"],
      ["a2", "mesa"],
      ["a3", "presenter"],
    ]);
  });

  it("name the Secretaría or the Presidencia when they answered for the presenter", () => {
    const documents = new Map([["doc", DOCUMENT]]);
    const recorders: PositionRecorders = {
      recordedAs: new Map([
        ["a1", "moderator"],
        ["a2", "moderator"],
        ["a3", "moderator"],
      ]),
      memberOf: new Map(),
      roleOf: new Map([
        ["sec", "Secretaría"],
        ["pres", "Presidencia"],
        ["mod", "Moderador"],
      ]),
    };
    const answered = (id: string, decidedByUserId: string) =>
      amendment(id, {
        position: {
          position: "accept",
          comment: null,
          decidedByUserId,
          updatedAt: new Date("2026-11-03T08:00:00Z"),
        } as LoadedAmendment["position"],
      });
    const rows = [
      answered("a1", "sec"),
      answered("a2", "pres"),
      answered("a3", "mod"),
    ];
    expect(
      sheetPositions(rows, documents, recorders).map(
        (entry) => entry.position.recorder,
      ),
    ).toEqual(["secretaria", "presidencia", "mesa"]);
    // A reader not told who answered nor when reads the answer alone.
    expect(
      sheetPositions(rows, documents, recorders, () => false)[0]!.position,
    ).toEqual({
      position: "accept",
      comment: null,
      recordedBy: null,
      recorder: null,
      updatedAt: null,
    });
  });
});
