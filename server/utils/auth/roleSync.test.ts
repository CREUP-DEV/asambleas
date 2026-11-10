import { describe, expect, it, vi } from "vitest";
import { PROTECTED_ROLES, SYSTEM_ROLES } from "~~/shared/constants/roles";

// Only the pure role decision is tested: stub the database, the logger and
// the intranet helpers.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../core/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../members/intranet", () => ({
  emailFingerprint: vi.fn(() => null),
  isRoleLookupAuthenticated: vi.fn(() => true),
  lookupIntranetRole: vi.fn(),
}));
vi.mock("./impersonation", () => ({ endImpersonations: vi.fn() }));
vi.mock("../members/link", () => ({
  INTRANET_MEMBER_TYPES: new Map([
    ["Asociado", "asociado"],
    ["Sectorial", "sectorial"],
    ["CEA", "executive"],
  ]),
  linkUserToIntranetMember: vi.fn(),
}));

const {
  computeRoleSyncUpdate,
  fallbackRoleName,
  resolveTargetRole,
  roleSyncAuditStates,
  stopsActingForMember,
} = await import("./roleSync");

describe("roleSyncAuditStates", () => {
  const current = {
    roleName: SYSTEM_ROLES.CEA,
    intranetId: null,
    externalRole: "CEA",
    externalName: "Persona",
    externalInitials: "VPU",
    university: null,
    memberId: "m1",
  };

  it("is unchanged when the sync only moved lastRoleSyncAt", () => {
    const { before, after } = roleSyncAuditStates({
      current,
      update: {
        externalRole: "CEA",
        externalName: "Persona",
        externalInitials: "VPU",
        university: null,
      },
      writtenRoleName: null,
    });
    expect(after).toEqual(before);
  });

  it("records the role written, the new intranet data and the unlink", () => {
    const { before, after } = roleSyncAuditStates({
      current,
      update: {
        externalRole: "Alumni",
        externalName: null,
        externalInitials: null,
        university: "Universidad de León",
        memberId: null,
      },
      writtenRoleName: SYSTEM_ROLES.OTRO,
    });
    expect(before).toEqual(current);
    expect(after).toEqual({
      roleName: SYSTEM_ROLES.OTRO,
      intranetId: null,
      externalRole: "Alumni",
      externalName: null,
      externalInitials: null,
      university: "Universidad de León",
      memberId: null,
    });
  });

  it("keeps what a failed sync did not touch", () => {
    const { after } = roleSyncAuditStates({
      current: { ...current, roleName: null },
      update: {},
      writtenRoleName: SYSTEM_ROLES.OTRO,
    });
    expect(after).toEqual({ ...current, roleName: SYSTEM_ROLES.OTRO });
  });
});

const external = (role: string, id: number | null = null) => ({
  id,
  role,
  name: "Persona",
  initials: "VPU",
  university: null,
});

const user = (roleName: string | null, externalRole: string | null = null) => ({
  id: "u1",
  email: "persona@creup.es",
  roleId: roleName ? "r1" : null,
  role: roleName ? { name: roleName } : null,
  externalRole,
});

describe("resolveTargetRole", () => {
  it("gives a new user the role of their intranet type", () => {
    expect(resolveTargetRole("Asociado", null, true)).toBe(
      SYSTEM_ROLES.ASOCIADO,
    );
    expect(resolveTargetRole("CEA", null, true)).toBe(SYSTEM_ROLES.CEA);
    expect(resolveTargetRole("Sectorial", null, true)).toBe(
      SYSTEM_ROLES.SECTORIAL,
    );
    expect(resolveTargetRole("Alumni", null, true)).toBe(SYSTEM_ROLES.OTRO);
  });

  it("moves sectorial Otro accounts to the Sectorial role, and back", () => {
    // Accounts that signed in before the role existed.
    expect(resolveTargetRole("Sectorial", SYSTEM_ROLES.OTRO, false)).toBe(
      SYSTEM_ROLES.SECTORIAL,
    );
    expect(resolveTargetRole("Sectorial", SYSTEM_ROLES.SECTORIAL, false)).toBe(
      null,
    );
    expect(resolveTargetRole("Asociado", SYSTEM_ROLES.SECTORIAL, false)).toBe(
      SYSTEM_ROLES.ASOCIADO,
    );
    expect(resolveTargetRole("Alumni", SYSTEM_ROLES.SECTORIAL, false)).toBe(
      SYSTEM_ROLES.OTRO,
    );
    // Roles assigned here stay.
    expect(resolveTargetRole("Sectorial", SYSTEM_ROLES.MODERADOR, false)).toBe(
      null,
    );
  });

  it("never gives Invitado, and only raises one given here", () => {
    // Invitado is given here by hand: sync keeps it for any other type...
    expect(resolveTargetRole("Alumni", SYSTEM_ROLES.INVITADO, false)).toBe(
      null,
    );
    expect(resolveTargetRole("Invitado", SYSTEM_ROLES.INVITADO, false)).toBe(
      null,
    );
    // ...and raises it to the role of a member type.
    expect(resolveTargetRole("Asociado", SYSTEM_ROLES.INVITADO, false)).toBe(
      SYSTEM_ROLES.ASOCIADO,
    );
    expect(resolveTargetRole("CEA", SYSTEM_ROLES.INVITADO, false)).toBe(
      SYSTEM_ROLES.CEA,
    );
    // A new account with the intranet type Invitado gets Otro.
    expect(resolveTargetRole("Invitado", null, true)).toBe(SYSTEM_ROLES.OTRO);
  });

  it("makes Otro, Asociado and CEA users follow their intranet type", () => {
    expect(resolveTargetRole("CEA", SYSTEM_ROLES.OTRO, false)).toBe(
      SYSTEM_ROLES.CEA,
    );
    expect(resolveTargetRole("CEA", SYSTEM_ROLES.ASOCIADO, false)).toBe(
      SYSTEM_ROLES.CEA,
    );
    expect(resolveTargetRole("Asociado", SYSTEM_ROLES.CEA, false)).toBe(
      SYSTEM_ROLES.ASOCIADO,
    );
    expect(resolveTargetRole("Alumni", SYSTEM_ROLES.CEA, false)).toBe(
      SYSTEM_ROLES.OTRO,
    );
    expect(resolveTargetRole("Asociado", SYSTEM_ROLES.ASOCIADO, false)).toBe(
      null,
    );
    expect(resolveTargetRole("CEA", SYSTEM_ROLES.CEA, false)).toBe(null);
  });

  it("keeps Admin, Secretaría, Presidencia, Moderador and custom roles", () => {
    for (const role of [
      SYSTEM_ROLES.ADMIN,
      SYSTEM_ROLES.SECRETARIA,
      SYSTEM_ROLES.PRESIDENCIA,
      SYSTEM_ROLES.MODERADOR,
      "Tesorería",
    ]) {
      expect(resolveTargetRole("CEA", role, false)).toBe(null);
      expect(resolveTargetRole("Asociado", role, false)).toBe(null);
      expect(resolveTargetRole("Alumni", role, false)).toBe(null);
    }
  });

  it("keeps every protected role", () => {
    for (const role of PROTECTED_ROLES) {
      expect(resolveTargetRole("CEA", role, false)).toBe(null);
      expect(resolveTargetRole("Asociado", role, false)).toBe(null);
    }
  });
});

describe("Presidencia and role sync", () => {
  it("keeps the member link of a Presidencia account whose intranet type changes", () => {
    const { assignRoleName, clearMember } = computeRoleSyncUpdate(
      user(SYSTEM_ROLES.PRESIDENCIA, "CEA"),
      external("Alumni"),
      false,
    );
    expect(assignRoleName).toBe(null);
    expect(clearMember).toBe(false);
  });
});

describe("computeRoleSyncUpdate", () => {
  it("stores the intranet data and assigns CEA to a new CEA account", () => {
    const { fields, assignRoleName } = computeRoleSyncUpdate(
      user(null),
      external("CEA"),
      false,
    );
    expect(assignRoleName).toBe(SYSTEM_ROLES.CEA);
    expect(fields).toMatchObject({
      externalRole: "CEA",
      externalName: "Persona",
      externalInitials: "VPU",
      university: null,
    });
  });

  it("gives Otro to a new user when the sync fails", () => {
    expect(computeRoleSyncUpdate(user(null), null, false).assignRoleName).toBe(
      SYSTEM_ROLES.OTRO,
    );
    expect(
      computeRoleSyncUpdate(user(SYSTEM_ROLES.CEA), null, false).assignRoleName,
    ).toBe(null);
  });

  it("makes the initial admin an Admin whatever the intranet says", () => {
    expect(
      computeRoleSyncUpdate(user(null), external("CEA"), true).assignRoleName,
    ).toBe(SYSTEM_ROLES.ADMIN);
  });

  it("dates and identifies the account only from a successful lookup", () => {
    const now = new Date("2026-11-06T09:00:00Z");
    expect(
      computeRoleSyncUpdate(user(null), external("Asociado", 412), false, now)
        .fields,
    ).toMatchObject({ lastRoleSyncAt: now, intranetId: 412 });
    // No id (legacy route): the stored one stays.
    expect(
      computeRoleSyncUpdate(user(null), external("Asociado"), false, now)
        .fields,
    ).not.toHaveProperty("intranetId");
    // A failed lookup writes neither, so an existing account gets no update.
    expect(
      computeRoleSyncUpdate(user(SYSTEM_ROLES.CEA), null, false, now).fields,
    ).toEqual({});
  });
});

describe("stopsActingForMember", () => {
  const input = (
    currentRoleName: string | null,
    assignRoleName: string | null,
    previousExternalRole: string | null,
    externalRole: string,
  ) => ({
    isNewUser: currentRoleName === null,
    currentRoleName,
    assignRoleName,
    previousExternalRole,
    externalRole,
  });

  it("unlinks a CEA cargo whose term ended", () => {
    expect(
      stopsActingForMember(
        input(SYSTEM_ROLES.CEA, SYSTEM_ROLES.OTRO, "CEA", "Alumni"),
      ),
    ).toBe(true);
    expect(
      stopsActingForMember(
        input(SYSTEM_ROLES.ASOCIADO, SYSTEM_ROLES.OTRO, "Asociado", "Baja"),
      ),
    ).toBe(true);
  });

  it("unlinks on a change between member types, so the new type relinks it", () => {
    expect(
      stopsActingForMember(
        input(SYSTEM_ROLES.ASOCIADO, SYSTEM_ROLES.CEA, "Asociado", "CEA"),
      ),
    ).toBe(true);
  });

  it("unlinks a sectorial Otro that becomes Sectorial, so it is linked again", () => {
    expect(
      stopsActingForMember(
        input(
          SYSTEM_ROLES.OTRO,
          SYSTEM_ROLES.SECTORIAL,
          "Sectorial",
          "Sectorial",
        ),
      ),
    ).toBe(true);
    expect(
      stopsActingForMember(
        input(SYSTEM_ROLES.SECTORIAL, null, "Sectorial", "Sectorial"),
      ),
    ).toBe(false);
  });

  it("unlinks an Otro whose intranet type stops being a member", () => {
    expect(
      stopsActingForMember(
        input(SYSTEM_ROLES.OTRO, null, "Sectorial", "Alumni"),
      ),
    ).toBe(true);
  });

  it("keeps the link while nothing changes", () => {
    expect(
      stopsActingForMember(input(SYSTEM_ROLES.CEA, null, "CEA", "CEA")),
    ).toBe(false);
    // A manual link on an account that never had a member type stays.
    expect(
      stopsActingForMember(input(SYSTEM_ROLES.OTRO, null, "Otro", "Otro")),
    ).toBe(false);
    expect(
      stopsActingForMember(input(SYSTEM_ROLES.OTRO, null, null, "Otro")),
    ).toBe(false);
  });

  it("never unlinks new accounts nor roles assigned on the platform", () => {
    expect(
      stopsActingForMember(input(null, SYSTEM_ROLES.OTRO, null, "Alumni")),
    ).toBe(false);
    for (const role of [
      SYSTEM_ROLES.ADMIN,
      SYSTEM_ROLES.SECRETARIA,
      SYSTEM_ROLES.MODERADOR,
    ]) {
      expect(stopsActingForMember(input(role, null, "CEA", "Alumni"))).toBe(
        false,
      );
    }
  });
});

describe("computeRoleSyncUpdate and the member link", () => {
  it("asks to unlink a CEA account demoted to Otro", () => {
    const update = computeRoleSyncUpdate(
      user(SYSTEM_ROLES.CEA, "CEA"),
      external("Alumni"),
      false,
    );
    expect(update.assignRoleName).toBe(SYSTEM_ROLES.OTRO);
    expect(update.clearMember).toBe(true);
  });

  it("keeps the link when the sync fails or nothing changes", () => {
    expect(
      computeRoleSyncUpdate(user(SYSTEM_ROLES.CEA, "CEA"), null, false)
        .clearMember,
    ).toBe(false);
    expect(
      computeRoleSyncUpdate(
        user(SYSTEM_ROLES.CEA, "CEA"),
        external("CEA"),
        false,
      ).clearMember,
    ).toBe(false);
  });
});

describe("fallbackRoleName", () => {
  it("never leaves a new account without a role", () => {
    expect(fallbackRoleName(SYSTEM_ROLES.CEA, true)).toBe(SYSTEM_ROLES.OTRO);
    expect(fallbackRoleName(SYSTEM_ROLES.OTRO, true)).toBe(null);
  });

  it("lets an existing account keep its role", () => {
    expect(fallbackRoleName(SYSTEM_ROLES.CEA, false)).toBe(null);
  });
});
