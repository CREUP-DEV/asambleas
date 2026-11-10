import { describe, expect, it, vi } from "vitest";
import {
  GENERIC_EXECUTIVE_MEMBER,
  GENERIC_EXECUTIVE_MEMBER_ID,
} from "~~/shared/constants/domain";
import {
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { AcceptanceDto, MemberDto, MemberRef } from "~~/shared/types/api";
import { entityIdSchema } from "~~/shared/utils/schemas/amendment";
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
  canSeeExecutiveMembers,
  collapseExecutive,
  placeGenericByAcronym,
  redactAcceptances,
  redactAuthors,
  redactEventActor,
  redactMember,
  redactMemberId,
  redactMemberOrNull,
  redactMembers,
  redactPayloadMembers,
  redactPresenters,
  visibleAcronym,
} = await import("./visibility");
const {
  EXECUTIVE_MAIN_REFUSED_REASON,
  EXECUTIVE_MEMBER_REFUSED_REASON,
  planListedMembers,
  planNamedMember,
  refuseExecutiveMain,
  refuseExecutiveMember,
} = await import("./executiveMembers");
const { genericExecutiveMemberDto } = await import("../members/dto");

// Fixtures ------------------------------------------------------------------

function makeActor(
  options: {
    role?: string | null;
    permissions?: PermissionKey[];
    memberId?: string | null;
    memberKind?: MemberRef["kind"] | null;
    omitMemberKind?: boolean;
  } = {},
): Actor {
  const permissions = options.permissions ?? [];
  const admin = options.role === SYSTEM_ROLES.ADMIN;
  return {
    user: {
      id: "u".repeat(32),
      name: "Ana",
      email: "ana@example.org",
      image: null,
      roleId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: options.memberId ?? null,
      lastRoleSyncAt: null,
      role: options.role ? { id: "role", name: options.role } : null,
    },
    memberId: options.memberId ?? null,
    ...(options.omitMemberKind
      ? {}
      : { memberKind: options.memberKind ?? null }),
    isAdmin: admin,
    permissions,
    can: (key) => admin || permissions.includes(key),
    impersonation: null,
  };
}

const AREA_A: MemberRef = {
  id: "areaaaaaaaaaaaaaaaaaaaaa",
  acronym: "VPU",
  name: "Vicepresidencia de Universidades",
  kind: "executive",
};
const AREA_B: MemberRef = {
  id: "areabbbbbbbbbbbbbbbbbbbb",
  acronym: "TES",
  name: "Tesorería",
  kind: "executive",
};
const COUNCIL: MemberRef = {
  id: "councilaaaaaaaaaaaaaaaaa",
  acronym: "CEUM",
  name: "Consejo de Estudiantes",
  kind: "asociado",
};
const SECTORIAL: MemberRef = {
  id: "sectorialaaaaaaaaaaaaaaa",
  acronym: "CEET",
  name: "Sectorial",
  kind: "sectorial",
};
const GENERIC: MemberRef = { ...GENERIC_EXECUTIVE_MEMBER };

const asociado = makeActor({
  role: SYSTEM_ROLES.ASOCIADO,
  memberId: COUNCIL.id,
  memberKind: "asociado",
});
const cea = makeActor({
  role: SYSTEM_ROLES.CEA,
  memberId: AREA_A.id,
  memberKind: "executive",
});
const mask = new Set([AREA_A.id, AREA_B.id]);

// Who sees the areas --------------------------------------------------------

describe("canSeeExecutiveMembers", () => {
  it("lets the CEA, the Secretaría, the Presidencia, the Mesa and Admins see the areas", () => {
    for (const role of [
      SYSTEM_ROLES.ADMIN,
      SYSTEM_ROLES.SECRETARIA,
      SYSTEM_ROLES.PRESIDENCIA,
      SYSTEM_ROLES.MODERADOR,
      SYSTEM_ROLES.CEA,
    ]) {
      expect(canSeeExecutiveMembers(makeActor({ role })), role).toBe(true);
    }
  });

  it("hides them from asociados, sectorials, guests and accounts with no role", () => {
    for (const role of [
      SYSTEM_ROLES.ASOCIADO,
      SYSTEM_ROLES.SECTORIAL,
      SYSTEM_ROLES.INVITADO,
      null,
    ]) {
      expect(canSeeExecutiveMembers(makeActor({ role })), String(role)).toBe(
        false,
      );
    }
  });

  it("follows the management permissions, whatever the role", () => {
    for (const key of [
      PERMISSION_KEYS.DOCUMENT_MANAGE,
      PERMISSION_KEYS.AMENDMENT_REVIEW,
      PERMISSION_KEYS.AMENDMENT_MANAGE,
      PERMISSION_KEYS.ASSEMBLY_MANAGE,
      PERMISSION_KEYS.SESSION_MODERATE,
      PERMISSION_KEYS.MEMBER_MANAGE,
      PERMISSION_KEYS.USER_MANAGE_ROLES,
    ]) {
      expect(
        canSeeExecutiveMembers(
          makeActor({ role: SYSTEM_ROLES.ASOCIADO, permissions: [key] }),
        ),
        key,
      ).toBe(true);
    }
  });

  it("does not follow the permissions every member account holds", () => {
    expect(
      canSeeExecutiveMembers(
        makeActor({
          role: SYSTEM_ROLES.ASOCIADO,
          permissions: [
            PERMISSION_KEYS.DOCUMENT_CREATE,
            PERMISSION_KEYS.AMENDMENT_CREATE,
            PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT,
            PERMISSION_KEYS.ASSEMBLY_CREATE,
            PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
          ],
        }),
      ),
    ).toBe(false);
  });

  it("lets an account that acts for an area see them, whatever its role", () => {
    expect(
      canSeeExecutiveMembers(
        makeActor({
          role: SYSTEM_ROLES.INVITADO,
          memberId: AREA_A.id,
          memberKind: "executive",
        }),
      ),
    ).toBe(true);
    expect(
      canSeeExecutiveMembers(
        makeActor({
          role: SYSTEM_ROLES.INVITADO,
          memberId: SECTORIAL.id,
          memberKind: "sectorial",
        }),
      ),
    ).toBe(false);
  });

  it("reads an actor built without the member's kind as not acting for an area", () => {
    expect(
      canSeeExecutiveMembers(
        makeActor({ memberId: AREA_A.id, omitMemberKind: true }),
      ),
    ).toBe(false);
  });
});

// Members -------------------------------------------------------------------

describe("the generic presenter", () => {
  it("has an id no body schema refuses and no row can have", () => {
    expect(entityIdSchema.safeParse(GENERIC_EXECUTIVE_MEMBER_ID).success).toBe(
      true,
    );
    // Rows get 24-character cuid2 ids.
    expect(GENERIC_EXECUTIVE_MEMBER_ID).not.toHaveLength(24);
    expect(GENERIC).toEqual({
      id: GENERIC_EXECUTIVE_MEMBER_ID,
      acronym: "CEA",
      name: "Comisión Ejecutiva Ampliada",
      kind: "executive",
    });
  });
});

describe("redactMember", () => {
  it("replaces an area for those who may not see it", () => {
    expect(redactMember(asociado, AREA_A)).toEqual(GENERIC);
    expect(redactMemberOrNull(asociado, AREA_B)).toEqual(GENERIC);
    expect(redactMemberOrNull(asociado, null)).toBeNull();
    expect(redactMemberOrNull(asociado, undefined)).toBeNull();
  });

  it("leaves councils and sectorials as they are for everyone", () => {
    expect(redactMember(asociado, COUNCIL)).toBe(COUNCIL);
    expect(redactMember(asociado, SECTORIAL)).toBe(SECTORIAL);
  });

  it("leaves the areas as they are for the CEA, its own included", () => {
    expect(redactMember(cea, AREA_A)).toBe(AREA_A);
    expect(redactMember(cea, AREA_B)).toBe(AREA_B);
  });

  it("names members by acronym the same way", () => {
    expect(visibleAcronym(asociado, AREA_A)).toBe("CEA");
    expect(visibleAcronym(asociado, COUNCIL)).toBe("CEUM");
    expect(visibleAcronym(cea, AREA_A)).toBe("VPU");
  });
});

describe("redactMembers", () => {
  it("collapses several areas into one entry, where the first was", () => {
    expect(
      redactMembers(asociado, [COUNCIL, AREA_A, SECTORIAL, AREA_B]),
    ).toEqual([COUNCIL, GENERIC, SECTORIAL]);
  });

  it("returns the list untouched for those who see the areas", () => {
    const list = [COUNCIL, AREA_A, AREA_B];
    expect(redactMembers(cea, list)).toBe(list);
  });

  it("returns a list with no area untouched", () => {
    const list = [COUNCIL, SECTORIAL];
    expect(redactMembers(asociado, list)).toBe(list);
  });
});

describe("placeGenericByAcronym", () => {
  it("moves the generic entry and keeps the order of the rest", () => {
    const zeta: MemberRef = { ...COUNCIL, id: "zeta", acronym: "ZAR" };
    const alfa: MemberRef = { ...COUNCIL, id: "alfa", acronym: "ARE" };
    expect(placeGenericByAcronym([alfa, COUNCIL, GENERIC, zeta])).toEqual([
      alfa,
      GENERIC,
      COUNCIL,
      zeta,
    ]);
    expect(placeGenericByAcronym([GENERIC, alfa])).toEqual([alfa, GENERIC]);
  });

  it("returns a list without it untouched", () => {
    const list = [COUNCIL, SECTORIAL];
    expect(placeGenericByAcronym(list)).toBe(list);
  });
});

describe("redactPresenters", () => {
  it("does not repeat the generic entry among the co-presenters", () => {
    expect(redactPresenters(asociado, AREA_A, [AREA_B, COUNCIL])).toEqual({
      proponent: GENERIC,
      coProponents: [COUNCIL],
    });
  });

  it("keeps a council as main presenter and collapses the areas with it", () => {
    expect(redactPresenters(asociado, COUNCIL, [AREA_A, AREA_B])).toEqual({
      proponent: COUNCIL,
      coProponents: [GENERIC],
    });
  });

  it("puts the generic entry where CEA sorts, not where the area was", () => {
    // VPU sorts after both and TES between them: the answer is the same.
    for (const area of [AREA_A, AREA_B]) {
      const co = [SECTORIAL, COUNCIL, area].sort((a, b) =>
        a.acronym.localeCompare(b.acronym),
      );
      expect(redactPresenters(asociado, null, co).coProponents).toEqual([
        GENERIC,
        SECTORIAL,
        COUNCIL,
      ]);
    }
  });

  it("changes nothing for the CEA or without presenters", () => {
    expect(redactPresenters(cea, AREA_A, [AREA_B])).toEqual({
      proponent: AREA_A,
      coProponents: [AREA_B],
    });
    expect(redactPresenters(asociado, null, [])).toEqual({
      proponent: null,
      coProponents: [],
    });
  });
});

describe("redactAuthors", () => {
  it("moves mainAuthorId to the generic entry with its author", () => {
    expect(
      redactAuthors(asociado, [AREA_A, AREA_B, COUNCIL], AREA_B.id),
    ).toEqual({
      authors: [GENERIC, COUNCIL],
      mainAuthorId: GENERIC_EXECUTIVE_MEMBER_ID,
    });
  });

  it("keeps a council as main author", () => {
    expect(redactAuthors(asociado, [COUNCIL, AREA_A], COUNCIL.id)).toEqual({
      authors: [COUNCIL, GENERIC],
      mainAuthorId: COUNCIL.id,
    });
    expect(redactAuthors(asociado, [], null)).toEqual({
      authors: [],
      mainAuthorId: null,
    });
  });

  it("changes nothing for the CEA", () => {
    expect(redactAuthors(cea, [AREA_A, COUNCIL], AREA_A.id)).toEqual({
      authors: [AREA_A, COUNCIL],
      mainAuthorId: AREA_A.id,
    });
  });
});

describe("redactAcceptances", () => {
  const acceptance = (
    member: MemberRef,
    decision: AcceptanceDto["decision"],
    decidedAt: string | null = null,
    recordedBy: AcceptanceDto["recordedBy"] = "party",
  ): AcceptanceDto => ({
    member,
    role: "author",
    decision,
    decidedAt,
    recordedBy,
  });

  it("answers for the areas as one: pending while any of them is", () => {
    expect(
      redactAcceptances(asociado, [
        acceptance(AREA_A, "accepted", "2026-11-01T10:00:00.000Z"),
        acceptance(COUNCIL, "accepted", "2026-11-01T09:00:00.000Z"),
        acceptance(AREA_B, "pending"),
      ]),
    ).toEqual([
      acceptance(GENERIC, "pending"),
      acceptance(COUNCIL, "accepted", "2026-11-01T09:00:00.000Z"),
    ]);
  });

  it("rejects when any area did and accepts once all did, at the last answer", () => {
    expect(
      redactAcceptances(asociado, [
        acceptance(AREA_A, "accepted", "2026-11-01T10:00:00.000Z"),
        acceptance(AREA_B, "rejected", "2026-11-02T10:00:00.000Z", "mesa"),
      ]),
    ).toEqual([
      acceptance(GENERIC, "rejected", "2026-11-02T10:00:00.000Z", "mesa"),
    ]);
    expect(
      redactAcceptances(asociado, [
        acceptance(AREA_A, "accepted", "2026-11-03T10:00:00.000Z"),
        acceptance(AREA_B, "accepted", "2026-11-02T10:00:00.000Z"),
      ]),
    ).toEqual([acceptance(GENERIC, "accepted", "2026-11-03T10:00:00.000Z")]);
  });

  it("changes nothing for the CEA or without areas", () => {
    const list = [acceptance(AREA_A, "pending"), acceptance(AREA_B, "pending")];
    expect(redactAcceptances(cea, list)).toBe(list);
    const councils = [acceptance(COUNCIL, "pending")];
    expect(redactAcceptances(asociado, councils)).toBe(councils);
  });
});

// Ids and payloads ----------------------------------------------------------

describe("redactMemberId and redactPayloadMembers", () => {
  it("replace the id of an area and leave the rest", () => {
    expect(redactMemberId(mask, AREA_A.id)).toBe(GENERIC_EXECUTIVE_MEMBER_ID);
    expect(redactMemberId(mask, COUNCIL.id)).toBe(COUNCIL.id);
    expect(redactMemberId(mask, null)).toBeNull();
    expect(redactMemberId(null, AREA_A.id)).toBe(AREA_A.id);
  });

  it("replace the areas under any key and at any depth, once per list", () => {
    expect(
      redactPayloadMembers(mask, {
        kind: "partial",
        code: "CEA 3",
        mainAuthorId: AREA_B.id,
        authorMemberIds: [AREA_A.id, COUNCIL.id, AREA_B.id],
        onBehalfOfMemberId: AREA_A.id,
        late: false,
        number: 4,
        changes: {
          proponentMemberId: { from: COUNCIL.id, to: AREA_A.id },
          coProponentMemberIds: { from: [], to: [AREA_A.id, AREA_B.id] },
        },
        nothing: null,
      }),
    ).toEqual({
      kind: "partial",
      code: "CEA 3",
      mainAuthorId: GENERIC_EXECUTIVE_MEMBER_ID,
      authorMemberIds: [GENERIC_EXECUTIVE_MEMBER_ID, COUNCIL.id],
      onBehalfOfMemberId: GENERIC_EXECUTIVE_MEMBER_ID,
      late: false,
      number: 4,
      changes: {
        proponentMemberId: {
          from: COUNCIL.id,
          to: GENERIC_EXECUTIVE_MEMBER_ID,
        },
        coProponentMemberIds: { from: [], to: [GENERIC_EXECUTIVE_MEMBER_ID] },
      },
      nothing: null,
    });
  });

  it("return the payload itself for those who see the areas", () => {
    const payload = { mainAuthorId: AREA_A.id };
    expect(redactPayloadMembers(null, payload)).toBe(payload);
    expect(redactPayloadMembers(new Set<string>(), payload)).toBe(payload);
  });
});

describe("redactEventActor", () => {
  it("hides the area and the person who acted for it", () => {
    expect(
      redactEventActor(asociado, { actorName: "Marta", actorMember: AREA_A }),
    ).toEqual({ actorName: null, actorMember: GENERIC });
  });

  it("keeps who acted for a council, for nobody, and everything for the CEA", () => {
    const council = { actorName: "Luis", actorMember: COUNCIL };
    expect(redactEventActor(asociado, council)).toBe(council);
    const secretariat = { actorName: "Sara", actorMember: null };
    expect(redactEventActor(asociado, secretariat)).toBe(secretariat);
    const area = { actorName: "Marta", actorMember: AREA_A };
    expect(redactEventActor(cea, area)).toBe(area);
  });
});

// GET /api/members ----------------------------------------------------------

describe("the members list", () => {
  const dto = (member: MemberRef, active = true): MemberDto => ({
    ...member,
    university: null,
    region: null,
    source: "manual",
    active,
    syncedAt: null,
    updatedAt: "2026-11-01T10:00:00.000Z",
  });

  it("gives one generic entry instead of the areas", () => {
    const list = collapseExecutive(
      asociado,
      [dto(COUNCIL), dto(AREA_B, false), dto(SECTORIAL), dto(AREA_A)],
      genericExecutiveMemberDto,
    );
    expect(list.map((member) => member.id)).toEqual([
      COUNCIL.id,
      GENERIC_EXECUTIVE_MEMBER_ID,
      SECTORIAL.id,
    ]);
    expect(list[1]).toMatchObject({ ...GENERIC, active: true });
  });

  it("marks it inactive when every area is, and adds none without areas", () => {
    expect(
      collapseExecutive(
        asociado,
        [dto(AREA_A, false)],
        genericExecutiveMemberDto,
      )[0],
    ).toMatchObject({ id: GENERIC_EXECUTIVE_MEMBER_ID, active: false });
    const councils = [dto(COUNCIL)];
    expect(
      collapseExecutive(asociado, councils, genericExecutiveMemberDto),
    ).toBe(councils);
  });

  it("gives the CEA every area", () => {
    const list = [dto(COUNCIL), dto(AREA_A), dto(AREA_B)];
    expect(collapseExecutive(cea, list, genericExecutiveMemberDto)).toBe(list);
  });
});

// Bodies --------------------------------------------------------------------

describe("planListedMembers", () => {
  const plan = (
    requested: string[] | undefined,
    current: string[] = [],
    hidden: ReadonlySet<string> | null = mask,
  ) => planListedMembers({ mask: hidden, requested, current });

  it("leaves a list that was not sent out", () => {
    expect(plan(undefined, [AREA_A.id])).toBeUndefined();
  });

  it("refuses an area or the generic id from those who may not see the areas", () => {
    expect(plan([COUNCIL.id, AREA_A.id])).toBe("refused");
    expect(plan([GENERIC_EXECUTIVE_MEMBER_ID])).toBe("refused");
    expect(plan([AREA_B.id], [AREA_A.id])).toBe("refused");
  });

  it("keeps the areas already there, named, stood for or left out", () => {
    const current = [COUNCIL.id, AREA_A.id, AREA_B.id];
    expect(plan([SECTORIAL.id], current)).toEqual([
      SECTORIAL.id,
      AREA_A.id,
      AREA_B.id,
    ]);
    expect(plan([GENERIC_EXECUTIVE_MEMBER_ID, SECTORIAL.id], current)).toEqual([
      SECTORIAL.id,
      AREA_A.id,
      AREA_B.id,
    ]);
    expect(plan([AREA_A.id], current)).toEqual([AREA_A.id, AREA_B.id]);
    expect(plan([], current)).toEqual([AREA_A.id, AREA_B.id]);
  });

  it("lets councils and sectorials through", () => {
    expect(plan([COUNCIL.id, SECTORIAL.id])).toEqual([
      COUNCIL.id,
      SECTORIAL.id,
    ]);
  });

  it("lets those who see the areas add and remove them, never the generic id", () => {
    expect(plan([AREA_B.id], [AREA_A.id], null)).toEqual([AREA_B.id]);
    expect(plan([], [AREA_A.id], null)).toEqual([]);
    expect(plan([GENERIC_EXECUTIVE_MEMBER_ID], [AREA_A.id], null)).toBe(
      "refused",
    );
  });
});

describe("planNamedMember", () => {
  const plan = (
    requested: string | null | undefined,
    current: string[] = [],
    currentMain: string | null = null,
    hidden: ReadonlySet<string> | null = mask,
  ) => planNamedMember({ mask: hidden, requested, current, currentMain });

  it("passes null and undefined through", () => {
    expect(plan(undefined)).toBeUndefined();
    expect(plan(null)).toBeNull();
  });

  it("reads the generic id as the area that holds the place", () => {
    expect(
      plan(GENERIC_EXECUTIVE_MEMBER_ID, [AREA_A.id, AREA_B.id], AREA_B.id),
    ).toBe(AREA_B.id);
  });

  it("reads it as the only area when a council holds the place", () => {
    expect(
      plan(GENERIC_EXECUTIVE_MEMBER_ID, [COUNCIL.id, AREA_A.id], COUNCIL.id),
    ).toBe(AREA_A.id);
  });

  it("refuses it when it cannot say which area, or there is none", () => {
    expect(
      plan(
        GENERIC_EXECUTIVE_MEMBER_ID,
        [COUNCIL.id, AREA_A.id, AREA_B.id],
        COUNCIL.id,
      ),
    ).toBe("ambiguous");
    expect(plan(GENERIC_EXECUTIVE_MEMBER_ID, [COUNCIL.id], COUNCIL.id)).toBe(
      "refused",
    );
  });

  it("refuses a new area and keeps one already there", () => {
    expect(plan(AREA_A.id, [COUNCIL.id], COUNCIL.id)).toBe("refused");
    expect(plan(AREA_A.id, [COUNCIL.id, AREA_A.id], COUNCIL.id)).toBe(
      AREA_A.id,
    );
    expect(plan(COUNCIL.id)).toBe(COUNCIL.id);
  });

  it("lets those who see the areas name any, never the generic id", () => {
    expect(plan(AREA_A.id, [], null, null)).toBe(AREA_A.id);
    expect(
      plan(GENERIC_EXECUTIVE_MEMBER_ID, [AREA_A.id], AREA_A.id, null),
    ).toBe("refused");
  });
});

describe("refuseExecutiveMember", () => {
  it("answers 422 with a stable reason", () => {
    expect(() => refuseExecutiveMember()).toThrowError(
      expect.objectContaining({
        statusCode: 422,
        data: { reason: EXECUTIVE_MEMBER_REFUSED_REASON },
      }),
    );
    expect(EXECUTIVE_MEMBER_REFUSED_REASON).toBe("executive_member");
  });

  it("answers 422 with its own reason when it cannot say which area", () => {
    expect(() => refuseExecutiveMain()).toThrowError(
      expect.objectContaining({
        statusCode: 422,
        data: { reason: EXECUTIVE_MAIN_REFUSED_REASON },
      }),
    );
    expect(EXECUTIVE_MAIN_REFUSED_REASON).toBe("executive_main");
  });
});
