import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IntranetAttendeesResponse } from "~~/shared/utils/schemas/seating";
import type { SeatingLayout } from "~~/shared/utils/seating/layout";
import type { Actor } from "./actor";
import type { AssemblyRow } from "./assemblies";

/**
 * Opt-in check of the seating SQL against a real database (locks, the
 * partial unique indexes, the batch's delete and insert, the sync's
 * writes and its throttle):
 *
 *   SEATING_DB_TEST=1 pnpm exec vitest run server/utils/domain/seating.db.test.ts
 *
 * It makes a draft AGO numbered 990 to 999 (the first free one) and deletes
 * it at the end with everything it held. The Intranet is never called: a
 * fake answer with invented people stands in for it, without images, so
 * nothing is queued, and the image worker gets a picture made here. Its
 * files go to a temporary folder. Use a development database. Skipped
 * otherwise, and nothing touching the database is imported then.
 */
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("../seating/intranet", async (original) => ({
  ...(await original<typeof import("../seating/intranet")>()),
  fetchSeatingImage: vi.fn(),
}));

const enabled = Boolean(process.env.SEATING_DB_TEST);

const id = (seed: string) => seed.padEnd(24, "0");

const LAYOUT: SeatingLayout = {
  schemaVersion: 1,
  tables: [
    {
      id: id("tablea"),
      shape: "rect",
      x: 0,
      y: 0,
      w: 180,
      h: 60,
      rotation: 0,
      zone: "delegates",
      run: "outer-u",
      seats: [
        { id: id("seata"), side: "front", index: 0 },
        { id: id("seatb"), side: "front", index: 1 },
        { id: id("seatc"), side: "front", index: 2 },
        { id: id("seatd"), side: "back", index: 0 },
      ],
    },
  ],
  chairs: [{ id: id("chaira"), x: 0, y: 300, rotation: 0 }],
  fixtures: [],
  template: { kind: "empty", params: {} },
};

function answer(
  accounts: number[],
  attendees: [number, number][],
): IntranetAttendeesResponse {
  return {
    event: {
      id: 900_001,
      name: "Asamblea de prueba",
      start_date: null,
      end_date: null,
    },
    accounts: accounts.map((account) => ({
      id: account,
      type: "Asociado",
      category: "Multiusuario",
      initials: `CP${account % 1000}`,
      designation: `Consejo de prueba ${account % 1000}`,
      university_acronym: null,
      order: null,
      logo_version: null,
    })),
    attendees: attendees.map(([attendee, account]) => ({
      id: attendee,
      account_id: account,
      name: `Nombre${attendee % 1000}`,
      surname: "Inventado",
      status: "Confirmada" as const,
      photo_version: null,
    })),
    generated_at: null,
  };
}

describe.skipIf(!enabled)("seating SQL on the database", () => {
  const load = async () => {
    const { db } = await import("../../db");
    const schema = await import("../../db/schema");
    const seating = await import("./seating");
    const drizzle = await import("drizzle-orm");
    return { db, schema, seating, drizzle };
  };

  let actor: Actor;
  let assembly: AssemblyRow;

  beforeAll(async () => {
    if (!enabled) return;
    const { db, schema, drizzle } = await load();
    const [user] = await db.select().from(schema.users).limit(1);
    expect(user).toBeDefined();
    const permissions = ["seating:view", "seating:edit"];
    actor = {
      user: { ...user!, role: null },
      memberId: null,
      memberKind: null,
      isAdmin: false,
      permissions: permissions as Actor["permissions"],
      can: (key: string) => permissions.includes(key),
      impersonation: null,
    } as unknown as Actor;
    const taken = await db
      .select({ number: schema.assemblies.number })
      .from(schema.assemblies)
      .where(
        drizzle.and(
          drizzle.eq(schema.assemblies.type, "AGO"),
          drizzle.gte(schema.assemblies.number, 990),
        ),
      );
    const used = new Set(taken.map((row) => row.number));
    const number = [990, 991, 992, 993, 994, 995, 996, 997, 998, 999].find(
      (candidate) => !used.has(candidate),
    );
    expect(number).toBeDefined();
    const [created] = await db
      .insert(schema.assemblies)
      .values({
        type: "AGO",
        number: number!,
        status: "draft",
        startDate: new Date("2099-11-18T09:00:00Z"),
        endDate: new Date("2099-11-22T14:00:00Z"),
        location: "Sala de pruebas",
      })
      .returning();
    assembly = created!;
  });

  afterAll(async () => {
    if (!enabled) return;
    const { db, schema, drizzle } = await load();
    if (assembly) {
      await db
        .delete(schema.assemblies)
        .where(drizzle.eq(schema.assemblies.id, assembly.id));
    }
    await db.$client.end();
  });

  const reasonOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      const failure = error as {
        statusCode?: number;
        data?: Record<string, unknown>;
      };
      return { status: failure.statusCode, data: failure.data ?? {} };
    }
    throw new Error("expected a refusal");
  };

  it("runs a whole room", async () => {
    const { db, schema, seating, drizzle } = await load();
    const events = async () =>
      (
        await db
          .select({ type: schema.events.type, payload: schema.events.payload })
          .from(schema.events)
          .where(drizzle.eq(schema.events.assemblyId, assembly.id))
      ).filter((row) => row.type.startsWith("seating_"));

    // A read creates nothing.
    const empty = await seating.loadSeatingPlan(actor, assembly);
    expect(empty).toMatchObject({ planId: null, groups: [], people: [] });

    // The first layout makes the plan with the Mesa and its two placeholders.
    const saved = await seating.saveSeatingLayout(actor, assembly, {
      layout: LAYOUT,
      updatedAt: null,
    });
    expect(saved.released).toEqual([]);
    let plan = await seating.loadSeatingPlan(actor, assembly);
    expect(plan.groups).toEqual([
      expect.objectContaining({ kind: "mesa", acronym: "Mesa" }),
    ]);
    expect(plan.people.map((person) => person.label)).toEqual([
      "Presidencia de la Mesa",
      "Vocalía de la Mesa",
    ]);
    expect(
      await reasonOf(
        seating.saveSeatingLayout(actor, assembly, {
          layout: LAYOUT,
          updatedAt: null,
        }),
      ),
    ).toMatchObject({ status: 409, data: { reason: "seating_stale" } });

    // A sync.
    const first = await seating.syncSeating(actor, assembly, async () => ({
      outcome: "ok",
      data: answer(
        [900_041, 900_042],
        [
          [900_501, 900_041],
          [900_502, 900_041],
          [900_503, 900_042],
        ],
      ),
    }));
    expect(first.called).toBe(true);
    expect(first.counts).toEqual({
      groups: { created: 2, updated: 0, gone: 0, back: 0 },
      people: { created: 3, updated: 0, gone: 0, back: 0 },
    });
    expect(first.plan.sync).toMatchObject({
      status: "ok",
      eventName: "Asamblea de prueba",
    });
    // Within a minute it calls nothing.
    const fetcher = vi.fn();
    expect((await seating.syncSeating(actor, assembly, fetcher)).called).toBe(
      false,
    );
    expect(fetcher).not.toHaveBeenCalled();

    const age = async () =>
      db
        .update(schema.seatingPlans)
        .set({ syncedAt: new Date(Date.now() - 120_000) })
        .where(drizzle.eq(schema.seatingPlans.assemblyId, assembly.id));
    // The same answer again changes nothing and records nothing.
    await age();
    const before = (await events()).length;
    const same = await seating.syncSeating(actor, assembly, async () => ({
      outcome: "ok",
      data: answer(
        [900_041, 900_042],
        [
          [900_501, 900_041],
          [900_502, 900_041],
          [900_503, 900_042],
        ],
      ),
    }));
    expect(same.counts).toEqual({
      groups: { created: 0, updated: 0, gone: 0, back: 0 },
      people: { created: 0, updated: 0, gone: 0, back: 0 },
    });
    expect((await events()).length).toBe(before);

    plan = same.plan;
    const byAttendee = (n: number) =>
      plan.people.find((person) => person.firstName === `Nombre${n}`)!;
    const ana = byAttendee(501);
    const bea = byAttendee(502);
    const carla = byAttendee(503);
    const [seatA, seatB, seatC] = LAYOUT.tables[0]!.seats.map((s) => s.id);

    // Seat two, then swap them.
    let result = await seating.applySeatingAssignments(actor, assembly, {
      ops: [
        { seatId: seatA!, expected: null, next: ana.id },
        { seatId: seatB!, expected: null, next: bea.id },
      ],
    });
    expect(result.assignments).toHaveLength(2);
    result = await seating.applySeatingAssignments(actor, assembly, {
      ops: [
        { seatId: seatA!, expected: ana.id, next: bea.id },
        { seatId: seatB!, expected: bea.id, next: ana.id },
      ],
    });
    expect(
      new Map(result.assignments.map((row) => [row.seatId, row.personId])),
    ).toEqual(
      new Map([
        [seatA!, bea.id],
        [seatB!, ana.id],
      ]),
    );
    // A stale view, and a person sent to a second seat, answer 409.
    expect(
      await reasonOf(
        seating.applySeatingAssignments(actor, assembly, {
          ops: [{ seatId: seatA!, expected: ana.id, next: null }],
        }),
      ),
    ).toMatchObject({
      status: 409,
      data: {
        reason: "seating_stale",
        seats: [{ seatId: seatA, personId: bea.id }],
      },
    });
    expect(
      await reasonOf(
        seating.applySeatingAssignments(actor, assembly, {
          ops: [{ seatId: seatC!, expected: null, next: ana.id }],
        }),
      ),
    ).toMatchObject({
      status: 409,
      data: { seats: [{ seatId: seatB, personId: ana.id }] },
    });
    // Two batches racing for the same empty seat: one wins, one is stale.
    const race = await Promise.allSettled([
      seating.applySeatingAssignments(actor, assembly, {
        ops: [{ seatId: seatC!, expected: null, next: carla.id }],
      }),
      seating.applySeatingAssignments(actor, assembly, {
        ops: [
          {
            seatId: seatC!,
            expected: null,
            next: plan.people.find((person) => person.source === "placeholder")!
              .id,
          },
        ],
      }),
    ]);
    expect(race.map((entry) => entry.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const lost = race.find((entry) => entry.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect(lost?.reason).toMatchObject({
      statusCode: 409,
      data: { reason: "seating_stale" },
    });

    // Whoever lost the race, carla sits somewhere: on the loose chair if
    // the placeholder took her seat.
    const seated = (await seating.loadSeatingPlan(actor, assembly)).assignments;
    if (!seated.some((row) => row.personId === carla.id)) {
      await seating.applySeatingAssignments(actor, assembly, {
        ops: [{ seatId: id("chaira"), expected: null, next: carla.id }],
      });
    }

    // A layout that removes an occupied seat asks first, then frees it.
    const layout = (await seating.loadSeatingPlan(actor, assembly))
      .layoutUpdatedAt;
    const smaller: SeatingLayout = {
      ...LAYOUT,
      tables: [
        {
          ...LAYOUT.tables[0]!,
          seats: LAYOUT.tables[0]!.seats.filter((seat) => seat.id !== seatA),
        },
      ],
    };
    expect(
      await reasonOf(
        seating.saveSeatingLayout(actor, assembly, {
          layout: smaller,
          updatedAt: layout,
        }),
      ),
    ).toMatchObject({
      status: 409,
      data: {
        reason: "seating_seats_occupied",
        seats: [{ seatId: seatA, personId: bea.id }],
      },
    });
    // A confirmation names who was shown: someone else on that seat is not
    // covered by it.
    expect(
      await reasonOf(
        seating.saveSeatingLayout(actor, assembly, {
          layout: smaller,
          updatedAt: layout,
          releaseSeats: [{ seatId: seatA!, personId: carla.id }],
        }),
      ),
    ).toMatchObject({
      status: 409,
      data: {
        reason: "seating_seats_occupied",
        seats: [{ seatId: seatA, personId: bea.id }],
      },
    });
    const released = await seating.saveSeatingLayout(actor, assembly, {
      layout: smaller,
      updatedAt: layout,
      releaseSeats: [{ seatId: seatA!, personId: bea.id }],
    });
    expect(released.released).toEqual([{ seatId: seatA, personId: bea.id }]);

    // «No necesita asiento» frees the seat; a stale token is refused.
    const anaNow = (await seating.loadSeatingPlan(actor, assembly)).people.find(
      (person) => person.id === ana.id,
    )!;
    const patched = await seating.updateSeatingPerson(actor, assembly, ana.id, {
      updatedAt: anaNow.updatedAt,
      needsSeat: false,
    });
    expect(patched.released).toEqual([{ seatId: seatB, personId: ana.id }]);
    // A tab that has not seen the mark yet cannot seat her again.
    expect(
      await reasonOf(
        seating.applySeatingAssignments(actor, assembly, {
          ops: [{ seatId: seatB!, expected: null, next: ana.id }],
        }),
      ),
    ).toMatchObject({
      status: 409,
      data: { reason: "seating_stale", unknownPersonIds: [ana.id] },
    });
    expect(
      await reasonOf(
        seating.updateSeatingPerson(actor, assembly, ana.id, {
          updatedAt: anaNow.updatedAt,
          needsSeat: true,
        }),
      ),
    ).toMatchObject({ status: 409, data: { reason: "seating_stale" } });
    expect(
      await reasonOf(
        seating.updateSeatingPerson(actor, assembly, ana.id, {
          updatedAt: patched.person.updatedAt,
          firstName: "Otra",
        }),
      ),
    ).toMatchObject({ status: 422 });

    // Groups and people made by hand; the Mesa and the Intranet's stay.
    const press = await seating.createSeatingGroup(actor, assembly, {
      acronym: "Prensa",
      name: "Prensa",
    });
    const guest = await seating.createSeatingPerson(actor, assembly, {
      source: "manual",
      groupId: press.id,
      firstName: "Invitada",
      surname: null,
    });
    expect(guest).toMatchObject({ status: "manual", position: 0 });
    const renamed = await seating.updateSeatingGroup(
      actor,
      assembly,
      press.id,
      {
        updatedAt: press.updatedAt,
        name: "Prensa y fotografía",
      },
    );
    expect(renamed.name).toBe("Prensa y fotografía");
    const mesa = plan.groups.find((group) => group.kind === "mesa")!;
    expect(
      await reasonOf(seating.deleteSeatingGroup(actor, assembly, mesa.id)),
    ).toMatchObject({ status: 422 });
    expect(
      await reasonOf(seating.deleteSeatingPerson(actor, assembly, carla.id)),
    ).toMatchObject({ status: 422 });
    const placeholder = plan.people.find(
      (person) => person.source === "placeholder",
    )!;
    const filled = await seating.updateSeatingPerson(
      actor,
      assembly,
      placeholder.id,
      {
        updatedAt: (await seating.loadSeatingPlan(actor, assembly)).people.find(
          (person) => person.id === placeholder.id,
        )!.updatedAt,
        firstName: "Presidenta",
      },
    );
    expect(filled.person).toMatchObject({ source: "manual" });
    expect(
      (await seating.deleteSeatingGroup(actor, assembly, press.id)).released,
    ).toEqual([]);

    // An account the Intranet stops listing is gone; not_found keeps it.
    await age();
    const gone = await seating.syncSeating(actor, assembly, async () => ({
      outcome: "ok",
      data: answer(
        [900_041],
        [
          [900_501, 900_041],
          [900_502, 900_041],
        ],
      ),
    }));
    expect(gone.counts).toMatchObject({
      groups: { gone: 1 },
      people: { gone: 1 },
    });
    // carla keeps her seat: nobody leaves a seat without saying so.
    expect(gone.plan.assignments).toContainEqual(
      expect.objectContaining({ personId: carla.id }),
    );
    await age();
    const missing = await seating.syncSeating(actor, assembly, async () => ({
      outcome: "notFound",
    }));
    expect(missing.plan.sync).toMatchObject({
      status: "not_found",
      eventName: null,
    });
    expect(
      missing.plan.groups.filter((group) => group.goneAt === null),
    ).toHaveLength(2);

    // The source: compare-and-set on what the client read.
    expect(
      await reasonOf(
        seating.setSeatingSource(actor, assembly, {
          sourceAssemblyId: id("someotherassembly"),
          expected: id("notwhatitis"),
        }),
      ),
    ).toMatchObject({ status: 409, data: { reason: "seating_stale" } });
    expect(
      await reasonOf(
        seating.setSeatingSource(actor, assembly, {
          sourceAssemblyId: assembly.id,
          expected: null,
        }),
      ),
    ).toMatchObject({ status: 422 });

    // The image worker names its file without touching the lock token, and
    // the route serves only what a row names now.
    const { mkdtemp, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sharp = (await import("sharp")).default;
    const intranet = await import("../seating/intranet");
    const images = await import("../seating/images");
    const dir = await mkdtemp(join(tmpdir(), "seating-db-"));
    vi.stubEnv("UPLOAD_STORAGE_DIR", dir);
    try {
      const picture = await sharp({
        create: {
          width: 64,
          height: 48,
          channels: 3,
          background: { r: 20, g: 90, b: 160 },
        },
      })
        .png()
        .toBuffer();
      vi.mocked(intranet.fetchSeatingImage).mockResolvedValue({
        outcome: "ok",
        data: picture,
      });
      await db
        .update(schema.seatingPeople)
        .set({ photoVersion: "ab12" })
        .where(drizzle.eq(schema.seatingPeople.id, bea.id));
      const before = (
        await seating.loadSeatingPlan(actor, assembly)
      ).people.find((person) => person.id === bea.id)!;
      const job = {
        assemblyId: assembly.id,
        planId: missing.plan.planId!,
        kind: "photo" as const,
        id: bea.id,
        intranetId: 900_502,
        version: "ab12",
      };
      expect(await images.processSeatingImageJob(job)).toBe("cached");
      const after = (
        await seating.loadSeatingPlan(actor, assembly)
      ).people.find((person) => person.id === bea.id)!;
      const name = `photo-${bea.id}-ab12.webp`;
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(after.photoUrl).toBe(
        `/api/assemblies/${assembly.id}/seating/images/${name}`,
      );
      expect(await seating.resolveSeatingImage(actor, assembly, name)).toBe(
        join(dir, "seating", job.planId, name),
      );
      expect(
        await reasonOf(
          seating.resolveSeatingImage(
            actor,
            assembly,
            `photo-${bea.id}-ffff.webp`,
          ),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await reasonOf(
          seating.resolveSeatingImage(
            actor,
            assembly,
            `photo-${ana.id}-ab12.webp`,
          ),
        ),
      ).toMatchObject({ status: 404 });

      // A sync changes the version while the image is on its way.
      await db
        .update(schema.seatingPeople)
        .set({ photoVersion: "cd34", photoFile: null })
        .where(drizzle.eq(schema.seatingPeople.id, bea.id));
      vi.mocked(intranet.fetchSeatingImage).mockImplementation(async () => {
        await db
          .update(schema.seatingPeople)
          .set({ photoVersion: "ef56" })
          .where(drizzle.eq(schema.seatingPeople.id, bea.id));
        return { outcome: "ok", data: picture };
      });
      expect(
        await images.processSeatingImageJob({ ...job, version: "cd34" }),
      ).toBe("stale");
      expect(await readdir(join(dir, "seating", job.planId))).toEqual([name]);
    } finally {
      images.stopSeatingImages();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }

    // Events carry no names.
    const recorded = JSON.stringify(await events());
    expect(recorded).not.toContain("Nombre");
    expect(recorded).not.toContain("Inventado");
    expect(recorded).not.toContain("Invitada");
    expect(recorded).not.toContain("Presidenta");
  });

  it("compares a first choice of source on the plan it makes", async () => {
    const { db, schema, seating, drizzle } = await load();
    // A Mesa account sees draft assemblies, this test's own among them.
    const permissions = ["seating:view", "seating:edit", "session:moderate"];
    const mesa = {
      ...actor,
      permissions,
      can: (key: string) => permissions.includes(key),
    } as unknown as Actor;
    const taken = await db
      .select({ number: schema.assemblies.number })
      .from(schema.assemblies)
      .where(
        drizzle.and(
          drizzle.eq(schema.assemblies.type, "AGO"),
          drizzle.gte(schema.assemblies.number, 990),
        ),
      );
    const used = new Set(taken.map((row) => row.number));
    const number = [990, 991, 992, 993, 994, 995, 996, 997, 998, 999].find(
      (candidate) => !used.has(candidate),
    );
    expect(number).toBeDefined();
    const [other] = await db
      .insert(schema.assemblies)
      .values({
        type: "AGO",
        number: number!,
        status: "draft",
        startDate: new Date("2099-11-18T09:00:00Z"),
        endDate: new Date("2099-11-22T14:00:00Z"),
        location: "Sala de pruebas",
      })
      .returning();
    try {
      const plans = () =>
        db
          .select({ source: schema.seatingPlans.sourceAssemblyId })
          .from(schema.seatingPlans)
          .where(drizzle.eq(schema.seatingPlans.assemblyId, other!.id));

      // Its own attendees, asked for while it has none: no plan is made.
      expect(
        await seating.setSeatingSource(mesa, other!, {
          sourceAssemblyId: null,
          expected: null,
        }),
      ).toEqual({ sourceAssemblyId: null });
      expect(await plans()).toEqual([]);

      // Two first choices at once: the second finds the first's plan and
      // is stale, never overwriting it.
      const race = await Promise.allSettled([
        seating.setSeatingSource(mesa, other!, {
          sourceAssemblyId: assembly.id,
          expected: null,
        }),
        seating.setSeatingSource(mesa, other!, {
          sourceAssemblyId: assembly.id,
          expected: null,
        }),
      ]);
      expect(race.map((entry) => entry.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const lost = race.find((entry) => entry.status === "rejected") as
        PromiseRejectedResult | undefined;
      expect(lost?.reason).toMatchObject({
        statusCode: 409,
        data: { reason: "seating_stale", sourceAssemblyId: assembly.id },
      });
      expect(await plans()).toEqual([{ source: assembly.id }]);
    } finally {
      await db
        .delete(schema.assemblies)
        .where(drizzle.eq(schema.assemblies.id, other!.id));
    }
  });
});
