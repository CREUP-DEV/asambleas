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

const {
  redactItemRowDto,
  sheetItemBodyOnlyTreated,
  sheetItemBodyTreats,
  sheetPositions,
  sheetTreatedIds,
  visibleSheetAmendments,
} = await import("./controlSheet");
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

/** Someone given the control sheet by hand, outside the CEA. */
const SHEET_READER = makeActor(SYSTEM_ROLES.ASOCIADO, [
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
          // No event names who answered: the main presenter.
          answeredBy: DOCUMENT.proponentMemberId,
        },
      },
    ]);
  });

  it("leave out amendments the reader does not see", () => {
    const documents = new Map([["doc", DOCUMENT]]);
    const list = [
      // Presented, not validated yet: its insiders, the Secretaría, the
      // Mesa and the CEA read it (user's decision of 2026-11-19).
      amendment("presented", { validatedAt: null, publishedAt: null }),
      // Validated, unpublished: every sheet reader reads it.
      amendment("validated", { publishedAt: null }),
      // A document the reader does not see.
      amendment("other", { documentId: "elsewhere" }),
    ];
    const ids = (reader: Actor) =>
      visibleSheetAmendments(reader, list, documents).map((row) => row.id);
    expect(ids(CEA_READER)).toEqual(["presented", "validated"]);
    // A sheet reader outside the CEA waits for the validation.
    expect(ids(SHEET_READER)).toEqual(["validated"]);
    const rows = visibleSheetAmendments(SHEET_READER, list, documents);
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
      answeredBy: null,
    });
  });
});

describe("the Mesa's treated mark by hand", () => {
  const token = { updatedAt: null };

  it("tells a body that only sets or undoes the mark", () => {
    expect(
      sheetItemBodyOnlyTreated({ treated: { value: true, ...token } }),
    ).toBe(true);
    expect(
      sheetItemBodyOnlyTreated({ treated: { value: false, ...token } }),
    ).toBe(true);
    expect(
      sheetItemBodyOnlyTreated({
        treated: { value: true, ...token },
        observations: { value: "x", ...token },
      }),
    ).toBe(false);
    expect(
      sheetItemBodyOnlyTreated({ listed: { value: true, ...token } }),
    ).toBe(false);
  });

  it("tells a body that would treat the item by hand", () => {
    expect(sheetItemBodyTreats({ treated: { value: true, ...token } })).toBe(
      true,
    );
    expect(sheetItemBodyTreats({ treated: { value: false, ...token } })).toBe(
      false,
    );
    expect(sheetItemBodyTreats({ result: { value: "lapsed", ...token } })).toBe(
      true,
    );
    expect(
      sheetItemBodyTreats({ result: { value: "withdrawn", ...token } }),
    ).toBe(true);
    expect(
      sheetItemBodyTreats({ result: { value: "not_applicable", ...token } }),
    ).toBe(false);
    expect(sheetItemBodyTreats({ result: { value: null, ...token } })).toBe(
      false,
    );
  });
});

describe("sheetTreatedIds", () => {
  const STARTED = new Date("2026-05-01T10:00:00.000Z");
  const amendment = (
    id: string,
    over: Partial<{
      status: LoadedAmendment["status"];
      approvalMethod: LoadedAmendment["approvalMethod"];
      decidedAt: Date | null;
    }> = {},
  ) => ({
    id,
    status: "submitted" as LoadedAmendment["status"],
    approvalMethod: null as LoadedAmendment["approvalMethod"],
    decidedAt: null as Date | null,
    ...over,
  });

  it("folds the mark and a settled result, never on an item awaiting a vote", () => {
    const result = sheetTreatedIds({
      itemRows: [
        { agendaItemId: "i1", treatedAt: STARTED, manualResult: null },
        { agendaItemId: "i2", treatedAt: null, manualResult: "lapsed" },
        { agendaItemId: "i3", treatedAt: null, manualResult: "not_applicable" },
        { agendaItemId: "i4", treatedAt: STARTED, manualResult: null },
      ],
      awaiting: new Set(["i4"]),
      amendments: [],
      amendmentRows: [],
      sessionStartedAt: null,
    });
    expect(result).toEqual({ itemIds: ["i1", "i2"], amendmentIds: [] });
  });

  it("treats an amendment marked or settled in session", () => {
    const result = sheetTreatedIds({
      itemRows: [],
      awaiting: new Set(),
      amendments: [
        amendment("a1", {
          status: "rejected",
          decidedAt: new Date("2026-05-01T11:00:00.000Z"),
        }),
        amendment("a2", {
          status: "rejected",
          decidedAt: new Date("2026-04-30T11:00:00.000Z"),
        }),
        amendment("a3", {
          status: "approved",
          approvalMethod: "proponent",
          decidedAt: new Date("2026-04-30T11:00:00.000Z"),
        }),
        amendment("a4"),
      ],
      amendmentRows: [
        { amendmentId: "a3", treatedAt: STARTED },
        { amendmentId: "a4", treatedAt: null },
      ],
      sessionStartedAt: STARTED,
    });
    expect(result.amendmentIds).toEqual(["a1", "a3"]);
  });
});

describe("redactItemRowDto", () => {
  it("keeps only the tokens and whether it is marked", () => {
    const at = "2026-05-01T10:00:00.000Z";
    expect(
      redactItemRowDto({
        id: "r1",
        agendaItemId: "i1",
        listed: true,
        listedUpdatedAt: at,
        manualResult: "lapsed",
        resultUpdatedAt: at,
        treated: { by: "Someone", at: "2026-05-01T09:00:00.000Z" },
        progressUpdatedAt: at,
        observations: "Internal note",
        observationsEdited: { by: "Someone", at },
        observationsUpdatedAt: at,
      }),
    ).toEqual({
      id: "r1",
      agendaItemId: "i1",
      listed: false,
      listedUpdatedAt: at,
      manualResult: null,
      resultUpdatedAt: at,
      treated: { by: null, at },
      progressUpdatedAt: at,
      observations: "",
      observationsEdited: null,
      observationsUpdatedAt: at,
    });
  });
});
