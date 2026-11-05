import { MILESTONE_KEYS } from "./domain";

/**
 * Catalogs of the traceability layer: audit actions, event types, sources,
 * activity categories and impersonation end reasons. Shared by the writers
 * (server/utils/domain/audit.ts, recordEvent), the activity read API and the
 * pages, so every action has one name and one i18n key
 * (`activity.actions.<action>`, `activity.categories.<category>`...).
 */

/**
 * Where an audit row comes from (audit_log.source):
 * - `user`: a request by a signed-in account (the default);
 * - `intranet`: role sync, member links and roster sync driven by the intranet;
 * - `auth`: better-auth sign-in, sign-out and account creation;
 * - `seed`: `pnpm db:seed`;
 * - `system`: the platform itself (an impersonation that expired or was revoked);
 * - `import`: bulk imports that go through the domain functions.
 */
export const AUDIT_SOURCES = [
  "user",
  "intranet",
  "auth",
  "seed",
  "system",
  "import",
] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

/**
 * Every audit_log action. Write them only through recordAudit
 * (server/utils/domain/audit.ts). The comment says who writes it, what the
 * target is and what `before`/`after` hold.
 */
export const AUDIT_ACTIONS = {
  // Admin section ---------------------------------------------------------
  /** PUT /api/admin/users/[id]/role. Target user; before/after {roleId, roleName}. */
  ROLE_ASSIGN: "role.assign",
  /** PUT /api/admin/users/[id]/permissions. Target user; before/after {permissions}. */
  USER_PERMISSIONS_SET: "user.permissions_set",
  /**
   * The account's member link: PUT /api/admin/users/[id]/member (source
   * user) or the automatic link after role sync (source intranet,
   * after.reason "role_sync"). Target user; before/after {memberId}.
   */
  USER_MEMBER_LINK: "user.member_link",
  /** PUT /api/admin/roles/[id]/permissions. Target role; before/after {permissions}. */
  PERMISSIONS_SET: "permissions.set",

  // Members ---------------------------------------------------------------
  /**
   * POST /api/members (source user), or a member created by the sign-in
   * link (source intranet, after.reason "sign_in_link"). Target member;
   * after = MemberDto-like.
   */
  MEMBER_CREATE: "member.create",
  /** PUT /api/members/[id]. Target member; before/after MemberDto-like. */
  MEMBER_UPDATE: "member.update",
  /** POST /api/members/sync summary. Target members/"intranet"; after {created, updated, deactivated, unchanged, manualConflicts, batchId}. */
  MEMBERS_SYNC: "members.sync",
  /** One per member the roster sync created. Target member; after {..., batchId}. */
  MEMBER_SYNC_CREATE: "member.sync_create",
  /** One per member the roster sync changed. Target member; before/after, after.batchId. */
  MEMBER_SYNC_UPDATE: "member.sync_update",
  /** One per member the roster sync deactivated. Target member; after {active: false, batchId}. */
  MEMBER_SYNC_DEACTIVATE: "member.sync_deactivate",

  // Assemblies and documents ---------------------------------------------
  /** DELETE /api/assemblies/[assembly] (draft). Target assembly; before = summary. */
  ASSEMBLY_DELETE: "assembly.delete",
  /**
   * An offline import script loaded an assembly (agenda, documents, events)
   * from outside the platform. Target assembly; assemblyId set; source
   * import; after = a summary of what was loaded (counts, origin, ids).
   */
  ASSEMBLY_IMPORT: "assembly.import",
  /** POST .../documents/[document]/import (DOCX to blocks, no state). Target document; after {fileName, blockCount}. */
  DOCUMENT_IMPORT: "document.import",

  // Account and sign-in ---------------------------------------------------
  /** First Google sign-in created the account (better-auth user.create.after). Target user; source auth. */
  USER_CREATED: "user.created",
  /**
   * Intranet role sync changed something other than lastRoleSyncAt. Target
   * user; source intranet; before/after {roleName, externalRole,
   * externalName, externalInitials, university, memberId}.
   */
  USER_ROLE_SYNC: "user.role_sync",
  /** INITIAL_ADMIN_EMAIL received Admin on sign-in. Target user; source intranet. */
  USER_INITIAL_ADMIN: "user.initial_admin",
  /**
   * A sign-in (better-auth session.create.after). Target user; source auth;
   * after {sessionId, roleSync: "ok" | "failed" | "unconfigured"}; the row's
   * ip_address and user_agent hold the access.
   */
  AUTH_SIGN_IN: "auth.sign_in",
  /** The user signed out (session.delete.after with a request). Target user; source auth; after {sessionId}. */
  AUTH_SIGN_OUT: "auth.sign_out",
  /** A session ended without a request (expiry or revocation). Target user; source auth; after {sessionId}. */
  AUTH_SESSION_ENDED: "auth.session_ended",

  // Exports ---------------------------------------------------------------
  /** POST .../export. Target document or assembly; assemblyId set; after {jobId, variant, locale, documentId}. */
  EXPORT_REQUEST: "export.request",
  /** GET /api/exports/[jobId]/download. Target document or assembly; after {jobId}. */
  EXPORT_DOWNLOAD: "export.download",

  // Roles seed ------------------------------------------------------------
  /** `pnpm db:seed` added grants. Target role; source seed; after {added: keys}. */
  RBAC_SEED: "rbac.seed",

  // Impersonation ---------------------------------------------------------
  /** An Admin started acting as an account. Actor the Admin; target the user; after {reason, expiresAt}. */
  IMPERSONATION_START: "impersonation.start",
  /** The Admin went back to their account, or signed out (after.endReason). */
  IMPERSONATION_STOP: "impersonation.stop",
  /** The time limit passed (closed lazily). Source system. */
  IMPERSONATION_EXPIRE: "impersonation.expire",
  /** It stopped applying: the Admin lost the role, the target became Admin or was deleted. Source system. */
  IMPERSONATION_REVOKE: "impersonation.revoke",
  /**
   * Optional safety net: an unsafe request made while impersonating, by a
   * mutation that writes no event or audit row of its own. Target the
   * effective user; after {method, path, status}.
   */
  IMPERSONATION_REQUEST: "impersonation.request",
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
export const AUDIT_ACTION_VALUES: readonly AuditAction[] =
  Object.values(AUDIT_ACTIONS);

/** What an audit row is about (audit_log.target_type). */
export const AUDIT_TARGET_TYPES = [
  "user",
  "role",
  "member",
  /** The whole roster (members.sync), targetId "intranet". */
  "members",
  "assembly",
  "document",
  "impersonation",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * Every events.type that recordEvent writes today. Add new types here so
 * the activity pages get an i18n key (`activity.actions.<type>`).
 */
export const EVENT_TYPES = [
  // Assembly, calendar
  "assembly_created",
  "assembly_updated",
  "assembly_status_changed",
  "assembly_deleted",
  "calendar_updated",
  "agenda_finalized",
  "agenda_reopened",
  // Agenda items
  "agenda_item_created",
  "agenda_item_updated",
  "agenda_item_deleted",
  "agenda_reordered",
  // Live session, speakers, votes and decisions
  "live_changed",
  "speakers_visibility_changed",
  "speaking_turn_added",
  "speaking_turn_started",
  "speaking_turn_finished",
  "speaking_turn_cancelled",
  "speaking_turn_restored",
  "speaking_turn_moved",
  "speaking_turn_updated",
  "vote_recorded",
  "decision_recorded",
  // Documents
  "document_created",
  "document_updated",
  "document_status_changed",
  "document_content_updated",
  "document_file_uploaded",
  "document_submitted",
  "document_correction_requested",
  "document_published",
  "document_deleted",
  "document_voted",
  "final_vote_annulled",
  // Amendments
  "amendment_created",
  "amendment_updated",
  "amendment_deleted",
  "amendment_submitted",
  "amendment_withdrawn",
  "amendment_correction_requested",
  "amendment_validated",
  "amendment_published",
  "amendment_admitted",
  "amendment_inadmissible",
  "amendment_approved",
  "amendment_rejected",
  "amendment_reopened",
  "amendment_transacted",
  "amendment_lapsed",
  "position_changed",
  "acceptance_recorded",
  "relation_created",
  "relation_deleted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Why an impersonation ended (impersonations.end_reason). */
export const IMPERSONATION_END_REASONS = [
  /** The Admin chose "Volver a mi cuenta". */
  "stopped",
  /** IMPERSONATION_TTL_MINUTES passed (or the Admin's session expired). */
  "expired",
  /** The Admin signed out. */
  "signed_out",
  /** It stopped applying: the Admin lost the role, the target became Admin or was deleted. */
  "revoked",
] as const;
export type ImpersonationEndReason = (typeof IMPERSONATION_END_REASONS)[number];

/** The audit action that records each end reason. */
export function impersonationEndAction(
  reason: ImpersonationEndReason,
): AuditAction {
  switch (reason) {
    case "expired":
      return AUDIT_ACTIONS.IMPERSONATION_EXPIRE;
    case "revoked":
      return AUDIT_ACTIONS.IMPERSONATION_REVOKE;
    default:
      return AUDIT_ACTIONS.IMPERSONATION_STOP;
  }
}

/** The audit source of each end reason: the Admin, the auth layer or the platform. */
export function impersonationEndSource(
  reason: ImpersonationEndReason,
): AuditSource {
  switch (reason) {
    case "stopped":
      return "user";
    case "signed_out":
      return "auth";
    default:
      return "system";
  }
}

/**
 * Which table an activity item comes from: `event` (the domain history,
 * events), `audit` (audit_log) or `impersonation` (one impersonations row,
 * shown as a session window).
 */
export const ACTIVITY_KINDS = ["event", "audit", "impersonation"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The `action` of an item of kind `impersonation` (the whole session window). */
export const IMPERSONATION_SESSION_ACTION = "impersonation.session";

/** Groups for filters, icons and i18n (`activity.categories.<category>`). */
export const ACTIVITY_CATEGORIES = [
  "assembly",
  "agenda",
  "document",
  "amendment",
  "session",
  "account",
  "access",
  "member",
  "roles",
  "export",
  "other",
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

const EVENT_CATEGORIES: Record<EventType, ActivityCategory> = {
  assembly_created: "assembly",
  assembly_updated: "assembly",
  assembly_status_changed: "assembly",
  assembly_deleted: "assembly",
  calendar_updated: "assembly",
  agenda_finalized: "assembly",
  agenda_reopened: "assembly",
  agenda_item_created: "agenda",
  agenda_item_updated: "agenda",
  agenda_item_deleted: "agenda",
  agenda_reordered: "agenda",
  live_changed: "session",
  speakers_visibility_changed: "session",
  speaking_turn_added: "session",
  speaking_turn_started: "session",
  speaking_turn_finished: "session",
  speaking_turn_cancelled: "session",
  speaking_turn_restored: "session",
  speaking_turn_moved: "session",
  speaking_turn_updated: "session",
  vote_recorded: "session",
  decision_recorded: "session",
  document_created: "document",
  document_updated: "document",
  document_status_changed: "document",
  document_content_updated: "document",
  document_file_uploaded: "document",
  document_submitted: "document",
  document_correction_requested: "document",
  document_published: "document",
  document_deleted: "document",
  document_voted: "document",
  final_vote_annulled: "document",
  amendment_created: "amendment",
  amendment_updated: "amendment",
  amendment_deleted: "amendment",
  amendment_submitted: "amendment",
  amendment_withdrawn: "amendment",
  amendment_correction_requested: "amendment",
  amendment_validated: "amendment",
  amendment_published: "amendment",
  amendment_admitted: "amendment",
  amendment_inadmissible: "amendment",
  amendment_approved: "amendment",
  amendment_rejected: "amendment",
  amendment_reopened: "amendment",
  amendment_transacted: "amendment",
  amendment_lapsed: "amendment",
  position_changed: "amendment",
  acceptance_recorded: "amendment",
  relation_created: "amendment",
  relation_deleted: "amendment",
};

const AUDIT_CATEGORIES: Record<AuditAction, ActivityCategory> = {
  "role.assign": "account",
  "user.permissions_set": "account",
  "user.member_link": "account",
  "permissions.set": "roles",
  "member.create": "member",
  "member.update": "member",
  "members.sync": "member",
  "member.sync_create": "member",
  "member.sync_update": "member",
  "member.sync_deactivate": "member",
  "assembly.delete": "assembly",
  "assembly.import": "assembly",
  "document.import": "document",
  "user.created": "account",
  "user.role_sync": "account",
  "user.initial_admin": "account",
  "auth.sign_in": "access",
  "auth.sign_out": "access",
  "auth.session_ended": "access",
  "export.request": "export",
  "export.download": "export",
  "rbac.seed": "roles",
  "impersonation.start": "access",
  "impersonation.stop": "access",
  "impersonation.expire": "access",
  "impersonation.revoke": "access",
  "impersonation.request": "access",
};

/** The event types and audit actions of each category, for SQL filters. */
export function actionsOfCategory(category: ActivityCategory): {
  eventTypes: EventType[];
  auditActions: AuditAction[];
} {
  return {
    eventTypes: EVENT_TYPES.filter(
      (type) => EVENT_CATEGORIES[type] === category,
    ),
    auditActions: AUDIT_ACTION_VALUES.filter(
      (action) => AUDIT_CATEGORIES[action] === category,
    ),
  };
}

/** The category of an activity item; `other` for an action not in the catalogs. */
export function activityCategory(
  kind: ActivityKind,
  action: string,
): ActivityCategory {
  if (kind === "impersonation") return "access";
  const categories: Record<string, ActivityCategory> =
    kind === "event" ? EVENT_CATEGORIES : AUDIT_CATEGORIES;
  // Own keys only: "constructor" and friends are not actions.
  return Object.hasOwn(categories, action)
    ? (categories[action] ?? "other")
    : "other";
}

// Field changes ---------------------------------------------------------------

/**
 * What an edit event says it changed (`payload.changes`, written with
 * diffChanges: `{ field: { from, to } }`) is shown field by field, and only
 * for the fields listed here:
 * - `values`: the field with its old and new value (titles, dates, flags,
 *   kinds, settings);
 * - `changed`: only that it changed, never the values (ids of members and
 *   agenda items, long formatted texts).
 * Anything else in `changes` never reaches a non-Admin. The events these
 * entities come from are in CHANGE_EVENT_ENTITIES.
 */
export type ChangeExposure = "values" | "changed";
export const CHANGE_ENTITIES = [
  "assembly",
  "calendar",
  "agenda_item",
  "document",
] as const;
export type ChangeEntity = (typeof CHANGE_ENTITIES)[number];

/** The edit events whose `payload.changes` is shown, and what they edit. */
export const CHANGE_EVENT_ENTITIES = {
  assembly_updated: "assembly",
  calendar_updated: "calendar",
  agenda_item_updated: "agenda_item",
  document_updated: "document",
} as const satisfies Partial<Record<EventType, ChangeEntity>>;

export const CHANGE_FIELDS: Record<
  ChangeEntity,
  Readonly<Record<string, ChangeExposure>>
> = {
  assembly: {
    number: "values",
    type: "values",
    startDate: "values",
    endDate: "values",
    location: "values",
    convocationIntro: "changed",
    "settings.positionVisibility": "values",
    "settings.tieRule": "values",
    "settings.denominator": "values",
  },
  // A milestone's date ("convocation") and its note ("convocation.note").
  calendar: Object.fromEntries(
    MILESTONE_KEYS.flatMap((key) => [
      [key, "values"],
      [`${key}.note`, "values"],
    ]),
  ) as Record<string, ChangeExposure>,
  agenda_item: {
    title: "values",
    description: "values",
    acceptsSubmissions: "values",
    parentId: "changed",
  },
  document: {
    title: "values",
    summary: "values",
    kind: "values",
    amendable: "values",
    voted: "values",
    majority: "values",
    acceptedAmendments: "values",
    amendmentsOpenAt: "values",
    amendmentsCloseAt: "values",
    agendaItemId: "changed",
    // Presenters see it too (their home page); document_updated values
    // only reach presenters and the Secretaría (redactDocumentChanges).
    dueAt: "values",
    proponentMemberId: "changed",
    coProponentMemberIds: "changed",
  },
};

/** The entity an edit event's `changes` are about, or null when none is shown. */
export function changeEntityOf(action: string): ChangeEntity | null {
  return Object.hasOwn(CHANGE_EVENT_ENTITIES, action)
    ? CHANGE_EVENT_ENTITIES[action as keyof typeof CHANGE_EVENT_ENTITIES]
    : null;
}

/** How a changed field is shown (CHANGE_FIELDS), or null when it is not. */
export function changeFieldExposure(
  entity: ChangeEntity,
  field: string,
): ChangeExposure | null {
  const fields = CHANGE_FIELDS[entity];
  return Object.hasOwn(fields, field) ? (fields[field] ?? null) : null;
}

/**
 * Tabs of GET /api/me/activity:
 * - `by`: what the account did (events and audit rows it is the actor of,
 *   including what an Admin did while acting as it);
 * - `to`: what was done to the account (role, grants, member link, role
 *   sync, creation, its role's permissions, impersonations of it);
 * - `access`: its sign-ins and sign-outs (with its own IP and user agent)
 *   and the impersonation sessions on it;
 * - `member`: what other accounts did for the same member (only when linked).
 */
export const ME_ACTIVITY_TABS = ["by", "to", "access", "member"] as const;
export type MeActivityTab = (typeof ME_ACTIVITY_TABS)[number];

/** Default page size of the activity lists. */
export const ACTIVITY_PAGE_DEFAULT_LIMIT = 50;
/** Largest page of GET /api/me/activity. */
export const ME_ACTIVITY_MAX_LIMIT = 100;
/** Largest page of GET /api/admin/activity and GET /api/admin/impersonations. */
export const ADMIN_ACTIVITY_MAX_LIMIT = 200;
/** "Mi actividad" warns when an Admin acted as the account within this many days. */
export const IMPERSONATION_NOTICE_DAYS = 30;
/** Length of the reason an Admin gives to start an impersonation. */
export const IMPERSONATION_REASON_MAX_LENGTH = 200;
