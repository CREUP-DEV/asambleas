import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntranetRoleLookup } from "../members/intranet";
import type { IntranetNotFoundResult } from "./roleSync";

// The daily access re-check with its lookups, revocations and audit row
// injected: which accounts lose access and when the safeguard stops it.

vi.mock("../../db", () => ({ db: {} }));
const logger = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../core/logger", () => logger);
vi.mock("../domain/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("./roleSync", () => ({ applyIntranetNotFound: vi.fn() }));
vi.mock("../members/intranet", () => ({
  emailFingerprint: (email: string) => `ref-${email.split("@")[0]}`,
  getRoleApiUrl: vi.fn(() => "https://intranet.test/user/role"),
  isRoleLookupAuthenticated: vi.fn(() => true),
  lookupIntranetRole: vi.fn(),
}));

const {
  ACCESS_RECHECK_MAX_CONSECUTIVE_FAILURES,
  isMassRevocation,
  recheckIntranetAccess,
} = await import("./accessRecheck");

const OK: IntranetRoleLookup = {
  outcome: "ok",
  account: {
    id: 1,
    role: "Asociado",
    name: null,
    initials: null,
    university: null,
  },
};
const NOT_FOUND: IntranetRoleLookup = { outcome: "notFound" };
const FAILED: IntranetRoleLookup = {
  outcome: "failed",
  reason: "timeout",
  status: null,
};

/** n accounts u1..un, each answered as `answers` says (default: found). */
function setup(answers: IntranetRoleLookup[]) {
  const candidates = answers.map((_, index) => ({
    id: `u${index + 1}`,
    email: `u${index + 1}@creup.es`,
  }));
  const byEmail = new Map(
    candidates.map((candidate, index) => [candidate.email, answers[index]!]),
  );
  const lookup = vi.fn(async (email: string) => byEmail.get(email)!);
  const revoke = vi.fn(async (): Promise<IntranetNotFoundResult> => ({
    kind: "revoked",
    sessionsEnded: 1,
    impersonationsEnded: 0,
  }));
  const recordBlocked = vi.fn(async () => undefined);
  const sleep = vi.fn(async () => undefined);
  const deps = {
    candidates: async () => candidates,
    lookup,
    revoke,
    recordBlocked,
    sleep,
    delayMs: 500,
    enabled: () => true,
  };
  return { deps, lookup, revoke, recordBlocked, sleep };
}

const many = (count: number, answer: IntranetRoleLookup) =>
  Array.from({ length: count }, () => answer);

beforeEach(() => {
  logger.logError.mockClear();
  logger.logInfo.mockClear();
  logger.logWarn.mockClear();
});

describe("isMassRevocation", () => {
  it.each([
    [0, 0, false],
    [1, 1, false],
    [3, 3, false],
    [10, 3, false],
    [4, 4, true],
    [10, 4, true],
    [100, 30, false],
    [100, 31, true],
  ])("%i checked, %i not found: %s", (checked, notFound, mass) => {
    expect(isMassRevocation(checked, notFound)).toBe(mass);
  });
});

describe("recheckIntranetAccess", () => {
  it("does nothing without an authenticated role lookup", async () => {
    const { deps, lookup } = setup([NOT_FOUND]);
    await expect(
      recheckIntranetAccess({ ...deps, enabled: () => false }),
    ).resolves.toEqual({ status: "skipped" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("revokes the accounts the intranet deleted, after every lookup", async () => {
    const { deps, lookup, revoke, sleep } = setup([
      OK,
      NOT_FOUND,
      OK,
      FAILED,
      OK,
    ]);
    await expect(recheckIntranetAccess(deps)).resolves.toEqual({
      status: "applied",
      checked: 4,
      notFound: 1,
      failed: 1,
      revoked: 1,
    });
    expect(lookup).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("u2", { accountRef: "ref-u2" });
    expect(revoke.mock.invocationCallOrder[0]).toBeGreaterThan(
      lookup.mock.invocationCallOrder[4]!,
    );
  });

  it("revokes a single account with a live session", async () => {
    const { deps, revoke } = setup([NOT_FOUND]);
    const outcome = await recheckIntranetAccess(deps);
    expect(outcome).toMatchObject({ status: "applied", revoked: 1 });
    expect(revoke).toHaveBeenCalledWith("u1", { accountRef: "ref-u1" });
  });

  it("counts only real revocations", async () => {
    const { deps, revoke } = setup([NOT_FOUND, NOT_FOUND]);
    revoke.mockResolvedValueOnce({ kind: "protected", roleName: "Moderador" });
    const outcome = await recheckIntranetAccess(deps);
    expect(outcome).toMatchObject({ notFound: 2, revoked: 1 });
  });

  it("revokes nobody when the intranet misses too many accounts", async () => {
    // An Intranet pointed at an empty database: every account not found.
    const { deps, revoke, recordBlocked } = setup(many(20, NOT_FOUND));
    await expect(recheckIntranetAccess(deps)).resolves.toEqual({
      status: "blocked",
      checked: 20,
      notFound: 20,
      failed: 0,
    });
    expect(revoke).not.toHaveBeenCalled();
    expect(recordBlocked).toHaveBeenCalledWith({ checked: 20, notFound: 20 });
    expect(logger.logError).toHaveBeenCalledWith(
      "access.recheck",
      expect.any(String),
      expect.objectContaining({ checked: 20, notFound: 20 }),
    );
  });

  it("judges the share over the accounts the intranet answered for", async () => {
    // 4 not found of 10 answered (40%), whatever the failures around them.
    const { deps, revoke } = setup([
      ...many(4, NOT_FOUND),
      ...many(6, OK),
      FAILED,
      OK,
      FAILED,
    ]);
    const outcome = await recheckIntranetAccess(deps);
    expect(outcome).toMatchObject({ status: "blocked", checked: 11 });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("gives up, revoking nobody, when the intranet keeps failing", async () => {
    const { deps, lookup, revoke } = setup([
      NOT_FOUND,
      ...many(ACCESS_RECHECK_MAX_CONSECUTIVE_FAILURES, FAILED),
      NOT_FOUND,
    ]);
    await expect(recheckIntranetAccess(deps)).resolves.toEqual({
      status: "aborted",
      checked: 1,
      failed: ACCESS_RECHECK_MAX_CONSECUTIVE_FAILURES,
    });
    expect(lookup).toHaveBeenCalledTimes(
      1 + ACCESS_RECHECK_MAX_CONSECUTIVE_FAILURES,
    );
    expect(revoke).not.toHaveBeenCalled();
  });

  it("never logs an email", async () => {
    const { deps } = setup([OK, NOT_FOUND, FAILED]);
    await recheckIntranetAccess(deps);
    const logged = JSON.stringify([
      ...logger.logInfo.mock.calls,
      ...logger.logWarn.mock.calls,
      ...logger.logError.mock.calls,
    ]);
    expect(logged).not.toContain("@creup.es");
  });
});
