import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";

// linkUserToIntranetMember with a stubbed database: which rows it records.
const selects: unknown[][] = [];
let inserted: Record<string, unknown>[] = [];
let updated: { id: string }[] = [];
const recordAudit = vi.fn(async () => "audit-id");

/** A query result that can also be narrowed with `.limit()`. */
function result(rows: unknown[]) {
  return Object.assign(Promise.resolve(rows), { limit: async () => rows });
}

const tx = {
  insert: () => ({
    values: (row: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: async () =>
          inserted.length > 0
            ? inserted.map((extra) => ({ ...row, ...extra }))
            : [],
      }),
    }),
  }),
  update: () => ({
    set: () => ({ where: () => ({ returning: async () => updated }) }),
  }),
};

vi.mock("../../db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => result(selects.shift() ?? []) }),
    }),
    transaction: async (run: (inner: typeof tx) => Promise<unknown>) => run(tx),
  },
}));
vi.mock("../domain/audit", () => ({ recordAudit }));
vi.mock("../core/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

const { linkUserToIntranetMember } = await import("./link");

const asociado = {
  role: "Asociado",
  initials: "CEUNEW",
  name: "Consejo nuevo",
  university: "Universidad Nueva",
};

const audits = () =>
  (
    recordAudit.mock.calls as unknown as [unknown, Record<string, unknown>][]
  ).map(([, input]) => input);

beforeEach(() => {
  selects.length = 0;
  inserted = [];
  updated = [];
  recordAudit.mockClear();
});

describe("linkUserToIntranetMember traceability", () => {
  it("records the member it creates and the link it sets", async () => {
    selects.push([{ memberId: null }], []);
    inserted = [{ id: "m-new", syncedAt: new Date() }];
    updated = [{ id: "u1" }];

    expect(await linkUserToIntranetMember("u1", asociado)).toBe("m-new");
    expect(audits()).toEqual([
      expect.objectContaining({
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.MEMBER_CREATE,
        targetType: "member",
        targetId: "m-new",
        after: expect.objectContaining({
          kind: "asociado",
          acronym: "CEUNEW",
          source: "intranet",
          reason: "sign_in_link",
        }),
      }),
      expect.objectContaining({
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.USER_MEMBER_LINK,
        targetType: "user",
        targetId: "u1",
        before: { memberId: null },
        after: { memberId: "m-new", reason: "role_sync" },
      }),
    ]);
  });

  it("links a council by its intranet id, whatever its acronym is now", async () => {
    // The council renamed its acronym: the id finds it, nothing is created.
    selects.push(
      [{ memberId: null }],
      [{ id: "m-ceum", kind: "asociado", intranetId: 412 }],
    );
    updated = [{ id: "u1" }];

    expect(await linkUserToIntranetMember("u1", { ...asociado, id: 412 })).toBe(
      "m-ceum",
    );
    expect(audits()).toEqual([
      expect.objectContaining({
        action: AUDIT_ACTIONS.USER_MEMBER_LINK,
        before: { memberId: null },
        after: { memberId: "m-ceum", reason: "role_sync" },
      }),
    ]);
  });

  it("falls back to the acronym, and creates the member with the id", async () => {
    selects.push([{ memberId: null }], [], []);
    inserted = [{ id: "m-new" }];
    updated = [{ id: "u1" }];

    expect(await linkUserToIntranetMember("u1", { ...asociado, id: 412 })).toBe(
      "m-new",
    );
    expect(audits()[0]).toMatchObject({
      action: AUDIT_ACTIONS.MEMBER_CREATE,
      after: { acronym: "CEUNEW", intranetId: 412 },
    });
  });

  it("links by email an account recreated with a new id", async () => {
    selects.push(
      [{ memberId: null, email: " CEUNEW@Uni.es" }],
      [],
      [
        {
          id: "m-ceunew",
          kind: "asociado",
          intranetId: 300,
          email: "ceunew@uni.es",
        },
      ],
    );
    updated = [{ id: "u1" }];

    expect(await linkUserToIntranetMember("u1", { ...asociado, id: 412 })).toBe(
      "m-ceunew",
    );
  });

  it("creates the member with the account's email", async () => {
    selects.push([{ memberId: null, email: "CEUNEW@uni.es" }], [], [], []);
    inserted = [{ id: "m-new" }];
    updated = [{ id: "u1" }];

    expect(await linkUserToIntranetMember("u1", { ...asociado, id: 412 })).toBe(
      "m-new",
    );
    // The email is stored on the member, never in its audit row.
    expect(audits()[0]).toMatchObject({ action: AUDIT_ACTIONS.MEMBER_CREATE });
    expect(JSON.stringify(audits())).not.toContain("ceunew@uni.es");
  });

  it("never links by acronym to a member of another email", async () => {
    selects.push(
      [{ memberId: null, email: "nuevo@uni.es" }],
      [],
      [],
      [
        {
          id: "m-other",
          kind: "asociado",
          intranetId: null,
          email: "viejo@uni.es",
        },
      ],
    );

    expect(
      await linkUserToIntranetMember("u1", { ...asociado, id: 412 }),
    ).toBeNull();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("never links by acronym to a member of another intranet account", async () => {
    selects.push(
      [{ memberId: null }],
      [],
      [{ id: "m-other", kind: "asociado", intranetId: 500 }],
    );
    updated = [{ id: "u1" }];

    expect(
      await linkUserToIntranetMember("u1", { ...asociado, id: 412 }),
    ).toBeNull();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("records nothing it did not do: a lost insert race or an unchanged link", async () => {
    // Another sign-in created the member first; the link was already set
    // (or an admin's manual link won), so the update touched no row.
    selects.push(
      [{ memberId: "m-other" }],
      [],
      [{ id: "m-ceunew", kind: "asociado" }],
    );
    inserted = [];
    updated = [];

    expect(await linkUserToIntranetMember("u1", asociado)).toBe("m-ceunew");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
