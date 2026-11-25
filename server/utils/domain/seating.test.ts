import { beforeEach, describe, expect, it, vi } from "vitest";
import { GENERIC_EXECUTIVE_MEMBER_ID } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AssemblyRow } from "./assemblies";
import { testActor } from "../../testing/actor";

// The seating domain with the database stubbed: guards, DTOs and the order
// of a sync, not its SQL (seating.db.test.ts runs that on a database).

const dbState = vi.hoisted(() => ({
  /** What each select resolves to, in call order; [] once exhausted. */
  selects: [] as unknown[][],
  /** What each update ... returning() resolves to, in call order. */
  updates: [] as unknown[][],
  /** What each insert resolves to, in call order; and how many ran. */
  inserts: [] as unknown[][],
  inserted: 0,
}));

/** A query builder: every method returns it, and awaiting it gives `result`. */
function chain(result: () => unknown): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (
            resolve: (value: unknown) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve(result()).then(resolve, reject);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

vi.mock("../../db", () => {
  const db: Record<string, unknown> = {
    select: () => chain(() => dbState.selects.shift() ?? []),
    selectDistinct: () => chain(() => []),
    insert: () => {
      dbState.inserted += 1;
      return chain(() => dbState.inserts.shift() ?? []);
    },
    update: () => chain(() => dbState.updates.shift() ?? []),
    delete: () => chain(() => []),
    query: { assemblies: { findFirst: async () => undefined } },
  };
  db.transaction = async (run: (tx: unknown) => Promise<unknown>) => run(db);
  return { db };
});
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("./documents", () => ({ shareLockAssembly: vi.fn() }));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));
vi.mock("../seating/images", () => ({
  enqueueSeatingImages: vi.fn(),
  removeSeatingImageFiles: vi.fn(),
}));

const { recordEvent } = await import("./events");
const { canSeeExecutiveMembers } = await import("./visibility");
const { SEATING_NOT_FOUND_REASON } =
  await import("~~/shared/constants/errorReasons");
const {
  createSeatingPerson,
  requireSeatingEditor,
  requireSeatingReader,
  requireSeatingRoom,
  setSeatingSource,
  syncSeating,
  toSeatingGroupDto,
  toSeatingPersonDto,
  updateSeatingPerson,
} = await import("./seating");

const READER = testActor({
  role: "Otro",
  permissions: [PERMISSION_KEYS.SEATING_VIEW],
});
const EDITOR = testActor({
  role: "Otro",
  permissions: [PERMISSION_KEYS.SEATING_EDIT],
});
const NOBODY = testActor({ role: "Otro" });

const ASSEMBLY = {
  id: "asm1b2c3d4e5f6g7h8i9j0k1",
  type: "AGO",
  number: 80,
  status: "convened",
} as AssemblyRow;

const statusOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return {
      statusCode: (error as { statusCode?: number }).statusCode,
      reason: (error as { data?: { reason?: string } }).data?.reason,
    };
  }
  return null;
};

describe("seating guards", () => {
  it("lets read whoever holds seating:view or seating:edit", () => {
    expect(statusOf(() => requireSeatingReader(READER))).toBeNull();
    expect(statusOf(() => requireSeatingReader(EDITOR))).toBeNull();
    expect(statusOf(() => requireSeatingReader(NOBODY))).toMatchObject({
      statusCode: 403,
    });
  });

  it("lets write only seating:edit", () => {
    expect(statusOf(() => requireSeatingEditor(EDITOR))).toBeNull();
    expect(statusOf(() => requireSeatingEditor(READER))).toMatchObject({
      statusCode: 403,
    });
  });

  it("gives an AGET no room", () => {
    expect(statusOf(() => requireSeatingRoom({ type: "AGO" }))).toBeNull();
    expect(statusOf(() => requireSeatingRoom({ type: "AGE" }))).toBeNull();
    expect(statusOf(() => requireSeatingRoom({ type: "AGET" }))).toEqual({
      statusCode: 404,
      reason: SEATING_NOT_FOUND_REASON,
    });
  });

  it("lets every seating reader see the offices, which the room names", () => {
    // If this fails, the room would name offices to someone who may not see
    // them: give the seating keys back to EXECUTIVE_VISIBLE_PERMISSIONS.
    expect(canSeeExecutiveMembers(READER)).toBe(true);
    expect(canSeeExecutiveMembers(EDITOR)).toBe(true);
  });
});

describe("seating DTOs", () => {
  const office = {
    id: "off1b2c3d4e5f6g7h8i9j0k1",
    acronym: "SE",
    name: "Secretaría Ejecutiva",
    kind: "executive" as const,
    university: null,
  };
  const council = {
    id: "cou1b2c3d4e5f6g7h8i9j0k1",
    acronym: "CEX",
    name: "Consejo de Estudiantes X",
    kind: "asociado" as const,
    university: "Universidad X",
  };
  const row = {
    id: "grp1b2c3d4e5f6g7h8i9j0k1",
    planId: "pln1b2c3d4e5f6g7h8i9j0k1",
    source: "intranet" as const,
    intranetAccountId: 41,
    memberId: council.id,
    kind: "asociado" as const,
    intranetType: "Asociado",
    category: "multiuser" as const,
    acronym: "CEX",
    name: "Consejo de Estudiantes X",
    logoVersion: "3f2a",
    logoFile: "logo-grp1b2c3d4e5f6g7h8i9j0k1-3f2a.webp",
    order: null,
    goneAt: null,
    createdAt: new Date("2026-11-15T10:00:00Z"),
    updatedAt: new Date("2026-11-15T10:00:00Z"),
  };

  it("carries the member with its university and the cached logo", () => {
    expect(toSeatingGroupDto(READER, ASSEMBLY.id, row, council)).toMatchObject({
      member: council,
      imageUrl: `/api/assemblies/${ASSEMBLY.id}/seating/images/${row.logoFile}`,
      updatedAt: "2026-11-15T10:00:00.000Z",
    });
  });

  it("passes the member through redactMember", () => {
    expect(
      toSeatingGroupDto(READER, ASSEMBLY.id, row, office).member,
    ).toMatchObject({ id: office.id, acronym: "SE" });
    expect(toSeatingGroupDto(NOBODY, ASSEMBLY.id, row, office).member).toEqual({
      id: GENERIC_EXECUTIVE_MEMBER_ID,
      acronym: "CEA",
      name: expect.any(String),
      kind: "executive",
      university: null,
    });
  });

  it("serves no image of what the Intranet no longer lists", () => {
    const gone = { ...row, goneAt: new Date() };
    expect(toSeatingGroupDto(READER, ASSEMBLY.id, gone, null)).toMatchObject({
      imageUrl: null,
      member: null,
    });
    const person = {
      id: "per1b2c3d4e5f6g7h8i9j0k1",
      planId: row.planId,
      groupId: row.id,
      source: "intranet" as const,
      intranetAttendeeId: 501,
      firstName: "Lucía",
      surname: "Inventada",
      label: null,
      status: "pending" as const,
      goneAt: new Date(),
      needsSeat: true,
      userId: null,
      photoVersion: "9f2c",
      photoFile: "photo-per1b2c3d4e5f6g7h8i9j0k1-9f2c.webp",
      position: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(toSeatingPersonDto(ASSEMBLY.id, person).photoUrl).toBeNull();
    expect(
      toSeatingPersonDto(ASSEMBLY.id, { ...person, goneAt: null }).photoUrl,
    ).toBe(`/api/assemblies/${ASSEMBLY.id}/seating/images/${person.photoFile}`);
  });

  it("serves no image of a version the row no longer has", () => {
    // A file the worker named while a sync took the image down.
    expect(
      toSeatingGroupDto(
        READER,
        ASSEMBLY.id,
        { ...row, logoVersion: null },
        null,
      ).imageUrl,
    ).toBeNull();
    expect(
      toSeatingGroupDto(
        READER,
        ASSEMBLY.id,
        { ...row, logoVersion: "aaaa" },
        null,
      ).imageUrl,
    ).toBeNull();
  });
});

describe("syncSeating", () => {
  const plan = {
    id: "pln1b2c3d4e5f6g7h8i9j0k1",
    assemblyId: ASSEMBLY.id,
    layout: null,
    layoutUpdatedAt: null,
    layoutUpdatedByUserId: null,
    intranetEventId: null,
    intranetEventName: null,
    sourceAssemblyId: null,
    syncedAt: new Date(),
    syncStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    dbState.selects = [];
    dbState.updates = [];
    vi.mocked(recordEvent).mockClear();
  });

  it("calls nothing within a minute of the last call", async () => {
    // The claim's compare-and-set finds no row; then the stored plan.
    dbState.updates = [[]];
    dbState.selects = [[plan]];
    const fetcher = vi.fn();
    const result = await syncSeating(EDITOR, ASSEMBLY, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      called: false,
      counts: null,
      plan: { planId: plan.id },
    });
  });

  it("goes on quietly when the Intranet does not have the route yet", async () => {
    dbState.updates = [[plan]];
    dbState.selects = [[plan], [{ ...plan, syncStatus: "unavailable" }]];
    const fetcher = vi.fn(async () => ({
      outcome: "unavailable" as const,
      status: 404,
    }));
    const result = await syncSeating(EDITOR, ASSEMBLY, fetcher);
    expect(fetcher).toHaveBeenCalledWith("AGO", 80);
    expect(result).toMatchObject({ called: true, counts: null });
    expect(result.plan.sync.status).toBe("unavailable");
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: "seating",
        type: "seating_synced",
        payload: { status: "unavailable" },
      }),
    );
  });

  it("records counts and never a name", async () => {
    dbState.updates = [[plan]];
    // The locked plan, its groups, its people, the members linked.
    dbState.selects = [[plan], [], [], []];
    const fetcher = vi.fn(async () => ({
      outcome: "ok" as const,
      data: {
        event: {
          id: 900,
          name: "999.ª Asamblea General Ordinaria",
          start_date: null,
          end_date: null,
        },
        accounts: [
          {
            id: 41,
            type: "Asociado",
            category: "Multiusuario",
            initials: "CEX",
            designation: "Consejo de Estudiantes X",
            university_acronym: null,
            order: null,
            logo_version: null,
          },
        ],
        attendees: [
          {
            id: 501,
            account_id: 41,
            name: "Lucía",
            surname: "Inventada",
            status: "Confirmada" as const,
            photo_version: null,
          },
        ],
        generated_at: null,
      },
    }));
    const result = await syncSeating(EDITOR, ASSEMBLY, fetcher);
    expect(result.counts).toEqual({
      groups: { created: 1, updated: 0, gone: 0, back: 0 },
      people: { created: 1, updated: 0, gone: 0, back: 0 },
    });
    const [, recorded] = vi.mocked(recordEvent).mock.calls[0]!;
    expect(recorded.payload).toEqual({
      status: "ok",
      groups: { created: 1, updated: 0, gone: 0, back: 0 },
      people: { created: 1, updated: 0, gone: 0, back: 0 },
    });
    expect(JSON.stringify(recorded)).not.toContain("Lucía");
    expect(JSON.stringify(recorded)).not.toContain("Inventada");
  });

  it("refuses an account that may only read", async () => {
    await expect(syncSeating(READER, ASSEMBLY, vi.fn())).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe("setSeatingSource", () => {
  const OTHER = "oth1b2c3d4e5f6g7h8i9j0k1";
  const plan = {
    id: "pln1b2c3d4e5f6g7h8i9j0k1",
    assemblyId: ASSEMBLY.id,
    sourceAssemblyId: null as string | null,
    syncedAt: null,
    syncStatus: null,
  };

  beforeEach(() => {
    dbState.selects = [];
    dbState.inserts = [];
    dbState.inserted = 0;
    vi.mocked(recordEvent).mockClear();
  });

  it("makes no plan to keep reading its own attendees", async () => {
    dbState.selects = [[]];
    await expect(
      setSeatingSource(EDITOR, ASSEMBLY, {
        sourceAssemblyId: null,
        expected: null,
      }),
    ).resolves.toEqual({ sourceAssemblyId: null });
    expect(dbState.inserted).toBe(0);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("compares with the plan once locked, never one read before it existed", async () => {
    // Another editor's first choice made the plan meanwhile: the locked
    // row carries it, and this one, which saw none, is stale.
    dbState.selects = [[{ ...plan, sourceAssemblyId: OTHER }]];
    await expect(
      setSeatingSource(EDITOR, ASSEMBLY, {
        sourceAssemblyId: "yyy1b2c3d4e5f6g7h8i9j0k1",
        expected: null,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { reason: "seating_stale", sourceAssemblyId: OTHER },
    });
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe("linking a person to an account", () => {
  const plan = { id: "pln1b2c3d4e5f6g7h8i9j0k1", assemblyId: ASSEMBLY.id };
  const mesa = {
    id: "mes1b2c3d4e5f6g7h8i9j0k1",
    planId: plan.id,
    source: "manual" as const,
    kind: "mesa" as const,
    memberId: null,
  };
  const press = { ...mesa, id: "prs1b2c3d4e5f6g7h8i9j0k1", kind: "other" };
  const SOMEONE_ELSE = "s".repeat(32);

  beforeEach(() => {
    dbState.selects = [];
    dbState.inserts = [];
    vi.mocked(recordEvent).mockClear();
  });

  it("links a Mesa person only to the editor's own account", async () => {
    dbState.selects = [[plan], [mesa]];
    await expect(
      createSeatingPerson(EDITOR, ASSEMBLY, {
        source: "manual",
        groupId: mesa.id,
        firstName: "Nombre",
        userId: SOMEONE_ELSE,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    dbState.selects = [[plan], [press]];
    await expect(
      createSeatingPerson(EDITOR, ASSEMBLY, {
        source: "manual",
        groupId: press.id,
        firstName: "Nombre",
        userId: EDITOR.user.id,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("refuses to change a link to someone else's account", async () => {
    const person = {
      id: "per1b2c3d4e5f6g7h8i9j0k1",
      planId: plan.id,
      groupId: mesa.id,
      source: "manual" as const,
      userId: null,
      updatedAt: new Date("2026-11-15T10:00:00Z"),
    };
    dbState.selects = [[plan], [person], [{ kind: "mesa", memberId: null }]];
    await expect(
      updateSeatingPerson(EDITOR, ASSEMBLY, person.id, {
        updatedAt: "2026-11-15T10:00:00.000Z",
        userId: SOMEONE_ELSE,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
