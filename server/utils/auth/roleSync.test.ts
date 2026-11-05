import { describe, expect, it, vi } from "vitest";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

// Only the pure role decision is tested: stub the database, the logger and
// the intranet helpers.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../core/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../members/intranet", () => ({
  getIntranetApiBaseUrl: vi.fn(),
  intranetUrl: vi.fn(),
  INTRANET_TIMEOUT_MS: 1_000,
}));
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
  stopsActingForMember,
} = await import("./roleSync");

const external = (role: string) => ({
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
      SYSTEM_ROLES.INVITADO,
    );
  });

  it("makes Invitado, Asociado and CEA users follow their intranet type", () => {
    expect(resolveTargetRole("CEA", SYSTEM_ROLES.INVITADO, false)).toBe(
      SYSTEM_ROLES.CEA,
    );
    expect(resolveTargetRole("CEA", SYSTEM_ROLES.ASOCIADO, false)).toBe(
      SYSTEM_ROLES.CEA,
    );
    expect(resolveTargetRole("Asociado", SYSTEM_ROLES.CEA, false)).toBe(
      SYSTEM_ROLES.ASOCIADO,
    );
    expect(resolveTargetRole("Alumni", SYSTEM_ROLES.CEA, false)).toBe(
      SYSTEM_ROLES.INVITADO,
    );
    expect(resolveTargetRole("Asociado", SYSTEM_ROLES.ASOCIADO, false)).toBe(
      null,
    );
    expect(resolveTargetRole("CEA", SYSTEM_ROLES.CEA, false)).toBe(null);
  });

  it("keeps Admin, Secretaría, Moderador and custom roles", () => {
    for (const role of [
      SYSTEM_ROLES.ADMIN,
      SYSTEM_ROLES.SECRETARIA,
      SYSTEM_ROLES.MODERADOR,
      "Tesorería",
    ]) {
      expect(resolveTargetRole("CEA", role, false)).toBe(null);
      expect(resolveTargetRole("Asociado", role, false)).toBe(null);
    }
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

  it("gives Invitado to a new user when the sync fails", () => {
    expect(computeRoleSyncUpdate(user(null), null, false).assignRoleName).toBe(
      SYSTEM_ROLES.INVITADO,
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
        input(SYSTEM_ROLES.CEA, SYSTEM_ROLES.INVITADO, "CEA", "Alumni"),
      ),
    ).toBe(true);
    expect(
      stopsActingForMember(
        input(SYSTEM_ROLES.ASOCIADO, SYSTEM_ROLES.INVITADO, "Asociado", "Baja"),
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

  it("unlinks an Invitado whose intranet type stops being a member", () => {
    expect(
      stopsActingForMember(
        input(SYSTEM_ROLES.INVITADO, null, "Sectorial", "Alumni"),
      ),
    ).toBe(true);
  });

  it("keeps the link while nothing changes", () => {
    expect(
      stopsActingForMember(input(SYSTEM_ROLES.CEA, null, "CEA", "CEA")),
    ).toBe(false);
    // A manual link on an account that never had a member type stays.
    expect(
      stopsActingForMember(input(SYSTEM_ROLES.INVITADO, null, "Otro", "Otro")),
    ).toBe(false);
    expect(
      stopsActingForMember(input(SYSTEM_ROLES.INVITADO, null, null, "Otro")),
    ).toBe(false);
  });

  it("never unlinks new accounts nor roles assigned on the platform", () => {
    expect(
      stopsActingForMember(input(null, SYSTEM_ROLES.INVITADO, null, "Alumni")),
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
  it("asks to unlink a CEA account demoted to Invitado", () => {
    const update = computeRoleSyncUpdate(
      user(SYSTEM_ROLES.CEA, "CEA"),
      external("Alumni"),
      false,
    );
    expect(update.assignRoleName).toBe(SYSTEM_ROLES.INVITADO);
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
    expect(fallbackRoleName(SYSTEM_ROLES.CEA, true)).toBe(
      SYSTEM_ROLES.INVITADO,
    );
    expect(fallbackRoleName(SYSTEM_ROLES.INVITADO, true)).toBe(null);
  });

  it("lets an existing account keep its role", () => {
    expect(fallbackRoleName(SYSTEM_ROLES.CEA, false)).toBe(null);
  });
});
