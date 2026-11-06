import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_VALUES,
  EVENT_TYPES,
  IMPERSONATION_SESSION_ACTION,
} from "~~/shared/constants/activity";
import type { ActivityItemDto, ActivityTargetDto } from "~~/shared/types/api";
import {
  ACTIVITY_ACTION_ICONS,
  ACTIVITY_ACTIONS,
  activityActionKey,
  activityDetails,
  activityIcon,
  activityItemKey,
  activityLink,
  impersonationDetails,
  mergeUniqueBy,
  userAgentSummary,
} from "./-present";

const ASSEMBLY = { id: "a1", slug: "80-ago", label: "80.ª AGO" };
const DOCUMENT = { id: "d1", slug: "reglamento", title: "Reglamento" };

function target(overrides: Partial<ActivityTargetDto> = {}): ActivityTargetDto {
  return {
    type: "document",
    id: "d1",
    label: "Reglamento",
    assembly: ASSEMBLY,
    document: DOCUMENT,
    available: true,
    ...overrides,
  };
}

function item(overrides: Partial<ActivityItemDto> = {}): ActivityItemDto {
  return {
    id: "e1",
    kind: "event",
    at: "2026-11-05T10:00:00.000Z",
    action: "document_submitted",
    category: "document",
    source: "user",
    actor: null,
    impersonatedBy: null,
    impersonationId: null,
    target: target(),
    payload: {},
    impersonation: null,
    access: null,
    approximate: false,
    ...overrides,
  };
}

describe("keys and merging", () => {
  it("keys items by table and id", () => {
    expect(activityItemKey({ kind: "audit", id: "x" })).toBe("audit:x");
  });

  it("appends only what is new, in order", () => {
    const merged = mergeUniqueBy(
      [{ k: "a" }, { k: "b" }],
      [{ k: "b" }, { k: "c" }, { k: "c" }],
      (entry) => entry.k,
    );
    expect(merged.map((entry) => entry.k)).toEqual(["a", "b", "c"]);
  });
});

describe("actions", () => {
  it("covers every catalog action once", () => {
    expect(ACTIVITY_ACTIONS).toHaveLength(
      EVENT_TYPES.length + AUDIT_ACTION_VALUES.length + 1,
    );
    expect(new Set(ACTIVITY_ACTIONS).size).toBe(ACTIVITY_ACTIONS.length);
    for (const action of ACTIVITY_ACTIONS) {
      expect(ACTIVITY_ACTION_ICONS[action]).toMatch(/^i-lucide-/);
    }
  });

  it("points unknown actions at the general sentence", () => {
    expect(activityActionKey("amendment_submitted")).toBe(
      "activity.actions.amendment_submitted",
    );
    expect(activityActionKey("role.assign")).toBe(
      "activity.actions.role.assign",
    );
    expect(activityActionKey(IMPERSONATION_SESSION_ACTION)).toBe(
      "activity.actions.impersonation.session",
    );
    expect(activityActionKey("something_new")).toBe("activity.actions.other");
    expect(activityActionKey("constructor")).toBe("activity.actions.other");
  });

  it("falls back to the category icon", () => {
    expect(activityIcon({ action: "auth.sign_in", category: "access" })).toBe(
      "i-lucide-log-in",
    );
    expect(activityIcon({ action: "mystery", category: "export" })).toBe(
      "i-lucide-file-down",
    );
  });
});

describe("activityLink", () => {
  it("opens an amendment inside its document", () => {
    expect(
      activityLink(
        item({
          action: "amendment_submitted",
          target: target({ type: "amendment", id: "am1", label: "CEUM 4" }),
        }),
      ),
    ).toEqual({
      slug: "80-ago",
      section: "documents",
      document: "reglamento",
      amendment: "am1",
    });
  });

  it("links documents, agenda items and the live session", () => {
    expect(activityLink(item())?.document).toBe("reglamento");
    expect(
      activityLink(
        item({ target: target({ type: "agenda_item", document: null }) }),
      )?.section,
    ).toBe("agenda");
    expect(
      activityLink(
        item({ target: target({ type: "speakers", document: null }) }),
      )?.section,
    ).toBe("live");
    expect(
      activityLink(item({ target: target({ type: "vote", document: null }) }))
        ?.section,
    ).toBe("live");
  });

  it("sends assembly changes to the right section", () => {
    const assembly = target({ type: "assembly", id: "a1", document: null });
    expect(
      activityLink(item({ action: "calendar_updated", target: assembly }))
        ?.section,
    ).toBe("calendar");
    expect(
      activityLink(item({ action: "agenda_finalized", target: assembly }))
        ?.section,
    ).toBe("agenda");
    expect(
      activityLink(item({ action: "assembly_updated", target: assembly })),
    ).toEqual({
      slug: "80-ago",
      section: "overview",
      document: null,
      amendment: null,
    });
  });

  it("links nothing the viewer cannot see or outside assemblies", () => {
    expect(
      activityLink(item({ target: target({ available: false }) })),
    ).toBeNull();
    expect(
      activityLink(
        item({
          kind: "audit",
          action: "role.assign",
          target: target({ type: "user", assembly: null, document: null }),
        }),
      ),
    ).toBeNull();
  });
});

describe("activityDetails", () => {
  it("reads status changes with known values only", () => {
    expect(
      activityDetails(
        item({
          action: "assembly_status_changed",
          payload: { from: "draft", to: "convened" },
        }),
      ),
    ).toEqual([
      { type: "status", entity: "assembly", from: "draft", to: "convened" },
    ]);
    expect(
      activityDetails(
        item({
          action: "document_status_changed",
          payload: { from: "draft", to: "<b>bogus</b>" },
        }),
      ),
    ).toEqual([]);
  });

  it("reads late submissions, notes, answers and results", () => {
    expect(
      activityDetails(
        item({ action: "amendment_submitted", payload: { late: true } }),
      ),
    ).toEqual([{ type: "late" }]);
    expect(
      activityDetails(
        item({
          action: "document_correction_requested",
          payload: { note: "Falta el anexo" },
        }),
      ),
    ).toEqual([{ type: "note", text: "Falta el anexo" }]);
    expect(
      activityDetails(
        item({ action: "position_changed", payload: { position: "accept" } }),
      ),
    ).toEqual([{ type: "position", position: "accept" }]);
    expect(
      activityDetails(
        item({
          action: "acceptance_recorded",
          payload: { decision: "rejected" },
        }),
      ),
    ).toEqual([{ type: "acceptance", decision: "rejected" }]);
    expect(
      activityDetails(
        item({ action: "document_voted", payload: { result: "approved" } }),
      ),
    ).toEqual([{ type: "result", result: "approved" }]);
  });

  it("says nothing about other payload fields", () => {
    expect(
      activityDetails(
        item({
          action: "document_updated",
          payload: { title: "x", secret: 1 },
        }),
      ),
    ).toEqual([]);
  });

  it("reads the fields an edit changed, ids only as changed", () => {
    expect(
      activityDetails(
        item({
          action: "document_updated",
          payload: {
            fields: ["title", "proponentMemberId", "dueAt"],
            changes: {
              title: { from: "Borrador", to: "Presupuesto" },
              // Raw ids in the Admin log: still said only as changed.
              proponentMemberId: { from: "m1", to: "m2" },
              coProponentMemberIds: {},
              amendable: { from: true, to: false },
              secret: { from: "a", to: "b" },
            },
          },
        }),
      ),
    ).toEqual([
      {
        type: "change",
        entity: "document",
        field: "title",
        from: "Borrador",
        to: "Presupuesto",
      },
      { type: "changed", entity: "document", field: "proponentMemberId" },
      {
        type: "changed",
        entity: "document",
        field: "coProponentMemberIds",
      },
      {
        type: "change",
        entity: "document",
        field: "amendable",
        from: true,
        to: false,
      },
    ]);
    expect(
      activityDetails(
        item({
          action: "calendar_updated",
          payload: {
            changes: {
              convocation: { from: null, to: "2026-11-01T10:00:00.000Z" },
              "convocation.note": { from: null, to: "Por correo" },
              "bogus.note": { from: null, to: "x" },
            },
          },
        }),
      ),
    ).toEqual([
      {
        type: "change",
        entity: "calendar",
        field: "convocation",
        from: null,
        to: "2026-11-01T10:00:00.000Z",
      },
      {
        type: "change",
        entity: "calendar",
        field: "convocation.note",
        from: null,
        to: "Por correo",
      },
    ]);
  });

  it("names what a deleted agenda item took and how many items moved", () => {
    expect(
      activityDetails(
        item({
          action: "agenda_item_deleted",
          target: target({ type: "agenda_item" }),
          payload: {
            title: "Informes",
            deletedItems: [
              { title: "Informes" },
              { id: "x", title: "Informe de la CE" },
            ],
          },
        }),
      ),
    ).toEqual([{ type: "subItems", titles: ["Informe de la CE"] }]);
    expect(
      activityDetails(
        item({ action: "agenda_reordered", payload: { moved: 3 } }),
      ),
    ).toEqual([{ type: "moved", count: 3 }]);
    expect(
      activityDetails(
        item({ action: "agenda_reordered", payload: { moves: [{}, {}] } }),
      ),
    ).toEqual([{ type: "moved", count: 2 }]);
  });

  it("reads role, member and intranet changes of role sync", () => {
    expect(
      activityDetails(
        item({
          kind: "audit",
          action: "user.role_sync",
          payload: {
            before: {
              roleName: "Invitado",
              memberId: null,
              externalRole: "Otro",
              university: "UGR",
            },
            after: {
              roleName: "Asociado",
              memberId: "m1",
              externalRole: "Asociado",
              university: "UGR",
            },
          },
        }),
      ),
    ).toEqual([
      { type: "role", from: "Invitado", to: "Asociado" },
      { type: "member", from: null, to: "m1" },
      { type: "intranet", field: "externalRole", from: "Otro", to: "Asociado" },
    ]);
  });

  it("reads the role and member an account lost with its access", () => {
    expect(
      activityDetails(
        item({
          kind: "audit",
          action: "user.access_revoked",
          payload: {
            before: {
              roleName: "Asociado",
              memberId: "m1",
              accessRevokedReason: null,
            },
            after: {
              roleName: "Invitado",
              memberId: null,
              accessRevokedReason: "intranet_deleted",
            },
          },
        }),
      ),
    ).toEqual([
      { type: "role", from: "Asociado", to: "Invitado" },
      { type: "member", from: "m1", to: null },
    ]);
  });

  it("diffs permissions and lists seeded grants", () => {
    expect(
      activityDetails(
        item({
          kind: "audit",
          action: "user.permissions_set",
          payload: {
            before: { permissions: ["document:create", "amendment:create"] },
            after: { permissions: ["document:create", "session:moderate"] },
          },
        }),
      ),
    ).toEqual([
      {
        type: "permissions",
        added: ["session:moderate"],
        removed: ["amendment:create"],
      },
    ]);
    expect(
      activityDetails(
        item({
          kind: "audit",
          action: "rbac.seed",
          payload: { after: { added: ["member:manage"] } },
        }),
      ),
    ).toEqual([{ type: "granted", keys: ["member:manage"] }]);
  });

  it("reads sign-ins, roster syncs and impersonation reasons", () => {
    expect(
      activityDetails(
        item({
          kind: "audit",
          action: "auth.sign_in",
          payload: { after: { roleSync: "failed" } },
        }),
      ),
    ).toEqual([{ type: "roleSyncFailed" }]);
    expect(
      activityDetails(
        item({
          kind: "audit",
          action: "auth.sign_in",
          payload: { after: { roleSync: "ok" } },
        }),
      ),
    ).toEqual([]);
    expect(
      activityDetails(
        item({
          kind: "audit",
          action: "members.sync",
          payload: { after: { created: 2, updated: 1 } },
        }),
      ),
    ).toEqual([{ type: "sync", created: 2, updated: 1, deactivated: 0 }]);
    expect(
      activityDetails(
        item({
          kind: "audit",
          action: "impersonation.start",
          payload: { after: { reason: "Revisar un error" } },
        }),
      ),
    ).toEqual([{ type: "reason", text: "Revisar un error" }]);
  });

  it("describes an impersonation window", () => {
    const window = {
      reason: "Soporte",
      active: false,
      expiresAt: "2026-11-05T11:00:00.000Z",
      endedAt: "2026-11-05T10:30:00.000Z",
      endReason: "stopped" as const,
    };
    expect(impersonationDetails(window)).toEqual([
      { type: "reason", text: "Soporte" },
      { type: "ended", reason: "stopped", at: "2026-11-05T10:30:00.000Z" },
    ]);
    expect(
      impersonationDetails({
        ...window,
        active: true,
        endedAt: null,
        endReason: null,
      }),
    ).toEqual([
      { type: "reason", text: "Soporte" },
      { type: "ongoing", until: "2026-11-05T11:00:00.000Z" },
    ]);
  });
});

describe("userAgentSummary", () => {
  it("names common browsers and systems", () => {
    expect(
      userAgentSummary(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", os: "Windows" });
    expect(
      userAgentSummary(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      ),
    ).toEqual({ browser: "Edge", os: "Windows" });
    expect(
      userAgentSummary(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Safari", os: "iOS" });
    expect(
      userAgentSummary(
        "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
      ),
    ).toEqual({ browser: "Firefox", os: "Linux" });
    expect(
      userAgentSummary(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", os: "Android" });
  });

  it("gives up on unknown agents", () => {
    expect(userAgentSummary(null)).toEqual({ browser: null, os: null });
    expect(userAgentSummary("curl/8.0")).toEqual({ browser: null, os: null });
  });
});
