import { describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { Actor } from "../domain/actor";
import type { AmendmentVisibilityContext } from "../domain/visibility";

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { AUDIENCE_EVENT_TYPES, amendmentAudience, liveAudienceOf } =
  await import("./audience");
const { liveMessageReaches } = await import("./audienceFilter");
const { canSeeAmendment } = await import("../domain/visibility");
const { liveNotice } = await import("../domain/events");
const { toLiveEventDto } = await import("../domain/assemblies");

const CREATOR = "creator-user";
const AUTHOR = "author-member";
const PARTY = "party-member";

function makeActor(
  role: string,
  permissions: string[] = [],
  ids: { userId?: string; memberId?: string | null } = {},
): Actor {
  return {
    user: {
      id: ids.userId ?? "someone",
      name: "Someone",
      email: "someone@example.org",
      image: null,
      roleId: "role",
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: ids.memberId ?? null,
      lastRoleSyncAt: null,
      role: { id: "role", name: role },
    },
    memberId: ids.memberId ?? null,
    memberKind: null,
    isAdmin: false,
    permissions: permissions as Actor["permissions"],
    can: (key) => permissions.includes(key),
    impersonation: null,
  };
}

const ROOM = makeActor(SYSTEM_ROLES.ASOCIADO, [], { memberId: "other-member" });
const MESA = makeActor(SYSTEM_ROLES.MODERADOR, [
  PERMISSION_KEYS.SESSION_MODERATE,
]);
const SECRETARIA = makeActor(SYSTEM_ROLES.SECRETARIA, [
  PERMISSION_KEYS.AMENDMENT_REVIEW,
]);
const CEA = makeActor(SYSTEM_ROLES.CEA);
const SHEET_READER = makeActor(SYSTEM_ROLES.ASOCIADO, [
  PERMISSION_KEYS.CONTROL_SHEET_VIEW,
]);
// Custom roles that manage without reviewing: they read `hasAmendments`.
const DOCUMENT_MANAGER = makeActor("Gestión documental", [
  PERMISSION_KEYS.DOCUMENT_MANAGE,
]);
const ASSEMBLY_MANAGER = makeActor("Gestión de asambleas", [
  PERMISSION_KEYS.ASSEMBLY_MANAGE,
]);
const CREATOR_ACCOUNT = makeActor(SYSTEM_ROLES.ASOCIADO, [], {
  userId: CREATOR,
});
const AUTHOR_ACCOUNT = makeActor(SYSTEM_ROLES.ASOCIADO, [], {
  memberId: AUTHOR,
});
const PARTY_ACCOUNT = makeActor(SYSTEM_ROLES.ASOCIADO, [], {
  memberId: PARTY,
});

const ROW = {
  publishedAt: null,
  createdByUserId: CREATOR,
  memberIds: [AUTHOR, PARTY, AUTHOR],
};

const MESSAGE = {
  assemblyId: "as1",
  entityType: "amendment" as const,
  entityId: "am1",
  documentId: "doc1",
};

describe("amendmentAudience", () => {
  it("names the creator and the members of an unpublished amendment", () => {
    for (const type of AUDIENCE_EVENT_TYPES) {
      if (type === "amendment_deleted") continue;
      expect(amendmentAudience(type, {}, ROW)).toEqual({
        userIds: [CREATOR],
        memberIds: [AUTHOR, PARTY],
      });
    }
  });

  it("reaches everyone once the amendment is published", () => {
    expect(
      amendmentAudience(
        "amendment_submitted",
        {},
        { ...ROW, publishedAt: new Date() },
      ),
    ).toBeNull();
  });

  it("reaches everyone when the payload says it is or was public", () => {
    // Validated and published at once.
    expect(
      amendmentAudience("amendment_validated", { publish: true }, ROW),
    ).toBeNull();
    // A correction asked of a published amendment: the room drops it.
    expect(
      amendmentAudience(
        "amendment_correction_requested",
        { afterValidation: true, published: true },
        ROW,
      ),
    ).toBeNull();
    // The Mesa's transactional, presented in session.
    expect(
      amendmentAudience("amendment_submitted", { admission: "admitted" }, ROW),
    ).toBeNull();
  });

  it("keeps an unpublished validation and an unpublished correction private", () => {
    expect(
      amendmentAudience(
        "amendment_validated",
        { publish: false, admission: "admitted" },
        ROW,
      ),
    ).not.toBeNull();
    expect(
      amendmentAudience(
        "amendment_correction_requested",
        { afterValidation: true, published: false },
        ROW,
      ),
    ).not.toBeNull();
  });

  it("reaches everyone when a draft's authors change", () => {
    for (const payload of [
      { kind: "partial", authorMemberIds: [AUTHOR] },
      { kind: "partial", mainAuthorId: AUTHOR },
      { kind: "partial", onBehalfOfMemberId: AUTHOR },
    ]) {
      expect(amendmentAudience("amendment_updated", payload, ROW)).toBeNull();
    }
    expect(
      amendmentAudience("amendment_updated", { kind: "partial" }, ROW),
    ).not.toBeNull();
  });

  it("reads a deleted draft's audience from its payload", () => {
    expect(
      amendmentAudience(
        "amendment_deleted",
        {
          kind: "partial",
          createdByUserId: CREATOR,
          authorMemberIds: [AUTHOR],
          mainAuthorId: AUTHOR,
        },
        null,
      ),
    ).toEqual({ userIds: [CREATOR], memberIds: [AUTHOR] });
    // A transactional's parties are not in it.
    expect(
      amendmentAudience(
        "amendment_deleted",
        { kind: "transactional", createdByUserId: CREATOR },
        null,
      ),
    ).toBeNull();
    expect(amendmentAudience("amendment_deleted", {}, null)).toBeNull();
  });

  it("reaches everyone with any other event or without the amendment", () => {
    for (const type of [
      "amendment_published",
      "amendment_approved",
      "amendment_withdrawn",
      "amendment_reopened",
      "amendment_validation_undone",
      "position_changed",
      "transactional_revision_proposed",
    ]) {
      expect(amendmentAudience(type, {}, ROW)).toBeNull();
    }
    expect(amendmentAudience("amendment_created", {}, null)).toBeNull();
  });

  it("gives up on an audience too long for the notice", () => {
    const memberIds = Array.from({ length: 300 }, (_, i) => `m${i}`);
    expect(
      amendmentAudience("amendment_created", {}, { ...ROW, memberIds }),
    ).toBeNull();
  });
});

describe("liveAudienceOf", () => {
  it("reads nothing for other entities nor when the payload settles it", async () => {
    const transaction = vi.fn();
    const executor = {
      transaction,
      select: () => {
        throw new Error("no read expected");
      },
    } as never;
    expect(
      await liveAudienceOf(executor, {
        entityType: "vote",
        entityId: "v1",
        type: "amendment_created",
      }),
    ).toBeNull();
    expect(
      await liveAudienceOf(executor, {
        entityType: "amendment",
        entityId: "am1",
        type: "amendment_validated",
        payload: { publish: true },
      }),
    ).toBeNull();
    expect(
      await liveAudienceOf(executor, {
        entityType: "amendment",
        entityId: "am1",
        type: "amendment_deleted",
        payload: { kind: "formal", createdByUserId: CREATOR },
      }),
    ).toEqual({ userIds: [CREATOR], memberIds: [] });
    expect(transaction).not.toHaveBeenCalled();
  });

  /**
   * An executor whose reads only work inside a savepoint (`transaction`),
   * answering each select with the next of `results`.
   */
  function savepointExecutor(results: unknown[][] | Error) {
    const savepoint = {
      select: () => ({
        from: () => ({
          where: () =>
            results instanceof Error
              ? Promise.reject(results)
              : Promise.resolve(results.shift() ?? []),
        }),
      }),
    };
    const transaction = vi.fn(
      async (run: (sp: typeof savepoint) => Promise<unknown>) => run(savepoint),
    );
    const executor = {
      transaction,
      select: () => {
        throw new Error("read outside the savepoint");
      },
    };
    return { executor: executor as never, transaction };
  }

  it("reads the amendment in a savepoint", async () => {
    const { executor, transaction } = savepointExecutor([
      [{ kind: "formal", publishedAt: null, createdByUserId: CREATOR }],
      [{ memberId: AUTHOR }],
    ]);
    expect(
      await liveAudienceOf(executor, {
        entityType: "amendment",
        entityId: "am1",
        type: "amendment_created",
      }),
    ).toEqual({ userIds: [CREATOR], memberIds: [AUTHOR] });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("reaches everyone when the read fails, inside its savepoint", async () => {
    const { executor, transaction } = savepointExecutor(new Error("boom"));
    expect(
      await liveAudienceOf(executor, {
        entityType: "amendment",
        entityId: "am1",
        type: "amendment_created",
      }),
    ).toBeNull();
    // The failure stays in the savepoint, so the caller's write survives.
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe("liveMessageReaches", () => {
  const audience = { userIds: [CREATOR], memberIds: [AUTHOR, PARTY] };

  it("tells everyone of a message without an audience", () => {
    expect(liveMessageReaches(ROOM, {})).toBe(true);
    expect(liveMessageReaches(ROOM, { audience: undefined })).toBe(true);
  });

  it("leaves out the room", () => {
    expect(liveMessageReaches(ROOM, { audience })).toBe(false);
    expect(
      liveMessageReaches(makeActor(SYSTEM_ROLES.ASOCIADO), { audience }),
    ).toBe(false);
  });

  it("still tells the creator, the authors and the parties", () => {
    expect(liveMessageReaches(CREATOR_ACCOUNT, { audience })).toBe(true);
    expect(liveMessageReaches(AUTHOR_ACCOUNT, { audience })).toBe(true);
    expect(liveMessageReaches(PARTY_ACCOUNT, { audience })).toBe(true);
  });

  it("still tells whoever sees unpublished amendments", () => {
    for (const actor of [MESA, SECRETARIA, CEA, SHEET_READER]) {
      expect(liveMessageReaches(actor, { audience })).toBe(true);
    }
  });

  it("still tells whoever manages documents or assemblies", () => {
    // They read `hasAmendments`, drafts included (agendaDelete).
    expect(liveMessageReaches(DOCUMENT_MANAGER, { audience })).toBe(true);
    expect(liveMessageReaches(ASSEMBLY_MANAGER, { audience })).toBe(true);
  });

  it("tells everyone of a malformed audience", () => {
    expect(
      liveMessageReaches(ROOM, { audience: { userIds: "x" } as never }),
    ).toBe(true);
  });

  it("tells everyone who can see the amendment, in any state", () => {
    const actors = [
      ROOM,
      MESA,
      SECRETARIA,
      CEA,
      SHEET_READER,
      DOCUMENT_MANAGER,
      ASSEMBLY_MANAGER,
      CREATOR_ACCOUNT,
      AUTHOR_ACCOUNT,
      PARTY_ACCOUNT,
    ];
    const base: AmendmentVisibilityContext = {
      status: "draft",
      publishedAt: null,
      validatedAt: null,
      documentPresenters: { proponentMemberId: null, coProponentMemberIds: [] },
      createdByUserId: CREATOR,
      authorMemberIds: [AUTHOR],
      partyMemberIds: [PARTY],
    };
    const states: AmendmentVisibilityContext[] = [
      base,
      { ...base, status: "submitted" },
      { ...base, status: "submitted", validatedAt: new Date() },
      { ...base, status: "withdrawn", validatedAt: new Date() },
    ];
    for (const state of states) {
      for (const actor of actors) {
        if (canSeeAmendment(actor, state)) {
          expect(liveMessageReaches(actor, { audience })).toBe(true);
        }
      }
    }
  });
});

describe("liveNotice", () => {
  it("carries the audience in the notice but never to clients", () => {
    const audience = { userIds: [CREATOR], memberIds: [AUTHOR] };
    const notice = liveNotice({
      ...MESSAGE,
      type: "amendment_created",
      audience,
    });
    expect(notice.audience).toEqual(audience);
    expect(toLiveEventDto(notice)).toEqual({
      entityType: "amendment",
      entityId: "am1",
      type: "amendment_created",
      documentId: "doc1",
    });
  });

  it("leaves out an audience that would make the notice too long", () => {
    // Cuids: 400 of them are over 8000 bytes.
    const memberIds = Array.from(
      { length: 400 },
      (_, i) => `${"c".repeat(20)}${String(i).padStart(4, "0")}`,
    );
    const notice = liveNotice({
      ...MESSAGE,
      type: "amendment_created",
      audience: { userIds: [], memberIds },
    });
    expect(notice.audience).toBeUndefined();
  });
});
