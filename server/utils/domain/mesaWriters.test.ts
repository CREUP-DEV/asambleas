import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { AssemblyRow } from "./assemblies";
import { testActor } from "../../testing/actor";

// The Mesa's writers of headcounts and speaking turns check session:moderate
// themselves, not only through their routes: anyone else is refused before
// anything is read or written.
const transaction = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({ db: { transaction } }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));

const { recordHeadcount, updateHeadcount } = await import("./headcounts");
const { addSpeakingTurn, updateSpeakingTurn } = await import("./speakers");

const TURN_ID = "t1aaaaaaaaaaaaaaaaaaaaaa";
const COUNT_ID = "c1aaaaaaaaaaaaaaaaaaaaaa";

/** In a closed assembly: whoever passes the permission check gets 409. */
const CLOSED = { id: "asm", status: "closed" } as AssemblyRow;

const writers = {
  recordHeadcount: (actor: ReturnType<typeof testActor>) =>
    recordHeadcount(actor, CLOSED, { members: [] } as never),
  updateHeadcount: (actor: ReturnType<typeof testActor>) =>
    updateHeadcount(actor, CLOSED, COUNT_ID, {} as never),
  addSpeakingTurn: (actor: ReturnType<typeof testActor>) =>
    addSpeakingTurn(actor, CLOSED, { speaker: "Ana" } as never),
  updateSpeakingTurn: (actor: ReturnType<typeof testActor>) =>
    updateSpeakingTurn(actor, CLOSED, TURN_ID, {} as never),
};

describe("the Mesa's writers", () => {
  beforeEach(() => transaction.mockReset());

  it.each(Object.entries(writers))(
    "%s refuses an account without session:moderate",
    async (_name, write) => {
      for (const actor of [
        testActor(),
        // Noting speakers or reading the sheet is not moderating.
        testActor({ permissions: [PERMISSION_KEYS.SESSION_RECORD_SPEAKERS] }),
        testActor({ permissions: [PERMISSION_KEYS.CONTROL_SHEET_EDIT] }),
      ]) {
        await expect(write(actor)).rejects.toMatchObject({ statusCode: 403 });
      }
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each(Object.entries(writers))(
    "%s lets the Mesa and an Admin through to the assembly's state",
    async (_name, write) => {
      for (const actor of [
        testActor({ permissions: [PERMISSION_KEYS.SESSION_MODERATE] }),
        testActor({ role: SYSTEM_ROLES.ADMIN }),
      ]) {
        await expect(write(actor)).rejects.toMatchObject({ statusCode: 409 });
      }
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
