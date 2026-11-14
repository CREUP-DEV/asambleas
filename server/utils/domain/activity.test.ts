import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AUDIT_ACTION_VALUES, EVENT_TYPES } from "~~/shared/constants/activity";
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  GENERIC_EXECUTIVE_MEMBER,
  GENERIC_EXECUTIVE_MEMBER_ID,
} from "~~/shared/constants/domain";
import {
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import type { ActivityItemDto } from "~~/shared/types/api";
import { decodeActivityCursor } from "~~/shared/utils/schemas/activity";
import type { Actor } from "./actor";

// Only the pure parts run here: the database and the auth layer are stubbed,
// so the real visibility rules (visibility.ts, actor.ts) judge every row.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("./resolvers", () => ({ resolveAssembly: vi.fn() }));
vi.mock("./amendments", () => ({
  // The same rule as amendments.ts.
  redactAmendmentEventPayload: (
    type: string,
    payload: Record<string, unknown>,
    positionsVisible: boolean,
  ) => (type === "position_changed" && !positionsVisible ? {} : payload),
}));
vi.mock("./documents", async () => {
  const actor = await vi.importActual<typeof import("./actor")>("./actor");
  const visibility =
    await vi.importActual<typeof import("./visibility")>("./visibility");
  // The same rules as documents.ts.
  return {
    assemblySettings: (assembly: { settings: object | null }) => ({
      ...DEFAULT_ASSEMBLY_SETTINGS,
      ...(assembly.settings ?? {}),
    }),
    canSeeDocumentCorrection: (
      viewer: Actor,
      document: Parameters<typeof visibility.isDocumentPresenter>[1] & {
        submittedByUserId: string | null;
      },
    ) =>
      actor.canManageDocuments(viewer) ||
      visibility.isDocumentPresenter(viewer, document) ||
      document.submittedByUserId === viewer.user.id,
  };
});

const {
  ADMIN_ONLY_ACTIONS,
  AUDIT_PAYLOAD_KEYS,
  EVENT_PAYLOAD_KEYS,
  activityQuery,
  adminActivityBranches,
  allowActivityPayload,
  collectActivityIds,
  collectActivityPage,
  containsPattern,
  emptyActivityLookups,
  meActivityBranches,
  roleTenure,
  toAdminActivityItem,
  toMeActivityItem,
} = await import("./activity");

type Lookups = ReturnType<typeof emptyActivityLookups>;
type Row = Parameters<typeof toMeActivityItem>[2];

const dialect = new PgDialect();
const render = (query: SQL) => dialect.sqlToQuery(query);

// Fixtures ------------------------------------------------------------------------

const ME = "u".repeat(32);
const OTHER = "o".repeat(32);
const ADMIN = "a".repeat(32);
const MEMBER = "m1aaaaaaaaaaaaaaaaaaaaaa";
const OTHER_MEMBER = "m2aaaaaaaaaaaaaaaaaaaaaa";

function makeActor(
  options: {
    id?: string;
    memberId?: string | null;
    permissions?: PermissionKey[];
    isAdmin?: boolean;
  } = {},
): Actor {
  const permissions = options.permissions ?? [];
  const admin = options.isAdmin ?? false;
  return {
    user: {
      id: options.id ?? ME,
      name: "Ana",
      email: "ana@example.org",
      image: null,
      roleId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: options.memberId ?? null,
      lastRoleSyncAt: null,
      role: null,
    },
    memberId: options.memberId ?? null,
    isAdmin: admin,
    permissions,
    can: (key) => admin || permissions.includes(key),
    impersonation: null,
  };
}

let sequence = 0;
function row(overrides: Partial<Row>): Row {
  sequence += 1;
  return {
    kind: "event",
    id: `row${String(sequence).padStart(21, "0")}`,
    at: "2026-11-05T10:15:30.123456Z",
    action: "assembly_updated",
    source: "user",
    actorUserId: ME,
    actorMemberId: null,
    impersonationId: null,
    assemblyId: "asm",
    targetType: "assembly",
    targetId: "asm",
    payload: {},
    ipAddress: null,
    userAgent: null,
    approximate: null,
    ...overrides,
  };
}

/** One convened assembly with a published document of OTHER_MEMBER and three amendments. */
function lookups(): Lookups {
  const result = emptyActivityLookups();
  result.assemblies.set("asm", {
    id: "asm",
    number: 80,
    type: "AGO",
    status: "convened",
    settings: { ...DEFAULT_ASSEMBLY_SETTINGS, positionVisibility: "mesa" },
  });
  result.assemblies.set("draftasm", {
    id: "draftasm",
    number: 81,
    type: "AGO",
    status: "draft",
    settings: DEFAULT_ASSEMBLY_SETTINGS,
  });
  result.documents.set("doc", {
    id: "doc",
    assemblyId: "asm",
    slug: "presupuesto",
    title: "Presupuesto",
    status: "published",
    proponentMemberId: OTHER_MEMBER,
    submittedByUserId: null,
    coProponentMemberIds: [],
  });
  result.documents.set("draftdoc", {
    id: "draftdoc",
    assemblyId: "asm",
    slug: "borrador",
    title: "Borrador",
    status: "draft",
    proponentMemberId: OTHER_MEMBER,
    submittedByUserId: null,
    coProponentMemberIds: [],
  });
  // Presented by OTHER_MEMBER, not published yet.
  result.amendments.set("hidden", {
    id: "hidden",
    documentId: "doc",
    code: "CEUM 1",
    status: "submitted",
    publishedAt: null,
    validatedAt: null,
    createdByUserId: OTHER,
    authorMemberIds: [OTHER_MEMBER],
    partyMemberIds: [],
  });
  result.amendments.set("public", {
    id: "public",
    documentId: "doc",
    code: "CEUM 2",
    status: "submitted",
    publishedAt: new Date("2026-11-01T10:00:00Z"),
    validatedAt: new Date("2026-11-01T10:00:00Z"),
    createdByUserId: OTHER,
    authorMemberIds: [OTHER_MEMBER],
    partyMemberIds: [],
  });
  result.amendments.set("mine", {
    id: "mine",
    documentId: "doc",
    code: "CEUA 1",
    status: "submitted",
    publishedAt: new Date("2026-11-01T10:00:00Z"),
    validatedAt: new Date("2026-11-01T10:00:00Z"),
    createdByUserId: ME,
    authorMemberIds: [MEMBER],
    partyMemberIds: [],
  });
  result.users.set(ME, { id: ME, name: "Ana" });
  result.users.set(OTHER, { id: OTHER, name: "Luis" });
  result.users.set(ADMIN, { id: ADMIN, name: "Admin" });
  result.members.set(MEMBER, {
    id: MEMBER,
    acronym: "CEUA",
    name: "Consejo A",
    kind: "asociado",
  });
  result.roles.set("role1", "Asociado");
  result.impersonations.set("imp1", {
    id: "imp1",
    adminUserId: ADMIN,
    targetUserId: ME,
    sessionId: "session",
    reason: "Soporte",
    startedAt: new Date("2026-11-05T09:00:00Z"),
    expiresAt: new Date("2026-11-05T10:00:00Z"),
    endedAt: new Date("2026-11-05T09:30:00Z"),
    endReason: "stopped",
    ipAddress: "10.0.0.1",
    userAgent: "Admin browser",
  });
  return result;
}

function meItem(
  actor: Actor,
  tab: "by" | "to" | "access" | "member",
  overrides: Partial<Row>,
  data: Lookups = lookups(),
): ActivityItemDto | null {
  return toMeActivityItem(actor, tab, row(overrides), data);
}

// Payload allowlists -----------------------------------------------------------------

describe("payload allowlists", () => {
  it("list every event type and every audit action", () => {
    expect(Object.keys(EVENT_PAYLOAD_KEYS).sort()).toEqual(
      [...EVENT_TYPES].sort(),
    );
    expect(Object.keys(AUDIT_PAYLOAD_KEYS).sort()).toEqual(
      [...AUDIT_ACTION_VALUES].sort(),
    );
  });

  it("drops ids of other rows and internal fields from events", () => {
    expect(
      allowActivityPayload("event", "amendment_created", {
        kind: "transactional",
        code: "T1",
        sourceIds: ["a", "b"],
        authorMemberIds: [MEMBER],
        onBehalfOfMemberId: MEMBER,
      }),
    ).toEqual({ kind: "transactional", code: "T1" });
    expect(
      allowActivityPayload("event", "document_created", {
        title: "Presupuesto",
        kind: "regulation",
        dueAt: "2026-11-10T00:00:00Z",
        proponentMemberId: MEMBER,
      }),
    ).toEqual({ title: "Presupuesto", kind: "regulation" });
    expect(
      allowActivityPayload("event", "document_voted", {
        result: "approved",
        appliedAmendmentIds: ["x"],
        consolidatedVersionId: "v",
      }),
    ).toEqual({ result: "approved" });
  });

  it("narrows edits to the fields shown, ids only as changed", () => {
    expect(
      allowActivityPayload("event", "document_updated", {
        fields: ["title", "proponentMemberId"],
        proponentMemberId: MEMBER,
        coProponentMemberIds: [OTHER_MEMBER],
        changes: {
          title: { from: "Borrador", to: "Presupuesto" },
          proponentMemberId: { from: OTHER_MEMBER, to: MEMBER },
          coProponentMemberIds: { from: [], to: [OTHER_MEMBER] },
          dueAt: { from: null, to: "2026-11-10T00:00:00.000Z" },
          internal: { from: 1, to: 2 },
        },
      }),
    ).toEqual({
      fields: ["title", "proponentMemberId"],
      changes: {
        title: { from: "Borrador", to: "Presupuesto" },
        proponentMemberId: {},
        coProponentMemberIds: {},
        dueAt: { from: null, to: "2026-11-10T00:00:00.000Z" },
      },
    });
    // Nothing shown is left: no `changes` at all.
    expect(
      allowActivityPayload("event", "agenda_item_updated", {
        from: "p1",
        to: "p2",
        changes: { secret: { from: 1, to: 2 } },
      }),
    ).toEqual({});
    expect(
      allowActivityPayload("event", "calendar_updated", {
        updated: ["convocation"],
        removed: [],
        changes: {
          convocation: {
            from: null,
            to: "2026-11-01T10:00:00.000Z",
          },
          "convocation.note": { from: ["x"], to: "Por correo" },
        },
      }),
    ).toEqual({
      updated: ["convocation"],
      removed: [],
      changes: {
        convocation: { from: null, to: "2026-11-01T10:00:00.000Z" },
        "convocation.note": { from: null, to: "Por correo" },
      },
    });
  });

  it("keeps deleted agenda titles and only counts reorder moves", () => {
    expect(
      allowActivityPayload("event", "agenda_item_deleted", {
        parentId: "p",
        deletedIds: ["i1", "i2"],
        title: "Informes",
        deletedItems: [
          { id: "i1", title: "Informes" },
          { id: "i2", title: "Informe de la CE" },
        ],
      }),
    ).toEqual({
      title: "Informes",
      deletedItems: [{ title: "Informes" }, { title: "Informe de la CE" }],
    });
    expect(
      allowActivityPayload("event", "agenda_reordered", {
        itemIds: ["i1", "i2"],
        moves: [
          {
            id: "i1",
            from: { parentId: null, order: 1 },
            to: { parentId: null, order: 2 },
          },
          {
            id: "i2",
            from: { parentId: null, order: 2 },
            to: { parentId: null, order: 1 },
          },
        ],
      }),
    ).toEqual({ moved: 2 });
  });

  it("keeps the mark of a root change made after the final agenda", () => {
    expect(
      allowActivityPayload("event", "agenda_item_created", {
        parentId: null,
        title: "Ruegos y preguntas",
        afterFinal: true,
      }),
    ).toEqual({ title: "Ruegos y preguntas", afterFinal: true });
    expect(
      allowActivityPayload("event", "agenda_reordered", {
        itemIds: ["i1"],
        moves: [
          {
            id: "i1",
            from: { parentId: null, order: 1 },
            to: { parentId: null, order: 0 },
          },
        ],
        afterFinal: true,
      }),
    ).toEqual({ moved: 1, afterFinal: true });
  });

  it("shows nothing of an unknown action", () => {
    expect(allowActivityPayload("event", "future_type", { a: 1 })).toEqual({});
    expect(allowActivityPayload("event", "constructor", { a: 1 })).toEqual({});
    expect(
      allowActivityPayload("audit", "future.action", {
        before: { a: 1 },
        after: { a: 2 },
      }),
    ).toEqual({});
    expect(allowActivityPayload("impersonation", "x", { a: 1 })).toEqual({});
  });

  it("keeps before and after of audit rows, allowlisted", () => {
    expect(
      allowActivityPayload("audit", "members.sync", {
        before: null,
        after: {
          created: 1,
          updated: 2,
          deactivated: 0,
          unchanged: 3,
          manualConflicts: ["X"],
          batchId: "b",
        },
      }),
    ).toEqual({
      before: null,
      after: { created: 1, updated: 2, deactivated: 0, unchanged: 3 },
    });
    expect(
      allowActivityPayload("audit", "auth.sign_in", {
        before: null,
        after: { sessionId: "secret", roleSync: "ok" },
      }),
    ).toEqual({ before: null, after: { roleSync: "ok" } });
  });

  it("shows the loss of access without what it ended", () => {
    expect(
      allowActivityPayload("audit", "user.access_revoked", {
        before: {
          roleName: "Asociado",
          memberId: null,
          accessRevokedReason: null,
        },
        after: {
          roleName: "Invitado",
          memberId: null,
          accessRevokedReason: "intranet_deleted",
          sessionsEnded: 2,
          impersonationsEnded: 1,
        },
      }),
    ).toEqual({
      before: {
        roleName: "Asociado",
        memberId: null,
        member: null,
        accessRevokedReason: null,
      },
      after: {
        roleName: "Invitado",
        memberId: null,
        member: null,
        accessRevokedReason: "intranet_deleted",
      },
    });
    expect(
      allowActivityPayload("audit", "members.sync_blocked", {
        before: null,
        after: {
          reason: "large_deactivation",
          kinds: [{ kind: "asociado", active: 40, toDeactivate: 40 }],
          trigger: "scheduled",
        },
      }),
    ).toEqual({
      before: null,
      after: {
        reason: "large_deactivation",
        kinds: [{ kind: "asociado", active: 40, toDeactivate: 40 }],
        trigger: "scheduled",
      },
    });
  });

  it("names the member a member link points to", () => {
    const members = new Map([
      [
        MEMBER,
        {
          id: MEMBER,
          acronym: "CEUA",
          name: "Consejo A",
          kind: "asociado" as const,
        },
      ],
    ]);
    expect(
      allowActivityPayload(
        "audit",
        "user.member_link",
        {
          before: { memberId: null },
          after: { memberId: MEMBER, reason: "role_sync" },
        },
        members,
      ),
    ).toEqual({
      before: { memberId: null, member: null },
      after: {
        memberId: MEMBER,
        reason: "role_sync",
        member: members.get(MEMBER),
      },
    });
  });
});

// Role tenure ---------------------------------------------------------------------------

describe("roleTenure", () => {
  const created = "2026-01-01T00:00:00.000000Z";

  it("assumes the current role when no change was recorded", () => {
    expect(
      roleTenure({
        changes: [],
        currentRoleId: "B",
        accountCreatedAt: created,
      }),
    ).toEqual([{ roleId: "B", from: created, to: null, approximate: true }]);
    expect(
      roleTenure({
        changes: [],
        currentRoleId: null,
        accountCreatedAt: created,
      }),
    ).toEqual([]);
  });

  it("follows the recorded changes exactly", () => {
    expect(
      roleTenure({
        changes: [
          {
            at: created,
            action: "user.created",
            beforeRoleId: null,
            afterRoleId: "A",
          },
          {
            at: "2026-03-01T00:00:00.000000Z",
            action: "user.role_sync",
            // Only the intranet name changed.
            beforeRoleId: "A",
            afterRoleId: "A",
          },
          {
            at: "2026-05-01T00:00:00.000000Z",
            action: "role.assign",
            beforeRoleId: "A",
            afterRoleId: "B",
          },
        ],
        currentRoleId: "B",
        accountCreatedAt: created,
      }),
    ).toEqual([
      {
        roleId: "A",
        from: created,
        to: "2026-05-01T00:00:00.000000Z",
        approximate: false,
      },
      {
        roleId: "B",
        from: "2026-05-01T00:00:00.000000Z",
        to: null,
        approximate: false,
      },
    ]);
  });

  it("assumes the role held before the first recorded change", () => {
    expect(
      roleTenure({
        changes: [
          {
            at: "2026-05-01T00:00:00.000000Z",
            action: "role.assign",
            beforeRoleId: "A",
            afterRoleId: "B",
          },
        ],
        currentRoleId: "B",
        accountCreatedAt: created,
      }),
    ).toEqual([
      {
        roleId: "A",
        from: created,
        to: "2026-05-01T00:00:00.000000Z",
        approximate: true,
      },
      {
        roleId: "B",
        from: "2026-05-01T00:00:00.000000Z",
        to: null,
        approximate: false,
      },
    ]);
  });

  it("marks both roles as assumed when the current one was never recorded", () => {
    const periods = roleTenure({
      changes: [
        {
          at: "2026-05-01T00:00:00.000000Z",
          action: "role.assign",
          beforeRoleId: "A",
          afterRoleId: "B",
        },
      ],
      currentRoleId: "C",
      accountCreatedAt: created,
    });
    expect(periods.slice(1)).toEqual([
      {
        roleId: "B",
        from: "2026-05-01T00:00:00.000000Z",
        to: null,
        approximate: true,
      },
      {
        roleId: "C",
        from: "2026-05-01T00:00:00.000000Z",
        to: null,
        approximate: true,
      },
    ]);
  });
});

// Tabs and filters -------------------------------------------------------------------------

describe("meActivityBranches", () => {
  const base = { userId: ME, memberId: MEMBER, tenure: [], filters: {} };

  it("tab by: the account's events and its own audit rows", () => {
    const branches = meActivityBranches({ ...base, tab: "by" });
    expect(branches.map((branch) => branch.kind)).toEqual(["event", "audit"]);
    const { sql, params } = render(activityQuery(branches, undefined, 51));
    expect(sql).toContain(`"events"."actor_user_id" = $`);
    expect(sql).toContain(`"audit_log"."actor_user_id" = $`);
    expect(sql).toContain(`"audit_log"."action" not like $`);
    expect(params).toContain("auth.%");
    expect(params).toEqual(expect.arrayContaining([...ADMIN_ONLY_ACTIONS]));
    // Intranet, sign-in, seed and system rows are not the account's acts.
    expect(params).toEqual(expect.arrayContaining(["user", "import"]));
    expect(params).not.toContain("intranet");
  });

  it("tab to: rows about the account, its roles' changes and impersonations of it", () => {
    const branches = meActivityBranches({
      ...base,
      tab: "to",
      tenure: [
        {
          roleId: "A",
          from: null,
          to: "2026-05-01T00:00:00Z",
          approximate: true,
        },
        {
          roleId: "B",
          from: "2026-05-01T00:00:00Z",
          to: null,
          approximate: false,
        },
      ],
    });
    expect(branches.map((branch) => branch.kind)).toEqual([
      "audit",
      "audit",
      "audit",
      "impersonation",
    ]);
    expect(
      branches.map((branch) =>
        branch.kind === "audit" ? branch.approximate : undefined,
      ),
    ).toEqual([undefined, true, false, undefined]);
    const { sql, params } = render(activityQuery(branches, undefined, 51));
    expect(params).toEqual(
      expect.arrayContaining(["user.created", "role.assign", "user.role_sync"]),
    );
    expect(params).toEqual(
      expect.arrayContaining(["permissions.set", "rbac.seed", "A", "B"]),
    );
    expect(sql).toContain(`"impersonations"."target_user_id" = $`);
    expect(sql).not.toContain(`"impersonations"."admin_user_id" = $`);
  });

  it("tab access: sign-ins and impersonations of or by the account", () => {
    const branches = meActivityBranches({ ...base, tab: "access" });
    expect(branches.map((branch) => branch.kind)).toEqual([
      "audit",
      "impersonation",
    ]);
    const { sql, params } = render(activityQuery(branches, undefined, 51));
    expect(params).toEqual(
      expect.arrayContaining([
        "auth.sign_in",
        "auth.sign_out",
        "user.access_revoked",
        "user.access_restored",
      ]),
    );
    expect(sql).toContain(`"impersonations"."admin_user_id" = $`);
  });

  it("tab member: others' acts for the member; nothing without a member", () => {
    expect(
      meActivityBranches({ ...base, memberId: null, tab: "member" }),
    ).toEqual([]);
    const branches = meActivityBranches({ ...base, tab: "member" });
    expect(branches.map((branch) => branch.kind)).toEqual(["event", "event"]);
    const { sql } = render(activityQuery(branches, undefined, 51));
    expect(sql).toContain(`"events"."actor_member_id" = $`);
    expect(sql).toContain(`"events"."actor_user_id" is distinct from $`);
    expect(sql).toContain(`->>'recordedForMemberId' = $`);
  });

  it("filters: an assembly or a category other than access drops the windows", () => {
    const byAssembly = meActivityBranches({
      ...base,
      tab: "access",
      filters: { assemblyId: "asm" },
    });
    expect(byAssembly.map((branch) => branch.kind)).toEqual(["audit"]);
    const byCategory = meActivityBranches({
      ...base,
      tab: "access",
      filters: { categories: ["document"] },
    });
    expect(byCategory.map((branch) => branch.kind)).toEqual(["audit"]);
    const access = meActivityBranches({
      ...base,
      tab: "access",
      filters: { categories: ["access"] },
    });
    expect(access.map((branch) => branch.kind)).toEqual([
      "audit",
      "impersonation",
    ]);
    // "roles" has no event type: the events branch goes.
    const roles = meActivityBranches({
      ...base,
      tab: "by",
      filters: { categories: ["roles"] },
    });
    expect(roles.map((branch) => branch.kind)).toEqual(["audit"]);
  });

  it("pages by keyset on (time, id) and bounds every branch", () => {
    const branches = meActivityBranches({
      ...base,
      tab: "by",
      filters: { from: "2026-01-01T00:00:00Z", to: "2026-12-01T00:00:00Z" },
    });
    const { sql, params } = render(
      activityQuery(
        branches,
        { at: "2026-11-05T10:15:30.123456Z", id: "abcdefghijklmnopqrstuvwx" },
        51,
      ),
    );
    expect(sql).toContain(`("events"."created_at", "events"."id") < ($`);
    expect(sql).toContain("::timestamptz");
    expect(sql).toContain(" union all ");
    expect(sql).toContain(`order by "atTs" desc, "id" desc limit $`);
    expect(params).toEqual(
      expect.arrayContaining([
        "2026-11-05T10:15:30.123456Z",
        "abcdefghijklmnopqrstuvwx",
        "2026-01-01T00:00:00Z",
        "2026-12-01T00:00:00Z",
        51,
      ]),
    );
  });
});

describe("adminActivityBranches", () => {
  const kinds = (plan: Parameters<typeof adminActivityBranches>[0]) =>
    adminActivityBranches(plan).map((branch) => branch.kind);

  it("reads the three tables without filters", () => {
    expect(kinds({})).toEqual(["event", "audit", "impersonation"]);
  });

  it("drops the kinds a filter cannot match", () => {
    // Events never target an account.
    expect(kinds({ target: ME })).toEqual(["audit", "impersonation"]);
    // Windows belong to no member nor assembly.
    expect(kinds({ member: MEMBER })).toEqual(["event", "audit"]);
    expect(kinds({ assemblyId: "asm" })).toEqual(["event", "audit"]);
    expect(kinds({ impersonated: false })).toEqual(["event", "audit"]);
    expect(kinds({ impersonated: true })).toEqual([
      "event",
      "audit",
      "impersonation",
    ]);
    expect(kinds({ sources: ["intranet"] })).toEqual(["audit"]);
    expect(kinds({ kinds: ["impersonation"] })).toEqual(["impersonation"]);
    expect(kinds({ actions: ["impersonation.session"] })).toEqual([
      "event",
      "audit",
      "impersonation",
    ]);
    expect(kinds({ actions: ["role.assign"] })).toEqual(["event", "audit"]);
    expect(kinds({ categories: ["roles"] })).toEqual(["audit"]);
  });

  it("finds audit rows by their assembly or by the assembly they target", () => {
    // assembly.delete names the deleted assembly only as its target.
    const { sql } = render(
      activityQuery(
        adminActivityBranches({ assemblyId: "asm", kinds: ["audit"] }),
        undefined,
        51,
      ),
    );
    expect(sql).toContain(
      `("audit_log"."assembly_id" = $1 or ("audit_log"."target_type" = $2 and "audit_log"."target_id" = $3))`,
    );
  });

  it("finds nothing when the search matches no account", () => {
    expect(adminActivityBranches({ matchingUserIds: [] })).toEqual([]);
    const { sql } = render(
      activityQuery(
        adminActivityBranches({ matchingUserIds: [ME], user: OTHER }),
        undefined,
        51,
      ),
    );
    expect(sql).toContain(`"events"."actor_user_id" in ($`);
    expect(sql).toContain(`"audit_log"."target_id" in ($`);
    expect(sql).toContain(`"impersonations"."target_user_id" in ($`);
  });

  it("escapes the search's own wildcards", () => {
    expect(containsPattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });
});

// Pages ---------------------------------------------------------------------------------------

describe("collectActivityPage", () => {
  const rows = Array.from({ length: 7 }, (_, index) =>
    row({
      id: `id${String(index).padStart(22, "0")}`,
      at: `2026-11-05T10:15:3${9 - index}.12345${index}Z`,
    }),
  );
  const fetch = vi.fn(
    async (cursor: { id: string } | undefined, size: number) => {
      const start = cursor
        ? rows.findIndex((item) => item.id === cursor.id) + 1
        : 0;
      return rows.slice(start, start + size);
    },
  );
  const keep =
    (dropped: Set<string> = new Set()) =>
    async (list: Row[]) =>
      list.map((item) =>
        dropped.has(item.id)
          ? null
          : ({ id: item.id } as unknown as ActivityItemDto),
      );

  it("ends with a cursor at the last row read, microseconds kept", async () => {
    const page = await collectActivityPage({
      cursor: undefined,
      limit: 3,
      fetch,
      build: keep(),
    });
    expect(page.items.map((item) => item.id)).toEqual(
      rows.slice(0, 3).map((item) => item.id),
    );
    expect(decodeActivityCursor(page.nextCursor!)).toEqual({
      at: rows[2]!.at,
      id: rows[2]!.id,
    });
  });

  it("reads on when rows are left out, and never skips one", async () => {
    const page = await collectActivityPage({
      cursor: undefined,
      limit: 3,
      fetch,
      build: keep(new Set([rows[1]!.id, rows[2]!.id])),
    });
    expect(page.items.map((item) => item.id)).toEqual([
      rows[0]!.id,
      rows[3]!.id,
      rows[4]!.id,
    ]);
    expect(decodeActivityCursor(page.nextCursor!)?.id).toBe(rows[4]!.id);
  });

  it("stops after its passes with the cursor at the last row read", async () => {
    const page = await collectActivityPage({
      cursor: undefined,
      limit: 2,
      maxPasses: 1,
      fetch,
      build: keep(new Set([rows[0]!.id, rows[1]!.id])),
    });
    expect(page.items).toEqual([]);
    expect(decodeActivityCursor(page.nextCursor!)?.id).toBe(rows[1]!.id);
  });

  it("has no cursor on the last page", async () => {
    const page = await collectActivityPage({
      cursor: { at: rows[3]!.at, id: rows[3]!.id },
      limit: 3,
      fetch,
      build: keep(),
    });
    expect(page.items.map((item) => item.id)).toEqual(
      rows.slice(4).map((item) => item.id),
    );
    expect(page.nextCursor).toBeNull();
  });
});

// Privacy -------------------------------------------------------------------------------------

describe("toMeActivityItem", () => {
  const correction = {
    action: "amendment_correction_requested",
    targetType: "amendment",
    payload: { note: "Revisa el artículo 3" },
  };

  it("keeps an own act on something no longer visible, emptied", () => {
    // A former Secretaría member asked an unpublished amendment for a correction.
    const item = meItem(makeActor(), "by", {
      ...correction,
      targetId: "hidden",
    })!;
    expect(item.target).toEqual({
      type: "amendment",
      id: "hidden",
      label: null,
      assembly: { id: "asm", slug: "80-ago", label: "80.ª AGO" },
      document: null,
      available: false,
    });
    expect(item.payload).toEqual({});
    expect(item.category).toBe("amendment");
  });

  it("shows it whole while the account still reviews amendments", () => {
    const item = meItem(
      makeActor({ permissions: [PERMISSION_KEYS.AMENDMENT_REVIEW] }),
      "by",
      { ...correction, targetId: "hidden" },
    )!;
    expect(item.target.available).toBe(true);
    expect(item.target.label).toBe("CEUM 1");
    expect(item.target.document).toEqual({
      id: "doc",
      slug: "presupuesto",
      title: "Presupuesto",
    });
    expect(item.payload).toEqual({ note: "Revisa el artículo 3" });
  });

  it("strips correction notes and positions others may not read", () => {
    const viewer = makeActor({ memberId: MEMBER });
    const note = meItem(viewer, "member", {
      ...correction,
      targetId: "public",
      actorUserId: OTHER,
    })!;
    expect(note.target.available).toBe(true);
    expect(note.payload).toEqual({});
    // Positions: the policy is "mesa" and the viewer does not present the document.
    const position = meItem(viewer, "member", {
      action: "position_changed",
      targetType: "amendment",
      targetId: "public",
      actorUserId: OTHER,
      payload: { position: "accept", by: "moderator", memberId: OTHER_MEMBER },
    })!;
    expect(position.payload).toEqual({});
    // Its own amendment's note stays.
    const own = meItem(viewer, "by", { ...correction, targetId: "mine" })!;
    expect(own.payload).toEqual({ note: "Revisa el artículo 3" });
  });

  it("leaves out others' acts on hidden things (tab member)", () => {
    expect(
      meItem(makeActor({ memberId: MEMBER }), "member", {
        ...correction,
        targetId: "hidden",
        actorUserId: OTHER,
      }),
    ).toBeNull();
    // A draft document of another member.
    expect(
      meItem(makeActor({ memberId: MEMBER }), "member", {
        action: "document_updated",
        targetType: "document",
        targetId: "draftdoc",
        actorUserId: OTHER,
      }),
    ).toBeNull();
  });

  it("hides what happened in an assembly the account cannot see", () => {
    const item = meItem(makeActor(), "by", {
      assemblyId: "draftasm",
      targetId: "draftasm",
    })!;
    expect(item.target.available).toBe(false);
    expect(item.target.assembly).toBeNull();
  });

  it("names the Admin behind an act only to the account and to Admins", () => {
    const acted = {
      action: "amendment_submitted",
      targetType: "amendment",
      targetId: "mine",
      impersonationId: "imp1",
      payload: { code: "CEUA 1", late: false },
    };
    const own = meItem(makeActor({ memberId: MEMBER }), "by", acted)!;
    expect(own.impersonatedBy).toEqual({ id: ADMIN, name: "Admin" });
    expect(own.impersonationId).toBe("imp1");

    const colleague = meItem(
      makeActor({ id: OTHER, memberId: MEMBER }),
      "member",
      acted,
    )!;
    expect(colleague.actor).toEqual({ id: ME, name: "Ana", member: null });
    expect(colleague.impersonatedBy).toBeNull();
    expect(colleague.impersonationId).toBeNull();

    const admin = meItem(
      makeActor({ id: OTHER, isAdmin: true }),
      "member",
      acted,
    )!;
    expect(admin.impersonatedBy).toEqual({ id: ADMIN, name: "Admin" });

    // The impersonation's own rows are the Admin's acts: nobody behind them.
    const start = meItem(makeActor({ id: ADMIN, isAdmin: true }), "by", {
      kind: "audit",
      action: "impersonation.start",
      actorUserId: ADMIN,
      impersonationId: "imp1",
      assemblyId: null,
      targetType: "user",
      targetId: ME,
      payload: { before: null, after: { reason: "Soporte" } },
    })!;
    expect(start.impersonatedBy).toBeNull();
    expect(start.impersonationId).toBe("imp1");
  });

  it("shows IP and user agent only on the account's own accesses", () => {
    const signIn = {
      kind: "audit" as const,
      action: "auth.sign_in",
      source: "auth" as const,
      assemblyId: null,
      targetType: "user",
      targetId: ME,
      ipAddress: "192.0.2.1",
      userAgent: "Firefox",
      payload: { before: null, after: { sessionId: "s", roleSync: "ok" } },
    };
    const own = meItem(makeActor(), "access", signIn)!;
    expect(own.access).toEqual({
      ipAddress: "192.0.2.1",
      userAgent: "Firefox",
    });
    expect(own.payload).toEqual({ before: null, after: { roleSync: "ok" } });
    // The same row outside the access tab.
    expect(meItem(makeActor(), "by", signIn)!.access).toBeNull();

    const window = {
      kind: "impersonation" as const,
      id: "imp1",
      action: "impersonation.session",
      actorUserId: ADMIN,
      impersonationId: "imp1",
      assemblyId: null,
      targetType: "user",
      targetId: ME,
      ipAddress: "10.0.0.1",
      userAgent: "Admin browser",
    };
    // An Admin acted as the account: the Admin's IP stays hidden.
    const onMe = toMeActivityItem(
      makeActor(),
      "access",
      row(window),
      lookups(),
    )!;
    expect(onMe.access).toBeNull();
    expect(onMe.actor).toEqual({ id: ADMIN, name: "Admin", member: null });
    expect(onMe.impersonatedBy).toBeNull();
    expect(onMe.impersonation).toMatchObject({
      id: "imp1",
      admin: { id: ADMIN, name: "Admin" },
      target: { id: ME, name: "Ana" },
      reason: "Soporte",
      endReason: "stopped",
      active: false,
    });
    expect(onMe.category).toBe("access");
    // The Admin's own window keeps its own IP.
    const byMe = toMeActivityItem(
      makeActor({ id: ADMIN, isAdmin: true }),
      "access",
      row(window),
      lookups(),
    )!;
    expect(byMe.access).toEqual({
      ipAddress: "10.0.0.1",
      userAgent: "Admin browser",
    });
  });

  it("shows changes to other accounts only to who manages them now", () => {
    const assign = {
      kind: "audit" as const,
      action: "role.assign",
      assemblyId: null,
      targetType: "user",
      targetId: OTHER,
      payload: {
        before: { roleId: "r1", roleName: "Invitado" },
        after: { roleId: "r2", roleName: "Asociado" },
      },
    };
    const former = meItem(makeActor(), "by", assign)!;
    expect(former.target).toMatchObject({ available: false, label: null });
    expect(former.payload).toEqual({});
    const manager = meItem(
      makeActor({ permissions: [PERMISSION_KEYS.USER_MANAGE_ROLES] }),
      "by",
      assign,
    )!;
    expect(manager.target).toMatchObject({ available: true, label: "Luis" });
    expect(manager.payload).toEqual({
      before: { roleName: "Invitado" },
      after: { roleName: "Asociado" },
    });
  });

  it("shows the changes to the permissions of a role the account held", () => {
    const change = {
      kind: "audit" as const,
      action: "permissions.set",
      actorUserId: OTHER,
      assemblyId: null,
      targetType: "role",
      targetId: "role1",
      payload: {
        before: { permissions: [] },
        after: { permissions: ["document:create"] },
      },
    };
    const held = meItem(makeActor(), "to", { ...change, approximate: true })!;
    expect(held.target).toMatchObject({ available: true, label: "Asociado" });
    expect(held.approximate).toBe(true);
    expect(held.actor).toEqual({ id: OTHER, name: "Luis", member: null });
    expect(held.access).toBeNull();
    // The same row found by actor (tab by) for someone who no longer reads roles.
    expect(meItem(makeActor(), "by", change)!.target.available).toBe(false);
  });

  it("keeps only the visible amendments of an admission decision", () => {
    const data = lookups();
    data.decisions.set("dec", {
      id: "dec",
      kind: "admit_late",
      method: "mesa",
      subjectIds: ["hidden", "public"],
    });
    const viewer = makeActor({ memberId: MEMBER });
    const decision = {
      action: "decision_recorded",
      targetType: "decision",
      targetId: "dec",
      payload: {
        kind: "admit_late",
        method: "mesa",
        subjectIds: ["hidden", "public"],
      },
    };
    const item = meItem(viewer, "by", decision, data)!;
    expect(item.target.available).toBe(true);
    expect(item.payload).toEqual({
      kind: "admit_late",
      method: "mesa",
      subjectIds: ["public"],
    });
    data.decisions.set("dec", {
      id: "dec",
      kind: "admit_late",
      method: "mesa",
      subjectIds: ["hidden"],
    });
    expect(meItem(viewer, "by", decision, data)!.target.available).toBe(false);
  });

  it("rebuilds who could see a deleted draft from its events", () => {
    const data = lookups();
    data.deleted.set("document:gone", {
      memberIds: [MEMBER],
      userIds: [],
      label: "Informe",
      wasPublic: false,
    });
    const deletion = {
      action: "document_deleted",
      targetType: "document",
      targetId: "gone",
      actorUserId: OTHER,
      payload: { title: "Informe", kind: "report", format: "structured" },
    };
    const insider = meItem(
      makeActor({ memberId: MEMBER }),
      "member",
      deletion,
      data,
    )!;
    expect(insider.target).toMatchObject({
      available: true,
      label: "Informe",
      document: null,
    });
    expect(
      meItem(makeActor({ memberId: OTHER_MEMBER }), "member", deletion, data),
    ).toBeNull();
  });

  it("lets the co-authors of a deleted amendment draft keep seeing it", () => {
    // What deleteAmendmentDraft records: the insiders, never shown as such.
    const deletion = {
      action: "amendment_deleted",
      targetType: "amendment",
      targetId: "gone",
      actorUserId: OTHER,
      actorMemberId: OTHER_MEMBER,
      payload: {
        kind: "modification",
        code: null,
        documentId: "doc",
        createdByUserId: OTHER,
        submittedByUserId: null,
        authorMemberIds: [OTHER_MEMBER, MEMBER],
        mainAuthorId: OTHER_MEMBER,
      },
    };
    const coAuthor = meItem(
      makeActor({ memberId: MEMBER }),
      "member",
      deletion,
    )!;
    expect(coAuthor.target.available).toBe(true);
    expect(coAuthor.payload).toEqual({ kind: "modification", code: null });
    expect(
      meItem(
        makeActor({ id: "x".repeat(32), memberId: "m3aaaaaaaaaaaaaaaaaaaaaa" }),
        "member",
        deletion,
      ),
    ).toBeNull();
  });

  it("shows a document's edited values only to its presenters and the Secretaría", () => {
    const edit = {
      action: "document_updated",
      targetType: "document",
      targetId: "doc",
      actorUserId: OTHER,
      payload: {
        fields: ["title"],
        changes: { title: { from: "Borrador interno", to: "Presupuesto" } },
      },
    };
    // The document is published: anyone sees the edit, not the draft title.
    const outsider = meItem(makeActor({ memberId: MEMBER }), "by", edit)!;
    expect(outsider.target.available).toBe(true);
    expect(outsider.payload).toEqual({ fields: ["title"] });
    const presenter = meItem(
      makeActor({ memberId: OTHER_MEMBER }),
      "by",
      edit,
    )!;
    expect(presenter.payload).toEqual({
      fields: ["title"],
      changes: { title: { from: "Borrador interno", to: "Presupuesto" } },
    });
  });

  it("leaves the speakers' queue history to the Mesa", () => {
    const turn = {
      action: "speaking_turn_added",
      targetType: "speakers",
      targetId: "turn",
      payload: { memberId: MEMBER, position: 2 },
    };
    expect(meItem(makeActor(), "by", turn)!.target.available).toBe(false);
    const mesa = meItem(
      makeActor({ permissions: [PERMISSION_KEYS.SESSION_MODERATE] }),
      "by",
      turn,
    )!;
    expect(mesa.target.available).toBe(true);
    expect(mesa.payload).toEqual({ position: 2 });
  });
});

describe("toAdminActivityItem", () => {
  it("shows everything, with the client and who was behind it", () => {
    const data = lookups();
    const item = toAdminActivityItem(
      row({
        action: "document_created",
        targetType: "document",
        targetId: "draftdoc",
        impersonationId: "imp1",
        payload: { title: "Borrador", dueAt: "2026-11-10T00:00:00Z" },
      }),
      data,
    );
    expect(item.payload).toEqual({
      title: "Borrador",
      dueAt: "2026-11-10T00:00:00Z",
    });
    expect(item.impersonatedBy).toEqual({ id: ADMIN, name: "Admin" });
    expect(item.target).toMatchObject({ available: true, label: "Borrador" });
    expect(item.access).toBeNull();

    const audit = toAdminActivityItem(
      row({
        kind: "audit",
        action: "auth.sign_in",
        source: "auth",
        assemblyId: null,
        targetType: "user",
        targetId: ME,
        ipAddress: "192.0.2.1",
        userAgent: "Firefox",
        payload: { before: null, after: { sessionId: "s" } },
      }),
      data,
    );
    expect(audit.access).toEqual({
      ipAddress: "192.0.2.1",
      userAgent: "Firefox",
    });
    expect(audit.payload).toEqual({ before: null, after: { sessionId: "s" } });
  });

  it("labels a deleted target with what its events kept", () => {
    const data = lookups();
    data.deleted.set("amendment:gone", {
      memberIds: [],
      userIds: [],
      label: "CEUA 9",
      wasPublic: false,
    });
    const item = toAdminActivityItem(
      row({
        action: "amendment_deleted",
        targetType: "amendment",
        targetId: "gone",
        payload: { kind: "modification", code: null },
      }),
      data,
    );
    expect(item.target).toMatchObject({
      available: true,
      label: "CEUA 9",
      document: null,
    });
  });
});

describe("automatic agenda sub-items", () => {
  const created = (documentId: string) => ({
    action: "agenda_item_created",
    targetType: "agenda_item",
    targetId: "item",
    actorUserId: OTHER,
    payload: { title: "Borrador", auto: true, documentId },
  });

  it("show to those who see their document", () => {
    const viewer = makeActor({ memberId: MEMBER });
    // Another member's draft: its sub-item carries its title.
    expect(meItem(viewer, "member", created("draftdoc"))).toBeNull();
    expect(meItem(viewer, "member", created("doc"))?.target.available).toBe(
      true,
    );
    const presenter = makeActor({ memberId: OTHER_MEMBER });
    const item = meItem(presenter, "member", created("draftdoc"))!;
    expect(item.target.available).toBe(true);
    expect(item.payload).toEqual({ title: "Borrador", auto: true });
  });

  it("show to document managers once the document is gone", () => {
    const deleted = {
      ...created("gone"),
      action: "agenda_item_deleted",
      payload: {
        title: "Borrador",
        deletedItems: [{ id: "item", title: "Borrador" }],
        auto: true,
        cascade: true,
        documentId: "gone",
      },
    };
    expect(
      meItem(makeActor({ memberId: MEMBER }), "member", deleted),
    ).toBeNull();
    const item = meItem(
      makeActor({ permissions: [PERMISSION_KEYS.DOCUMENT_MANAGE] }),
      "member",
      deleted,
    )!;
    expect(item.payload).toEqual({
      title: "Borrador",
      deletedItems: [{ title: "Borrador" }],
      auto: true,
      cascade: true,
    });
  });

  it("leave items written by hand visible to everyone", () => {
    expect(
      meItem(makeActor({ memberId: MEMBER }), "member", {
        action: "agenda_item_created",
        targetType: "agenda_item",
        targetId: "item",
        actorUserId: OTHER,
        payload: { title: "Informes" },
      })?.target.available,
    ).toBe(true);
  });

  it("keep hiding one that stayed after its document moved away", () => {
    // No longer automatic, but it may still carry the draft's title.
    const renamed = (documentId: string) => ({
      action: "agenda_item_updated",
      targetType: "agenda_item",
      targetId: "item",
      actorUserId: OTHER,
      payload: {
        changes: { description: { from: null, to: "Notas" } },
        documentId,
      },
    });
    const viewer = makeActor({ memberId: MEMBER });
    expect(meItem(viewer, "member", renamed("draftdoc"))).toBeNull();
    // Once the document is published everyone sees its events.
    expect(meItem(viewer, "member", renamed("doc"))?.target.available).toBe(
      true,
    );
    const presenter = makeActor({ memberId: OTHER_MEMBER });
    const item = meItem(presenter, "member", renamed("draftdoc"))!;
    expect(item.target.available).toBe(true);
    expect(item.payload).not.toHaveProperty("documentId");
  });

  it("follow the document's last status once it is deleted", () => {
    const moved = {
      action: "agenda_item_updated",
      targetType: "agenda_item",
      targetId: "item",
      actorUserId: OTHER,
      payload: { changes: {}, documentId: "gone" },
    };
    const viewer = makeActor({ memberId: MEMBER });
    const draft = lookups();
    draft.deleted.set("document:gone", {
      memberIds: [OTHER_MEMBER],
      userIds: [],
      label: "Borrador",
      wasPublic: false,
    });
    expect(meItem(viewer, "member", moved, draft)).toBeNull();
    const published = lookups();
    published.deleted.set("document:gone", {
      memberIds: [OTHER_MEMBER],
      userIds: [],
      label: "Informe",
      wasPublic: true,
    });
    expect(meItem(viewer, "member", moved, published)?.target.available).toBe(
      true,
    );
  });

  it("keep a withheld title for document managers", () => {
    const renamed = {
      action: "agenda_item_updated",
      targetType: "agenda_item",
      targetId: "item",
      actorUserId: OTHER,
      payload: {
        changes: { title: { from: "Borrador", to: "Varios" } },
        titleWithheld: true,
      },
    };
    expect(
      meItem(makeActor({ memberId: MEMBER }), "member", renamed),
    ).toBeNull();
    const manager = makeActor({
      permissions: [PERMISSION_KEYS.DOCUMENT_MANAGE],
    });
    expect(meItem(manager, "member", renamed)?.target.available).toBe(true);
  });

  it("load the document their events name", () => {
    const ids = collectActivityIds([row(created("draftdoc"))]);
    expect([...ids.documents]).toEqual(["draftdoc"]);
    expect([...ids.agendaItems]).toEqual(["item"]);
  });
});

describe("collectActivityIds", () => {
  it("collects actors, targets and the ids payloads name", () => {
    const ids = collectActivityIds([
      row({
        action: "vote_recorded",
        targetType: "vote",
        targetId: "v",
        payload: { subjectType: "amendment", subjectId: "a1" },
      }),
      row({
        action: "decision_recorded",
        targetType: "decision",
        targetId: "d",
        payload: { subjectIds: ["a2"] },
      }),
      row({
        kind: "audit",
        action: "user.member_link",
        assemblyId: null,
        targetType: "user",
        targetId: OTHER,
        impersonationId: "imp1",
        payload: { before: { memberId: MEMBER }, after: { memberId: null } },
      }),
    ]);
    expect([...ids.amendments]).toEqual(["a1", "a2"]);
    expect([...ids.decisions]).toEqual(["d"]);
    expect([...ids.users].sort()).toEqual([ME, OTHER].sort());
    expect([...ids.members]).toEqual([MEMBER]);
    expect([...ids.impersonations]).toEqual(["imp1"]);
    expect([...ids.assemblies]).toEqual(["asm"]);
  });
});

// Executive areas ----------------------------------------------------------------------

describe("executive areas in Mi actividad", () => {
  const AREA = "areaaaaaaaaaaaaaaaaaaaaa";
  const OTHER_AREA = "areabbbbbbbbbbbbbbbbbbbb";

  function withAreas(): Lookups {
    const data = lookups();
    data.members.set(AREA, {
      id: AREA,
      acronym: "VPU",
      name: "Vicepresidencia de Universidades",
      kind: "executive",
    });
    data.members.set(OTHER_AREA, {
      id: OTHER_AREA,
      acronym: "TES",
      name: "Tesorería",
      kind: "executive",
    });
    return data;
  }

  /** An area answered the amendment of the viewer's member. */
  const answered: Partial<Row> = {
    action: "amendment_approved",
    actorUserId: OTHER,
    actorMemberId: AREA,
    targetType: "amendment",
    targetId: "mine",
    payload: { method: "proponent" },
  };

  it("names neither the area nor the person who acted for it", () => {
    const item = meItem(
      makeActor({ memberId: MEMBER }),
      "member",
      answered,
      withAreas(),
    );
    expect(item?.actor).toEqual({
      id: GENERIC_EXECUTIVE_MEMBER_ID,
      name: GENERIC_EXECUTIVE_MEMBER.name,
      member: { ...GENERIC_EXECUTIVE_MEMBER },
    });
    expect(JSON.stringify(item)).not.toContain("VPU");
    expect(JSON.stringify(item)).not.toContain("Luis");
    expect(JSON.stringify(item)).not.toContain(AREA);
  });

  it("shows both to those who see the areas", () => {
    const item = meItem(
      makeActor({
        memberId: MEMBER,
        permissions: [PERMISSION_KEYS.AMENDMENT_REVIEW],
      }),
      "member",
      answered,
      withAreas(),
    );
    expect(item?.actor).toEqual({
      id: OTHER,
      name: "Luis",
      member: {
        id: AREA,
        acronym: "VPU",
        name: "Vicepresidencia de Universidades",
        kind: "executive",
      },
    });
  });

  it("keeps the viewer's own name on its own acts", () => {
    const item = meItem(
      makeActor({ memberId: MEMBER }),
      "by",
      { ...answered, actorUserId: ME },
      withAreas(),
    );
    expect(item?.actor).toEqual({
      id: ME,
      name: "Ana",
      member: { ...GENERIC_EXECUTIVE_MEMBER },
    });
  });

  it("replaces the areas a payload names, also those only the full mask knows", () => {
    const item = toMeActivityItem(
      makeActor({ memberId: MEMBER }),
      "by",
      row({
        kind: "audit",
        action: "user.member_link",
        assemblyId: null,
        targetType: "user",
        targetId: ME,
        payload: {
          before: { memberId: AREA },
          after: { memberId: "areacccccccccccccccccccc" },
        },
      }),
      withAreas(),
      new Date(),
      new Set([AREA, OTHER_AREA, "areacccccccccccccccccccc"]),
    );
    expect(item?.payload).toEqual({
      before: {
        memberId: GENERIC_EXECUTIVE_MEMBER_ID,
        member: { ...GENERIC_EXECUTIVE_MEMBER },
      },
      after: { memberId: GENERIC_EXECUTIVE_MEMBER_ID, member: null },
    });
  });

  it("says nothing of what an area was and became", () => {
    const item = meItem(
      makeActor({ memberId: MEMBER }),
      "by",
      {
        kind: "audit",
        action: "member.update",
        assemblyId: null,
        targetType: "member",
        targetId: AREA,
        payload: {
          before: { acronym: "VPU", name: "Vicepresidencia" },
          after: { acronym: "VPUN", name: "Vicepresidencia de Universidades" },
        },
      },
      withAreas(),
    );
    expect(item?.target.id).toBe(GENERIC_EXECUTIVE_MEMBER_ID);
    expect(item?.target.label).toBe("CEA");
    expect(item?.payload).toEqual({});
  });
});
