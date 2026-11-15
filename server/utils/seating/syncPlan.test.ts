import { describe, expect, it } from "vitest";
import {
  intranetAttendeesResponseSchema,
  type IntranetAttendeesResponse,
} from "~~/shared/utils/schemas/seating";
import {
  planSeatingSync,
  syncChangedRows,
  type SyncGroupRow,
  type SyncPersonRow,
} from "./syncPlan";

// Invented accounts and people: never real attendees.

const NOW = new Date("2026-11-15T10:00:00Z");
const EARLIER = new Date("2026-11-14T10:00:00Z");

function response(
  accounts: Record<string, unknown>[],
  attendees: Record<string, unknown>[],
): IntranetAttendeesResponse {
  return intranetAttendeesResponseSchema.parse({
    event: {
      id: 900,
      name: "999.ª Asamblea General Ordinaria",
      start_date: "2026-11-18",
      end_date: "2026-11-22",
    },
    accounts,
    attendees,
    generated_at: "2026-11-15T10:00:00+01:00",
  });
}

const account = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "Asociado",
  category: "Multiusuario",
  initials: `CE${id}`,
  designation: `Consejo de Estudiantes ${id}`,
  university_acronym: null,
  order: null,
  logo_version: null,
  ...overrides,
});

const attendee = (
  id: number,
  accountId: number,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  account_id: accountId,
  name: `Nombre${id}`,
  surname: `Apellido${id}`,
  status: "Confirmada",
  modality: "Regular",
  photo_version: null,
  ...overrides,
});

const group = (overrides: Partial<SyncGroupRow>): SyncGroupRow => ({
  id: "g",
  source: "intranet",
  intranetAccountId: null,
  memberId: null,
  kind: "asociado",
  intranetType: "Asociado",
  category: "multiuser",
  acronym: "X",
  name: "X",
  logoVersion: null,
  logoFile: null,
  order: null,
  goneAt: null,
  ...overrides,
});

const person = (overrides: Partial<SyncPersonRow>): SyncPersonRow => ({
  id: "p",
  groupId: "g",
  source: "intranet",
  intranetAttendeeId: null,
  firstName: null,
  surname: null,
  status: "confirmed",
  photoVersion: null,
  photoFile: null,
  position: 0,
  goneAt: null,
  ...overrides,
});

function ids() {
  let next = 0;
  return () => `new${String(next++).padStart(21, "0")}`;
}

/** The group and people a first sync of account 1 with attendees 11, 12 makes. */
const synced = {
  group: group({
    id: "g1",
    intranetAccountId: 1,
    acronym: "CE1",
    name: "Consejo de Estudiantes 1",
  }),
  people: [
    person({
      id: "p11",
      groupId: "g1",
      intranetAttendeeId: 11,
      firstName: "Nombre11",
      surname: "Apellido11",
      position: 0,
    }),
    person({
      id: "p12",
      groupId: "g1",
      intranetAttendeeId: 12,
      firstName: "Nombre12",
      surname: "Apellido12",
      position: 1,
    }),
  ],
};

describe("planSeatingSync", () => {
  it("makes a group per account and a person per attendee, in order", () => {
    const plan = planSeatingSync({
      groups: [],
      people: [],
      response: response(
        [
          account(1, { logo_version: "aa11" }),
          account(2, { type: "CEA", category: "Individual", order: 3 }),
        ],
        [
          attendee(11, 1, { photo_version: "bb22" }),
          attendee(12, 1, { status: "Pendiente" }),
          attendee(21, 2),
        ],
      ),
      memberIdByIntranetId: new Map([[1, "member-1"]]),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupInserts).toEqual([
      expect.objectContaining({
        source: "intranet",
        intranetAccountId: 1,
        memberId: "member-1",
        kind: "asociado",
        category: "multiuser",
        acronym: "CE1",
        name: "Consejo de Estudiantes 1",
        logoVersion: "aa11",
        logoFile: null,
      }),
      expect.objectContaining({
        intranetAccountId: 2,
        memberId: null,
        kind: "cea",
        intranetType: "CEA",
        category: "individual",
        order: 3,
      }),
    ]);
    const [g1, g2] = plan.groupInserts;
    expect(plan.peopleInserts).toEqual([
      expect.objectContaining({
        groupId: g1!.id,
        intranetAttendeeId: 11,
        firstName: "Nombre11",
        status: "confirmed",
        position: 0,
        photoVersion: "bb22",
      }),
      expect.objectContaining({
        groupId: g1!.id,
        intranetAttendeeId: 12,
        status: "pending",
        position: 1,
      }),
      expect.objectContaining({
        groupId: g2!.id,
        intranetAttendeeId: 21,
        position: 0,
      }),
    ]);
    expect(plan.images).toEqual([
      { kind: "logo", id: g1!.id, intranetId: 1, version: "aa11" },
      {
        kind: "photo",
        id: plan.peopleInserts[0]!.id,
        intranetId: 11,
        version: "bb22",
      },
    ]);
    expect(plan.counts).toEqual({
      groups: { created: 2, updated: 0, gone: 0, back: 0 },
      people: { created: 3, updated: 0, gone: 0, back: 0 },
    });
  });

  it("keeps the CAS's kind `cea` and its Intranet type", () => {
    const plan = planSeatingSync({
      groups: [],
      people: [],
      response: response(
        [account(5, { type: "CAS", category: "Individual", initials: "CAS" })],
        [],
      ),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupInserts[0]).toMatchObject({
      kind: "cea",
      intranetType: "CAS",
      acronym: "CAS",
    });
  });

  it("writes nothing when nothing changed", () => {
    const plan = planSeatingSync({
      groups: [synced.group],
      people: synced.people,
      response: response([account(1)], [attendee(11, 1), attendee(12, 1)]),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupInserts).toEqual([]);
    expect(plan.groupUpdates).toEqual([]);
    expect(plan.peopleInserts).toEqual([]);
    expect(plan.peopleUpdates).toEqual([]);
    expect(plan.images).toEqual([]);
    expect(plan.removeFiles).toEqual([]);
    expect(syncChangedRows(plan.counts)).toBe(false);
  });

  it("writes only the fields that changed", () => {
    const plan = planSeatingSync({
      groups: [synced.group],
      people: synced.people,
      response: response(
        [account(1, { initials: "CE1b" })],
        [attendee(11, 1, { status: "Pendiente" }), attendee(12, 1)],
      ),
      memberIdByIntranetId: new Map([[1, "member-1"]]),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupUpdates).toEqual([
      { id: "g1", set: { memberId: "member-1", acronym: "CE1b" } },
    ]);
    expect(plan.peopleUpdates).toEqual([
      { id: "p11", set: { status: "pending" } },
    ]);
    expect(plan.counts.groups.updated).toBe(1);
    expect(plan.counts.people.updated).toBe(1);
  });

  it("marks what the Intranet stops listing as gone, and drops its image", () => {
    const plan = planSeatingSync({
      groups: [
        { ...synced.group, logoVersion: "aa11", logoFile: "logo-g1-aa11.webp" },
      ],
      people: [
        {
          ...synced.people[0]!,
          photoVersion: "bb22",
          photoFile: "photo-p11-bb22.webp",
        },
        synced.people[1]!,
      ],
      response: response([], []),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupUpdates).toEqual([
      {
        id: "g1",
        set: { goneAt: NOW, logoVersion: null, logoFile: null },
      },
    ]);
    expect(plan.peopleUpdates).toEqual([
      { id: "p11", set: { goneAt: NOW, photoVersion: null, photoFile: null } },
      { id: "p12", set: { goneAt: NOW, photoVersion: null, photoFile: null } },
    ]);
    expect(plan.removeFiles.sort()).toEqual([
      "logo-g1-aa11.webp",
      "photo-p11-bb22.webp",
    ]);
    expect(plan.counts.groups.gone).toBe(1);
    expect(plan.counts.people.gone).toBe(2);
  });

  it("brings back what returns, with its image queued again", () => {
    const plan = planSeatingSync({
      groups: [{ ...synced.group, goneAt: EARLIER }],
      people: [{ ...synced.people[0]!, goneAt: EARLIER }],
      response: response(
        [account(1, { logo_version: "aa11" })],
        [attendee(11, 1, { photo_version: "bb22" })],
      ),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupUpdates).toEqual([
      { id: "g1", set: { logoVersion: "aa11", logoFile: null, goneAt: null } },
    ]);
    expect(plan.peopleUpdates).toEqual([
      {
        id: "p11",
        set: { photoVersion: "bb22", photoFile: null, goneAt: null },
      },
    ]);
    expect(plan.images.map((image) => image.kind)).toEqual(["logo", "photo"]);
    expect(plan.counts.groups).toMatchObject({ back: 1, updated: 1 });
    expect(plan.counts.people).toMatchObject({ back: 1, updated: 1 });
  });

  it("replaces an image whose version changed or turned null", () => {
    const plan = planSeatingSync({
      groups: [
        { ...synced.group, logoVersion: "aa11", logoFile: "logo-g1-aa11.webp" },
      ],
      people: [
        {
          ...synced.people[0]!,
          photoVersion: "bb22",
          photoFile: "photo-p11-bb22.webp",
        },
      ],
      response: response(
        [account(1, { logo_version: "cc33" })],
        [attendee(11, 1, { photo_version: null })],
      ),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupUpdates).toEqual([
      { id: "g1", set: { logoVersion: "cc33", logoFile: null } },
    ]);
    expect(plan.peopleUpdates).toEqual([
      { id: "p11", set: { photoVersion: null, photoFile: null } },
    ]);
    expect(plan.removeFiles.sort()).toEqual([
      "logo-g1-aa11.webp",
      "photo-p11-bb22.webp",
    ]);
    expect(plan.images).toEqual([
      { kind: "logo", id: "g1", intranetId: 1, version: "cc33" },
    ]);
  });

  it("clears the file with its version even when the row read had none", () => {
    // The worker may name a file for the old version between the sync's
    // read and its write: the write never leaves it on the row.
    const plan = planSeatingSync({
      groups: [{ ...synced.group, logoVersion: "aa11" }],
      people: [{ ...synced.people[0]!, photoVersion: "bb22" }],
      response: response(
        [account(1, { logo_version: null })],
        [attendee(11, 1, { photo_version: "dd44" })],
      ),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupUpdates).toEqual([
      { id: "g1", set: { logoVersion: null, logoFile: null } },
    ]);
    expect(plan.peopleUpdates).toEqual([
      { id: "p11", set: { photoVersion: "dd44", photoFile: null } },
    ]);
  });

  it("queues again an image that has a version and no file yet", () => {
    const plan = planSeatingSync({
      groups: [{ ...synced.group, logoVersion: "aa11" }],
      people: [],
      response: response([account(1, { logo_version: "aa11" })], []),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupUpdates).toEqual([]);
    expect(plan.images).toEqual([
      { kind: "logo", id: "g1", intranetId: 1, version: "aa11" },
    ]);
  });

  it("never touches groups made by hand, people added by hand or placeholders", () => {
    const manualGroup = group({
      id: "gm",
      source: "manual",
      kind: "mesa",
      intranetType: null,
      category: null,
      acronym: "Mesa",
    });
    const plan = planSeatingSync({
      groups: [manualGroup, synced.group],
      people: [
        person({ id: "pm", groupId: "gm", source: "placeholder", position: 0 }),
        person({
          id: "px",
          groupId: "g1",
          source: "manual",
          firstName: "Invitada",
          position: 5,
        }),
        ...synced.people,
      ],
      response: response(
        [account(1)],
        [attendee(11, 1), attendee(12, 1), attendee(13, 1)],
      ),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupUpdates).toEqual([]);
    expect(plan.peopleUpdates).toEqual([]);
    // A new person goes after the group's last, people added by hand counted.
    expect(plan.peopleInserts).toEqual([
      expect.objectContaining({ intranetAttendeeId: 13, position: 6 }),
    ]);
  });

  it("moves a person whose registration changed account", () => {
    const plan = planSeatingSync({
      groups: [
        synced.group,
        group({ id: "g2", intranetAccountId: 2, acronym: "CE2", name: "CE2" }),
      ],
      people: [synced.people[0]!],
      response: response(
        [account(1), account(2, { initials: "CE2", designation: "CE2" })],
        [attendee(11, 2)],
      ),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.peopleUpdates).toEqual([{ id: "p11", set: { groupId: "g2" } }]);
  });

  it("names an account without initials by its designation, or its id", () => {
    const plan = planSeatingSync({
      groups: [],
      people: [],
      response: response(
        [
          account(7, { initials: null, designation: "Prensa del evento" }),
          account(8, { initials: null, designation: null }),
        ],
        [],
      ),
      memberIdByIntranetId: new Map(),
      now: NOW,
      newId: ids(),
    });
    expect(plan.groupInserts.map((row) => [row.acronym, row.name])).toEqual([
      ["Prensa del evento", "Prensa del evento"],
      ["#8", "#8"],
    ]);
  });
});
