import {
  ACCEPTANCE_DECISIONS,
  ASSEMBLY_STATUSES,
  DOCUMENT_STATUSES,
  PROPONENT_POSITIONS,
  VOTE_RESULTS,
} from "~~/shared/constants/domain";
import {
  AUDIT_ACTION_VALUES,
  EVENT_TYPES,
  IMPERSONATION_END_REASONS,
  IMPERSONATION_SESSION_ACTION,
  changeEntityOf,
  changeFieldExposure,
  type ActivityCategory,
  type AuditAction,
  type ChangeEntity,
  type EventType,
  type ImpersonationEndReason,
} from "~~/shared/constants/activity";
import { RECLASSIFIABLE_KINDS } from "~~/shared/utils/amendmentReclassify";
import type {
  ActivityItemDto,
  ActivityTargetDto,
  ImpersonationDto,
} from "~~/shared/types/api";

/**
 * How the activity pages present an item, kept free of Vue and i18n so it
 * can be tested: its key, its icon, where it links to and which details of
 * its payload are worth a sentence. The components turn these into text.
 *
 * Only the payload fields named here are read; anything else in a payload
 * is ignored, so an unexpected field never reaches the screen.
 */

// Keys ------------------------------------------------------------------------

/** Unique across the three tables an activity list merges. */
export function activityItemKey(item: Pick<ActivityItemDto, "kind" | "id">) {
  return `${item.kind}:${item.id}`;
}

/** `list` followed by the items of `incoming` it does not have yet. */
export function mergeUniqueBy<T>(
  list: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set(list.map(keyOf));
  const merged = [...list];
  for (const item of incoming) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// Actions ---------------------------------------------------------------------

export type ActivityAction =
  EventType | AuditAction | typeof IMPERSONATION_SESSION_ACTION;

/** Every action an item may carry, each with its `activity.actions.*` sentence. */
export const ACTIVITY_ACTIONS: readonly ActivityAction[] = [
  ...EVENT_TYPES,
  ...AUDIT_ACTION_VALUES,
  IMPERSONATION_SESSION_ACTION,
];

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(ACTIVITY_ACTIONS);

export function isActivityAction(action: string): action is ActivityAction {
  return KNOWN_ACTIONS.has(action);
}

/**
 * The i18n key of an action's sentence. Actions outside the catalogs get
 * the general one (`activity.actions.other`); their code is shown to
 * Admins only.
 */
export function activityActionKey(action: string): string {
  return isActivityAction(action)
    ? `activity.actions.${action}`
    : "activity.actions.other";
}

/** One icon per action, so the timeline reads at a glance. */
export const ACTIVITY_ACTION_ICONS = {
  assembly_created: "i-lucide-landmark",
  assembly_updated: "i-lucide-pencil",
  assembly_status_changed: "i-lucide-flag",
  assembly_deleted: "i-lucide-trash-2",
  calendar_updated: "i-lucide-calendar-days",
  agenda_finalized: "i-lucide-lock",
  agenda_reopened: "i-lucide-lock-open",
  convocation_uploaded: "i-lucide-file-signature",
  convocation_removed: "i-lucide-file-x",
  agenda_item_created: "i-lucide-list-plus",
  agenda_item_updated: "i-lucide-pencil",
  agenda_item_deleted: "i-lucide-list-x",
  agenda_reordered: "i-lucide-arrow-up-down",
  live_changed: "i-lucide-radio",
  speakers_visibility_changed: "i-lucide-eye",
  speaking_turn_added: "i-lucide-mic",
  speaking_turn_started: "i-lucide-mic",
  speaking_turn_finished: "i-lucide-mic-off",
  speaking_turn_cancelled: "i-lucide-mic-off",
  speaking_turn_restored: "i-lucide-rotate-ccw",
  speaking_turn_moved: "i-lucide-arrow-up-down",
  speaking_turn_updated: "i-lucide-pencil",
  headcount_recorded: "i-lucide-users-round",
  headcount_corrected: "i-lucide-user-round-pen",
  vote_recorded: "i-lucide-vote",
  decision_recorded: "i-lucide-gavel",
  document_created: "i-lucide-file-plus",
  document_updated: "i-lucide-pencil",
  document_status_changed: "i-lucide-flag",
  document_content_updated: "i-lucide-file-pen-line",
  document_file_uploaded: "i-lucide-file-up",
  document_image_uploaded: "i-lucide-image-up",
  document_images_imported: "i-lucide-images",
  document_submitted: "i-lucide-send",
  document_correction_requested: "i-lucide-message-square-warning",
  document_published: "i-lucide-eye",
  document_deleted: "i-lucide-file-x",
  document_voted: "i-lucide-vote",
  final_vote_annulled: "i-lucide-undo-2",
  amendment_created: "i-lucide-file-plus",
  amendment_updated: "i-lucide-pencil",
  amendment_deleted: "i-lucide-file-x",
  amendment_submitted: "i-lucide-send",
  amendment_withdrawn: "i-lucide-undo-2",
  amendment_correction_requested: "i-lucide-message-square-warning",
  amendment_reclassified: "i-lucide-tags",
  amendment_authors_changed: "i-lucide-user-pen",
  amendment_validated: "i-lucide-badge-check",
  amendment_published: "i-lucide-eye",
  amendment_admitted: "i-lucide-badge-check",
  amendment_inadmissible: "i-lucide-ban",
  amendment_approved: "i-lucide-circle-check",
  amendment_rejected: "i-lucide-circle-x",
  amendment_reopened: "i-lucide-rotate-ccw",
  amendment_transacted: "i-lucide-git-merge",
  amendment_lapsed: "i-lucide-hourglass",
  position_changed: "i-lucide-message-square",
  acceptance_recorded: "i-lucide-handshake",
  relation_created: "i-lucide-link-2",
  relation_deleted: "i-lucide-unlink",
  "role.assign": "i-lucide-shield",
  "user.permissions_set": "i-lucide-key-round",
  "user.member_link": "i-lucide-link",
  "permissions.set": "i-lucide-shield-check",
  "member.create": "i-lucide-building-2",
  "member.update": "i-lucide-pencil",
  "members.sync": "i-lucide-refresh-cw",
  "members.sync_blocked": "i-lucide-shield-alert",
  "member.sync_create": "i-lucide-building-2",
  "member.sync_update": "i-lucide-refresh-cw",
  "member.sync_deactivate": "i-lucide-archive",
  "assembly.delete": "i-lucide-trash-2",
  "assembly.import": "i-lucide-file-input",
  "document.import": "i-lucide-file-input",
  "document_images.cleanup": "i-lucide-image-minus",
  "calendar_rules.update": "i-lucide-calendar-cog",
  "calendar_rules.seed": "i-lucide-calendar-cog",
  "user.created": "i-lucide-user-plus",
  "user.role_sync": "i-lucide-refresh-cw",
  "user.initial_admin": "i-lucide-shield",
  "user.access_revoked": "i-lucide-user-x",
  "user.access_restored": "i-lucide-user-check",
  "user.intranet_missing": "i-lucide-user-search",
  "users.access_recheck_blocked": "i-lucide-shield-alert",
  "user.onboarding_seen": "i-lucide-life-buoy",
  "auth.sign_in": "i-lucide-log-in",
  "auth.sign_out": "i-lucide-log-out",
  "auth.session_ended": "i-lucide-timer-off",
  "export.request": "i-lucide-file-down",
  "export.download": "i-lucide-download",
  "rbac.seed": "i-lucide-shield-check",
  "impersonation.start": "i-lucide-venetian-mask",
  "impersonation.stop": "i-lucide-venetian-mask",
  "impersonation.expire": "i-lucide-timer-off",
  "impersonation.revoke": "i-lucide-shield-off",
  "impersonation.request": "i-lucide-venetian-mask",
  [IMPERSONATION_SESSION_ACTION]: "i-lucide-venetian-mask",
} satisfies Record<ActivityAction, string>;

/** Icons of the categories, for actions outside the catalogs and the filters. */
export const ACTIVITY_CATEGORY_ICONS = {
  assembly: "i-lucide-landmark",
  agenda: "i-lucide-list-tree",
  document: "i-lucide-file-text",
  amendment: "i-lucide-file-diff",
  session: "i-lucide-radio",
  account: "i-lucide-user-cog",
  access: "i-lucide-log-in",
  member: "i-lucide-building-2",
  roles: "i-lucide-shield-check",
  export: "i-lucide-file-down",
  other: "i-lucide-circle-dot",
} satisfies Record<ActivityCategory, string>;

export function activityIcon(
  item: Pick<ActivityItemDto, "action" | "category">,
): string {
  return isActivityAction(item.action)
    ? ACTIVITY_ACTION_ICONS[item.action]
    : ACTIVITY_CATEGORY_ICONS[item.category];
}

// Links -----------------------------------------------------------------------

/** Sections of an assembly an item can link to (see assemblyPath). */
export type ActivityLinkSection =
  "overview" | "agenda" | "documents" | "live" | "calendar" | "convocation";

/**
 * Where an item leads, as parts of an unlocalized path: the assembly section
 * and, for documents and amendments, the document with the amendment open
 * (`?enmienda=<id>`).
 */
export interface ActivityLink {
  slug: string;
  section: ActivityLinkSection;
  /** Document slug, under the documents section. */
  document: string | null;
  /** Amendment id, opened in the document. */
  amendment: string | null;
}

/**
 * The page an item is about, or null when it is not available to the viewer
 * or belongs to no assembly (accounts, roles, members).
 */
export function activityLink(
  item: Pick<ActivityItemDto, "action"> & { target: ActivityTargetDto },
): ActivityLink | null {
  const { target } = item;
  if (!target.available || !target.assembly) return null;
  const at = (
    section: ActivityLinkSection,
    document: string | null = null,
    amendment: string | null = null,
  ): ActivityLink => ({
    slug: target.assembly!.slug,
    section,
    document,
    amendment,
  });
  const document = target.document?.slug ?? null;
  switch (target.type) {
    case "amendment":
      return document ? at("documents", document, target.id) : at("documents");
    case "document":
      return at("documents", document);
    case "agenda_item":
      return at("agenda");
    case "live":
    case "speakers":
    case "headcount":
      return at("live");
    case "vote":
    case "decision":
      return document ? at("documents", document) : at("live");
    default:
      break;
  }
  switch (item.action) {
    case "calendar_updated":
      return at("calendar");
    case "agenda_finalized":
    case "agenda_reopened":
    case "agenda_reordered":
      return at("agenda");
    case "convocation_uploaded":
    case "convocation_removed":
      return at("convocation");
    default:
      return document ? at("documents", document) : at("overview");
  }
}

// Details ---------------------------------------------------------------------

/** Intranet fields that role sync copies onto the account. */
export const ACTIVITY_INTRANET_FIELDS = [
  "externalRole",
  "externalName",
  "externalInitials",
  "university",
] as const;
export type ActivityIntranetField = (typeof ACTIVITY_INTRANET_FIELDS)[number];

/**
 * One thing worth saying about an item, besides its action and target.
 * Values are raw (status codes, role names, member ids, permission keys):
 * the components translate and name them.
 */
export type ActivityDetail =
  | {
      type: "status";
      entity: "assembly" | "document";
      from: string | null;
      to: string;
    }
  | { type: "role"; from: string | null; to: string | null }
  | { type: "permissions"; added: string[]; removed: string[] }
  | { type: "granted"; keys: string[] }
  | { type: "member"; from: string | null; to: string | null }
  | {
      type: "intranet";
      field: ActivityIntranetField;
      from: string | null;
      to: string | null;
    }
  | { type: "note"; text: string }
  | { type: "late" }
  | { type: "result"; result: string }
  | { type: "position"; position: string }
  | { type: "acceptance"; decision: string }
  /** The kind an amendment was reclassified to ("formal" or "partial"). */
  | { type: "reclassified"; to: string }
  | { type: "reason"; text: string }
  | { type: "roleSyncFailed" }
  | { type: "sync"; created: number; updated: number; deactivated: number }
  | { type: "ended"; reason: ImpersonationEndReason; at: string | null }
  | { type: "ongoing"; until: string }
  /** A field an edit changed, with its old and new value (raw). */
  | {
      type: "change";
      entity: ChangeEntity;
      field: string;
      from: ActivityChangeValue;
      to: ActivityChangeValue;
    }
  /** A field an edit changed, said without its values (ids, deadlines). */
  | { type: "changed"; entity: ChangeEntity; field: string }
  /** The sub-items a deleted agenda item took with it, by title. */
  | { type: "subItems"; titles: string[] }
  /** How many agenda items a reorder moved. */
  | { type: "moved"; count: number }
  /** A change to the root agenda items made once the agenda was final. */
  | { type: "afterFinal" }
  /** The agenda item is the automatic sub-item of a document. */
  | { type: "autoItem" }
  /** The agenda item went with the item it hung from. */
  | { type: "cascade" }
  /** How many documents a deleted agenda item took with it. */
  | { type: "deletedDocuments"; count: number };

/** A value in a field change: text, number, flag or empty. */
export type ActivityChangeValue = string | number | boolean | null;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;
}

function oneOf(values: readonly string[], value: unknown): string | null {
  return typeof value === "string" && values.includes(value) ? value : null;
}

/** A field that changed between `before` and `after` (only after: set). */
function changed(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  field: string,
): { from: string | null; to: string | null } | null {
  if (!(field in after)) return null;
  const from = text(before[field]);
  const to = text(after[field]);
  return from === to ? null : { from, to };
}

function changeValue(value: unknown): ActivityChangeValue {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : null;
}

/**
 * The fields an edit changed (`payload.changes`), in the order the event
 * lists them, only the ones CHANGE_FIELDS shows: with their values, or
 * only as changed. The Admin log gets the raw payload, so this is where
 * ids are left out for everyone.
 */
function changeDetails(
  action: string,
  payload: Record<string, unknown>,
): ActivityDetail[] {
  const entity = changeEntityOf(action);
  if (!entity) return [];
  const details: ActivityDetail[] = [];
  for (const [field, value] of Object.entries(record(payload.changes))) {
    const exposure = changeFieldExposure(entity, field);
    if (!exposure) continue;
    const change = record(value);
    if (exposure === "changed" || !("from" in change || "to" in change)) {
      details.push({ type: "changed", entity, field });
      continue;
    }
    const from = changeValue(change.from);
    const to = changeValue(change.to);
    if (from !== to) details.push({ type: "change", entity, field, from, to });
  }
  return details;
}

/** The mark of a root agenda change made once the agenda was final. */
function afterFinalDetails(payload: Record<string, unknown>): ActivityDetail[] {
  return payload.afterFinal === true ? [{ type: "afterFinal" }] : [];
}

/** The marks of an automatic sub-item and of one deleted with its parent. */
function autoItemDetails(payload: Record<string, unknown>): ActivityDetail[] {
  return [
    ...(payload.auto === true ? [{ type: "autoItem" as const }] : []),
    ...(payload.cascade === true ? [{ type: "cascade" as const }] : []),
  ];
}

function eventDetails(
  action: string,
  payload: Record<string, unknown>,
): ActivityDetail[] {
  switch (action) {
    case "assembly_updated":
    case "calendar_updated":
    case "document_updated":
    case "headcount_corrected":
      return changeDetails(action, payload);
    case "agenda_item_created":
      return [...autoItemDetails(payload), ...afterFinalDetails(payload)];
    case "agenda_item_updated":
      return [
        ...autoItemDetails(payload),
        ...changeDetails(action, payload),
        ...afterFinalDetails(payload),
      ];
    case "agenda_item_deleted": {
      // The first entry is the deleted item itself, then what was under it.
      const titles = (
        Array.isArray(payload.deletedItems) ? payload.deletedItems : []
      )
        .map((entry) => text(record(entry).title))
        .filter((title): title is string => title !== null)
        .slice(1);
      const documents = count(payload.deletedDocuments);
      return [
        ...autoItemDetails(payload),
        ...(titles.length > 0 ? [{ type: "subItems" as const, titles }] : []),
        ...(documents > 0
          ? [{ type: "deletedDocuments" as const, count: documents }]
          : []),
        ...afterFinalDetails(payload),
      ];
    }
    case "agenda_reordered": {
      // `moved` outside the Admin log; the raw `moves` in it.
      const moved = Array.isArray(payload.moves)
        ? payload.moves.length
        : count(payload.moved);
      return [
        ...(moved > 0 ? [{ type: "moved" as const, count: moved }] : []),
        ...afterFinalDetails(payload),
      ];
    }
    case "assembly_status_changed":
    case "document_status_changed": {
      const entity =
        action === "assembly_status_changed" ? "assembly" : "document";
      const statuses: readonly string[] =
        entity === "assembly" ? ASSEMBLY_STATUSES : DOCUMENT_STATUSES;
      const to = oneOf(statuses, payload.to);
      return to
        ? [{ type: "status", entity, from: oneOf(statuses, payload.from), to }]
        : [];
    }
    case "amendment_submitted":
    case "document_submitted":
      return payload.late === true ? [{ type: "late" }] : [];
    case "amendment_correction_requested":
    case "document_correction_requested": {
      const note = text(payload.note);
      return note ? [{ type: "note", text: note }] : [];
    }
    case "amendment_reclassified": {
      const to = oneOf(RECLASSIFIABLE_KINDS, payload.to);
      return to ? [{ type: "reclassified", to }] : [];
    }
    case "position_changed": {
      const position = oneOf(PROPONENT_POSITIONS, payload.position);
      return position ? [{ type: "position", position }] : [];
    }
    case "acceptance_recorded": {
      const decision = oneOf(ACCEPTANCE_DECISIONS, payload.decision);
      return decision ? [{ type: "acceptance", decision }] : [];
    }
    case "vote_recorded":
    case "document_voted": {
      const result = oneOf(VOTE_RESULTS, payload.result);
      return result ? [{ type: "result", result }] : [];
    }
    default:
      return [];
  }
}

function permissionDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ActivityDetail[] {
  const next = strings(after.permissions);
  if (!next) return [];
  const previous = strings(before.permissions) ?? [];
  const added = next.filter((key) => !previous.includes(key));
  const removed = previous.filter((key) => !next.includes(key));
  return added.length > 0 || removed.length > 0
    ? [{ type: "permissions", added, removed }]
    : [];
}

function auditDetails(
  action: string,
  payload: Record<string, unknown>,
): ActivityDetail[] {
  const before = record(payload.before);
  const after = record(payload.after);
  switch (action) {
    case "role.assign":
    case "user.initial_admin": {
      const role = changed(before, after, "roleName");
      return role ? [{ type: "role", ...role }] : [];
    }
    case "user.role_sync": {
      const details: ActivityDetail[] = [];
      const role = changed(before, after, "roleName");
      if (role) details.push({ type: "role", ...role });
      const member = changed(before, after, "memberId");
      if (member) details.push({ type: "member", ...member });
      for (const field of ACTIVITY_INTRANET_FIELDS) {
        const value = changed(before, after, field);
        if (value) details.push({ type: "intranet", field, ...value });
      }
      return details;
    }
    case "user.member_link": {
      const member = changed(before, after, "memberId");
      return member ? [{ type: "member", ...member }] : [];
    }
    case "user.access_revoked": {
      const details: ActivityDetail[] = [];
      const role = changed(before, after, "roleName");
      if (role) details.push({ type: "role", ...role });
      const member = changed(before, after, "memberId");
      if (member) details.push({ type: "member", ...member });
      return details;
    }
    case "user.permissions_set":
    case "permissions.set":
      return permissionDiff(before, after);
    case "rbac.seed": {
      const keys = strings(after.added) ?? [];
      return keys.length > 0 ? [{ type: "granted", keys }] : [];
    }
    case "members.sync":
      return [
        {
          type: "sync",
          created: count(after.created),
          updated: count(after.updated),
          deactivated: count(after.deactivated),
        },
      ];
    case "auth.sign_in":
      return after.roleSync === "failed" ? [{ type: "roleSyncFailed" }] : [];
    case "impersonation.start": {
      const reason = text(after.reason);
      return reason ? [{ type: "reason", text: reason }] : [];
    }
    default:
      return [];
  }
}

/** The window of an impersonation: why, and when it ended or ends. */
export function impersonationDetails(
  impersonation: Pick<
    ImpersonationDto,
    "reason" | "active" | "expiresAt" | "endedAt" | "endReason"
  >,
): ActivityDetail[] {
  const details: ActivityDetail[] = [];
  const reason = text(impersonation.reason);
  if (reason) details.push({ type: "reason", text: reason });
  if (impersonation.active) {
    details.push({ type: "ongoing", until: impersonation.expiresAt });
  } else {
    const ended = oneOf(IMPERSONATION_END_REASONS, impersonation.endReason);
    if (ended) {
      details.push({
        type: "ended",
        reason: ended as ImpersonationEndReason,
        at: impersonation.endedAt,
      });
    }
  }
  return details;
}

/**
 * What is worth saying about an item beyond its action and target. Nothing
 * when its target is no longer available: the server empties the payload
 * then, and the item says so instead.
 */
export function activityDetails(
  item: Pick<
    ActivityItemDto,
    "kind" | "action" | "payload" | "impersonation" | "target"
  >,
): ActivityDetail[] {
  if (item.kind === "impersonation") {
    return item.impersonation ? impersonationDetails(item.impersonation) : [];
  }
  const payload = record(item.payload);
  return item.kind === "event"
    ? eventDetails(item.action, payload)
    : auditDetails(item.action, payload);
}

// Devices ---------------------------------------------------------------------

/** "Chrome" and "Windows" out of a user agent; null when it cannot be told. */
export function userAgentSummary(userAgent: string | null | undefined): {
  browser: string | null;
  os: string | null;
} {
  const ua = userAgent ?? "";
  const browser = /\bEdg(?:e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /\b(?:OPR|Opera)\//.test(ua)
      ? "Opera"
      : /\b(?:Firefox|FxiOS)\//.test(ua)
        ? "Firefox"
        : /\bSamsungBrowser\//.test(ua)
          ? "Samsung Internet"
          : /\b(?:Chrome|CriOS|Chromium)\//.test(ua)
            ? "Chrome"
            : /\bVersion\/[\d.]+.*\bSafari\//.test(ua)
              ? "Safari"
              : null;
  const os = /\b(?:iPhone|iPad|iPod)\b/.test(ua)
    ? "iOS"
    : /\bAndroid\b/.test(ua)
      ? "Android"
      : /\bWindows\b/.test(ua)
        ? "Windows"
        : /\bCrOS\b/.test(ua)
          ? "ChromeOS"
          : /\bMac OS X\b|\bMacintosh\b/.test(ua)
            ? "macOS"
            : /\bLinux\b/.test(ua)
              ? "Linux"
              : null;
  return { browser, os };
}
