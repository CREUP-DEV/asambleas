import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { MemberRef } from "~~/shared/types/api";
import { GENERIC_EXECUTIVE_MEMBER } from "~~/shared/constants/domain";
import type { Actor } from "./actor";
import type { AgendaItemRow } from "./assemblies";
import { numberAgendaItems } from "~~/shared/utils/agendaNumbering";

const query = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const requireActor = vi.hoisted(() => vi.fn());

vi.mock("h3", async (original) => ({
  ...(await original<typeof import("h3")>()),
  getQuery: () => query.value,
}));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("./actor", async (original) => ({
  ...(await original<typeof import("./actor")>()),
  requireActor,
}));

const { canModerate } = await import("./actor");
const {
  canSeeAmendment,
  canSeeDocument,
  canSeeExecutiveMembers,
  redactMember,
} = await import("./visibility");
const { agendaItemDtos } = await import("./assemblies");
const {
  ROOM_VIEWER_ID,
  isRoomViewer,
  requireViewer,
  roomViewOf,
  roomViewer,
  screenTitleReadable,
  withScreenItem,
} = await import("./roomView");

const MESA_ID = "m".repeat(32);

function makeActor(role: string, permissions: string[] = []): Actor {
  const admin = role === SYSTEM_ROLES.ADMIN;
  return {
    user: {
      id: MESA_ID,
      name: "Vocalía de la Mesa",
      email: "mesa@example.org",
      image: null,
      roleId: "role",
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: null,
      lastRoleSyncAt: null,
      role: { id: "role", name: role },
    },
    memberId: null,
    memberKind: null,
    isAdmin: admin,
    permissions: permissions as Actor["permissions"],
    can: (key) => admin || permissions.includes(key),
    impersonation: null,
  };
}

const MESA = makeActor(SYSTEM_ROLES.MODERADOR, [
  PERMISSION_KEYS.SESSION_MODERATE,
]);

function makeEvent(method = "GET") {
  return {
    method,
    context: {} as Record<string, unknown>,
  } as never as Parameters<typeof requireViewer>[0] & {
    context: Record<string, unknown>;
  };
}

const OFFICE: MemberRef = {
  id: "office".padEnd(24, "a"),
  acronym: "SE",
  name: "Secretaría Ejecutiva",
  kind: "executive",
};

describe("roomViewer", () => {
  const room = roomViewer(MESA);

  it("reads as an account that sees only what is public", () => {
    expect(isRoomViewer(room)).toBe(true);
    expect(isRoomViewer(MESA)).toBe(false);
    expect(room.user.id).toBe(ROOM_VIEWER_ID);
    expect(room.user.role).toBeNull();
    expect(room.memberId).toBeNull();
    expect(room.isAdmin).toBe(false);
    expect(room.permissions).toEqual([]);
    expect(canModerate(room)).toBe(false);
  });

  it("does not see the executive offices, whatever the Mesa sees", () => {
    expect(canSeeExecutiveMembers(MESA)).toBe(true);
    expect(canSeeExecutiveMembers(room)).toBe(false);
    expect(redactMember(room, OFFICE)).toEqual(GENERIC_EXECUTIVE_MEMBER);
    // An Admin opening the projection reads as the room too.
    expect(
      canSeeExecutiveMembers(roomViewer(makeActor(SYSTEM_ROLES.ADMIN))),
    ).toBe(false);
  });

  it("is never the creator of what the Mesa account created", () => {
    const unpublished = {
      status: "submitted" as const,
      publishedAt: null,
      createdByUserId: MESA_ID,
      authorMemberIds: [],
      partyMemberIds: [],
    };
    expect(canSeeAmendment(MESA, unpublished)).toBe(true);
    expect(canSeeAmendment(room, unpublished)).toBe(false);
    expect(
      canSeeAmendment(room, { ...unpublished, publishedAt: new Date() }),
    ).toBe(true);
    const submitted = {
      status: "submitted" as const,
      submittedByUserId: MESA_ID,
      proponentMemberId: null,
      coProponentMemberIds: [],
    };
    expect(canSeeDocument(room, submitted)).toBe(false);
    expect(canSeeDocument(room, { ...submitted, status: "published" })).toBe(
      true,
    );
  });
});

describe("requireViewer", () => {
  beforeEach(() => {
    query.value = {};
    requireActor.mockReset();
  });

  it("changes nothing without the flag", async () => {
    requireActor.mockResolvedValue(MESA);
    const event = makeEvent();
    await expect(requireViewer(event)).resolves.toBe(MESA);
    expect(event.context.actor).toBeUndefined();
    expect(roomViewOf(event)).toBeUndefined();
  });

  it("answers as the room viewer to the Mesa, for every later requireActor", async () => {
    requireActor.mockResolvedValue(MESA);
    query.value = { view: "room" };
    const event = makeEvent();
    const viewer = await requireViewer(event);
    expect(isRoomViewer(viewer)).toBe(true);
    // The cached actor the shared resolvers read through requireActor.
    expect(event.context.actor).toBe(viewer);
    // The Mesa account stays at hand: the room never reads more than it.
    expect(roomViewOf(event)).toBe(MESA);
  });

  it("refuses the flag to anyone who does not moderate", async () => {
    requireActor.mockResolvedValue(
      makeActor(SYSTEM_ROLES.SECRETARIA, [PERMISSION_KEYS.DOCUMENT_MANAGE]),
    );
    query.value = { view: "room" };
    const event = makeEvent();
    await expect(requireViewer(event)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(event.context.actor).toBeUndefined();
  });

  it("refuses any other view and the flag on a write", async () => {
    requireActor.mockResolvedValue(MESA);
    query.value = { view: "mesa" };
    await expect(requireViewer(makeEvent())).rejects.toMatchObject({
      statusCode: 400,
    });
    query.value = { view: "room" };
    await expect(requireViewer(makeEvent("POST"))).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

// The item the Mesa puts on screen -----------------------------------------

const row = (
  id: string,
  parentId: string | null,
  order: number,
  extra: Partial<AgendaItemRow> = {},
): AgendaItemRow => ({
  id,
  assemblyId: "assembly",
  parentId,
  title: `Title ${id}`,
  description: null,
  order,
  acceptsSubmissions: false,
  submissionKinds: [],
  generatedForDocumentId: null,
  hiddenWithDocumentId: null,
  titleWithheld: false,
  titleCustom: false,
  createdAt: new Date("2026-11-01T09:00:00Z"),
  updatedAt: new Date("2026-11-01T09:00:00Z"),
  ...extra,
});

describe("withScreenItem", () => {
  const rows = [
    row("first", null, 0),
    row("resolutions", null, 1, { acceptsSubmissions: true }),
    row("published", "resolutions", 0, { generatedForDocumentId: "d-pub" }),
    row("late", "resolutions", 1, { generatedForDocumentId: "d-late" }),
    row("withheld", "resolutions", 2, { titleWithheld: true }),
    row("last", null, 2),
  ];
  // What the room viewer gets: only public documents.
  const listed = agendaItemDtos(
    rows,
    [{ id: "d-pub", agendaItemId: "published", status: "published" }],
    false,
  );
  const ids = (items: { id: string }[]) => items.map((item) => item.id);

  it("leaves the agenda alone when the item on screen is listed", () => {
    expect(ids(listed)).not.toContain("late");
    expect(withScreenItem(listed, rows, "published")).toBe(listed);
    expect(withScreenItem(listed, rows, null)).toBe(listed);
  });

  it("adds the item on screen, unlisted, with its title, in its place", () => {
    const items = withScreenItem(listed, rows, "late", true);
    expect(ids(items)).toEqual([
      "first",
      "resolutions",
      "published",
      "late",
      "last",
    ]);
    const late = items.find((item) => item.id === "late")!;
    expect(late).toMatchObject({
      title: "Title late",
      titleHidden: false,
      unlisted: true,
      // Its title only: never what document it was created for.
      description: null,
      generatedForDocumentId: null,
    });
  });

  it("adds the items above it without their titles", () => {
    const nested = [...rows, row("child", "late", 0, { title: "Child" })];
    const items = withScreenItem(listed, nested, "child", true);
    // Flat, in the order the rows are loaded: the client builds the tree.
    expect(ids(items)).toEqual([
      "first",
      "resolutions",
      "published",
      "late",
      "last",
      "child",
    ]);
    expect(items.find((item) => item.id === "late")).toMatchObject({
      title: "",
      titleHidden: true,
      unlisted: true,
    });
    expect(items.find((item) => item.id === "child")).toMatchObject({
      title: "Child",
      titleHidden: false,
    });
  });

  it("never gives the room a withheld title", () => {
    const items = withScreenItem(listed, rows, "withheld", true);
    expect(items.find((item) => item.id === "withheld")).toMatchObject({
      title: "",
      titleHidden: true,
    });
  });

  it("gives no title the Mesa account does not read, only a place", () => {
    const items = withScreenItem(listed, rows, "late", false);
    expect(ids(items)).toContain("late");
    expect(items.find((item) => item.id === "late")).toMatchObject({
      title: "",
      titleHidden: true,
      unlisted: true,
    });
  });

  describe("an item the room receives without its title", () => {
    // "holder" carries the title of a draft document, but stays for the
    // room because it holds the item of a published one.
    const held = [
      row("first", null, 0),
      row("resolutions", null, 1, { acceptsSubmissions: true }),
      row("holder", "resolutions", 0, { generatedForDocumentId: "d-draft" }),
      row("inner", "holder", 0, { generatedForDocumentId: "d-in" }),
      row("next", "resolutions", 1),
      row("last", null, 2),
    ];
    const roomList = agendaItemDtos(
      held,
      [{ id: "d-in", agendaItemId: "inner", status: "published" }],
      false,
    );

    it("keeps its place and everyone's numbers", () => {
      const holder = roomList.find((item) => item.id === "holder")!;
      expect(holder).toMatchObject({ titleHidden: true, unlisted: false });
      const before = numberAgendaItems(roomList);
      expect(before.get("holder")).toBe("2.1");

      const items = withScreenItem(roomList, held, "holder", true);
      expect(ids(items)).toEqual(ids(roomList));
      expect(items.find((item) => item.id === "holder")).toMatchObject({
        title: "Title holder",
        titleHidden: false,
        unlisted: false,
      });
      const after = numberAgendaItems(items);
      expect(after).toEqual(before);
      expect(after.get("inner")).toBe("2.1.1");
      expect(after.get("next")).toBe("2.2");
      expect(after.get("last")).toBe("3");
    });

    it("stays as it is when the Mesa account does not read the title", () => {
      expect(withScreenItem(roomList, held, "holder", false)).toBe(roomList);
    });
  });
});

// Whether the room reads the title on screen ------------------------------

/** An executor that answers each select with the next of `results`. */
function fakeExecutor(...results: unknown[][]) {
  const queue = [...results];
  const chain = {
    from: () => chain,
    where: async () => queue.shift() ?? [],
  };
  return { select: () => chain } as never;
}

describe("screenTitleReadable", () => {
  const draftDocument = {
    id: "d-draft",
    status: "draft",
    submittedByUserId: "someone-else",
    proponentMemberId: "council",
  };
  const item = row("auto", "resolutions", 0, {
    generatedForDocumentId: "d-draft",
  });

  it("hides the title of a draft from a Mesa account that cannot read it", async () => {
    await expect(
      screenTitleReadable(MESA, item, fakeExecutor([draftDocument], [])),
    ).resolves.toBe(false);
  });

  it("gives the title the Mesa account reads", async () => {
    // The Mesa reads a document sent to the Secretaría.
    await expect(
      screenTitleReadable(
        MESA,
        item,
        fakeExecutor([{ ...draftDocument, status: "submitted" }], []),
      ),
    ).resolves.toBe(true);
    // An item that carries no document's title.
    await expect(
      screenTitleReadable(MESA, row("plain", null, 0), fakeExecutor()),
    ).resolves.toBe(true);
  });

  it("never gives a withheld title, nor one without the Mesa account", async () => {
    const admin = makeActor(SYSTEM_ROLES.ADMIN);
    await expect(
      screenTitleReadable(
        admin,
        row("withheld", null, 0, { titleWithheld: true }),
        fakeExecutor(),
      ),
    ).resolves.toBe(false);
    await expect(
      screenTitleReadable(undefined, row("plain", null, 0), fakeExecutor()),
    ).resolves.toBe(false);
  });
});
