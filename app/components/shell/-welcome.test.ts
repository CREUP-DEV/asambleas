import { describe, expect, it } from "vitest";
import {
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import en from "~~/i18n/locales/en.json";
import es from "~~/i18n/locales/es.json";
import {
  WELCOME_STEP_IDS,
  welcomeAudience,
  welcomePending,
  welcomeSteps,
  welcomeWork,
  type WelcomeAccount,
  type WelcomeAudience,
} from "./-welcome";

const AUDIENCES: WelcomeAudience[] = [
  "secretariat",
  "mesa",
  "cea",
  "asociado",
  "sectorial",
  "guest",
];

const PRESENTER: PermissionKey[] = [
  PERMISSION_KEYS.DOCUMENT_CREATE,
  PERMISSION_KEYS.AMENDMENT_CREATE,
];

function account(overrides: Partial<WelcomeAccount> = {}): WelcomeAccount {
  return {
    isAdmin: false,
    permissions: [],
    role: null,
    member: null,
    ...overrides,
  };
}

function lookup(messages: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      messages,
    );
}

describe("welcomeAudience", () => {
  it("treats an Admin as the Secretaría, whatever its permissions", () => {
    expect(welcomeAudience(account({ isAdmin: true, role: "Admin" }))).toBe(
      "secretariat",
    );
  });

  it("treats whoever validates or organises as the Secretaría", () => {
    for (const key of [
      PERMISSION_KEYS.ASSEMBLY_MANAGE,
      PERMISSION_KEYS.DOCUMENT_MANAGE,
      PERMISSION_KEYS.AMENDMENT_MANAGE,
      PERMISSION_KEYS.AMENDMENT_REVIEW,
    ]) {
      expect(
        welcomeAudience(account({ permissions: [...PRESENTER, key] })),
      ).toBe("secretariat");
    }
  });

  it("treats an account that only moderates as the Mesa", () => {
    expect(
      welcomeAudience(
        account({
          role: "Moderador",
          permissions: [PERMISSION_KEYS.SESSION_MODERATE],
        }),
      ),
    ).toBe("mesa");
  });

  it("puts the Secretaría before the Mesa", () => {
    expect(
      welcomeAudience(
        account({
          permissions: [
            PERMISSION_KEYS.SESSION_MODERATE,
            PERMISSION_KEYS.DOCUMENT_MANAGE,
          ],
        }),
      ),
    ).toBe("secretariat");
  });

  it("names presenters after the member they act for", () => {
    const of = (kind: "asociado" | "sectorial" | "executive") =>
      welcomeAudience(
        account({
          role: "Asociado",
          permissions: PRESENTER,
          member: { kind },
        }),
      );
    expect(of("asociado")).toBe("asociado");
    expect(of("sectorial")).toBe("sectorial");
    expect(of("executive")).toBe("cea");
  });

  it("falls back to the role when the account has no member", () => {
    const of = (role: string) =>
      welcomeAudience(account({ role, permissions: PRESENTER }));
    expect(of("CEA")).toBe("cea");
    expect(of("Sectorial")).toBe("sectorial");
    expect(of("Asociado")).toBe("asociado");
    expect(of("Rol nuevo")).toBe("asociado");
  });

  it("falls back to the role for a member of another kind", () => {
    expect(
      welcomeAudience(
        account({
          role: "CEA",
          permissions: PRESENTER,
          member: { kind: "other" },
        }),
      ),
    ).toBe("cea");
  });

  it("treats an account that can do nothing as a guest", () => {
    expect(welcomeAudience(account({ role: "Invitado" }))).toBe("guest");
    // A role name alone gives nothing: permissions decide.
    expect(welcomeAudience(account({ role: "Asociado" }))).toBe("guest");
    expect(
      welcomeAudience(
        account({ role: "Invitado", member: { kind: "asociado" } }),
      ),
    ).toBe("guest");
  });
});

describe("welcomeWork", () => {
  it("explains to each audience its own main task", () => {
    expect(welcomeWork("secretariat")).toBe("manage");
    expect(welcomeWork("mesa")).toBe("moderate");
    expect(welcomeWork("cea")).toBe("present");
    expect(welcomeWork("asociado")).toBe("present");
    expect(welcomeWork("sectorial")).toBe("present");
    expect(welcomeWork("guest")).toBe("read");
  });
});

describe("welcomeSteps", () => {
  it("always shows the same five steps in the same order", () => {
    for (const audience of AUDIENCES) {
      expect(welcomeSteps(audience).map((step) => step.id)).toEqual([
        ...WELCOME_STEP_IDS,
      ]);
    }
  });

  it("words the first step for the audience", () => {
    for (const audience of AUDIENCES) {
      expect(welcomeSteps(audience)[0]?.bodyKey).toBe(
        `onboarding.steps.role.body.${audience}`,
      );
    }
  });

  it("tells a guest that the home page lists assemblies, not tasks", () => {
    expect(welcomeSteps("guest")[1]?.bodyKey).toBe(
      "onboarding.steps.find.guest.body",
    );
    expect(welcomeSteps("asociado")[1]?.bodyKey).toBe(
      "onboarding.steps.find.tasks.body",
    );
  });

  it("never offers a guest to present", () => {
    const keys = welcomeSteps("guest").flatMap((step) => [
      step.titleKey,
      step.bodyKey,
    ]);
    expect(keys.some((key) => key.includes(".present."))).toBe(false);
    expect(keys).toContain("onboarding.steps.work.read.body");
  });

  it("gives every step a drawing", () => {
    for (const audience of AUDIENCES) {
      for (const step of welcomeSteps(audience)) {
        expect(step.icons.length).toBeGreaterThan(0);
        for (const icon of step.icons) expect(icon).toMatch(/^i-lucide-/);
      }
    }
  });

  it("has every text in both languages", () => {
    for (const audience of AUDIENCES) {
      for (const step of welcomeSteps(audience)) {
        for (const key of [step.titleKey, step.bodyKey]) {
          expect(typeof lookup(es, key), `es ${key}`).toBe("string");
          expect(typeof lookup(en, key), `en ${key}`).toBe("string");
        }
      }
    }
  });
});

describe("welcomePending", () => {
  const account = { impersonation: null };

  it("is pending until this browser closes the welcome", () => {
    expect(welcomePending({ seen: false, account })).toBe(true);
    expect(welcomePending({ seen: true, account })).toBe(false);
  });

  it("is never pending while an Admin acts as the account", () => {
    expect(
      welcomePending({ seen: false, account: { impersonation: { id: "i1" } } }),
    ).toBe(false);
  });

  it("is not pending before the account is known", () => {
    expect(welcomePending({ seen: false, account: null })).toBe(false);
    expect(welcomePending({ seen: false, account: undefined })).toBe(false);
  });
});
