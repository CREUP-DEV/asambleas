import { createError } from "h3";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  notLike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db";
import {
  agendaItems,
  amendmentAcceptances,
  amendmentAuthors,
  amendments,
  assemblies,
  auditLog,
  decisions,
  documents,
  events,
  impersonations,
  members,
  roles,
  users,
} from "../../db/schema";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_VALUES,
  EVENT_TYPES,
  IMPERSONATION_NOTICE_DAYS,
  IMPERSONATION_SESSION_ACTION,
  actionsOfCategory,
  activityCategory,
  changeEntityOf,
  changeFieldExposure,
  type ActivityCategory,
  type ActivityKind,
  type AuditAction,
  type AuditSource,
  type EventType,
  type MeActivityTab,
} from "~~/shared/constants/activity";
import type {
  AssemblySettings,
  AssemblyStatus,
  DecisionKind,
  DecisionMethod,
  DocumentStatus,
  AmendmentStatus,
} from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  ActivityActorDto,
  ActivityCursor,
  ActivityItemDto,
  ActivityPageDto,
  AdminActivityQuery,
  AdminImpersonationDto,
  AdminImpersonationPageDto,
  AdminImpersonationQuery,
  DecisionDto,
  ImpersonationDto,
  MeActivityPageDto,
  MeActivityQuery,
  MemberRef,
  UserRef,
} from "~~/shared/types/api";
import { encodeActivityCursor } from "~~/shared/utils/schemas/activity";
import {
  buildAssemblySlug,
  formatAssemblyLabel,
  parseAssemblySlug,
} from "~~/shared/utils/slug";
import {
  endImpersonations,
  toImpersonationDto,
  type ImpersonationRow,
} from "../auth/impersonation";
import { logError } from "../core/logger";
import { toMemberRef } from "../members/dto";
import {
  canManageAssemblies,
  canManageDocuments,
  canModerate,
  canReviewAmendments,
  type Actor,
} from "./actor";
import { redactAmendmentEventPayload } from "./amendments";
import { assemblySettings, canSeeDocumentCorrection } from "./documents";
import { loadCoProponentIds, loadSourceAuthorIds } from "./presenters";
import { resolveAssembly } from "./resolvers";
import {
  canSeeAmendment,
  canSeeAssembly,
  canSeeDocument,
  canSeePositions,
  filterDecisionsByAmendment,
  isAmendmentInsider,
  isDocumentPresenter,
  redactCorrectionNote,
  redactDocumentChanges,
  seesAllPresentedAmendments,
} from "./visibility";

/**
 * The activity read API (docs/api.md, "Activity and impersonation"):
 * GET /api/me/activity ("Mi actividad"), GET /api/admin/activity and GET
 * /api/admin/impersonations.
 *
 * One UNION ALL over events, audit_log and impersonations (each branch
 * served by its composite index), newest first and paged by keyset on
 * (created_at, id): never OFFSET, never COUNT. Labels and visibility are
 * resolved per page in batch (a handful of queries whatever the table size).
 *
 * Privacy of /api/me/activity: every row is judged again with the CURRENT
 * actor through the same helpers as the history endpoints (canSeeAssembly,
 * canSeeDocument, canSeeAmendment, correction notes, positions, decisions):
 * nothing is trusted from the time of the act.
 * - The account's own acts it can no longer see stay, with their type, time
 *   and (visible) assembly, and `target.available = false`, no label, no
 *   document and an empty payload.
 * - Others' acts (tab `member`) it cannot see are left out, so they do not
 *   reveal that a hidden item exists.
 * - Payloads go through a per-action allowlist after the redactions, so a
 *   new payload field never leaks by default.
 * - IP and user agent only on the account's own access rows (tab `access`).
 * - Who really did it while impersonating (`impersonatedBy`) only for the
 *   account acted as and for Admins.
 * Admins (GET /api/admin/*) read everything unredacted.
 */

// Raw rows ----------------------------------------------------------------------

/** One row of the activity UNION ALL. */
export interface RawActivityRow {
  kind: ActivityKind;
  id: string;
  /** Database time with microseconds, UTC (the cursor's `at`). */
  at: string;
  /** events.type, audit_log.action or IMPERSONATION_SESSION_ACTION. */
  action: string;
  source: AuditSource;
  /** The actor, or the Admin of an impersonation window. */
  actorUserId: string | null;
  /** events.actor_member_id; null for the other kinds. */
  actorMemberId: string | null;
  /** The impersonation it was recorded under; its own id for a window. */
  impersonationId: string | null;
  assemblyId: string | null;
  targetType: string;
  targetId: string;
  /** Event payload; `{ before, after }` for audit rows; `{}` for windows. */
  payload: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * Only on the "to" tab rows about a role the account held: whether that
   * tenure is assumed (true) or recorded (false). null elsewhere.
   */
  approximate: boolean | null;
}

/** A SELECT over one table; branches combine with UNION ALL. */
export type ActivityBranch =
  | { kind: "event"; where: SQL[] }
  | { kind: "audit"; where: SQL[]; approximate?: boolean }
  | { kind: "impersonation"; where: SQL[] };

/** to_char format of the cursor times: UTC with microseconds. */
const UTC_MICROS = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`);

/** A timestamptz column as the cursor's text (never through a JS Date). */
function atText(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', ${UTC_MICROS})`;
}

/** Keyset condition: rows strictly after the cursor in (time desc, id desc). */
export function keysetBefore(
  time: AnyPgColumn,
  id: AnyPgColumn,
  cursor: ActivityCursor | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${time}, ${id}) < (${cursor.at}::timestamptz, ${cursor.id}::text)`;
}

function whereOf(conditions: (SQL | undefined)[]): SQL {
  return and(...conditions) ?? sql`true`;
}

function branchQuery(
  branch: ActivityBranch,
  cursor: ActivityCursor | undefined,
  fetch: number,
): SQL {
  switch (branch.kind) {
    case "event": {
      const where = whereOf([
        ...branch.where,
        keysetBefore(events.createdAt, events.id, cursor),
      ]);
      return sql`(select 'event'::text as "kind", ${events.id} as "id", ${events.createdAt} as "atTs", ${atText(events.createdAt)} as "at", ${events.type} as "action", 'user'::text as "source", ${events.actorUserId} as "actorUserId", ${events.actorMemberId} as "actorMemberId", ${events.impersonationId} as "impersonationId", ${events.assemblyId} as "assemblyId", ${events.entityType} as "targetType", ${events.entityId} as "targetId", ${events.payload} as "payload", null::text as "ipAddress", null::text as "userAgent", null::boolean as "approximate" from ${events} where ${where} order by ${events.createdAt} desc, ${events.id} desc limit ${fetch})`;
    }
    case "audit": {
      const where = whereOf([
        ...branch.where,
        keysetBefore(auditLog.createdAt, auditLog.id, cursor),
      ]);
      const approximate =
        branch.approximate === undefined
          ? sql`null::boolean`
          : sql`${branch.approximate}::boolean`;
      return sql`(select 'audit'::text as "kind", ${auditLog.id} as "id", ${auditLog.createdAt} as "atTs", ${atText(auditLog.createdAt)} as "at", ${auditLog.action} as "action", ${auditLog.source} as "source", ${auditLog.actorUserId} as "actorUserId", null::text as "actorMemberId", ${auditLog.impersonationId} as "impersonationId", ${auditLog.assemblyId} as "assemblyId", ${auditLog.targetType} as "targetType", ${auditLog.targetId} as "targetId", jsonb_build_object('before', ${auditLog.before}, 'after', ${auditLog.after}) as "payload", ${auditLog.ipAddress} as "ipAddress", ${auditLog.userAgent} as "userAgent", ${approximate} as "approximate" from ${auditLog} where ${where} order by ${auditLog.createdAt} desc, ${auditLog.id} desc limit ${fetch})`;
    }
    case "impersonation": {
      const where = whereOf([
        ...branch.where,
        keysetBefore(impersonations.startedAt, impersonations.id, cursor),
      ]);
      return sql`(select 'impersonation'::text as "kind", ${impersonations.id} as "id", ${impersonations.startedAt} as "atTs", ${atText(impersonations.startedAt)} as "at", ${IMPERSONATION_SESSION_ACTION}::text as "action", 'user'::text as "source", ${impersonations.adminUserId} as "actorUserId", null::text as "actorMemberId", ${impersonations.id} as "impersonationId", null::text as "assemblyId", (case when ${impersonations.targetUserId} is null then 'impersonation' else 'user' end)::text as "targetType", coalesce(${impersonations.targetUserId}, ${impersonations.id}) as "targetId", '{}'::jsonb as "payload", ${impersonations.ipAddress} as "ipAddress", ${impersonations.userAgent} as "userAgent", null::boolean as "approximate" from ${impersonations} where ${where} order by ${impersonations.startedAt} desc, ${impersonations.id} desc limit ${fetch})`;
    }
  }
}

/**
 * The UNION ALL of the branches after `cursor`, newest first, at most
 * `fetch` rows. Each branch is limited too, so Postgres merges the index
 * scans instead of reading whole tables.
 */
export function activityQuery(
  branches: ActivityBranch[],
  cursor: ActivityCursor | undefined,
  fetch: number,
): SQL {
  const parts = branches.map((branch) => branchQuery(branch, cursor, fetch));
  return sql`select * from (${sql.join(parts, sql` union all `)}) as activity order by "atTs" desc, "id" desc limit ${fetch}`;
}

async function fetchActivityRows(
  branches: ActivityBranch[],
  cursor: ActivityCursor | undefined,
  fetch: number,
): Promise<RawActivityRow[]> {
  if (branches.length === 0) return [];
  const result = await db.execute<
    RawActivityRow & Record<string, unknown> & { atTs: unknown }
  >(activityQuery(branches, cursor, fetch));
  return result.rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    at: row.at,
    action: row.action,
    source: row.source,
    actorUserId: row.actorUserId ?? null,
    actorMemberId: row.actorMemberId ?? null,
    impersonationId: row.impersonationId ?? null,
    assemblyId: row.assemblyId ?? null,
    targetType: row.targetType,
    targetId: row.targetId,
    payload: row.payload ?? null,
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
    approximate: row.approximate ?? null,
  }));
}

// Pages -------------------------------------------------------------------------

/** Passes a page makes when the viewer's filter leaves rows out. */
export const ACTIVITY_PAGE_PASSES = 3;

/**
 * Builds a page of at most `limit` items from raw rows read in keyset order.
 * `build` may leave rows out (null): then more rows are read, up to
 * `maxPasses` reads. The next cursor is always the last row READ, never the
 * last one kept, so nothing is skipped or repeated; it is null only when no
 * row is left.
 */
export async function collectActivityPage(input: {
  cursor: ActivityCursor | undefined;
  limit: number;
  fetch: (
    cursor: ActivityCursor | undefined,
    count: number,
  ) => Promise<RawActivityRow[]>;
  build: (rows: RawActivityRow[]) => Promise<(ActivityItemDto | null)[]>;
  maxPasses?: number;
}): Promise<ActivityPageDto> {
  const items: ActivityItemDto[] = [];
  let position = input.cursor;
  const passes = Math.max(1, input.maxPasses ?? ACTIVITY_PAGE_PASSES);
  for (let pass = 0; pass < passes; pass += 1) {
    const need = input.limit - items.length;
    const rows = await input.fetch(position, need + 1);
    const scanned = rows.slice(0, need);
    for (const item of await input.build(scanned)) {
      if (item) items.push(item);
    }
    if (rows.length <= need) return { items, nextCursor: null };
    const last = scanned[scanned.length - 1]!;
    position = { at: last.at, id: last.id };
    if (items.length >= input.limit) break;
  }
  return {
    items,
    nextCursor: position ? encodeActivityCursor(position) : null,
  };
}

// Filters -----------------------------------------------------------------------

/** Filters every branch shares (both endpoints). */
export interface ActivityFilters {
  /** Resolved assembly id. */
  assemblyId?: string;
  categories?: ActivityCategory[];
  /** Exact event types, audit actions or IMPERSONATION_SESSION_ACTION. */
  actions?: string[];
  /** Inclusive (ISO with offset). */
  from?: string;
  /** Exclusive (ISO with offset). */
  to?: string;
}

function timeColumn(kind: ActivityKind): AnyPgColumn {
  if (kind === "event") return events.createdAt;
  if (kind === "audit") return auditLog.createdAt;
  return impersonations.startedAt;
}

/** The category filter of one kind; null when it rules the kind out. */
function categoryCondition(
  kind: "event" | "audit",
  categories: ActivityCategory[],
): SQL | null {
  const column = kind === "event" ? events.type : auditLog.action;
  const names = new Set<string>();
  for (const category of categories) {
    const { eventTypes, auditActions } = actionsOfCategory(category);
    for (const name of kind === "event" ? eventTypes : auditActions) {
      names.add(name);
    }
  }
  const parts: SQL[] = [];
  if (names.size > 0) parts.push(inArray(column, [...names]));
  // "other": actions outside the catalogs.
  if (categories.includes("other")) {
    const known: readonly string[] =
      kind === "event" ? EVENT_TYPES : AUDIT_ACTION_VALUES;
    parts.push(notInArray(column, [...known]));
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : or(...parts)!;
}

/**
 * The shared filters as conditions of one branch kind, or null when they
 * rule the kind out (impersonation windows belong to no assembly, and their
 * only action is IMPERSONATION_SESSION_ACTION in category `access`).
 */
export function sharedConditions(
  kind: ActivityKind,
  filters: ActivityFilters,
): SQL[] | null {
  const conditions: SQL[] = [];
  const time = timeColumn(kind);
  if (filters.from) {
    conditions.push(sql`${time} >= ${filters.from}::timestamptz`);
  }
  if (filters.to) conditions.push(sql`${time} < ${filters.to}::timestamptz`);

  if (kind === "impersonation") {
    if (filters.assemblyId) return null;
    if (
      filters.categories?.length &&
      !filters.categories.includes(
        activityCategory("impersonation", IMPERSONATION_SESSION_ACTION),
      )
    ) {
      return null;
    }
    if (
      filters.actions?.length &&
      !filters.actions.includes(IMPERSONATION_SESSION_ACTION)
    ) {
      return null;
    }
    return conditions;
  }

  if (filters.assemblyId) {
    conditions.push(
      kind === "event"
        ? eq(events.assemblyId, filters.assemblyId)
        : // An audit row names its assembly in assembly_id, or as its target
          // (assembly.delete, whose assembly no longer exists).
          or(
            eq(auditLog.assemblyId, filters.assemblyId),
            and(
              eq(auditLog.targetType, "assembly"),
              eq(auditLog.targetId, filters.assemblyId),
            ),
          )!,
    );
  }
  if (filters.categories?.length) {
    const condition = categoryCondition(kind, filters.categories);
    if (!condition) return null;
    conditions.push(condition);
  }
  if (filters.actions?.length) {
    conditions.push(
      inArray(kind === "event" ? events.type : auditLog.action, [
        ...filters.actions,
      ]),
    );
  }
  return conditions;
}

/** Audit actions about the account itself (tab `to`). */
export const ME_TO_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.USER_CREATED,
  AUDIT_ACTIONS.ROLE_ASSIGN,
  AUDIT_ACTIONS.USER_PERMISSIONS_SET,
  AUDIT_ACTIONS.USER_MEMBER_LINK,
  AUDIT_ACTIONS.USER_ROLE_SYNC,
  AUDIT_ACTIONS.USER_INITIAL_ADMIN,
];

/** Sign-ins and sign-outs (tab `access`). */
export const ME_ACCESS_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.AUTH_SIGN_IN,
  AUDIT_ACTIONS.AUTH_SIGN_OUT,
  AUDIT_ACTIONS.AUTH_SESSION_ENDED,
];

/** Changes to a role's permissions, attributed to the accounts holding it. */
export const ROLE_CHANGE_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.PERMISSIONS_SET,
  AUDIT_ACTIONS.RBAC_SEED,
];

/** Roster sync internals: one row per member, for Admins only. */
export const ADMIN_ONLY_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.MEMBER_SYNC_CREATE,
  AUDIT_ACTIONS.MEMBER_SYNC_UPDATE,
  AUDIT_ACTIONS.MEMBER_SYNC_DEACTIVATE,
];

/** Sources of what an account does itself (the rest is the intranet, sign-in, seed or system). */
const OWN_ACT_SOURCES: readonly AuditSource[] = ["user", "import"];

/** Event types a Mesa records in a member's name (tab `member`). */
const RECORDED_FOR_MEMBER_TYPES: readonly EventType[] = [
  "position_changed",
  "acceptance_recorded",
];

/** A role the account held over a period ("to" tab), from roleTenure. */
export interface RolePeriod {
  roleId: string;
  /** Inclusive start (cursor-style text), or null for "since always". */
  from: string | null;
  /** Exclusive end, or null for "until now". */
  to: string | null;
  /** The period is assumed (no recorded change starts it), not recorded. */
  approximate: boolean;
}

/**
 * The branches of each "Mi actividad" tab (ME_ACTIVITY_TABS):
 * - `by`: events the account is the actor of (also what an Admin did while
 *   acting as it) and its own audit rows, without sign-ins, rows from the
 *   intranet, sign-in, seed or system, and roster sync internals;
 * - `to`: audit rows about the account (ME_TO_ACTIONS), changes to the
 *   permissions of the roles it held while it held them (`tenure`), and the
 *   impersonations of it;
 * - `access`: its sign-ins and sign-outs, and the impersonations of it or
 *   by it;
 * - `member`: what other accounts did for its member, plus the positions and
 *   acceptances the Mesa recorded for it. Empty without a member.
 */
export function meActivityBranches(input: {
  tab: MeActivityTab;
  userId: string;
  memberId: string | null;
  tenure: RolePeriod[];
  filters: ActivityFilters;
}): ActivityBranch[] {
  const { userId, filters } = input;
  const branches: ActivityBranch[] = [];
  const add = (
    kind: ActivityKind,
    where: SQL[],
    approximate?: boolean,
  ): void => {
    const shared = sharedConditions(kind, filters);
    if (!shared) return;
    const all = [...where, ...shared];
    if (kind === "audit") branches.push({ kind, where: all, approximate });
    else branches.push({ kind, where: all });
  };
  const aboutMe = and(
    eq(auditLog.targetType, "user"),
    eq(auditLog.targetId, userId),
  )!;

  switch (input.tab) {
    case "by":
      add("event", [eq(events.actorUserId, userId)]);
      add("audit", [
        eq(auditLog.actorUserId, userId),
        inArray(auditLog.source, [...OWN_ACT_SOURCES]),
        notLike(auditLog.action, "auth.%"),
        notInArray(auditLog.action, [...ADMIN_ONLY_ACTIONS]),
      ]);
      break;
    case "to":
      add("audit", [aboutMe, inArray(auditLog.action, [...ME_TO_ACTIONS])]);
      for (const period of input.tenure) {
        add(
          "audit",
          [
            eq(auditLog.targetType, "role"),
            eq(auditLog.targetId, period.roleId),
            inArray(auditLog.action, [...ROLE_CHANGE_ACTIONS]),
            ...(period.from
              ? [sql`${auditLog.createdAt} >= ${period.from}::timestamptz`]
              : []),
            ...(period.to
              ? [sql`${auditLog.createdAt} < ${period.to}::timestamptz`]
              : []),
          ],
          period.approximate,
        );
      }
      add("impersonation", [eq(impersonations.targetUserId, userId)]);
      break;
    case "access":
      add("audit", [aboutMe, inArray(auditLog.action, [...ME_ACCESS_ACTIONS])]);
      add("impersonation", [
        or(
          eq(impersonations.targetUserId, userId),
          eq(impersonations.adminUserId, userId),
        )!,
      ]);
      break;
    case "member": {
      const memberId = input.memberId;
      if (!memberId) break;
      add("event", [
        eq(events.actorMemberId, memberId),
        sql`${events.actorUserId} is distinct from ${userId}`,
      ]);
      add("event", [
        inArray(events.type, [...RECORDED_FOR_MEMBER_TYPES]),
        or(
          and(
            eq(events.type, "position_changed"),
            sql`${events.payload}->>'by' = 'moderator'`,
            sql`${events.payload}->>'memberId' = ${memberId}`,
          ),
          and(
            eq(events.type, "acceptance_recorded"),
            sql`${events.payload}->>'recordedForMemberId' = ${memberId}`,
          ),
        )!,
        // Not already in the first branch, nor the account's own act.
        sql`${events.actorMemberId} is distinct from ${memberId}`,
        sql`${events.actorUserId} is distinct from ${userId}`,
      ]);
      break;
    }
  }
  return branches;
}

/** GET /api/admin/activity filters, resolved (assembly id, users matching `q`). */
export interface AdminActivityPlan extends ActivityFilters {
  actor?: string;
  target?: string;
  user?: string;
  member?: string;
  kinds?: ActivityKind[];
  sources?: AuditSource[];
  impersonated?: boolean;
  impersonation?: string;
  /** Users whose name or email matches `q`; undefined without `q`. */
  matchingUserIds?: string[];
}

/**
 * The branches of the Admin log. Filters combine with AND; a filter a kind
 * cannot meet drops that kind: `target` (an account) drops events, `member`
 * and `assembly` drop impersonation windows, `impersonated=false` drops
 * the windows too, and `source` other than `user` drops events and windows.
 */
export function adminActivityBranches(
  plan: AdminActivityPlan,
): ActivityBranch[] {
  if (plan.matchingUserIds && plan.matchingUserIds.length === 0) return [];
  const wants = (kind: ActivityKind) =>
    !plan.kinds?.length || plan.kinds.includes(kind);
  const userSource = !plan.sources?.length || plan.sources.includes("user");
  const matching = plan.matchingUserIds;
  const branches: ActivityBranch[] = [];

  if (wants("event") && userSource && !plan.target) {
    const shared = sharedConditions("event", plan);
    if (shared) {
      const where = [...shared];
      if (plan.actor) where.push(eq(events.actorUserId, plan.actor));
      if (plan.user) where.push(eq(events.actorUserId, plan.user));
      if (plan.member) where.push(eq(events.actorMemberId, plan.member));
      if (plan.impersonated !== undefined) {
        where.push(
          plan.impersonated
            ? isNotNull(events.impersonationId)
            : isNull(events.impersonationId),
        );
      }
      if (plan.impersonation) {
        where.push(eq(events.impersonationId, plan.impersonation));
      }
      if (matching) where.push(inArray(events.actorUserId, matching));
      branches.push({ kind: "event", where });
    }
  }

  if (wants("audit")) {
    const shared = sharedConditions("audit", plan);
    if (shared) {
      const where = [...shared];
      const aboutUser = (id: string) =>
        and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, id))!;
      if (plan.sources?.length) {
        where.push(inArray(auditLog.source, plan.sources));
      }
      if (plan.actor) where.push(eq(auditLog.actorUserId, plan.actor));
      if (plan.target) where.push(aboutUser(plan.target));
      if (plan.user) {
        where.push(
          or(eq(auditLog.actorUserId, plan.user), aboutUser(plan.user))!,
        );
      }
      if (plan.member) {
        where.push(
          and(
            eq(auditLog.targetType, "member"),
            eq(auditLog.targetId, plan.member),
          )!,
        );
      }
      if (plan.impersonated !== undefined) {
        where.push(
          plan.impersonated
            ? isNotNull(auditLog.impersonationId)
            : isNull(auditLog.impersonationId),
        );
      }
      if (plan.impersonation) {
        where.push(eq(auditLog.impersonationId, plan.impersonation));
      }
      if (matching) {
        where.push(
          or(
            inArray(auditLog.actorUserId, matching),
            and(
              eq(auditLog.targetType, "user"),
              inArray(auditLog.targetId, matching),
            ),
          )!,
        );
      }
      branches.push({ kind: "audit", where });
    }
  }

  if (
    wants("impersonation") &&
    userSource &&
    !plan.member &&
    plan.impersonated !== false
  ) {
    const shared = sharedConditions("impersonation", plan);
    if (shared) {
      const where = [...shared];
      if (plan.actor) where.push(eq(impersonations.adminUserId, plan.actor));
      if (plan.target) where.push(eq(impersonations.targetUserId, plan.target));
      if (plan.user) {
        where.push(
          or(
            eq(impersonations.adminUserId, plan.user),
            eq(impersonations.targetUserId, plan.user),
          )!,
        );
      }
      if (plan.impersonation) {
        where.push(eq(impersonations.id, plan.impersonation));
      }
      if (matching) {
        where.push(
          or(
            inArray(impersonations.adminUserId, matching),
            inArray(impersonations.targetUserId, matching),
          )!,
        );
      }
      branches.push({ kind: "impersonation", where });
    }
  }
  return branches;
}

// Role tenure ---------------------------------------------------------------------

/** A recorded change of the account's role, oldest first (role ids resolved). */
export interface RoleChange {
  at: string;
  action: string;
  beforeRoleId: string | null;
  afterRoleId: string | null;
}

/** At most this many tenure periods become branches (role changes are rare). */
export const ROLE_TENURE_MAX_PERIODS = 30;

/**
 * The roles the account held and when, from its recorded role changes
 * (user.created, role.assign, user.role_sync, user.initial_admin; oldest
 * first). A period that a recorded change starts is exact; the role held
 * before the first recorded change, the current role when nothing was
 * recorded, and a current role that no recorded change explains are
 * assumed (`approximate`): rows older than the role history fall back to
 * the current role. Nothing is attributed before the account existed.
 */
export function roleTenure(input: {
  changes: RoleChange[];
  currentRoleId: string | null;
  accountCreatedAt: string | null;
}): RolePeriod[] {
  const periods: RolePeriod[] = [];
  let role: string | null = null;
  let from: string | null = input.accountCreatedAt;
  let exact = false;
  for (const change of input.changes) {
    if (role === null && change.beforeRoleId) {
      // Held before the first recorded change, since an unknown time.
      role = change.beforeRoleId;
      exact = false;
    }
    const next = change.afterRoleId;
    if (!next || next === role) continue;
    if (role !== null) {
      periods.push({ roleId: role, from, to: change.at, approximate: !exact });
    }
    role = next;
    from = change.at;
    exact = true;
  }
  if (role === null) {
    if (input.currentRoleId) {
      periods.push({
        roleId: input.currentRoleId,
        from: input.accountCreatedAt,
        to: null,
        approximate: true,
      });
    }
  } else if (input.currentRoleId && input.currentRoleId !== role) {
    // A change nothing recorded: both roles are possible since then.
    periods.push({ roleId: role, from, to: null, approximate: true });
    periods.push({
      roleId: input.currentRoleId,
      from,
      to: null,
      approximate: true,
    });
  } else {
    periods.push({ roleId: role, from, to: null, approximate: !exact });
  }
  return periods.slice(-ROLE_TENURE_MAX_PERIODS);
}

/** Audit actions that record the account's role (the tenure timeline). */
const ROLE_TIMELINE_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.USER_CREATED,
  AUDIT_ACTIONS.ROLE_ASSIGN,
  AUDIT_ACTIONS.USER_ROLE_SYNC,
  AUDIT_ACTIONS.USER_INITIAL_ADMIN,
];

async function loadRoleTenure(userId: string): Promise<RolePeriod[]> {
  const [accounts, roleRows, changes] = await Promise.all([
    db
      .select({ roleId: users.roleId, createdAt: atText(users.createdAt) })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db.select({ id: roles.id, name: roles.name }).from(roles),
    db
      .select({
        action: auditLog.action,
        before: auditLog.before,
        after: auditLog.after,
        at: atText(auditLog.createdAt),
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "user"),
          eq(auditLog.targetId, userId),
          inArray(auditLog.action, [...ROLE_TIMELINE_ACTIONS]),
        ),
      )
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
      .limit(500),
  ]);
  const account = accounts[0];
  const byName = new Map(roleRows.map((role) => [role.name, role.id]));
  const roleOf = (side: unknown): string | null => {
    const value = record(side);
    if (!value) return null;
    const id = text(value.roleId);
    if (id) return id;
    const name = text(value.roleName);
    return name ? (byName.get(name) ?? null) : null;
  };
  return roleTenure({
    changes: changes.map((change) => ({
      at: change.at,
      action: change.action,
      beforeRoleId: roleOf(change.before),
      afterRoleId: roleOf(change.after),
    })),
    currentRoleId: account?.roleId ?? null,
    accountCreatedAt: account?.createdAt ?? null,
  });
}

// Payload allowlists ----------------------------------------------------------------

/**
 * Event payload keys shown outside the Admin log, per type. A key left out
 * here (ids of other rows, internal versions, deadlines, file paths) never
 * reaches a non-Admin; a new type shows nothing until it is listed.
 * Correction notes, positions and a document's field values are redacted
 * before this (see eventTarget). `decision_recorded.subjectIds` is already
 * filtered to the amendments the viewer can see. Some keys are narrowed
 * after picking (narrowEventPayload): `changes` to the fields of
 * CHANGE_FIELDS, `deletedItems` to titles, `moves` to a count (`moved`).
 */
export const EVENT_PAYLOAD_KEYS: Record<EventType, readonly string[]> = {
  assembly_created: ["number", "type", "defaultCalendar"],
  assembly_updated: ["fields", "changes"],
  assembly_status_changed: ["from", "to"],
  assembly_deleted: [],
  calendar_updated: ["updated", "removed", "changes"],
  agenda_finalized: [],
  agenda_reopened: [],
  agenda_item_created: ["title"],
  agenda_item_updated: ["changes"],
  agenda_item_deleted: ["title", "deletedItems"],
  agenda_reordered: ["moves"],
  live_changed: ["changed", "speakersVisible"],
  speakers_visibility_changed: ["visible", "reason"],
  speaking_turn_added: ["position"],
  speaking_turn_started: ["from", "to", "position", "renamed"],
  speaking_turn_finished: ["from", "to", "reason"],
  speaking_turn_cancelled: ["from", "to", "reason"],
  speaking_turn_restored: ["from", "to", "position"],
  speaking_turn_moved: ["from", "to", "position"],
  speaking_turn_updated: ["from", "to", "position", "renamed"],
  vote_recorded: ["subjectType", "result"],
  decision_recorded: ["kind", "method", "subjectIds"],
  document_created: ["title", "kind", "format", "acceptedAmendments"],
  document_updated: ["fields", "changes"],
  document_status_changed: ["from", "to"],
  document_content_updated: ["blockCount"],
  document_file_uploaded: ["fileName", "replaced"],
  document_submitted: ["submittedAt", "afterCorrection"],
  document_correction_requested: ["note"],
  document_published: ["reference", "republished", "from"],
  document_deleted: ["title", "kind", "format"],
  document_voted: [
    "result",
    "method",
    "majority",
    "inFavor",
    "against",
    "abstentions",
    "blank",
    "invalid",
    "present",
  ],
  final_vote_annulled: ["result", "note"],
  amendment_created: ["kind", "code"],
  amendment_updated: ["kind"],
  amendment_deleted: ["kind", "code"],
  amendment_submitted: [
    "number",
    "code",
    "late",
    "admission",
    "afterCorrection",
    "awaitsAuthors",
  ],
  amendment_withdrawn: ["by", "sourceCode", "sourceStatus"],
  amendment_correction_requested: ["note"],
  amendment_validated: ["publish", "admission", "method"],
  amendment_published: [],
  amendment_admitted: ["method", "voteResult", "validated"],
  amendment_inadmissible: ["method", "voteResult", "validated"],
  amendment_approved: [
    "method",
    "byPosition",
    "reason",
    "inFavor",
    "against",
    "abstentions",
  ],
  amendment_rejected: ["method", "inFavor", "against", "abstentions"],
  amendment_reopened: ["previousStatus", "reason"],
  // The transactional that replaced it was published when validated.
  amendment_transacted: ["code"],
  amendment_lapsed: ["reason", "by", "code"],
  position_changed: ["position", "by"],
  acceptance_recorded: ["role", "decision"],
  relation_created: ["kind", "direction"],
  relation_deleted: ["kind", "direction"],
};

/**
 * Audit `before`/`after` keys shown outside the Admin log, per action.
 * Never IPs, emails, session or job ids, batch ids or roster conflicts.
 */
export const AUDIT_PAYLOAD_KEYS: Record<AuditAction, readonly string[]> = {
  "role.assign": ["roleName"],
  "user.permissions_set": ["permissions"],
  "user.member_link": ["memberId", "reason"],
  "permissions.set": ["permissions"],
  "member.create": [
    "acronym",
    "name",
    "kind",
    "university",
    "region",
    "active",
    "reason",
  ],
  "member.update": [
    "acronym",
    "name",
    "kind",
    "university",
    "region",
    "active",
  ],
  "members.sync": ["created", "updated", "deactivated", "unchanged"],
  "member.sync_create": [],
  "member.sync_update": [],
  "member.sync_deactivate": [],
  "assembly.delete": ["number", "type", "slug", "startDate", "location"],
  // Ids, file ids and folder names of the source: Admins only.
  "assembly.import": [],
  "document.import": ["fileName", "blockCount"],
  "user.created": ["roleName"],
  "user.role_sync": [
    "roleName",
    "externalRole",
    "externalName",
    "externalInitials",
    "university",
    "memberId",
  ],
  "user.initial_admin": ["roleName"],
  "auth.sign_in": ["roleSync"],
  "auth.sign_out": [],
  "auth.session_ended": [],
  "export.request": ["variant", "locale"],
  "export.download": [],
  "rbac.seed": ["added"],
  "impersonation.start": ["reason", "expiresAt"],
  "impersonation.stop": ["endReason", "startedAt", "endedAt"],
  "impersonation.expire": ["endReason", "startedAt", "endedAt"],
  "impersonation.revoke": ["endReason", "startedAt", "endedAt"],
  "impersonation.request": ["method", "path", "status"],
};

function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  return result;
}

function keysOf<T extends string>(
  catalog: Record<T, readonly string[]>,
  action: string,
): readonly string[] {
  // Own keys only: "constructor" and friends are not actions.
  return Object.hasOwn(catalog, action) ? (catalog[action as T] ?? []) : [];
}

/** A value of a change that may be shown: a scalar, never an array or object. */
function changeScalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : null;
}

/**
 * The fields of `payload.changes` a non-Admin may read (CHANGE_FIELDS):
 * `{ from, to }` for the ones shown with their values, `{}` for the ones
 * shown only as changed (ids, the internal deadline). Null when none is left.
 */
export function allowedChanges(
  action: string,
  changes: unknown,
): Record<string, { from?: unknown; to?: unknown }> | null {
  const entity = changeEntityOf(action);
  const source = record(changes);
  if (!entity || !source) return null;
  const result: Record<string, { from?: unknown; to?: unknown }> = {};
  for (const [field, value] of Object.entries(source)) {
    const exposure = changeFieldExposure(entity, field);
    const change = record(value);
    if (!exposure || !change) continue;
    result[field] =
      exposure === "values"
        ? { from: changeScalar(change.from), to: changeScalar(change.to) }
        : {};
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Narrows the picked keys that carry more than a non-Admin may read:
 * `changes` (allowedChanges), `deletedItems` of a deleted agenda item (its
 * titles, without ids) and `moves` of a reordered agenda (how many items
 * moved, without ids or positions).
 */
function narrowEventPayload(
  action: string,
  picked: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...picked };
  if (Object.hasOwn(result, "changes")) {
    const changes = allowedChanges(action, result.changes);
    if (changes) result.changes = changes;
    else delete result.changes;
  }
  if (Object.hasOwn(result, "deletedItems")) {
    result.deletedItems = Array.isArray(result.deletedItems)
      ? result.deletedItems
          .map((entry) => text(record(entry)?.title))
          .filter((title): title is string => title !== null)
          .map((title) => ({ title }))
      : [];
  }
  if (Object.hasOwn(result, "moves")) {
    result.moved = Array.isArray(result.moves) ? result.moves.length : 0;
    delete result.moves;
  }
  return result;
}

/**
 * Adds the member a `memberId` names (member links, role sync), so the
 * pages say which council or area without another request.
 */
function withMember(
  side: Record<string, unknown> | null,
  membersById: ReadonlyMap<string, MemberRef>,
): Record<string, unknown> | null {
  if (!side || !Object.hasOwn(side, "memberId")) return side;
  const memberId = text(side.memberId);
  return {
    ...side,
    member: memberId ? (membersById.get(memberId) ?? null) : null,
  };
}

/**
 * The payload of an item outside the Admin log: the allowlisted keys of an
 * event payload, `{ before, after }` with the allowlisted keys of an audit
 * row, `{}` for a window or an unknown action.
 */
export function allowActivityPayload(
  kind: ActivityKind,
  action: string,
  payload: Record<string, unknown> | null,
  membersById: ReadonlyMap<string, MemberRef> = new Map(),
): Record<string, unknown> {
  const source = payload ?? {};
  if (kind === "event") {
    return narrowEventPayload(
      action,
      pick(source, keysOf(EVENT_PAYLOAD_KEYS, action)),
    );
  }
  if (kind !== "audit") return {};
  const keys = keysOf(AUDIT_PAYLOAD_KEYS, action);
  if (keys.length === 0) return {};
  const side = (value: unknown) => {
    const object = record(value);
    return object ? withMember(pick(object, keys), membersById) : null;
  };
  return { before: side(source.before), after: side(source.after) };
}

/** An audit payload for Admins: everything, plus the members it names. */
function adminAuditPayload(
  payload: Record<string, unknown> | null,
  membersById: ReadonlyMap<string, MemberRef>,
): Record<string, unknown> {
  const source = payload ?? {};
  return {
    before: withMember(record(source.before), membersById),
    after: withMember(record(source.after), membersById),
  };
}

// Lookups -----------------------------------------------------------------------------

export interface AssemblyInfo {
  id: string;
  number: number;
  type: string;
  status: AssemblyStatus;
  settings: AssemblySettings;
}

export interface DocumentInfo {
  id: string;
  assemblyId: string;
  slug: string;
  title: string;
  status: DocumentStatus;
  proponentMemberId: string | null;
  submittedByUserId: string | null;
  coProponentMemberIds: string[];
}

export interface AmendmentInfo {
  id: string;
  documentId: string;
  code: string | null;
  status: AmendmentStatus;
  publishedAt: Date | null;
  createdByUserId: string | null;
  authorMemberIds: string[];
  partyMemberIds: string[];
}

export interface DecisionInfo {
  id: string;
  kind: DecisionKind;
  method: DecisionMethod;
  subjectIds: string[];
}

export interface ImpersonationInfo extends ImpersonationRow {
  ipAddress: string | null;
  userAgent: string | null;
}

/** Who could see a document or amendment that no longer exists, from its events. */
export interface DeletedInfo {
  memberIds: string[];
  userIds: string[];
  /** Its title or code, when an event kept it. */
  label: string | null;
}

/** What a page of rows names, loaded in batch. */
export interface ActivityLookups {
  users: Map<string, UserRef>;
  members: Map<string, MemberRef>;
  assemblies: Map<string, AssemblyInfo>;
  documents: Map<string, DocumentInfo>;
  amendments: Map<string, AmendmentInfo>;
  decisions: Map<string, DecisionInfo>;
  agendaItems: Map<string, string>;
  roles: Map<string, string>;
  impersonations: Map<string, ImpersonationInfo>;
  /** Keyed `document:<id>` or `amendment:<id>`. */
  deleted: Map<string, DeletedInfo>;
}

export function emptyActivityLookups(): ActivityLookups {
  return {
    users: new Map(),
    members: new Map(),
    assemblies: new Map(),
    documents: new Map(),
    amendments: new Map(),
    decisions: new Map(),
    agendaItems: new Map(),
    roles: new Map(),
    impersonations: new Map(),
    deleted: new Map(),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The ids a page of rows names, per table. */
export interface ActivityIds {
  users: Set<string>;
  members: Set<string>;
  assemblies: Set<string>;
  documents: Set<string>;
  amendments: Set<string>;
  decisions: Set<string>;
  agendaItems: Set<string>;
  roles: Set<string>;
  impersonations: Set<string>;
}

/** Collects what each row names: actors, targets and the ids in payloads. */
export function collectActivityIds(rows: RawActivityRow[]): ActivityIds {
  const ids: ActivityIds = {
    users: new Set(),
    members: new Set(),
    assemblies: new Set(),
    documents: new Set(),
    amendments: new Set(),
    decisions: new Set(),
    agendaItems: new Set(),
    roles: new Set(),
    impersonations: new Set(),
  };
  for (const row of rows) {
    const payload = row.payload ?? {};
    if (row.actorUserId) ids.users.add(row.actorUserId);
    if (row.actorMemberId) ids.members.add(row.actorMemberId);
    if (row.assemblyId) ids.assemblies.add(row.assemblyId);
    if (row.impersonationId) ids.impersonations.add(row.impersonationId);

    if (row.kind === "event") {
      switch (row.targetType) {
        case "document":
          ids.documents.add(row.targetId);
          break;
        case "amendment":
          ids.amendments.add(row.targetId);
          break;
        case "agenda_item":
          ids.agendaItems.add(row.targetId);
          break;
        case "decision":
          ids.decisions.add(row.targetId);
          for (const id of texts(payload.subjectIds)) ids.amendments.add(id);
          break;
        case "vote": {
          const subjectId = text(payload.subjectId);
          if (!subjectId) break;
          if (payload.subjectType === "document") ids.documents.add(subjectId);
          if (payload.subjectType === "amendment") {
            ids.amendments.add(subjectId);
          }
          if (payload.subjectType === "decision") ids.decisions.add(subjectId);
          break;
        }
      }
      continue;
    }

    switch (row.targetType) {
      case "user":
        ids.users.add(row.targetId);
        break;
      case "member":
        ids.members.add(row.targetId);
        break;
      case "role":
        ids.roles.add(row.targetId);
        break;
      case "assembly":
        ids.assemblies.add(row.targetId);
        break;
      case "document":
        ids.documents.add(row.targetId);
        break;
    }
    for (const side of [payload.before, payload.after]) {
      const memberId = text(record(side)?.memberId);
      if (memberId) ids.members.add(memberId);
    }
  }
  return ids;
}

/** Display name: the intranet's when known, the Google one otherwise. Never the email. */
const userName = sql<string>`coalesce(${users.externalName}, ${users.name})`;

async function loadUserRefs(
  ids: Iterable<string>,
): Promise<Map<string, UserRef>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: userName })
    .from(users)
    .where(inArray(users.id, list));
  return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name }]));
}

async function loadMemberRefs(
  ids: Iterable<string>,
): Promise<Map<string, MemberRef>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await db
    .select({
      id: members.id,
      acronym: members.acronym,
      name: members.name,
      kind: members.kind,
    })
    .from(members)
    .where(inArray(members.id, list));
  return new Map(rows.map((row) => [row.id, toMemberRef(row)]));
}

const impersonationInfoColumns = {
  id: impersonations.id,
  adminUserId: impersonations.adminUserId,
  targetUserId: impersonations.targetUserId,
  sessionId: impersonations.sessionId,
  reason: impersonations.reason,
  startedAt: impersonations.startedAt,
  expiresAt: impersonations.expiresAt,
  endedAt: impersonations.endedAt,
  endReason: impersonations.endReason,
  ipAddress: impersonations.ipAddress,
  userAgent: impersonations.userAgent,
};

/**
 * Amendments with what canSeeAmendment needs: the same reads as the history
 * endpoints (authors, acceptances, authors of what a transactional groups).
 */
async function loadAmendmentInfo(
  ids: string[],
): Promise<Map<string, AmendmentInfo>> {
  if (ids.length === 0) return new Map();
  const [rows, authorRows, partyRows, sourceAuthors] = await Promise.all([
    db
      .select({
        id: amendments.id,
        documentId: amendments.documentId,
        code: amendments.code,
        status: amendments.status,
        publishedAt: amendments.publishedAt,
        createdByUserId: amendments.createdByUserId,
      })
      .from(amendments)
      .where(inArray(amendments.id, ids)),
    db
      .select({
        amendmentId: amendmentAuthors.amendmentId,
        memberId: amendmentAuthors.memberId,
      })
      .from(amendmentAuthors)
      .where(inArray(amendmentAuthors.amendmentId, ids)),
    db
      .select({
        amendmentId: amendmentAcceptances.amendmentId,
        memberId: amendmentAcceptances.memberId,
      })
      .from(amendmentAcceptances)
      .where(inArray(amendmentAcceptances.amendmentId, ids)),
    loadSourceAuthorIds(ids),
  ]);
  const group = (list: { amendmentId: string; memberId: string }[]) => {
    const map = new Map<string, string[]>();
    for (const row of list) {
      map.set(row.amendmentId, [
        ...(map.get(row.amendmentId) ?? []),
        row.memberId,
      ]);
    }
    return map;
  };
  const authors = group(authorRows);
  const parties = group(partyRows);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        ...row,
        authorMemberIds: authors.get(row.id) ?? [],
        partyMemberIds: [
          ...(parties.get(row.id) ?? []),
          ...(sourceAuthors.get(row.id) ?? []),
        ],
      },
    ]),
  );
}

async function loadDocumentInfo(
  ids: string[],
): Promise<Map<string, DocumentInfo>> {
  if (ids.length === 0) return new Map();
  const [rows, coProponents] = await Promise.all([
    db
      .select({
        id: documents.id,
        assemblyId: documents.assemblyId,
        slug: documents.slug,
        title: documents.title,
        status: documents.status,
        proponentMemberId: documents.proponentMemberId,
        submittedByUserId: documents.submittedByUserId,
      })
      .from(documents)
      .where(inArray(documents.id, ids)),
    loadCoProponentIds(ids),
  ]);
  return new Map(
    rows.map((row) => [
      row.id,
      { ...row, coProponentMemberIds: coProponents.get(row.id) ?? [] },
    ]),
  );
}

/** Insiders a payload names: presenters and authors (members), creators (users). */
export function insidersOfPayload(payload: Record<string, unknown>): {
  memberIds: string[];
  userIds: string[];
} {
  return {
    memberIds: [
      ...texts(payload.coProponentMemberIds),
      ...texts(payload.authorMemberIds),
      ...[payload.proponentMemberId, payload.mainAuthorId]
        .map(text)
        .filter((id): id is string => id !== null),
    ],
    userIds: [payload.submittedByUserId, payload.createdByUserId]
      .map(text)
      .filter((id): id is string => id !== null),
  };
}

/**
 * Who could see documents and amendments that no longer exist: rebuilt
 * from their creation and deletion events (the deletion payload names its
 * presenters or authors once the writers record them; the creator is the
 * creation event's actor).
 */
async function loadDeletedInfo(
  documentIds: string[],
  amendmentIds: string[],
): Promise<Map<string, DeletedInfo>> {
  const scope: SQL[] = [];
  if (documentIds.length > 0) {
    scope.push(
      and(
        eq(events.entityType, "document"),
        inArray(events.entityId, documentIds),
        inArray(events.type, ["document_created", "document_deleted"]),
      )!,
    );
  }
  if (amendmentIds.length > 0) {
    scope.push(
      and(
        eq(events.entityType, "amendment"),
        inArray(events.entityId, amendmentIds),
        inArray(events.type, ["amendment_created", "amendment_deleted"]),
      )!,
    );
  }
  if (scope.length === 0) return new Map();
  const rows = await db
    .select({
      entityType: events.entityType,
      entityId: events.entityId,
      type: events.type,
      payload: events.payload,
      actorUserId: events.actorUserId,
    })
    .from(events)
    .where(or(...scope))
    .orderBy(asc(events.createdAt), asc(events.id));
  const result = new Map<string, DeletedInfo>();
  for (const row of rows) {
    const key = `${row.entityType}:${row.entityId}`;
    const entry = result.get(key) ?? {
      memberIds: [],
      userIds: [],
      label: null,
    };
    const payload = row.payload ?? {};
    const insiders = insidersOfPayload(payload);
    entry.memberIds.push(...insiders.memberIds);
    entry.userIds.push(...insiders.userIds);
    if (row.type.endsWith("_created") && row.actorUserId) {
      entry.userIds.push(row.actorUserId);
    }
    entry.label =
      text(row.entityType === "document" ? payload.title : payload.code) ??
      entry.label;
    result.set(key, entry);
  }
  return result;
}

/**
 * Everything a page of rows names, in a few batched rounds: impersonations,
 * decisions, agenda items and roles; then amendments and users; then
 * documents; then assemblies, members and what deleted rows left behind.
 */
export async function loadActivityLookups(
  rows: RawActivityRow[],
): Promise<ActivityLookups> {
  const lookups = emptyActivityLookups();
  if (rows.length === 0) return lookups;
  const ids = collectActivityIds(rows);

  const [impersonationRows, decisionRows, agendaRows, roleRows] =
    await Promise.all([
      ids.impersonations.size > 0
        ? db
            .select(impersonationInfoColumns)
            .from(impersonations)
            .where(inArray(impersonations.id, [...ids.impersonations]))
        : [],
      ids.decisions.size > 0
        ? db
            .select({
              id: decisions.id,
              kind: decisions.kind,
              method: decisions.method,
              subjectIds: decisions.subjectIds,
            })
            .from(decisions)
            .where(inArray(decisions.id, [...ids.decisions]))
        : [],
      ids.agendaItems.size > 0
        ? db
            .select({ id: agendaItems.id, title: agendaItems.title })
            .from(agendaItems)
            .where(inArray(agendaItems.id, [...ids.agendaItems]))
        : [],
      ids.roles.size > 0
        ? db
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .where(inArray(roles.id, [...ids.roles]))
        : [],
    ]);
  for (const row of impersonationRows) {
    lookups.impersonations.set(row.id, row);
    if (row.adminUserId) ids.users.add(row.adminUserId);
    if (row.targetUserId) ids.users.add(row.targetUserId);
  }
  for (const row of decisionRows) {
    lookups.decisions.set(row.id, { ...row, subjectIds: row.subjectIds ?? [] });
    for (const id of row.subjectIds ?? []) ids.amendments.add(id);
  }
  for (const row of agendaRows) lookups.agendaItems.set(row.id, row.title);
  for (const row of roleRows) lookups.roles.set(row.id, row.name);

  const [amendmentInfo, userRefs] = await Promise.all([
    loadAmendmentInfo([...ids.amendments]),
    loadUserRefs(ids.users),
  ]);
  lookups.amendments = amendmentInfo;
  lookups.users = userRefs;
  for (const amendment of amendmentInfo.values()) {
    ids.documents.add(amendment.documentId);
  }

  lookups.documents = await loadDocumentInfo([...ids.documents]);
  for (const document of lookups.documents.values()) {
    ids.assemblies.add(document.assemblyId);
  }

  const missingDocuments = [...ids.documents].filter(
    (id) => !lookups.documents.has(id),
  );
  const missingAmendments = [...ids.amendments].filter(
    (id) => !lookups.amendments.has(id),
  );
  const [assemblyRows, memberRefs, deleted] = await Promise.all([
    ids.assemblies.size > 0
      ? db
          .select({
            id: assemblies.id,
            number: assemblies.number,
            type: assemblies.type,
            status: assemblies.status,
            settings: assemblies.settings,
          })
          .from(assemblies)
          .where(inArray(assemblies.id, [...ids.assemblies]))
      : [],
    loadMemberRefs(ids.members),
    loadDeletedInfo(missingDocuments, missingAmendments),
  ]);
  for (const row of assemblyRows) lookups.assemblies.set(row.id, row);
  lookups.members = memberRefs;
  lookups.deleted = deleted;
  return lookups;
}

// Items --------------------------------------------------------------------------------

/** What an item is about, as one viewer may see it. */
interface TargetView {
  visible: boolean;
  label: string | null;
  /** The assembly it belongs to, when known. */
  assembly: AssemblyInfo | null;
  document: DocumentInfo | null;
  /** The payload after the viewer's redactions (the allowlist comes later). */
  payload: Record<string, unknown>;
}

function assemblyRef(assembly: AssemblyInfo) {
  return {
    id: assembly.id,
    slug: buildAssemblySlug(assembly),
    label: formatAssemblyLabel(assembly),
  };
}

function documentRef(document: DocumentInfo) {
  return { id: document.id, slug: document.slug, title: document.title };
}

function isDeletedInsider(
  actor: Actor,
  deleted: DeletedInfo | undefined,
  payload: Record<string, unknown>,
): boolean {
  const own = insidersOfPayload(payload);
  const memberIds = [...own.memberIds, ...(deleted?.memberIds ?? [])];
  const userIds = [...own.userIds, ...(deleted?.userIds ?? [])];
  return (
    userIds.includes(actor.user.id) ||
    Boolean(actor.memberId && memberIds.includes(actor.memberId))
  );
}

/** The amendment exists and the actor sees it and its document (as the amendment endpoints do). */
function amendmentVisible(
  actor: Actor,
  lookups: ActivityLookups,
  id: string,
): boolean {
  const amendment = lookups.amendments.get(id);
  const document = amendment
    ? lookups.documents.get(amendment.documentId)
    : undefined;
  return Boolean(
    amendment &&
    document &&
    canSeeDocument(actor, document) &&
    canSeeAmendment(actor, amendment),
  );
}

function decisionDto(decision: DecisionInfo): DecisionDto {
  return {
    id: decision.id,
    kind: decision.kind,
    method: decision.method,
    subjectIds: decision.subjectIds,
    note: null,
    vote: null,
    decidedAt: "",
  };
}

/**
 * A decision as the actor may read it (filterDecisionsByAmendment): an
 * admission decision keeps only the amendments the actor can see and is
 * hidden when it names none; null when hidden.
 */
function visibleDecision(
  actor: Actor,
  lookups: ActivityLookups,
  decision: DecisionInfo,
): DecisionDto | null {
  const [kept] = filterDecisionsByAmendment([decisionDto(decision)], (id) =>
    amendmentVisible(actor, lookups, id),
  );
  return kept ?? null;
}

/** The decision of a decision_recorded row: the stored one, else its payload. */
function decisionOfRow(
  row: RawActivityRow,
  lookups: ActivityLookups,
): DecisionInfo | null {
  const stored = lookups.decisions.get(row.targetId);
  if (stored) return stored;
  const payload = row.payload ?? {};
  const kind = text(payload.kind);
  if (!kind) return null;
  return {
    id: row.targetId,
    kind: kind as DecisionKind,
    method: (text(payload.method) ?? "mesa") as DecisionMethod,
    subjectIds: texts(payload.subjectIds),
  };
}

/**
 * An event's target for `actor` (null: an Admin, who sees everything
 * unredacted). The assembly must be visible first; then documents and
 * amendments follow the history endpoints (canSeeDocument, canSeeAmendment
 * with its document, correction notes, positions), votes follow their
 * subject, decisions filterDecisionsByAmendment, speaking turns the Mesa.
 */
function eventTarget(
  row: RawActivityRow,
  lookups: ActivityLookups,
  actor: Actor | null,
): TargetView {
  const payload = row.payload ?? {};
  const assembly = row.assemblyId
    ? (lookups.assemblies.get(row.assemblyId) ?? null)
    : null;
  const base = { assembly, document: null, label: null, payload };
  if (actor && (!assembly || !canSeeAssembly(actor, assembly))) {
    return { ...base, visible: false };
  }

  switch (row.targetType) {
    case "assembly":
      return {
        ...base,
        visible: true,
        label: assembly ? formatAssemblyLabel(assembly) : null,
      };
    case "agenda_item":
      return {
        ...base,
        visible: true,
        label: lookups.agendaItems.get(row.targetId) ?? text(payload.title),
      };
    case "document": {
      const document = lookups.documents.get(row.targetId) ?? null;
      if (document) {
        if (!actor) {
          return { ...base, visible: true, label: document.title, document };
        }
        // Notes and a draft's field values: presenters and the Secretaría.
        const insider = canSeeDocumentCorrection(actor, document);
        return {
          ...base,
          visible: canSeeDocument(actor, document),
          label: document.title,
          document,
          payload: redactDocumentChanges(
            row.action,
            redactCorrectionNote(row.action, payload, insider),
            insider,
          ),
        };
      }
      const deleted = lookups.deleted.get(`document:${row.targetId}`);
      const label = deleted?.label ?? text(payload.title);
      if (!actor) return { ...base, visible: true, label };
      const visible =
        canManageDocuments(actor) || isDeletedInsider(actor, deleted, payload);
      return {
        ...base,
        visible,
        label,
        payload: redactDocumentChanges(
          row.action,
          redactCorrectionNote(row.action, payload, visible),
          visible,
        ),
      };
    }
    case "amendment": {
      const amendment = lookups.amendments.get(row.targetId);
      const document = amendment
        ? (lookups.documents.get(amendment.documentId) ?? null)
        : null;
      if (amendment && document) {
        const label = amendment.code;
        if (!actor) return { ...base, visible: true, label, document };
        const notes =
          seesAllPresentedAmendments(actor) ||
          isAmendmentInsider(actor, amendment);
        const positions =
          assembly !== null &&
          canSeePositions(actor, {
            settings: assemblySettings(assembly),
            assemblyStatus: assembly.status,
            isPresenter: isDocumentPresenter(actor, document),
          });
        return {
          ...base,
          visible:
            canSeeDocument(actor, document) &&
            canSeeAmendment(actor, amendment),
          label,
          document,
          payload: redactCorrectionNote(
            row.action,
            redactAmendmentEventPayload(row.action, payload, positions),
            notes,
          ),
        };
      }
      const deleted = lookups.deleted.get(`amendment:${row.targetId}`);
      const label = deleted?.label ?? text(payload.code);
      if (!actor) return { ...base, visible: true, label, document };
      const visible =
        canReviewAmendments(actor) || isDeletedInsider(actor, deleted, payload);
      return {
        ...base,
        visible,
        label,
        payload: redactCorrectionNote(
          row.action,
          redactAmendmentEventPayload(row.action, payload, false),
          visible,
        ),
      };
    }
    case "vote": {
      const subjectId = text(payload.subjectId);
      if (payload.subjectType === "document" && subjectId) {
        const document = lookups.documents.get(subjectId) ?? null;
        return {
          ...base,
          visible:
            !actor || (document !== null && canSeeDocument(actor, document)),
          label: document?.title ?? null,
          document,
        };
      }
      if (payload.subjectType === "amendment" && subjectId) {
        const amendment = lookups.amendments.get(subjectId);
        return {
          ...base,
          visible: !actor || amendmentVisible(actor, lookups, subjectId),
          label: amendment?.code ?? null,
          document: amendment
            ? (lookups.documents.get(amendment.documentId) ?? null)
            : null,
        };
      }
      if (payload.subjectType === "decision" && subjectId) {
        const decision = lookups.decisions.get(subjectId);
        return {
          ...base,
          visible:
            !actor ||
            (decision !== undefined &&
              visibleDecision(actor, lookups, decision) !== null),
        };
      }
      return { ...base, visible: true };
    }
    case "decision": {
      const decision = decisionOfRow(row, lookups);
      if (!actor || !decision) return { ...base, visible: true };
      const kept = visibleDecision(actor, lookups, decision);
      return {
        ...base,
        visible: kept !== null,
        payload: kept ? { ...payload, subjectIds: kept.subjectIds } : payload,
      };
    }
    case "speakers":
      // The queue's history is the Mesa's: attendees only see who has the floor.
      return { ...base, visible: !actor || canModerate(actor) };
    default:
      // live and any new entity: the assembly's.
      return { ...base, visible: true };
  }
}

/** The label a deleted assembly's audit summary keeps ("80.ª AGO"). */
function deletedAssemblyLabel(payload: Record<string, unknown>): string | null {
  const before = record(payload.before);
  const number = before?.number;
  const type = text(before?.type);
  return typeof number === "number" && type
    ? formatAssemblyLabel({ number, type })
    : null;
}

/**
 * An audit row's target for `actor` (null: an Admin). Accounts other than
 * the actor's own need user:manage_roles now; roles need a key that reads
 * them, unless the row is about a role the account held (tab `to`);
 * members are public; assemblies and documents follow their visibility;
 * deleted ones their managers. A row in an assembly the actor cannot see
 * is hidden.
 */
function auditTarget(
  row: RawActivityRow,
  lookups: ActivityLookups,
  actor: Actor | null,
): TargetView {
  const payload = row.payload ?? {};
  let assembly = row.assemblyId
    ? (lookups.assemblies.get(row.assemblyId) ?? null)
    : null;
  let document: DocumentInfo | null = null;
  let label: string | null = null;
  let visible: boolean;

  switch (row.targetType) {
    case "user":
      label = lookups.users.get(row.targetId)?.name ?? null;
      visible =
        !actor ||
        row.targetId === actor.user.id ||
        actor.can(PERMISSION_KEYS.USER_MANAGE_ROLES);
      break;
    case "role":
      label = lookups.roles.get(row.targetId) ?? null;
      visible =
        !actor ||
        row.approximate !== null ||
        actor.can(PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS) ||
        actor.can(PERMISSION_KEYS.USER_MANAGE_ROLES);
      break;
    case "member": {
      const sides = [record(payload.after), record(payload.before)];
      label =
        lookups.members.get(row.targetId)?.acronym ??
        sides.map((side) => text(side?.acronym)).find(Boolean) ??
        null;
      visible = true;
      break;
    }
    case "members":
      visible = true;
      break;
    case "assembly": {
      const target = lookups.assemblies.get(row.targetId) ?? null;
      if (target) {
        assembly = target;
        label = formatAssemblyLabel(target);
        visible = !actor || canSeeAssembly(actor, target);
      } else {
        label = deletedAssemblyLabel(payload);
        visible = !actor || canManageAssemblies(actor);
      }
      break;
    }
    case "document": {
      document = lookups.documents.get(row.targetId) ?? null;
      if (document) {
        assembly = lookups.assemblies.get(document.assemblyId) ?? assembly;
        label = document.title;
        visible = !actor || canSeeDocument(actor, document);
      } else {
        visible = !actor || canManageDocuments(actor);
      }
      break;
    }
    default:
      // impersonation (the account is gone) and anything new: Admins only.
      visible = !actor || actor.isAdmin;
  }
  if (actor && assembly && !canSeeAssembly(actor, assembly)) visible = false;
  return { visible, label, assembly, document, payload };
}

function windowTarget(
  row: RawActivityRow,
  lookups: ActivityLookups,
): TargetView {
  return {
    visible: true,
    label:
      row.targetType === "user"
        ? (lookups.users.get(row.targetId)?.name ?? null)
        : null,
    assembly: null,
    document: null,
    payload: {},
  };
}

function targetView(
  row: RawActivityRow,
  lookups: ActivityLookups,
  actor: Actor | null,
): TargetView {
  if (row.kind === "event") return eventTarget(row, lookups, actor);
  if (row.kind === "audit") return auditTarget(row, lookups, actor);
  return windowTarget(row, lookups);
}

function actorOf(
  row: RawActivityRow,
  lookups: ActivityLookups,
): ActivityActorDto | null {
  const user = row.actorUserId ? lookups.users.get(row.actorUserId) : undefined;
  if (!user) return null;
  const member =
    row.kind === "event" && row.actorMemberId
      ? (lookups.members.get(row.actorMemberId) ?? null)
      : null;
  return { ...user, member };
}

/** The real Admin behind a row done while acting as its actor; null otherwise. */
function impersonatorOf(
  row: RawActivityRow,
  lookups: ActivityLookups,
): UserRef | null {
  const impersonation = row.impersonationId
    ? lookups.impersonations.get(row.impersonationId)
    : undefined;
  // The impersonation's own rows (start, stop, the window) are the Admin's.
  if (
    !impersonation?.adminUserId ||
    impersonation.adminUserId === row.actorUserId
  ) {
    return null;
  }
  return lookups.users.get(impersonation.adminUserId) ?? null;
}

function windowOf(
  row: RawActivityRow,
  lookups: ActivityLookups,
  now: Date,
): ImpersonationDto | null {
  if (row.kind !== "impersonation") return null;
  const impersonation = lookups.impersonations.get(row.id);
  if (!impersonation) return null;
  const ref = (id: string | null) =>
    id ? (lookups.users.get(id) ?? null) : null;
  return toImpersonationDto(
    impersonation,
    {
      admin: ref(impersonation.adminUserId),
      target: ref(impersonation.targetUserId),
    },
    now,
  );
}

/**
 * One row of "Mi actividad" for `actor` (PRIVACY RULES, see the module
 * comment), or null when it is left out: others' acts on something the
 * actor cannot see (tab `member`).
 */
export function toMeActivityItem(
  actor: Actor,
  tab: MeActivityTab,
  row: RawActivityRow,
  lookups: ActivityLookups,
  now: Date = new Date(),
): ActivityItemDto | null {
  const me = actor.user.id;
  const view = targetView(row, lookups, actor);
  if (!view.visible && tab === "member") return null;

  // Who was really behind it: only for the account acted as and Admins.
  const seesImpersonation = row.actorUserId === me || actor.isAdmin;
  // IP and user agent: only the account's own accesses.
  const ownAccess =
    (row.kind === "audit" &&
      row.targetType === "user" &&
      row.targetId === me &&
      (ME_ACCESS_ACTIONS as readonly string[]).includes(row.action)) ||
    (row.kind === "impersonation" &&
      lookups.impersonations.get(row.id)?.adminUserId === me);
  const assembly =
    view.assembly && canSeeAssembly(actor, view.assembly)
      ? assemblyRef(view.assembly)
      : null;

  return {
    id: row.id,
    kind: row.kind,
    at: row.at,
    action: row.action,
    category: activityCategory(row.kind, row.action),
    source: row.source,
    actor: actorOf(row, lookups),
    impersonatedBy: seesImpersonation ? impersonatorOf(row, lookups) : null,
    impersonationId: seesImpersonation ? row.impersonationId : null,
    target: {
      type: row.targetType,
      id: row.targetId,
      label: view.visible ? view.label : null,
      assembly,
      document:
        view.visible && view.document ? documentRef(view.document) : null,
      available: view.visible,
    },
    payload: view.visible
      ? allowActivityPayload(
          row.kind,
          row.action,
          view.payload,
          lookups.members,
        )
      : {},
    impersonation: windowOf(row, lookups, now),
    access:
      tab === "access" && ownAccess
        ? { ipAddress: row.ipAddress, userAgent: row.userAgent }
        : null,
    approximate: row.approximate === true,
  };
}

/**
 * One row of the Admin log: unredacted, with the IP and user agent of audit
 * rows and windows. Every row is `available`; a deleted target keeps the
 * label its events recorded (title or code) and has no document link.
 */
export function toAdminActivityItem(
  row: RawActivityRow,
  lookups: ActivityLookups,
  now: Date = new Date(),
): ActivityItemDto {
  const view = targetView(row, lookups, null);
  return {
    id: row.id,
    kind: row.kind,
    at: row.at,
    action: row.action,
    category: activityCategory(row.kind, row.action),
    source: row.source,
    actor: actorOf(row, lookups),
    impersonatedBy: impersonatorOf(row, lookups),
    impersonationId: row.impersonationId,
    target: {
      type: row.targetType,
      id: row.targetId,
      label: view.label,
      assembly: view.assembly ? assemblyRef(view.assembly) : null,
      document: view.document ? documentRef(view.document) : null,
      available: true,
    },
    payload:
      row.kind === "audit"
        ? adminAuditPayload(row.payload, lookups.members)
        : row.kind === "event"
          ? (row.payload ?? {})
          : {},
    impersonation: windowOf(row, lookups, now),
    access:
      row.kind === "event"
        ? null
        : { ipAddress: row.ipAddress, userAgent: row.userAgent },
    approximate: row.approximate === true,
  };
}

// Endpoints ------------------------------------------------------------------------------

/** Impersonations of the account listed in the notice of "Mi actividad". */
export const RECENT_IMPERSONATIONS_LIMIT = 20;

async function loadRecentImpersonations(
  userId: string,
  now: Date,
): Promise<ImpersonationDto[]> {
  const rows = await db
    .select(impersonationInfoColumns)
    .from(impersonations)
    .where(
      and(
        eq(impersonations.targetUserId, userId),
        sql`${impersonations.startedAt} >= now() - make_interval(days => ${IMPERSONATION_NOTICE_DAYS}::int)`,
      ),
    )
    .orderBy(desc(impersonations.startedAt), desc(impersonations.id))
    .limit(RECENT_IMPERSONATIONS_LIMIT);
  if (rows.length === 0) return [];
  const people = await loadUserRefs([
    userId,
    ...rows.flatMap((row) => (row.adminUserId ? [row.adminUserId] : [])),
  ]);
  const ref = (id: string | null) => (id ? (people.get(id) ?? null) : null);
  return rows.map((row) =>
    toImpersonationDto(
      row,
      { admin: ref(row.adminUserId), target: ref(row.targetUserId) },
      now,
    ),
  );
}

/**
 * GET /api/me/activity: a page of the actor's tab (meActivityBranches),
 * each row judged again for the actor (toMeActivityItem), plus the
 * impersonations of the account in the last IMPERSONATION_NOTICE_DAYS days.
 * While an Admin acts as an account, this is that account's activity.
 */
export async function loadMeActivity(
  actor: Actor,
  query: MeActivityQuery,
): Promise<MeActivityPageDto> {
  const now = new Date();
  const assemblyId = query.assembly
    ? (await resolveAssembly(actor, query.assembly)).id
    : undefined;
  const tenure = query.tab === "to" ? await loadRoleTenure(actor.user.id) : [];
  const branches = meActivityBranches({
    tab: query.tab,
    userId: actor.user.id,
    memberId: actor.memberId,
    tenure,
    filters: {
      assemblyId,
      categories: query.category,
      from: query.from,
      to: query.to,
    },
  });

  const [page, recentImpersonations] = await Promise.all([
    collectActivityPage({
      cursor: query.cursor,
      limit: query.limit,
      fetch: (cursor, size) => fetchActivityRows(branches, cursor, size),
      build: async (rows) => {
        const lookups = await loadActivityLookups(rows);
        return rows.map((row) =>
          toMeActivityItem(actor, query.tab, row, lookups, now),
        );
      },
    }),
    loadRecentImpersonations(actor.user.id, now),
  ]);
  return { ...page, recentImpersonations };
}

const CUID_PATTERN = /^[a-z0-9]{20,32}$/;

/**
 * The Admin's `assembly` filter: a slug ("80-ago") or an id. An id is
 * kept even when the assembly no longer exists, so the audit rows of a
 * deleted draft can still be found.
 */
async function resolveAdminAssemblyId(param: string): Promise<string> {
  const parsed = parseAssemblySlug(param);
  if (parsed) {
    const [row] = await db
      .select({ id: assemblies.id })
      .from(assemblies)
      .where(
        and(
          eq(assemblies.type, parsed.type),
          eq(assemblies.number, parsed.number),
        ),
      )
      .limit(1);
    if (row) return row.id;
  } else if (CUID_PATTERN.test(param)) {
    return param;
  }
  throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
}

/** Most accounts a `q` search matches before the log is filtered by them. */
export const ACTIVITY_SEARCH_MAX_USERS = 500;

/** `q` as an ILIKE pattern: its own %, _ and \ match literally. */
export function containsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

async function findUsersMatching(query: string): Promise<string[]> {
  const pattern = containsPattern(query);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        sql`${users.name} ilike ${pattern}`,
        sql`${users.externalName} ilike ${pattern}`,
        sql`${users.email} ilike ${pattern}`,
      ),
    )
    .limit(ACTIVITY_SEARCH_MAX_USERS);
  return rows.map((row) => row.id);
}

/** GET /api/admin/activity (Admin only): the whole log, unredacted. */
export async function loadAdminActivity(
  query: AdminActivityQuery,
): Promise<ActivityPageDto> {
  const now = new Date();
  const [assemblyId, matchingUserIds] = await Promise.all([
    query.assembly ? resolveAdminAssemblyId(query.assembly) : undefined,
    query.q ? findUsersMatching(query.q) : undefined,
  ]);
  const branches = adminActivityBranches({
    actor: query.actor,
    target: query.target,
    user: query.user,
    member: query.member,
    assemblyId,
    actions: query.action,
    categories: query.category,
    kinds: query.kind,
    sources: query.source,
    impersonated: query.impersonated,
    impersonation: query.impersonation,
    from: query.from,
    to: query.to,
    matchingUserIds,
  });
  return collectActivityPage({
    cursor: query.cursor,
    limit: query.limit,
    maxPasses: 1,
    fetch: (cursor, size) => fetchActivityRows(branches, cursor, size),
    build: async (rows) => {
      const lookups = await loadActivityLookups(rows);
      return rows.map((row) => toAdminActivityItem(row, lookups, now));
    },
  });
}

/**
 * GET /api/admin/impersonations (Admin only): newest first, keyset on
 * (started_at, id). Expired rows still open are closed first (a sweep with
 * no request, so the system rows carry no IP), so `endedAt`/`endReason`
 * are current. `actionCount` counts the events and audit rows recorded
 * under each one, without its own impersonation.* rows (as
 * AdminImpersonationDto says; the optional impersonation.request safety
 * net is left out too).
 */
export async function loadAdminImpersonations(
  query: AdminImpersonationQuery,
): Promise<AdminImpersonationPageDto> {
  const now = new Date();
  try {
    await endImpersonations(db, { expired: true }, "expired");
  } catch (error) {
    logError("activity.impersonationSweep", error);
  }

  const rows = await db
    .select({
      ...impersonationInfoColumns,
      at: atText(impersonations.startedAt),
    })
    .from(impersonations)
    .where(
      and(
        query.admin ? eq(impersonations.adminUserId, query.admin) : undefined,
        query.target
          ? eq(impersonations.targetUserId, query.target)
          : undefined,
        query.active === undefined
          ? undefined
          : query.active
            ? and(
                isNull(impersonations.endedAt),
                sql`${impersonations.expiresAt} > now()`,
              )
            : or(
                isNotNull(impersonations.endedAt),
                sql`${impersonations.expiresAt} <= now()`,
              ),
        keysetBefore(impersonations.startedAt, impersonations.id, query.cursor),
      ),
    )
    .orderBy(desc(impersonations.startedAt), desc(impersonations.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = rows.length > query.limit ? page[page.length - 1] : undefined;
  const nextCursor = last
    ? encodeActivityCursor({ at: last.at, id: last.id })
    : null;
  if (page.length === 0) return { items: [], nextCursor };

  const ids = page.map((row) => row.id);
  const userIds = [
    ...new Set(
      page.flatMap((row) =>
        [row.adminUserId, row.targetUserId].filter(
          (id): id is string => id !== null,
        ),
      ),
    ),
  ];
  const [people, eventCounts, auditCounts] = await Promise.all([
    userIds.length > 0
      ? db
          .select({
            id: users.id,
            name: userName,
            role: roles.name,
            memberId: members.id,
            memberAcronym: members.acronym,
            memberName: members.name,
            memberKind: members.kind,
          })
          .from(users)
          .leftJoin(roles, eq(roles.id, users.roleId))
          .leftJoin(members, eq(members.id, users.memberId))
          .where(inArray(users.id, userIds))
      : [],
    db
      .select({ id: events.impersonationId, total: count() })
      .from(events)
      .where(inArray(events.impersonationId, ids))
      .groupBy(events.impersonationId),
    db
      .select({ id: auditLog.impersonationId, total: count() })
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.impersonationId, ids),
          notLike(auditLog.action, "impersonation.%"),
        ),
      )
      .groupBy(auditLog.impersonationId),
  ]);

  const byId = new Map(people.map((person) => [person.id, person]));
  const counts = new Map<string, number>();
  for (const row of [...eventCounts, ...auditCounts]) {
    if (row.id)
      counts.set(row.id, (counts.get(row.id) ?? 0) + Number(row.total));
  }
  const ref = (id: string | null): UserRef | null => {
    const person = id ? byId.get(id) : undefined;
    return person ? { id: person.id, name: person.name } : null;
  };

  const items: AdminImpersonationDto[] = page.map((row) => {
    const target = row.targetUserId ? byId.get(row.targetUserId) : undefined;
    const base = toImpersonationDto(
      row,
      { admin: ref(row.adminUserId), target: ref(row.targetUserId) },
      now,
    );
    return {
      ...base,
      target: target
        ? {
            id: target.id,
            name: target.name,
            role: target.role ?? null,
            member:
              target.memberId &&
              target.memberAcronym &&
              target.memberName &&
              target.memberKind
                ? {
                    id: target.memberId,
                    acronym: target.memberAcronym,
                    name: target.memberName,
                    kind: target.memberKind,
                  }
                : null,
          }
        : null,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      actionCount: counts.get(row.id) ?? 0,
    };
  });
  return { items, nextCursor };
}
